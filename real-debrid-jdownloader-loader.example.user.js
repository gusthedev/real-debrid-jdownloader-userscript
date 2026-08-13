// ==UserScript==
// @name         Real-Debrid OAuth + JDownloader Loader
// @namespace    local.real-debrid.jdownloader.loader
// @version      1.1.0
// @description  Loads the shared Real-Debrid/JDownloader script with private local configuration.
// @match        *://*/*
// @exclude      *://mdblist.com/*
// @exclude      *://*.mdblist.com/*
// @exclude      *://imdb.com/*
// @exclude      *://*.imdb.com/*
// @exclude      *://soundcloud.com/*
// @exclude      *://*.soundcloud.com/*
// @exclude      *://mediafire.com/*
// @exclude      *://*.mediafire.com/*
// @exclude      *://google.com/*
// @exclude      *://*.google.com/*
// @exclude      *://real-debrid.com/*
// @exclude      *://*.real-debrid.com/*
// @exclude      *://icloud.com/*
// @exclude      *://*.icloud.com/*
// @exclude      *://apple.com/*
// @exclude      *://*.apple.com/*
// @exclude      *://cnn.com/*
// @exclude      *://*.cnn.com/*
// @exclude      *://facebook.com/*
// @exclude      *://*.facebook.com/*
// @exclude      *://instagram.com/*
// @exclude      *://*.instagram.com/*
// @exclude      *://x.com/*
// @exclude      *://*.x.com/*
// @exclude      *://threads.net/*
// @exclude      *://*.threads.net/*
// @exclude      *://chatgpt.com/*
// @exclude      *://*.chatgpt.com/*
// @exclude      *://youtube.com/*
// @exclude      *://*.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      raw.githubusercontent.com
// @connect      api.real-debrid.com
// @connect      jdownloader.example.com
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

  const SHARED_SCRIPT_URL = 'https://raw.githubusercontent.com/gusthedev/real-debrid-jdownloader-userscript/main/real-debrid-jdownloader.user.js';
  const UPDATE_INTERVAL = 60 * 60 * 1000;
  const EMPTY_CACHE_RETRY_INTERVAL = 5 * 60 * 1000;
  const REQUEST_TIMEOUT = 15_000;
  const STORAGE = Object.freeze({
    source: 'rdJdLoader.sharedCore.source.v1',
    etag: 'rdJdLoader.sharedCore.etag.v1',
    lastAttempt: 'rdJdLoader.sharedCore.lastAttempt.v1'
  });

  let executionAttempted = false;
  let updateInFlight = false;

  function sharedCoreVersion(source) {
    return String(source || '').match(/^\/\/\s*@version\s+([^\s]+)\s*$/m)?.[1] || 'unknown version';
  }

  function isValidSharedCore(source) {
    if (typeof source !== 'string' || source.length < 1_000 || source.length > 500_000) return false;
    if (!source.includes('// @name         Real-Debrid OAuth + JDownloader (Shared Core)')) return false;
    if (!source.includes('// @namespace    shared.real-debrid.jdownloader')) return false;
    if (!source.includes('globalThis.RD_JD_CONFIG')) return false;

    try {
      new Function(source);
      return true;
    } catch {
      return false;
    }
  }

  function readCachedSource() {
    const source = GM_getValue(STORAGE.source, '');
    if (isValidSharedCore(source)) return source;
    if (source) {
      GM_deleteValue(STORAGE.source);
      GM_deleteValue(STORAGE.etag);
      console.warn('[RD + JD loader] Discarded an invalid cached shared core.');
    }
    return '';
  }

  function executeSharedCore(source) {
    if (executionAttempted || !isValidSharedCore(source)) return false;
    executionAttempted = true;
    try {
      eval(`${source}\n//# sourceURL=real-debrid-jdownloader.user.js`);
      return true;
    } catch (error) {
      console.error('[RD + JD loader] Could not start the shared script.', error);
      return false;
    }
  }

  function responseHeader(response, headerName) {
    const target = headerName.toLowerCase();
    for (const line of String(response.responseHeaders || '').split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator < 0 || line.slice(0, separator).trim().toLowerCase() !== target) continue;
      return line.slice(separator + 1).trim();
    }
    return '';
  }

  function notifyManual(message) {
    window.alert(`[RD + JD loader] ${message}`);
  }

  function checkForSharedCoreUpdate({ manual = false, executeIfEmpty = false } = {}) {
    if (updateInFlight) {
      if (manual) notifyManual('An update check is already running.');
      return;
    }

    updateInFlight = true;
    GM_setValue(STORAGE.lastAttempt, Date.now());

    const previousSource = readCachedSource();
    const etag = previousSource ? GM_getValue(STORAGE.etag, '') : '';
    const headers = etag ? { 'If-None-Match': etag } : {};

    function fail(message, error) {
      updateInFlight = false;
      const suffix = previousSource ? ' The cached core remains active.' : '';
      console.warn(`[RD + JD loader] ${message}${suffix}`, error || '');
      if (manual) notifyManual(`${message}${suffix}`);
    }

    GM_xmlhttpRequest({
      method: 'GET',
      url: SHARED_SCRIPT_URL,
      headers,
      timeout: REQUEST_TIMEOUT,
      onload(response) {
        updateInFlight = false;

        if (response.status === 304 && previousSource) {
          if (manual) notifyManual(`The shared core is current (${sharedCoreVersion(previousSource)}).`);
          return;
        }
        if (response.status !== 200) {
          fail(`GitHub returned HTTP ${response.status}.`);
          return;
        }

        const nextSource = response.responseText;
        if (!isValidSharedCore(nextSource)) {
          fail('GitHub returned an invalid shared core; it was not saved.');
          return;
        }

        const changed = nextSource !== previousSource;
        GM_setValue(STORAGE.source, nextSource);
        const nextEtag = responseHeader(response, 'etag');
        if (nextEtag) GM_setValue(STORAGE.etag, nextEtag);
        else GM_deleteValue(STORAGE.etag);

        if (executeIfEmpty && !previousSource) executeSharedCore(nextSource);

        const version = sharedCoreVersion(nextSource);
        if (manual) {
          notifyManual(changed
            ? `Shared core ${version} was saved. Reload the page to use it.`
            : `The shared core is current (${version}).`);
        } else if (changed && previousSource) {
          console.info(`[RD + JD loader] Shared core ${version} cached for the next page load.`);
        }
      },
      onerror(error) {
        fail('The shared core update check failed.', error);
      },
      ontimeout() {
        fail('The shared core update check timed out.');
      }
    });
  }

  GM_registerMenuCommand('Check for shared-core updates now', () => {
    checkForSharedCoreUpdate({ manual: true });
  });

  const cachedSource = readCachedSource();
  if (cachedSource) executeSharedCore(cachedSource);

  const lastAttempt = Number(GM_getValue(STORAGE.lastAttempt, 0)) || 0;
  const retryInterval = cachedSource ? UPDATE_INTERVAL : EMPTY_CACHE_RETRY_INTERVAL;
  if (Date.now() - lastAttempt >= retryInterval) {
    checkForSharedCoreUpdate({ executeIfEmpty: !cachedSource });
  }
})();
