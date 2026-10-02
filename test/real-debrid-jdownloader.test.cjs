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
    FakeAnchor,
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
