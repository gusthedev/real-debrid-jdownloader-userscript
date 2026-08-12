# Real-Debrid OAuth + JDownloader Userscript

This repository contains the shared, endpoint-free core for a Tampermonkey userscript that adds Real-Debrid and JDownloader buttons beside supported host links.

## Privacy model

- The public core contains no personal JDownloader hostname, password, OAuth token, generated client secret, or account credential.
- The Real-Debrid client ID in the core is the public client ID that Real-Debrid documents for open-source apps.
- Per-user OAuth credentials and tokens are generated during authorization and remain in Tampermonkey storage in the browser.
- The private JDownloader endpoint stays in a small loader installed locally in Tampermonkey.

## Installation

1. Copy `real-debrid-jdownloader-loader.example.user.js` into Tampermonkey.
2. Replace the example JDownloader endpoint with your own endpoint.
3. Add any private domains on which the script should not run to `excludedDomains`.
4. Save the loader and disable older copies of the full userscript.
5. From Tampermonkey's menu for the loader, run **Connect or reconnect Real-Debrid (OAuth)** once in each browser.

The loader retrieves the current core from this repository whenever it runs. This makes the GitHub repository a trusted code source; review repository changes and protect the GitHub account with strong authentication.

## Stored values

Tampermonkey stores the supported-host cache and the Real-Debrid OAuth client ID, generated client secret, access token, refresh token, and expiry time. These values are never part of this repository.
