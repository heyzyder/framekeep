# Beta limits and validation

Windows x64 and unpacked Chrome are the supported beta target. Other operating systems, browsers and store distribution are unverified. The launcher is unsigned; runtimes are separately installed. The Windows ZIP is an installer/source distribution, not a standalone runtime bundle.

Provider extraction depends on the original website, yt-dlp and available formats. Enabled extractors do not guarantee every URL works. No DRM, account-cookie, access-control or paywall bypass. Player recognition and successful extraction are separate. New downloads do not overwrite existing completed media.

Original-copy mode retains metadata. Verified PNG/JPEG cleaning requires the separately installed compatible local sanitizer. Other formats retain their bytes with no cleaning claim. Capture keeps originals and permits up to 100 selected files, 256 MiB each and 1 GiB total source bytes; processing needs additional space.

Captions depend on available tracks. Sidecar captions and optional generated transcription are labeled separately. Browser/WebView2 playback depends on installed codecs; Open file uses the system player. Missing captions are not replaced with invented text.

Acquisition supports cancellation and truthful interrupted states, not pause/resume. Optional Study Suite recovery obeys its stage and runtime compatibility rules. The installed Study Suite does not expose a supported cancellation operation; the app explains that running preparation continues instead of showing a nonfunctional Cancel button. Sampled frames and transcripts do not prove listening, continuous visual review, understanding or correctness. Basic capture/playback requires no model; speech generation explicitly activates an already installed compatible local model. No runtime or model is bundled or automatically downloaded.

Live browser transcription has partial source coverage: only selected-tab audio captured after Start is included. Timestamps refer to the saved browser recording, not the original site's timeline. Pauses remain part of that recording. Navigation, seeking, detected source/rate/ad changes, protected media and a 20-second queue limit stop capture instead of silently joining discontinuous media. Captures are bounded to one hour. Live capture requires a detectable top-frame audio/video source. Embedded-only or hidden players without verifiable source continuity are rejected with an explanation. No microphone input is requested. Speech recognition can mishear or omit words; automatic language detection, punctuation and mixed-language accuracy are not guaranteed. Original inference windows remain locally available alongside settled text.

Live mode requires Chrome's tabCapture, offscreen and sidePanel support, an explicit extension invocation, a compatible installed Study Suite speech environment and its cached pinned large-v3-turbo model. A reloaded unpacked extension may require Chrome to acknowledge its additional permissions. Chrome-managed, protected or unsupported tabs may refuse capture. Restarting the extension or losing the local connection stops capture and retains partial results. The app does not claim to transcribe all provider content or an entire source from a short live recording.

Release validation uses synthetic data and explicitly identified permitted public fixtures. The record is finalized against the release artifacts. Product function, rendered inspection, public checksum verification and fresh-source build are separate checks. Producer verification remains distinct from independent acceptance.

## 1.8.0-beta.3 current verification

This update has **89 passing JavaScript checks**, including rendered synthetic desktop/browser UI journeys, and **103 passing Python checks**. Automated fixtures exercise durable collection creation, rename and batch membership, ordering, preserved originals, media-specific rejection, transcript selection/export, playback controls and recovery boundaries. These checks do not substitute for the installed application's real user journeys.

The actual installed Windows WebView2 application opened an existing **10-cue generated live transcript** with no source captions and no new transcription request. Search for “Collections” and seeking to **12 seconds** worked. Its native save dialog exported **SRT**, with all ten cue texts and millisecond timings checked against the saved track. Display-title rename was cancelled and saved while the original media filename and file were preserved.

The daily app also created and renamed a collection, saved membership for three selected items, retained an empty collection across restart, and deleted that test collection without deleting media. Image zoom, silent-video speech omission, frame extraction, Activity parent navigation and **Open frames** were exercised. A two-item playable queue excluded the image; Next, Previous and autoplay-next worked. Theater and video fullscreen exited back to the item. Transcript scrolling kept playback visible and exposed Return to current line. System, Light and Dark appearance rendered; text size and autoplay preferences survived restart and were restored to their prior defaults. Help replay, Skip, Back, Next and Finish worked without recording or setup. Desktop and Start shortcuts launched the updated app; all three existing shortcut files, native connection configuration and all 76 pre-existing media/metadata files matched their before-update hashes.

A fresh allowlisted source stage installed into an isolated app/media directory with registration and shortcuts disabled, reused existing global dependencies, compiled its launcher and passed CLI health and 32 managed-file hash checks. This establishes source installation on the configured machine, not clean-VM dependency setup. The daily UI was inspected at approximately 1109 × 569 pixels; narrower/scaled layouts and keyboard reorder/repeat cases were exercised synthetically, not all in the actual daily window.

A paced **35.915-second authored English fixture** exercised the already installed local CUDA speech pipeline. Observed measurements on that computer were:

| Local pipeline measurement | Observed result |
| --- | --- |
| Model load | 2.359 seconds |
| First settled text | 6.625 seconds |
| Maximum chunk processing time | 0.609 seconds |
| Maximum queue delay | 0.016 seconds |
| Failed or dropped chunks | 0 |
| Silence check | No additional cues |

These are **installed local pipeline measurements, not end-to-end Chrome latency**. They are not a universal performance or transcription-accuracy guarantee. The test used an existing model; it did not certify fresh model setup or multilingual browser transcription.

The verification tooling was blocked at Chrome's protected settings route. Consequently, this update has **not verified the currently loaded unpacked directory, extension reload, normal toolbar capture invocation or Chrome's explicit capture permission grant**. Actual no-caption YouTube capture, a second ordinary site's complete browser capture journey, denied-permission behavior in real Chrome, and multilingual browser acceptance remain unverified. Earlier Chrome capture checks below do not establish these newly added live-transcription capabilities.

Live browser transcription is therefore **experimental in beta.3**. Installed UI checks, local processing, synthetic browser transport tests, release packaging and independent usability acceptance are separate. This record does not claim completion of the full milestone or independent acceptance. The existing Study Suite still has no supported cancellation API; its preparation capability reports that limit, while ordinary supported download cancellation and live capture's explicit Stop remain separate controls.

## Historical beta.1 validation scope

Validated on Windows x64 with Python 3.12.6, Node.js 24.14.0, FFmpeg 8.1.1, the existing WebView2 runtime and actual Google Chrome 153.0.8010.53. This was an isolated application directory, library, native-host name and browser profile on an existing Windows machine, not a factory-reset VM. Python packages and reusable runtimes were already present; fresh-machine downloading of those third-party installers was not exercised.

- 75 Python tests and 68 JavaScript tests passed, including shared durable receipts, cancellation, source/artifact integrity, preview byte ranges, packaging and installer safety. A separate syntax/manifest/asset check passed.
- The installed WebView2 app played authored video, searched and sought sidecar captions, persisted a collection, and displayed real source-linked visual study artifacts. The extension exported a synthetic caption transcript with verified text bytes.
- Actual Chrome loaded the unpacked extension with its stable manifest identity. Its real native host saved an image and a CC0 video; independent file hashing and CLI/Desktop readback matched the job IDs. Opening the captured image launched Windows Photos with the saved filename.
- A real CLI download appeared in Desktop. A real Desktop button started audio extraction that the CLI inspected. A separate actual MCP subprocess read the same engine's UI/bridge-created job. Cross-process cancellation, restart identity and hash-verified completed-request reuse passed without duplicate outputs.
- Source installation, installed update and uninstall ran in isolated directories. Uninstall removed application files and preserved the configured media and settings. Normal Windows PowerShell native-host registration was exercised with a separate test identity; the daily installation was preserved.
- Rendered checks covered keyboard navigation, focus, empty/error states, reduced motion and resized layouts. Extension cases included a 430-pixel viewport, short windows and 175% browser zoom. Screenshots use synthetic media; they are not photographs from a user's library.

The real network video fixture was [MDN's CC0 flower sample](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4). A small [httpbin image response](https://httpbin.org/image/png) exercised original-byte capture; it is not distributed or shown in public screenshots. Synthetic artwork, audio and captions were authored for testing. Optional visual study preparation was tested against an already installed compatible Study Suite; speech/model quality and every external provider were not certified.

Desktop's native save-dialog invocation was exercised; automated exported-text byte verification used the extension's export path. Windows code signing, Chrome Web Store installation, Linux/macOS, other browsers, clean-VM runtime bootstrapping and every optional model remain outside this beta's verified scope.

## 1.8.0-beta.2 daily-upgrade verification

The validation above records the original beta.1 release. Beta.2 additionally verified an in-place upgrade of an existing daily Windows installation, using its existing library and native connection:

- Desktop, Start, and the existing pinned shortcut dispatched the same upgraded daily application. The live extension's **Media tools → Open Desktop** action started a new process in that installation and displayed Library, Activity, and Settings. This checks dispatch through the existing pinned shortcut; it does not certify removing or creating a taskbar pin.
- A real extension capture appeared under the same job ID in daily Desktop, CLI, and an actual MCP process. **Open file** opened the saved image in Windows Photos. A cold restart retained the job's receipt timestamps, output hash, and collection without duplicate processing.
- Desktop's real native **Save As** dialog exported three authored caption cues. An independent byte check verified the resulting 122-byte text file. This completes the Desktop export check that remained unverified in the beta.1 record.
- Settings now exposes the running Desktop version, an installation build fingerprint, and collapsed local diagnostics. The fingerprint records the managed files and launcher at installation time; it is not a signature or a continuous integrity check. The registered extension ID does not claim the version currently loaded by Chrome. Diagnostic installation paths remain local and should be hidden in shared screenshots.

These checks used an existing configured Windows machine. They do not establish clean-machine setup, automatic updates, new taskbar pinning, or broader browser/platform support. The beta.1 release and its original artifacts remain unchanged.
