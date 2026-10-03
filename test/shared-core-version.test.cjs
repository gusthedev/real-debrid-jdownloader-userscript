'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const script = resolve(__dirname, '../scripts/check-shared-core-version.cjs');
const core = (version, body = '', runtime = version) =>
    `// ==UserScript==\n// @version ${version}\n// ==/UserScript==\nconst CORE_VERSION = '${runtime}';\n${body}\n`;

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'shared-core-version-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, {
        cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    git('init', '-q', '--initial-branch=main');
    const commit = files => {
        for (const [file, content] of Object.entries(files)) {
            const path = join(repo, file);
            mkdirSync(dirname(path), { recursive: true });
            if (content === null) rmSync(path);
            else writeFileSync(path, content);
        }
        git('add', '.');
        git('-c', 'user.name=Guard Test', '-c', 'user.email=guard@example.invalid',
            'commit', '--no-gpg-sign', '-qm', 'fixture');
        return git('rev-parse', 'HEAD');
    };
    const base = commit({ 'core.user.js': core('1.2.3') });
    const check = (head, constant, cwd = repo, baseSha = base) => {
        const result = spawnSync(process.execPath,
            [script, baseSha, head, 'core.user.js', ...(constant ? ['CORE_VERSION'] : [])],
            { cwd, encoding: 'utf8' });
        assert.ifError(result.error);
        return result;
    };
    const merge = branch => {
        git('-c', 'user.name=Guard Test', '-c', 'user.email=guard@example.invalid',
            'merge', '--no-ff', '--no-gpg-sign', '-qm', 'merge fixture', branch);
        return git('rev-parse', 'HEAD');
    };
    return { root, repo, git, commit, merge, base, check };
}

test('dependency, workflow, documentation, and loader-only changes need no core bump', t => {
    const f = fixture(t);
    const head = f.commit({
        'package.json': '{"devDependencies":{"example":"2.0.0"}}',
        'package-lock.json': '{"lockfileVersion":3}',
        '.github/workflows/ci.yml': 'name: Updated dependency',
        'README.md': 'Documentation change',
        'loader.user.js': '// @version 9.0.0'
    });
    const result = f.check(head, true);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unchanged/);
});

test('changed core with unchanged version fails across multiple PR commits', t => {
    const f = fixture(t);
    f.commit({ 'core.user.js': core('1.2.3', '// changed behavior') });
    const head = f.commit({ 'README.md': 'Follow-up documentation only' });
    // Read the supplied candidate snapshot, regardless of the current checkout.
    f.commit({ 'core.user.js': core('1.2.4') });
    const result = f.check(head);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed but @version is still 1.2.3/);
});

for (const next of ['1.2.4', '1.3.0', '2.0.0', '1.2.4-beta.1+build.2']) {
    test(`changed core with semantic version ${next} passes`, t => {
        const f = fixture(t);
        const head = f.commit({ 'core.user.js': core(next, '// changed behavior') });
        const result = f.check(head, true);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /1.2.3 ->/);
    });
}

for (const metadata of ['1.2', '01.2.4', '1.2.4-01', '1.2.4 extra', '1.2.4\n// @version 1.2.5']) {
    test(`invalid or duplicate @version ${JSON.stringify(metadata)} fails`, t => {
        const f = fixture(t);
        const head = f.commit({ 'core.user.js': core(metadata) });
        const result = f.check(head);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /exactly one valid semantic @version/);
    });
}

test('missing version in the metadata block fails even if the body contains one', t => {
    const f = fixture(t);
    const head = f.commit({ 'core.user.js': '// ==UserScript==\n// ==/UserScript==\n// @version 1.2.4\n' });
    const result = f.check(head);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /valid semantic @version/);
});

test('runtime constant must exist and match the bumped metadata', t => {
    const f = fixture(t);
    for (const source of [core('1.2.4', '', '1.2.3'), core('1.2.4').replace(/const CORE_VERSION.*\n/, '')]) {
        const head = f.commit({ 'core.user.js': source });
        const result = f.check(head, true);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /CORE_VERSION must match @version 1.2.4/);
    }
});

test('missing fetched base or deleted core fails rather than silently skipping', t => {
    const f = fixture(t);
    assert.equal(f.check(f.base, false, f.repo, '0'.repeat(40)).status, 1);
    const head = f.commit({ 'core.user.js': null });
    assert.equal(f.check(head).status, 1);
});

test('depth-one checkout plus exact shallow base fetch is sufficient', t => {
    const f = fixture(t);
    const head = f.commit({ 'core.user.js': core('1.2.4') });
    const shallow = join(f.root, 'shallow');
    f.git('clone', '-q', '--depth=1', pathToFileURL(f.repo).href, shallow);
    const git = (...args) => execFileSync('git', args, {
        cwd: shallow, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    git('fetch', '--no-tags', '--depth=1', 'origin', f.base);
    assert.equal(git('rev-parse', '--is-shallow-repository'), 'true');
    const result = f.check(head, true, shallow);
    assert.equal(result.status, 0, result.stderr);
});

test('older Dependabot branch passes when only main changed the core', t => {
    const f = fixture(t);
    f.git('switch', '-qc', 'dependabot');
    f.commit({ 'package-lock.json': '{"lockfileVersion":3}' });
    f.git('switch', '-q', 'main');
    // Simulate legacy main drift after the dependency branch was created.
    const currentBase = f.commit({ 'core.user.js': core('1.2.3', '// main-only change') });
    const candidate = f.merge('dependabot');
    const result = f.check(candidate, true, f.repo, currentBase);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unchanged/);
});

test('inheriting a version bump from main does not excuse unversioned PR changes', t => {
    const f = fixture(t);
    const original = '\n'.repeat(12) + '// original behavior';
    f.commit({ 'core.user.js': core('1.2.3', original) });
    f.git('switch', '-qc', 'feature');
    f.commit({ 'core.user.js': core('1.2.3', original.replace('original', 'changed')) });
    f.git('switch', '-q', 'main');
    const currentBase = f.commit({ 'core.user.js': core('1.2.4', original) });
    const candidate = f.merge('feature');
    const result = f.check(candidate, true, f.repo, currentBase);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed but @version is still 1.2.4/);
});
