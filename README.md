# Real-Debrid OAuth + JDownloader Userscript

This repository contains the shared, endpoint-free core for a Tampermonkey userscript that adds Real-Debrid and JDownloader buttons beside supported host links. JDownloader success is shown only after its configured endpoint returns HTTP 2xx and the Flash interface reports `success`.

## Features

- Unlock an individual supported link with Real-Debrid OAuth.
- Send an individual supported link to JDownloader with verified HTTP status.
- Send all unique supported links on the current page to JDownloader in one confirmed request.
- Show local OAuth expiry, supported-host cache state, and the configured endpoint hostname, then perform a harmless JDownloader connectivity check.

## Privacy model

- The public core contains no personal JDownloader hostname, password, OAuth token, generated client secret, or account credential.
- The Real-Debrid client ID in the core is the public client ID that Real-Debrid documents for open-source apps.
- Per-user OAuth credentials and tokens are generated during authorization and remain in Tampermonkey storage in the browser.
- The private JDownloader endpoint stays in a small loader installed locally in Tampermonkey.

## Installation

1. Copy `real-debrid-jdownloader-loader.example.user.js` into Tampermonkey.
2. Replace the example JDownloader endpoint with your own endpoint.
3. In the loader metadata, replace the example `@connect` hostname with the exact hostname used by that endpoint. Keep this private value in the local loader; the remotely loaded core cannot grant access to it.
4. Add any private domains on which the script should not run to `excludedDomains`.
5. Save the loader and disable older copies of the full userscript.
6. From Tampermonkey's menu for the loader, run **Connect or reconnect Real-Debrid (OAuth)** once in each browser.

The loader periodically checks this repository for an updated core and keeps a last-known-good cached copy for offline or GitHub-outage fallback. This makes the GitHub repository a trusted code source; review repository changes and protect the GitHub account with strong authentication.

Loader 1.1.2 fetches the current `main` core through GitHub's Contents API with raw media and requires a valid semantic `@version` in its userscript header. It retains the hourly update interval (five-minute retries without a cached core). **Check for shared-core updates now** bypasses caching and revalidates the stored ETag; a changed core is saved for the next page load.

When upgrading an existing local loader, preserve your private endpoint, endpoint `@connect` hostname, and `excludedDomains`. Change the GitHub `@connect` entry from `raw.githubusercontent.com` to `api.github.com` along with the loader code; updating the shared core alone does not update your locally installed loader.

## Stored values

Tampermonkey stores the supported-host cache and the Real-Debrid OAuth client ID, generated client secret, access token, refresh token, and expiry time. These values are never part of this repository.

The status command reports only whether the OAuth fields exist and when the access token expires. It never displays their values. Its JDownloader check submits the normal form fields with an empty `urls` value, so it does not add a download; it accepts either documented Flash-interface result as proof that the interface itself is reachable.

## Checks

Run the dependency-free Node test suite with:

```sh
npm test
```

Pull requests that change `real-debrid-jdownloader.user.js` must change its semantic `@version` relative to the PR base. CI compares the tested PR merge result with its exact base, fetching only that base at depth one; dependency-only (including Dependabot), workflow-only, documentation-only, and loader-only changes do not require a core bump. Only bump a loader version when that loader changes.

To run the same check locally with the base and candidate commits available locally (CI uses the PR merge commit as the candidate):

```sh
node scripts/check-shared-core-version.cjs <base-sha> <candidate-sha> real-debrid-jdownloader.user.js
```
