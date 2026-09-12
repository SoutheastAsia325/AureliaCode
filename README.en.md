# AureliaCode

**An Android AI coding assistant deeply customized for the Agnes model.**

AureliaCode is a self-contained Android app: no Termux, no root, no desktop required.
It embeds its own runtime and coding-agent engine, and adds a dedicated adaptation layer
that fixes Agnes' unstable tool-call formatting and high first-token latency.

Derived from the open-source project
[kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) (MIT).
Upstream attribution and licensing are fully preserved.

## Highlights

- **Agnes adaptation layer** (`plugins/dsh-llm-agnes`):
  - *Format cleansing* — tool calls written into the message body are detected in the
    stream and rewritten into proper `tool_calls` blocks. Six malformed shapes are
    covered (bare JSON, OpenAI envelope, function envelope, Markdown fences,
    `<tool_call>` tags, mixed prose + call). Brace matching is used instead of regex,
    because tool arguments contain nested objects and braces inside strings.
  - *Prefix-cache alignment* — canonical serialization of the system slot and tool
    definitions, plus session-level drift detection (diagnostic only, never blocks).
  - *Tool-call constraint* — a hard format rule injected into the system slot, only when
    the request actually carries tools.
- All three attach to the engine's existing `llm/stream` waterfall seam. **No engine
  source is modified and no provider is registered**, so any Agnes route you configure
  in the app's settings is covered automatically.
- Embedded runtime snapshot (bash + node + toolchain), transactional replacement with
  automatic recovery on interruption.
- Streaming UI with Markdown, syntax highlighting and typewriter effect; reasoning is
  rendered as its own collapsible block, never mixed into the answer.
- Optional on-device control (accessibility or ADB channel) with explicit authorization.

## Documentation

The full documentation — installation, first-run Agnes configuration, build
instructions, architecture and permissions — is in the Chinese
[README.md](README.md).

## Build

APKs are built in the cloud via GitHub Actions (this is the only verified path):

```bash
export GITHUB_TOKEN=<your token>          # needs repo + workflow scope
bash scripts/aureliacode-cloud-build.sh <owner/repo> arm64
```

## License

MIT — see [LICENSE](LICENSE). Upstream: [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk).
