# Installation, update and removal

Windows x64 and Chrome 127+ are the beta target. Install Python 3.11+, Node.js 22+, FFmpeg/FFprobe and WebView2 Evergreen from their official distributions. Keep reusable runtimes at user/machine scope, outside the project. Verify in a fresh shell with `python --version`, `node --version`, `ffmpeg -version` and `ffprobe -version`.

The installer installs missing `pywebview>=6.2.1,<7` and `yt-dlp[default]` through `python -m pip install --user --no-cache-dir`. You may install these yourself first. No account credentials, private workspace or paid service is required.

Launch **Install Framekeep.cmd** from File Explorer. Packaged terminals can redirect registration/filesystem writes; the installer requires an ordinary Windows shell for registration. It is per-user; administrator access is not required.

Default app: `%USERPROFILE%\Applications\Framekeep`. Default media: `%USERPROFILE%\Downloads\Framekeep`. Existing configured media location is preserved on update. Keep the unpacked extension directory where Chrome can load it. Capture originals are retained under `Originals` within the media directory until you explicitly remove them.

`scripts/Install.ps1 -CheckOnly` previews setup. Isolated tests accept `-InstallDirectory`, `-DownloadDirectory`, `-NoRegistration`, `-NoShortcuts`, `-SkipOptionalDependencies` and explicit runtime paths. A no-registration install does not connect Chrome. A separate test registration can use `-NativeHostName com.framekeep.beta_test` with a deliberate test-only extension copy targeting that name. Normal installation uses `com.framekeep.downloader` and the documented stable extension ID.

## Update

Finish/cancel active jobs and close Desktop. Extract the new release and run its installer against the same app directory. The save location and media are preserved. Reload Framekeep at `chrome://extensions` and refresh only pages where you want the updated content script. Reopen Desktop. There is no automatic updater.

`scripts/Update-Installed.ps1` updates managed source without changing runtimes, registration or downloads. Use the full installer for setup repair. Keep the previous release until the new one works; reinstalling prior source is a code rollback, not media deletion.

## Uninstall

Close Desktop and finish jobs, then run `scripts/Uninstall.ps1` for the matching installation. It removes managed app files, matching registration and matching shortcuts. Saved media, originals, local library metadata and shared runtimes remain. Remove the extension from `chrome://extensions`; its unused extracted source can then be removed separately.

## Common problems

- Helper unavailable: install both components, check the extension ID, and run setup through File Explorer.
- Cleaning unavailable: choose Original copies or configure a separately installed compatible sanitizer. No failed cleaning is silently bypassed.
- Unsupported source: private, DRM, login, region or verification restrictions and changing providers can prevent extraction.
- No captions: the source may not provide a track. Source captions, sidecar captions and optional generated transcription are distinct.
- Interrupted download: completed output remains; a new acquisition attempt starts a new transfer. Only optional study jobs offer their supported stage recovery.
