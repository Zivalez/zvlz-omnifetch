<h1 align="center">ZVLZ OmniFetch</h1>

<p align="center">
  <img src="icons/icon128.png" alt="ZVLZ OmniFetch icon" width="128" height="128">
</p>

<p align="center">
  A Chrome extension that detects media on the active tab<br>
  and only offers a download once it is verified complete as one whole file.<br>
  No loose fragments. No partial file saved as a success.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square" alt="Manifest V3">
  <img src="https://img.shields.io/badge/Chrome-120%2B-4285F4?style=flat-square" alt="Chrome 120 plus">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License">
  <img src="https://img.shields.io/badge/Version-0.1.0-blue?style=flat-square" alt="Version 0.1.0">
</p>

## What is ZVLZ OmniFetch?

**ZVLZ OmniFetch** is a personal, extension-only media downloader for Chrome.

It watches the active tab, collects media candidates from the network, the page DOM, and the page itself, then builds one entry per media item. An item only becomes downloadable when its manifest, segments, audio pairing, and size checks pass. If any part is missing, changed, encrypted, or live, the item stays in the Unavailable group with a specific reason instead of offering a broken or partial download.

Everything runs locally in the browser. There is no account, no processing server, no companion app, and no library loaded from a CDN at runtime.

> **ZVLZ OmniFetch** = the extension
>
> **Completeness gate** = the rule that decides what can be downloaded
>
> **READY** = manifest complete, audio pairing complete, no DRM, not live, within size limits

## Features

- Active tab only detection, with per-tab results that survive tab switching within the same browser session
- HLS, DASH, progressive files, audio, and images in one list
- Hover preview for video after 350 ms, muted, one preview at a time, with a favicon fallback when there is no poster
- One entry per whole item, with audio and video pairing for adaptive streams
- Lazy download: segments are only fetched after you click Download, in order, with retries
- HLS TS transmuxed to MP4 and separate audio plus video muxed without re-encoding, using bundled MediaBunny
- AES-128 HLS decryption in the download path
- OPFS staging for large tracks, with a Clear temporary files action
- Live recording through tab capture, clearly labeled as a partial, re-encoded capture from now on
- Queue view with pause, resume, and cancel, plus a History view and a Settings view
- Popup and side panel sharing the same implementation
- Dark-only UI, system fonts, English interface

## Install, no build, no npm

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome 120 or later.
3. Turn on **Developer mode**.
4. Choose **Load unpacked**, then select the repository root folder itself, the folder that directly contains `manifest.json`.
5. Reload the source page so the content scripts and page hook start working. Play the media, then open the extension.

Do not select a subfolder named `media-downloader`. That folder does not exist in this repository, and selecting it will fail because `manifest.json` is at the root.

`npm` is only needed to run the development tests. It is not needed to use the extension.

## How it works

### 1. Detection, three layers, active tab only

- Network layer: observes media and manifest URLs and response headers, and discards candidates from non-active tabs immediately.
- DOM layer: scans video and audio elements, preferring `currentSrc`, plus posters, durations, dimensions, srcset images, lazy attributes, and CSS background images. Scanning pauses when the tab is hidden.
- Page layer: a MAIN world hook wraps fetch and XHR and forwards only metadata, never response bodies. It also reads YouTube player response metadata where available.

Candidates are deduplicated by canonical URL, debounced, and analyzed in the offscreen document. Detection stores URLs plus metadata only. No media segment bytes are stored at detection, except for a small manifest fetch and a first-bytes peek for progressive files and images.

### 2. Completeness gate

An item is READY only when at least one variant has zero blocking reasons.

For HLS, that means: a master or media playlist with ENDLIST, a non-empty segment list, an init segment for fMP4, a complete audio rendition when the variant needs audio, no SAMPLE-AES or CENC DRM, no discontinuity, and an estimated size within the limit.

For DASH, that means: a static MPD with SegmentList or SegmentTemplate plus timeline, one Period, a complete audio representation when pairing is needed, no DRM ContentProtection, and an estimated size within the limit.

For progressive files, that means: a first-bytes probe that sniffs the real format instead of trusting the extension or content type, a size within the limit, and a result that is not an HTML or JSON error page.

For images, that means: a single file that passes the magic-bytes peek, with small images hidden by default unless Show small images is on.

A failed gate never becomes a partial download. It becomes a NOT_READY reason: DRM, live, incomplete segment list, missing init, incomplete audio, key unavailable, too large, unsupported codec, or signature required.

### 3. Preview

Video preview runs on hover or focus after 350 ms, muted, and stops when the cursor leaves, when the popup hides, or when the list re-renders. Only one preview plays at a time, and the preview player is destroyed on stop. Preview streams only. It never calls the download API and never stages a file for download.

If an item has no poster, the thumbnail area falls back to the page favicon, then to the app icon as a last resort. Audio items have no hover playback.

### 4. Download, only on click

Clicking Download creates a job, then the offscreen worker:

1. Refreshes the manifest and re-verifies ENDLIST, segment count, DRM status, and audio pairing.
2. Fetches AES-128 keys before any segment. A missing or short key cancels the job with `key_unavailable`.
3. Checks the estimated size against the 1.5 GB default cap and the device memory cap.
4. Fetches segments with bounded concurrency, per-segment timeout, retries with backoff, and ordered writing. Fetching may run in parallel, but writing is strictly in index order.
5. Stages each track in memory up to 96 MB, then spills to OPFS for larger tracks.
6. Assembles the output, transmuxes HLS TS to MP4 or muxes separate audio and video without re-encoding, and verifies the result: tracks present, duration finite and positive, and duration within tolerance of the manifest.
7. Only then hands the finished blob to the Chrome downloads API. On any failure or cancel, staging is cleared and no partial file reaches the Downloads folder.

Pause and resume work while the job is alive in the same session. A browser or extension restart fails running jobs with `session_restart`, and a failed job must start again from scratch with a fresh manifest check. Do not rely on restart-proof resume.

## Supported formats and honest limits

This is an early 0.1.0 build. READY means the manifest and metadata are eligible, not a guarantee that the network will stay available later.

| Area | Status |
| --- | --- |
| HLS | Supported for non-encrypted TS and fMP4 streams with ENDLIST. AES-128 is supported in the download path. SAMPLE-AES, CENC, and all DRM are refused. Discontinuities are refused. Direct media playlists without master codec and bandwidth info are refused conservatively. |
| DASH | Supported for SegmentList and SegmentTemplate plus timeline, with audio pairing and subtitle sidecars. SegmentBase and sidx are NOT READY, even though a parser exists. Negative timeline repeats, some inheritance forms, multi-Period, and complex content are incomplete. |
| Progressive | Supported for single files with first-bytes sniffing. Range support is recorded but not required, so a file without Range support is downloaded as one whole fetch. |
| Images | Supported as single files and as a store-only ZIP. Failed images in a ZIP are silently skipped, so a ZIP can omit failed images without an error. Individual image downloads do not have this problem. |
| Audio | Supported standalone and as a pairing track for video. Language preference is available in Settings. |
| YouTube | Only formats with a direct URL from the player response are used. Formats with only a signature cipher and no URL become NOT_READY with `signature_required`. No signature solving is implemented, and YouTube has not been tested end to end. No claim is made that all videos can be saved. |
| Transcode | Not available. No ffmpeg.wasm is bundled, and there is no re-encoding except live recording. Unsupported codecs become `codec_unsupported`. |
| Subtitles | Basic sidecar download as one `.vtt` file. No embedding, no SRT conversion, and some playlist subtitles are incomplete. |
| Large jobs | Default estimated cap is 1.5 GB, plus a device memory cap. OPFS staging exists, but the mux stage still uses an in-memory buffer target, so this is not an end-to-end constant-memory pipeline. Very large progressive files are first loaded whole before staging. |
| Queue and resume | Pause and resume work in-session only. There is no global max-concurrent-jobs gate yet, so Download all starts jobs concurrently even though its confirmation text says one after another. Reorder, failed-job retry, and restart-proof resume are incomplete. |
| Auth | Page cookies can be inherited where the browser allows through `credentials: include`. Partitioned or site-specific cookie restrictions can still fail. A per-site header and cookie path is unfinished and not activated. |
| Live | No whole-file download button for live streams. The only live path is recording from now on through tab capture, labeled as partial and re-encoded. |
| Chrome testing | End-to-end Chrome testing could not run in the original sandbox because system shared libraries were missing. Node tests do not replace real Chrome testing, site auth testing, or PRD acceptance testing. |

## Design preview

Opening the repository root `index.html` or `ui/popup.html?preview=1` shows a design preview with fake demo data labeled as a preview. That data is not real detection, and its buttons do not create real jobs. Normal extension mode does not use demo data.

## Privacy and permissions

Host permission `<all_urls>` is needed to observe media across sites, but detection events are limited to the active tab. History stores only filename, host, and metadata, not token URLs. Session inventories do contain segment URLs, which may carry tokens, for as long as the browser session lives.

Other permissions are used for their stated purpose: downloads for saving finished files, storage for per-tab state and settings, offscreen for long media work, webRequest and webNavigation for detection, scripting for content script injection, alarms for keepalive, contextMenus for Scan this tab and Download this media, cookies for page-inherited auth where allowed, sidePanel for the side panel view, tabCapture for live recording only, declarativeNetRequest for per-job Referer and Origin session rules, notifications for job completion and failure, and tabs for active tab tracking.

There is no external analytics, no account, and no native messaging host.

## Local libraries

- MediaBunny 1.62.1, MPL-2.0, source: https://github.com/Vanilagy/mediabunny, unmodified
- HLS.js 1.5.20, Apache-2.0, source: https://github.com/video-dev/hls.js
- dash.js 4.7.4, BSD-3-Clause, source: https://github.com/Dash-Industry-Forum/dash.js

License texts are in `lib/licenses/`. No additional library is installed at use time.

## Testing

- Syntax check for all non-vendor JavaScript files.
- `npm test`: 10 unit tests pass, covering HLS master and audio rendition, DRM and live gates, DASH timeline repeats, byterange offsets, resolution labels, filename sanitizing, ZIP CRC and headers, AES default IV, and quoted codec attributes.
- Node experiments with MediaBunny against Apple HLS and Big Buck Bunny DASH samples: TS to MP4, audio plus video mux, and AAC extraction parsed back successfully.
- Chrome end-to-end testing has not been completed yet, as noted above.

## FAQ

### Why does an item show Unavailable instead of a Download button?

Because the completeness gate found a blocking reason: DRM, live, incomplete segment list, missing init, incomplete audio, a key that cannot be fetched, a file too large, an unsupported codec, or a signature-only YouTube format. The reason is shown on the card, with a contextual action where one exists: Record for live, an explanation for DRM, Scan again for rescan reasons, or other qualities for audio and codec cases.

### Why does returning to a tab show its old results, but restarting Chrome does not?

Per-tab state lives in `chrome.storage.session`, which survives tab switching within the same browser session but is lost on browser restart. Running jobs are also failed on restart. This is a known limit, not a bug in the list view.

### Why is a live stream not downloadable as a whole file?

A live stream has no complete segment list and no ENDLIST, so a whole file cannot be verified. The only supported live path is recording from now on, which is a partial, re-encoded capture, not the original broadcast.

### Why is DRM refused?

Widevine, FairPlay, and PlayReady keys never leave the browser decryption module, so there is no legitimate in-extension way to save the decrypted media. Refusal is technical, not a policy choice in the gate.

### Can I use this for media I do not own or do not have rights to save?

Use only media you have the right to save. This extension does not grant rights, bypass DRM, or solve signatures.

## Project structure

- `manifest.json`: Manifest V3 metadata, permissions, icons, popup, side panel, and content scripts
- `background/`: service worker orchestration, active tab tracking, per-tab store, webRequest observation, job lifecycle, and offscreen client
- `content/`: DOM detector in the isolated world and fetch and XHR hook in the MAIN world
- `engine/`: pure helpers for the gate, HLS and DASH parsing, AES-128, codecs, formats, naming, reasons, sniffing, URLs, ZIP, and MP4 boxes
- `offscreen/`: analysis, fetching, assembly, staging, and live recording
- `ui/`: popup and side panel views, components, and styles
- `lib/`: bundled HLS.js, dash.js, and MediaBunny, with licenses in `lib/licenses/`
- `icons/`: extension icons in 16, 32, 48, and 128 pixels
- `tests/`: Node unit tests for the engine

## License and author

- License: MIT, see `LICENSE`
- Author and owner: [Zivalez](https://github.com/Zivalez)
- Repository: https://github.com/Zivalez/zvlz-omnifetch
- Icon: infinity mark with a download arrow, pale green on dark, in `icons/`
