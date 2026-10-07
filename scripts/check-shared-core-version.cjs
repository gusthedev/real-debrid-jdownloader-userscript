'use strict';

const { execFileSync } = require('node:child_process');

const number = '(?:0|[1-9][0-9]*)';
const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function version(source, label) {
    const header = source.match(/^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==[ \t]*\r?$/m)?.[1] || '';
    const versions = [...header.matchAll(/^\/\/[ \t]*@version[ \t]+([^\r\n]*)/gm)];
    const value = versions[0]?.[1].trim();
    if (versions.length !== 1 || !semver.test(value || '')) {
        throw new Error(`${label} must declare exactly one valid semantic @version (for example, 1.2.3).`);
    }
    return value;
}

try {
    const [base, candidate, core, runtimeConstant] = process.argv.slice(2);
    if (!/^[a-f0-9]{40}$/.test(base || '') || !/^[a-f0-9]{40}$/.test(candidate || '') || !core
        || (runtimeConstant && !/^[A-Z_][A-Z0-9_]*$/.test(runtimeConstant))) {
        throw new Error('Usage: node scripts/check-shared-core-version.cjs <base-sha> <candidate-sha> <core-file> [RUNTIME_CONSTANT]');
    }
    // CI passes the exact PR base and tested merge commit, or the push event's
    // previous revision and pushed tip. Comparing the PR merge result to its exact
    // base avoids treating main-only drift as a change in an older PR.
    // These two shallow snapshots need no merge-base/history walk.
    const read = ref => execFileSync('git', ['show', `${ref}:${core}`], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    const before = read(base);
    const after = read(candidate);
    if (before === after) {
        console.log(`${core}: unchanged; no shared-core version bump required.`);
    } else {
        const previous = version(before, `${core} at base commit`);
        const next = version(after, `${core} at candidate commit`);
        if (previous === next) {
            throw new Error(`${core} changed but @version is still ${next}. Bump the shared-core version; leave unchanged loaders alone.`);
        }
        if (runtimeConstant) {
            const declarations = [...after.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${runtimeConstant}\\s*=\\s*(['"])([^'"]+)\\1`, 'g'))];
            if (declarations.length !== 1 || declarations[0][2] !== next) {
                throw new Error(`${core}: ${runtimeConstant} must match @version ${next}.`);
            }
        }
        console.log(`${core}: @version ${previous} -> ${next}.`);
    }
} catch (error) {
    console.error(`Shared-core version check failed: ${error.message}`);
    process.exitCode = 1;
}
