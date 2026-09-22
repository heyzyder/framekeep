# Components and agent interfaces

`extension/` is the Manifest V3 popup, side panel, floating picker, discovery and caption interface. `native/host.py` is the shared acquisition/format engine. `native/desktop.pyw` hosts the dedicated Desktop interface in WebView2; `desktop_bridge.py` adapts its actions to the same engine.

Durable native job IDs and output references live beside the configured media library. Desktop, CLI and MCP inspect those same records. This metadata is not a second Study Suite job database. Existing loose files receive stable local identities. The library imports direct files and completed Capture folders without recursively exposing retained Originals.

Media previews use a loopback-only token-scoped server with path containment and byte-range support. Do not share preview URLs. Public source reopening validates URLs. Cancellation signals the original existing worker; Framekeep does not add a second executor or pretend an interrupted transfer can resume.

## Agent entry points

The installed `framekeep_cli.py` and `framekeep_mcp.py` sit beside `config.json`. Supply `--config` explicitly for custom/test installations. Run `python native/framekeep_cli.py --help` for the exact shipped parser. The stdio MCP adapter exposes matching local operations and has no external HTTP listener. Configure your client with your Python executable and script path. Do not publish your config or library records.

## Optional study preparation

`study_adapter.py` calls supported operations of a separately installed compatible Study Suite. The suite retains source/job/artifact identity and evidence/recovery semantics. This release does not install models, alter the suite schema or publish the shared suite. Missing optional tools show an explicit unavailable state.

Prepared artifacts, source captions, generated transcription and model output have different meanings. Artifact existence and hashes establish availability/integrity, not complete review or factual correctness. Reopening prepared output does not reprocess the source.
