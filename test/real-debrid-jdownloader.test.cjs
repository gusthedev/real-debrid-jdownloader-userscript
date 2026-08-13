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
  let mutationCallback = null;

  class FakeElement {
    constructor() {
      this.children = [];
      this.isConnected = true;
      this.scanCount = 0;
    }

    contains(candidate) {
      return candidate === this || this.children.some(child => child.contains(candidate));
    }

    matches() {
      return false;
    }

    querySelectorAll() {
      this.scanCount += 1;
      return [];
    }
  }

  class FakeAnchor extends FakeElement {}

  const document = {
    body: new FakeElement(),
    links: [],
    querySelectorAll() {
      return this.links;
    }
  };
  const pageUrl = new URL('https://page.example/downloads');
  const window = {
    alert: message => alerts.push(String(message)),
    confirm: message => {
      confirmations.push(String(message));
      return options.confirmResult !== false;
    },
    clearTimeout,
    setTimeout
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

      observe() {}
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
    alerts,
    confirmations,
    document,
    menuCommands,
    requests,
    storage,
    getMutationCallback: () => mutationCallback
  };
}

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
