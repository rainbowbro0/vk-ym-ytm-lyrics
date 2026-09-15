'use strict';

// ─── Musixmatch (скрытый резерв — в авто-режиме не используется) ──────────────
let mxmToken = null;
let mxmTokenExpiry = 0;

async function getMxmToken() {
  if (mxmToken && Date.now() < mxmTokenExpiry) return mxmToken;
  try {
    const res = await fetch(
      'https://apic-desktop.musixmatch.com/ws/1.1/token.get?app_id=web-desktop-app-v1.0',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    const tok = data?.message?.body?.user_token;
    if (tok && !/^0+$/.test(tok)) {
      mxmToken = tok;
      mxmTokenExpiry = Date.now() + 10 * 60 * 1000;
    } else {
      mxmToken = null;
      mxmTokenExpiry = Date.now() + 30 * 1000;
    }
    return mxmToken;
  } catch { return null; }
}

async function fetchMxm(artist, title, duration) {
  const token = await getMxmToken();
  if (!token) return null;
  try {
    const p = new URLSearchParams({
      app_id: 'web-desktop-app-v1.0', usertoken: token,
      q_artist: artist, q_track: title,
      q_duration: duration ? Math.round(duration) : '',
      f_subtitle_length_max_deviation: '10',
      subtitle_format: 'lrc', format: 'json'
    });
    const res = await fetch(
      `https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get?${p}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    const calls = data?.message?.body?.macro_calls;
    const foundTrack = calls?.['matcher.track.get']?.message?.body?.track;
    if (foundTrack) {
      const normalize = s => (s || '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
      const titleMatch = !title || normalize(foundTrack.track_name).includes(normalize(title))
        || normalize(title).includes(normalize(foundTrack.track_name));
      const artistMatch = !artist || normalize(foundTrack.artist_name).includes(normalize(artist.split(',')[0].trim()))
        || normalize(artist.split(',')[0].trim()).includes(normalize(foundTrack.artist_name));
      if (!titleMatch && !artistMatch) return null;
    }
    const sub = calls?.['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle;
    if (sub?.subtitle_body) return { type: 'synced', content: sub.subtitle_body, source: 'Musixmatch' };
    const lyr = calls?.['track.lyrics.get']?.message?.body?.lyrics?.lyrics_body;
    if (lyr) return { type: 'plain', content: lyr.replace(/\*{3}.*$/s, '').trim(), source: 'Musixmatch' };
  } catch (e) { console.log('[BG] MXM:', e.message); }
  return null;
}

// ─── LRCLIB ───────────────────────────────────────────────────────────────────
async function fetchLRCLIB(artist, title, duration) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const p = new URLSearchParams({ artist_name: artist, track_name: title });
    if (duration > 0) p.set('duration', Math.round(duration));
    const res = await fetch(`https://lrclib.net/api/get?${p}`, { signal: ctrl.signal });
    if (res.ok) {
      const d = await res.json();
      if (d.syncedLyrics) { clearTimeout(timer); return { type: 'synced', content: d.syncedLyrics, source: 'LRCLIB' }; }
      if (d.plainLyrics)  { clearTimeout(timer); return { type: 'plain',  content: d.plainLyrics,  source: 'LRCLIB' }; }
    }
    const ps = new URLSearchParams({ q: `${artist} ${title}` });
    const res2 = await fetch(`https://lrclib.net/api/search?${ps}`, { signal: ctrl.signal });
    if (res2.ok) {
      const arr = await res2.json();
      if (Array.isArray(arr) && arr.length) {
        const hit = arr[0];
        if (hit.syncedLyrics) { clearTimeout(timer); return { type: 'synced', content: hit.syncedLyrics, source: 'LRCLIB' }; }
        if (hit.plainLyrics)  { clearTimeout(timer); return { type: 'plain',  content: hit.plainLyrics,  source: 'LRCLIB' }; }
      }
    }
  } catch (e) { console.log('[BG] LRCLIB:', e.message); }
  clearTimeout(timer);
  return null;
}

// ─── Genius ───────────────────────────────────────────────────────────────────
function gNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
function gWords(s) { return gNorm(s).split(' ').filter(w => w.length > 1); }
function gOverlap(a, bArr) { const set = new Set(bArr); return a.filter(w => set.has(w)).length; }

function cleanQuery(s) {
  return String(s || '')
    .replace(/[([].*?[)\]]/g, ' ')
    .replace(/\b(feat|ft|prod|при участии|remix|ремикс|explicit|radio edit)\b.*$/gi, ' ')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ').trim();
}

// Извлекает латинский алиас из скобок: "название (alias)" → "alias"
function extractLatinAlias(title) {
  const m = String(title).match(/[(\[]([a-z0-9][a-z0-9\s\-']+)[)\]]/i);
  return m ? m[1].trim() : null;
}

function genSlug(s) {
  return String(s || '').toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '');
}

function slugCandidates(artist, title) {
  const latinAlias = extractLatinAlias(title);
  const titleClean = cleanQuery(title);
  const t = genSlug(titleClean);
  const out = new Set();
  const parts = cleanQuery(artist)
    .split(/\s*(?:,|&|×|\+)\s*|\s+(?:and|x|и)\s+/i)
    .map(s => s.trim()).filter(Boolean);
  const a = genSlug(cleanQuery(artist));

  // Латинский алиас — самые точные варианты, идут первыми
  if (latinAlias) {
    const la = genSlug(latinAlias);
    if (a) out.add(`${a}-${la}-lyrics`);
    if (parts.length >= 2) {
      const a1 = genSlug(parts[0]);
      const a2 = genSlug(parts.slice(1).join(' '));
      if (a1 && a2) {
        out.add(`${a1}-and-${a2}-${la}-lyrics`);
        out.add(`${a1}-${a2}-${la}-lyrics`);
        out.add(`${a1}-${la}-lyrics`);
      }
    }
    out.add(`${la}-lyrics`);
  }

  if (t) {
    if (a) out.add(`${a}-${t}-lyrics`);
    if (parts.length >= 2) {
      const a1 = genSlug(parts[0]);
      const a2 = genSlug(parts.slice(1).join(' '));
      if (a1 && a2) {
        out.add(`${a1}-and-${a2}-${t}-lyrics`);
        out.add(`${a1}-${a2}-${t}-lyrics`);
        out.add(`${a1}-${t}-lyrics`);
        out.add(`${a2}-${t}-lyrics`);
      }
    } else if (parts.length === 1) {
      out.add(`${genSlug(parts[0])}-${t}-lyrics`);
    }
    out.add(`${t}-lyrics`);
  }

  return [...out];
}

function verifySlugPage(html, artist, title) {
  if (!html || html.length < 500) return false;
  if (html.includes('"statusCode":404') || /page not found/i.test(html)) return false;
  // Есть блок с текстом — точно подходит
  if (html.includes('data-lyrics-container="true"')) return true;
  // Мягкая проверка по <title>
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (!m) return false;
  const pageWords = gNorm(m[1]).split(' ');
  const tw = gWords(cleanQuery(title));
  const aw = gWords(cleanQuery(artist));
  const la = extractLatinAlias(title);
  const law = la ? gWords(la) : [];
  return gOverlap(law, pageWords) >= 1 ||
         gOverlap(tw, pageWords) >= 1 ||
         gOverlap(aw, pageWords) >= 1;
}

// ─── Genius: общие хелперы (прокси + парсинг) ─────────────────────────────────
const GENIUS_PROXY = 'https://genius-proxy.rainbowbro0.workers.dev';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g,    (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;|&#0?39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripLyricsBlock(b) {
  return decodeEntities(
    String(b || '')
      // Футер страницы (Embed, How to Format Lyrics, Q&A, Credits, Comments)
      // лежит после текста внутри того же захвата regex — отрезаем по тегам секций
      .replace(/<section[\s\S]*$/i, '')
      .replace(/<footer[\s\S]*$/i, '')
      // Хвост незакрылого тега (напр. "<div ") — захват обрывается по строке
      // data-lyrics-container следующего контейнера
      .replace(/<\/?[a-zA-Z][^<>]*$/, '')
      .replace(/<[^>]*data-exclude-from-selection[^>]*>[\s\S]*?<\/div>/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

// Текстовые сигнатуры Genius-футера — страховка, если разметка изменится
function truncateGeniusJunk(s) {
  const m = String(s || '').match(/EmbedCancel|How to Format Lyrics|AboutHave the inside scoop|Q&AFind answers|CreditsReleased|Expand Comments|Sign Up And Drop Knowledge/);
  return m ? s.slice(0, m.index) : s;
}

// Не используем DOMParser — он недоступен в service worker.
// Три уровня fallback: data-lyrics-container → класс Lyrics__Container → JSON-стейт страницы.
function extractGeniusLyrics(html) {
  if (!html) return '';
  let out = '';
  for (const m of html.matchAll(/data-lyrics-container="true"[^>]*>([\s\S]*?)(?=data-lyrics-container|<\/main|$)/g)) {
    out += truncateGeniusJunk(stripLyricsBlock(m[1])) + '\n';
  }
  if (out.trim().length < 40) {
    out = '';
    for (const m of html.matchAll(/<div[^>]*class="[^"]*Lyrics__Container[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*Lyrics__Container|<\/main|$)/g)) {
      out += truncateGeniusJunk(stripLyricsBlock(m[1])) + '\n';
    }
  }
  if (out.trim().length < 40) {
    const m = html.match(/"body":\{"html":"((?:\\.|[^"\\])*)"/);
    if (m) {
      try {
        out = truncateGeniusJunk(
          decodeEntities(JSON.parse('"' + m[1] + '"'))
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
        );
      } catch {}
    }
  }
  return out.trim();
}

async function fetchGenius(artist, title, token) {
  if (!token) return null;
  try {
    const PAGE_HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html'
    };
    const preloaded = new Map();
    const getPageHtml = async (url) => {
      if (preloaded.has(url)) return preloaded.get(url);
      let html = null;
      // Страницы грузим через CF-воркер: Genius отдаёт прямому Firefox-fetch урезанный HTML без текста
      try {
        const res = await fetch(`${GENIUS_PROXY}/page?url=${encodeURIComponent(url)}`);
        if (res.ok) html = await res.text();
      } catch {}
      if (!html) {
        try {
          const res = await fetch(url, { headers: PAGE_HEADERS });
          if (res.ok) html = await res.text();
        } catch {}
      }
      console.log('[BG] page', url.slice(-45), 'len=', html?.length, 'marker=', html?.includes('data-lyrics-container="true"'));
      preloaded.set(url, html);
      return html;
    };

    const doSearch = async (query) => {
      try {
        // access_token как query param — работает в Firefox где заголовки могут стрипаться
        const url = `https://genius-proxy.rainbowbro0.workers.dev/search?q=${encodeURIComponent(query)}&access_token=${encodeURIComponent(token)}`;  // прокси — обходит блокировку Firefox
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) { console.log('[BG] genius search http', res.status); return []; }
        const data = await res.json();
        return Array.isArray(data?.response?.hits) ? data.response.hits : [];
      } catch { return []; }
    };

    const isSong = h => h?.result?.url &&
      (h.type === 'song' || h.index === 'song' || /-lyrics\/?$/i.test(h.result.url));

    const latinAlias = extractLatinAlias(title);
    const titleClean = cleanQuery(title);
    const qTitleW  = gWords(titleClean);
    const qArtistW = gWords(cleanQuery(artist));
    const qAliasW  = latinAlias ? gWords(latinAlias) : [];

    // Поисковые запросы: латинский алиас первым
    const queries = [...new Set([
      latinAlias ? `${cleanQuery(artist)} ${latinAlias}` : null,
      latinAlias,
      `${artist} ${titleClean}`,
      `${cleanQuery(artist)} ${titleClean}`,
      titleClean,
    ].filter(Boolean))];

    let hits = [];
    const searchResults = await Promise.all(queries.map(q => doSearch(q)));
    for (const r of searchResults) {
      const h = (r || []).filter(isSong);
      if (h.length) { hits = h; break; }
    }

    // Slug fallback
    if (!hits.length) {
      const slugs = slugCandidates(artist, title).slice(0, 8);
      const found = await Promise.all(slugs.map(async slug => {
        const url = `https://genius.com/${slug}`;
        const html = await getPageHtml(url);
        if (!verifySlugPage(html, artist, title)) return null;
        return { result: { url, title, primary_artist: { name: artist } }, type: 'song' };
      }));
      hits = found.filter(Boolean);
    }

    if (!hits.length) return null;

    const candidates = hits.slice(0, 8);
    const raws = await Promise.all(
      candidates.map(c => getPageHtml(c.result.url).then(extractGeniusLyrics))
    );

    for (let i = 0; i < candidates.length; i++) {
      const r = candidates[i].result;
      const raw = raws[i] || '';
      if (!raw || raw.trim().length < 40) continue;

      const hitArtists = [r.primary_artist?.name, ...(r.featured_artists || []).map(f => f.name)].join(' ');
      const artistOverlap = gOverlap(qArtistW, gWords(hitArtists));
      const titleOverlap  = gOverlap(qTitleW,  gWords(r.title));
      const aliasOverlap  = gOverlap(qAliasW,  gWords(r.title));

      const ok = aliasOverlap >= 1 ||
                 titleOverlap >= 2 ||
                 (titleOverlap >= 1 && artistOverlap >= 1) ||
                 artistOverlap >= 2;
      if (!ok) continue;

      // Чистка мусора
      const cleanLines = [];
      const safeTitle = String(r.title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (/^\d+\s+(Contributors|Участников)/i.test(trimmed)) continue;
        if (safeTitle && new RegExp(`^${safeTitle}\\s+Lyrics`, 'i').test(trimmed)) continue;
        if (/^\[Текст песни/i.test(trimmed)) continue;
        cleanLines.push(line);
      }
      while (cleanLines.length && !cleanLines[0].trim()) cleanLines.shift();

      let lyrics = cleanLines.join('\n').trim()
        .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

      const lower = lyrics.toLowerCase();
      const blogKeywords = ['дата проведения', 'разбираем новинки', 'на прошедшей трансляции',
        'следующие релизы', 'заказанный разбор', 'голосуйте в опросе'];
      if (blogKeywords.filter(kw => lower.includes(kw)).length >= 2) continue;
      if (lyrics.length < 40) continue;

      const header = `🎤 ${r.primary_artist?.name || artist} - ${r.title || title}\n\n`;
      return { type: 'plain', content: header + lyrics, source: 'Genius' };
    }
  } catch (e) { console.log('[BG] Genius:', e.message); }
  return null;
}

// ─── VK Plain Lyrics ──────────────────────────────────────────────────────────
async function fetchVkLyrics(audioId, accessToken) {
  if (!audioId || !accessToken) return null;
  try {
    const body = new URLSearchParams({ audio_id: audioId, access_token: accessToken });
    const res = await fetch('https://web.api.vk.ru/method/audio.getLyrics?v=5.285&client_id=6287487', {
      method: 'POST', credentials: 'include', body
    });
    if (!res.ok) return null;
    const data = await res.json();
    const lyrics = data?.response?.lyrics;
    if (!lyrics) return null;
    if (Array.isArray(lyrics.timestamps) && lyrics.timestamps.length) {
      const lrc = lyrics.timestamps
        .filter(t => t.line && !t.interlude)
        .map(t => {
          const ms = t.begin;
          const min = Math.floor(ms / 60000);
          const sec = ((ms % 60000) / 1000).toFixed(2).padStart(5, '0');
          return `[${String(min).padStart(2, '0')}:${sec}]${t.line}`;
        }).join('\n');
      if (lrc.length > 20) return { type: 'synced', content: lrc, source: 'VK' };
    }
    if (Array.isArray(lyrics.text) && lyrics.text.length) {
      const plain = lyrics.text.join('\n').trim();
      if (plain.length > 20) return { type: 'plain', content: plain, source: 'VK' };
    }
  } catch (e) { console.log('[BG] VK lyrics:', e.message); }
  return null;
}

// ─── Genius: загрузка страниц по готовым URL (вызывается из bridge) ───────────
async function fetchGeniusPages(hits, artist, title) {
  const items = (hits || [])
    .map(h => ({ hit: h, url: h?.result?.url }))
    .filter(it => it.url);
  const urls = items.map(it => it.url);
  const PAGE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html'
  };

  const raws = await Promise.all(urls.map(async url => {
    let html = '';
    // Сначала через CF-воркер (полный HTML), при сбое — напрямую
    try {
      const res = await fetch(`${GENIUS_PROXY}/page?url=${encodeURIComponent(url)}`);
      if (res.ok) html = await res.text();
    } catch {}
    if (!html) {
      try {
        const res = await fetch(url, { headers: PAGE_HEADERS });
        if (res.ok) html = await res.text();
      } catch {}
    }
    console.log('[BG] page', url.slice(-45), 'len=', html?.length, 'marker=', html?.includes('data-lyrics-container="true"'));
    return html ? extractGeniusLyrics(html) : '';
  }));

  // Пороги совпадения — те же, что в fetchGenius
  const qTitleW  = gWords(cleanQuery(title));
  const qArtistW = gWords(cleanQuery(artist));
  const latinAlias = extractLatinAlias(title);
  const qAliasW  = latinAlias ? gWords(latinAlias) : [];
  let fallback = null; // текст первой непустой страницы — вернём, если ничего не совпало

  for (let i = 0; i < urls.length; i++) {
    const raw = raws[i];
    if (!raw || raw.length < 40) continue;

    const cleanLines = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (/^\d+\s+(Contributors|Участников)/i.test(trimmed)) continue;
      if (/^\[Текст песни/i.test(trimmed)) continue;
      cleanLines.push(line);
    }
    while (cleanLines.length && !cleanLines[0].trim()) cleanLines.shift();

    let lyrics = cleanLines.join('\n').trim()
      .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    const lower = lyrics.toLowerCase();
    const blogKeywords = ['дата проведения', 'разбираем новинки', 'на прошедшей трансляции'];
    if (blogKeywords.filter(kw => lower.includes(kw)).length >= 2) continue;
    if (lyrics.length < 40) continue;

    const r = items[i].hit?.result || {};
    const hitArtists = [r.primary_artist?.name, ...(r.featured_artists || []).map(f => f.name)].join(' ');
    const aliasOverlap  = gOverlap(qAliasW,  gWords(r.title));
    const titleOverlap  = gOverlap(qTitleW,  gWords(r.title));
    const artistOverlap = gOverlap(qArtistW, gWords(hitArtists));
    const ok = aliasOverlap >= 1 ||
               titleOverlap >= 2 ||
               (titleOverlap >= 1 && artistOverlap >= 1) ||
               artistOverlap >= 2;
    if (!ok) { if (!fallback) fallback = lyrics; continue; }

    return { type: 'plain', content: lyrics, source: 'Genius' };
  }
  if (fallback) return { type: 'plain', content: fallback, source: 'Genius' };
  return null;
}


// ─── Роутер ───────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    MUSIXMATCH:        () => fetchMxm(msg.artist, msg.title, msg.duration),
    LRCLIB:            () => fetchLRCLIB(msg.artist, msg.title, msg.duration),
    GENIUS_SEARCH:     () => fetchGenius(msg.artist, msg.title, msg.token),
    GENIUS_FETCH_PAGES:() => fetchGeniusPages(msg.hits, msg.artist, msg.title),
    VK_LYRICS:         () => fetchVkLyrics(msg.audioId, msg.accessToken),
  };
  const h = handlers[msg.type];
  if (h) { h().then(sendResponse).catch(() => sendResponse(null)); return true; }
});
