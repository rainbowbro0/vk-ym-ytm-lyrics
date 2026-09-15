'use strict';
try { document.documentElement.dataset.ymlNoCoverUrl = chrome.runtime.getURL('no-cover.png'); } catch {}

chrome.storage.local.get(['yml_enabled','yml_source','yml_genius_token'], s => {
  window.postMessage({
    _yml: 'INIT',
    enabled: s.yml_enabled !== false,
    source: s.yml_source || 'auto',
    geniusToken: s.yml_genius_token || ''
  }, '*');
});

window.addEventListener('message', e => {
  if (!e.data?._yml) return;
  if (e.data._yml === 'SET_SETTINGS') {
    chrome.storage.local.set({
      yml_enabled: e.data.enabled,
      yml_source: e.data.source,
      yml_genius_token: e.data.geniusToken
    });
  }
  const map = {
    MXM:          'MUSIXMATCH',
    LRCLIB:       'LRCLIB',
    GENIUS:       'GENIUS_SEARCH',
    GENIUS_PAGES: 'GENIUS_FETCH_PAGES',
  };
  const type = map[e.data._yml];
  if (!type) return;
  const {id, ...payload} = e.data;
  chrome.runtime.sendMessage({type, ...payload}, result => {
    window.postMessage({_yml: e.data._yml + '_RESULT', id, data: result || null}, '*');
  });
});
