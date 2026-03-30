# Mediabunny Migration Plan

## Goal
- Remove every product path that opens `https://ffmpeg.bmmmd.com/` or `https://ffmpeg.94cat.com/`.
- Keep the old `catCatchFFmpeg` job semantics only as a compatibility envelope.
- Perform the old final "FFmpeg" work inside this extension with Mediabunny.
- Make the output contract explicit: one job should end in one final downloadable media file, not segment downloads.

This repo does not bundle `ffmpeg` or `ffmpeg.wasm`, so the migration target is local remux/finalization in the browser, not full FFmpeg feature parity.

## What The Code Does Today
- `js/background.js` handles `Message == "catCatchFFmpeg"` by opening `G.ffmpegConfig.url`, caching jobs, and forwarding them after the remote tab loads.
- `js/content-script.js` bridges extension messages and blobs into the remote page with `window.postMessage`.
- `js/m3u8.js` and `js/downloader.js` can also embed the hosted page in an `iframe` when `G.iframeFFmpeg` is enabled.
- `catch-script/catch.js` and `catch-script/recorder.js` still post `catCatchFFmpeg` jobs that assume a remote processor exists.
- `js/m3u8.js` already downloads and decrypts segments locally, but it still hands final processing off to the hosted FFmpeg path for `merge`, `addFile`, `catchMerge`, `transcode`, and `onlyAudio`.

## Core Decision
- Treat "FFmpeg" as a legacy action name, not as a deployment target.
- Add an extension-owned runner such as `mediabunny.html`, `js/mediabunny.js`, and `js/mediabunny-worker.js`.
- Keep the current payload shape as stable as possible: `action`, `files`, `taskId`, `quantity`, `tabId`, `index`, `title`, `output`, `extra`.
- Let the local runner collect partial inputs until `quantity` is satisfied, then emit one final file and a `catCatchFFmpegResult`-compatible completion signal.

This keeps caller churn low while removing the remote dependency completely.

## Blocking The Hosted Redirect
Removing the remote URL from config is necessary but not sufficient. We also need a defensive migration layer so stale paths cannot keep opening the hosted site.

- Replace `G.ffmpegConfig.url` in `js/init.js` with a local extension URL such as `chrome.runtime.getURL("mediabunny.html")`.
- Replace every `chrome.tabs.query/create/sendMessage` path that targets the hosted URL in `js/background.js`, `js/m3u8.js`, `js/downloader.js`, and `js/popup.js`.
- Add a temporary navigation guard during migration: if a main-frame navigation still targets `ffmpeg.bmmmd.com` or `ffmpeg.94cat.com`, immediately reroute that tab to the local `mediabunny.html` page or close it and open the local page instead.
- Remove the remote-page `window.postMessage` bridge from `js/content-script.js` after all callers talk to the local runner directly.

The important distinction is that we are not asking the old hosted page to redirect anywhere. The extension itself must stop opening it and must defensively catch any remaining attempts.

## Mediabunny Responsibilities
### MVP scope
- `merge`: collect separate audio/video inputs and mux them into one MP4.
- `addFile`: append one input to an in-progress merge task until `quantity` is met, then finalize one MP4.
- `catchMerge`: combine captured audio/video blobs into one final file.

### Phase 2 scope
- `transcode`
- `onlyAudio`
- codec fallback logic for browser-incompatible inputs

For MVP, the target is single-file remux/finalization, not universal transcoding. If a job truly requires decode/re-encode and the browser cannot provide it, the runner should fail clearly instead of pretending to offer full FFmpeg behavior.

## Single-File Output Contract
- `js/m3u8.js` should still download, decrypt, and assemble segments locally, but the user-visible result must be one final media file.
- No `.ts`, `.m4s`, or per-track downloads should be emitted when the user chose merge/finalize.
- `catch-script/catch.js` should produce one final file per capture job.
- `catch-script/recorder.js` already has a single-file `MediaRecorder` result; it should only use Mediabunny when packaging/normalization is needed.
- Temporary segment buffers in memory are acceptable. User-visible segment files are not.

## Recommended Architecture
### Runner lifecycle
- The local mux page opens a `chrome.runtime.connect` port to `js/background.js`.
- The background owns the pending-job queue and attaches jobs to an active runner session.
- The mux page hands heavy work to a dedicated worker so large mux jobs do not block UI responsiveness.

### Job normalization
- Accept `Blob`, `ArrayBuffer`, and object URL inputs.
- Resolve object URLs inside the extension context before sending work into Mediabunny.
- Preserve `taskId`, `quantity`, `index`, and `tabId` so existing progress/auto-close logic still works.

### Mediabunny output
- Use `BlobSource` for downloaded inputs.
- Use `Mp4OutputFormat` for final video output.
- Start with `BufferTarget` plus `chrome.downloads.download`.
- Move to `StreamTarget` only if memory pressure is unacceptable.

## Concrete Repository Changes
- `js/init.js`: replace or rename `G.ffmpegConfig` so it no longer points at a hosted URL. Keep `streamSaverConfig` separate because it still uses a remote `mitm.html`.
- `js/background.js`: replace the hosted-tab cache with a local runner registry, pending-job queue, and temporary redirect guard for legacy hosted URLs.
- `js/content-script.js`: remove the `Message == "ffmpeg"` relay into page `postMessage` once the local runner is wired.
- `js/m3u8.js`: replace hosted iframe/tab logic with local runner calls; multi-manifest audio+video merges should end in one MP4 download.
- `js/downloader.js`: replace hosted iframe/tab logic with local runner calls; merge tasks should finalize into one file locally.
- `catch-script/catch.js`: stop creating hosted-job object URLs and hand local blobs to the extension runner.
- `catch-script/recorder.js`: keep direct single-file download for simple cases, and use the runner only when final packaging is required.
- `js/popup.js`, `js/preview.js`, `popup.html`, `preview.html`, `options.html`, and locale files: rename user-facing "online ffmpeg" wording to local mux/remux wording and remove buttons that explicitly open the hosted site.
- `lib/`: vendor the Mediabunny browser build and record it in `lib/third-party-libraries.md`.

## Compatibility Mapping
- `merge` and `addFile` should map to the same local task accumulator so existing multi-file and multi-tab merge flows keep working.
- `catchMerge` should map to "combine capture outputs into one final asset", not "download each capture part separately".
- `transcode` and `onlyAudio` should be kept behind explicit capability checks. If we cannot actually satisfy them locally, they should remain disabled or return a clear unsupported result.

## Risks And Decisions
- Mediabunny is not a drop-in replacement for all FFmpeg features. The migration should promise local remux/finalization first, not universal transcoding.
- Existing HEVC/H.265 warnings in the UI likely remain relevant. Browser codec support still limits what can be decoded or encoded locally.
- Large files are still a memory risk because current flows often accumulate buffers before finalization. `BufferTarget` is the fastest MVP, but not the long-term ceiling.
- Firefox and Chromium differ on structured cloning and media support. Prefer direct extension messaging and workers over cross-origin page messaging.
- `catchMerge` needs one validation pass to confirm it always means "combine tracks into one file" and never "emit a folder of parts".

## Suggested Delivery Order
1. Replace hosted URLs with a local `mediabunny.html` entry point and add the defensive redirect block.
2. Build the background queue and local runner session so `catCatchFFmpeg` jobs no longer depend on a remote page.
3. Implement `merge`, `addFile`, and `catchMerge` in Mediabunny with a one-file output contract.
4. Rewire `m3u8`, downloader, catch, recorder, popup, and preview flows to the local runner.
5. Rename UI text away from "online ffmpeg".
6. Re-evaluate `transcode` and `onlyAudio` only after the mux/remux path is stable.

## Acceptance Checklist
- No extension flow opens `ffmpeg.bmmmd.com` or `ffmpeg.94cat.com`.
- Any stale attempt to navigate to those hosted pages is blocked and rerouted to the local runner.
- `merge`, `addFile`, and `catchMerge` end in one final downloadable file.
- `m3u8` merge does not expose segment files as user-visible downloads.
- `catch` and `recorder` still produce a final file and completion signal.
- `taskId`, `quantity`, progress callbacks, auto-close, and completion messages still behave correctly.
- Mediabunny is documented in `lib/third-party-libraries.md`.

## References
- [Mediabunny introduction](https://mediabunny.dev/guide/introduction)
- [Mediabunny conversion API](https://mediabunny.dev/guide/converting-media-files)
- [Mediabunny supported formats and codecs](https://mediabunny.dev/guide/supported-formats-and-codecs)
