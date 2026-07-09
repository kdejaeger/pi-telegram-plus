# Changelog

## 0.1.0 (2025-07-09)

- **Rich Message API** — migrated from custom HTML rendering to Telegram's native `sendRichText`/`editRichText` markdown support
- **Custom UI routing** — added `custom()` handler in Telegram UI runtime for external extension UIs (`@juicesharp/rpiv-ask-user-question`, `@aliou/pi-guardrails`)
- **Error propagation** — controller-level error handling with user-facing error messages
- **Render consolidation** — unified inline event rendering with configurable tool/thinking visibility levels
- **Config cleanup** — removed redundant config reload on initial load
- **Markdown improvements** — table alignment fixes, paragraph break preservation, proper table separator rendering
- **TUI status** — configurable footer verbosity level (hidden/minimal/brief/full)
- **Per-workspace bot tokens** — `/tg-bind-cwd` and `/tg-unbind-cwd` for multi-project setups