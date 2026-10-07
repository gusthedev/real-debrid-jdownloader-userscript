'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const corePath = path.join(projectRoot, 'real-debrid-jdownloader.user.js');
const coreSource = fs.readFileSync(corePath, 'utf8');

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function settle() {
  await tick();
  await tick();
}

// Plain wrappers deliberately have no relationship to the constructors in the VM.
function createElementWrapper(tagName = 'div') {
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    children: [],
    isConnected: true,
    scanCount: 0,
    attributes: new Map(),
    dataset: {},
    style: {},
    listeners: new Map(),
    nextSibling: null,
    contains(candidate) {
      return candidate === this || this.children.some(child => child.contains(candidate));
    },
    hasAttribute(name) {
      return this.attributes.has(name);
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'href') this.href = String(value);
    },
    matches(selector) {
      if (selector === 'a[href]') return this.tagName === 'A' && this.hasAttribute('href');
      if (selector === '[data-rd-jd-controls]') return this.dataset.rdJdControls !== undefined;
      return false;
    },
    querySelectorAll(selector) {
      this.scanCount += 1;
      const collect = element => element.children.flatMap(child => [
        ...(child.matches(selector) ? [child] : []),
        ...collect(child)
      ]);
      return collect(this);
    },
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    focus() {},
    after(node) {
      this.nextSibling = node;
      node.previousSibling = this;
    },
    remove() {
      this.removed = true;
      if (this.previousSibling) this.previousSibling.nextSibling = null;
    }
  };
}

function createAnchorWrapper(href) {
  const anchor = createElementWrapper('a');
  anchor.href = '';
  if (href !== undefined) anchor.setAttribute('href', href);
  return anchor;
}

function assertControls(link) {
  const container = link.nextSibling;
  assert.ok(container, 'supported anchor should have controls');
  assert.equal(container.tagName, 'SPAN');
  assert.equal(container.dataset.rdJdControls, 'true');
  assert.deepEqual(container.children.map(button => button.textContent), ['🔗', '📥']);
  for (const button of container.children) {
    assert.equal(button.type, 'button');
    assert.equal(typeof button.listeners.get('click'), 'function');
  }
  return container;
}

function createHarness(options = {}) {
  const now = Date.now();
  const storage = new Map(Object.entries({
    rdHosts: ['files.example'],
    rdHostsUpdated: now,
    ...options.storage
  }));
  const menuCommands = new Map();
  const alerts = [];
  const confirmations = [];
  const requests = [];
  const popups = [];
  const observations = [];
  let mutationCallback = null;

  class FakeElement {
    constructor(tagName) {
      Object.assign(this, createElementWrapper(tagName));
    }
  }

  class FakeAnchor extends FakeElement {
    constructor() {
      super('a');
      this.href = '';
    }
  }

  const document = {
    body: new FakeElement(),
    links: options.links || [],
    createElement(tagName) {
      return tagName === 'a' ? new FakeAnchor() : new FakeElement(tagName);
    },
    querySelectorAll() {
      return this.links;
    }
  };
  const pageUrl = new URL('https://page.example/downloads');
  const window = {
    open() {
      const popup = {
        document: { ...document, body: new FakeElement() },
        location: { href: '' },
        close() { this.closed = true; }
      };
      popups.push(popup);
      return popup;
    },
    alert: message => alerts.push(String(message)),
    confirm: message => {
      confirmations.push(String(message));
      return options.confirmResult !== false;
    },
    clearTimeout,
    setTimeout: options.immediateTimers ? callback => setImmediate(callback) : setTimeout
  };
  window.self = window;
  window.top = window;

  const requestHandler = options.requestHandler || ((request) => {
    const body = new URLSearchParams(request.data || '');
    request.onload({
      status: 200,
      statusText: 'OK',
      responseText: body.get('urls') ? 'success' : 'failed',
      finalUrl: request.url
    });
  });

  const context = {
    URL,
    URLSearchParams,
    window,
    document,
    location: { href: pageUrl.href, hostname: pageUrl.hostname },
    Element: FakeElement,
    HTMLAnchorElement: FakeAnchor,
    MutationObserver: class {
      constructor(callback) {
        mutationCallback = callback;
      }

      observe(target, options) {
        observations.push({ target, options });
      }
    },
    console: { error() {}, info() {}, warn() {} },
    RD_JD_CONFIG: {
      jdownloaderEndpoint: 'https://jdownloader.example.com/flash/add',
      excludedDomains: []
    },
    GM_getValue(key, defaultValue) {
      return storage.has(key) ? storage.get(key) : defaultValue;
    },
    GM_setValue(key, value) {
      storage.set(key, value);
    },
    GM_deleteValue(key) {
      storage.delete(key);
    },
    GM_registerMenuCommand(label, callback) {
      menuCommands.set(label, callback);
    },
    GM_xmlhttpRequest(request) {
      requests.push(request);
      requestHandler(request);
    }
  };

  vm.runInNewContext(coreSource, context, { filename: corePath });
  return {
    FakeElement,
    FakeAnchor,
    alerts,
    confirmations,
    document,
    menuCommands,
    observations,
    popups,
    requests,
    storage,
    getMutationCallback: () => mutationCallback
  };
}

function oauthSession(accessTokenIsCurrent = false) {
  return {
    rdOauthClientId: 'saved-client-id',
    rdOauthClientSecret: 'saved-client-secret',
    rdOauthAccessToken: 'saved-access-token',
    rdOauthRefreshToken: 'saved-refresh-token',
    rdOauthAccessTokenExpiresAt: Date.now() + (accessTokenIsCurrent ? 3_600_000 : -1000)
  };
}

function respondJson(request, status, body) {
  request.onload({ status, responseText: JSON.stringify(body) });
}

test('manual supported-host refresh reports failures while retaining cached hosts, then succeeds on retry', async t => {
  const failures = [
    ['network error', request => request.onerror(), /Network error/],
    ['timeout', request => request.ontimeout(), /did not respond in time/],
    ['HTTP 503', request => respondJson(request, 503, { error: 'Service unavailable' }), /Service unavailable/],
    ['invalid JSON', request => request.onload({ status: 200, responseText: '{' }), /invalid response/],
    ['empty host list', request => respondJson(request, 200, []), /empty supported-host list/]
  ];

  for (const [name, fail, message] of failures) {
    await t.test(name, async () => {
      const savedSession = oauthSession(true);
      const cachedHosts = ['files.example'];
      const cachedAt = Date.now() - 1000;
      const existing = createAnchorWrapper('https://files.example/existing');
      const newlySupported = createAnchorWrapper('https://new.example/existing');
      const harness = createHarness({
        storage: { ...savedSession, rdHosts: cachedHosts, rdHostsUpdated: cachedAt },
        links: [existing, newlySupported], immediateTimers: true,
        requestHandler(request) {
          assert.equal(request.url, 'https://api.real-debrid.com/rest/1.0/hosts/domains');
          if (harness.requests.length === 1) fail(request);
          else respondJson(request, 200, ['files.example', 'new.example']);
        }
      });
      await settle();
      const originalControls = assertControls(existing);
      assert.equal(harness.requests.length, 0, 'fresh cache should avoid an automatic request');
      const refresh = harness.menuCommands.get('Refresh Real-Debrid supported hosts');

      await refresh();
      assert.equal(harness.requests.length, 1, 'manual refresh must bypass even a fresh cache');
      assert.match(harness.alerts.at(-1), /could not be refreshed/);
      assert.match(harness.alerts.at(-1), message);
      assert.match(harness.alerts.at(-1), /cached list/i);
      assert.doesNotMatch(harness.alerts.at(-1), /was refreshed/);
      assert.equal(harness.storage.get('rdHosts'), cachedHosts);
      assert.equal(harness.storage.get('rdHostsUpdated'), cachedAt);
      assert.equal(existing.nextSibling, originalControls);
      assert.equal(newlySupported.nextSibling, null);

      const dynamic = createAnchorWrapper('https://files.example/dynamic');
      harness.getMutationCallback()([{ type: 'childList', addedNodes: [dynamic] }]);
      await settle();
      assertControls(dynamic);

      await refresh();
      assert.equal(harness.requests.length, 2);
      assert.equal(harness.alerts.at(-1), 'The supported-host list was refreshed.');
      assert.deepEqual(Array.from(harness.storage.get('rdHosts')), ['files.example', 'new.example']);
      assert.ok(harness.storage.get('rdHostsUpdated') > cachedAt);
      assertControls(newlySupported);
      assert.equal(existing.nextSibling, originalControls, 'rescan must not duplicate controls');
      assert.equal(harness.observations.length, 1, 'refresh must not add another observer');
      for (const [key, value] of Object.entries(savedSession)) assert.equal(harness.storage.get(key), value, key);
    });
  }
});

test('automatic supported-host discovery falls back to a stale cache during an outage', async () => {
  const cachedHosts = ['files.example'];
  const cachedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const existing = createAnchorWrapper('https://files.example/existing');
  const harness = createHarness({
    storage: { rdHosts: cachedHosts, rdHostsUpdated: cachedAt },
    links: [existing], immediateTimers: true,
    requestHandler(request) { request.onerror(); }
  });
  await settle();

  assert.equal(harness.requests.length, 1);
  assertControls(existing);
  assert.equal(harness.storage.get('rdHosts'), cachedHosts);
  assert.equal(harness.storage.get('rdHostsUpdated'), cachedAt);
  assert.deepEqual(harness.alerts, []);
  const dynamic = createAnchorWrapper('https://files.example/dynamic');
  harness.getMutationCallback()([{ type: 'childList', addedNodes: [dynamic] }]);
  await settle();
  assertControls(dynamic);
  assert.equal(harness.observations.length, 1);
});

test('manual supported-host refresh recovers existing and dynamic links after initial discovery fails without a cache', async () => {
  const savedSession = oauthSession(true);
  const existing = createAnchorWrapper('https://files.example/existing');
  let attempts = 0;
  const harness = createHarness({
    storage: { ...savedSession, rdHosts: [], rdHostsUpdated: 0 },
    links: [existing], immediateTimers: true,
    requestHandler(request) {
      assert.equal(request.url, 'https://api.real-debrid.com/rest/1.0/hosts/domains');
      if (++attempts <= 2) request.onerror();
      else respondJson(request, 200, ['files.example']);
    }
  });
  await settle();
  assert.equal(attempts, 1);
  assert.equal(existing.nextSibling, null);
  const refresh = harness.menuCommands.get('Refresh Real-Debrid supported hosts');
  await refresh();
  assert.match(harness.alerts.at(-1), /could not be refreshed/);
  assert.doesNotMatch(harness.alerts.at(-1), /cached list|was refreshed/i);
  assert.equal(harness.storage.get('rdHostsUpdated'), 0);

  const addedDuringOutage = createAnchorWrapper('https://files.example/during-outage');
  harness.document.links.push(addedDuringOutage);
  await refresh();
  assert.equal(harness.alerts.at(-1), 'The supported-host list was refreshed.');
  assertControls(existing);
  assertControls(addedDuringOutage);
  assert.deepEqual(Array.from(harness.storage.get('rdHosts')), ['files.example']);
  assert.ok(harness.storage.get('rdHostsUpdated') > 0);
  assert.equal(harness.observations.length, 1, 'recovery must leave one active observer');
  assert.equal(harness.observations[0].target, harness.document.body);

  const dynamic = createAnchorWrapper('https://files.example/dynamic');
  const changed = createAnchorWrapper('https://unsupported.example/link');
  harness.getMutationCallback()([{ type: 'childList', addedNodes: [dynamic, changed] }]);
  await settle();
  assertControls(dynamic);
  assert.equal(changed.nextSibling, null);
  changed.setAttribute('href', 'https://files.example/changed');
  harness.getMutationCallback()([{ type: 'attributes', attributeName: 'href', target: changed }]);
  assertControls(changed);

  const observerCallback = harness.getMutationCallback();
  const originalControls = assertControls(existing);
  await refresh();
  assert.equal(attempts, 4);
  assert.equal(harness.observations.length, 1);
  assert.equal(harness.getMutationCallback(), observerCallback);
  assert.equal(existing.nextSibling, originalControls);
  for (const [key, value] of Object.entries(savedSession)) assert.equal(harness.storage.get(key), value, key);
});

async function clickRealDebrid(link) {
  const button = assertControls(link).children[0];
  button.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
  await settle();
}

function respondToDeviceAuthorization(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/device/code')) {
    respondJson(request, 200, {
      device_code: 'new-device-code', user_code: 'USERCODE',
      verification_url: 'https://real-debrid.com/device', expires_in: 600, interval: 2
    });
  } else if (url.pathname.endsWith('/device/credentials')) {
    respondJson(request, 200, { client_id: 'new-client-id', client_secret: 'new-client-secret' });
  } else if (url.pathname.endsWith('/token')) {
    assert.equal(new URLSearchParams(request.data).get('code'), 'new-device-code');
    respondJson(request, 200, { access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600 });
  } else {
    assert.equal(url.pathname, '/rest/1.0/unrestrict/link');
    assert.equal(request.headers.Authorization, 'Bearer new-access-token');
    respondJson(request, 200, { download: 'https://files.example/download' });
  }
}

test('refresh failures retain the entire session and allow a later retry without device authorization', async t => {
  const failures = [
    ['network error', request => request.onerror()],
    ['timeout', request => request.ontimeout()],
    ...[408, 429, 500, 502, 503, 504].map(status => [
      `HTTP ${status}`, request => respondJson(request, status, { error: 'Temporary failure', error_code: status === 429 ? 34 : 25 })
    ]),
    ...[408, 429, 503].map(status => [
      `HTTP ${status} with misleading bad-token code`, request => respondJson(request, status, { error_code: 8 })
    ]),
    ...[400, 401, 403].map(status => [
      `ambiguous HTTP ${status}`, request => respondJson(request, status, { error: 'Bad token' })
    ]),
    ['permission denied', request => respondJson(request, 403, { error: 'Permission denied', error_code: 9 })],
    ['account locked', request => respondJson(request, 403, { error: 'Account locked', error_code: 14 })],
    ['slow down', request => respondJson(request, 400, { error: 'Slow down', error_code: 5 })],
    ['non-JSON response', request => request.onload({ status: 502, responseText: '<html>Bad Gateway</html>' })],
    ['malformed success', request => request.onload({ status: 200, responseText: '{' })],
    ['incomplete success', request => respondJson(request, 200, { access_token: 'incomplete-token' })]
  ];

  for (const accessTokenIsCurrent of [false, true]) {
    for (const [name, fail] of failures) {
      await t.test(`${accessTokenIsCurrent ? 'after API 401' : 'expired access token'}: ${name}`, async () => {
        const saved = oauthSession(accessTokenIsCurrent);
        const link = createAnchorWrapper('https://files.example/a');
        let refreshAttempts = 0;
        const harness = createHarness({
          storage: saved, links: [link],
          requestHandler(request) {
            if (request.url.endsWith('/unrestrict/link')) {
              if (request.headers.Authorization === 'Bearer saved-access-token') {
                respondJson(request, 401, { error: 'Bad token', error_code: 8 });
              } else {
                assert.equal(request.headers.Authorization, 'Bearer refreshed-access-token');
                respondJson(request, 200, { download: 'https://files.example/download' });
              }
              return;
            }
            assert.equal(request.url, 'https://api.real-debrid.com/oauth/v2/token');
            const parameters = new URLSearchParams(request.data);
            assert.equal(parameters.get('client_id'), saved.rdOauthClientId);
            assert.equal(parameters.get('client_secret'), saved.rdOauthClientSecret);
            assert.equal(parameters.get('code'), saved.rdOauthRefreshToken);
            assert.equal(parameters.get('grant_type'), 'http://oauth.net/grant_type/device/1.0');
            if (++refreshAttempts === 1) fail(request);
            else respondJson(request, 200, { access_token: 'refreshed-access-token', expires_in: 3600 });
          }
        });
        await settle();

        await clickRealDebrid(link);
        for (const [key, value] of Object.entries(saved)) assert.equal(harness.storage.get(key), value, key);
        assert.equal(refreshAttempts, 1, 'failure must not immediately retry');
        assert.equal(harness.popups[0].closed, true);
        assert.match(harness.alerts.at(-1), /OAuth session could not be refreshed/);
        assert.equal(harness.requests.some(request => request.url.includes('/device/')), false);

        await clickRealDebrid(link);
        assert.equal(refreshAttempts, 2, 'a rejected refresh promise must not block later attempts');
        assert.equal(harness.storage.get('rdOauthClientId'), saved.rdOauthClientId);
        assert.equal(harness.storage.get('rdOauthClientSecret'), saved.rdOauthClientSecret);
        assert.equal(harness.storage.get('rdOauthRefreshToken'), saved.rdOauthRefreshToken);
        assert.equal(harness.storage.get('rdOauthAccessToken'), 'refreshed-access-token');
        assert.ok(harness.storage.get('rdOauthAccessTokenExpiresAt') > Date.now());
        assert.equal(harness.popups[1].location.href, 'https://files.example/download');
        assert.equal(harness.alerts.length, 1);
      });
    }
  }
});

test('a definitive bad refresh token clears all OAuth values and permits device authorization', async t => {
  for (const accessTokenIsCurrent of [false, true]) {
    for (const status of [400, 401, 403]) {
      for (const errorBody of [{ error: 'Bad token', error_code: 8 }, { error: 8, error_description: 'Bad token' }]) {
        await t.test(`${accessTokenIsCurrent ? 'after API 401' : 'expired token'}: HTTP ${status}, ${JSON.stringify(errorBody)}`, async () => {
          const saved = oauthSession(accessTokenIsCurrent);
          const link = createAnchorWrapper('https://files.example/a');
          let deviceRequests = 0;
          const harness = createHarness({
            storage: saved, links: [link], immediateTimers: true,
            requestHandler(request) {
              if (request.headers.Authorization === 'Bearer saved-access-token') {
                respondJson(request, 401, { error_code: 8 });
              } else if (new URLSearchParams(request.data).get('code') === saved.rdOauthRefreshToken) {
                respondJson(request, status, errorBody);
              } else {
                if (request.url.includes('/device/code')) {
                  deviceRequests++;
                  for (const key of Object.keys(saved)) assert.equal(harness.storage.has(key), false, key);
                  assert.deepEqual(harness.storage.get('rdHosts'), ['files.example']);
                }
                respondToDeviceAuthorization(request);
              }
            }
          });
          await settle();

          await clickRealDebrid(link);
          assert.equal(deviceRequests, 1);
          assert.equal(harness.storage.get('rdOauthClientId'), 'new-client-id');
          assert.equal(harness.storage.get('rdOauthClientSecret'), 'new-client-secret');
          assert.equal(harness.storage.get('rdOauthAccessToken'), 'new-access-token');
          assert.equal(harness.storage.get('rdOauthRefreshToken'), 'new-refresh-token');
          assert.ok(harness.storage.get('rdOauthAccessTokenExpiresAt') > Date.now());
          assert.equal(harness.popups[0].location.href, 'https://files.example/download');
          assert.deepEqual(harness.alerts, []);
        });
      }
    }
  }
});

test('explicit reconnect replaces a saved session through device authorization', async () => {
  const harness = createHarness({
    storage: oauthSession(true), immediateTimers: true,
    requestHandler: respondToDeviceAuthorization
  });
  await harness.menuCommands.get('Connect or reconnect Real-Debrid (OAuth)')();
  assert.ok(harness.requests[0].url.includes('/device/code'));
  assert.equal(harness.storage.get('rdOauthRefreshToken'), 'new-refresh-token');
  assert.equal(harness.popups[0].closed, true);
  assert.match(harness.alerts.at(-1), /connected successfully/);
});

test('explicit disconnect clears all OAuth values even when remote invalidation fails', async () => {
  const saved = oauthSession(true);
  const harness = createHarness({
    storage: saved,
    requestHandler(request) {
      assert.equal(request.url, 'https://api.real-debrid.com/rest/1.0/disable_access_token');
      assert.equal(request.headers.Authorization, 'Bearer saved-access-token');
      request.onerror();
    }
  });
  await harness.menuCommands.get('Disconnect Real-Debrid on this browser')();
  for (const key of Object.keys(saved)) assert.equal(harness.storage.has(key), false, key);
  assert.deepEqual(harness.storage.get('rdHosts'), ['files.example']);
  assert.match(harness.alerts.at(-1), /disconnected/);
});

test('cancelling explicit disconnect preserves the session without making a request', async () => {
  const saved = oauthSession(true);
  const harness = createHarness({ storage: saved, confirmResult: false });
  await harness.menuCommands.get('Disconnect Real-Debrid on this browser')();
  for (const [key, value] of Object.entries(saved)) assert.equal(harness.storage.get(key), value, key);
  assert.equal(harness.requests.length, 0);
});

test('public core contains only intended public hostname literals', () => {
  const literalHosts = [...new Set(
    [...coreSource.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(match => match[1].toLowerCase())
  )].sort();
  assert.deepEqual(literalHosts, ['api.real-debrid.com', 'oauth.net']);
});

test('bulk command deduplicates supported links and sends them in one POST', async () => {
  const harness = createHarness();
  await settle();
  harness.document.links = [
    { href: 'https://files.example/a' },
    { href: 'https://files.example/a' },
    { href: 'https://unsupported.example/b' }
  ];

  harness.menuCommands.get('Send all supported page links to JDownloader')();
  await settle();

  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0], /1 unique supported link/);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].method, 'POST');
  const body = new URLSearchParams(harness.requests[0].data);
  assert.equal(body.get('source'), 'Tampermonkey');
  assert.equal(body.get('urls'), 'https://files.example/a');
  assert.match(harness.alerts.at(-1), /accepted.*HTTP 200.*success/i);
});

test('JDownloader HTTP failures are reported instead of showing success', async () => {
  const harness = createHarness({
    requestHandler(request) {
      request.onload({
        status: 503,
        statusText: 'Service Unavailable',
        responseText: '',
        finalUrl: request.url
      });
    }
  });
  await settle();
  harness.document.links = [{ href: 'https://files.example/a' }];

  harness.menuCommands.get('Send all supported page links to JDownloader')();
  await settle();

  assert.match(harness.alerts.at(-1), /HTTP 503/);
  assert.doesNotMatch(harness.alerts.at(-1), /accepted/i);
});

test('JDownloader interface-level failure is rejected even with HTTP 200', async () => {
  const harness = createHarness({
    requestHandler(request) {
      request.onload({
        status: 200,
        statusText: 'OK',
        responseText: 'failed',
        finalUrl: request.url
      });
    }
  });
  await settle();
  harness.document.links = [{ href: 'https://files.example/a' }];

  harness.menuCommands.get('Send all supported page links to JDownloader')();
  await settle();

  assert.match(harness.alerts.at(-1), /did not accept/i);
  assert.doesNotMatch(harness.alerts.at(-1), /accepted/i);
});

test('cross-origin authentication redirects are not treated as JDownloader success', async () => {
  const harness = createHarness({
    requestHandler(request) {
      request.onload({
        status: 200,
        statusText: 'OK',
        responseText: '<html>Sign in</html>',
        finalUrl: 'https://login.example.com/'
      });
    }
  });
  await settle();
  harness.document.links = [{ href: 'https://files.example/a' }];

  harness.menuCommands.get('Send all supported page links to JDownloader')();
  await settle();

  assert.match(harness.alerts.at(-1), /redirected away/i);
  assert.doesNotMatch(harness.alerts.at(-1), /accepted/i);
});

test('status command reports state without revealing stored OAuth values', async () => {
  const secret = 'generated-client-secret-value';
  const token = 'access-token-value';
  const harness = createHarness({
    storage: {
      rdOauthClientId: 'generated-client-id',
      rdOauthClientSecret: secret,
      rdOauthAccessToken: token,
      rdOauthRefreshToken: 'refresh-token-value',
      rdOauthAccessTokenExpiresAt: Date.now() + 60 * 60 * 1000
    }
  });
  await settle();

  harness.menuCommands.get('Show status and test JDownloader endpoint')();
  await settle();

  const report = harness.alerts.at(-1);
  assert.match(report, /Real-Debrid OAuth: connected/);
  assert.match(report, /Supported-host cache: fresh \(1 hosts/);
  assert.match(report, /JDownloader endpoint hostname: jdownloader\.example\.com/);
  assert.match(report, /interface reachable \(HTTP 200; failed\)/);
  assert.doesNotMatch(report, new RegExp(secret));
  assert.doesNotMatch(report, new RegExp(token));
  const body = new URLSearchParams(harness.requests[0].data);
  assert.equal(body.get('urls'), '');
  assert.equal(body.get('source'), 'Tampermonkey status check');
});

test('mutation batching prunes a pending child when its parent is also pending', async () => {
  const harness = createHarness();
  await settle();
  const child = new harness.FakeElement();
  const parent = new harness.FakeElement();
  parent.children.push(child);

  harness.getMutationCallback()([{ type: 'childList', addedNodes: [child, parent] }]);
  await new Promise(resolve => setTimeout(resolve, 180));

  assert.equal(parent.scanCount, 1);
  assert.equal(child.scanCount, 0);
});

test('initial scan processes wrapped anchors while preserving anchor and supported-host filtering', async () => {
  const supported = createAnchorWrapper('https://files.example/a');
  const subdomain = createAnchorWrapper('https://cdn.files.example/b');
  const ordinaryElement = createElementWrapper();
  ordinaryElement.setAttribute('href', supported.href);
  const rejected = [
    ordinaryElement,
    createAnchorWrapper(),
    createAnchorWrapper('https://unsupported.example/a'),
    createAnchorWrapper('https://notfiles.example/a'),
    createAnchorWrapper('https://files.example.evil.example/a'),
    createAnchorWrapper('ftp://files.example/a'),
    Object.assign(createAnchorWrapper(supported.href), { nodeType: 3 }),
    Object.assign(createAnchorWrapper(supported.href), { href: { baseVal: supported.href } })
  ];
  const harness = createHarness({ links: [supported, subdomain, ...rejected] });
  assert.equal(supported instanceof harness.FakeElement, false);
  assert.equal(supported instanceof harness.FakeAnchor, false);
  const sameRealmAnchor = new harness.FakeAnchor();
  sameRealmAnchor.setAttribute('href', 'https://files.example/same-realm');
  harness.document.links.push(sameRealmAnchor);
  await settle();

  [supported, subdomain, sameRealmAnchor].forEach(assertControls);
  rejected.forEach(node => assert.equal(node.nextSibling, null));
  assert.equal(typeof harness.getMutationCallback(), 'function');
  assert.equal(harness.requests.length, 0);
});

test('mutation-added wrapped roots process anchors and skip non-elements and injected controls', async () => {
  const harness = createHarness();
  await settle();
  const direct = createAnchorWrapper('https://files.example/direct');
  const nested = createAnchorWrapper('https://files.example/nested');
  const root = createElementWrapper();
  root.append(nested);
  const injected = createElementWrapper('span');
  injected.dataset.rdJdControls = 'true';
  const injectedLink = createAnchorWrapper('https://files.example/injected');
  injected.append(injectedLink);
  const disconnected = createAnchorWrapper('https://files.example/disconnected');
  disconnected.isConnected = false;
  const nonElements = [3, 9, 11].map(nodeType => Object.assign(createElementWrapper(), { nodeType }));
  assert.equal(root instanceof harness.FakeElement, false);
  assert.equal(direct instanceof harness.FakeAnchor, false);

  harness.getMutationCallback()([{
    type: 'childList',
    addedNodes: [direct, nested, root, injected, disconnected, ...nonElements, null, {}, { nodeType: 1 }]
  }]);
  await new Promise(resolve => setTimeout(resolve, 180));

  const directControls = assertControls(direct);
  assertControls(nested);
  assert.equal(root.scanCount, 1);
  assert.equal(nested.scanCount, 0, 'pending parent should subsume the nested anchor scan');
  assert.equal(injected.scanCount, 0);
  assert.equal(injectedLink.nextSibling, null);
  assert.equal(disconnected.nextSibling, null);
  nonElements.forEach(node => assert.equal(node.scanCount, 0));

  harness.getMutationCallback()([{ type: 'childList', addedNodes: [direct, directControls] }]);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(direct.nextSibling, directControls, 'rescanning must not duplicate controls');
  assert.equal(directControls.scanCount, 0);
});

test('href mutations on wrapped anchors add, retain, replace, and remove controls', async () => {
  const link = createAnchorWrapper('https://unsupported.example/a');
  const harness = createHarness({ links: [link] });
  await settle();
  assert.equal(link instanceof harness.FakeAnchor, false);
  assert.equal(link.nextSibling, null);
  const mutateHref = () => harness.getMutationCallback()([{
    type: 'attributes', attributeName: 'href', target: link
  }]);

  link.setAttribute('href', 'https://files.example/a');
  mutateHref();
  const originalControls = assertControls(link);
  mutateHref();
  assert.equal(link.nextSibling, originalControls);

  link.setAttribute('href', 'https://files.example/b');
  mutateHref();
  const replacementControls = assertControls(link);
  assert.notEqual(replacementControls, originalControls);
  assert.equal(originalControls.removed, true);

  link.setAttribute('href', 'https://unsupported.example/b');
  mutateHref();
  assert.equal(link.nextSibling, null);
  assert.equal(replacementControls.removed, true);

  const ordinaryElement = createElementWrapper();
  ordinaryElement.setAttribute('href', 'https://files.example/not-an-anchor');
  harness.getMutationCallback()([{
    type: 'attributes', attributeName: 'href', target: ordinaryElement
  }]);
  assert.equal(ordinaryElement.nextSibling, null);
  assert.equal(harness.requests.length, 0);
});

test('a burst of sibling roots is deduplicated once before scanning', async () => {
  const harness = createHarness();
  await settle();
  let comparisons = 0;
  const roots = Array.from({ length: 40 }, () => {
    const root = createElementWrapper();
    root.contains = candidate => { comparisons++; return candidate === root; };
    return root;
  });
  harness.getMutationCallback()([{ type: 'childList', addedNodes: roots }]);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert(roots.every(root => root.scanCount === 1));
  assert(comparisons <= 40 * 39, 'the same batch must not repeat containment checks while enqueueing');
});
