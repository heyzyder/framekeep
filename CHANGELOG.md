# Changelog

## 1.8.0-beta.3

- Make existing generated transcripts and source captions readable alongside playback, with source/language selection, search, real timestamp seeking and TXT/SRT/VTT export.
- Add durable collection management, display-title rename, multiple membership, recoverable Library removal and separately confirmed Windows Recycle Bin actions.
- Use verified media streams for available actions; expose source-linked Activity previews and preserved transcript/frame history, including missing-source explanations.
- Add theater and ordered playlist controls, persistent theme/text/playback preferences, and skippable/replayable onboarding.
- Add experimental incremental, locally processed selected-tab transcripts with bounded audio transport, preserved raw inference windows, visible capture state, explicit Stop, interruption reasons and partial-coverage labels. Reuse an installed compatible speech runtime and cached model; bundle no runtime or model.
- Add persistent, scoped widget dismissal and toolbar restoration without cancelling ordinary downloads.
- Extend the existing daily-update and release allowlists for these components. Prior beta tags and assets remain unchanged.

Beta.3 verification includes 89 JavaScript checks, including rendered synthetic UI journeys, and 103 Python checks. The actual daily Windows app exercised generated-track search/seek/native SRT export, display-title rename, collection membership and empty-collection restart/deletion, image zoom, silent-video frame extraction, Activity source/result navigation, theater/fullscreen, playlist Next/Previous/autoplay, persistent appearance/reading preferences, and skippable/replayable onboarding. Existing media and configuration hashes were preserved. An isolated fresh-source installation reused global dependencies and passed launcher/CLI/managed-file checks. See the detailed validation record for checks that remain synthetic or unverified.

Installed local speech processing was measured separately from the browser transport. Actual Chrome toolbar invocation, capture consent, the loaded unpacked directory and reload were not verified for this update because verification tooling was blocked at the browser's protected settings route. No no-caption YouTube or multilingual browser acceptance is claimed. This is an experimental beta, not a completed usability milestone or independent acceptance; see [the detailed scope](docs/limitations.md#180-beta3-current-verification).

## 1.8.0-beta.2

- Add running Desktop version, managed-payload build fingerprint, and collapsed local installation diagnostics to Settings.
- Keep prerelease version reporting consistent across Desktop, native host, Extension, and MCP.
- Preserve existing installation paths, native registration, shortcuts, settings and saved media when updating the daily app.
- Refresh current GitHub links and product description for heyzyder/framekeep. The beta.1 tag and assets remain unchanged.

## 1.8.0-beta.1

First public Windows/Chrome beta. Extension and native protocol version: 1.8.0.

- Desktop navigation centers on Library, Activity and Settings, with searchable media and a dedicated item workspace.
- Captured images and video/audio outputs share durable item/job identities across Desktop, Extension and the included agent entry points.
- Local previews, source reopening, collections and available caption navigation keep saved results useful without repeated downloads.
- Prepared study evidence is an optional installed-tool integration; preparation is distinguished from human review.
- Image capture offers an explicit original-copy mode. Existing verified PNG/JPEG cleaning remains optional and never silently falls back after failure.
- Public installation, packaging and source separation preserve user media and keep runtimes outside the repository.

## 1.7.2 (private baseline)

Floating draggable media picker, multi-select capture, image previews, public video/audio extraction, captions, parallel downloads and Windows desktop host. The public beta preserves this engine and extends the human-facing workflow.
