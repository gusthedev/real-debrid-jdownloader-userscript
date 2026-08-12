// ==UserScript==
// @name         Real-Debrid OAuth + JDownloader (Shared Core)
// @namespace    shared.real-debrid.jdownloader
// @version      7.1.0
// @description  Adds Real-Debrid OAuth and JDownloader controls beside supported host links using loader-provided configuration.
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
// @connect      api.real-debrid.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';
  const RD_OAUTH_BASE = 'https://api.real-debrid.com/oauth/v2';
  const RD_PUBLIC_CLIENT_ID = 'X245A4XAIBGVM';
  const RD_DEVICE_GRANT = 'http://oauth.net/grant_type/device/1.0';
  const HOST_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const TOKEN_EXPIRY_MARGIN = 60 * 1000;
  const REQUEST_TIMEOUT = 20_000;

  function normalizeHostname(hostname) {
    return String(hostname || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  }

  function isDomainOrSubdomain(hostname, domain) {
    const normalizedDomain = normalizeHostname(domain);
    return Boolean(normalizedDomain) && (hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`));
  }

  function normalizeJDownloaderEndpoint(value) {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('JDownloader endpoint must use HTTP or HTTPS.');
    }
    url.hash = '';
    return url.href;
  }

  const loaderConfig = typeof globalThis.RD_JD_CONFIG === 'object' && globalThis.RD_JD_CONFIG
    ? globalThis.RD_JD_CONFIG
    : null;
  let config;

  try {
    if (!loaderConfig) throw new Error('Install this script through its configured loader.');
    config = Object.freeze({
      jdownloaderEndpoint: normalizeJDownloaderEndpoint(loaderConfig.jdownloaderEndpoint),
      excludedDomains: Array.isArray(loaderConfig.excludedDomains)
        ? loaderConfig.excludedDomains.map(normalizeHostname).filter(Boolean)
        : []
    });
  } catch (error) {
    console.error('[RD + JD] Invalid loader configuration.', error);
    return;
  }

  const STORAGE = Object.freeze({
    hosts: 'rdHosts',
    hostsUpdated: 'rdHostsUpdated',
    oauthClientId: 'rdOauthClientId',
    oauthClientSecret: 'rdOauthClientSecret',
    accessToken: 'rdOauthAccessToken',
    refreshToken: 'rdOauthRefreshToken',
    accessTokenExpiresAt: 'rdOauthAccessTokenExpiresAt'
  });

  const OAUTH_STORAGE_KEYS = [
    STORAGE.oauthClientId,
    STORAGE.oauthClientSecret,
    STORAGE.accessToken,
    STORAGE.refreshToken,
    STORAGE.accessTokenExpiresAt
  ];

  const PUBLIC_BLACKLIST = [
    'mediafire.com',
    'google.com',
    'real-debrid.com',
    'icloud.com',
    'apple.com',
    'cnn.com',
    'facebook.com',
    'instagram.com',
    'x.com',
    'threads.net',
    'chatgpt.com',
    'youtube.com'
  ];

  const pageHostname = normalizeHostname(location.hostname);
  const excludedDomains = [...PUBLIC_BLACKLIST, ...config.excludedDomains];
  if (window.top !== window.self || excludedDomains.some(domain => isDomainOrSubdomain(pageHostname, domain))) {
    return;
  }

  let supportedDomains = new Set();
  let observer = null;
  let processTimer = null;
  let oauthConnectionPromise = null;
  let oauthRefreshPromise = null;
  const pendingRoots = new Set();
  const injectedControls = new WeakMap();

  class RequestError extends Error {
    constructor(message, status = 0, apiCode = null, details = null) {
      super(String(message || 'Unknown error'));
      this.name = 'RequestError';
      this.status = status;
      this.apiCode = apiCode;
      this.details = details;
    }
  }

  function delay(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
  }

  function requestJson(url, options = {}) {
    const { method = 'GET', headers = {}, data = null } = options;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: { Accept: 'application/json', ...headers },
        data,
        timeout: REQUEST_TIMEOUT,
        onload: response => {
          let body = null;
          if (response.responseText) {
            try {
              body = JSON.parse(response.responseText);
            } catch {
              reject(new RequestError(`Real-Debrid returned an invalid response (HTTP ${response.status}).`, response.status));
              return;
            }
          }
          if (response.status >= 200 && response.status < 300) {
            resolve(body);
            return;
          }
          const apiCode = body?.error_code ?? (typeof body?.error === 'number' ? body.error : null);
          const apiMessage = body?.error_description
            || (typeof body?.error === 'string' ? body.error : '')
            || response.statusText
            || `HTTP ${response.status}`;
          reject(new RequestError(apiMessage, response.status, apiCode, body));
        },
        onerror: () => reject(new RequestError('Network error while contacting Real-Debrid.')),
        ontimeout: () => reject(new RequestError('Real-Debrid did not respond in time.'))
      });
    });
  }

  function readOAuthSession() {
    return {
      clientId: String(GM_getValue(STORAGE.oauthClientId, '') || ''),
      clientSecret: String(GM_getValue(STORAGE.oauthClientSecret, '') || ''),
      accessToken: String(GM_getValue(STORAGE.accessToken, '') || ''),
      refreshToken: String(GM_getValue(STORAGE.refreshToken, '') || ''),
      expiresAt: Number(GM_getValue(STORAGE.accessTokenExpiresAt, 0)) || 0
    };
  }

  function clearOAuthSession() {
    OAUTH_STORAGE_KEYS.forEach(key => GM_deleteValue(key));
  }

  function saveOAuthSession(credentials, tokens) {
    const accessToken = String(tokens?.access_token || '');
    const refreshToken = String(tokens?.refresh_token || readOAuthSession().refreshToken || '');
    const expiresIn = Number(tokens?.expires_in) || 0;

    if (!credentials.clientId || !credentials.clientSecret || !accessToken || !refreshToken || expiresIn <= 0) {
      throw new RequestError('Real-Debrid returned incomplete OAuth credentials.');
    }

    GM_setValue(STORAGE.oauthClientId, credentials.clientId);
    GM_setValue(STORAGE.oauthClientSecret, credentials.clientSecret);
    GM_setValue(STORAGE.accessToken, accessToken);
    GM_setValue(STORAGE.refreshToken, refreshToken);
    GM_setValue(STORAGE.accessTokenExpiresAt, Date.now() + expiresIn * 1000);
    return accessToken;
  }

  function postOAuthToken(parameters) {
    return requestJson(`${RD_OAUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      data: new URLSearchParams(parameters).toString()
    });
  }

  function preparePopup(popup, message = 'Real-Debrid is preparing…') {
    try {
      popup.opener = null;
      popup.document.title = 'Real-Debrid';
      popup.document.body.textContent = message;
      popup.document.body.style.cssText = 'font:16px system-ui,sans-serif;padding:32px;color:#222;background:#fff';
    } catch {
      // Safari may restrict blank-tab access; later navigation can still work.
    }
  }

  function renderOAuthInstructions(popup, authorization) {
    const userCode = String(authorization.user_code || '');
    const verificationUrl = new URL(String(authorization.verification_url || ''));
    if (!userCode || verificationUrl.protocol !== 'https:' || !isDomainOrSubdomain(normalizeHostname(verificationUrl.hostname), 'real-debrid.com')) {
      throw new RequestError('Real-Debrid returned invalid device-authorization instructions.');
    }

    try {
      const doc = popup.document;
      doc.title = 'Connect Real-Debrid';
      doc.body.replaceChildren();
      doc.body.style.cssText = 'font:16px system-ui,sans-serif;max-width:620px;margin:0 auto;padding:48px 28px;color:#202124;background:#fff';

      const heading = doc.createElement('h1');
      heading.textContent = 'Connect Real-Debrid';
      heading.style.cssText = 'font-size:26px;margin:0 0 18px';
      const instructions = doc.createElement('p');
      instructions.textContent = 'Copy this code, then authorize the script on Real-Debrid:';
      const code = doc.createElement('div');
      code.textContent = userCode;
      code.style.cssText = 'font:700 27px ui-monospace,monospace;letter-spacing:2px;padding:18px;margin:20px 0;background:#f1f3f4;border-radius:8px;text-align:center;user-select:all;-webkit-user-select:all';
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = 'Copy code and open Real-Debrid';
      button.style.cssText = 'font:600 16px system-ui,sans-serif;padding:12px 18px;border:0;border-radius:7px;background:#1769e0;color:#fff;cursor:pointer';
      button.addEventListener('click', () => {
        try {
          const copyField = doc.createElement('textarea');
          copyField.value = userCode;
          copyField.style.cssText = 'position:fixed;left:-9999px';
          doc.body.appendChild(copyField);
          copyField.select();
          doc.execCommand('copy');
          copyField.remove();
        } catch {
          // The code remains selectable if clipboard access is unavailable.
        }
        const authorizationTab = popup.open(verificationUrl.href, '_blank');
        if (authorizationTab) {
          try { authorizationTab.opener = null; } catch { /* The tab is still safe to use. */ }
        } else {
          popup.location.href = verificationUrl.href;
        }
      });
      const waiting = doc.createElement('p');
      waiting.textContent = 'Keep this tab open. It will continue automatically after you approve access.';
      waiting.style.cssText = 'margin-top:18px;color:#5f6368';
      doc.body.append(heading, instructions, code, button, waiting);
      button.focus();
    } catch {
      window.prompt('Copy this Real-Debrid authorization code, then continue:', userCode);
      popup.location.href = verificationUrl.href;
    }
  }

  async function pollForOAuthCredentials(authorization) {
    const deviceCode = String(authorization.device_code || '');
    const expiresIn = Number(authorization.expires_in) || 0;
    let interval = Math.max(Number(authorization.interval) || 5, 2) * 1000;
    const deadline = Date.now() + expiresIn * 1000;
    let transientFailures = 0;

    if (!deviceCode || expiresIn <= 0) {
      throw new RequestError('Real-Debrid returned incomplete device-authorization data.');
    }

    while (Date.now() < deadline) {
      await delay(interval);
      try {
        const credentials = await requestJson(
          `${RD_OAUTH_BASE}/device/credentials?${new URLSearchParams({
            client_id: RD_PUBLIC_CLIENT_ID,
            code: deviceCode
          })}`
        );
        if (credentials?.client_id && credentials?.client_secret) {
          return { clientId: String(credentials.client_id), clientSecret: String(credentials.client_secret) };
        }
      } catch (error) {
        if (error.status === 429) {
          interval += 5000;
          continue;
        }
        if ([400, 401, 403, 404].includes(error.status)) continue;
        transientFailures += 1;
        if (transientFailures >= 3) throw error;
      }
    }
    throw new RequestError('Real-Debrid authorization expired before it was completed.');
  }

  async function runOAuthConnection(popup) {
    const authorization = await requestJson(
      `${RD_OAUTH_BASE}/device/code?${new URLSearchParams({
        client_id: RD_PUBLIC_CLIENT_ID,
        new_credentials: 'yes'
      })}`
    );
    renderOAuthInstructions(popup, authorization);
    const credentials = await pollForOAuthCredentials(authorization);
    const tokens = await postOAuthToken({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code: String(authorization.device_code),
      grant_type: RD_DEVICE_GRANT
    });
    return saveOAuthSession(credentials, tokens);
  }

  function connectOAuth(popup) {
    if (oauthConnectionPromise) return oauthConnectionPromise;
    oauthConnectionPromise = runOAuthConnection(popup).finally(() => { oauthConnectionPromise = null; });
    return oauthConnectionPromise;
  }

  function refreshOAuthAccessToken() {
    if (oauthRefreshPromise) return oauthRefreshPromise;
    const session = readOAuthSession();
    if (!session.clientId || !session.clientSecret || !session.refreshToken) {
      return Promise.reject(new RequestError('Real-Debrid is not connected.'));
    }
    oauthRefreshPromise = postOAuthToken({
      client_id: session.clientId,
      client_secret: session.clientSecret,
      code: session.refreshToken,
      grant_type: RD_DEVICE_GRANT
    })
      .then(tokens => saveOAuthSession(session, tokens))
      .catch(error => {
        clearOAuthSession();
        throw new RequestError(`The Real-Debrid OAuth session could not be refreshed: ${error.message}`, error.status, error.apiCode);
      })
      .finally(() => { oauthRefreshPromise = null; });
    return oauthRefreshPromise;
  }

  async function getValidAccessToken(authorizationPopup = null) {
    const session = readOAuthSession();
    if (session.accessToken && Date.now() < session.expiresAt - TOKEN_EXPIRY_MARGIN) return session.accessToken;
    if (session.clientId && session.clientSecret && session.refreshToken) {
      try {
        return await refreshOAuthAccessToken();
      } catch (error) {
        if (!authorizationPopup) throw error;
      }
    }
    if (authorizationPopup) return connectOAuth(authorizationPopup);
    throw new RequestError('Real-Debrid is not connected.');
  }

  async function requestRealDebrid(url, options = {}, authorizationPopup = null) {
    let accessToken = await getValidAccessToken(authorizationPopup);
    const send = token => requestJson(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` }
    });
    try {
      return await send(accessToken);
    } catch (error) {
      if (error.status !== 401 && error.apiCode !== 8) throw error;
      try {
        accessToken = await refreshOAuthAccessToken();
      } catch (refreshError) {
        if (!authorizationPopup) throw refreshError;
        accessToken = await connectOAuth(authorizationPopup);
      }
      return send(accessToken);
    }
  }

  async function disconnectOAuth() {
    const { accessToken } = readOAuthSession();
    try {
      if (accessToken) {
        await requestJson(`${RD_API_BASE}/disable_access_token`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
      }
    } catch (error) {
      console.warn('[RD + JD] Could not disable the current access token remotely.', error);
    } finally {
      clearOAuthSession();
    }
  }

  function normalizeHostList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(normalizeHostname).filter(Boolean))];
  }

  async function loadSupportedHosts(forceRefresh = false) {
    const cachedHosts = normalizeHostList(GM_getValue(STORAGE.hosts, []));
    const lastUpdated = Number(GM_getValue(STORAGE.hostsUpdated, 0)) || 0;
    const cacheIsFresh = Date.now() - lastUpdated < HOST_CACHE_MAX_AGE;
    if (cachedHosts.length) supportedDomains = new Set(cachedHosts);
    if (!forceRefresh && cacheIsFresh && cachedHosts.length) return;
    try {
      const response = await requestJson(`${RD_API_BASE}/hosts/domains`);
      const freshHosts = normalizeHostList(response);
      if (!freshHosts.length) throw new RequestError('Real-Debrid returned an empty supported-host list.');
      supportedDomains = new Set(freshHosts);
      GM_setValue(STORAGE.hosts, freshHosts);
      GM_setValue(STORAGE.hostsUpdated, Date.now());
    } catch (error) {
      if (!cachedHosts.length) throw error;
      console.warn('[RD + JD] Could not refresh supported hosts; using the cached list.', error);
    }
  }

  function isSupportedUrl(urlString) {
    try {
      const url = new URL(urlString, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      let hostname = normalizeHostname(url.hostname);
      while (hostname) {
        if (supportedDomains.has(hostname)) return true;
        const dot = hostname.indexOf('.');
        if (dot === -1) break;
        hostname = hostname.slice(dot + 1);
      }
    } catch {
      return false;
    }
    return false;
  }

  function setButtonState(button, text, disabled) {
    button.textContent = text;
    button.disabled = disabled;
    button.style.opacity = disabled ? '0.65' : '1';
  }

  function createButton(text, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.style.cssText = [
      'all:initial', 'box-sizing:border-box', 'display:inline-flex', 'align-items:center',
      'justify-content:center', 'width:25px', 'height:25px', 'padding:0',
      'border:1px solid rgba(127,127,127,.45)', 'border-radius:5px',
      'background:rgba(127,127,127,.12)', 'cursor:pointer',
      'font-family:system-ui,sans-serif', 'font-size:14px', 'line-height:1',
      'vertical-align:middle', 'user-select:none', '-webkit-user-select:none'
    ].join(';');
    return button;
  }

  function extractDownloadUrls(response) {
    const results = Array.isArray(response) ? response : [response];
    const urls = results
      .map(item => item?.download)
      .filter(value => typeof value === 'string')
      .filter(value => {
        try {
          const protocol = new URL(value).protocol;
          return protocol === 'http:' || protocol === 'https:';
        } catch {
          return false;
        }
      });
    return [...new Set(urls)];
  }

  function showMultipleDownloads(popup, urls) {
    try {
      const doc = popup.document;
      doc.title = 'Real-Debrid downloads';
      doc.body.replaceChildren();
      doc.body.style.cssText = 'font:16px system-ui,sans-serif;padding:32px;color:#222;background:#fff';
      const heading = doc.createElement('h1');
      heading.textContent = 'Real-Debrid returned multiple downloads';
      heading.style.fontSize = '20px';
      doc.body.appendChild(heading);
      const list = doc.createElement('ol');
      for (const [index, url] of urls.entries()) {
        const item = doc.createElement('li');
        item.style.margin = '12px 0';
        const link = doc.createElement('a');
        link.href = url;
        link.rel = 'noopener noreferrer';
        link.textContent = `Download ${index + 1}`;
        item.appendChild(link);
        list.appendChild(item);
      }
      doc.body.appendChild(list);
    } catch {
      popup.location.href = urls[0];
    }
  }

  async function unlockWithRealDebrid(originalUrl, button) {
    const popup = window.open('', '_blank');
    if (!popup) {
      window.alert('Your browser blocked the download tab. Allow popups for this site and try again.');
      return;
    }
    preparePopup(popup);
    setButtonState(button, '⏳', true);
    try {
      const response = await requestRealDebrid(`${RD_API_BASE}/unrestrict/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        data: new URLSearchParams({ link: originalUrl }).toString()
      }, popup);
      const downloadUrls = extractDownloadUrls(response);
      if (!downloadUrls.length) throw new RequestError('No downloadable link was returned.');
      if (downloadUrls.length === 1) popup.location.href = downloadUrls[0];
      else showMultipleDownloads(popup, downloadUrls);
    } catch (error) {
      try { popup.close(); } catch { /* Nothing to close. */ }
      window.alert(`Real-Debrid could not unlock this link.\n\n${error.message}`);
    } finally {
      setButtonState(button, '🔗', false);
    }
  }

  function sendToJDownloader(url, button) {
    setButtonState(button, '⏳', true);
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = config.jdownloaderEndpoint;
    form.target = '_blank';
    form.rel = 'noopener noreferrer';
    form.style.display = 'none';
    for (const [name, value] of Object.entries({ source: 'Tampermonkey', urls: url })) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    window.setTimeout(() => form.remove(), 1000);
    setButtonState(button, '✅', true);
    window.setTimeout(() => setButtonState(button, '📥', false), 1800);
  }

  function removeExistingControls(link) {
    const existing = injectedControls.get(link);
    if (!existing) return;
    existing.container.remove();
    injectedControls.delete(link);
  }

  function processLink(link) {
    if (!(link instanceof HTMLAnchorElement) || !link.hasAttribute('href')) return;
    const currentUrl = link.href;
    const existing = injectedControls.get(link);
    const supported = isSupportedUrl(currentUrl);
    if (existing?.url === currentUrl && link.nextSibling === existing.container && supported) return;
    if (existing) removeExistingControls(link);
    if (!supported) return;
    const container = document.createElement('span');
    container.dataset.rdJdControls = 'true';
    container.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-left:6px;vertical-align:middle';
    const rdButton = createButton('🔗', 'Unlock with Real-Debrid');
    const jdButton = createButton('📥', 'Send to JDownloader');
    rdButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void unlockWithRealDebrid(link.href, rdButton);
    });
    jdButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      sendToJDownloader(link.href, jdButton);
    });
    container.append(rdButton, jdButton);
    link.after(container);
    injectedControls.set(link, { url: currentUrl, container });
  }

  function processRoot(root) {
    if (!(root instanceof Element)) return;
    if (root.matches('[data-rd-jd-controls]')) return;
    if (root.matches('a[href]')) processLink(root);
    root.querySelectorAll('a[href]').forEach(processLink);
  }

  function flushPendingRoots() {
    processTimer = null;
    const roots = [...pendingRoots];
    pendingRoots.clear();
    roots.forEach(processRoot);
  }

  function scheduleRoot(root) {
    if (!(root instanceof Element)) return;
    pendingRoots.add(root);
    window.clearTimeout(processTimer);
    processTimer = window.setTimeout(flushPendingRoots, 150);
  }

  function startObserver() {
    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          processLink(mutation.target);
          continue;
        }
        mutation.addedNodes.forEach(scheduleRoot);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href']
    });
  }

  function rescanAllLinks() {
    document.querySelectorAll('a[href]').forEach(processLink);
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('Connect or reconnect Real-Debrid (OAuth)', async () => {
      const popup = window.open('', '_blank');
      if (!popup) {
        window.alert('Your browser blocked the authorization tab. Allow popups and try again.');
        return;
      }
      preparePopup(popup, 'Preparing Real-Debrid authorization…');
      try {
        await connectOAuth(popup);
        try { popup.close(); } catch { /* Nothing to close. */ }
        window.alert('Real-Debrid OAuth was connected successfully.');
      } catch (error) {
        try { popup.close(); } catch { /* Nothing to close. */ }
        window.alert(`Real-Debrid could not be connected.\n\n${error.message}`);
      }
    });
    GM_registerMenuCommand('Disconnect Real-Debrid on this browser', async () => {
      if (!window.confirm('Disconnect Real-Debrid and clear this browser’s saved OAuth session?')) return;
      await disconnectOAuth();
      window.alert('Real-Debrid was disconnected on this browser.');
    });
    GM_registerMenuCommand('Refresh Real-Debrid supported hosts', async () => {
      try {
        await loadSupportedHosts(true);
        rescanAllLinks();
        window.alert('The supported-host list was refreshed.');
      } catch (error) {
        window.alert(`The supported-host list could not be refreshed.\n\n${error.message}`);
      }
    });
  }

  async function initialize() {
    registerMenuCommands();
    if (!document.body) return;
    try {
      await loadSupportedHosts();
      rescanAllLinks();
      startObserver();
    } catch (error) {
      console.error('[RD + JD] Initialization failed.', error);
    }
  }

  void initialize();
})();
