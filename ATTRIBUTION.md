# Source notes

Reference project: https://github.com/tublydownloader/Youtube-Downloader-Extension

Inspected upstream HEAD: `5f9e1fad5378f1924595644effe44adb48a35dd2` on 2026-09-11.

The reference repository advertises a YouTube downloader, but its manifest references absent background, content, and style files, and its popup uses simulated progress. Framekeep replaces that incomplete implementation with newly written extension and companion code. No upstream code, logo, screenshots or trademark assets are bundled. No license file was present in the inspected upstream root, so this is an independent implementation of the requested workflow rather than a redistributed upstream fork.

Dependencies are installed separately, with their own licenses:

- yt-dlp: https://github.com/yt-dlp/yt-dlp (Unlicense for the project source; see its license and dependency notes).
- yt-dlp EJS: https://github.com/yt-dlp/ejs.
- FFmpeg: https://ffmpeg.org/legal.html (license depends on the installed build; the existing FFmpeg binary is not redistributed).
- Python and Node.js are reused from the user's global installations.

Native messaging implementation follows the Chrome extension documentation: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging.
