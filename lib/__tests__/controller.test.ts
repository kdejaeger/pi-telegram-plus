import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { encodeUiCallback } from "../callback-protocol.ts";
import { createTelegramUiRuntime } from "../telegram-ui.ts";
import { parseLeadingCommand, normalizeLeadingCommand } from "../command-parser.ts";
import { createTelegramController } from "../controller.ts";

// ── Shared harness ──────────────────────────────────────────────────────────────

const baseSession = (overrides: Record<string, unknown> = {}) =>
  ({
    prompt: async () => undefined,
    isStreaming: false,
    extensionRunner: {
      getUIContext: () => undefined,
      setUIContext: () => undefined,
      getCommand: () => undefined,
      createCommandContext: () => ({} as any),
    },
    ...overrides,
  }) as any;

const baseTransport = () => ({
  removeInlineKeyboard: async () => undefined,
  sendText: async () => [{ message_id: 1 }],
  sendRichText: async () => [{ message_id: 1 }],
  editRichText: async () => undefined,
  sendButtons: async () => ({ message_id: 1 }),
  editText: async () => undefined,
  editButtons: async () => undefined,
  answerCallbackQuery: async () => undefined,
  deleteMessage: async () => undefined,
  sendDocument: async () => undefined,
  sendPhoto: async () => undefined,
  sendChatAction: async () => undefined,
});

const baseUi = () => ({
  create: () => ({ notify: async () => undefined }) as any,
  resolveInput: () => ({ handled: false }),
  isSensitiveInput: () => false,
  hasPendingInput: () => false,
  setJuicesharpRpivAskUserQuestionData: () => {},
  pushGuardrailsPrompt: () => {},
  closeGuardrailsPrompt: () => {},
  cancelPendingInput: () => ({ handled: false }),
  createHybridContext: () => ({}) as any,
  dispose: async () => undefined,
});

function buildController(overrides: Record<string, unknown> = {}) {
  return createTelegramController({
    getSession: () => overrides.session,
    transport: baseTransport(),
    ui: baseUi(),
    authorizeUser: async () => true,
    setActiveChatId: async () => undefined,
    getBotUsername: () => "test-bot",
    getMessageMode: () => "queue",
    telegramCommands: new Map(),
    getActiveTurn: () => undefined,
    beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({ chatId, queuedAttachments: [], replaceMessageId }),
    endTelegramTurn: () => undefined,
    ...overrides,
  } as any);
}

describe("parseLeadingCommand", () => {
  it("parses simple slash command", () => {
    expect(parseLeadingCommand("/help")).toEqual({ name: "help", args: "" });
  });

  it("parses command with args", () => {
    expect(parseLeadingCommand("/model sonnet")).toEqual({ name: "model", args: "sonnet" });
  });

  it("parses command with multi-word args", () => {
    expect(parseLeadingCommand("/tg-config tool full")).toEqual({ name: "tg-config", args: "tool full" });
  });

  it("handles @botUsername via normalizeLeadingCommand, not parseLeadingCommand", () => {
    // parseLeadingCommand uses [^\s@]+ so @ is excluded from name
    expect(parseLeadingCommand("/help@mybot")).toBeUndefined();
  });

  it("returns undefined for non-slash text", () => {
    expect(parseLeadingCommand("hello")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseLeadingCommand("")).toBeUndefined();
  });

  it("parses command with underscore name", () => {
    expect(parseLeadingCommand("/review_loop")).toEqual({ name: "review_loop", args: "" });
  });

  it("parses command with hyphen name", () => {
    expect(parseLeadingCommand("/tg-config")).toEqual({ name: "tg-config", args: "" });
  });

  it("parses command with remaining text as args", () => {
    expect(parseLeadingCommand("/new this is a test")).toEqual({ name: "new", args: "this is a test" });
  });
});

describe("normalizeLeadingCommand", () => {
  it("strips @botUsername suffix", () => {
    expect(normalizeLeadingCommand("/help@mybot", "mybot")).toBe("/help");
  });

  it("strips @botUsername with trailing space", () => {
    expect(normalizeLeadingCommand("/help@mybot args", "mybot")).toBe("/help args");
  });

  it("returns text unchanged without botUsername", () => {
    expect(normalizeLeadingCommand("/help@mybot", undefined)).toBe("/help@mybot");
  });

  it("is case-insensitive for bot username", () => {
    expect(normalizeLeadingCommand("/help@MyBot", "mybot")).toBe("/help");
  });

  it("does not strip non-matching username", () => {
    expect(normalizeLeadingCommand("/help@otherbot", "mybot")).toBe("/help@otherbot");
  });
});

describe("createTelegramController media message behavior", () => {
  it("submits prompt for incoming document-only message", async () => {
    const prompts: string[] = [];
    const session = baseSession({
      prompt: async (text: string) => {
        prompts.push(text);
      },
    });
    const controller = buildController({ session });

    await controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      document: {
        file_id: "abc",
        file_name: "photo.png",
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[telegram attachment]");
    expect(prompts[0]).toContain("document: photo.png");
  });

  it("appends attachment summary to captioned message", async () => {
    const prompts: string[] = [];
    const session = baseSession({
      prompt: async (text: string) => {
        prompts.push(text);
      },
    });
    const controller = buildController({ session });

    await controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      caption: "Analyze this image",
      photo: [
        { file_id: "photo-id-1", file_size: 100 },
      ],
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Analyze this image");
    expect(prompts[0]).toContain("photo (1 photo frame(s))");
  });

  it("downloads and records incoming photo attachment path", async () => {
    const prompts: string[] = [];
    const sent: string[] = [];
    const saved: Array<{ fileId: string; fileName?: string; kind: string }> = [];
    const session = baseSession({
      prompt: async (text: string) => {
        prompts.push(text);
      },
    });

    const transportSendText = vi.fn(async () => [{ message_id: 1 }]);

    const controller = buildController({
      session,
      transport: {
        ...baseTransport(),
        sendText: async (_chatId: number, text: string) => {
          sent.push(text);
          return transportSendText();
        },
      },
      saveIncomingTelegramAttachment: async (fileId: string, fileName: string | undefined, kind: string) => {
        saved.push({ fileId, fileName, kind });
        return `/tmp/saved/${fileId}.jpg`;
      },
    });

    await controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      photo: [
        { file_id: "photo-small", file_size: 100 },
        { file_id: "photo-large", file_size: 400 },
      ],
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("photo (2 photo frame(s))");
    expect(prompts[0]).toContain("photo-large");
    expect(prompts[0]).toContain("/tmp/saved/photo-large.jpg");
    expect(saved).toEqual([{ fileId: "photo-large", kind: "photo", fileName: undefined }]);
    expect(transportSendText).toHaveBeenCalledTimes(1);
    expect(sent[0]).toContain("✅ Saved attachments (local paths):");
    expect(sent[0]).toContain("/tmp/saved/photo-large.jpg");
  });

  it("does not block message handling while waiting for prompt completion", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = baseSession({
      prompt: async () => {
        await gate;
      },
    });

    const controller = buildController({ session });

    const result = await Promise.race([
      controller.handleMessage({
        message_id: 1,
        chat: { id: 999 },
        text: "Continue the analysis",
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);

    expect(result).toBe(undefined);
    release();
    await gate;
  });

  it("skips queued follow-up prompts after /stop", async () => {
    let firstResolved = false;
    let firstRelease: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      firstRelease = resolve;
    });

    const prompts: string[] = [];
    const session = baseSession({
      prompt: async (text: string) => {
        prompts.push(text);
        if (text === "A") {
          await firstGate;
          firstResolved = true;
          return;
        }
      },
      abort: vi.fn(() => Promise.resolve()),
    });

    const sendText = vi.fn(async () => [{ message_id: 1 }]);
    const controller = buildController({
      session,
      transport: { ...baseTransport(), sendText },
    });

    await controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      text: "A",
    });
    await controller.handleMessage({
      message_id: 2,
      chat: { id: 999 },
      text: "B",
    });

    const result = await Promise.race([
      controller.handleMessage({
        message_id: 3,
        chat: { id: 999 },
        text: "/stop",
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);
    expect(result).toBeUndefined();

    firstRelease();
    await firstGate;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(prompts).toEqual(["A"]);
    expect(firstResolved).toBe(true);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(999, "⏹️ Interrupt requested.");
  });

  it("does not block message handling while a command handler is waiting", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commandStarted: { value: boolean } = { value: false };
    const commandDone: { value: boolean } = { value: false };

    const session = baseSession();

    const command = new Map<string, (args: string, _ctx: any) => Promise<void>>();
    command.set("new", async () => {
      commandStarted.value = true;
      await gate;
      commandDone.value = true;
    });

    const controller = buildController({ session, telegramCommands: command });

    const result = await Promise.race([
      controller.handleMessage({
        message_id: 1,
        chat: { id: 999 },
        text: "/new",
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);

    expect(result).toBe(undefined);
    expect(commandStarted.value).toBe(true);
    expect(commandDone.value).toBe(false);

    release();
    await gate;
    expect(commandDone.value).toBe(true);
  });

  it("does not block another command while a previous command waits", async () => {
    let releaseSecond: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const firstStarted: { value: boolean } = { value: false };
    const secondStarted: { value: boolean } = { value: false };

    const session = baseSession();

    const command = new Map<string, (args: string, _ctx: any) => Promise<void>>();
    command.set("first", async () => {
      firstStarted.value = true;
      await firstGate;
    });
    command.set("second", async () => {
      secondStarted.value = true;
    });

    const controller = buildController({ session, telegramCommands: command });

    await controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      text: "/first",
    });

    const timeoutRace = await Promise.race([
      controller.handleMessage({
        message_id: 2,
        chat: { id: 999 },
        text: "/second",
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);

    expect(timeoutRace).toBe(undefined);
    expect(firstStarted.value).toBe(true);
    expect(secondStarted.value).toBe(true);

    releaseSecond();
    await firstGate;
  });

  it("does not crash when command handler rejects", async () => {
    const session = baseSession();

    const command = new Map<string, (args: string, _ctx: any) => Promise<void>>();
    command.set("fail", async () => {
      throw new Error("command boom");
    });

    const controller = buildController({ session, telegramCommands: command });

    await expect(controller.handleMessage({
      message_id: 1,
      chat: { id: 999 },
      text: "/fail",
    })).resolves.toBeUndefined();
  });

  it("resolves ui.confirm through callback without blocking", async () => {
    const commandPrompted = { confirmed: false };
    const session = baseSession();

    const sentMessageId = 77;
    const transport = {
      removeInlineKeyboard: vi.fn(async () => undefined),
      sendText: vi.fn(async () => [] as any),
      sendRichText: vi.fn(async () => [] as any),
      editRichText: vi.fn(async () => undefined),
      sendButtons: vi.fn(async () => ({ message_id: sentMessageId } as any)),
      editText: vi.fn(async () => undefined),
      editButtons: vi.fn(async () => undefined),
      answerCallbackQuery: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      sendDocument: vi.fn(async () => undefined),
      sendPhoto: vi.fn(async () => undefined),
      sendChatAction: vi.fn(async () => undefined),
    };

    const uiRuntime = createTelegramUiRuntime({
      getSession: () => session,
      transport,
    });

    const command = new Map<string, (args: string, _ctx: any) => Promise<void>>();
    command.set("ask", async () => {
      const ui = uiRuntime.create(321);
      commandPrompted.confirmed = await ui.confirm("Proceed?", "Are you sure?");
      if (commandPrompted.confirmed) {
        await ui.notify("confirmed");
      }
    });

    const controller = buildController({
      session,
      transport,
      ui: uiRuntime,
      telegramCommands: command,
    });

    const handled = await Promise.race([
      controller.handleMessage({
        message_id: 1,
        chat: { id: 321 },
        text: "/ask",
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);
    expect(handled).toBeUndefined();

    await controller.handleCallbackQuery({
      id: "cb-1",
      message: { chat: { id: 321 }, message_id: sentMessageId },
      data: encodeUiCallback("f:1:yes"),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(commandPrompted.confirmed).toBe(true);
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(transport.removeInlineKeyboard).toHaveBeenCalledWith(321, sentMessageId);
  });
});

describe("runWithTelegramUi runner context swap/restore (Pi 0.85 compat)", () => {
  /**
   * Mimics the Pi 0.85.1 ExtensionRunner semantics the controller relies on:
   * - setUIContext(ui?, mode = "print") stores a WRAPPED copy of ui (object spread)
   *   plus the mode, as plain instance fields (private in TS, public at runtime);
   * - getUIContext() returns that stored context.
   *
   * Wrapping on install is what makes the restore path observable: if the controller
   * restored through setUIContext(previousUi), the stored context would be a fresh
   * wrapper object, not the exact previous instance.
   */
  function createStatefulRunner(tuiUi: ExtensionUIContext) {
    const state = {
      uiContext: tuiUi as ExtensionUIContext | undefined,
      mode: "tui" as string | undefined,
      setCalls: [] as Array<{ ui: unknown; mode: string | undefined }>,
    };
    const runner = {
      setUIContext(ui?: ExtensionUIContext, mode?: string) {
        state.setCalls.push({ ui, mode });
        state.uiContext = ui ? ({ ...ui, __wrapped: true } as ExtensionUIContext) : ({ __noop: true } as unknown as ExtensionUIContext);
        state.mode = mode ?? "print"; // default-parameter semantics of Pi 0.85+
      },
      getUIContext() {
        return state.uiContext as ExtensionUIContext;
      },
      get mode() {
        return state.mode;
      },
      set mode(value: string | undefined) {
        state.mode = value;
      },
      get uiContext() {
        return state.uiContext;
      },
      set uiContext(value: ExtensionUIContext | undefined) {
        state.uiContext = value;
      },
    };
    return { runner, state };
  }

  function buildSwapHarness(session: unknown) {
    let createdUi: any;
    const controller = buildController({
      session,
      ui: {
        ...baseUi(),
        create: () => {
          createdUi = { notify: async () => undefined, chatId: 999 } as any;
          return createdUi;
        },
      },
    });
    return { controller, createdUi: () => createdUi };
  }

  it("installs the Telegram UI with the captured mode and restores the exact previous context directly", async () => {
    const tuiUi = { notify: () => undefined } as any;
    const { runner, state } = createStatefulRunner(tuiUi);
    const { controller, createdUi } = buildSwapHarness(baseSession({ extensionRunner: runner }));

    await controller.handleMessage({ message_id: 1, chat: { id: 999 }, text: "hello" });
    // Queue mode runs the turn in the background (promptTails chain) — let it settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Install: exactly one setUIContext call, with the Telegram UI and the mode captured BEFORE install.
    expect(state.setCalls).toHaveLength(1);
    expect(state.setCalls[0].ui).toBe(createdUi());
    expect(state.setCalls[0].mode).toBe("tui");
    // Restore: the exact previous context object (identity), not a re-wrapped copy.
    expect(state.uiContext).toBe(tuiUi);
    expect(state.mode).toBe("tui");
  });

  it("does not accumulate setUIContext calls across repeated Telegram turns", async () => {
    const tuiUi = { notify: () => undefined } as any;
    const { runner, state } = createStatefulRunner(tuiUi);
    const { controller } = buildSwapHarness(baseSession({ extensionRunner: runner }));

    await controller.handleMessage({ message_id: 1, chat: { id: 999 }, text: "first" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await controller.handleMessage({ message_id: 2, chat: { id: 999 }, text: "second" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.setCalls).toHaveLength(2); // one install per turn, restore never re-wraps
    expect(state.uiContext).toBe(tuiUi);
    expect(state.mode).toBe("tui");
  });

  it("restores context and mode even when the turn throws", async () => {
    const tuiUi = { notify: () => undefined } as any;
    const { runner, state } = createStatefulRunner(tuiUi);
    const session = baseSession({
      extensionRunner: runner,
      prompt: async () => {
        throw new Error("boom");
      },
    });
    const { controller } = buildSwapHarness(session);

    await controller.handleMessage({ message_id: 1, chat: { id: 999 }, text: "boom turn" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.uiContext).toBe(tuiUi);
    expect(state.mode).toBe("tui");
    expect(state.setCalls).toHaveLength(1);
  });
});
