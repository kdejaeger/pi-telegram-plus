import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { encodeUiCallback } from "./callback-protocol.ts";
import { escapeHtml } from "./html.ts";
import type { CapturedAgentSession, PendingInputResolver, TelegramTransport } from "./types.ts";

const MAX_BUTTON_TEXT = 60;
const PAGE_SIZE = 10;
/**
 * Interactive prompts surfaced in Telegram (guardrails, ask_user_question,
 * confirm/input/inputSecret/editor/select) deliberately have NO timeout:
 * like a terminal prompt, they wait indefinitely until answered, cancelled
 * via /stop, or retired programmatically. Stale button presses on old
 * messages are rejected by flow-id/prompt-message validation in resolveInput
 * — the controller replies "This prompt is no longer active." — so
 * long-lived buttons are harmless.
 */

/** Marker for UI contexts created by this runtime (per-chat telegram contexts and the hybrid context). */
const TELEGRAM_PLUS_UI = Symbol("pi-telegram-plus.ui");

type Pending = { flowId: string; resolve: PendingInputResolver; sensitive: boolean; acceptsText: boolean; promptMessageId?: number };

/** Outcome of a Telegram-side prompt flow. */
type TelegramFlowResult =
  | { status: "answered"; value: unknown; messageId?: number; text?: string }
  | { status: "cancelled"; messageId?: number; text?: string }
  | { status: "gaveup"; messageId?: number; text?: string };

type TelegramFlow = {
  result: Promise<TelegramFlowResult>;
  /** Stop listening on the Telegram side (used when the terminal answers first). */
  giveUp(): void;
};

type ButtonRow = { text: string; value: string }[][];

function truncateLabel(text: string): string { return text.length <= MAX_BUTTON_TEXT ? text : text.slice(0, MAX_BUTTON_TEXT - 1) + "…"; }

export type TelegramUiRuntime = {
  create(chatId: number): ExtensionUIContext & { chatId: number; inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
  resolveInput(chatId: number, value: string | boolean | undefined, replyToMessageId?: number, fromCallback?: boolean): { handled: boolean; promptMessageId?: number };
  isSensitiveInput(chatId: number, replyToMessageId?: number): boolean;
  hasPendingInput(chatId: number): boolean;
  setJuicesharpRpivAskUserQuestionData(data: unknown): void;
  /** Track a `guardrails:prompt:opened` payload for the next custom() call. */
  pushGuardrailsPrompt(data: unknown): void;
  /** Drop an unconsumed prompt after `guardrails:prompt:closed` (never answered through Telegram). */
  closeGuardrailsPrompt(data: unknown): void;
  /** Cancel a pending prompt from the Telegram side (e.g. /stop): resolves as cancelled on both surfaces. */
  cancelPendingInput(chatId: number, replyToMessageId?: number): { handled: boolean; promptMessageId?: number };
  /**
   * Default UI context for terminal-originated turns: terminal-native behavior,
   * with custom() prompts (guardrails, ask-user) mirrored to the active chat.
   * Returns undefined when no usable terminal UI context has been captured.
   */
  createHybridContext(getIsConnected: () => boolean): ExtensionUIContext | undefined;
  dispose(): void;
};

export function createTelegramUiRuntime(deps: {
  getSession: () => CapturedAgentSession | undefined;
  transport: TelegramTransport;
  /** The true TUI UI context (terminal side of dual prompts). Captured by index.ts at session start. */
  getBaseUi?: () => ExtensionUIContext | undefined;
  /** Active chat for the hybrid context (terminal-originated turns). */
  getActiveChatId?: () => number | undefined;
  /** Optional cwd basename shown on dual prompts so multi-session chats are unambiguous. */
  getCwdLabel?: () => string | undefined;
  onPendingInputChange?: (chatId: number) => void;
}): TelegramUiRuntime {
  const pendingByChat = new Map<number, Map<string, Pending>>();
  // Per-flow replace targets prevent rapid callbacks from overwriting each other.
  const replaceNextMessageByFlow = new Map<string, number>();
  const latestTextFlow = new Map<number, string>();
  const latestFlow = new Map<number, string>();
  let nextFlowId = 1;

  const flows = (chatId: number) => {
    let map = pendingByChat.get(chatId);
    if (!map) { map = new Map(); pendingByChat.set(chatId, map); }
    return map;
  };
  const clearFlow = (chatId: number, flowId: string) => {
    const map = pendingByChat.get(chatId); const pending = map?.get(flowId);
    map?.delete(flowId);
    if (latestTextFlow.get(chatId) === flowId) latestTextFlow.delete(chatId);
    if (latestFlow.get(chatId) === flowId) latestFlow.delete(chatId);
    if (map && map.size === 0) pendingByChat.delete(chatId);
    if (pending) deps.onPendingInputChange?.(chatId);
  };
  const beginFlow = () => String(nextFlowId++);
  const waitInput = (chatId: number, flowId: string, sensitive = false, acceptsText = true, promptMessageId?: number) =>
    new Promise<string | boolean | undefined>((resolve) => {
      flows(chatId).set(flowId, { flowId, resolve, sensitive, acceptsText, promptMessageId });
      latestFlow.set(chatId, flowId);
      if (acceptsText) latestTextFlow.set(chatId, flowId);
      deps.onPendingInputChange?.(chatId);
    });
  const cb = (flowId: string, value: string) => encodeUiCallback(`f:${flowId}:${value}`);
  const getReplaceIdForFlow = (chatId: number, flowId: string | undefined): number | undefined => {
    if (!flowId) return undefined;
    const id = replaceNextMessageByFlow.get(flowId);
    if (id !== undefined) replaceNextMessageByFlow.delete(flowId);
    return id;
  };
  const sendOrReplaceText = async (chatId: number, text: string, flowId?: string) => {
    const replaceId = getReplaceIdForFlow(chatId, flowId);
    if (replaceId !== undefined) {
      try {
        await deps.transport.editText(chatId, replaceId, text);
        return { message_id: replaceId };
      } catch {
        // edit failed (message deleted?) — fall back to sending fresh
        const [sent] = await deps.transport.sendText(chatId, text);
        return sent;
      }
    }
    const [sent] = await deps.transport.sendText(chatId, text);
    return sent;
  };
  const sendOrReplaceButtons = async (chatId: number, text: string, rows: ButtonRow, flowId?: string) => {
    const replaceId = getReplaceIdForFlow(chatId, flowId);
    if (replaceId !== undefined) {
      await deps.transport.editButtons(chatId, replaceId, text, rows);
      return { message_id: replaceId };
    }
    return deps.transport.sendButtons(chatId, text, rows);
  };

  /** Track the currently active flow for each chat (for sendOrReplace lookups). */
  const activeFlowByChat = new Map<number, string>();

  /**
   * Captured ask_user_question payload, consumed by custom().
   * Relies on @juicesharp/rpiv-ask-user-question emitting "rpiv:ask-user:prompt"
   * BEFORE calling ctx.ui.custom(). Event fires synchronously in same execution;
   * channel name and payload are immutable/append-only per their contract.
   * Payload: { questions: [{ question, header, multiSelect, options: [{label, description, hasPreview}] }] }
   */
  let pendingJuicesharpRpivAskUserQuestionData: unknown = null;

  /**
   * Open @aliou/pi-guardrails prompts, keyed by prompt id (from guardrails:prompt:opened).
   * guardrails:prompt:closed removes unconsumed entries, so a prompt answered without
   * Telegram can never leak into a later custom() call. custom() consumes the payload
   * it can render (pathAccess / permissionGate) and leaves unknown features for their
   * closed event to clean up.
   */
  const openGuardrailsPrompts = new Map<string, unknown>();
  /** Flows aborted via cancelPendingInput ("/stop") resolve as "cancelled" instead of "gaveup". */
  const userCancelByFlow = new Set<string>();

  const takeGuardrailsPrompt = (): any => {
    for (const [id, data] of [...openGuardrailsPrompts.entries()].reverse()) {
      const feature = (data as any)?.feature;
      if (feature === "pathAccess" || feature === "permissionGate") {
        openGuardrailsPrompts.delete(id);
        return data;
      }
    }
    return undefined;
  };

  /** Consume the captured ask_user_question payload, if it has questions. */
  const takeAskUserPayload = (): any => {
    const data = pendingJuicesharpRpivAskUserQuestionData as any;
    pendingJuicesharpRpivAskUserQuestionData = null;
    return data?.questions?.length ? data : undefined;
  };

  const cwdSuffix = () => {
    const label = deps.getCwdLabel?.();
    return label ? `\n<i>project: ${escapeHtml(label)}</i>` : "";
  };

  const guardrailsHeaderText = (data: any): string => {
    if (data.feature === "pathAccess") {
      const path = data.action?.path || "";
      const toolName = data.context?.toolName || data.action?.origin || "";
      const command = data.context?.input?.command || "";
      const specificDesc = command && toolName === "bash" ? `\`bash\` → \`${escapeHtml(command)}\``
        : `\`${escapeHtml(toolName)}\``;
      return `📁 <b>Outside Workspace Access</b>\n${specificDesc} targets a path outside the working directory.\n\n<code>${escapeHtml(path)}</code>\n\n${escapeHtml(data.reason || "")}`;
    }
    const cmd = data.action?.command || "";
    return `⚠️ <b>Dangerous Command</b>\n<code>${escapeHtml(cmd.substring(0, 200))}</code>\n\n${escapeHtml(data.reason || "")}`;
  };

  const guardrailsButtonRows = (data: any, flowId: string): ButtonRow => {
    const rows: ButtonRow = [];
    const btn = (l: string, v: string) => rows.push([{ text: truncateLabel(l), value: cb(flowId, v) }]);
    if (data.feature === "pathAccess") {
      const toolName = data.context?.toolName || data.action?.origin || "";
      const isDirTool = toolName === "ls" || toolName === "find";
      if (isDirTool) {
        btn("Allow once", "allow-dir-once");
        btn("Allow directory this session", "allow-dir-session");
        btn("Allow directory always", "allow-dir-always");
      } else {
        btn("Allow once", "allow-file-once");
        btn("Allow file this session", "allow-file-session");
        btn("Allow file always", "allow-file-always");
        btn("Allow directory this session", "allow-dir-session");
        btn("Allow directory always", "allow-dir-always");
      }
      btn("🚫 Deny", "deny");
    } else {
      btn("✅ Allow once", "allow");
      btn("🔄 Allow for session", "allow-session");
      btn("🚫 Deny", "deny");
    }
    return rows;
  };

  /** Resolve the pending waitInput of a flow from the outside (used by giveUp and /stop). */
  const abandonFlow = (chatId: number, flowId: string) => {
    const pending = flows(chatId).get(flowId);
    if (!pending) return;
    clearFlow(chatId, flowId);
    pending.resolve(undefined);
  };

  /** Telegram side of a guardrails prompt (pathAccess / permissionGate). */
  const runGuardrailsTelegramFlow = (chatId: number, data: any): TelegramFlow => {
    let gaveUp = false;
    let currentFlowId: string | undefined;
    let currentMessageId: number | undefined;
    const result = (async (): Promise<TelegramFlowResult> => {
      try {
        const flowId = beginFlow();
        currentFlowId = flowId;
        activeFlowByChat.set(chatId, flowId);
        const text = `${guardrailsHeaderText(data)}${cwdSuffix()}`;
        const rows = guardrailsButtonRows(data, flowId);
        const sent = await deps.transport.sendButtons(chatId, text, rows);
        currentMessageId = sent.message_id;
        if (gaveUp) {
          activeFlowByChat.delete(chatId);
          return { status: "gaveup", messageId: sent.message_id, text };
        }
        const val = await waitInput(chatId, flowId, false, false, sent.message_id);
        activeFlowByChat.delete(chatId);
        void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
        if (val === undefined) {
          return userCancelByFlow.delete(flowId)
            ? { status: "cancelled", messageId: sent.message_id, text }
            : { status: "gaveup", messageId: sent.message_id, text };
        }
        return { status: "answered", value: val === "cancel" ? "deny" : String(val), messageId: sent.message_id, text };
      } catch {
        return { status: "gaveup", messageId: currentMessageId };
      }
    })();
    return {
      result,
      giveUp() {
        gaveUp = true;
        if (currentFlowId !== undefined) abandonFlow(chatId, currentFlowId);
      },
    };
  };

  /** Telegram side of the ask_user_question questionnaire. */
  const runAskUserTelegramFlow = (chatId: number, data: any): TelegramFlow => {
    let gaveUp = false;
    let currentFlowId: string | undefined;
    const result = (async (): Promise<TelegramFlowResult> => {
      let lastSentMessageId: number | undefined;
      try {
        const answers: any[] = [];
        for (let i = 0; i < data.questions.length; i++) {
          if (gaveUp) return { status: "gaveup", messageId: lastSentMessageId };
          const q = data.questions[i];
          const multi = q.multiSelect;
          const sel = new Set<number>();
          let done = false;
          while (!done) {
            if (gaveUp) return { status: "gaveup", messageId: lastSentMessageId };
            const flowId = beginFlow();
            currentFlowId = flowId;
            activeFlowByChat.set(chatId, flowId);
            const rows: ButtonRow = [];
            const btn = (l: string, v: string) => rows.push([{ text: truncateLabel(l), value: cb(flowId, v) }]);
            if (multi) {
              for (let oi = 0; oi < q.options.length; oi++) btn(`${sel.has(oi) ? "✅" : "⬜"} ${q.options[oi].label}`, `t:${oi}`);
              btn("✅ Done", "done");
            } else {
              for (let oi = 0; oi < q.options.length; oi++) btn(q.options[oi].label, `o:${oi}`);
              btn("✏️ Type something...", "other");
            }
            btn("💬 Chat about this", "chat");
            const selText = multi && sel.size ? `\n<i>Selected: ${[...sel].map(i => escapeHtml(q.options[i].label)).join(", ")}</i>` : "";
            const sent = await deps.transport.sendButtons(chatId, `<b>${escapeHtml(q.question)}</b>${selText}${cwdSuffix()}`, rows);
            lastSentMessageId = sent.message_id;
            if (gaveUp) { void deps.transport.removeInlineKeyboard(chatId, sent.message_id); return { status: "gaveup", messageId: sent.message_id }; }
            const val = await waitInput(chatId, flowId, false, !multi, sent.message_id);
            activeFlowByChat.delete(chatId);
            if (val === undefined) {
              void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
              return userCancelByFlow.delete(flowId)
                ? { status: "cancelled", messageId: sent.message_id }
                : { status: "gaveup", messageId: sent.message_id };
            }
            if (val === "chat") { void deps.transport.removeInlineKeyboard(chatId, sent.message_id); return { status: "answered", value: { answers, cancelled: true }, messageId: sent.message_id }; }
            if (multi && typeof val === "string") {
              if (val.startsWith("t:")) { const oi = parseInt(val.slice(2), 10); if (!isNaN(oi)) { if (sel.has(oi)) sel.delete(oi); else sel.add(oi); } }
              else if (val === "done") { void deps.transport.removeInlineKeyboard(chatId, sent.message_id); done = true; answers.push({ questionIndex: i, question: q.question, kind: "multi", answer: null, selected: [...sel].map(i => q.options[i].label) }); }
            } else if (!multi) {
              if (typeof val === "string" && val.startsWith("o:")) {
                const oi = parseInt(val.slice(2), 10);
                if (!isNaN(oi) && oi < q.options.length) { void deps.transport.removeInlineKeyboard(chatId, sent.message_id); answers.push({ questionIndex: i, question: q.question, kind: "option", answer: q.options[oi].label }); done = true; }
              } else if (val === "other") {
                const tf = beginFlow();
                currentFlowId = tf;
                activeFlowByChat.set(chatId, tf);
                const p = await deps.transport.sendButtons(chatId, `<b>${escapeHtml(q.question)}</b>\n\nType your answer:`, [[{ text: "Cancel", value: cb(tf, "cancel") }]]);
                if (gaveUp) { void deps.transport.removeInlineKeyboard(chatId, p.message_id); return { status: "gaveup", messageId: sent.message_id }; }
                const tv = await waitInput(chatId, tf, false, true, p.message_id);
                activeFlowByChat.delete(chatId);
                if (tv === undefined) {
                  void deps.transport.removeInlineKeyboard(chatId, p.message_id);
                  if (gaveUp || userCancelByFlow.delete(tf)) return { status: gaveUp ? "gaveup" : "cancelled", messageId: sent.message_id };
                  continue;
                }
                void deps.transport.removeInlineKeyboard(chatId, p.message_id);
                void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
                answers.push({ questionIndex: i, question: q.question, kind: "custom", answer: String(tv) });
                done = true;
              } else if (typeof val === "string") {
                void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
                answers.push({ questionIndex: i, question: q.question, kind: "custom", answer: val });
                done = true;
              }
            }
          }
        }
        if (lastSentMessageId !== undefined) void deps.transport.removeInlineKeyboard(chatId, lastSentMessageId);
        return { status: "answered", value: { answers, cancelled: false }, messageId: lastSentMessageId };
      } catch {
        return { status: "gaveup", messageId: lastSentMessageId };
      }
    })();
    return {
      result,
      giveUp() {
        gaveUp = true;
        if (currentFlowId !== undefined) abandonFlow(chatId, currentFlowId);
      },
    };
  };

  /** Legacy single-surface behavior (no terminal UI available): render in Telegram only. */
  const telegramOnlyCustom = async <T>(chatId: number): Promise<T> => {
    // 1. ask_user_question questionnaire
    const askUserData = takeAskUserPayload();
    if (askUserData) {
      const r = await runAskUserTelegramFlow(chatId, askUserData).result;
      return (r.status === "answered" ? r.value : { answers: [], cancelled: true }) as T;
    }

    // 2. guardrails prompts (path-access, permission-gate)
    const guardrailsData = takeGuardrailsPrompt();
    if (guardrailsData) {
      const r = await runGuardrailsTelegramFlow(chatId, guardrailsData).result;
      return (r.status === "answered" ? r.value : "deny") as T;
    }

    // 3. fallback – unknown custom() call
    await deps.transport.sendText(chatId, "📋 The agent needs input — please respond in the terminal.");
    return undefined as T;
  };

  /** The terminal side for dual prompts: the true TUI context, never one of our own contexts. */
  const terminalSideBase = (): ExtensionUIContext | undefined => {
    const base = deps.getBaseUi?.();
    return base && typeof (base as any).custom === "function" && !(base as any)[TELEGRAM_PLUS_UI] ? base : undefined;
  };

  /**
   * Dual-surface custom(): renders the prompt component on the terminal (via the true
   * TUI context, capturing its done callback) AND the matching buttons in Telegram,
   * then races the two answers. Whichever surface answers first completes the other.
   */
  const dualCustom = async <T>(chatId: number, factory: any, options: any): Promise<T> => {
    const base = terminalSideBase();
    if (!base) {
      return telegramOnlyCustom<T>(chatId);
    }

    const guardrailsData = takeGuardrailsPrompt();
    const askUserData = takeAskUserPayload();

    if (!guardrailsData && !askUserData) {
      // Unknown custom() caller — no payload metadata to render buttons from.
      void deps.transport.sendText(chatId, "📋 The agent needs input — please respond in the terminal.").catch(() => undefined);
      return (base.custom as any)(factory, options) as Promise<T>;
    }

    let terminalDone: ((value: unknown) => void) | undefined;
    let factoryInvoked = false;
    const wrappedFactory = (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => {
      factoryInvoked = true;
      terminalDone = done;
      return factory(tui, theme, kb, done);
    };
    /** Complete the terminal prompt programmatically (its component may already be gone). */
    const completeTerminal = (value: unknown) => {
      try { terminalDone?.(value); } catch { /* terminal component may already be gone */ }
    };

    const terminalPromise: Promise<unknown> = (base.custom as any)(wrappedFactory, options);
    // No timer: whichever side resolves first retires the other. A terminal
    // answer or error retires Telegram via giveUp(); a Telegram /stop resolves
    // the flow itself ("cancelled") and completes the terminal prompt instead.
    const flow = guardrailsData ? runGuardrailsTelegramFlow(chatId, guardrailsData) : runAskUserTelegramFlow(chatId, askUserData);

    let outcome: { source: "terminal"; value: unknown } | { source: "telegram"; r: TelegramFlowResult };
    try {
      outcome = await Promise.race([
        terminalPromise.then((value) => ({ source: "terminal" as const, value })),
        flow.result.then((r) => ({ source: "telegram" as const, r })),
      ]);
    } catch (error) {
      // Terminal-side failure: retire the Telegram side instead of leaving
      // stale buttons and a pending flow behind, then surface the error.
      flow.giveUp();
      const r = await flow.result.catch(() => undefined);
      if (r?.messageId !== undefined) await deps.transport.removeInlineKeyboard(chatId, r.messageId).catch(() => undefined);
      throw error;
    }

    if (outcome.source === "telegram") {
      const r = outcome.r;
      if (r.status === "answered") {
        // Telegram answered first: complete the terminal prompt with the same value.
        completeTerminal(r.value);
      } else if (r.status === "cancelled") {
        // /stop → end both surfaces with the payload's deny value.
        completeTerminal(guardrailsData ? "deny" : { answers: [], cancelled: true });
      }
      // "gaveup" (giveUp from the other surface, transport error, or dispose):
      // the terminal prompt remains authoritative.
      return (await terminalPromise) as T;
    }

    if (!factoryInvoked) {
      // Hosts without a real custom() implementation (RPC/print stubs) resolve
      // without invoking the factory — the Telegram side is the only surface,
      // with telegramOnlyCustom semantics.
      const r = await flow.result;
      if (r.status === "answered") return r.value as T;
      return (guardrailsData ? "deny" : { answers: [], cancelled: true }) as T;
    }

    // Terminal answered first: retire the Telegram side and annotate the message.
    flow.giveUp();
    const r = await flow.result;
    if (r.messageId !== undefined && r.status === "gaveup") {
      await deps.transport.removeInlineKeyboard(chatId, r.messageId).catch(() => undefined);
      const annotation = r.text !== undefined ? `${r.text}\n\n✅ <i>Answered in terminal</i>` : "✅ <i>Answered in terminal</i>";
      await deps.transport.editText(chatId, r.messageId, annotation).catch(() => undefined);
    }
    return outcome.value as T;
  };

  return {
    setJuicesharpRpivAskUserQuestionData(data: unknown) { pendingJuicesharpRpivAskUserQuestionData = data; },
    pushGuardrailsPrompt(data: unknown) {
      const id = (data as any)?.prompt?.id;
      if (typeof id === "string") openGuardrailsPrompts.set(id, data);
    },
    closeGuardrailsPrompt(data: unknown) {
      const id = (data as any)?.prompt?.id;
      if (typeof id === "string") openGuardrailsPrompts.delete(id);
    },
    cancelPendingInput(chatId, replyToMessageId) {
      const map = pendingByChat.get(chatId);
      const entries = map ? [...map.values()] : [];
      if (entries.length === 0) return { handled: false };
      if (replyToMessageId !== undefined) {
        const entry = entries.find((p) => p.promptMessageId === replyToMessageId);
        if (!entry) return { handled: false };
        userCancelByFlow.add(entry.flowId);
        abandonFlow(chatId, entry.flowId);
        return { handled: true, promptMessageId: entry.promptMessageId };
      }
      // Bare /stop: cancel EVERY pending flow in the chat — a dual prompt and a
      // Telegram-turn flow can coexist, and leaving one pending would strand a
      // surface. Each flow cleans up its own keyboard on resolution.
      const latest = latestFlow.get(chatId);
      const primary = entries.find((p) => p.flowId === latest) ?? entries[0];
      for (const entry of entries) {
        userCancelByFlow.add(entry.flowId);
        abandonFlow(chatId, entry.flowId);
      }
      return { handled: true, promptMessageId: primary.promptMessageId };
    },
    createHybridContext(getIsConnected: () => boolean): ExtensionUIContext | undefined {
      const base = terminalSideBase();
      if (!base) return undefined;
      const hybrid: any = { ...base, [TELEGRAM_PLUS_UI]: true };
      hybrid.custom = async (factory: any, options: any) => {
        const chatId = deps.getActiveChatId?.();
        if (!getIsConnected() || chatId === undefined) {
          // Terminal-only: consume the captured ask-user payload so it cannot
          // leak into a later connected custom() (that slot has no closed-event
          // cleanup; the guardrails queue does).
          takeAskUserPayload();
          return (base.custom as any)(factory, options);
        }
        return dualCustom(chatId, factory, options);
      };
      return hybrid as ExtensionUIContext;
    },
    create(chatId) {
      const base = deps.getSession()?.extensionRunner.getUIContext?.();
      return {
        ...(base as ExtensionUIContext),
        [TELEGRAM_PLUS_UI]: true as const,
        chatId,
        notify: (message, level = "info") => {
          const flowId = activeFlowByChat.get(chatId);
          const text = `<b>${escapeHtml(String(level))}</b>\n${escapeHtml(message)}`;
          if (flowId !== undefined && pendingByChat.get(chatId)?.has(flowId)) {
            // The active flow's message carries live inline buttons; editing it
            // would strip them and leave the prompt unanswerable — send separately.
            void deps.transport.sendText(chatId, text);
            return;
          }
          void sendOrReplaceText(chatId, text, flowId);
        },
        confirm: async (title, message) => {
          const flowId = beginFlow();
          activeFlowByChat.set(chatId, flowId);
          const sent = await sendOrReplaceButtons(chatId, `<b>${escapeHtml(title)}</b>\n${escapeHtml(message)}`, [[
            { text: "Yes", value: cb(flowId, "yes") }, { text: "No", value: cb(flowId, "no") }, { text: "Cancel", value: cb(flowId, "cancel") },
          ]], flowId);
          const value = await waitInput(chatId, flowId, false, false, sent.message_id);
          activeFlowByChat.delete(chatId);
          void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
          return value === true || value === "yes";
        },
        input: async (title, placeholder) => {
          const flowId = beginFlow();
          activeFlowByChat.set(chatId, flowId);
          const sent = await sendOrReplaceButtons(chatId, `<b>${escapeHtml(title)}</b>${placeholder ? `\n${escapeHtml(placeholder)}` : ""}`, [[{ text: "Cancel", value: cb(flowId, "cancel") }]], flowId);
          const value = await waitInput(chatId, flowId, false, true, sent.message_id);
          activeFlowByChat.delete(chatId);
          void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
          return typeof value === "string" ? value : undefined;
        },
        inputSecret: async (title: string, placeholder?: string) => {
          const flowId = beginFlow();
          activeFlowByChat.set(chatId, flowId);
          const sent = await sendOrReplaceButtons(chatId, `<b>${escapeHtml(title)}</b>${placeholder ? `\n${escapeHtml(placeholder)}` : ""}`, [[{ text: "Cancel", value: cb(flowId, "cancel") }]], flowId);
          const value = await waitInput(chatId, flowId, true, true, sent.message_id);
          activeFlowByChat.delete(chatId);
          void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
          return typeof value === "string" ? value : undefined;
        },
        editor: async (title, prefill) => {
          const flowId = beginFlow();
          activeFlowByChat.set(chatId, flowId);
          const sent = await sendOrReplaceButtons(chatId, `<b>${escapeHtml(title)}</b>${prefill ? `\n${escapeHtml(prefill)}` : ""}`, [[{ text: "Cancel", value: cb(flowId, "cancel") }]], flowId);
          const value = await waitInput(chatId, flowId, false, true, sent.message_id);
          activeFlowByChat.delete(chatId);
          void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
          return typeof value === "string" ? value : undefined;
        },
        select: async (title, options) => {
          if (options.length === 0) return undefined;
          let page = 0; const pageCount = Math.ceil(options.length / PAGE_SIZE); const flowId = beginFlow();
          activeFlowByChat.set(chatId, flowId);
          while (true) {
            const start = page * PAGE_SIZE; const pageOptions = options.slice(start, start + PAGE_SIZE);
            const rows = pageOptions.map((label, i) => [{ text: truncateLabel(label), value: cb(flowId, `s:${start + i}`) }]);
            const nav = [];
            if (page > 0) nav.push({ text: "◀ Prev", value: cb(flowId, `p:${page - 1}`) });
            if (page < pageCount - 1) nav.push({ text: "Next ▶", value: cb(flowId, `p:${page + 1}`) });
            nav.push({ text: "Cancel", value: cb(flowId, "cancel") }); rows.push(nav);
            const suffix = pageCount > 1 ? ` (${page + 1}/${pageCount})` : "";
            const sent = await sendOrReplaceButtons(chatId, `<b>${escapeHtml(title + suffix)}</b>`, rows, flowId);
            const value = await waitInput(chatId, flowId, false, false, sent.message_id);
            if (typeof value !== "string") { activeFlowByChat.delete(chatId); void deps.transport.removeInlineKeyboard(chatId, sent.message_id); return undefined; }
            if (value === "cancel") { activeFlowByChat.delete(chatId); void deps.transport.removeInlineKeyboard(chatId, sent.message_id); return undefined; }
            if (value.startsWith("p:")) { const next = parseInt(value.slice(2), 10); if (next >= 0 && next < pageCount) page = next; continue; }
            if (value.startsWith("s:")) { const idx = parseInt(value.slice(2), 10); activeFlowByChat.delete(chatId); void deps.transport.removeInlineKeyboard(chatId, sent.message_id); return idx >= 0 && idx < options.length ? options[idx] : undefined; }
            if (options.includes(value)) { activeFlowByChat.delete(chatId); void deps.transport.removeInlineKeyboard(chatId, sent.message_id); return value; }
            activeFlowByChat.delete(chatId);
            void deps.transport.removeInlineKeyboard(chatId, sent.message_id);
            return undefined;
          }
        },
        custom: async <T>(factory: any, options?: any): Promise<T> => {
          if (terminalSideBase()) return dualCustom<T>(chatId, factory, options);
          return telegramOnlyCustom<T>(chatId);
        },
      } as ExtensionUIContext & { chatId: number; inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined> };
    },
    resolveInput(chatId, raw, replyToMessageId, fromCallback = false) {
      let flowId: string | undefined; let value = raw;
      if (fromCallback && typeof raw === "string" && raw.startsWith("f:")) {
        const [, id, ...rest] = raw.split(":"); flowId = id; const inner = rest.join(":");
        value = inner === "yes" ? true : inner === "no" ? false : inner === "cancel" ? undefined : inner;
      } else {
        const map = pendingByChat.get(chatId);
        const isCancel = raw === undefined;
        if (replyToMessageId) {
          flowId = map ? [...map.values()].find((p) =>
            p.promptMessageId === replyToMessageId && (isCancel || p.acceptsText)
          )?.flowId : undefined;
          if (!flowId) return { handled: false };
        } else {
          flowId = isCancel ? latestFlow.get(chatId) : latestTextFlow.get(chatId);
        }
      }
      if (!flowId) return { handled: false };
      const pending = pendingByChat.get(chatId)?.get(flowId); if (!pending) return { handled: false };
      if (fromCallback) {
        if (replyToMessageId !== pending.promptMessageId) return { handled: false };
      } else if (raw !== undefined && !pending.acceptsText) return { handled: false };
      clearFlow(chatId, flowId);
      // Store the per-flow replace target after clearing, so subsequent sendOrReplace* calls
      // (e.g. pagination, notify) can edit the message instead of sending a new one.
      if (fromCallback && replyToMessageId !== undefined) replaceNextMessageByFlow.set(flowId, replyToMessageId);
      pending.resolve(value); return { handled: true, promptMessageId: pending.promptMessageId };
    },
    isSensitiveInput(chatId, replyToMessageId) {
      const map = pendingByChat.get(chatId); if (!map) return false;
      if (replyToMessageId) {
        const exact = [...map.values()].find((p) => p.acceptsText && p.promptMessageId === replyToMessageId);
        return exact?.sensitive === true;
      }
      const latest = latestTextFlow.get(chatId);
      return latest ? map.get(latest)?.sensitive === true : false;
    },
    hasPendingInput(chatId) {
      return (pendingByChat.get(chatId)?.size ?? 0) > 0;
    },
    dispose() {
      for (const map of pendingByChat.values()) {
        for (const pending of map.values()) {
          pending.resolve(undefined);
        }
      }
      pendingByChat.clear();
      replaceNextMessageByFlow.clear();
      latestTextFlow.clear();
      latestFlow.clear();
      activeFlowByChat.clear();
      openGuardrailsPrompts.clear();
      userCancelByFlow.clear();
    },
  };
}
