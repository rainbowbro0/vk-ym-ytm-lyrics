'use strict';

// URL отдельной обложки для треков VK без собственной обложки.
// bridge.js работает в изолированном мире, поэтому передаём URL в MAIN world через data-атрибут.
try {
  document.documentElement.dataset.vklNoCoverUrl = chrome.runtime.getURL('no-cover.png');
} catch {}

chrome.storage.local.get(['vkl_enabled', 'vkl_source', 'vkl_genius_token'], s => {
  window.postMessage({
    _vkl: 'INIT',
    enabled: s.vkl_enabled !== false,
    source:  s.vkl_source  || 'auto',
    geniusToken: s.vkl_genius_token || ''
  }, '*');
});

window.addEventListener('message', e => {
  if (!e.data?._vkl) return;

  if (e.data._vkl === 'SET_SETTINGS') {
    chrome.storage.local.set({
      vkl_enabled:      e.data.enabled,
      vkl_source:       e.data.source,
      vkl_genius_token: e.data.geniusToken
    });
  }

  const bgTypes = {
    'MXM':          'MUSIXMATCH',
    'LRCLIB':       'LRCLIB',
    'GENIUS':       'GENIUS_SEARCH',
    'GENIUS_PAGES': 'GENIUS_FETCH_PAGES',
    'VK_LYRICS':    'VK_LYRICS',
  };

  const bgType = bgTypes[e.data._vkl];
  if (bgType) {
    const { id, ...payload } = e.data;
    chrome.runtime.sendMessage(
      { type: bgType, ...payload },
      result => window.postMessage({ _vkl: e.data._vkl + '_RESULT', id, data: result || null }, '*')
    );
  }
});
