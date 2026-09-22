# Third-party components

Framekeep's original source, original icons and synthetic test illustrations are MIT licensed. External tools are installed separately. No Python, Node.js, browser, WebView2, FFmpeg, model, font or third-party package binary is included in the release archives. Fonts use the system stack; SVG interface icons are authored paths. See ATTRIBUTION.md for the original workflow reference and independent implementation provenance.

| Component | Role | Upstream license / terms |
| --- | --- | --- |
| Python | Native helper and desktop runtime | [PSF license](https://docs.python.org/3/license.html) |
| Node.js | JavaScript challenge execution and development checks | [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE) |
| pywebview | Windows desktop host | [BSD 3-Clause](https://github.com/r0x0r/pywebview/blob/master/LICENSE) |
| yt-dlp | Supported public-media extraction | [Unlicense and dependency notices](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE) |
| yt-dlp-ejs | Extractor challenge scripts | [Unlicense](https://github.com/yt-dlp/ejs/blob/main/LICENSE) |
| FFmpeg / FFprobe | Media conversion, inspection and previews | [LGPL/GPL depending on build](https://ffmpeg.org/legal.html); binaries are not redistributed |
| Microsoft Edge WebView2 | Windows rendering engine | [Microsoft WebView2 distribution terms](https://developer.microsoft.com/microsoft-edge/webview2/) |
| Playwright | Optional development browser tests | [Apache 2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) |

The optional installed image sanitizer and Study Suite are separate tools, not bundled dependencies or code relicensed by Framekeep. Their absence does not prevent original image copies, public video/audio capture, library browsing or available captions. Their own licensing and installation are separate from this release. No optional model or paid inference is required by the basic product.

Public source does not contain personal media or study databases. Release UI illustrations and local media fixtures are synthetic. Any externally hosted fixture used in validation is identified in the validation record, with its upstream terms; it is not silently bundled into the product.
