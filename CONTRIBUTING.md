# Contributing

Start with a small issue describing the user-visible problem and Windows/Chrome versions. Keep the extension capture flow responsive, preserve existing files and identifiers, and use the shared native operations for every entry point.

Run `npm test`, `npm run check`, and `python -B -m unittest discover -s tests -p "*_test.py"` before proposing a change. Render the affected interface and exercise real error and empty states. Capture synthetic evidence only; do not attach browser profiles, private links, downloaded personal media, credentials or local configuration.

Use existing global tools for development. Framekeep does not need a repository node_modules directory for the standard checks. Browser integration tests can use a separately installed Playwright package and Chromium path through the documented environment variables. Do not weaken source URL checks, origin restrictions or artifact path containment to make a test pass.

Contributions to original Framekeep code are submitted under the MIT license. Preserve third-party notices and explain any new redistribution requirement.
