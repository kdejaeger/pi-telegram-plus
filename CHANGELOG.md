# Changelog

## 0.2.1 (2026-09-07)

- **Prompts no longer time out.** Interactive prompts surfaced in Telegram (guardrails path/command confirmation, `ask_user_question`, confirm/input/inputSecret/editor/select) stay answerable until you answer, press Deny/Cancel, or send `/stop` — matching the terminal, which also waits indefinitely. Previously the Telegram side auto-expired after 10 minutes, silently stripping the buttons and auto-denying unattended guardrails prompts — an answer from your phone could arrive too late. Answering from the terminal still retires the Telegram buttons immediately, and pressing buttons on an already-resolved prompt is safely rejected ("This prompt is no longer active").

## 0.2.0 (2026-09-05)

- **Synced dual-surface prompts** — guardrails (`pathAccess`, `permissionGate`) and `ask_user_question` prompts now appear on the laptop terminal AND in Telegram at the same time, whenever Telegram is connected. Answer on either surface; the other side is retired automatically (the terminal prompt completes with the Telegram answer, or the Telegram buttons are removed and annotated "Answered in terminal"). This also covers prompts during turns pi starts itself — e.g. continuations after async subagent runs complete — which previously rendered only on the terminal.
- **Robust prompt correlation** — replaced the deprecated `guardrails:action:prompted` listener and its stale single-slot capture with `guardrails:prompt:opened`/`guardrails:prompt:closed` tracking, so prompts answered elsewhere can never leak into a later Telegram rendering.
- **`/stop` ends prompts on all surfaces** — cancelling from Telegram now resolves every pending prompt in the chat (dual-surface or Telegram-side) as deny/cancelled, including the terminal prompt.
- **Session context on prompts** — dual prompts include the project directory name so multi-session chats are unambiguous.
- **Host-mode preservation** — the hybrid default UI context keeps the host's extension mode (`ctx.mode === "tui"` in interactive sessions), so mode-gated extensions keep working.

## 0.1.1 (2026-08-25)

- **Fix `/thinking` conflict** — removed the plugin's TUI registration of `/thinking`, which now collides with pi's built-in interactive command and produced a startup warning. `/thinking` still works in Telegram via the plugin's own command routing.
- **Add `/tg-status`** — Telegram status tool and `/tg-status` command.
- **Housekeeping** — updated Model type parameters and `.gitignore`.

## 0.1.0 (2025-07-09)

- **Rich Message API** — migrated from custom HTML rendering to Telegram's native `sendRichText`/`editRichText` markdown support
- **Custom UI routing** — added `custom()` handler in Telegram UI runtime for external extension UIs (`@juicesharp/rpiv-ask-user-question`, `@aliou/pi-guardrails`)
- **Error propagation** — controller-level error handling with user-facing error messages
- **Render consolidation** — unified inline event rendering with configurable tool/thinking visibility levels
- **Config cleanup** — removed redundant config reload on initial load
- **Markdown improvements** — table alignment fixes, paragraph break preservation, proper table separator rendering
- **TUI status** — configurable footer verbosity level (hidden/minimal/brief/full)
- **Per-workspace bot tokens** — `/tg-bind-cwd` and `/tg-unbind-cwd` for multi-project setups