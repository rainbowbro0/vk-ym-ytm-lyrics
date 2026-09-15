'use strict';
(async () => {

const w = window;
let enabled     = true;
let source      = 'auto';
let manualScrollMode = false;
let scrollResumeBtn = null;
let autoScrollUntil = 0;
let lastHighlightedIdx = -1;
let geniusToken = '';

let currentKey  = '';
let syncedLines = [];
let syncTimer   = null;
let progressInterval = null;  // добавлено
let audioEl     = null;
let panel       = null;
let panelOpen   = false;
let fetchCallbacks = {};
let currentTrack = null;
let lyricsFetchInFlightKey = '';
let hasLyrics = false; // true если хоть какой-то текст (plain или synced) уже показан
let lastTrackProbeKey = '';
let lastTrackProbeAt = 0;
let coverPollTimer = null;
let coverLoadToken = 0;

// ─── Получить актуальный audio элемент ────────────────────────────────────
function getAudioEl() {
  const vkAudio = w.ap?._impl?.audioElement;
  if (vkAudio && vkAudio.src) { audioEl = vkAudio; return vkAudio; }
  if (audioEl && audioEl.isConnected && audioEl.src) return audioEl;
  const audios = [...document.querySelectorAll('audio[src]')];
  const active = audios.find(a => !a.paused && !a.ended) || audios.find(a => a.readyState > 0);
  if (active) { audioEl = active; return active; }
  audioEl = audios[0] || null;
  return audioEl;
}

// ─── Надёжное отслеживание уже существующих audio ────────────────────────────
const hookedAudio = new WeakSet();
function hookAudioElement(el) {
  if (!(el instanceof HTMLAudioElement) || hookedAudio.has(el)) return;
  hookedAudio.add(el);
  const onPlay = () => {
    audioEl = el;
    try { w.audioEl = el; } catch {}
    // autoplay VK/VK Styles может запустить уже существующий audio до нашего
    // content script — событие play тогда уже потеряно. Здесь ловим все новые.
    onTrackStart();
  };
  const onPause = () => {
    if (audioEl === el) stopSync();
  };
  el.addEventListener('play', onPlay, true);
  el.addEventListener('playing', onPlay, true);
  el.addEventListener('pause', onPause, true);
  el.addEventListener('ended', onPause, true);
  // Если музыка уже играет к моменту подключения — запускаем синхронизацию сразу.
  if (!el.paused && !el.ended) onPlay();
}
function scanAudioElements() {
  document.querySelectorAll('audio').forEach(hookAudioElement);
  const apAudio = w.ap?._impl?.audioElement;
  if (apAudio) hookAudioElement(apAudio);
}

// ─── Bridge ───────────────────────────────────────────────────────────────────
window.addEventListener('message', e => {
  if (!e.data?._vkl) return;

  if (e.data._vkl === 'INIT') {
    enabled     = e.data.enabled;
    source      = e.data.source      || 'auto';
    geniusToken = e.data.geniusToken || '';
    updateButtonState();
    updateSourceTabs();
  }

  if (['MXM_RESULT','GENIUS_RESULT','GENIUS_PAGES_RESULT','LRCLIB_RESULT','KUGOU_RESULT','VK_LYRICS_RESULT'].includes(e.data._vkl)) {
    const cb = fetchCallbacks[e.data.id];
    if (cb) { delete fetchCallbacks[e.data.id]; cb(e.data.data); }
  }
});

function saveSettings() {
  window.postMessage({ _vkl: 'SET_SETTINGS', enabled, source, geniusToken }, '*');
}

function bridgeCall(type, payload) {
  return new Promise(resolve => {
    const id = Math.random().toString(36).slice(2);
    fetchCallbacks[id] = resolve;
    window.postMessage({ _vkl: type, id, ...payload }, '*');
    setTimeout(() => { delete fetchCallbacks[id]; resolve(null); }, 10000);
  });
}

// ─── Хук аудио ───────────────────────────────────────────────────────────────
function hookAP(ap) {
  if (!ap?._impl) return;
  hookVolumeAPI(ap);
  let nk = '', ek = '';
  Object.defineProperty(ap._impl, 'currentNode', {
    get() {
      if (!(nk in this))
        nk = Object.getOwnPropertyNames(this).find(k => k.endsWith('__currentNode')) || '';
      return nk ? this[nk] : null;
    }, configurable: true
  });
  Object.defineProperty(ap._impl, 'audioElement', {
    get() {
      const n = this.currentNode;
      if (!n) return null;
      if (!(ek in n))
        ek = Object.getOwnPropertyNames(n).find(k => k.endsWith('__element')) || '';
      return ek ? n[ek] : null;
    }, configurable: true
  });

  const origPlay = ap._implPlay;
  if (typeof origPlay === 'function') {
    ap._implPlay = function() {
      audioEl = ap._impl.audioElement || audioEl;
      if (audioEl) hookAudioElement(audioEl);
      onTrackStart();
      return origPlay.apply(this, arguments);
    };
  }
  const origPause = ap._impl.pause;
  if (typeof origPause === 'function') {
    ap._impl.pause = function() { stopSync(); return origPause.apply(this, arguments); };
  }
  const origStop = ap.stop;
  if (typeof origStop === 'function') {
    ap.stop = function() { stopSync(); return origStop.apply(this, arguments); };
  }

  // Если панель уже открыта (пользователь открыл до того как ap инициализировался) — запускаем поиск
  if (panelOpen && !currentKey) {
    setTimeout(() => { if (!currentKey) onTrackStart(); }, 300);
  }
}

const origAudio = w.Audio;
w.Audio = function() {
  const n = new origAudio(...arguments);
  hookAudioElement(n);
  return n;
};

const apWatched = new WeakSet();
function watchGlobal(key, handler) {
  let val = w[key];
  handler(val);
  Object.defineProperty(w, key, {
    get: () => val,
    set: v => { handler(v); val = v; },
    configurable: true
  });
}
function ensureAPHooked() {
  const ap = w.ap;
  if (ap && !apWatched.has(ap)) {
    apWatched.add(ap);
    hookAP(ap);
  }
}
// VK может создать ap до запуска MAIN-world content script.
ensureAPHooked();
watchGlobal('ap', ap => {
  if (ap && !apWatched.has(ap)) {
    apWatched.add(ap);
    hookAP(ap);
  }
});
// И дополнительно проверяем уже существующий ap: VK иногда заменяет объект без
// прохождения через наш setter.
setInterval(() => { ensureAPHooked(); scanAudioElements(); }, 500);
scanAudioElements();

// ─── Инфо о треке ─────────────────────────────────────────────────────────────
function decodeHTML(s) {
  if (!s || !s.includes('&')) return s;
  const ENT = { '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&apos;':"'",'&nbsp;':'\u00A0' };
  return s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, x => ENT[x] || x);
}

function getTrackInfo() {
  if (w.ap?._currentAudio) {
    const a = w.ap._currentAudio;
    const title  = decodeHTML(a[3] || '');
    const artist = decodeHTML(a[4] || '');
    // audioId для audio.getLyrics: owner_id_audio_id_hash
    const audioId = (a[0] && a[1] && a[13])
      ? `${a[1]}_${a[0]}_${String(a[13]).split('/')[0]}`
      : '';
    if (title && artist) {
      return { title, artist, duration: a[5] || audioEl?.duration || 0, audioId };
    }
  }
  const ms = navigator.mediaSession?.metadata;
  if (ms?.title && ms?.artist)
    return { title: ms.title.trim(), artist: ms.artist.trim(),
             duration: audioEl?.duration || 0, audioId: '' };
  return null;
}

// ─── Старт трека ──────────────────────────────────────────────────────────────
function onTrackStart(retries = 8) {
  if (!enabled) return;
  setTimeout(() => {
    const track = getTrackInfo();
    if (!track) {
      if (retries > 0) onTrackStart(retries - 1);
      return;
    }

    const key = `${track.artist}||${track.title}`;
    currentTrack = track;

    if (key === currentKey && (syncedLines.length || hasLyrics)) {
      if (!syncTimer && !getAudioEl()?.paused && syncedLines.length) startSync();
      return;
    }

    // Уже идёт загрузка для этого трека — не сбрасываем прогресс повторно
    if (lyricsFetchInFlightKey === key) return;

    // Тот же трек но hasLyrics=false и fetch не запущен — не сбрасываем прогресс,
    // просто запускаем fetch заново (VK Styles мог перезапустить трек)
    if (key === currentKey) {
      lyricsFetchInFlightKey = key;
      Promise.resolve(fetchLyrics(track)).finally(() => {
        if (lyricsFetchInFlightKey === key) lyricsFetchInFlightKey = '';
      });
      return;
    }

    currentKey = key;
    syncedLines = [];
    hasLyrics = false;
    stopSync();

    if (panel) {
      const bar = panel.querySelector('.vkl-progress-bar');
      const inp = panel.querySelector('#vkl-progress-input');
      const ct  = panel.querySelector('.vkl-current-time');
      const dur = panel.querySelector('.vkl-duration');
      if (bar) bar.style.width = '0%';
      if (inp) inp.value = 0;
      if (ct)  ct.textContent = '0:00';
      if (dur) dur.textContent = '0:00';
    }

    if (!panel) createPanel();
    setStatus('⏳ Поиск текста…');
    setPanelTrack(track);
    getPanelBody().innerHTML = '';
    getPanelBody().classList.remove('vkl-body--synced');

    lyricsFetchInFlightKey = key;
    Promise.resolve(fetchLyrics(track)).finally(() => {
      if (lyricsFetchInFlightKey === key) lyricsFetchInFlightKey = '';
    });
  }, 150);
}

function probeCurrentTrack() {
  if (!enabled) return;
  const now = Date.now();
  const el = getAudioEl();
  const playing = !!el && !el.paused && !el.ended;
  const track = getTrackInfo();
  if (!track) return;
  const key = `${track.artist}||${track.title}`;

  currentTrack = track;
  if (panel) setPanelTrack(track);

  if (key !== lastTrackProbeKey || now - lastTrackProbeAt > 1500) {
    lastTrackProbeKey = key;
    lastTrackProbeAt = now;
  }

  // Запускаем поиск если трек сменился или текст ещё не найден (и не ищется)
  if (key !== currentKey || (!hasLyrics && !lyricsFetchInFlightKey)) {
    onTrackStart(4);
  }

  if (playing && syncedLines.length && !syncTimer) startSync();
}

// ─── Sync ─────────────────────────────────────────────────────────────────────
function startSync() {
  stopSync();
  syncTimer = setInterval(() => {
    const el = getAudioEl();
    if (el) highlightLine(el.currentTime);
  }, 250);
}

function stopSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}


function setManualScrollMode(on) {
  manualScrollMode = !!on;
  const body = getPanelBody();
  if (manualScrollMode) {
    body?.classList.add('vkl-body--manual-scroll');
    scrollResumeBtn?.classList.add('vkl-scroll-resume--visible');
  } else {
    body?.classList.remove('vkl-body--manual-scroll');
    scrollResumeBtn?.classList.remove('vkl-scroll-resume--visible');
    const active = getPanelBody()?.querySelector('.vkl-line--active');
    if (active) {
      autoScrollUntil = Date.now() + 1200;
      active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}
function highlightLine(t) {
  if (!syncedLines.length || !panel) return;
  let idx = syncedLines.findIndex(l => l.time > t) - 1;
  if (idx < 0) idx = 0;
  const body = getPanelBody();
  if (!body) return;
  const lines = body.querySelectorAll('.vkl-line');
  lines.forEach((el, i) => el.classList.toggle('vkl-line--active', i === idx));
  const active = lines[idx];
  if (active && idx !== lastHighlightedIdx && !manualScrollMode) {
    lastHighlightedIdx = idx;
    autoScrollUntil = Date.now() + 1200;
    active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else {
    lastHighlightedIdx = idx;
  }
}

// ─── Каскадный поиск ──────────────────────────────────────────────────────────
async function fetchLyrics(track) {
  const keyAtStart = currentKey;

  if (source !== 'auto') {
    setStatus(`⏳ ${sourceName(source)}…`);
    const res = await fetchOne(source, track);
    if (currentKey !== keyAtStart) return;
    if (res) { renderLyrics(res); return; }
    setStatus(`😶 ${sourceName(source)}: не найдено`);
    // Любой вручную выбранный источник не нашёл текст — останавливаем watcher
    hasLyrics = true;
    return;
  }

  // MXM временно убран из авто — их API банит запросы (токен 000...)
  const sources = ['vk', 'lrclib', ...(geniusToken ? ['genius'] : [])];
  setStatus('⏳ Поиск…');

  const promises = sources.map(src => fetchOne(src, track).catch(() => null));

  // Ждём первый SYNCED результат
  try {
    const synced = await Promise.any(
      promises.map(p => p.then(r => {
        if (r?.type === 'synced') return r;
        throw new Error('not synced');
      }))
    );
    if (currentKey !== keyAtStart) return;
    renderLyrics(synced);
    return;
  } catch {}

  if (currentKey !== keyAtStart) return;

  // Нет synced — ждём все и берём лучший plain
  const results = await Promise.all(promises);
  if (currentKey !== keyAtStart) return;
  const cache = Object.fromEntries(sources.map((s, i) => [s, results[i]]));
  for (const src of sources) {
    if (cache[src]) { renderLyrics(cache[src]); return; }
  }

  setStatus('😶 Текст не найден');
  // Все источники ничего не нашли — помечаем hasLyrics=true чтобы watcher
  // не спамил повторными попытками для этого трека.
  hasLyrics = true;
}

function sourceName(s) {
  return { vk: 'VK', musixmatch: 'Musixmatch', lrclib: 'LRCLIB', genius: 'Genius' }[s] || s;
}

// Конвертируем VK субтитры {start,end,text} (ms) в LRC строку

async function fetchVK(track) {
  if (!track.audioId) return null;
  try {
    // Читаем access_token из localStorage (VK хранит его там)
    let accessToken = '';
    try {
      const raw = localStorage.getItem('6287487:web_token:login:auth');
      if (raw) accessToken = JSON.parse(raw)?.access_token || '';
    } catch {}
    if (!accessToken) return null;
    const res = await bridgeCall('VK_LYRICS', { audioId: track.audioId, accessToken });
    if (res) return res;
  } catch (e) { console.log('[VKL] fetchVK error:', e.message); }
  return null;
}

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

    if (!hits.length) {
      // Slug fallback через background (страницы genius.com)
      return bridgeCall('GENIUS', { artist, title, token });
    }

    // Страницы грузим через background (там нет CORS проблем для genius.com)
    // Передаём сами хиты — background проверит совпадение исполнителя/названия
    return bridgeCall('GENIUS_PAGES', { hits: hits.slice(0, 8), artist, title });
  } catch (e) {
    console.log('[VKL] Genius in-page:', e.message);
    return null;
  }
}


async function fetchOne(src, track) {
  switch (src) {
    case 'vk':        return fetchVK(track);
    case 'musixmatch': return bridgeCall('MXM',    { artist: track.artist, title: track.title, duration: track.duration });
    case 'lrclib':     return bridgeCall('LRCLIB', { artist: track.artist, title: track.title, duration: track.duration });
    case 'genius':     return geniusToken ? fetchGeniusInPage(track.artist, track.title, geniusToken) : null;
  }
  return null;
}

// ─── LRC Parser ───────────────────────────────────────────────────────────────
function parseLRC(lrc) {
  const lines = [];
  // Поддерживаем и [mm:ss.xx], и [mm:ss], а также несколько таймкодов
  // в одной строке. Служебные LRC-теги без текста игнорируются.
  const tagRe = /\[(\d+):(\d{1,2}(?:\.\d+)?)\]/g;
  for (const rawLine of String(lrc || '').split(/\r?\n/)) {
    const tags = [...rawLine.matchAll(tagRe)];
    if (!tags.length) continue;
    const text = rawLine.replace(tagRe, '').trim();
    for (const m of tags) {
      const minutes = Number(m[1]);
      const seconds = Number(m[2]);
      if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
        lines.push({ time: minutes * 60 + seconds, text: text || '♩' });
      }
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

// ─── Рендер ───────────────────────────────────────────────────────────────────
function renderLyrics({ type, content, url, fullTitle, source }) {
  stopSync();
  const body = getPanelBody();
  body.innerHTML = '';

  if (type === 'genius_url') {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.className = 'vkl-genius-link';
    a.textContent = `📖 Открыть на Genius\n${fullTitle}`;
    body.appendChild(a);
    setStatus(`🔗 ${source || 'Genius'}`);
    return;
  }

  if (type === 'synced') {
    syncedLines = parseLRC(content);
    hasLyrics = true;
    body.classList.add('vkl-body--synced');
    for (const { text } of syncedLines) {
      const el = document.createElement('div');
      el.className = 'vkl-line';
      el.textContent = text || '♩';
      body.appendChild(el);
    }
    setStatus(`🎵 ${source || 'Текст'} (синхр.)`);
    startSync();
    body.scrollTop = 0;
    return;
  }

  syncedLines = [];
  body.classList.remove('vkl-body--synced');
  for (const line of content.split('\n')) {
    const el = document.createElement('div');
    el.className = 'vkl-line';
    el.textContent = line;
    body.appendChild(el);
  }
  hasLyrics = true;
  setStatus(`📄 ${source || 'Текст'}`);
  body.scrollTop = 0;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function getPanelBody()  { return panel?.querySelector('.vkl-body'); }
function getPanelStatus(){ return panel?.querySelector('.vkl-status'); }
function setStatus(t)    { const el = getPanelStatus(); if (el) el.textContent = t; }

function getNoCoverUrl() {
  try {
    return document.documentElement?.dataset?.vklNoCoverUrl || '';
  } catch {
    return '';
  }
}

function isUsableCoverSrc(src) {
  return typeof src === 'string' && /^https?:\/\//i.test(src) &&
    /(?:sun\d+[-.]|userapi\.com|vk\.com\/doc)/i.test(src);
}

function pickCoverUrlFromValue(value) {
  if (value == null || value === false) return '';
  if (typeof value === 'string') {
    const parts = value.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (isUsableCoverSrc(parts[i])) return parts[i];
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const thumb = value.thumb && typeof value.thumb === 'object' ? value.thumb : value;
  const keys = [
    'photo_1200', 'photo_600', 'photo_300', 'photo_270', 'photo_135',
    'photo_68', 'photo_34', 'src', 'url', 'coverUrl', 'cover', 'covers'
  ];
  for (const key of keys) {
    const found = pickCoverUrlFromValue(thumb[key]);
    if (found) return found;
  }
  return '';
}

function audioMatchesTrack(audio, track) {
  if (!audio || !track) return false;
  const title = decodeHTML(Array.isArray(audio) ? (audio[3] || '') : (audio.title || '')).trim();
  const artist = decodeHTML(Array.isArray(audio)
    ? (audio[4] || '')
    : (audio.artist || audio.performer || '')).trim();
  return title === String(track.title || '').trim() &&
    artist === String(track.artist || '').trim();
}

// Источник истины — данные УЖЕ нового трека в ap._currentAudio.
// Пустой cover (null / undefined / '') значит обложки нет: нельзя подставлять
// оставшийся в MediaSession/DOM artwork предыдущего трека.
function getCoverFromCurrentAudio(track) {
  try {
    const audio = w.ap?._currentAudio;
    if (!audioMatchesTrack(audio, track)) return { ready: false, url: null };

    const blobs = Array.isArray(audio)
      ? [audio[14], audio.coverUrl, audio.covers]
      : [audio.coverUrl, audio.covers, audio.cover, audio.thumb];

    for (const blob of blobs) {
      const url = pickCoverUrlFromValue(blob);
      if (url) return { ready: true, url };
    }
    return { ready: true, url: null };
  } catch {
    return { ready: false, url: null };
  }
}

function getCurrentTrackCoverFromData(track) {
  try {
    const ms = navigator.mediaSession?.metadata;
    if (!ms?.artwork?.length) return null;
    const sameTrack =
      String(ms.title || '').trim() === String(track?.title || '').trim() &&
      String(ms.artist || '').trim() === String(track?.artist || '').trim();
    if (!sameTrack) return null;
    for (const x of ms.artwork) {
      const src = x?.src;
      if (isUsableCoverSrc(src)) return src;
    }
  } catch {}
  return null;
}

function findCoverImg() {
  const selectors = [
    '[class*=AudioPlayer] img',
    '[class*=audioPlayer] img',
    '[data-testid*=AudioPlayer] img',
    '[class*=audio_player] img',
    '[class*=PlayerBarLeft] img',
    '[class*=playerBarLeft] img',
    '.audio_player img',
    '[class*=CoverImage] img',
    '[class*=cover] img[src*=sun9]',
    '[class*=cover] img[src*=vk]',
  ];
  for (const sel of selectors) {
    try {
      const imgs = [...document.querySelectorAll(sel)];
      for (const img of imgs) {
        const src = img?.currentSrc || img?.src || '';
        if (!src || src.includes('data:')) continue;
        if (isUsableCoverSrc(src)) return src;
      }
    } catch {}
  }
  return null;
}

function setPanelTrack({ artist, title }) {
  if (!panel) return;
  const tEl = panel.querySelector('.vkl-track');
  const aEl = panel.querySelector('.vkl-artist');
  if (tEl) tEl.textContent = title;
  if (aEl) aEl.textContent = artist;

  const cover = panel.querySelector('.vkl-cover');
  if (!cover) return;

  const trackKey = `${artist}||${title}`;
  const prevTrackKey = cover.dataset.vklTrackKey || '';
  const trackChanged = prevTrackKey !== trackKey;
  const previousRealSrc = cover.dataset.vklRealCoverSrc || '';
  const noCoverUrl = getNoCoverUrl();
  cover.dataset.vklTrackKey = trackKey;

  const stopCoverPoll = () => {
    if (coverPollTimer) {
      clearInterval(coverPollTimer);
      coverPollTimer = null;
    }
  };

  const commitCover = (src, real) => {
    if (!src || cover.dataset.vklTrackKey !== trackKey) return false;

    let art = cover.querySelector('img.vkl-cover-art');
    let glow = cover.querySelector('img.vkl-cover-glow');
    if (!art || !glow) {
      cover.textContent = '';
      glow = document.createElement('img');
      glow.className = 'vkl-cover-glow';
      glow.alt = '';
      glow.draggable = false;
      glow.setAttribute('aria-hidden', 'true');
      art = document.createElement('img');
      art.className = 'vkl-cover-art';
      art.width = 52;
      art.height = 52;
      art.alt = '';
      art.draggable = false;
      cover.appendChild(glow);
      cover.appendChild(art);
    }

    glow.src = src;
    art.src = src;
    art.dataset.vklSrc = src;

    cover.dataset.glowReady = '1';

    if (real) {
      cover.dataset.vklRealCoverSrc = src;
      cover.dataset.fallback = '0';
    } else {
      cover.removeAttribute('data-vkl-real-cover-src');
      cover.dataset.fallback = '1';
    }
    return true;
  };

  const applyCover = (src, real = true) => {
    if (!src || cover.dataset.vklTrackKey !== trackKey) return false;
    if (!real && noCoverUrl && src === noCoverUrl && cover.dataset.fallback === '1') {
      const img = cover.querySelector('img.vkl-cover-art');
      if (img?.dataset.vklSrc === src) return true;
    }
    if (real && cover.dataset.fallback === '0' && cover.dataset.vklRealCoverSrc === src) {
      return true;
    }

    const token = ++coverLoadToken;
    const preload = new Image();
    let settled = false;
    const finish = (ok) => {
      if (settled || token !== coverLoadToken || cover.dataset.vklTrackKey !== trackKey) return;
      settled = true;
      if (!ok) {
        if (real) showNoCover();
        return;
      }
      commitCover(src, real);
    };

    preload.addEventListener('load', () => finish(true), { once: true });
    preload.addEventListener('error', () => finish(false), { once: true });
    preload.src = src;
    if (preload.complete) finish(preload.naturalWidth > 0);
    return true;
  };

  const showNoCover = () => {
    if (noCoverUrl) applyCover(noCoverUrl, false);
    else {
      coverLoadToken++;
      cover.textContent = '🎵';
      cover.removeAttribute('data-vkl-real-cover-src');
      cover.removeAttribute('data-glow-ready');
      cover.dataset.fallback = '1';
    }
  };

  const applyResolvedCover = (url) => {
    stopCoverPoll();
    if (isUsableCoverSrc(url)) applyCover(url, true);
    else showNoCover();
  };

  if (!trackChanged && cover.dataset.fallback === '0' && cover.dataset.vklRealCoverSrc) {
    return;
  }

  if (trackChanged) {
    coverLoadToken++;
    stopCoverPoll();
    cover.removeAttribute('data-vkl-real-cover-src');
    cover.dataset.fallback = '';
  }

  // Сначала ждём данные ИМЕННО нового трека. Только потом решаем src.
  // Пустая обложка в _currentAudio важнее «хвоста» старой картинки в MS/DOM.
  const audioCover = getCoverFromCurrentAudio({ artist, title });
  if (audioCover.ready) {
    applyResolvedCover(audioCover.url);
    return;
  }

  if (!trackChanged && cover.dataset.fallback === '1') return;
  if (coverPollTimer) return;

  let attempts = 24;
  let stableSrc = '';
  let stableCount = 0;
  const previousSrc = trackChanged ? previousRealSrc : (cover.dataset.vklRealCoverSrc || '');
  coverPollTimer = setInterval(() => {
    if (!panel || !document.body.contains(panel) || cover.dataset.vklTrackKey !== trackKey) {
      stopCoverPoll();
      return;
    }

    const fromAudio = getCoverFromCurrentAudio({ artist, title });
    if (fromAudio.ready) {
      applyResolvedCover(fromAudio.url);
      return;
    }

    const msSrc = getCurrentTrackCoverFromData({ artist, title });
    const src = (msSrc && msSrc !== previousSrc) ? msSrc : findCoverImg();
    if (src && src !== previousSrc) {
      if (src === stableSrc) stableCount++;
      else { stableSrc = src; stableCount = 1; }
      if (stableCount >= 2) {
        applyResolvedCover(src);
        return;
      }
    }

    if (--attempts <= 0) {
      applyResolvedCover(null);
    }
  }, 120);

}

function updateButtonState() {
  if (typeof updateAllButtonInstances === 'function') updateAllButtonInstances();
  else document.getElementById('vkl-btn')?.classList.toggle('vkl-btn--active', enabled);
}

function updateSourceTabs() {
  if (!panel) return;
  panel.querySelectorAll('.vkl-src-tab').forEach(t =>
    t.classList.toggle('vkl-src-tab--active', t.dataset.src === source)
  );
}

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

// ─── Громкость ────────────────────────────────────────────────────────────────
// VK хранит gain линейно 0..1, а показывает perceptual/UI значение:
// UI = gain^(1/3) * 100. Поэтому источником истины здесь является ap.getVolume(),
// а не найденный в DOM range: на странице VK есть несколько других slider-ов,
// из-за которых расширение раньше иногда показывало 100% или несколько % мимо.
let cachedVolumeUi = null;
let manualVolumeUntil = 0;
let lastObservedGain = null;

// Небольшая поправка к perceptual-шкале VK. На практике raw gain VK
// отображается примерно на 2 п.п. ниже нашей линейной шкалы. Поэтому
// при чтении вычитаем коррекцию, а при записи добавляем её обратно.
// Это компенсирует стабильное расхождение вроде VK=50% <-> extension=52%.
const VK_UI_CALIBRATION = 2;

function gainToUi(gain) {
  const g = clamp01(gain);
  if (g === null) return null;
  return Math.max(0, Math.min(1, Math.cbrt(g) - VK_UI_CALIBRATION / 100));
}
function uiToGain(ui) {
  const u = clamp01(ui);
  if (u === null) return null;
  const calibrated = Math.min(1, u + VK_UI_CALIBRATION / 100);
  return calibrated * calibrated * calibrated;
}

function readDirectVkGain() {
  try {
    const ap = w.ap;
    if (ap && typeof ap.getVolume === 'function') {
      const gain = Number(ap.getVolume());
      if (Number.isFinite(gain)) return clamp01(gain);
    }
  } catch {}
  return null;
}

function getCurrentVolume() {
  // После ручного изменения UI-кэш является источником истины, пока VK
  // асинхронно применяет новое значение.
  if (cachedVolumeUi !== null && Date.now() < manualVolumeUntil) return cachedVolumeUi;

  const gain = readDirectVkGain();
  if (gain !== null) {
    lastObservedGain = gain;
    cachedVolumeUi = gainToUi(gain);
    return cachedVolumeUi;
  }

  // Если ap ещё не создан, лучше вернуть последнее известное значение, чем
  // ошибочно показывать 100%.
  return cachedVolumeUi;
}

function syncExternalVolume() {
  if (Date.now() < manualVolumeUntil) return;

  const gain = readDirectVkGain();
  if (gain === null) return;

  if (lastObservedGain === null || Math.abs(gain - lastObservedGain) > 0.0001) {
    lastObservedGain = gain;
    cachedVolumeUi = gainToUi(gain);
  }
}

function setCurrentVolume(ui) {
  const uiVal = clamp01(ui);
  if (uiVal === null) return;
  const gain = uiToGain(uiVal);
  if (gain === null) return;

  // Сразу обновляем UI-кэш. Асинхронный ap.setVolume() не сможет вернуть
  // ползунок к старому промежуточному значению.
  cachedVolumeUi = uiVal;
  lastObservedGain = gain;
  manualVolumeUntil = Date.now() + 1500;

  try {
    if (typeof w.ap?.setVolume === 'function') {
      w.ap.setVolume(gain);
      return;
    }
  } catch {}
  try {
    if (typeof w.ap?._impl?.setVolume === 'function') {
      w.ap._impl.setVolume(gain);
      return;
    }
  } catch {}
  const el = getAudioEl();
  if (el) try { el.volume = gain; } catch {}
}

function hookVolumeAPI(ap) {
  if (!ap || ap.__vklVolumeHooked) return;
  try {
    if (typeof ap.getVolume === 'function') {
      const origGet = ap.getVolume;
      ap.getVolume = function() {
        const gain = origGet.apply(this, arguments);
        const n = Number(gain);
        if (Date.now() >= manualVolumeUntil && Number.isFinite(n)) {
          lastObservedGain = clamp01(n);
          cachedVolumeUi = gainToUi(n);
        }
        return gain;
      };
    }
    if (typeof ap.setVolume === 'function') {
      const origSet = ap.setVolume;
      ap.setVolume = function(gain) {
        const n = Number(gain);
        if (Number.isFinite(n)) {
          const clamped = clamp01(n);
          lastObservedGain = clamped;
          cachedVolumeUi = gainToUi(clamped);
          manualVolumeUntil = Date.now() + 1500;
        }
        return origSet.apply(this, arguments);
      };
    }
  } catch {}
  try { ap.__vklVolumeHooked = true; } catch {}
}

// ─── Создание панели (новый UI как VK app) ────────────────────────────────────
const SOURCES = [
  { id: 'auto',       label: 'Авто' },
  { id: 'vk',         label: 'VK' },
  { id: 'lrclib',     label: 'LRCLIB' },
  { id: 'genius',     label: 'Genius' },
];

function createPanel() {
  if (panel) return;

  const overlay = document.createElement('div');
  overlay.id = 'vkl-overlay';
  overlay.addEventListener('click', closePanel);
  document.body.appendChild(overlay);

  panel = document.createElement('div');
  panel.id = 'vkl-panel';
  panel.className = 'vkl-panel';

  panel.innerHTML = `
    <div class="vkl-panel-topbar">
      <button class="vkl-topbar-btn" id="vkl-settings-btn" title="Настройки">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96a6.97 6.97 0 0 0-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.477.477 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
      </button>
      <button class="vkl-topbar-btn vkl-close" id="vkl-close">✕</button>
    </div>
    <div class="vkl-panel-header">
      <div class="vkl-cover">🎵</div>
      <div class="vkl-header-text">
        <div class="vkl-track">— Ожидание трека —</div>
        <div class="vkl-artist"></div>
      </div>
    </div>
    <div class="vkl-source-bar"></div>
    <div class="vkl-status">Ожидание трека…</div>
    <div class="vkl-body-wrap">
      <div class="vkl-body"></div>
      <button class="vkl-scroll-resume" title="Вернуть синхронизацию">⏱</button>
    </div>
    <div class="vkl-controls-bottom">
      <div class="vkl-progress">
        <div class="vkl-progress-track"></div>
        <div class="vkl-progress-bar" id="vkl-progress-bar"></div>
        <input type="range" class="vkl-progress-input" id="vkl-progress-input" min="0" max="100" value="0">
      </div>
      <div class="vkl-time">
        <span class="vkl-current-time">0:00</span>
        <span class="vkl-duration">0:00</span>
      </div>
      <div class="vkl-buttons">
        <button class="vkl-control-btn" id="vkl-repeat-btn" title="Повтор">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
        </button>
        <button class="vkl-control-btn" id="vkl-prev-btn" title="Предыдущий">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
        </button>
        <button class="vkl-play-btn" id="vkl-play-btn" title="Play/Pause">
          <svg class="vcf-icon-play" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          <svg class="vcf-icon-pause" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>
        <button class="vkl-control-btn" id="vkl-next-btn" title="Следующий">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm2-8.14L11.03 12 8 14.14V9.86zM16 6h2v12h-2z"/></svg>
        </button>
        <button class="vkl-settings-btn" id="vkl-volume-btn" title="Громкость">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
        </button>
      </div>
    </div>
  `;

  const sourceBar = panel.querySelector('.vkl-source-bar');
  SOURCES.forEach(s => {
    const tab = document.createElement('button');
    tab.className = 'vkl-src-tab' + (s.id === source ? ' vkl-src-tab--active' : '');
    tab.dataset.src = s.id;
    tab.textContent = s.label;
    sourceBar.appendChild(tab);
  });

  // Закрыть
  panel.querySelector('#vkl-close').addEventListener('click', closePanel);

  // Вкладки источников
  panel.querySelectorAll('.vkl-src-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      source = tab.dataset.src;
      setManualScrollMode(false);
      updateSourceTabs();
      saveSettings();
      if (currentTrack) {
        stopSync();
        syncedLines = [];
        hasLyrics = false;
        getPanelBody().innerHTML = '';
        getPanelBody().classList.remove('vkl-body--synced');
        fetchLyrics(currentTrack);
      }
    });
  });

  // Play/Pause кнопка — состояние берём у самого VK-плеера/его audio,
  // а действие по возможности передаём нативной кнопке VK. Это не даёт
  // нашему значку жить в отдельном состоянии от реального проигрывания.
  const playBtn = panel.querySelector('#vkl-play-btn');

  function findVkPlayPauseButton() {
    const selectors = [
      '[data-testid*="PlayButton"]',
      '[data-testid*="playButton"]',
      'button[aria-label*="Пауза"]',
      'button[aria-label*="пауза"]',
      'button[aria-label*="Pause"]',
      'button[aria-label*="pause"]',
      'button[aria-label*="Воспроизвести"]',
      'button[aria-label*="воспроизвести"]',
      'button[aria-label*="Play"]',
      'button[aria-label*="play"]',
      '[class*="PlayButton"]',
      '[class*="playButton"]'
    ];

    const seen = new Set();
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el) || el === playBtn || el.closest('#vkl-panel')) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return el;
      }
    }
    return null;
  }

  function getPlaybackPaused() {
    const el = getAudioEl();
    if (el) return !!el.paused;

    const vkBtn = findVkPlayPauseButton();
    if (vkBtn) {
      const label = `${vkBtn.getAttribute('aria-label') || ''} ${vkBtn.getAttribute('title') || ''} ${vkBtn.className || ''}`.toLowerCase();
      if (/pause|пауза|playing|playingstate/.test(label)) return false;
    }
    return true;
  }

  panel._updatePlayBtn = () => {
    const paused = getPlaybackPaused();
    const playIcon = playBtn.querySelector('.vcf-icon-play');
    const pauseIcon = playBtn.querySelector('.vcf-icon-pause');
    if (playIcon) playIcon.style.display = paused ? '' : 'none';
    if (pauseIcon) pauseIcon.style.display = paused ? 'none' : '';
    playBtn.title = paused ? 'Воспроизвести' : 'Пауза';
    playBtn.setAttribute('aria-label', paused ? 'Воспроизвести' : 'Пауза');
  };
  const updatePlayBtn = panel._updatePlayBtn;
  updatePlayBtn();

  playBtn.addEventListener('click', () => {
    const paused = getPlaybackPaused();
    const vkPlay = findVkPlayPauseButton();

    if (vkPlay) {
      vkPlay.click();
    } else if (paused && typeof w.ap?.play === 'function') {
      w.ap.play();
    } else if (!paused && typeof w.ap?.pause === 'function') {
      w.ap.pause();
    } else {
      const el = getAudioEl();
      if (el) paused ? el.play() : el.pause();
    }

    // VK обновляет своё состояние асинхронно.
    setTimeout(updatePlayBtn, 30);
    setTimeout(updatePlayBtn, 150);
    setTimeout(updatePlayBtn, 400);
  });

  document.addEventListener('play',  updatePlayBtn, true);
  document.addEventListener('pause', updatePlayBtn, true);
  document.addEventListener('ended', updatePlayBtn, true);

  // При смене трека VK создаёт новый audio-элемент, поэтому проверяем
  // состояние периодически, а не вешаем слушатели только на один старый node.
  panel._mediaStateInterval = setInterval(() => {
    if (!panel || !document.body.contains(panel)) return;
    getAudioEl();
    updatePlayBtn();
    const popup = document.querySelector('.vkl-volume-popup');
    popup?._sync?.();
    if (syncedLines.length && !syncTimer && !getPlaybackPaused()) startSync();
  }, 250);

  // Prev кнопка
  panel.querySelector('#vkl-prev-btn').addEventListener('click', () => {
    if (typeof w.ap?.playPrev === 'function') w.ap.playPrev();
    else if (typeof w.ap?.prev === 'function') w.ap.prev();
    else if (typeof w.ap?.prevAudio === 'function') w.ap.prevAudio();
    else { const el = getAudioEl(); if (el) el.currentTime = 0; }
  });

  // Next кнопка
  panel.querySelector('#vkl-next-btn').addEventListener('click', () => {
    if (typeof w.ap?.playNext === 'function') w.ap.playNext();
    else if (typeof w.ap?.next === 'function') w.ap.next();
    else if (typeof w.ap?.nextAudio === 'function') w.ap.nextAudio();
  });
  
  // Repeat кнопка — 0: выкл, 1: повтор всего, 2: повтор трека
  let repeatState = 0;
  const repeatBtn = panel.querySelector('#vkl-repeat-btn');
  repeatBtn.addEventListener('click', () => {
    repeatState = (repeatState + 1) % 3;
    repeatBtn.classList.toggle('vkl-control-btn--active', repeatState > 0);
    repeatBtn.title = ['Повтор выкл', 'Повтор всего', 'Повтор трека'][repeatState];
    try {
      if (typeof w.ap?.setRepeat === 'function') {
        w.ap.setRepeat(repeatState);
      } else if (typeof w.ap?.toggleRepeat === 'function') {
        w.ap.toggleRepeat();
      } else {
        // Fallback: кликаем по кнопке repeat в VK плеере
        const vkRepeatBtn = document.querySelector(
          '[data-testid*="Repeat"], [class*="repeat"]:not(#vkl-repeat-btn), ' +
          'button[aria-label*="повтор"], button[aria-label*="repeat"]'
        );
        if (vkRepeatBtn) vkRepeatBtn.click();
      }
    } catch (e) { console.log('[VK Lyrics] Repeat error:', e.message); }
  });

  // Настройки кнопка
  panel.querySelector('#vkl-settings-btn').addEventListener('click', showSettingsModal);

  // Громкость кнопка
  let volumePopup = null;
  panel.querySelector('#vkl-volume-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (volumePopup) { volumePopup.remove(); volumePopup = null; return; }

    syncExternalVolume();
    const currentVol = getCurrentVolume();
    const vol = Math.round((currentVol ?? 0) * 100);

    volumePopup = document.createElement('div');
    volumePopup.className = 'vkl-volume-popup';
    volumePopup.innerHTML = `
      <span class="vkl-volume-pct"></span>
      <input class="vkl-volume-slider" type="range" min="0" max="100" value="0" step="1">
      <div class="vkl-vol-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="rgba(255,255,255,0.4)">
          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
        </svg>
      </div>
    `;
    volumePopup.querySelector('.vkl-volume-pct').textContent = vol + '%';
    volumePopup.querySelector('.vkl-volume-slider').value = vol;

    const slider = volumePopup.querySelector('.vkl-volume-slider');
    const pct    = volumePopup.querySelector('.vkl-volume-pct');

    let isDragging = false;
    let syncBlocked = false; // блокируем _sync после ручного изменения
    slider.addEventListener('mousedown',  () => { isDragging = true; });
    slider.addEventListener('touchstart', () => { isDragging = true; }, { passive: true });
    slider.addEventListener('mouseup',  () => { isDragging = false; });
    slider.addEventListener('touchend', () => { isDragging = false; });

    // Синхронизация: читаем громкость VK и обновляем наш ползунок
    volumePopup._sync = () => {
      if (isDragging) return;
      syncExternalVolume();
      const currentVol = getCurrentVolume();
      if (currentVol === null) return;
      const current = Math.round(currentVol * 100);
      if (parseInt(slider.value, 10) !== current) {
        slider.value = current;
        pct.textContent = `${current}%`;
      }
    };
    volumePopup._sync();

    // Polling пока popup открыт
    let syncInterval = setInterval(() => { volumePopup?._sync(); }, 200);
    const origRemove = volumePopup.remove.bind(volumePopup);
    volumePopup.remove = () => { clearInterval(syncInterval); origRemove(); };

    slider.addEventListener('input', () => {
      const v = parseInt(slider.value, 10) / 100;
      pct.textContent = `${slider.value}%`;
      // Сначала фиксируем UI-кэш, затем отправляем gain в VK.
      // Это исключает возврат к промежуточному значению при следующем polling.
      syncBlocked = true;
      clearTimeout(slider._unblockTimer);
      slider._unblockTimer = setTimeout(() => { syncBlocked = false; }, 800);
      setCurrentVolume(v);
    });

    // Клики внутри popup не должны всплывать и закрывать его
    volumePopup.addEventListener('click', e => e.stopPropagation());
    volumePopup.addEventListener('mousedown', e => e.stopPropagation());
    volumePopup.addEventListener('pointerdown', e => e.stopPropagation());

    document.body.appendChild(volumePopup);

    // Позиция — над кнопкой
    const btn  = panel.querySelector('#vkl-volume-btn');
    const rect = btn.getBoundingClientRect();
    const pw   = volumePopup.offsetWidth || 40;
    const ph   = volumePopup.offsetHeight || 130;
    volumePopup.style.left = (rect.left + rect.width / 2 - pw / 2) + 'px';
    volumePopup.style.top  = (rect.top - ph - 8) + 'px';

    // Закрыть при клике вне
    setTimeout(() => {
      document.addEventListener('click', function closeVol(ev) {
        if (!volumePopup?.contains(ev.target) && ev.target.id !== 'vkl-volume-btn') {
          volumePopup?.remove(); volumePopup = null;
          document.removeEventListener('click', closeVol);
        }
      });
    }, 50);
  });

  // Прогресс бар
  const progressInput = panel.querySelector('#vkl-progress-input');
  progressInput.addEventListener('input', e => {
    const el = audioEl || w.ap?._impl?.audioElement;
    if (el) el.currentTime = (e.target.value / 100) * el.duration;
  });


  // Обновление прогресса при воспроизведении
  const updateProgress = () => {
    const el = getAudioEl();
    if (!el || el.readyState < 1 || !isFinite(el.duration) || el.duration <= 0) return;
    const percent = Math.min(100, (el.currentTime / el.duration) * 100);
    progressInput.value = percent;
    panel.querySelector('.vkl-progress-bar').style.width = percent + '%';
    panel.querySelector('.vkl-current-time').textContent = formatTime(el.currentTime);
    panel.querySelector('.vkl-duration').textContent     = formatTime(el.duration);
  };

  // Сохраняем updateProgress глобально для перезапуска
  panel._updateProgress = updateProgress;

  if (audioEl) {
    audioEl.addEventListener('timeupdate', updateProgress);
    audioEl.addEventListener('loadedmetadata', updateProgress);
  }

  // Кнопка возврата синхронизации
  scrollResumeBtn = panel.querySelector('.vkl-scroll-resume');
  if (scrollResumeBtn) {
    scrollResumeBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); setManualScrollMode(false); });
  }
  // Ручной скролл — отключаем автоцентрирование
  const bodyEl = getPanelBody();
  if (bodyEl) {
    let scrollTimeout;
    bodyEl.addEventListener('wheel', () => {
      if (syncedLines.length) setManualScrollMode(true);
    }, { passive: true });
    bodyEl.addEventListener('touchmove', () => {
      if (syncedLines.length) setManualScrollMode(true);
    }, { passive: true });
    bodyEl.addEventListener('scroll', () => {
      if (!syncedLines.length) return;
      if (Date.now() < autoScrollUntil) return;
      setManualScrollMode(true);
    }, { passive: true });
    // Скроллбар — правый край
    bodyEl.addEventListener('pointerdown', e => {
      const r = bodyEl.getBoundingClientRect();
      if (e.clientX >= r.right - 14) setManualScrollMode(true);
    }, { passive: true });
  }

  startProgressInterval();
  document.body.appendChild(panel);
}

function startProgressInterval() {
  if (progressInterval) clearInterval(progressInterval);
  const fn = panel?._updateProgress;
  if (!fn) return;
  progressInterval = setInterval(fn, 200);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function showSettingsModal() {
  const modal = document.createElement('div');
  modal.className = 'vkl-settings-modal';
  modal.innerHTML = `
    <div class="vkl-settings-content">
      <h3>Настройки</h3>
      <label>
        <span>Genius Client Access Token</span>
        <input type="password" id="vkl-genius-input" placeholder="Вставьте токен…" value="">
      </label>
      <div class="vkl-settings-buttons">
        <button id="vkl-save-genius">Сохранить</button>
        <button id="vkl-close-settings">Закрыть</button>
      </div>
    </div>
  `;
  modal.querySelector('#vkl-genius-input').value = geniusToken;
  document.body.appendChild(modal);

  modal.querySelector('#vkl-save-genius').addEventListener('click', () => {
    geniusToken = modal.querySelector('#vkl-genius-input').value.trim();
    saveSettings();
    modal.remove();
    if (currentTrack) { getPanelBody().innerHTML = ''; fetchLyrics(currentTrack); }
  });

  modal.querySelector('#vkl-close-settings').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function closePanel() {
  panelOpen = false;
  panel?.classList.remove('vkl-panel--open');
  document.getElementById('vkl-overlay')?.classList.remove('vkl--open');
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
  if (panel?._mediaStateInterval) {
    clearInterval(panel._mediaStateInterval);
    panel._mediaStateInterval = null;
  }
}

function openPanel() {
  if (!panel) createPanel();
  panelOpen = true;
  panel.classList.add('vkl-panel--open');
  document.getElementById('vkl-overlay')?.classList.add('vkl--open');
  startProgressInterval();

  // Если трек уже известен — обновляем заголовок
  if (currentTrack && panel) {
    setPanelTrack(currentTrack);
  }
  if (!currentKey) {
    // ap может ещё не быть готов — пробуем несколько раз
    const tryFetchCurrent = (attempts) => {
      const track = getTrackInfo();
      if (track) {
        const key = `${track.artist}||${track.title}`;
        currentKey = key;
        currentTrack = track;
        syncedLines = [];
        hasLyrics = false;
        stopSync();
        getPanelBody().innerHTML = '';
        getPanelBody().classList.remove('vkl-body--synced');
        setStatus('⏳ Поиск текста…');
        fetchLyrics(track);
      } else if (attempts > 0) {
        setTimeout(() => tryFetchCurrent(attempts - 1), 500);
      }
    };
    tryFetchCurrent(10); // пробуем 10 раз с интервалом 500мс = до 5 сек
  } else if (syncedLines.length && !getAudioEl()?.paused) {
    startSync();
  }

  if (!panel._mediaStateInterval) {
    panel._mediaStateInterval = setInterval(() => {
      if (!panel || !document.body.contains(panel)) return;
      getAudioEl();
      panel._updatePlayBtn?.();
      document.querySelector('.vkl-volume-popup')?._sync?.();
      if (syncedLines.length && !syncTimer && !getAudioEl()?.paused) {
        startSync();
      }
    }, 250);
  }
}

// ─── Кнопка в плеере ──────────────────────────────────────────────────────────
// VK Styles сам отслеживает реальные контейнеры плеера и добавляет в них .cp_e.
// При sticky VK может держать старый и новый контейнер одновременно во время
// анимации/перестройки. Поэтому Lyrics заранее присутствует ВО ВСЕХ подходящих
// контейнерах. Это убирает даже короткий провал при первом скролле.
const VKS_PLAYER_CONTAINER_SELECTORS = [
  'div:is([class*=__userButtonsContainer],[data-testid="AudioPlayerBlock_LayoutGroups_After"]>div)'
];

const lyricsButtonRefs = new Set();
let buttonInstanceSeq = 0;

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function isOurUI(el) {
  return !!el?.closest('#vkl-panel, #vkl-overlay');
}

function getPlayerContainers() {
  const out = new Set();
  for (const selector of VKS_PLAYER_CONTAINER_SELECTORS) {
    document.querySelectorAll(selector).forEach(el => {
      // Не вставляем кнопку в верхний sticky-плеер (контейнер, отмеченный
      // VK как stTopNavigation__player). Именно этот контейнер даёт
      // нежелательную кнопку рядом с названием текущего трека.
      if (el.isConnected && !isOurUI(el) && !el.closest('li[class*="stTopNavigation__player"]')) {
        out.add(el);
      }
    });
  }

  return [...out];
}

function removeButtonFromStickyPlayer() {
  document.querySelectorAll('li[class*="stTopNavigation__player"] .vkl-btn-wrap[data-vkl-button-instance]')
    .forEach(wrap => wrap.remove());
}

function getEqInContainer(container) {
  return container?.querySelector?.('.cp_e:not([data-vkl-ignore])') || null;
}

function createLyricsButton() {
  const wrap = document.createElement('div');
  wrap.className = 'vkl-btn-wrap';
  wrap.dataset.vklButtonInstance = String(++buttonInstanceSeq);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vkl-btn--button';
  btn.title = 'VK Lyrics';
  btn.setAttribute('aria-label', 'VK Lyrics');
  if (enabled) btn.classList.add('vkl-btn--active');

  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
    viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 18V5l12-2v13"/>
    <circle cx="6" cy="18" r="3"/>
    <circle cx="18" cy="16" r="3"/>
  </svg>`;

  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (panelOpen) closePanel();
    else {
      openPanel();
      if (!currentKey) onTrackStart();
    }
  });

  btn.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    enabled = !enabled;
    saveSettings();
    updateButtonState();
    if (!enabled) {
      stopSync();
      closePanel();
    }
  });

  wrap.appendChild(btn);
  lyricsButtonRefs.add(wrap);
  return wrap;
}

function updateAllButtonInstances() {
  for (const wrap of [...lyricsButtonRefs]) {
    if (!wrap.isConnected) continue;
    wrap.querySelector('.vkl-btn--button')?.classList.toggle('vkl-btn--active', enabled);
  }
}

function getButtonInContainer(container) {
  return container?.querySelector?.(':scope > .vkl-btn-wrap[data-vkl-button-instance]') || null;
}

function ensureButtonInContainer(container) {
  if (!container || !container.isConnected || isOurUI(container)) return false;

  let wrap = getButtonInContainer(container);
  const eq = getEqInContainer(container);

  if (!wrap) {
    wrap = createLyricsButton();
  }

  // ВАЖНО: позиционирование делаем относительно .cp_e именно в этом контейнере.
  // Даже если VK Styles ещё не успел добавить эквалайзер, кнопка уже находится
  // в новом player-container и не исчезает на переходе sticky.
  if (eq) {
    if (wrap.parentElement !== container || wrap.nextElementSibling !== eq) {
      container.insertBefore(wrap, eq);
    }
  } else if (wrap.parentElement !== container) {
    container.appendChild(wrap);
  }

  return true;
}

function isNavbarButton(wrap) {
  return !!wrap.closest('[class*=__userButtonsContainer]');
}

function isPopupButton(wrap) {
  return !!wrap.closest('[class*=vkuiPopover_host], [data-testid="AudioLayer_Popover"]');
}

function removeAllButtons() {
  for (const wrap of [...lyricsButtonRefs]) {
    // навбар и попап плеера не трогаем — они видны на любой странице
    if (isNavbarButton(wrap) || isPopupButton(wrap)) continue;
    wrap.remove();
    lyricsButtonRefs.delete(wrap);
  }
  if (buttonGhost) { buttonGhost.remove(); buttonGhost = null; }
  lastButtonRect = null;
  removeButtonFromStickyPlayer();
}

function isAudioPage() {
  return /^\/(audio(s[^\/]*)?)|(artist\/)|(music\/)|(playlist\/)|(album\/)/.test(location.pathname);
}

function tryInsertButton() {
  // Если кнопка осталась от предыдущей версии, сразу убираем её из sticky-плеера.
  removeButtonFromStickyPlayer();

  // На не-музыкальных страницах убираем только кнопку из топбар-плеера.
  // Кнопка в попапе и навбаре остаётся — она доступна везде.
  if (!isAudioPage()) { removeAllButtons(); }

  const containers = getPlayerContainers();
  if (!containers.length) return false;

  let changed = false;
  // Не выбираем только "текущий" контейнер. Держим кнопку во всех экземплярах
  // плеера, которые VK сейчас держит в DOM. Скрытый/старый экземпляр не мешает,
  // а новый sticky уже готов до того, как старый будет удалён.
  for (const container of containers) {
    if (ensureButtonInContainer(container)) changed = true;
  }

  updateAllButtonInstances();
  return changed;
}

let insertScheduled = false;
function scheduleButtonInsert() {
  if (insertScheduled) return;
  insertScheduled = true;
  requestAnimationFrame(() => {
    insertScheduled = false;
    tryInsertButton();
  });
}

const buttonObserver = new MutationObserver(scheduleButtonInsert);
if (document.documentElement) {
  buttonObserver.observe(document.documentElement, { childList: true, subtree: true });
}

// ─── Переход между обычным и sticky-плеером ────────────────────────────────
// VK на несколько кадров может скрыть старый player-container раньше, чем
// новый станет видимым. Чтобы кнопка визуально не мигала, держим лёгкую
// "копию-переходник" в последней известной позиции только на время такого
// разрыва. Как только любой реальный экземпляр становится видимым — копия
// убирается.
let buttonGhost = null;
let lastButtonRect = null;

function getVisibleLyricsButton() {
  for (const wrap of lyricsButtonRefs) {
    const btn = wrap.querySelector('.vkl-btn--button');
    if (btn && isVisible(btn)) return btn;
  }
  return null;
}

function ensureButtonGhost() {
  if (!lastButtonRect || buttonGhost) return;
  buttonGhost = document.createElement('button');
  buttonGhost.type = 'button';
  buttonGhost.className = 'vkl-btn--button vkl-btn--ghost';
  buttonGhost.setAttribute('aria-hidden', 'true');
  buttonGhost.tabIndex = -1;
  buttonGhost.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  document.body.appendChild(buttonGhost);
}

let _ghostHideCount = 0;
function updateButtonGhost() {
  const real = getVisibleLyricsButton();
  if (real) {
    const r = real.getBoundingClientRect();
    if (r.width && r.height) lastButtonRect = r;
    // Убираем ghost только когда кнопка стабильно видна 3 кадра подряд
    _ghostHideCount++;
    if (_ghostHideCount >= 3 && buttonGhost) {
      buttonGhost.remove();
      buttonGhost = null;
    }
    return;
  }
  _ghostHideCount = 0;
  if (!lastButtonRect) return;
  ensureButtonGhost();
  if (!buttonGhost) return;
  buttonGhost.style.left = `${lastButtonRect.left}px`;
  buttonGhost.style.top = `${lastButtonRect.top}px`;
  buttonGhost.style.width = `${lastButtonRect.width}px`;
  buttonGhost.style.height = `${lastButtonRect.height}px`;
}

window.addEventListener('wheel', () => {
  // wheel срабатывает ДО скролла — успеваем запомнить позицию
  const real = getVisibleLyricsButton();
  if (real) {
    const r = real.getBoundingClientRect();
    if (r.width && r.height) lastButtonRect = r;
    ensureButtonGhost();
    if (buttonGhost && lastButtonRect) {
      buttonGhost.style.left = `${lastButtonRect.left}px`;
      buttonGhost.style.top = `${lastButtonRect.top}px`;
      buttonGhost.style.width = `${lastButtonRect.width}px`;
      buttonGhost.style.height = `${lastButtonRect.height}px`;
    }
  }
}, { passive: true });

window.addEventListener('scroll', () => {
  const real = getVisibleLyricsButton();
  if (real) {
    const r = real.getBoundingClientRect();
    if (r.width && r.height) lastButtonRect = r;
  }
  updateButtonGhost();
}, { passive: true });

// rAF loop — синхронно с отрисовкой браузера
(function rafLoop() {
  updateButtonGhost();
  requestAnimationFrame(rafLoop);
})();

// ─── SPA-навигация: убираем кнопку при уходе со страницы музыки ──────────────
let _lastPathname = location.pathname;
function onSpaNavigate() {
  if (location.pathname !== _lastPathname) {
    _lastPathname = location.pathname;
    if (!isAudioPage()) removeAllButtons();
    else tryInsertButton();
  }
}
window.addEventListener('popstate', onSpaNavigate);
// VK меняет URL через history.pushState — перехватываем
(function patchHistoryState() {
  const orig = history.pushState.bind(history);
  history.pushState = function(...args) { orig(...args); onSpaNavigate(); };
  const origR = history.replaceState.bind(history);
  history.replaceState = function(...args) { origR(...args); onSpaNavigate(); };
})();

// При загрузке страницы ждём настоящий контейнер плеера. Navbar больше никогда
// не используется как fallback.
tryInsertButton();

// Частый watchdog нужен для sticky-перехода, когда VK перестраивает плеер
// несколькими синхронными операциями.
setInterval(tryInsertButton, 50);

// Постоянный watcher состояния VK/VK Styles.
// Не зависит от play-события: если автозапуск произошёл до content script,
// периодически проверяем текущий трек и запускаем поиск/синхронизацию сами.
setInterval(() => {
  if (!enabled) return;
  ensureAPHooked();
  scanAudioElements();
  probeCurrentTrack();
}, 300);

// Первый запуск сразу после загрузки скрипта.
setTimeout(() => { ensureAPHooked(); scanAudioElements(); probeCurrentTrack(); }, 0);
setTimeout(() => { ensureAPHooked(); scanAudioElements(); probeCurrentTrack(); }, 250);
setTimeout(() => { ensureAPHooked(); scanAudioElements(); probeCurrentTrack(); }, 750);
setTimeout(() => { ensureAPHooked(); scanAudioElements(); probeCurrentTrack(); }, 1500);

})();
