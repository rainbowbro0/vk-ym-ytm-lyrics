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
  // YouTube Music играет через <video> внутри ytmusic-player
  const ytVideo = document.querySelector('ytmusic-player video, video.video-stream, video');
  if (ytVideo && (ytVideo.src || ytVideo.currentSrc)) { audioEl = ytVideo; return ytVideo; }
  if (audioEl && audioEl.isConnected && (audioEl.src || audioEl.currentSrc)) return audioEl;
  const medias = [...document.querySelectorAll('video, audio')].filter(m => m.src || m.currentSrc);
  const active = medias.find(m => !m.paused && !m.ended) || medias.find(m => m.readyState > 0);
  if (active) { audioEl = active; return active; }
  audioEl = medias[0] || null;
  return audioEl;
}

// ─── Надёжное отслеживание уже существующих audio ────────────────────────────
const hookedAudio = new WeakSet();
function hookAudioElement(el) {
  if (!(el instanceof HTMLMediaElement) || hookedAudio.has(el)) return;
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
  document.querySelectorAll('video, audio').forEach(hookAudioElement);
}

// ─── Bridge ───────────────────────────────────────────────────────────────────
window.addEventListener('message', e => {
  if (!e.data?._vkl) return;

  if (e.data._vkl === 'INIT') {
    enabled     = true; // состояние "выключено" не используется
    source      = e.data.source      || 'auto';
    geniusToken = e.data.geniusToken || '';
    updateButtonState();
    updateSourceTabs();
  }

  if (['MXM_RESULT','GENIUS_RESULT','LRCLIB_RESULT','KUGOU_RESULT','YT_LYRICS_RESULT'].includes(e.data._vkl)) {
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
// YouTube Music играет через один постоянный <video>-элемент и меняет треки
// без нового события play — смену трека ловит probeCurrentTrack(), а
// play/pause/ended — слушатели на медиа-элементах (hookAudioElement).
const origAudio = w.Audio;
w.Audio = function() {
  const n = new origAudio(...arguments);
  hookAudioElement(n);
  return n;
};

setInterval(() => { scanAudioElements(); }, 500);
scanAudioElements();

// YouTube Music включает CSP Trusted Types: innerHTML и DOMParser запрещены.
// Весь DOM строим императивно через createElement/textContent/appendChild.
const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

function svgIcon(size, pathD, fill) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', fill || 'currentColor');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', pathD);
  svg.appendChild(p);
  return svg;
}

function noteSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M9 18V5l12-2v13');
  const c1 = document.createElementNS(SVG_NS, 'circle');
  c1.setAttribute('cx', '6'); c1.setAttribute('cy', '18'); c1.setAttribute('r', '3');
  const c2 = document.createElementNS(SVG_NS, 'circle');
  c2.setAttribute('cx', '18'); c2.setAttribute('cy', '16'); c2.setAttribute('r', '3');
  svg.append(p, c1, c2);
  return svg;
}

// ─── Инфо о треке ─────────────────────────────────────────────────────────────
function decodeHTML(s) {
  if (!s || !s.includes('&')) return s;
  const named = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', ndash:'–', mdash:'—' };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = (ent[1] === 'x' || ent[1] === 'X')
        ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const lower = ent.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : m;
  });
}

function getTrackInfo() {
  const ms = navigator.mediaSession?.metadata;
  const bar = document.querySelector('ytmusic-player-bar');
  let title = '', artist = '';
  if (bar) {
    title  = bar.querySelector('.title')?.textContent?.trim() || '';
    artist = bar.querySelector('.subtitle a')?.textContent?.trim()
          || bar.querySelector('.subtitle')?.textContent?.trim() || '';
  }
  if (!title && ms?.title) title = ms.title.trim();
  if (!artist && ms?.artist) artist = ms.artist.trim();
  // У YTMusic при паузе subtitle иногда дублирует title
  if (artist && title && artist === title && ms?.artist) artist = ms.artist.trim();
  if (title && artist) {
    return { title, artist, duration: audioEl?.duration || 0, audioId: '' };
  }
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
    getPanelBody()?.replaceChildren();
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
  const sources = ['yt', 'lrclib', ...(geniusToken ? ['genius'] : [])];
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
  return { yt: 'YouTube', musixmatch: 'Musixmatch', lrclib: 'LRCLIB', genius: 'Genius' }[s] || s;
}

// ─── YouTube Music lyrics (Innertube) ─────────────────────────────────────────
function getYTVideoId() {
  try {
    const pr = document.getElementById('movie_player')?.getPlayerResponse?.();
    if (pr?.videoDetails?.videoId) return pr.videoDetails.videoId;
  } catch {}
  try {
    const img = document.querySelector(
      'ytmusic-player-bar .image img, ytmusic-player-bar img, ytmusic-player img');
    const m = (img?.src || '').match(/\/vi\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  } catch {}
  return '';
}

function getInnertubeConfig() {
  try {
    const d = window.ytcfg?.data_ || {};
    return {
      apiKey: d.INNERTUBE_API_KEY || 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
      clientVersion: d.INNERTUBE_CLIENT_VERSION || '1.20240901.01.00'
    };
  } catch {
    return { apiKey: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
             clientVersion: '1.20240901.01.00' };
  }
}

function ytDeepFind(obj, key, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj[key]);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') ytDeepFind(v, key, out);
  }
  return out;
}

function ytMsToLrc(ms) {
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(2).padStart(5, '0');
  return `${String(min).padStart(2, '0')}:${sec}`;
}

function ytFindLyricsBrowseId(nextJson) {
  try {
    const tabs = nextJson?.contents?.singleColumnMusicWatchNextResultsRenderer
      ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs;
    if (!Array.isArray(tabs)) return '';
    for (const t of tabs) {
      const tr = t?.tabRenderer;
      const bid = tr?.endpoint?.browseEndpoint?.browseId || '';
      const title = String(tr?.title || '').toLowerCase();
      if (bid.startsWith('MPLYt') || /текст|lyrics/.test(title)) return bid;
    }
    const second = tabs[1]?.tabRenderer?.endpoint?.browseEndpoint?.browseId;
    if (second && second.startsWith('MPLYt')) return second;
  } catch {}
  return '';
}

// Innertube прямо из контекста страницы: те же куки и visitor-id, что у самого YTMusic
async function ytInnertubePage(endpoint, bodyExtra = {}, clientOverride = null) {
  const cfg = window.ytcfg?.data_ || {};
  const client = clientOverride || {
    clientName: cfg.INNERTUBE_CLIENT_NAME || 'WEB_REMIX',
    clientVersion: cfg.INNERTUBE_CLIENT_VERSION || '1.20240901.01.00',
    hl: cfg.LANG || 'ru',
    gl: cfg.GL || 'RU'
  };
  const body = { context: { client }, ...bodyExtra };
  const key = cfg.INNERTUBE_API_KEY || '';
  try {
    const res = await fetch(`https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false&key=${key}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.VISITOR_DATA ? { 'X-Goog-Visitor-Id': cfg.VISITOR_DATA } : {})
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) { console.log('[YTL]', endpoint, 'HTTP', res.status); return null; }
    return await res.json();
  } catch (e) {
    console.log('[YTL]', endpoint, 'ошибка:', e.message);
    return null;
  }
}

async function fetchYT(track) {
  const videoId = getYTVideoId();
  if (!videoId) { console.log('[YTL] videoId не определён'); return null; }
  try {
    const nextJson = await ytInnertubePage('next', { videoId });
    const browseId = ytFindLyricsBrowseId(nextJson);
    console.log('[YTL] videoId=%s browseId=%s', videoId, browseId || '(нет)');
    if (!browseId) return null;

    const timedJson = await ytInnertubePage('browse', { browseId }, {
      clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50', hl: 'ru', gl: 'RU'
    });
    const timed = ytDeepFind(timedJson, 'timedLyricsData')[0];
    if (Array.isArray(timed) && timed.length) {
      const lines = [];
      for (const raw of timed) {
        const text = (raw?.lyricLine || '').trim();
        const start = Number(raw?.cueRange?.startTimeMilliseconds);
        if (!text || !Number.isFinite(start)) continue;
        lines.push(`[${ytMsToLrc(start)}]${text}`);
      }
      console.log('[YTL] синхронизированных строк:', lines.length);
      if (lines.length > 2) {
        return { type: 'synced', content: lines.join('\n'), source: 'YouTube' };
      }
    }

    const webJson = await ytInnertubePage('browse', { browseId });
    for (const shelf of ytDeepFind(webJson, 'musicDescriptionShelfRenderer')) {
      const runs = shelf?.description?.runs;
      if (!Array.isArray(runs) || !runs.length) continue;
      const first = runs[0]?.text || '';
      const text = (first.includes('\n') ? first : runs.map(r => r?.text || '').join('\n')).trim();
      console.log('[YTL] обычный текст, длина:', text.length);
      if (text.length > 10) {
        return { type: 'plain', content: text, source: 'YouTube' };
      }
    }
  } catch (e) { console.log('[YTL] fetchYT error:', e.message); }
  return null;
}

async function fetchOne(src, track) {
  switch (src) {
    case 'musixmatch': return bridgeCall('MXM',    { artist: track.artist, title: track.title, duration: track.duration });
    case 'yt':         return fetchYT(track);
    case 'lrclib':     return bridgeCall('LRCLIB', { artist: track.artist, title: track.title, duration: track.duration });
    case 'genius':     return geniusToken ? bridgeCall('GENIUS', { artist: track.artist, title: track.title, token: geniusToken }) : null;
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
  body?.replaceChildren();

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
    /(?:ytimg\.com|googleusercontent\.com|ggpht\.com)/i.test(src);
}

// Источник истины — плеер-бар YTMusic. Возвращаем обложку только когда в нём
// уже данные ИМЕННО нового трека, чтобы не подставить арт предыдущего.
function getCoverFromCurrentAudio(track) {
  try {
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar) return { ready: false, url: null };
    const barTitle = bar.querySelector('.title')?.textContent?.trim() || '';
    if (barTitle !== String(track?.title || '').trim()) return { ready: false, url: null };
    const img = bar.querySelector('.image img, .thumbnail-image-wrapper img, img');
    const src = img?.src || '';
    if (/^https?:/i.test(src) && !src.includes('data:')) return { ready: true, url: src };
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
    'ytmusic-player-bar .image img',
    'ytmusic-player-bar .thumbnail-image-wrapper img',
    'ytmusic-player .image img',
    '#player img',
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
// Работаем напрямую с нативным слайдером YTMusic (#volume-slider,
// Polymer two-way binding): читаем его value, пишем в него же с событиями —
// приложение воспринимает это как реальное перетаскивание.
function getYtVolumeSlider() {
  const bar = document.querySelector('ytmusic-player-bar');
  return (bar?.querySelector('#volume-slider')) || document.querySelector('#volume-slider') || null;
}

function getCurrentVolume() {
  const s = getYtVolumeSlider();
  if (s) {
    const v = Number(s.value ?? s.immediateValue);
    if (Number.isFinite(v)) return clamp01(v / 100);
  }
  const el = getAudioEl();
  // YouTube: media.volume = (slider/100)^3 — кубическая шкала
  return el ? clamp01(Math.cbrt(clamp01(el.volume))) : null;
}

function syncExternalVolume() {}

function setCurrentVolume(ui) {
  const val = Math.round(clamp01(ui) * 100);
  const s = getYtVolumeSlider();
  if (s) {
    try {
      s.value = val;
      s.setAttribute('value', String(val));
      for (const type of ['change', 'immediate-value-changed', 'value-changed']) {
        s.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
      }
      return;
    } catch {}
  }
  const el = getAudioEl();
  if (el) try { el.volume = Math.pow(clamp01(ui), 3); } catch {}
}

// ─── Создание панели (новый UI как VK app) ────────────────────────────────────
const SOURCES = [
  { id: 'auto',       label: 'Авто' },
  { id: 'yt',         label: 'YouTube' },
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

  const tabsRow = h('div', { class: 'vkl-source-bar' });
  for (const s of SOURCES) {
    tabsRow.appendChild(h('button', {
      class: 'vkl-src-tab' + (s.id === source ? ' vkl-src-tab--active' : ''),
      'data-src': s.id, text: s.label
    }));
  }

  const playIcon = svgIcon(20, 'M8 5v14l11-7z'); playIcon.classList.add('vcf-icon-play');
  const pauseIcon = svgIcon(20, 'M6 19h4V5H6v14zm8-14v14h4V5h-4z'); pauseIcon.classList.add('vcf-icon-pause');
  pauseIcon.style.display = 'none';

  panel.append(
    h('div', { class: 'vkl-panel-topbar' },
      h('button', { class: 'vkl-topbar-btn', id: 'vkl-settings-btn', title: 'Настройки' },
        svgIcon(14, 'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96a6.97 6.97 0 0 0-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.477.477 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z')),
      h('button', { class: 'vkl-topbar-btn vkl-close', id: 'vkl-close', text: '✕' })),
    h('div', { class: 'vkl-panel-header' },
      h('div', { class: 'vkl-cover', text: '🎵' }),
      h('div', { class: 'vkl-header-text' },
        h('div', { class: 'vkl-track', text: '— Ожидание трека —' }),
        h('div', { class: 'vkl-artist' }))),
    tabsRow,
    h('div', { class: 'vkl-status', text: 'Ожидание трека…' }),
    h('div', { class: 'vkl-body-wrap' },
      h('div', { class: 'vkl-body' }),
      h('button', { class: 'vkl-scroll-resume', title: 'Вернуть синхронизацию', text: '⏱' })),
    h('div', { class: 'vkl-controls-bottom' },
      h('div', { class: 'vkl-progress' },
        h('div', { class: 'vkl-progress-track' }),
        h('div', { class: 'vkl-progress-bar', id: 'vkl-progress-bar' }),
        h('input', { type: 'range', class: 'vkl-progress-input', id: 'vkl-progress-input', min: '0', max: '100', value: '0' })),
      h('div', { class: 'vkl-time' },
        h('span', { class: 'vkl-current-time', text: '0:00' }),
        h('span', { class: 'vkl-duration', text: '0:00' })),
      h('div', { class: 'vkl-buttons' },
        h('button', { class: 'vkl-control-btn', id: 'vkl-dislike-btn', title: 'Не нравится' }, svgIcon(16, 'M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z')),
        h('button', { class: 'vkl-control-btn', id: 'vkl-repeat-btn', title: 'Повтор' }, svgIcon(16, 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z')),
        h('button', { class: 'vkl-control-btn', id: 'vkl-prev-btn', title: 'Предыдущий' }, svgIcon(16, 'M6 6h2v12H6zm3.5 6l8.5 6V6z')),
        h('button', { class: 'vkl-play-btn', id: 'vkl-play-btn', title: 'Play/Pause' }, playIcon, pauseIcon),
        h('button', { class: 'vkl-control-btn', id: 'vkl-next-btn', title: 'Следующий' }, svgIcon(16, 'M6 18l8.5-6L6 6v12zm2-8.14L11.03 12 8 14.14V9.86zM16 6h2v12h-2z')),
        h('button', { class: 'vkl-control-btn', id: 'vkl-like-btn', title: 'Нравится' }, svgIcon(16, 'M1 21h4V9H1v12zM23 10c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z')),
        h('button', { class: 'vkl-settings-btn', id: 'vkl-volume-btn', title: 'Громкость' }, svgIcon(14, 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z')))));

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
        getPanelBody()?.replaceChildren();
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
    const el = document.querySelector(
      'ytmusic-player-bar .play-pause-button, ytmusic-player .play-pause-button, .play-pause-button');
    if (!el || el === playBtn || el.closest('#vkl-panel')) return null;
    const r = el.getBoundingClientRect();
    return (r.width > 0 && r.height > 0) ? el : null;
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
    panel._updateLikeBtns?.();
    const popup = document.querySelector('.vkl-volume-popup');
    popup?._sync?.();
    if (syncedLines.length && !syncTimer && !getPlaybackPaused()) startSync();
  }, 250);

  // Prev кнопка
  panel.querySelector('#vkl-prev-btn').addEventListener('click', () => {
    const btn = document.querySelector('ytmusic-player-bar .previous-button, .previous-button');
    if (btn) btn.click();
    else { const el = getAudioEl(); if (el) el.currentTime = 0; }
  });

  // Next кнопка
  panel.querySelector('#vkl-next-btn').addEventListener('click', () => {
    document.querySelector('ytmusic-player-bar .next-button, .next-button')?.click();
  });
  
  // Repeat кнопка — 0: выкл, 1: повтор всего, 2: повтор трека
  let repeatState = 0;
  const repeatBtn = panel.querySelector('#vkl-repeat-btn');
  function clickNativeRepeat() {
    const candidates = [
      'ytmusic-player-bar .repeat-button',
      '.repeat-button',
      'ytmusic-player-bar [title*="Повтор"]', 'ytmusic-player-bar [title*="Repeat"]',
      'ytmusic-player-bar tp-yt-paper-icon-button[aria-label*="повтор"]',
      'ytmusic-player-bar tp-yt-paper-icon-button[aria-label*="repeat"]'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().width > 0) { el.click(); return true; }
    }
    console.log('[YTL] нативная кнопка повтора не найдена');
    return false;
  }

  repeatBtn.addEventListener('click', () => {
    repeatState = (repeatState + 1) % 3;
    repeatBtn.classList.toggle('vkl-control-btn--active', repeatState > 0);
    repeatBtn.title = ['Повтор выкл', 'Повтор всего', 'Повтор трека'][repeatState];
    try {
      clickNativeRepeat();
    } catch (e) { console.log('[YTL] Repeat error:', e.message); }
  });

  // Like / Dislike — кликаем по нативным кнопкам YTMusic, состояние читаем
  // из атрибута like-status (LIKE / DISLIKE / INDIFFERENT)
  const likeBtn = panel.querySelector('#vkl-like-btn');
  const dislikeBtn = panel.querySelector('#vkl-dislike-btn');
  function findYtLikeHost() {
    return document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer')
        || document.querySelector('ytmusic-like-button-renderer');
  }
  function ytLikeRoot(host) { return host?.shadowRoot || host; }
  function getYtLikeStatus() {
    try {
      const st = findYtLikeHost()?.getAttribute('like-status');
      if (st === 'LIKE' || st === 'DISLIKE' || st === 'INDIFFERENT') return st;
    } catch {}
    try {
      const root = ytLikeRoot(findYtLikeHost());
      if (root?.querySelector('#like-button')?.getAttribute('aria-pressed') === 'true') return 'LIKE';
      if (root?.querySelector('#dislike-button')?.getAttribute('aria-pressed') === 'true') return 'DISLIKE';
    } catch {}
    return 'INDIFFERENT';
  }
  function clickYtLikeBtn(which) {
    const host = findYtLikeHost();
    if (!host) return false;
    const root = ytLikeRoot(host);
    const b = root?.querySelector(which === 'like' ? '#like-button' : '#dislike-button');
    if (b) { b.click(); return true; }
    // крайний фолбэк: первый/последний paper-icon-button внутри рендерера
    const all = root?.querySelectorAll('tp-yt-paper-icon-button, button');
    const fb = which === 'like' ? all?.[0] : all?.[all.length - 1];
    if (fb) { fb.click(); return true; }
    return false;
  }
  panel._updateLikeBtns = () => {
    const st = getYtLikeStatus();
    likeBtn?.classList.toggle('vkl-control-btn--active', st === 'LIKE');
    dislikeBtn?.classList.toggle('vkl-control-btn--active', st === 'DISLIKE');
  };
  panel._updateLikeBtns();
  likeBtn?.addEventListener('click', () => {
    clickYtLikeBtn('like');
    setTimeout(() => panel._updateLikeBtns?.(), 300);
    setTimeout(() => panel._updateLikeBtns?.(), 900);
  });
  dislikeBtn?.addEventListener('click', () => {
    clickYtLikeBtn('dislike');
    setTimeout(() => panel._updateLikeBtns?.(), 300);
    setTimeout(() => panel._updateLikeBtns?.(), 900);
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
    const volIcon = svgIcon(14, 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z');
    volIcon.setAttribute('fill', 'rgba(255,255,255,0.4)');
    volumePopup.append(
      h('span', { class: 'vkl-volume-pct', text: vol + '%' }),
      h('input', { class: 'vkl-volume-slider', type: 'range', min: '0', max: '100', value: String(vol), step: '1' }),
      h('div', { class: 'vkl-vol-icon' }, volIcon));

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
    const el = getAudioEl();
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
  modal.appendChild(
    h('div', { class: 'vkl-settings-content' },
      h('h3', { text: 'Настройки' }),
      h('label', {},
        h('span', { text: 'Genius Client Access Token' }),
        h('input', { type: 'password', id: 'vkl-genius-input', placeholder: 'Вставьте токен…', value: geniusToken })),
      h('div', { class: 'vkl-settings-buttons' },
        h('button', { id: 'vkl-save-genius', text: 'Сохранить' }),
        h('button', { id: 'vkl-close-settings', text: 'Закрыть' }))));
  document.body.appendChild(modal);

  modal.querySelector('#vkl-save-genius').addEventListener('click', () => {
    geniusToken = modal.querySelector('#vkl-genius-input').value.trim();
    saveSettings();
    modal.remove();
    if (currentTrack) { getPanelBody()?.replaceChildren(); fetchLyrics(currentTrack); }
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
        getPanelBody()?.replaceChildren();
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
      panel._updateLikeBtns?.();
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
  'ytmusic-player-bar #right-controls',
  'ytmusic-player-bar'
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
      if (el.isConnected && !isOurUI(el)) {
        out.add(el);
      }
    });
  }

  // Оставляем только самый вложенный контейнер: если #top-bar-buttons есть,
  // кнопка вставится в него, а дубль напрямую в #right-controls не нужен
  const all = [...out];
  for (const el of all) {
    for (const other of all) {
      if (el !== other && el.contains(other)) out.delete(el);
    }
  }

  return [...out];
}

function removeButtonFromStickyPlayer() {}

function getEqInContainer(container) {
  return null;
}

function createLyricsButton() {
  const wrap = document.createElement('div');
  wrap.className = 'vkl-btn-wrap';
  wrap.dataset.vklButtonInstance = String(++buttonInstanceSeq);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vkl-btn--button';
  btn.title = 'YT Music Lyrics';
  btn.setAttribute('aria-label', 'YT Music Lyrics');
  btn.classList.add('vkl-btn--active'); // 'выключенного' состояния нет — всегда активна

  btn.appendChild(noteSvg());

  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (panelOpen) closePanel();
    else {
      openPanel();
      if (!currentKey) onTrackStart();
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
    // Позиция: ПЕРЕД последней видимой нативной кнопкой
    // (между «перемешать» 🔀 и шевроном «развернуть» ▼)
    let anchor = container.querySelector(':scope > #expand-button');
    if (!anchor) {
      const kids = [...container.children].filter(ch =>
        !ch.classList?.contains('vkl-btn-wrap') && !ch.classList?.contains('vkl-btn-ghost') &&
        ch.getBoundingClientRect().width > 0);
      anchor = kids[kids.length - 1] || null;
    }
    if (anchor && anchor.parentElement === container) container.insertBefore(wrap, anchor);
    else container.appendChild(wrap);
  }

  return true;
}

function isNavbarButton(wrap) {
  return false;
}

function isPopupButton(wrap) {
  return false;
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
  return true; // music.youtube.com целиком про музыку — кнопка нужна везде
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

  if (changed && !tryInsertButton._logged) {
    tryInsertButton._logged = true;
    console.log('[YTL] кнопка вставлена:', containers.map(el => el.tagName + '#' + (el.id || '-')).join(', '));
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
  buttonGhost.appendChild(noteSvg());
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
  scanAudioElements();
  probeCurrentTrack();
}, 300);

// Первый запуск сразу после загрузки скрипта.
setTimeout(() => { scanAudioElements(); probeCurrentTrack(); }, 0);
setTimeout(() => { scanAudioElements(); probeCurrentTrack(); }, 250);
setTimeout(() => { scanAudioElements(); probeCurrentTrack(); }, 750);
setTimeout(() => { scanAudioElements(); probeCurrentTrack(); }, 1500);

})();
