'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const coreFile = 'real-debrid-jdownloader.user.js';
const script = resolve(__dirname, '../scripts/check-shared-core-version.cjs');
const workflow = readFileSync(resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8');
const step = workflow.match(/^      - name: Check shared-core version\n([\s\S]*?)(?=^      - |$(?![\s\S]))/m)?.[1];
assert.ok(step, 'CI must include the shared-core version step');
const run = step.match(/^        run: \|\n([\s\S]*)/m)?.[1].replace(/^          /gm, '');
assert.ok(run, 'Exercise the actual CI shell commands');

const core = (version, body = '') =>
    `// ==UserScript==\n// @version ${version}\n// ==/UserScript==\n${body}\n`;

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'ci-workflow-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const gitAt = (cwd, ...args) => execFileSync('git', args, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    const git = (...args) => gitAt(repo, ...args);
    const identity = ['-c', 'user.name=Workflow Test', '-c', 'user.email=workflow@example.invalid'];
    git('init', '-q', '--initial-branch=main');
    const commit = files => {
        for (const [file, content] of Object.entries(files)) {
            const path = join(repo, file);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, content);
        }
        git('add', '.');
        git(...identity, 'commit', '--no-gpg-sign', '-qm', 'fixture');
        return git('rev-parse', 'HEAD');
    };
    const base = commit({ [coreFile]: core('1.2.3', '\n'.repeat(12) + '// original behavior') });
    const merge = branch => {
        git(...identity, 'merge', '--no-ff', '--no-gpg-sign', '-qm', 'merge fixture', branch);
        return git('rev-parse', 'HEAD');
    };
    const check = (eventName, event, candidate) => {
        const checkout = join(root, 'checkout');
        git('clone', '-q', '--depth=1', pathToFileURL(repo).href, checkout);
        assert.equal(gitAt(checkout, 'rev-parse', 'HEAD'), candidate);
        mkdirSync(join(checkout, 'scripts'));
        copyFileSync(script, join(checkout, 'scripts/check-shared-core-version.cjs'));
        const context = { github: { event, sha: candidate } };
        const env = { ...process.env, GITHUB_EVENT_NAME: eventName };
        // Resolve the workflow's simple context bindings, including absent event fields.
        for (const [, name, expression] of step.matchAll(/^          (\w+): \$\{\{ (github\.[\w.]+) \}\}$/gm)) {
            env[name] = expression.split('.').reduce((value, key) => value?.[key], context) ?? '';
        }
        const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
            cwd: checkout, env, encoding: 'utf8'
        });
        assert.ifError(result.error);
        assert.equal(gitAt(checkout, 'rev-parse', '--is-shallow-repository'), 'true');
        // Only the candidate and selected base snapshots should be present.
        assert.ok(Number(gitAt(checkout, 'rev-list', '--all', '--count')) <= 2);
        return result;
    };
    return { git, commit, merge, base, check };
}

test('CI runs the guard unconditionally for PRs and main pushes with read-only permissions', () => {
    assert.match(workflow, /on:\n  pull_request:\n  push:\n    branches: \[main\]/);
    assert.doesNotMatch(step, /^        if:/m);
    assert.match(workflow, /permissions:\n  contents: read/);
    assert.match(workflow, /persist-credentials: false/);
    assert.doesNotMatch(workflow, /fetch-depth: 0/);
});

test('PR uses its exact base and merge result when an older branch inherits main-only changes', t => {
    const f = fixture(t);
    f.git('switch', '-qc', 'dependency');
    f.commit({ 'package-lock.json': '{"lockfileVersion":3}' });
    f.git('switch', '-q', 'main');
    const base = f.commit({ [coreFile]: core('1.2.3', '// main-only change') });
    const candidate = f.merge('dependency');
    const result = f.check('pull_request', { pull_request: { base: { sha: base } } }, candidate);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unchanged/);
});

test('PR cannot use an inherited main version bump to excuse its own unversioned core change', t => {
    const f = fixture(t);
    f.git('switch', '-qc', 'feature');
    f.commit({ [coreFile]: core('1.2.3', '\n'.repeat(12) + '// changed behavior') });
    f.git('switch', '-q', 'main');
    const base = f.commit({ [coreFile]: core('1.2.4', '\n'.repeat(12) + '// original behavior') });
    const candidate = f.merge('feature');
    const result = f.check('pull_request', { pull_request: { base: { sha: base } } }, candidate);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed but @version is still 1.2.4/);
});

test('push compares the entire pushed range with event.before, not the tip parent or main', t => {
    const f = fixture(t);
    f.commit({ [coreFile]: core('1.2.3', '// unversioned change') });
    const candidate = f.commit({ 'README.md': 'Documentation-only final commit' });
    const result = f.check('push', { before: f.base }, candidate);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed but @version is still 1.2.3/);
});

test('push passes when a version bump occurs before the last commit in the pushed range', t => {
    const f = fixture(t);
    f.commit({ [coreFile]: core('1.2.4', '// versioned change') });
    const candidate = f.commit({ 'README.md': 'Documentation-only final commit' });
    const result = f.check('push', { before: f.base }, candidate);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1.2.3 -> 1.2.4/);
});

test('push with only workflow, dependency, documentation, and loader changes needs no core bump', t => {
    const f = fixture(t);
    const candidate = f.commit({
        '.github/workflows/ci.yml': 'name: CI',
        'package-lock.json': '{"lockfileVersion":3}',
        'README.md': 'Documentation change',
        'loader.user.js': '// @version 9.0.0'
    });
    const result = f.check('push', { before: f.base }, candidate);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unchanged/);
});

test('force-push compares exact previous and candidate snapshots without an ancestry walk', t => {
    const f = fixture(t);
    const before = f.commit({ [coreFile]: core('1.2.3', '// previous main') });
    f.git('switch', '-qc', 'replacement', f.base);
    const candidate = f.commit({ [coreFile]: core('1.2.3', '// replacement behavior') });
    const result = f.check('push', { before }, candidate);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed but @version is still 1.2.3/);
});

for (const before of [undefined, '0'.repeat(40), 'a'.repeat(40)]) {
    test(`push fails closed when its previous revision is ${before || 'missing'}`, t => {
        const f = fixture(t);
        const candidate = f.commit({ 'README.md': 'Documentation change' });
        const result = f.check('push', { before }, candidate);
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /unchanged/);
    });
}
