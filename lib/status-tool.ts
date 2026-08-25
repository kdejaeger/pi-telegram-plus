import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TelegramConfig } from "./types.ts";
import type { TelegramPollingRuntime } from "./polling.ts";

export type TelegramStatusToolDeps = {
  getConfig: () => TelegramConfig;
  getPolling: () => TelegramPollingRuntime;
  getLastStatusError: () => string | undefined;
};

export function registerTelegramStatusTool(
  pi: ExtensionAPI,
  deps: TelegramStatusToolDeps,
): void {
  pi.registerTool({
    name: "tg_status",
    label: "Telegram Status",
    description: "Check if Telegram is connected. Connected means the bot token is configured, polling is active, and a user has been paired.",
    promptSnippet: "Check Telegram connection status.",
    parameters: Type.Object({}),
    async execute() {
      const config = deps.getConfig();
      const connected = !!config.botToken && deps.getPolling().isActive() && config.allowedUserId !== undefined;

      return {
        content: [{
          type: "text" as const,
          text: connected
            ? `Telegram: connected (@${config.botUsername ?? "unknown"})`
            : `Telegram: disconnected`,
        }],
        details: {
          connected,
          botToken: !!config.botToken,
          polling: deps.getPolling().isActive(),
          paired: config.allowedUserId !== undefined,
          botUsername: config.botUsername,
          error: deps.getLastStatusError(),
        },
      };
    },
  });
}