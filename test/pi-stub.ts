/**
 * Drives the real extension factory against Pi's real `SessionManager` on real
 * session files, with a recording stand-in for the `ExtensionAPI`.
 *
 * What is real: session JSONL reads and writes, entry ids and parent links,
 * compaction handling, and every line of this extension's own logic.
 *
 * What is a stand-in: Pi's runtime binding of events to handlers. Pi dispatches
 * `input`, `session_before_compact`, and the rest with the arguments replayed
 * here, and it turns `sendUserMessage("/cmd", { expandPromptTemplates: true })`
 * into a command dispatch. That dispatch rule is read from Pi's published source
 * (`prompt()` returns early after `_tryExecuteExtensionCommand`) rather than
 * executed here.
 */
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import safeResume from "../src/index.ts";

type Handler = (event: never, ctx: never) => unknown;

export interface RecordedSend {
  content: string | unknown[];
  options: unknown;
}

export interface RecordedNotify {
  message: string;
  type?: "info" | "warning" | "error";
}

export interface Recorded {
  selects: { title: string; options: string[] }[];
  confirms: { title: string; message: string }[];
  notifies: RecordedNotify[];
  editorTexts: string[];
  statuses: { key: string; text: string | undefined }[];
}

export interface CtxOptions {
  sessionManager: SessionManager;
  model?: Model<any> | undefined;
  tokens?: number | null;
  percent?: number | null;
  hasUI?: boolean;
  /** What `ui.select` returns. `undefined` is Escape. */
  selectResult?: string | undefined;
  confirmResult?: boolean;
}

export interface StubCtx extends ExtensionContext {
  recorded: Recorded;
}

export function makeCtx(options: CtxOptions): StubCtx {
  const recorded: Recorded = { selects: [], confirms: [], notifies: [], editorTexts: [], statuses: [] };
  const ctx = {
    recorded,
    ui: {
      select: async (title: string, choices: string[]) => {
        recorded.selects.push({ title, options: choices });
        return options.selectResult;
      },
      confirm: async (title: string, message: string) => {
        recorded.confirms.push({ title, message });
        return options.confirmResult ?? false;
      },
      notify: (message: string, type?: "info" | "warning" | "error") => {
        recorded.notifies.push({ message, type });
      },
      setEditorText: (text: string) => {
        recorded.editorTexts.push(text);
      },
      setStatus: (key: string, text: string | undefined) => {
        recorded.statuses.push({ key, text });
      },
    },
    mode: "tui",
    hasUI: options.hasUI ?? true,
    cwd: options.sessionManager.getCwd(),
    sessionManager: options.sessionManager,
    modelRegistry: {},
    model: options.model,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () =>
      options.tokens === undefined && options.percent === undefined
        ? undefined
        : { tokens: options.tokens ?? null, contextWindow: 200_000, percent: options.percent ?? null },
    compact: () => {},
    getSystemPrompt: () => "",
  } as unknown as StubCtx;
  return ctx;
}

export interface CommandCtxOptions extends CtxOptions {
  /** Runs `setup` against a real replacement SessionManager, then `withSession`. */
  newSession: ExtensionCommandContext["newSession"];
}

export interface StubCommandCtx extends ExtensionCommandContext {
  recorded: Recorded;
  sentUserMessages: RecordedSend[];
}

export function makeCommandCtx(options: CommandCtxOptions): StubCommandCtx {
  const base = makeCtx(options);
  const sentUserMessages: RecordedSend[] = [];
  return {
    ...base,
    sentUserMessages,
    getSystemPromptOptions: () => ({}) as never,
    waitForIdle: async () => {},
    newSession: options.newSession,
    fork: async () => ({ cancelled: true }),
    navigateTree: async () => ({ cancelled: true }),
    switchSession: async () => ({ cancelled: true }),
    reload: async () => {},
  } as unknown as StubCommandCtx;
}

export interface StubReplacementCtx {
  recorded: Recorded;
  sentUserMessages: RecordedSend[];
  sendUserMessage: (content: string | unknown[], opts?: unknown) => Promise<void>;
  ui: Record<string, unknown>;
}

export function makeReplacementCtx(cwd: string, sessionManager?: SessionManager): StubReplacementCtx {
  const recorded: Recorded = { selects: [], confirms: [], notifies: [], editorTexts: [], statuses: [] };
  const sentUserMessages: RecordedSend[] = [];
  return {
    recorded,
    sentUserMessages,
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        recorded.notifies.push({ message, type });
      },
      setStatus: (key: string, text: string | undefined) => {
        recorded.statuses.push({ key, text });
      },
      setEditorText: (text: string) => {
        recorded.editorTexts.push(text);
      },
    },
    cwd,
    sendUserMessage: async (content: string | unknown[], opts?: unknown) => {
      sentUserMessages.push({ content, options: opts });
      // Pi appends the sent message to the session, so the stand-in does too.
      if (!sessionManager) return;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      sessionManager.appendMessage({ role: "user", content: blocks, timestamp: Date.now() } as never);
    },
  } as unknown as StubReplacementCtx;
}

export interface ToolLike {
  name: string;
  execute: (toolCallId: string, params: never, signal: never, onUpdate: never, ctx: never) => Promise<unknown>;
}

export class PiStub {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, ToolLike>();
  readonly commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  readonly flags = new Map<string, string | boolean | undefined>();
  readonly appended: { customType: string; data: unknown }[] = [];
  readonly sentUserMessages: RecordedSend[] = [];
  readonly api: ExtensionAPI;

  constructor() {
    const api = {
      on: (event: string, handler: Handler) => {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
        return () => {};
      },
      registerTool: (tool: ToolLike) => {
        this.tools.set(tool.name, tool);
      },
      registerCommand: (name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) => {
        this.commands.set(name, options);
      },
      registerFlag: (name: string, options: { default?: string | boolean }) => {
        this.flags.set(name, options.default);
      },
      registerShortcut: () => {},
      registerMessageRenderer: () => {},
      registerMarkdownTransformer: () => {},
      registerEntryRenderer: () => {},
      getFlag: (name: string) => this.flags.get(name),
      sendMessage: () => {},
      sendUserMessage: (content: string | unknown[], opts?: unknown) => {
        this.sentUserMessages.push({ content, options: opts });
      },
      appendEntry: (customType: string, data?: unknown) => {
        this.appended.push({ customType, data });
      },
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => {},
      registerProvider: () => {},
      unregisterProvider: () => {},
      events: {},
    } as unknown as ExtensionAPI;
    this.api = api;
  }

  load(): void {
    safeResume(this.api);
  }

  /** Replay one event, mirroring Pi's "first handler to return a value wins". */
  async fire(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      const produced = await (handler as unknown as (event: unknown, ctx: unknown) => unknown)(payload, ctx);
      if (produced !== undefined && result === undefined) result = produced;
    }
    return result;
  }

  /** Invoke a registered command the way Pi's command dispatch would. */
  async runCommand(name: string, args: string, ctx: unknown): Promise<void> {
    const command = this.commands.get(name);
    if (!command) throw new Error(`no command registered as ${name}`);
    await (command.handler as unknown as (args: string, ctx: unknown) => Promise<void>)(args, ctx);
  }

  /** Wait for the deferred command dispatch the guard schedules with setTimeout. */
  async settleDispatch(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
