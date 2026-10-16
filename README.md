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

Loader **1.1.3** fetches the current `main` core through GitHub's Contents API with raw media and requires a valid semantic `@version` in its userscript header. It retains the hourly update interval (five-minute retries without a cached core). **Check for shared-core updates now** bypasses caching and revalidates the stored ETag; a changed core is saved for the next page load.

When upgrading an existing local loader, preserve your private endpoint, endpoint `@connect` hostname, and `excludedDomains`. Loader **1.1.3** adds `// @grant GM_addValueChangeListener`, which shared core **7.3.0** needs for live supported-host synchronization. Add this grant to your existing local loader (or apply the example loader update while retaining your private configuration), save, and reload all open pages. If upgrading from a pre-1.1.2 loader, also change the GitHub `@connect` entry from `raw.githubusercontent.com` to `api.github.com` along with the loader code. Updating the shared core alone cannot grant permissions to your locally installed loader.

Without the new grant, the core remains usable and logs an upgrade instruction, but idle tabs cannot receive host-cache updates or repair concurrent writes through storage events. Tabs running older core versions must also be reloaded to participate.

## Stored values

Tampermonkey stores the supported-host cache and the Real-Debrid OAuth client ID, generated client secret, access token, refresh token, and expiry time. These values are never part of this repository.

Core 7.3.0 stores host domains, their accepted timestamp, and non-secret request-ordering stamps together in `rdSupportedHostsStateV1`. Existing `rdHosts` / `rdHostsUpdated` values provide the initial fallback until the first request publishes this record. They are retained for compatibility but are no longer updated or authoritative once the new record exists. An older tab writing those legacy keys cannot overwrite the upgraded cache. Host synchronization does not read, write, or broadcast OAuth credentials or private loader configuration.

The status command reports only whether the OAuth fields exist and when the access token expires. It never displays their values. Its JDownloader check submits the normal form fields with an empty `urls` value, so it does not add a download; it accepts either documented Flash-interface result as proof that the interface itself is reachable.

## OAuth disconnect and recovery

Since shared core **7.2.7**, the script clears local OAuth credentials immediately when you confirm **Disconnect Real-Debrid on this browser**, then attempts to invalidate the previous access token remotely. A failed remote request does not restore local credentials. A new connection can start while that request is still pending.

Pending refresh and device-authorization operations check whether they were superseded before saving credentials, continuing authorization, or reporting success. A non-secret `rdOauthSessionGeneration` marker remains in Tampermonkey storage after disconnect so other tabs using the same loader can detect the disconnect too. Old request cleanup cannot release a newer operation's shared promise, and a refresh for replaced credentials cannot overwrite or clear the newer session.

Transient refresh failures still retain the saved credentials for a later retry. Only a definitive invalid-token response for the current session clears them and permits device authorization. To connect again after an explicit disconnect, use the connect menu or retry a Real-Debrid link. Reload open pages after updating the core so every tab uses the new guards.

## Supported-host refreshes

Shared core **7.3.0** coordinates supported-host refreshes across open tabs using the same installed loader and Tampermonkey storage. This extends PR #13's within-page protection. Two-context regression tests reproduce the previously documented idle-tab controls and stale cross-tab overwrite problems; they are simulated consistency failures, not a report of a production incident.

- **Refresh Real-Debrid supported hosts** bypasses the cache and publishes an ordered request stamp before fetching. Responses check the current shared stamp before saving. A later observed request supersedes earlier discovery or manual refreshes across tabs; obsolete successes and failures stay silent.
- One atomic record carries the latest request, its accepted cache, and timestamp. Starting a refresh preserves the accepted cache as fallback. A failed latest refresh retains that fallback, reports failure in its initiating tab, and cannot revive an older response. Another refresh can start immediately; no shared lock can be stranded by a closed tab.
- [Tampermonkey value-change events](https://www.tampermonkey.net/documentation.php?locale=en&q=GM_values) update idle tabs' in-memory host lists and reconcile controls when the host set changes. Unsupported buttons are removed, newly supported buttons are added, and unchanged buttons retain their identity and in-flight state. Remote changes do not show success/failure alerts or start network requests.
- Request stamps use a logical clock and a random tie breaker. Observing a newer stamp advances the clock even within the same millisecond or after wall-clock rollback. Truly concurrent requests with stale storage views use deterministic stamp ordering. Delayed or reordered notifications merge by request stamp, then by accepted-cache stamp within that request; a losing stored write is repaired. Because Tampermonkey storage has no compare-and-swap, synchronization converges when events are delivered, rather than providing a synchronous cross-tab transaction. A tab suspended before receiving events can temporarily show its previous controls.

Automatic discovery and bulk-send operations use a fresh cache when available and otherwise share the current in-flight request within their page. Independent tabs may still issue separate network requests; their results are ordered and synchronized. There is no permanent polling, retry loop, or additional network call for synchronization. It applies to upgraded tabs of the same script installation, not separate loaders, browser profiles, or devices.

## Dynamic page controls

Removed anchors and their injected buttons are reconciled in the existing 150 ms mutation batch, without a full-page rescan. Controls follow moved anchors and retain in-flight button state. Links reinserted before the batch runs keep their controls; links reinserted after cleanup receive fresh controls. Removing an entire subtree or a link's `href` also clears the affected controls.

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
