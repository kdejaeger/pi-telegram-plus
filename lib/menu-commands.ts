import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTelegramMyCommands } from "./telegram-api.ts";

/** Commands that should NOT appear in the Telegram bot menu, but remain available in the TUI/terminal. */
const TELEGRAM_EXCLUDED_COMMANDS = new Set([
  "tg-connect",
  "tg-disconnect",
  "tg-setup",
  "tg-config",
]);

const TELEGRAM_MENU_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "commands", description: "Browse available commands, add search term to filter." },
  { command: "scoped-models", description: "Choose a scoped model" },
  { command: "thinking", description: "Change thinking level" },
  { command: "stop", description: "Stop the current agent turn" },
  { command: "model", description: "Choose a model" },

  // 💬 Session management
  { command: "new", description: "Start a new session" },
  { command: "session", description: "Show session statistics" },
  { command: "resume", description: "Resume a previous session" },
  { command: "name", description: "Set or show session name" },
  { command: "compact", description: "Compact session context" },
  { command: "copy", description: "Copy last assistant message" },
  { command: "fork", description: "Fork from a previous message" },
  { command: "clone", description: "Clone at a previous message" },
  { command: "reload", description: "Reload pi resources" },

  // ⚙️ Settings & Telegram management
  { command: "settings", description: "Open settings menu" },
  { command: "tg-config", description: "Configure Telegram message rendering" },

  // ℹ️ Info & diagnostics
  { command: "debug", description: "Show debug information" },
  { command: "cwd", description: "Show current working directory" },
  { command: "tg-list", description: "List Telegram bot bindings" },
];

const toTelegramCommandName = (name: string): string | undefined => {
  // Telegram bot menu commands allow only [A-Za-z0-9_] and max 32 chars.
  const telegramName = name.replace(/-/g, "_").toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(telegramName)) return undefined;
  return telegramName;
};

export function buildTelegramMenuCommands(pi: ExtensionAPI): Array<{ command: string; description: string }> {
  const commands = new Map<string, string>();
  const addCommand = (name: string, description?: string) => {
    const telegramName = toTelegramCommandName(name);
    if (!telegramName || commands.has(telegramName)) return;
    commands.set(telegramName, (description?.trim() || `Run /${telegramName}`).slice(0, 256));
  };

  for (const command of TELEGRAM_MENU_COMMANDS) addCommand(command.command, command.description);
  for (const command of pi.getCommands()) {
    if (!TELEGRAM_EXCLUDED_COMMANDS.has(command.name)) {
      addCommand(command.name, command.description);
    }
  }

  // Telegram accepts at most 100 bot commands. Keep the curated built-in-style
  // commands first, then fill the rest with extension/prompt/skill commands.
  return Array.from(commands, ([command, description]) => ({ command, description })).slice(0, 100);
}

export async function syncTelegramCommands(botToken: string | undefined, pi: ExtensionAPI): Promise<void> {
  if (!botToken) return;
  try {
    await setTelegramMyCommands(botToken, buildTelegramMenuCommands(pi));
  } catch { /* non-critical */ }
}