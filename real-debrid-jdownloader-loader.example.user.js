// ==UserScript==
// @name         Real-Debrid OAuth + JDownloader Loader
// @namespace    local.real-debrid.jdownloader.loader
// @version      1.0.0
// @description  Loads the shared Real-Debrid/JDownloader script with private local configuration.
// @match        *://*/*
// @exclude      *://mdblist.com/*
// @exclude      *://*.mdblist.com/*
// @exclude      *://imdb.com/*
// @exclude      *://*.imdb.com/*
// @exclude      *://soundcloud.com/*
// @exclude      *://*.soundcloud.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      raw.githubusercontent.com
// @connect      api.real-debrid.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // Keep your real endpoint and private domains in your locally installed copy.
  globalThis.RD_JD_CONFIG = Object.freeze({
    jdownloaderEndpoint: 'https://jdownloader.example.com/flash/add',
    excludedDomains: ['example.com']
  });

  const sharedScriptUrl = `https://raw.githubusercontent.com/gusthedev/real-debrid-jdownloader-userscript/main/real-debrid-jdownloader.user.js?t=${Date.now()}`;

  GM_xmlhttpRequest({
    method: 'GET',
    url: sharedScriptUrl,
    headers: { 'Cache-Control': 'no-cache' },
    onload(response) {
      if (response.status !== 200) {
        console.error(`[RD + JD loader] GitHub returned HTTP ${response.status}.`);
        return;
      }
      try {
        eval(`${response.responseText}\n//# sourceURL=real-debrid-jdownloader.user.js`);
      } catch (error) {
        console.error('[RD + JD loader] Could not start the shared script.', error);
      }
    },
    onerror(error) {
      console.error('[RD + JD loader] The shared script is unavailable.', error);
    }
  });
})();
