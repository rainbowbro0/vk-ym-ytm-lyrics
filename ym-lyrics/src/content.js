'use strict';
(() => {
const w = window;
let enabled = true, source = 'auto', geniusToken = '';
let currentKey = '', currentTrack = null;
let syncedLines = [], syncTimer = null, progressInterval = null;
let panel = null, panelOpen = false, hasLyrics = false, lyricsFetchInFlightKey = '';
let isDragging = false;
let seekOverride = null;

// LRC manual scrolling state
let manualScrollMode = false;
let autoScrollUntil = 0;
let lastHighlightedIndex = -1;
let scrollResumeButton = null;

// Native Yandex lyrics UI suppression while requesting LRC
let nativeLyricsSuppressionUntil = 0;
let fetchCallbacks = {}, coverToken = 0;

// Sync debugging and tracking variables
let timeTrackingMethod = 'unknown';
let lastKnownProgress = {current: 0, duration: 0, timestamp: 0};
let detectedTimestampFormat = 'unknown';
let syncRetryCount = 0;
const MAX_SYNC_RETRIES = 2;

// Method validation and broken method tracking
let brokenMethods = new Set();
const METHOD_VALIDATION_INTERVAL = 5000; // 5 seconds
let lastMethodValidationTime = 0;

// Yandex native lyrics cache (intercepted downloadUrl)
let yandexLyricsCache = null;

// Track/audio transition guards
let previousAudioSrc = '';
let progressTransitionUntil = 0;
let transitionTrackKey = '';

// Перехватываем AudioContext чтобы поймать скрытый плеер Яндекса (YASP)
let capturedAudio = null;
let capturedAudioContext = null;
(function() {
  // Перехват HTMLAudioElement через src (обычный режим)
  try {
    const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if(origSrcDesc) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        set(v) {
          origSrcDesc.set.call(this, v);
          if(v && this instanceof HTMLAudioElement) {
            const self = this;
            const onUpdate = () => { if(self.duration > 0) capturedAudio = self; };
            self.addEventListener('timeupdate', onUpdate, {passive:true});
            self.addEventListener('play', onUpdate, {passive:true});
          }
        },
        get() { return origSrcDesc.get.call(this); },
        configurable: true
      });
    }
  } catch(e) {}

  // Перехват через createMediaElementSource и createMediaStreamSource
  try {
    const OrigCtx = window.AudioContext || window.webkitAudioContext;
    if(OrigCtx) {
      const origCreate = OrigCtx.prototype.createMediaElementSource;
      OrigCtx.prototype.createMediaElementSource = function(el) {
        if(el instanceof HTMLAudioElement) {
          capturedAudio = el;
          el.addEventListener('timeupdate', () => { if(el.duration>0) capturedAudio=el; }, {passive:true});
        }
        return origCreate.call(this, el);
      };
    }
  } catch(e) {}
})();

// Перехватываем fetch к Яндекс lyrics API
(function() {
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = origFetch(input, init);
    if (/lyrics.*sign=|sign=.*format=LRC/i.test(url)) {
      p.then(function(r) {
        if (!r || !r.ok) return;
        r.clone().json().then(function(data) {
          if (data && data.downloadUrl) {
            yandexLyricsCache = {downloadUrl: data.downloadUrl, ts: Date.now()};
            // Запрос получен — нативное окно нам больше не нужно. Закрываем его сразу.
            nativeLyricsSuppressionUntil = Date.now() + 150;
            setTimeout(restoreNativeLyricsUi, 120);
            console.log('[YM-SYNC] ✅ Яндекс lyrics URL перехвачен:', data.downloadUrl.slice(0, 60));
          }
        }).catch(function(){});
      }).catch(function(){});
    }
    return p;
  };
})();

// MediaSession position cache (setPositionState hook)
let mediaSessionCache = null;
try {
  const origSet = navigator.mediaSession.setPositionState?.bind(navigator.mediaSession);
  if (origSet) {
    navigator.mediaSession.setPositionState = function(state) {
      if (state && state.duration > 0) {
        mediaSessionCache = {
          current: state.position || 0,
          duration: state.duration,
          ts: Date.now(),
          stale: false
        };
      }
      return origSet(state);
    };
    console.log('[YM-SYNC] ✅ mediaSession.setPositionState hook installed');
  }
  // Перехватываем playbackState и metadata для точного отслеживания
  try {
    let _playbackState = 'none';
    const pbDesc = Object.getOwnPropertyDescriptor(navigator.mediaSession.__proto__, 'playbackState')
      || Object.getOwnPropertyDescriptor(navigator.mediaSession, 'playbackState');

    Object.defineProperty(navigator.mediaSession, 'playbackState', {
      set(v) {
        const prev = _playbackState;
        _playbackState = v;
        if(pbDesc?.set) pbDesc.set.call(navigator.mediaSession, v);
        if(mediaSessionCache) {
          if(v === 'paused' && prev === 'playing') {
            // Замораживаем позицию
            const elapsed = (Date.now() - mediaSessionCache.ts) / 1000;
            mediaSessionCache.current = Math.min(mediaSessionCache.current + elapsed, mediaSessionCache.duration);
            mediaSessionCache.ts = Date.now();
          } else if(v === 'playing' && prev !== 'playing') {
            // Возобновление — обновляем только ts
            mediaSessionCache.ts = Date.now();
          }
        }
      },
      get() { return _playbackState; },
      configurable: true
    });

    // Перехватываем metadata — он меняется при каждой смене трека
    const metaDesc = Object.getOwnPropertyDescriptor(navigator.mediaSession.__proto__, 'metadata')
      || Object.getOwnPropertyDescriptor(navigator.mediaSession, 'metadata');
    let _metadata = null;
    Object.defineProperty(navigator.mediaSession, 'metadata', {
      set(v) {
        _metadata = v;
        if(metaDesc?.set) metaDesc.set.call(navigator.mediaSession, v);
        // При смене трека сбрасываем stale — Яндекс скоро вызовет setPositionState
        // Но пока ставим current=0 чтобы таймлайн не показывал старое значение
        if(mediaSessionCache) {
          mediaSessionCache.stale = false;
          mediaSessionCache.current = 0;
          mediaSessionCache.ts = Date.now();
        }
      },
      get() { return _metadata; },
      configurable: true
    });
  } catch(e) { console.debug('[YM-SYNC] playbackState hook failed:', e.message); }
} catch(e) {
  console.log('[YM-SYNC] ❌ mediaSession hook failed:', e.message);
}

// Track change detection variables
let lastUrl = '';
let lastTrackInfo = null;
let urlObserver = null;
let playerBarObserver = null;
let trackTextObserver = null;
let lastArtistTitle = '';

// Panel healing and lifecycle management
let panelHealingInterval = null;
const PANEL_HEALING_INTERVAL_MS = 500;

const SOURCES = [
  {id:'auto', label:'Авто'}, {id:'yandex', label:'Яндекс'},
  {id:'lrclib', label:'LRCLIB'}, {id:'genius', label:'Genius'}
];

function api(){ return w.externalAPI && typeof w.externalAPI === 'object' && typeof w.externalAPI.getCurrentTrack === 'function' ? w.externalAPI : null; }
function audioEl(){
  const audios=[...document.querySelectorAll('audio')].filter(a=>a.isConnected);
  // Если в DOM нет аудио (Моя волна) — используем перехваченный элемент
  if(!audios.length) return (capturedAudio && capturedAudio.duration > 0) ? capturedAudio : null;

  const score=(a)=>{
    let n=0;
    const src=a.currentSrc||a.src||'';
    if(!a.paused && !a.ended) n+=50;
    if(a.readyState>=2) n+=15;
    if(currentTrack?.duration>0 && a.duration>0){
      const d=Math.abs(Number(a.duration)-Number(currentTrack.duration));
      n += Math.max(0,30-Math.min(30,d*10));
    }
    // После skip вперёд предпочитаем элемент с новым src.
    if(previousAudioSrc && src && src!==previousAudioSrc) n+=80;
    // Старый поток часто остаётся около 1 секунды во время перехода — понижаем его.
    if(Date.now()<progressTransitionUntil && src && src===previousAudioSrc) n-=100;
    return n;
  };

  return audios.map(a=>({a,n:score(a)})).sort((x,y)=>y.n-x.n)[0]?.a || audios[0];
}


function parseTime(s){
  if(!s) return 0;
  const p = s.trim().replace(/[^0-9:]/g,'').split(':').map(Number);
  return p.length===2 ? p[0]*60+p[1] : 0;
}

// Enhanced time tracking with multiple fallback methods
function validateAndResetBrokenMethods() {
  const now = Date.now();
  if (now - lastMethodValidationTime < METHOD_VALIDATION_INTERVAL) return;
  lastMethodValidationTime = now;

  console.log('[YM-SYNC] Validating broken methods, currently broken:', Array.from(brokenMethods));

  // Try to unmark methods if they start working again
  if (brokenMethods.has('externalAPI')) {
    try {
      const apiObj = api();
      if (apiObj && typeof apiObj.getCurrentTrack === 'function') {
        brokenMethods.delete('externalAPI');
        console.log('[YM-SYNC] ✅ externalAPI method recovered');
      }
    } catch (e) {
      console.log('[YM-SYNC] externalAPI still broken:', e.message);
    }
  }

  if (brokenMethods.has('DOM')) {
    const times = document.querySelectorAll('[class*="Timecode_root"]');
    if (times.length >= 2) {
      brokenMethods.delete('DOM');
      console.log('[YM-SYNC] ✅ DOM method recovered');
    }
  }

  if (brokenMethods.has('slider')) {
    const slider = document.querySelector('[class*="ChangeTimecodeBackground_slider"],[class*="ChangeTimecode_slider"]');
    if (slider && slider.max && slider.value) {
      brokenMethods.delete('slider');
      console.log('[YM-SYNC] ✅ slider method recovered');
    }
  }

  if (brokenMethods.has('mediaSession')) {
    if (navigator.mediaSession && typeof navigator.mediaSession.getPositionState === 'function') {
      brokenMethods.delete('mediaSession');
      console.log('[YM-SYNC] ✅ mediaSession method recovered');
    }
  }

  if (brokenMethods.has('audioElement')) {
    const audio = audioEl();
    if (audio && !isNaN(audio.currentTime) && !isNaN(audio.duration)) {
      brokenMethods.delete('audioElement');
      console.log('[YM-SYNC] ✅ audioElement method recovered');
    }
  }
}

function updateLastKnownProgress(current, duration) {
  lastKnownProgress = {
    current: Number(current) || 0,
    duration: Number(duration) || 0,
    timestamp: Date.now()
  };
}

function getProgress(){
  // Если недавно была перемотка — возвращаем наше значение пока DOM не догнал
  if(seekOverride && Date.now() < seekOverride.until){
    return {current: seekOverride.current, duration: seekOverride.duration};
  }
  seekOverride = null;
  const now = Date.now();

  // Во время перехода между треками не доверяем старому DOM/slider значению.
  // Разрешаем только новый audio-поток; иначе ждём его и возвращаем 0 для текущего трека.
  if(now < progressTransitionUntil && transitionTrackKey===currentKey){
    const a=audioEl();
    const src=a?.currentSrc||a?.src||'';
    if(a && a.duration>0 && (!previousAudioSrc || src!==previousAudioSrc) && !isNaN(a.currentTime)){
      return {current:Number(a.currentTime)||0,duration:Number(a.duration)||Number(currentTrack?.duration)||0};
    }
    return {current:0,duration:Number(currentTrack?.duration)||lastKnownProgress.duration||0};
  }

  // Initial diagnostic log - only once per session
  if (lastMethodValidationTime === 0) {
    console.log('[YM-SYNC] 🔍 Initial diagnostics - checking available methods');
    console.log('[YM-SYNC] - window.externalAPI:', typeof window.externalAPI);
    console.log('[YM-SYNC] - window.MusicPlayer:', typeof window.MusicPlayer);
    console.log('[YM-SYNC] - audio element:', !!document.querySelector('audio'));
    lastMethodValidationTime = now;
  }

  // Method 1: Try externalAPI getCurrentTrack with position
  if (!brokenMethods.has('externalAPI')) {
    try {
      const apiObj = api();
      const track = apiObj?.getCurrentTrack?.();

      if (track && (track.position !== undefined || track.progress !== undefined)) {
        const pos = Number(track.position || track.progress || 0);
        const dur = Number(track.duration || track.durationMs/1000 || currentTrack?.duration || 0);
        const idsMatch = !currentTrack?.id || !track?.id || String(currentTrack.id)===String(track.id);
        const durationMatch = !currentTrack?.duration || !dur || Math.abs(Number(currentTrack.duration)-dur) <= 2.5;

        if (pos >= 0 && dur > 0 && idsMatch && durationMatch && !isNaN(pos) && !isNaN(dur)) {
          // Если API завис на одном значении при реально играющем треке,
          // не блокируем остальные источники времени.
          const staleFor = isPlaying() && timeTrackingMethod==='externalAPI' &&
            lastKnownProgress.duration===dur && Math.abs(lastKnownProgress.current-pos)<0.03
            ? now-lastKnownProgress.timestamp : 0;
          if(staleFor < 900){
            if (timeTrackingMethod !== 'externalAPI') console.log('[YM-SYNC] ✅ Switched to externalAPI method');
            timeTrackingMethod = 'externalAPI';
            updateLastKnownProgress(pos, dur);
            return {current: pos, duration: dur};
          }
        }
      }
    } catch (e) {
      console.log('[YM-SYNC] ❌ externalAPI exception:', e.message);
      brokenMethods.add('externalAPI');
    }
  }

  // Method 2: HTML5 Audio element — самый живой источник после skip.
  // На некоторых версиях Яндекс API/DOM может на короткое время держать старое
  // значение при последовательном переходе только вперёд. audio.currentTime при
  // этом уже относится к новому треку.
  if (!brokenMethods.has('audioElement')) {
    try {
      const audio = audioEl();
      if (audio && !isNaN(audio.currentTime) && !isNaN(audio.duration) && audio.duration > 0) {
        const cur = Number(audio.currentTime);
        const dur = Number(audio.duration);
        if (timeTrackingMethod !== 'audioElement') {
          console.log('[YM-SYNC] ✅ Switched to audioElement method');
        }
        timeTrackingMethod = 'audioElement';
        updateLastKnownProgress(cur, dur);
        return {current: cur, duration: dur};
      }
    } catch (e) {
      console.log('[YM-SYNC] ❌ audio element exception:', e.message);
      brokenMethods.add('audioElement');
    }
  }

  // Method 2: DOM elements (current implementation)
  if (!brokenMethods.has('DOM')) {
    try {
      const times = document.querySelectorAll('[class*="Timecode_root"]');

      if(times.length >= 3){
        // Моя волна fullscreen: t[0]=склеенный, t[1]=текущее, t[2]=длительность
        const cur = parseTime(times[1].textContent);
        const dur = parseTime(times[2].textContent);
        if(dur > 0 && !isNaN(cur) && !isNaN(dur)) {
          if (timeTrackingMethod !== 'DOM-vibe') {
            console.log('[YM-SYNC] ✅ Switched to DOM-vibe method (fullscreen)');
          }
          timeTrackingMethod = 'DOM-vibe';
          updateLastKnownProgress(cur, dur);
          return {current: cur, duration: dur};
        }
      }

      if(times.length >= 2){
        const dur = parseTime(times[0].textContent);
        const cur = parseTime(times[1].textContent);

        if(dur > 0 && !isNaN(cur) && !isNaN(dur)) {
          if (timeTrackingMethod !== 'DOM') {
            console.log('[YM-SYNC] ✅ Switched to DOM method');
          }
          timeTrackingMethod = 'DOM';
          updateLastKnownProgress(cur, dur);
          return {current: cur, duration: dur};
        }
      }
    } catch (e) {
      console.log('[YM-SYNC] ❌ DOM exception:', e.message);
      brokenMethods.add('DOM');
    }
  }

  // Method 3: Try progress bar slider value
  if (!brokenMethods.has('slider')) {
    try {
      const slider = document.querySelector('[class*="ChangeTimecodeBackground_slider"],[class*="ChangeTimecode_slider"]');

      if (slider && slider.max && slider.value) {
        const pct = Number(slider.value) / Number(slider.max);
        const dur = currentTrack?.duration || lastKnownProgress.duration || 0;

        if (dur > 0 && pct >= 0 && pct <= 1 && !isNaN(pct) && !isNaN(dur)) {
          const cur = dur * pct;
          if (timeTrackingMethod !== 'slider') {
            console.log('[YM-SYNC] ✅ Switched to slider method');
          }
          timeTrackingMethod = 'slider';
          updateLastKnownProgress(cur, dur);
          return {current: cur, duration: dur};
        }
      }
    } catch (e) {
      console.log('[YM-SYNC] ❌ slider exception:', e.message);
      brokenMethods.add('slider');
    }
  }

  // Method 4: MediaSession positionState (via setPositionState hook)
  const msAge = mediaSessionCache ? (Date.now() - mediaSessionCache.ts) / 1000 : 999;
  if (!brokenMethods.has('mediaSession') && mediaSessionCache && mediaSessionCache.duration > 0 && msAge < 60) {
    try {
      // Экстраполируем позицию только если играет, иначе возвращаем замороженное значение
      const elapsed = isPlaying() ? (Date.now() - mediaSessionCache.ts) / 1000 : 0;
      const cur = Math.min(mediaSessionCache.current + elapsed, mediaSessionCache.duration);
      if (timeTrackingMethod !== 'mediaSession') {
        console.log('[YM-SYNC] ✅ Switched to mediaSession hook method');
      }
      timeTrackingMethod = 'mediaSession';
      updateLastKnownProgress(cur, mediaSessionCache.duration);
      return {current: cur, duration: mediaSessionCache.duration};
    } catch (e) {
      console.log('[YM-SYNC] ❌ mediaSession cache exception:', e.message);
      brokenMethods.add('mediaSession');
    }
  }

  // Final live fallback: audio должен выигрывать у кеша, если DOM/API зависли после
  // последовательного skip вперёд. Это особенно важно на быстром переключении My Wave.
  try {
    const audio = audioEl();
    if (audio && !isNaN(audio.currentTime) && !isNaN(audio.duration) && audio.duration > 0) {
      const cur = Number(audio.currentTime);
      const dur = Number(audio.duration);
      if (isPlaying() && lastKnownProgress.duration===dur && Math.abs(lastKnownProgress.current-cur)<0.03 &&
          (now-lastKnownProgress.timestamp)>900) {
        if(timeTrackingMethod!=='audioElement-live') console.log('[YM-SYNC] 🚨 Live fallback: audioElement after stale source');
      }
      timeTrackingMethod='audioElement-live';
      updateLastKnownProgress(cur,dur);
      return {current:cur,duration:dur};
    }
  } catch(e){}

  // Последнее известное значение только когда ни один live-источник не доступен.
  if (lastKnownProgress.duration > 0) {
    return {current: lastKnownProgress.current, duration: lastKnownProgress.duration};
  }

  // ULTIMATE FALLBACK: читаем Timecode_root напрямую
  try {
    const times = document.querySelectorAll('[class*="Timecode_root"]');
    if(times.length >= 3){
      const cur = parseTime(times[1].textContent);
      const dur = parseTime(times[2].textContent);
      if(dur > 0){ updateLastKnownProgress(cur, dur); return {current:cur, duration:dur}; }
    }
    if(times.length >= 2){
      const dur = parseTime(times[0].textContent);
      const cur = parseTime(times[1].textContent);
      if(dur > 0){ updateLastKnownProgress(cur, dur); return {current:cur, duration:dur}; }
    }
  } catch(e){}

  if (timeTrackingMethod !== 'criticalFallback') {
    console.log('[YM-SYNC] 🚨 CRITICAL: All methods failed, using last known');
  }
  timeTrackingMethod = 'criticalFallback';
  return {current: lastKnownProgress.current, duration: lastKnownProgress.duration || currentTrack?.duration || 0};
}

function isPlaying(){
  // Проверяем оба плеера
  const selectors=[
    '[class*="VibePlayerControls_root"]',
    '[class*="PlayerBarDesktopWithBackgroundProgressBar_player"]'
  ];
  for(const sel of selectors){
    const p=document.querySelector(sel);
    if(!p)continue;
    if(p.querySelector('[aria-label="Пауза"]')) return true;
    if(p.querySelector('[aria-label="Воспроизведение"]')) return false;
  }
  try {
    const a = audioEl();
    if(a && a.isConnected && !a.paused && !a.ended && a.readyState >= 2) return true;
  } catch {}
  return false;
}

function clickPlayerControl(label){
  // Ищем в обоих плеерах
  const selectors = [
    '[class*="VibePlayerBar_root"]',
    '[class*="PlayerBarDesktopWithBackgroundProgressBar_player"]'
  ];
  for(const sel of selectors){
    const player=document.querySelector(sel);
    if(!player)continue;
    const btn=player.querySelector('[aria-label="'+label+'"]');
    if(btn){btn.click();return true;}
  }
  // Fallback — ищем везде
  const btn=document.querySelector('[aria-label="'+label+'"]');
  if(btn){btn.click();return true;}
  return false;
}function clickPlayerButton(pattern){ const els=[...document.querySelectorAll('button,[role=button]')]; const el=els.find(x=>pattern.test(`${x.getAttribute('aria-label')||''} ${x.getAttribute('title')||''} ${x.className||''}`)); if(el){el.click();return true} return false }
function noCoverUrl(){ try{return document.documentElement.dataset.ymlNoCoverUrl||'';}catch{return '';} }
// ─── Genius API fetch из MAIN world (обходит блокировку Firefox) ──────────────
async function fetchGeniusInPage(artist, title, token) {
  try {
    const isSong = h => h?.result?.url &&
      (h.type === 'song' || h.index === 'song' || /-lyrics\/?$/.test(h.result.url));

    const doSearch = async (query) => {
      try {
        const res = await fetch(
          `https://genius-proxy.rainbowbro0.workers.dev/search?q=${encodeURIComponent(query)}&access_token=${encodeURIComponent(token)}`
        );
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data?.response?.hits) ? data.response.hits : [];
      } catch { return []; }
    };

    const latinAlias = (() => {
      const m = String(title).match(/[([]([a-z0-9][a-z0-9\s\-']+)[)\]]/i);
      return m ? m[1].trim() : null;
    })();
    const titleClean = String(title).replace(/[([].*?[)\]]/g, ' ').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

    const queries = [...new Set([
      latinAlias ? `${artist} ${latinAlias}` : null,
      latinAlias,
      `${artist} ${titleClean}`,
      titleClean,
    ].filter(Boolean))];

    let hits = [];
    const results = await Promise.all(queries.map(q => doSearch(q)));
    for (const r of results) {
      const h = (r || []).filter(isSong);
      if (h.length) { hits = h; break; }
    }

    if (!hits.length) return bridgeCall('GENIUS', { artist, title, token });

    return bridgeCall('GENIUS_PAGES', { hits: hits.slice(0, 8), artist, title });
  } catch (e) {
    console.log('[YML] Genius in-page:', e.message);
    return null;
  }
}


function bridgeCall(type,payload){return new Promise(resolve=>{const id=Math.random().toString(36).slice(2);fetchCallbacks[id]=resolve;window.postMessage({_yml:type,id,...payload},'*');setTimeout(()=>{delete fetchCallbacks[id];resolve(null)},10000)})}
function updateButtonState(){ensureButtons();}
window.addEventListener('message',e=>{if(!e.data?._yml)return;if(e.data._yml==='INIT'){enabled=e.data.enabled;source=e.data.source||'auto';geniusToken=e.data.geniusToken||'';updateButtonState();updateSourceTabs()}else if(e.data._yml.endsWith('_RESULT')){const cb=fetchCallbacks[e.data.id];if(cb){delete fetchCallbacks[e.data.id];cb(e.data.data)}}});
function saveSettings(){window.postMessage({_yml:'SET_SETTINGS',enabled,source,geniusToken},'*')}
function decode(s){return String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")}
function getTrackInfo(){
  try{
    const t=api()?.getCurrentTrack?.();
    if(t){
      const artist=decode((t.artists||[]).map(a=>a.title||a.name||'').filter(Boolean).join(', '));
      const title=decode(t.title||'');
      const duration=Number(t.duration||t.durationMs/1000||t.duration_ms/1000||0);
      const id=t.id||t.trackId||t.track_id||'';
      const album=t.album||t.albums?.[0]||null;
      return {title,artist,duration,id,raw:t,cover:t.cover||album?.coverUri||album?.cover||''};
    }
  }catch(e){console.debug('[YML] externalAPI track',e)}
  const ms=navigator.mediaSession?.metadata;
  if(ms?.title) return {title:ms.title,artist:ms.artist||'',duration:0,id:'',raw:null,cover:ms.artwork?.[0]?.src||''};
  const title=document.querySelector('.track__title')?.getAttribute('title')||document.querySelector('.track__title')?.textContent||'';
  const artist=document.querySelector('.track__artists')?.textContent||'';
  if(title.trim()) return {title:title.trim(),artist:artist.trim(),duration:0,id:'',raw:null,cover:''};
  return null;
}
function trackKey(t){return `${t.id||''}||${t.artist}||${t.title}`}
// Enhanced track change detection for "My Wave" and dynamic content
function setupUrlObserver(){
  if(urlObserver) return;
  urlObserver = new MutationObserver(() => {
    const currentUrl = window.location.href;
    if(currentUrl !== lastUrl){
      console.log('[YM-SYNC] URL changed:', lastUrl, '->', currentUrl);
      lastUrl = currentUrl;
      // Force track change detection on URL change
      setTimeout(onTrackChange, 100);
    }
  });
  if(!document.body){urlObserver=null;return;}
  urlObserver.observe(document.body, {childList: true, subtree: true});
}

function setupPlayerBarObserver(){
  if(playerBarObserver) return;
  const playerBar = document.querySelector('[class*="PlayerBar"], [class*="VibePlayerBar"]');
  if(!playerBar) return;

  playerBarObserver = new MutationObserver(() => {
    console.log('[YM-SYNC] Player bar mutated, checking for track change');
    setTimeout(probe, 50);
  });
  playerBarObserver.observe(playerBar, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-label']
  });
  console.log('[YM-SYNC] Player bar observer set up');
}

function setupTrackTextObserver(){
  if(trackTextObserver) return;

  // Set up observer for artist/title text changes in the player bar
  const trackSelectors = [
    '.track__title',
    '.track__artists',
    '[class*="TrackInfo_title"]',
    '[class*="TrackInfo_artists"]',
    '[class*="VibePlayerBar_title"]',
    '[class*="VibePlayerBar_artist"]'
  ];

  const observeTrackText = () => {
    for(const selector of trackSelectors){
      const element = document.querySelector(selector);
      if(element && !element.__ymlTrackObserved){
        element.__ymlTrackObserved = true;
        const observer = new MutationObserver(() => {
          const currentText = element.textContent?.trim() || '';
          if(currentText && currentText !== lastArtistTitle){
            console.log('[YM-SYNC] Track text changed:', lastArtistTitle, '->', currentText);
            lastArtistTitle = currentText;
            setTimeout(onTrackChange, 100);
          }
        });
        observer.observe(element, {
          childList: true,
          characterData: true,
          subtree: true
        });
        console.log('[YM-SYNC] Track text observer set up for:', selector);
        // Store observer reference
        if(!trackTextObserver) trackTextObserver = [];
        trackTextObserver.push(observer);
      }
    }
  };

  observeTrackText();
  // Retry periodically for dynamic elements
  setInterval(observeTrackText, 2000);
}
function onTrackChange(){
  if(!enabled)return;
  console.log('[YM-SYNC] Track change triggered');
  setTimeout(()=>{
    const oldAudio=audioEl();
    previousAudioSrc = oldAudio?.currentSrc || oldAudio?.src || previousAudioSrc || '';
    const t=getTrackInfo(); if(!t)return;
    const key=trackKey(t); currentTrack=t;
    progressTransitionUntil=Date.now()+800;
    transitionTrackKey=key;

    if(key===currentKey){
      console.log('[YM-SYNC] Same track, resuming sync if needed');
      if(syncedLines.length&&!syncTimer&&isPlaying())startSync();
      return
    }

    console.log('[YM-SYNC] Track changed:', key);
    currentKey=key;
    hasLyrics=false;
    syncedLines=[];
    stopSync();
    syncRetryCount = 0;
    detectedTimestampFormat = 'unknown';
    timeTrackingMethod = 'unknown';
    brokenMethods.clear();
    lastMethodValidationTime = 0;
    seekOverride = null;
    manualScrollMode = false;
    lastHighlightedIndex = -1;
    // Сбрасываем прогресс при смене трека
    if(typeof lastKnownProgress !== 'undefined') lastKnownProgress = {current:0, duration:0, timestamp:0};
    // mediaSessionCache сбросится через metadata hook когда Яндекс установит новый трек
    capturedAudio = null;
    yandexLyricsCache = null;

    // ВАЖНО: панель не создаём и текст не запрашиваем при смене трека,
    // если пользователь её закрыл. Запрос к Яндексу должен происходить
    // только после явного открытия нашей панели.
    if(panel && panelOpen){
      setPanelTrack(t);
      resetProgress();
      getPanelBody().innerHTML='';
      getPanelBody().classList.remove('vkl-body--synced','vkl-body--manual-scroll');
      scrollResumeButton?.classList.remove('vkl-scroll-resume--visible');
      manualScrollMode=false;
      lastHighlightedIndex=-1;
      setStatus('⏳ Поиск текста…');
      if(lyricsFetchInFlightKey!==key){
        lyricsFetchInFlightKey=key;
        fetchLyrics(t).finally(()=>{if(lyricsFetchInFlightKey===key)lyricsFetchInFlightKey=''})
      }
    }
  },80)
}
function probe(){
  if(!enabled)return;
  const t=getTrackInfo();
  if(!t)return;
  const k=trackKey(t);
  if(k!==currentKey){
    console.log('[YM-SYNC] Probe detected track change');
    onTrackChange();
  } else if(panel){
    setPanelTrack(t);
  }
  if(isPlaying()&&syncedLines.length&&!syncTimer){
    console.log('[YM-SYNC] Probe detected playing state, starting sync');
    startSync();
  }
}
function startSync(){
  stopSync();
  if(manualScrollMode) return;
  console.log('[YM-SYNC] Starting sync with', syncedLines.length, 'lines');
  console.log('[YM-SYNC] Time tracking method:', timeTrackingMethod);
  syncTimer=setInterval(()=>{
    if(isPlaying() && !manualScrollMode){
      const progress = getProgress();
      highlightLine(progress.current);
    }
  },120);
}
function stopSync(){
  if(syncTimer){
    clearInterval(syncTimer);
    syncTimer=null;
    console.log('[YM-SYNC] Sync stopped');
  }
}
function centerActiveLine(body, active, behavior='smooth'){
  if(!body || !active) return;
  active.scrollIntoView({ block: 'center', behavior });
}
function setManualScrollMode(enabledMode){
  manualScrollMode=!!enabledMode;
  if(manualScrollMode){
    stopSync();
    scrollResumeButton?.classList.add('vkl-scroll-resume--visible');
    getPanelBody()?.classList.add('vkl-body--manual-scroll');
  }else{
    scrollResumeButton?.classList.remove('vkl-scroll-resume--visible');
    getPanelBody()?.classList.remove('vkl-body--manual-scroll');
  }
}
function resumeLyricsSync(){
  setManualScrollMode(false);
  const body=getPanelBody();
  if(body){
    const active=body.querySelector('.vkl-line--active');
    if(active){
      autoScrollUntil=Date.now()+1200;
      centerActiveLine(body,active,'smooth');
    }
  }
  if(syncedLines.length && isPlaying()) startSync();
  else if(syncedLines.length) highlightLine(getProgress().current);
}
function highlightLine(t){
  if(!syncedLines.length||!panel) return;
  if(!ensurePanelConnected()) return;

  let idx=-1;
  for(let i=0;i<syncedLines.length;i++){
    if(syncedLines[i].time<=t) idx=i;
    else break;
  }
  if(idx<0)idx=0;

  const body=getPanelBody();
  if(!body) return;
  const els=body.querySelectorAll('.vkl-line');
  els.forEach((el,i)=>el.classList.toggle('vkl-line--active',i===idx));

  const active=els[idx];
  // Не дёргаем прокрутку каждые 120 мс и никогда не забираем скролл у пользователя.
  if(active && idx!==lastHighlightedIndex && !manualScrollMode){
    lastHighlightedIndex=idx;
    autoScrollUntil=Date.now()+1200;
    centerActiveLine(body,active,'smooth');
  }else{
    lastHighlightedIndex=idx;
  }

  if(Math.random() < 0.01) {
    console.log('[YM-SYNC] Highlighting line', idx, 'at time', t.toFixed(2), 'method:', timeTrackingMethod);
  }
}
function sourceName(s){return {yandex:'Яндекс',musixmatch:'Musixmatch',lrclib:'LRCLIB',genius:'Genius'}[s]||s}
function nativeCandidateText(el){
  return `${el?.getAttribute?.('aria-label')||''} ${el?.getAttribute?.('title')||''} ${el?.textContent||''} ${typeof el?.className==='string'?el.className:''}`.replace(/\s+/g,' ').trim();
}
function isOurElement(el){ return !!(el && (el.closest?.('#vkl-panel,#vkl-overlay,.vkl-btn-wrap,.vkl-settings-modal') || el.classList?.contains('vkl-btn--button'))); }

// React/DOM helper: вызываем обработчик самого элемента, не создавая click-событие.
// Это не блокирует родительские кнопки Яндекса и не запускает цепочку pointer/click.
function getReactProps(el){
  if(!el) return null;
  try{
    const key=Object.keys(el).find(k=>k.startsWith('__reactProps$'));
    return key ? el[key] : null;
  }catch{return null}
}
function invokeNativeHandler(el){
  if(!el || isOurElement(el)) return false;
  try{
    const props=getReactProps(el);
    const fn=props?.onClick || props?.onPress;
    if(typeof fn==='function'){
      fn({
        preventDefault(){}, stopPropagation(){},
        nativeEvent:{preventDefault(){},stopPropagation(){}} ,
        currentTarget:el,target:el
      });
      return true;
    }
  }catch(e){ console.debug('[YM-SYNC] React handler invoke failed:',e); }
  return false;
}

let nativeUiObserver=null;
function hideNativeLyricsUi(){
  try{
    document.documentElement.dataset.ymlHideNativeLyrics='1';
    const candidates=[...document.querySelectorAll('[role="dialog"], [role="presentation"], [class*="Lyrics"], [class*="lyrics"], [class*="Modal"], [class*="modal"], [data-testid*="lyrics"], [data-test-id*="lyrics"]')];
    // Fallback: find visible large containers whose own text clearly belongs to native lyrics UI.
    for(const el of document.querySelectorAll('body *')){
      if(candidates.includes(el) || isOurElement(el) || !isVisible(el)) continue;
      const r=el.getBoundingClientRect();
      if(r.width<260 || r.height<120) continue;
      const text=(el.textContent||'').replace(/\s+/g,' ');
      if(/показать\s+текст\s+песни|текст\s+песни/i.test(text)) candidates.push(el);
    }
    for(const el of candidates){
      if(isOurElement(el)||!isVisible(el)) continue;
      const text=(el.textContent||'').replace(/\s+/g,' ');
      if(!/текст\s+песни|lyrics/i.test(text) && !/lyrics/i.test(String(el.className||''))) continue;
      el.dataset.ymlNativeLyricsHidden='1';
      el.style.setProperty('visibility','hidden','important');
      el.style.setProperty('pointer-events','none','important');
      el.style.setProperty('opacity','0','important');
      el.style.setProperty('display','none','important');
    }
  }catch{}
}
function restoreNativeLyricsUi(){
  if(nativeUiObserver){nativeUiObserver.disconnect();nativeUiObserver=null;}
  try{
    delete document.documentElement.dataset.ymlHideNativeLyrics;
    document.querySelectorAll('[data-yml-native-lyrics-hidden="1"]').forEach(el=>{
      el.style.removeProperty('visibility');
      el.style.removeProperty('pointer-events');
      el.style.removeProperty('opacity');
      el.style.removeProperty('display');
      delete el.dataset.ymlNativeLyricsHidden;
    });
  }catch{}
}
function startNativeLyricsUiSuppression(ms=3500){
  hideNativeLyricsUi();
  if(nativeUiObserver) nativeUiObserver.disconnect();
  nativeUiObserver=new MutationObserver(()=>hideNativeLyricsUi());
  nativeUiObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','aria-hidden']});
  nativeLyricsSuppressionUntil=Date.now()+ms;
  setTimeout(()=>{ if(Date.now()>=nativeLyricsSuppressionUntil) restoreNativeLyricsUi(); },ms+100);
}
function findNativePlayerMenuButton(){
  const players=[
    ...document.querySelectorAll('[class*="PlayerBarDesktopWithBackgroundProgressBar_player"], [class*="VibePlayerBar_root"], [class*="PlayerBar"]')
  ].filter(p=>p.isConnected);
  const roots=players.length?players:[document.body];
  const candidates=[];
  for(const root of roots){
    for(const el of root.querySelectorAll('button,[role="button"]')){
      if(isOurElement(el)) continue;
      const text=nativeCandidateText(el);
      if(/контекстн|дополн\.?|ещ[ёе]|more|menu/i.test(text)) candidates.push(el);
    }
  }
  return candidates.find(isVisible) || candidates[0] || null;
}
function findNativeLyricsMenuItem(){
  const candidates=[...document.querySelectorAll('[role="menuitem"], [role="option"], button, [role="button"]')].filter(el=>!isOurElement(el));
  const exact=candidates.find(el=>/показать\s+текст\s+песни/i.test(nativeCandidateText(el)));
  if(exact) return exact;
  return candidates.find(el=>/текст\s+песни|lyrics/i.test(nativeCandidateText(el))) || null;
}
function invokeNativeLyricsMenuItem(){
  const item=findNativeLyricsMenuItem();
  if(!item) return false;
  startNativeLyricsUiSuppression(3500);
  return invokeNativeHandler(item);
}
async function triggerNativeYandexLyricsRequest(){
  // Стратегия: скрываем UI ДО вызова React-обработчика, получаем fetch-перехват,
  // потом закрываем меню через Escape чтобы ничего не осталось на экране.
  function closeAnyOpenMenu(){
    try{
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      document.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',bubbles:true,cancelable:true}));
    }catch{}
  }

  // Вариант А: кнопка «текст песни» прямо в плеере (без меню)
  const direct=[...document.querySelectorAll('button,[role="button"]')]
    .filter(el=>!isOurElement(el) && /текст\s+песни|lyrics/i.test(nativeCandidateText(el)) && !/показать\s+текст\s+песни/i.test(nativeCandidateText(el)));
  const directBtn=direct.find(isVisible) || direct[0];
  if(directBtn){
    startNativeLyricsUiSuppression(4000);
    const ok=invokeNativeHandler(directBtn);
    // Скрываем появившееся окно текста через 80мс
    setTimeout(closeAnyOpenMenu, 80);
    setTimeout(restoreNativeLyricsUi, 4100);
    return ok;
  }

  // Вариант Б: ищем пункт в DOM без открытия меню
  // Сначала открываем меню скрыто, ищем пункт, закрываем немедленно
  const menu=findNativePlayerMenuButton();
  if(!menu) return false;

  // Скрываем весь UI ДО открытия
  startNativeLyricsUiSuppression(3000);
  if(!invokeNativeHandler(menu)) { restoreNativeLyricsUi(); return false; }

  // Ждём появления пункта (макс 400мс)
  let found=false;
  for(let i=0;i<8;i++){
    await new Promise(res=>setTimeout(res,50));
    if(invokeNativeLyricsMenuItem()){ found=true; break; }
  }

  // Закрываем меню СРАЗУ в любом случае
  closeAnyOpenMenu();
  closeAnyOpenMenu();
  await new Promise(res=>setTimeout(res,80));
  closeAnyOpenMenu();
  restoreNativeLyricsUi();
  return found;
}
async function fetchOne(src,t){
  if(src==='yandex') return (async function() {
    // Если кеш свежий (не старше 30 сек) — используем его
    if (yandexLyricsCache && (Date.now() - yandexLyricsCache.ts) < 30000) {
      try {
        const r = await fetch(yandexLyricsCache.downloadUrl);
        if (!r.ok) return null;
        const lrc = await r.text();
        if (lrc && lrc.includes('[')) return {type:'synced', content: lrc, source:'Яндекс'};
      } catch(e) {}
    }

    // Запрос выполняется только после открытия нашей панели пользователем.
    // Нативный обработчик вызывается напрямую, без .click()/pointer-событий.
    await triggerNativeYandexLyricsRequest();

    // Ждём именно перехваченный downloadUrl, а не открытие нативного окна.
    const waitUntil = Date.now() + 5000;
    while (!yandexLyricsCache && Date.now() < waitUntil) {
      await new Promise(res => setTimeout(res, 100));
    }

    if (yandexLyricsCache && (Date.now() - yandexLyricsCache.ts) < 5000) {
      try {
        const r = await fetch(yandexLyricsCache.downloadUrl);
        if (!r.ok) return null;
        const lrc = await r.text();
        if (lrc && lrc.includes('[')) return {type:'synced', content: lrc, source:'Яндекс'};
      } catch(e) {}
    }
    return null;
  })();
  if(src==='musixmatch')return bridgeCall('MXM',{artist:t.artist,title:t.title,duration:t.duration});
  if(src==='lrclib')return bridgeCall('LRCLIB',{artist:t.artist,title:t.title,duration:t.duration});
  if(src==='genius'&&geniusToken)return fetchGeniusInPage(t.artist,t.title,geniusToken);
  return null;
}
async function fetchLyrics(t){
  const key=trackKey(t);
  const hasCyrillic=/[а-яёА-ЯЁ]/.test((t.title||'')+(t.artist||''));
  // MXM временно убран из авто — их API банит запросы (токен 000...)
  const autoSources=['yandex','lrclib',...(geniusToken?['genius']:[])];
  const sources=source==='auto'?autoSources:[source];
  setStatus(source==='auto'?'⏳ Поиск…':`⏳ ${sourceName(source)}…`);
  const promises=sources.map(s=>fetchOne(s,t).catch(()=>null));
  try{const r=await Promise.any(promises.map(p=>p.then(x=>{if(x?.type==='synced')return x;throw 0})));if(currentKey===key){renderLyrics(r);return}}catch{}
  const results=await Promise.all(promises);if(currentKey!==key)return;const best=results.find(Boolean);if(best){renderLyrics(best);return}setStatus(`😶 ${source==='auto'?'Текст не найден':sourceName(source)+': не найдено'}`);hasLyrics=true
}
// Enhanced timestamp parser supporting multiple formats
function parseTimestamp(tag) {
  // Format 1: [mm:ss.xx] - standard LRC (e.g., [01:23.45])
  const standardMatch = tag.match(/\[(\d+):(\d{1,2})(?:\.(\d+))?\]/);
  if (standardMatch) {
    const min = Number(standardMatch[1]);
    const sec = Number(standardMatch[2]);
    const ms = standardMatch[3] ? Number('0.' + standardMatch[3]) : 0;
    return min * 60 + sec + ms;
  }

  // Format 2: [mm:ss:xxx] - millisecond precision (e.g., [01:23:456])
  const msMatch = tag.match(/\[(\d+):(\d{1,2}):(\d{1,3})\]/);
  if (msMatch) {
    const min = Number(msMatch[1]);
    const sec = Number(msMatch[2]);
    const ms = Number(msMatch[3]) / 1000;
    return min * 60 + sec + ms;
  }

  // Format 3: Raw millisecond offset (e.g., [83456])
  const rawMsMatch = tag.match(/\[(\d+)\]/);
  if (rawMsMatch) {
    const ms = Number(rawMsMatch[1]);
    // If it's a large number, treat as milliseconds
    if (ms > 1000) {
      return ms / 1000;
    }
    // Otherwise treat as seconds
    return ms;
  }

  return null;
}

function parseLRC(lrc, isFallback = false) {
  const out = [];
  const lines = String(lrc || '').split(/\r?\n/);
  let formatDetected = false;

  console.log('[YM-SYNC] Starting LRC parse, fallback mode:', isFallback);
  console.log('[YM-SYNC] First line sample:', lines[0]?.substring(0, 50));

  for (const raw of lines) {
    // Try multiple timestamp patterns
    const patterns = [
      /\[(\d+):(\d{1,2})(?:\.(\d+))?\]/g,  // [mm:ss.xx]
      /\[(\d+):(\d{1,2}):(\d{1,3})\]/g,   // [mm:ss:xxx]
      /\[(\d+)\]/g                         // [milliseconds]
    ];

    let matched = false;
    for (const pattern of patterns) {
      const tags = [...raw.matchAll(pattern)];
      if (tags.length > 0) {
        if (!formatDetected) {
          detectedTimestampFormat = pattern.toString();
          formatDetected = true;
          console.log('[YM-SYNC] Detected timestamp format:', pattern.toString());
        }

        const text = raw.replace(pattern, '').trim();
        for (const m of tags) {
          const time = parseTimestamp(m[0]);
          if (time !== null) {
            out.push({ time, text: text || '♩' });
          }
        }
        matched = true;
        break;
      }
    }

    // If no timestamp found, it might be a plain text line
    if (!matched && raw.trim()) {
      out.push({ time: -1, text: raw.trim() }); // -1 indicates unsynced
    }
  }

  // Filter out invalid timestamps and sort
  const validLines = out.filter(line => line.time >= 0).sort((a, b) => a.time - b.time);

  console.log('[YM-SYNC] Parsed', validLines.length, 'synced lines from', lines.length, 'total lines');
  console.log('[YM-SYNC] Timestamp format:', detectedTimestampFormat);

  if (validLines.length === 0 && !isFallback) {
    console.log('[YM-SYNC] No synced lines found, will try fallback parsing');
  }

  return validLines;
}
// Fallback mechanism for sync failures
function renderLyrics(r){
  stopSync();
  const body=getPanelBody();
  body.innerHTML='';

  if(r.type==='synced'){
    console.log('[YM-SYNC] Rendering synced lyrics from source:', r.source);
    detectedTimestampFormat = 'unknown';
    syncedLines=parseLRC(r.content, false);

    // If primary parsing failed, try fallback
    if(syncedLines.length === 0 && syncRetryCount < MAX_SYNC_RETRIES){
      console.log('[YM-SYNC] Primary parse failed, trying fallback (attempt', syncRetryCount + 1, ')');
      syncRetryCount++;
      syncedLines = parseLRC(r.content, true); // Try with fallback mode
    } else {
      syncRetryCount = 0; // Reset counter on success
    }

    if(syncedLines.length > 0){
      hasLyrics=true;
      body.classList.remove('vkl-body--empty');
      body.classList.add('vkl-body--synced');
      syncedLines.forEach(x=>{const e=document.createElement('div');e.className='vkl-line';e.textContent=x.text;body.appendChild(e)});
      setStatus(`🎵 ${r.source||'Текст'} (синхр.)`);
      manualScrollMode=false;
      lastHighlightedIndex=-1;
      scrollResumeButton?.classList.remove('vkl-scroll-resume--visible');
      body.classList.remove('vkl-body--manual-scroll');
      body.scrollTop=0;
      console.log('[YM-SYNC] Successfully rendered', syncedLines.length, 'synced lines');
      if(isPlaying())startSync();
      return;
    } else {
      console.log('[YM-SYNC] All parsing attempts failed, falling back to plain text');
      // Fall through to plain text rendering
    }
  }

  // Plain text rendering (fallback or original plain lyrics)
  syncedLines=[];
  body.classList.remove('vkl-body--synced','vkl-body--empty');
  String(r.content||'').split('\n').forEach(x=>{const e=document.createElement('div');e.className='vkl-line';e.textContent=x;body.appendChild(e)});
  hasLyrics=true;
  setStatus(`📄 ${r.source||'Текст'}`);
  body.scrollTop=0;
  console.log('[YM-SYNC] Rendered as plain text');
}
function getPanelBody(){
  if(!panel || !panel.isConnected){
    console.log('[YM-SYNC] Panel missing in getPanelBody, attempting recovery');
    healPanel();
  }
  return panel?.querySelector('.vkl-body')
}
function getPanelStatus(){
  if(!panel || !panel.isConnected){
    console.log('[YM-SYNC] Panel missing in getPanelStatus, attempting recovery');
    healPanel();
  }
  return panel?.querySelector('.vkl-status')
}
function setStatus(t){
  const e=getPanelStatus();
  if(e)e.textContent=t;
  // Скрываем body и кнопку часиков только при загрузке или отсутствии текста
  const body=getPanelBody();
  const noText=/^⏳/.test(t) || /^😶/.test(t);
  body?.classList.toggle('vkl-body--empty', !!noText);
  if(noText) {
    scrollResumeButton?.classList.remove('vkl-scroll-resume--visible');
    manualScrollMode = false;
  }
}
function coverUrl(t){
  let c=t?.cover||'';if(typeof c==='object')c=c.uri||c.url||c.coverUri||'';if(c.includes('%%'))c=c.replace('%%','1000x1000');if(c&&!/^https?:\/\//i.test(c))c='https://'+c;c=c.replace(/\/(?:40|50|80|100|200|300|400|600|800)x(?:40|50|80|100|200|300|400|600|800)(?=\b|$)/,'/1000x1000');return c
}
function setPanelTrack(t){
  if(!panel || !panel.isConnected){
    console.log('[YM-SYNC] Panel missing in setPanelTrack, attempting recovery');
    healPanel();
    return;
  }
  try{
    panel.querySelector('.vkl-track').textContent=t.title;
    panel.querySelector('.vkl-artist').textContent=t.artist;
    const box=panel.querySelector('.vkl-cover');
    const key=trackKey(t);
    if(box.dataset.key===key&&box.dataset.coverReady)return;
    box.dataset.key=key;
    box.dataset.coverReady='';
    coverToken++;
    const token=coverToken;
    let src=coverUrl(t)||'';
    if(!src){
      // Берём artwork с наибольшим размером из mediaSession
      const artwork=navigator.mediaSession?.metadata?.artwork||[];
      const best=artwork.sort((a,b)=>parseInt(b.sizes)-parseInt(a.sizes))[0];
      src=best?.src||'';
    }
    if(src&&src.includes('%%'))src=src.replace('%%','1000x1000');
    // Апгрейдим avatars.yandex.net URL до максимального размера
    src=src.replace(/\/(?:40|50|80|100|200|300|400|600|800)x(?:40|50|80|100|200|300|400|600|800)(?=\b|$)/, '/1000x1000');
    const img=new Image();
    img.onload=()=>{if(token!==coverToken||box.dataset.key!==key)return;box.innerHTML='';const glow=document.createElement('img');glow.className='vkl-cover-glow';glow.src=src;const art=document.createElement('img');art.className='vkl-cover-art';art.src=src;box.append(glow,art);box.dataset.coverReady='1'};
    img.onerror=()=>{if(token!==coverToken||box.dataset.key!==key)return;box.textContent='';const u=noCoverUrl();if(u){const im=document.createElement('img');im.className='vkl-cover-art';im.src=u;box.appendChild(im)}else{box.textContent='🎵'}box.dataset.coverReady='1'};
    if(src)img.src=src;else img.onerror()
  }catch(e){
    console.log('[YM-SYNC] Error in setPanelTrack:', e.message);
  }
}
function resetProgress(){
  if(!panel || !panel.isConnected){
    console.log('[YM-SYNC] Panel missing in resetProgress, attempting recovery');
    healPanel();
    return;
  }
  try{
    panel.querySelector('.vkl-progress-bar').style.width='0%';
    panel.querySelector('#vkl-progress-input').value=0;
    panel.querySelector('.vkl-current-time').textContent='0:00';
    panel.querySelector('.vkl-duration').textContent='0:00';
  }catch(e){
    console.log('[YM-SYNC] Error in resetProgress:', e.message);
  }
}
function formatTime(s){s=Math.max(0,Number(s)||0);return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`}
function updateProgress(){
  if(!panel || !panel.isConnected) return;
  if(isDragging) return;
  const p=getProgress();
  if(!p.duration)return;

  const pct=Math.max(0,Math.min(100,p.current/p.duration*100));
  panel.querySelector('#vkl-progress-input').value=pct;
  panel.querySelector('.vkl-progress-bar').style.width=pct+'%';
  panel.querySelector('.vkl-current-time').textContent=formatTime(p.current);
  panel.querySelector('.vkl-duration').textContent=formatTime(p.duration);

  // Debug logging for progress updates
  if(Math.random() < 0.005) {
    console.log('[YM-SYNC] Progress update:', p.current.toFixed(2), '/', p.duration.toFixed(2), 'method:', timeTrackingMethod);
  }
}
function getVolume(){
  const slider=document.querySelector('[class*="ChangeVolume"] input[type="range"]');
  if(slider) return Math.max(0,Math.min(1,Number(slider.value)));
  return null;
}
function setVolume(v){
  v=Math.max(0,Math.min(1,v));
  const slider=document.querySelector('[class*="ChangeVolume"] input[type="range"]');
  if(slider){
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(slider, v);
    slider.dispatchEvent(new Event('input',{bubbles:true}));
    slider.dispatchEvent(new Event('change',{bubbles:true}));
  }
}
function getRepeat(){try{return api()?.getRepeat?.()??0}catch{return 0}}
function setRepeat(v){try{const a=api();if(a?.toggleRepeat){a.toggleRepeat(v);return}clickPlayerButton(/repeat|повтор/i)}catch{}}

// Panel healing and lifecycle management
function destroyPanel(){
  console.log('[YM-SYNC] Destroying panel');
  if(panelHealingInterval){
    clearInterval(panelHealingInterval);
    panelHealingInterval = null;
  }
  if(panel && panel.isConnected){
    panel.remove();
  }
  if(document.getElementById('vkl-overlay')?.isConnected){
    document.getElementById('vkl-overlay').remove();
  }
  panel = null;
  panelOpen = false;
  if(progressInterval){
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

function healPanel(){
  if(!panel || !panel.isConnected){
    console.log('[YM-SYNC] 🔧 Panel disconnected, attempting recovery');
    if(panelOpen && currentTrack){
      console.log('[YM-SYNC] Re-creating panel for current track');
      destroyPanel();
      createPanel();
      setPanelTrack(currentTrack);
      if(hasLyrics && syncedLines.length > 0){
        getPanelBody().innerHTML = '';
        getPanelBody().classList.add('vkl-body--synced');
        syncedLines.forEach(x=>{
          const e = document.createElement('div');
          e.className = 'vkl-line';
          e.textContent = x.text;
          getPanelBody().appendChild(e);
        });
        setStatus(`🎵 Текст (синхр.)`);
        manualScrollMode=false;
        lastHighlightedIndex=-1;
        scrollResumeButton?.classList.remove('vkl-scroll-resume--visible');
        if(isPlaying()) startSync();
      }
      panel.classList.add('vkl-panel--open');
      const overlay = document.getElementById('vkl-overlay');
      if(overlay) overlay.classList.add('vkl--open');
      startProgressInterval();
    }
  }
}

function startPanelHealing(){
  if(panelHealingInterval) return;
  panelHealingInterval = setInterval(healPanel, PANEL_HEALING_INTERVAL_MS);
  console.log('[YM-SYNC] Panel healing started');
}

function ensurePanelConnected(){
  if(!panel || !panel.isConnected){
    console.log('[YM-SYNC] ⚠️ Panel not connected, healing...');
    healPanel();
    return false;
  }
  return true;
}

function createPanel(){
  if(panel && panel.isConnected) return;
  console.log('[YM-SYNC] Creating new panel');
  destroyPanel(); // Clean up any existing panel first

  const overlay=document.createElement('div');
  overlay.id='vkl-overlay';
  overlay.onclick=closePanel;
  document.body.appendChild(overlay);

  panel=document.createElement('div');
  panel.id='vkl-panel';
  panel.className='vkl-panel';
  panel.innerHTML=`<div class="vkl-panel-topbar"><button class="vkl-topbar-btn" id="vkl-settings-btn">⚙</button><button class="vkl-topbar-btn vkl-close" id="vkl-close">✕</button></div><div class="vkl-panel-header"><div class="vkl-cover">🎵</div><div class="vkl-header-text"><div class="vkl-track">— Ожидание трека —</div><div class="vkl-artist"></div></div></div><div class="vkl-source-bar"></div><div class="vkl-status">Ожидание трека…</div><div class="vkl-body"></div><button type="button" id="vkl-scroll-resume" class="vkl-scroll-resume" aria-label="Вернуться к текущей строке" title="Вернуться к текущей строке"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.4v5l3.2 1.9"></path></svg></button><div class="vkl-controls-bottom"><div class="vkl-progress"><div class="vkl-progress-track"></div><div class="vkl-progress-bar"></div><input type="range" id="vkl-progress-input" class="vkl-progress-input" min="0" max="100" value="0"></div><div class="vkl-time"><span class="vkl-current-time">0:00</span><span class="vkl-duration">0:00</span></div><div class="vkl-buttons"><button class="vkl-control-btn" id="vkl-dislike-btn" title="Не нравится">🚫</button><button class="vkl-control-btn" id="vkl-repeat-btn">↻</button><button class="vkl-control-btn" id="vkl-prev-btn">◀</button><button class="vkl-play-btn" id="vkl-play-btn"><svg class="vcf-icon-play" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><svg class="vcf-icon-pause" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg></button><button class="vkl-control-btn" id="vkl-next-btn">▶</button><button class="vkl-settings-btn" id="vkl-volume-btn">🔊</button><button class="vkl-control-btn" id="vkl-like-btn" title="Нравится">❤</button></div></div>`;
  const sb=panel.querySelector('.vkl-source-bar');SOURCES.forEach(s=>{const b=document.createElement('button');b.className='vkl-src-tab'+(s.id===source?' vkl-src-tab--active':'');b.dataset.src=s.id;b.textContent=s.label;sb.appendChild(b)});
  document.body.appendChild(panel);
  scrollResumeButton=panel.querySelector('#vkl-scroll-resume');
  const body=panel.querySelector('.vkl-body');
  if(body){
    const userScroll=()=>{
      // Wheel/touch — это однозначно ручной скролл, даже если наша плавная
      // автопрокрутка ещё не закончилась.
      setManualScrollMode(true);
    };
    body.addEventListener('wheel', userScroll, {passive:true});
    body.addEventListener('touchmove', userScroll, {passive:true});
    body.addEventListener('scroll', ()=>{
      if(Date.now()<autoScrollUntil) return;
      // Срабатывает и при перетаскивании scrollbar/ручном скролле.
      if(!manualScrollMode) setManualScrollMode(true);
    }, {passive:true});
    body.addEventListener('pointerdown', e=>{
      const r=body.getBoundingClientRect();
      if(e.clientX>=r.right-14) setManualScrollMode(true);
    }, {passive:true});
  }
  scrollResumeButton?.addEventListener('click', e=>{e.preventDefault();e.stopPropagation();resumeLyricsSync()});
  panel.querySelector('#vkl-close').onclick=closePanel;panel.querySelector('#vkl-settings-btn').onclick=showSettingsModal;
  panel.querySelectorAll('.vkl-src-tab').forEach(b=>b.onclick=()=>{source=b.dataset.src;updateSourceTabs();saveSettings();if(currentTrack){hasLyrics=false;syncedLines=[];getPanelBody().innerHTML='';fetchLyrics(currentTrack)}});
  const play=panel.querySelector('#vkl-play-btn');panel._updatePlayBtn=()=>{const p=isPlaying();play.querySelector('.vcf-icon-play').style.display=p?'none':'';play.querySelector('.vcf-icon-pause').style.display=p?'':'none'};play.onclick=()=>{if(isPlaying())clickPlayerControl('Пауза');else clickPlayerControl('Воспроизведение');setTimeout(panel._updatePlayBtn,80)};
  panel.querySelector('#vkl-prev-btn').onclick=()=>clickPlayerControl('Предыдущая песня');
  panel.querySelector('#vkl-next-btn').onclick=()=>clickPlayerControl('Следующая песня');
  panel.querySelector('#vkl-like-btn').onclick=()=>clickPlayerControl('Нравится');
  panel.querySelector('#vkl-dislike-btn').onclick=()=>clickPlayerControl('Не нравится');
  panel.querySelector('#vkl-repeat-btn').onclick=()=>{const r=getRepeat();const n=(Number(r)||0)+1;setRepeat(n>2?0:n);setTimeout(updateRepeat,80)};
  function updateRepeat(){const r=getRepeat();const b=panel.querySelector('#vkl-repeat-btn');b.classList.toggle('vkl-control-btn--active',!!r);b.title=`Повтор: ${r||'выкл'}`}
  panel._updateRepeat=updateRepeat;updateRepeat();panel._updatePlayBtn();
  panel.querySelector('#vkl-progress-input').addEventListener('mousedown',()=>{isDragging=true});
  panel.querySelector('#vkl-progress-input').addEventListener('touchstart',()=>{isDragging=true});
  panel.querySelector('#vkl-progress-input').oninput=e=>{
    const pct=Number(e.target.value)/100;
    const p=getProgress();
    const pos=p.duration*pct;
    const ymSlider=document.querySelector('[class*="ChangeTimecodeBackground_slider"] input[type="range"], [class*="ChangeTimecode_slider"] input[type="range"], input[aria-label="Управление таймкодом"]');
    if(ymSlider){
      const nativeInputValueSetter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      nativeInputValueSetter.call(ymSlider, Math.round(pos));
      ymSlider.dispatchEvent(new Event('input',{bubbles:true}));
      ymSlider.dispatchEvent(new Event('change',{bubbles:true}));
      // Принудительно обновляем жёлтую полоску Яндекса
      const pctStr=(pct*100).toFixed(4)+'%';
      ymSlider.style.setProperty('--seek-before-width', pctStr);
      ymSlider.style.backgroundSize=pctStr+' 100%';
    }
    // Сразу обновляем lastKnownProgress нашим значением
    if(typeof lastKnownProgress !== 'undefined') lastKnownProgress={current:pos,duration:p.duration,timestamp:Date.now()};
    seekOverride={current:pos,duration:p.duration,until:Date.now()+1500};
  };
  panel.querySelector('#vkl-progress-input').addEventListener('mouseup',()=>{setTimeout(()=>{isDragging=false},500)});
  panel.querySelector('#vkl-progress-input').addEventListener('touchend',()=>{setTimeout(()=>{isDragging=false},500)});
  panel._updateProgress=updateProgress;startProgressInterval();
  let volPopup=null;panel.querySelector('#vkl-volume-btn').onclick=e=>{e.stopPropagation();if(volPopup){volPopup.remove();volPopup=null;return}const v=Math.round((getVolume()??0)*100);volPopup=document.createElement('div');volPopup.className='vkl-volume-popup';volPopup.innerHTML=`<span class="vkl-volume-pct"></span><input class="vkl-volume-slider" type="range" min="0" max="100" value="0"><div class="vkl-vol-icon">🔊</div>`;volPopup.querySelector('.vkl-volume-pct').textContent=v+'%';volPopup.querySelector('.vkl-volume-slider').value=v;const sl=volPopup.querySelector('input'),pct=volPopup.querySelector('span');volPopup._sync=()=>{const x=getVolume();if(x!==null&&!sl.matches(':active')){sl.value=Math.round(x*100);pct.textContent=Math.round(x*100)+'%'}};sl.oninput=()=>{pct.textContent=sl.value+'%';setVolume(Number(sl.value)/100)};document.body.appendChild(volPopup);const r=panel.querySelector('#vkl-volume-btn').getBoundingClientRect();volPopup.style.left=(r.left+r.width/2-20)+'px';volPopup.style.top=(r.top-(volPopup.offsetHeight||130)-8)+'px';setTimeout(()=>{const close=e2=>{if(!volPopup?.contains(e2.target)&&e2.target!==panel.querySelector('#vkl-volume-btn')){volPopup?.remove();volPopup=null;document.removeEventListener('click',close)}};document.addEventListener('click',close)},30)};
}
function startProgressInterval(){if(progressInterval)clearInterval(progressInterval);if(!panel)return;progressInterval=setInterval(()=>{updateProgress();panel?._updatePlayBtn?.();panel?._updateRepeat?.();if(syncedLines.length&&!syncTimer&&isPlaying())startSync()},150)}
function closePanel(){
  panelOpen=false;
  manualScrollMode=false;
  scrollResumeButton?.classList.remove('vkl-scroll-resume--visible');
  panel?.querySelector('.vkl-body')?.classList.remove('vkl-body--manual-scroll');
  restoreNativeLyricsUi();
  panel?.classList.remove('vkl-panel--open');
  document.getElementById('vkl-overlay')?.classList.remove('vkl--open');
  if(progressInterval){clearInterval(progressInterval);progressInterval=null}
  if(panelHealingInterval){clearInterval(panelHealingInterval);panelHealingInterval=null}
}
function openPanel(){
  if(!panel)createPanel();
  panelOpen=true;
  panel.classList.add('vkl-panel--open');
  document.getElementById('vkl-overlay')?.classList.add('vkl--open');
  startProgressInterval();
  startPanelHealing();
  const t=getTrackInfo();
  if(t){
    currentTrack=t;
    const key=trackKey(t);
    if(key!==currentKey){
      onTrackChange();
      return;
    }
    setPanelTrack(t);
    resetProgress();
    // Если текст уже есть — сразу прыгаем к текущей строке без анимации
    if(hasLyrics && syncedLines.length){
      setTimeout(()=>{
        const active=getPanelBody()?.querySelector('.vkl-line--active');
        if(active) active.scrollIntoView({ block: 'center', behavior: 'instant' });
      }, 50);
    }
    // Единственная точка автоматического запроса текста: пользователь открыл панель.
    if(!hasLyrics && lyricsFetchInFlightKey!==key){
      getPanelBody().innerHTML='';
      getPanelBody().classList.remove('vkl-body--manual-scroll');
      manualScrollMode=false;
      lastHighlightedIndex=-1;
      scrollResumeButton?.classList.remove('vkl-scroll-resume--visible');
      setStatus('⏳ Поиск текста…');
      lyricsFetchInFlightKey=key;
      fetchLyrics(t).finally(()=>{if(lyricsFetchInFlightKey===key)lyricsFetchInFlightKey=''})
    }
  }else setStatus('⏳ Ожидание трека…')
}
function updateSourceTabs(){panel?.querySelectorAll('.vkl-src-tab').forEach(x=>x.classList.toggle('vkl-src-tab--active',x.dataset.src===source))}
function showSettingsModal(){const m=document.createElement('div');m.className='vkl-settings-modal';m.innerHTML=`<div class="vkl-settings-content"><h3>Настройки</h3><label><span>Genius Client Access Token</span><input type="password" id="vkl-genius-input" value="" placeholder="Вставьте токен…"></label><div class="vkl-settings-buttons"><button id="vkl-save-genius">Сохранить</button><button id="vkl-close-settings">Закрыть</button></div></div>`;m.querySelector('#vkl-genius-input').value=geniusToken;document.body.appendChild(m);m.querySelector('#vkl-save-genius').onclick=()=>{geniusToken=m.querySelector('#vkl-genius-input').value.trim();saveSettings();m.remove();if(currentTrack)fetchLyrics(currentTrack)};m.querySelector('#vkl-close-settings').onclick=()=>m.remove();m.onclick=e=>{if(e.target===m)m.remove()}}

// ─── Одна кнопка в реальном нижнем плеере Яндекс Музыки ─────────────────────
let playerButton = null;
let playerHost = null;
const playerSelectors = [
  '[class*="player-controls"]','[class*="PlayerControls"]','[class*="playerControls"]',
  '[class*="PlayerBar"]','[class*="playerBar"]','[class*="player-bar"]',
  '[class*="Player__controls"]','[data-testid*="player"]'
];
function isVisible(e){if(!e||!e.isConnected)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0}
function directButtons(e){return [...e.children].filter(x=>x.matches?.('button,[role="button"]'))}
function scoreContainer(e){
  if(!isVisible(e)||e.closest('#vkl-panel,#vkl-overlay'))return -Infinity;
  const r=e.getBoundingClientRect();
  const bs=directButtons(e);
  if(bs.length<2)return -Infinity;
  let score=bs.length*25;
  if(r.width>500)score+=100;
  if(r.height>=35&&r.height<=110)score+=30;
  if(r.bottom>innerHeight-180)score+=180;
  if(r.top>innerHeight*0.65)score+=100;
  if(r.left<innerWidth*0.2)score-=60;
  if(r.width>innerWidth*0.8)score+=60;
  return score;
}
function getBestContainer(){
  // В Моей волне явно берём верхний ряд кнопок
  const vibeProgress=document.querySelector('[class*="VibePlayerBar_progress"]');
  if(vibeProgress && isVisible(vibeProgress)) return vibeProgress;

  const all=new Set();
  for(const s of playerSelectors)document.querySelectorAll(s).forEach(e=>all.add(e));
  const a=audioEl();
  if(a){let e=a.parentElement;for(let i=0;e&&i<7;i++,e=e.parentElement)all.add(e)}
  let best=null,bestScore=-Infinity;
  for(const e of all){const sc=scoreContainer(e);if(sc>bestScore){best=e;bestScore=sc}}
  return best;
}
function removeExtraButtons(keep){
  document.querySelectorAll('.vkl-btn-wrap').forEach(w=>{if(w!==keep)w.remove()});
}
function createPlayerButton(){
  const wrap=document.createElement('div');
  wrap.className='vkl-btn-wrap';
  wrap.dataset.ymlLyricsButton='1';
  const b=document.createElement('button');
  b.type='button';
  b.className='vkl-btn--button';
  b.title='Текст песни';
  b.setAttribute('aria-label','Текст песни');
  b.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
  b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openPanel()},{capture:true});
  b.addEventListener('pointerdown',e=>e.stopPropagation(),{capture:true});
  wrap.appendChild(b);
  return wrap;
}
function isVibePlayer(host){
  return !!(host.closest('[class*="VibePlayerBar"]') || (host.className||'').includes('VibePlayerBar'));
}
function findInsertTarget(host){
  const bs=directButtons(host);
  if(!bs.length)return null;
  if(isVibePlayer(host)){
    // В Моей волне: вставляем перед "Контекстное меню"
    const menu=bs.find(b=>/контекст|меню/i.test(b.getAttribute('aria-label')||''));
    if(menu)return menu;
  }
  // В обычном плеере: перед последней кнопкой
  return bs[bs.length-1];
}
function ensureButtons(){
  const host=getBestContainer();
  if(!host){
    if(playerButton?.isConnected)playerButton.remove();
    playerButton=null;playerHost=null;
    return false;
  }
  // There must be exactly ONE extension button in the entire page.
  if(!playerButton||!playerButton.isConnected)playerButton=createPlayerButton();
  removeExtraButtons(playerButton);
  const target=findInsertTarget(host);
  if(playerButton.parentElement!==host){
    if(target)host.insertBefore(playerButton,target);else host.appendChild(playerButton);
  }else if(target && playerButton.nextElementSibling!==target){
    host.insertBefore(playerButton,target);
  }
  // Фиксируем размер через inline style — берём размер у соседних кнопок Яндекса
  const isVibe=isVibePlayer(host);
  let sz='32px';
  if(isVibe){
    const neighbour=host.querySelector('[aria-label="Нравится"],[aria-label="Контекстное меню"]');
    if(neighbour){
      const w=Math.round(neighbour.getBoundingClientRect().width);
      sz=(w>20?w:46)+'px';
    } else sz='46px';
  }
  playerButton.style.cssText=`width:${sz}!important;height:${sz}!important;flex-shrink:0!important;`;
  const btn=playerButton.querySelector('button');
  if(btn) btn.style.cssText=`width:${sz}!important;height:${sz}!important;min-width:${sz}!important;min-height:${sz}!important;`;
  playerHost=host;
  playerButton.querySelector('button')?.classList.toggle('vkl-btn--active',enabled);
  return true;
}
const mo=new MutationObserver(()=>{
  if(!mo.__scheduled){mo.__scheduled=true;requestAnimationFrame(()=>{mo.__scheduled=false;ensureButtons()})}
});
mo.observe(document.documentElement,{childList:true,subtree:true});
setInterval(ensureButtons,1000);

// externalAPI is the preferred integration point for the current/new Yandex design.
function hookApi(){
  const a=api();
  if(!a||a.__ymlHooked)return false;
  try{
    console.log('[YM-SYNC] Attempting to hook externalAPI events');
    if(a.EVENT_TRACK){
      a.on(a.EVENT_TRACK,onTrackChange);
      console.log('[YM-SYNC] Hooked EVENT_TRACK');
    }
    if(a.EVENT_STATE){
      a.on(a.EVENT_STATE,probe);
      console.log('[YM-SYNC] Hooked EVENT_STATE');
    }
    if(a.EVENT_PROGRESS){
      a.on(a.EVENT_PROGRESS,()=>{
        updateProgress();
        if(syncedLines.length&&isPlaying()&&!syncTimer)startSync()
      });
      console.log('[YM-SYNC] Hooked EVENT_PROGRESS');
    }
    if(a.EVENT_VOLUME){
      a.on(a.EVENT_VOLUME,()=>document.querySelector('.vkl-volume-popup')?._sync?.());
      console.log('[YM-SYNC] Hooked EVENT_VOLUME');
    }
    a.__ymlHooked=true;
    console.log('[YM-SYNC] externalAPI hooks established successfully');
    return true;
  }catch(e){
    console.debug('[YM-SYNC] API hook failed:', e);
    return false;
  }
}
function hookAudio(){
  const a=audioEl();
  if(!a||a.__ymlHooked)return false;
  console.log('[YM-SYNC] Attempting to hook audio element events');
  ['play','pause','timeupdate','durationchange','loadedmetadata','volumechange','ended'].forEach(ev=>{
    a.addEventListener(ev,()=>{
      console.log('[YM-SYNC] Audio event:', ev, 'currentTime:', a.currentTime, 'duration:', a.duration);
      probe();
      updateProgress();
      if(syncedLines.length&&isPlaying()&&!syncTimer)startSync()
    });
  });
  a.__ymlHooked=true;
  console.log('[YM-SYNC] Audio element hooks established');
  return true;
}
function updateAll(){
  validateAndResetBrokenMethods();
  hookApi();
  hookAudio();
  setupUrlObserver();
  setupPlayerBarObserver();
  setupTrackTextObserver();
  probe();
  ensureButtons();
}
setInterval(updateAll,500);setTimeout(updateAll,0);setTimeout(updateAll,500);setTimeout(updateAll,1500);
})();
