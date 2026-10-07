const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const loaderSource = fs.readFileSync(
  path.join(__dirname, '..', 'real-debrid-jdownloader-loader.example.user.js'), 'utf8'
);
const SHARED_SCRIPT_URL = 'https://api.github.com/repos/gusthedev/real-debrid-jdownloader-userscript/contents/real-debrid-jdownloader.user.js?ref=main';
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const STORAGE = {
  source: 'rdJdLoader.sharedCore.source.v1',
  etag: 'rdJdLoader.sharedCore.etag.v1',
  lastAttempt: 'rdJdLoader.sharedCore.lastAttempt.v1'
};

function core(version = '7.2.1') {
  return `// ==UserScript==
// @name         Real-Debrid OAuth + JDownloader (Shared Core)
// @namespace    shared.real-debrid.jdownloader
// @version      ${version}
// ${'validated fixture '.repeat(70)}
// ==/UserScript==
globalThis.__coreRuns = [...(globalThis.__coreRuns || []), '${version}'];
globalThis.__configSeen = globalThis.RD_JD_CONFIG;`;
}

function runLoader(storageValues = {}) {
  const storage = new Map(Object.entries(storageValues));
  const requests = [];
  const menus = new Map();
  const alerts = [];
  let syntaxChecks = 0;
  const context = {
    Function: function (source) { syntaxChecks++; return new Function(source); },
    Date: class extends Date { static now() { return NOW; } },
    console: { error() {}, info() {}, warn() {} },
    window: { alert: message => alerts.push(String(message)) },
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, value) => storage.set(key, value),
    GM_deleteValue: key => storage.delete(key),
    GM_registerMenuCommand: (label, callback) => menus.set(label, callback),
    GM_xmlhttpRequest: request => requests.push(request)
  };
  vm.runInNewContext(loaderSource, context, { filename: 'loader.user.js' });
  return {
    alerts, context, requests, storage, syntaxChecks: () => syntaxChecks,
    checkManually: () => menus.get('Check for shared-core updates now')(),
    runs: () => Array.from(context.__coreRuns || [])
  };
}

function respond(request, source, responseHeaders = 'ETag: "new-core"\r\n') {
  request.onload({ status: 200, responseText: source, responseHeaders });
}

function assertRequest(request, { manual = false, etag } = {}) {
  assert.equal(request.method, 'GET');
  assert.equal(request.url, manual ? `${SHARED_SCRIPT_URL}&tm_refresh=${NOW}` : SHARED_SCRIPT_URL);
  assert.equal(request.headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(request.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(request.headers['If-None-Match'], etag);
  assert.equal(request.headers['Cache-Control'], manual ? 'no-cache' : undefined);
  assert.equal(request.headers.Pragma, manual ? 'no-cache' : undefined);
  assert.equal(request.timeout, 15_000);
}

test('loader metadata grants the Contents API host', () => {
  assert.match(loaderSource, /^\/\/\s*@connect\s+api\.github\.com\s*$/m);
  assert.doesNotMatch(loaderSource, /^\/\/\s*@connect\s+raw\.githubusercontent\.com\s*$/m);
});

test('fresh install fetches current main as raw source, caches, and executes it once', () => {
  const h = runLoader({ [STORAGE.etag]: '"orphaned-etag"' });
  assert.equal(h.requests.length, 1);
  assertRequest(h.requests[0]);
  assert.equal(h.storage.get(STORAGE.lastAttempt), NOW);
  assert.deepEqual(h.runs(), []);
  respond(h.requests[0], core(), 'Content-Type: text/plain\r\neTaG: "core-721"\r\n');
  assert.equal(h.storage.get(STORAGE.source), core());
  assert.equal(h.storage.get(STORAGE.etag), '"core-721"');
  assert.deepEqual(h.runs(), ['7.2.1']);
  assert.equal(h.context.__configSeen, h.context.RD_JD_CONFIG);
  assert.equal(h.context.__configSeen.jdownloaderEndpoint, 'https://jdownloader.example.com/flash/add');
  assert.deepEqual(Array.from(h.context.__configSeen.excludedDomains), ['example.com']);
  assert.equal(Object.isFrozen(h.context.__configSeen), true);
  assert.deepEqual(h.alerts, []);
});

test('fresh cache starts synchronously and keeps the hourly update boundary', () => {
  for (const age of [0, HOUR - 1, HOUR]) {
    const h = runLoader({
      [STORAGE.source]: core(), [STORAGE.etag]: '"core-721"', [STORAGE.lastAttempt]: NOW - age
    });
    assert.deepEqual(h.runs(), ['7.2.1']);
    assert.equal(h.requests.length, age === HOUR ? 1 : 0);
    if (h.requests.length) assertRequest(h.requests[0], { etag: '"core-721"' });
  }
});

test('empty cache keeps the five-minute retry boundary', () => {
  for (const age of [0, FIVE_MINUTES - 1, FIVE_MINUTES]) {
    const h = runLoader({ [STORAGE.lastAttempt]: NOW - age });
    assert.deepEqual(h.runs(), []);
    assert.equal(h.requests.length, age === FIVE_MINUTES ? 1 : 0);
  }
});

test('automatic update revalidates its ETag and saves fresh source for the next page', () => {
  const h = runLoader({ [STORAGE.source]: core('7.2.0'), [STORAGE.etag]: '"core-720"' });
  assertRequest(h.requests[0], { etag: '"core-720"' });
  respond(h.requests[0], core());
  assert.deepEqual(h.runs(), ['7.2.0']);
  assert.equal(h.storage.get(STORAGE.source), core());
  assert.equal(h.storage.get(STORAGE.etag), '"new-core"');
  const nextPage = runLoader(Object.fromEntries(h.storage));
  assert.deepEqual(nextPage.runs(), ['7.2.1']);
  assert.equal(nextPage.requests.length, 0);
});

test('automatic 304 preserves the validated cache and ETag without reexecution', () => {
  const h = runLoader({ [STORAGE.source]: core(), [STORAGE.etag]: '"core-721"' });
  assertRequest(h.requests[0], { etag: '"core-721"' });
  h.requests[0].onload({ status: 304, responseText: '', responseHeaders: '' });
  assert.equal(h.storage.get(STORAGE.source), core());
  assert.equal(h.storage.get(STORAGE.etag), '"core-721"');
  assert.equal(h.storage.get(STORAGE.lastAttempt), NOW);
  assert.deepEqual(h.runs(), ['7.2.1']);
  assert.deepEqual(h.alerts, []);
});

test('manual update bypasses caches despite a fresh cache and reports the new version', () => {
  const h = runLoader({
    [STORAGE.source]: core('7.2.0'), [STORAGE.etag]: '"core-720"', [STORAGE.lastAttempt]: NOW
  });
  assert.equal(h.requests.length, 0);
  h.checkManually();
  assert.equal(h.requests.length, 1);
  assertRequest(h.requests[0], { manual: true, etag: '"core-720"' });
  respond(h.requests[0], core());
  assert.equal(h.storage.get(STORAGE.source), core());
  assert.equal(h.storage.get(STORAGE.etag), '"new-core"');
  assert.deepEqual(h.runs(), ['7.2.0']);
  assert.equal(h.alerts.at(-1), '[RD + JD loader] Shared core 7.2.1 was saved. Reload the page to use it.');
});

test('manual 304 reports the cached version and leaves source and ETag intact', () => {
  const h = runLoader({
    [STORAGE.source]: core(), [STORAGE.etag]: '"core-721"', [STORAGE.lastAttempt]: NOW
  });
  h.checkManually();
  assertRequest(h.requests[0], { manual: true, etag: '"core-721"' });
  h.requests[0].onload({ status: 304, responseHeaders: '' });
  assert.equal(h.storage.get(STORAGE.source), core());
  assert.equal(h.storage.get(STORAGE.etag), '"core-721"');
  assert.deepEqual(h.runs(), ['7.2.1']);
  assert.equal(h.alerts.at(-1), '[RD + JD loader] The shared core is current (7.2.1).');
});

test('manual unchanged 200 reports current and clears a missing ETag', () => {
  const h = runLoader({
    [STORAGE.source]: core(), [STORAGE.etag]: '"core-721"', [STORAGE.lastAttempt]: NOW
  });
  h.checkManually();
  respond(h.requests[0], core(), 'Content-Type: text/plain\r\n');
  assert.equal(h.storage.get(STORAGE.source), core());
  assert.equal(h.storage.has(STORAGE.etag), false);
  assert.deepEqual(h.runs(), ['7.2.1']);
  assert.equal(h.alerts.at(-1), '[RD + JD loader] The shared core is current (7.2.1).');
});

test('304 without a valid cache fails instead of claiming an unknown version is current', () => {
  const h = runLoader({ [STORAGE.lastAttempt]: NOW });
  h.checkManually();
  assertRequest(h.requests[0], { manual: true });
  h.requests[0].onload({ status: 304, responseHeaders: '' });
  assert.equal(h.storage.has(STORAGE.source), false);
  assert.deepEqual(h.runs(), []);
  assert.match(h.alerts.at(-1), /GitHub returned HTTP 304/);
  assert.doesNotMatch(h.alerts.at(-1), /current|unknown version/);
  h.checkManually();
  assert.equal(h.requests.length, 2, 'failed request must release the in-flight guard');
});

const invalidVersions = [
  ['missing', core().replace('// @version      7.2.1\n', '')],
  ['empty', core('')],
  ['non-version', core('latest')],
  ['partial', core('7.2')],
  ['leading zero', core('07.2.1')],
  ['invalid prerelease', core('7.2.1-01')],
  ['trailing text', core('7.2.1 extra')],
  ['duplicate', core().replace('// @version      7.2.1', '// @version      7.2.1\n// @version      7.2.2')],
  ['outside header', `${core().replace('// @version      7.2.1\n', '')}\n// @version      7.2.1`],
  ['multiline', core().replace('// @version      7.2.1', '// @version\n// 7.2.1')]
];

test('invalid version metadata is neither cached nor executed nor reported as current', async t => {
  for (const [label, invalid] of invalidVersions) {
    await t.test(label, () => {
      const cold = runLoader();
      respond(cold.requests[0], invalid);
      assert.equal(cold.storage.has(STORAGE.source), false);
      assert.equal(cold.storage.has(STORAGE.etag), false);
      assert.deepEqual(cold.runs(), []);

      const warm = runLoader({
        [STORAGE.source]: core(), [STORAGE.etag]: '"good"', [STORAGE.lastAttempt]: NOW
      });
      warm.checkManually();
      respond(warm.requests[0], invalid, 'ETag: "bad"\r\n');
      assert.equal(warm.storage.get(STORAGE.source), core());
      assert.equal(warm.storage.get(STORAGE.etag), '"good"');
      assert.deepEqual(warm.runs(), ['7.2.1']);
      assert.match(warm.alerts.at(-1), /invalid shared core; it was not saved/);

      const cached = runLoader({ [STORAGE.source]: invalid, [STORAGE.etag]: '"bad"' });
      assert.deepEqual(cached.runs(), []);
      assert.equal(cached.storage.has(STORAGE.source), false);
      assert.equal(cached.storage.has(STORAGE.etag), false);
      assertRequest(cached.requests[0]);
      respond(cached.requests[0], core());
      assert.deepEqual(cached.runs(), ['7.2.1']);
    });
  }
});

test('valid semantic prerelease/build metadata and CRLF headers are reported accurately', () => {
  const version = '7.2.1-rc.1+build.001';
  const source = core(version).replaceAll('\n', '\r\n');
  const h = runLoader({ [STORAGE.lastAttempt]: NOW });
  h.checkManually();
  respond(h.requests[0], source);
  assert.equal(h.storage.get(STORAGE.source), source);
  assert.match(h.alerts.at(-1), /Shared core 7\.2\.1-rc\.1\+build\.001 was saved/);
});

test('concurrent manual checks do not issue duplicate requests', () => {
  const h = runLoader();
  h.checkManually();
  assert.equal(h.requests.length, 1);
  assert.match(h.alerts.at(-1), /already running/);
  respond(h.requests[0], core());
  h.checkManually();
  assert.equal(h.requests.length, 2);
  assertRequest(h.requests[1], { manual: true, etag: '"new-core"' });
});

test('failed manual checks preserve the active cache and allow another check', () => {
  for (const fail of [
    request => request.onerror(new Error('offline')),
    request => request.ontimeout(),
    request => request.onload({ status: 403, responseText: '{"message":"rate limit"}' })
  ]) {
    const h = runLoader({
      [STORAGE.source]: core(), [STORAGE.etag]: '"good"', [STORAGE.lastAttempt]: NOW
    });
    h.checkManually();
    fail(h.requests[0]);
    assert.equal(h.storage.get(STORAGE.source), core());
    assert.equal(h.storage.get(STORAGE.etag), '"good"');
    assert.deepEqual(h.runs(), ['7.2.1']);
    assert.match(h.alerts.at(-1), /The cached core remains active/);
    h.checkManually();
    assert.equal(h.requests.length, 2);
  }
});

test('warm startup validates cached source only once', () => {
  const h = runLoader({ [STORAGE.source]: core(), [STORAGE.lastAttempt]: NOW });
  assert.equal(h.syntaxChecks(), 1);
  assert.equal(h.runs().length, 1);
});
