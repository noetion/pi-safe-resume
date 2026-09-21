/**
 * Integration coverage for the whole guarded workflow, driven through the real
 * extension factory against Pi's real `SessionManager` on real session files.
 *
 * See `pi-stub.ts` for the exact boundary between what is real here and what is a
 * stand-in for Pi's own runtime binding.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateTextTokens, HANDOFF_TOKEN_BUDGET } from "../src/handoff.ts";
import { RETRIEVAL_RESPONSE_TOKENS } from "../src/history.ts";
import type { CacheTiming, SessionLink } from "../src/types.ts";
import { PiStub, makeCommandCtx, makeCtx, makeReplacementCtx, type StubCtx } from "./pi-stub.ts";
import {
  assistantEntry,
  assistantMessage,
  HOUR,
  NOW,
  stubModel,
  textOfExactTokens,
  userEntry,
  userMessage,
  usage,
  writeSessionFile,
} from "./helpers.ts";

const RESTART_OPTION = "Start a new session with previous context";
const CONTINUE_OPTION = "Continue this session";
const CANCEL_OPTION = "Cancel";
const RESTART_COMMAND = "safe-resume-restart";
const LINK_ENTRY = "safe-resume:link";
const TIMING_ENTRY = "safe-resume:timing";
const RETRIEVAL_ENTRY = "safe-resume:retrieval";

const MODEL = stubModel({ promptCache: { short: 300 } });

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-safe-resume-int-"));
}

/** A persisted session with a large, old, cache-relevant transcript. */
function largeSession(): SessionManager {
  const dir = tempDir();
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  sm.appendMessage(
    userMessage("ORIGINAL-TASK: build the widget. The EARLIER-DETAIL is that the flange is 12mm.") as never,
  );
  sm.appendMessage(assistantMessage("Started on the widget.", usage({ input: 100, cacheWrite: 480_000 })) as never);
  sm.appendMessage(userMessage("keep going") as never);
  sm.appendMessage(assistantMessage("The widget compiles.", usage({ input: 20, cacheRead: 480_000 })) as never);
  return sm;
}

function seedTiming(sm: SessionManager, requestStartedAt: number): void {
  const timing: CacheTiming = {
    requestStartedAt,
    provider: "stub-provider",
    modelId: "stub-model",
    observed: true,
  };
  sm.appendCustomEntry(TIMING_ENTRY, timing);
}

interface Setup {
  harness: PiStub;
  sm: SessionManager;
  ctx: StubCtx;
}

async function setup(options: { selectResult?: string | undefined; tokens?: number | null } = {}): Promise<Setup> {
  const sm = largeSession();
  seedTiming(sm, Date.now() - 2 * HOUR);
  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({
    sessionManager: sm,
    model: MODEL,
    tokens: options.tokens === undefined ? 500_000 : options.tokens,
    percent: 70,
    selectResult: options.selectResult,
  });
  await harness.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
  return { harness, sm, ctx };
}

function inputEvent(text: string, extra: Record<string, unknown> = {}): unknown {
  return { type: "input", text, source: "interactive", ...extra };
}

function compactEvent(reason: "manual" | "threshold" | "overflow"): unknown {
  return {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    reason,
    willRetry: false,
    signal: new AbortController().signal,
  };
}

/** A `newSession` stand-in that runs `setup` and `withSession` against real managers. */
function realNewSession(): {
  newSession: Parameters<typeof makeCommandCtx>[0]["newSession"];
  replacement: ReturnType<typeof makeReplacementCtx>;
  manager: () => SessionManager;
} {
  let replacement: ReturnType<typeof makeReplacementCtx> | undefined;
  let manager: SessionManager | undefined;
  return {
    get replacement() {
      if (!replacement) throw new Error("setup never ran");
      return replacement;
    },
    manager: () => {
      if (!manager) throw new Error("setup never ran");
      return manager;
    },
    newSession: (async (options?: {
      setup?: (sm: SessionManager) => Promise<void>;
      withSession?: (ctx: never) => Promise<void>;
    }) => {
      const dir = tempDir();
      manager = SessionManager.create(dir, join(dir, "sessions"));
      replacement = makeReplacementCtx(dir, manager);
      if (options?.setup) await options.setup(manager);
      if (options?.withSession) await options.withSession(replacement as never);
      return { cancelled: false };
    }) as Parameters<typeof makeCommandCtx>[0]["newSession"],
  };
}

function commandCtxFor(setup0: Setup, newSession: ReturnType<typeof realNewSession>["newSession"]) {
  return makeCommandCtx({
    sessionManager: setup0.sm,
    model: MODEL,
    tokens: 500_000,
    percent: 70,
    newSession,
  });
}

function entryText(entry: SessionEntry): string {
  if (entry.type !== "message") return "";
  const content = (entry.message as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : ""))
    .join("\n");
}

/**
 * The handoff text the replacement session carries. Pi writes a session file only
 * once an assistant message exists, so the buffered entries are the source of
 * truth until the developer's first turn completes.
 */
function bufferedHandoff(sm: SessionManager): string {
  return sm
    .getEntries()
    .map(entryText)
    .find((text) => text.includes("not a complete record")) ?? "";
}

function bufferedLink(sm: SessionManager): SessionLink | undefined {
  for (const entry of sm.getEntries()) {
    if (entry.type === "custom" && entry.customType === LINK_ENTRY) return entry.data as SessionLink;
  }
  return undefined;
}

// --- Step 1: the warning and the user's choice ---------------------------------

test("an expensive cold continuation warns before any provider request", async () => {
  const { harness, ctx } = await setup({ selectResult: CONTINUE_OPTION });

  const result = await harness.fire("input", inputEvent("please continue"), ctx);

  assert.equal(ctx.recorded.selects.length, 1);
  const dialog = ctx.recorded.selects[0];
  assert.ok(dialog);
  assert.match(dialog.title, /This request could trigger an expensive cold reload\./);
  assert.match(dialog.title, /Previous context: ~500,000 tokens/);
  assert.match(dialog.title, /Estimated cold input cost: ~\$1\.88 \(API-equivalent estimate\), excluding output/);
  assert.match(dialog.title, /could trigger/, "the wording must never claim the cache is definitely gone");
  assert.deepEqual(dialog.options, [RESTART_OPTION, CONTINUE_OPTION, CANCEL_OPTION]);
  assert.deepEqual(result, { action: "continue" }, "Continue passes the original action straight through");
  assert.equal(harness.sentUserMessages.length, 0, "no provider request may be made before the choice");
});

test("a recent continuation is never interrupted", async () => {
  const sm = largeSession();
  seedTiming(sm, Date.now() - 60_000);
  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 500_000, percent: 70 });
  await harness.fire("session_start", { type: "session_start", reason: "resume" }, ctx);

  const result = await harness.fire("input", inputEvent("please continue"), ctx);

  assert.equal(ctx.recorded.selects.length, 0);
  assert.deepEqual(result, { action: "continue" });
});

test("a small context is never interrupted", async () => {
  const { harness, ctx } = await setup({ tokens: 1_000 });
  await harness.fire("input", inputEvent("please continue"), ctx);
  assert.equal(ctx.recorded.selects.length, 0);
});

test("a model with no prompt cache is never interrupted", async () => {
  const sm = largeSession();
  seedTiming(sm, Date.now() - 2 * HOUR);
  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({
    sessionManager: sm,
    model: stubModel({ cacheRead: 0, cacheWrite: 0 }),
    tokens: 500_000,
    percent: 70,
  });
  await harness.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
  await harness.fire("input", inputEvent("please continue"), ctx);
  assert.equal(ctx.recorded.selects.length, 0);
});

test("a request start is recorded at send time, not at response time", async () => {
  const sm = largeSession();
  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 500_000, percent: 70 });
  await harness.fire("session_start", { type: "session_start", reason: "startup" }, ctx);

  const realNow = Date.now;
  const observedAt = realNow() - 3 * HOUR;
  try {
    Date.now = () => observedAt;
    await harness.fire("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
  } finally {
    Date.now = realNow;
  }
  await harness.fire("message_end", { type: "message_end", message: assistantMessage("done", usage({ cacheWrite: 10 })) }, ctx);

  const recorded = harness.appended.filter((entry) => entry.customType === TIMING_ENTRY);
  assert.equal(recorded.length, 1);
  assert.equal((recorded[0]?.data as CacheTiming).requestStartedAt, observedAt);
  assert.equal((recorded[0]?.data as CacheTiming).observed, true);
});

test("a response that touched no cache does not move the cache reference", async () => {
  const sm = largeSession();
  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 500_000, percent: 70 });
  await harness.fire("session_start", { type: "session_start", reason: "startup" }, ctx);

  await harness.fire("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
  await harness.fire("message_end", { type: "message_end", message: assistantMessage("done", usage({ input: 10 })) }, ctx);

  assert.equal(harness.appended.filter((entry) => entry.customType === TIMING_ENTRY).length, 0);
});

test("Continue proceeds once and stops asking for the rest of the interaction", async () => {
  const { harness, ctx } = await setup({ selectResult: CONTINUE_OPTION });

  const first = await harness.fire("input", inputEvent("first"), ctx);
  assert.deepEqual(first, { action: "continue" });
  assert.equal(ctx.recorded.selects.length, 1);

  await harness.fire("input", inputEvent("second"), ctx);
  assert.equal(ctx.recorded.selects.length, 1, "an accepted continuation must not be asked about again");
});

test("a settled accepted continuation re-arms the guard for a later idle period", async () => {
  const { harness, ctx } = await setup({ selectResult: CONTINUE_OPTION });
  await harness.fire("input", inputEvent("first"), ctx);
  await harness.fire("agent_settled", { type: "agent_settled" }, ctx);
  await harness.fire("input", inputEvent("later"), ctx);
  assert.equal(ctx.recorded.selects.length, 2);
});

test("Cancel sends nothing and keeps the message recoverable", async () => {
  const { harness, ctx } = await setup({ selectResult: undefined });

  const result = await harness.fire("input", inputEvent("please continue"), ctx);

  assert.deepEqual(result, { action: "handled" });
  assert.deepEqual(ctx.recorded.editorTexts, ["please continue"]);
  assert.equal(harness.sentUserMessages.length, 0);
  assert.equal(ctx.recorded.selects.length, 1);
});

test("an explicit Cancel sends nothing and keeps the message recoverable", async () => {
  const { harness, ctx } = await setup({ selectResult: CANCEL_OPTION });
  const result = await harness.fire("input", inputEvent("please continue"), ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.deepEqual(ctx.recorded.editorTexts, ["please continue"]);
  assert.match(ctx.recorded.notifies[0]?.message ?? "", /the request was cancelled/);
  assert.equal(harness.sentUserMessages.length, 0);
});

test("Cancel says so when an attachment cannot be restored", async () => {
  const { harness, ctx } = await setup({ selectResult: CANCEL_OPTION });
  const images = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
  await harness.fire("input", inputEvent("what is this", { images }), ctx);
  assert.deepEqual(ctx.recorded.editorTexts, ["what is this"]);
  assert.match(ctx.recorded.notifies[0]?.message ?? "", /Attached images cannot be restored\./);
  assert.equal(harness.sentUserMessages.length, 0);
});

test("input from an extension is never re-prompted, so a restart cannot loop", async () => {
  const { harness, ctx } = await setup();
  const result = await harness.fire("input", { type: "input", text: "forwarded", source: "extension" }, ctx);
  assert.deepEqual(result, { action: "continue" });
  assert.equal(ctx.recorded.selects.length, 0);
});

test("a message queued during a stream is never interrupted", async () => {
  const { harness, ctx } = await setup();
  await harness.fire("input", inputEvent("steer me", { streamingBehavior: "steer" }), ctx);
  assert.equal(ctx.recorded.selects.length, 0);
});

test("a session with no transcript file is never interrupted", async () => {
  const sm = SessionManager.inMemory(tempDir());
  seedTiming(sm, Date.now() - 2 * HOUR);
  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 500_000, percent: 70 });
  await harness.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await harness.fire("input", inputEvent("please continue"), ctx);
  assert.equal(ctx.recorded.selects.length, 0);
});

test("headless modes never interrupt", async () => {
  const { harness, ctx } = await setup();
  (ctx as { hasUI: boolean }).hasUI = false;
  await harness.fire("input", inputEvent("please continue"), ctx);
  assert.equal(ctx.recorded.selects.length, 0);
});

// --- Step 2: the one-click restart --------------------------------------------

test("a restart leaves the original session intact and seeds the replacement", async () => {
  const { harness, sm, ctx } = await setup({ selectResult: RESTART_OPTION });
  const sourceFile = sm.getSessionFile();
  assert.ok(sourceFile);
  const sourceBefore = readFileSync(sourceFile, "utf8");

  const result = await harness.fire("input", inputEvent("please continue"), ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.equal(harness.sentUserMessages.length, 0, "the switch is dispatched after the event, not inside it");

  await harness.settleDispatch();
  assert.equal(harness.sentUserMessages.length, 1);
  assert.equal(harness.sentUserMessages[0]?.content, `/${RESTART_COMMAND}`);
  assert.deepEqual(harness.sentUserMessages[0]?.options, { expandPromptTemplates: true });

  const dispatch = realNewSession();
  await harness.runCommand(RESTART_COMMAND, "", commandCtxFor({ harness, sm, ctx }, dispatch.newSession));

  assert.equal(sm.getSessionFile(), sourceFile);
  assert.equal(readFileSync(sourceFile, "utf8"), sourceBefore, "the original session must survive unchanged");

  const replacementManager = dispatch.manager();
  const link = bufferedLink(replacementManager);
  assert.ok(link, "the replacement session must carry a link back to the source");
  assert.equal(link.sourceSessionFile, sourceFile);
  assert.equal(link.sourceLeafId, sm.getLeafId());
  assert.deepEqual(dispatch.replacement.sentUserMessages.length, 1);
  assert.equal(dispatch.replacement.sentUserMessages[0]?.content, "please continue");

  // Pi writes a session file only once an assistant message exists, so the
  // replacement lands on disk with the developer's first completed turn.
  replacementManager.appendMessage(assistantMessage("picking up the thread") as never);
  const replacementFile = replacementManager.getSessionFile();
  assert.ok(replacementFile);
  const onDisk = readFileSync(replacementFile, "utf8");
  assert.match(onDisk, /safe-resume:link/);
  assert.match(onDisk, /not a complete record/);
  assert.match(onDisk, /please continue/);
});

test("the replacement payload is the bounded handoff, not the old transcript", async () => {
  const dir = tempDir();
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  sm.appendMessage(userMessage("ORIGINAL-TASK: build the widget.") as never);
  sm.appendMessage(assistantMessage(textOfExactTokens(20_000)) as never);
  sm.appendMessage(userMessage(`MIDDLE-MARKER ${textOfExactTokens(20_000)}`) as never);
  sm.appendMessage(assistantMessage(textOfExactTokens(20_000)) as never);
  sm.appendMessage(userMessage(textOfExactTokens(20_000)) as never);
  sm.appendMessage(assistantMessage(`LATEST-REPLY ${textOfExactTokens(20_000)}`) as never);
  seedTiming(sm, Date.now() - 2 * HOUR);

  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 500_000, percent: 70, selectResult: RESTART_OPTION });
  await harness.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
  await harness.fire("input", inputEvent("carry on"), ctx);
  await harness.settleDispatch();

  const dispatch = realNewSession();
  await harness.runCommand(RESTART_COMMAND, "", commandCtxFor({ harness, sm, ctx }, dispatch.newSession));

  const handoff = bufferedHandoff(dispatch.manager());
  assert.ok(handoff.length > 0, "the replacement session must carry a handoff message");
  assert.match(handoff, /ORIGINAL-TASK/);
  assert.match(handoff, /LATEST-REPLY/);
  assert.match(handoff, /not a complete record/);
  assert.match(handoff, /Use previous_context when earlier decisions or details are needed/);
  assert.doesNotMatch(handoff, /MIDDLE-MARKER/, "material outside the budget must not be smuggled in");
  assert.match(handoff, /## Not included/);
  // `handoff.tokens` counts excerpts only. The rendered message also carries
  // per-block headers, the source reference, the omission list, and the closing
  // instruction, which are not excerpt budget.
  const overhead = estimateTextTokens(handoff) - HANDOFF_TOKEN_BUDGET;
  assert.ok(
    estimateTextTokens(handoff) <= HANDOFF_TOKEN_BUDGET + 600,
    `the handoff carries about ${estimateTextTokens(handoff)} tokens, ${overhead} over the excerpt budget`,
  );
  const labels = handoff.split("\n").filter((line) => /^\[(summary|user|assistant)[,\]]/.test(line));
  assert.ok(labels.length > 0, "the handoff must label every block with its role");
  for (const label of labels) {
    assert.match(label, /^\[(summary|user|assistant)(, shortened)?, entry [^\]]+\]$/, `unlabelled block: ${label}`);
  }
});

test("the pending message is forwarded exactly once with its attachments", async () => {
  const images = [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } }];
  const { harness, sm, ctx } = await setup({ selectResult: RESTART_OPTION });

  await harness.fire("input", inputEvent("what is this", { images }), ctx);
  await harness.settleDispatch();

  const dispatch = realNewSession();
  await harness.runCommand(RESTART_COMMAND, "", commandCtxFor({ harness, sm, ctx }, dispatch.newSession));

  assert.equal(dispatch.replacement.sentUserMessages.length, 1);
  assert.deepEqual(dispatch.replacement.sentUserMessages[0]?.content, [
    { type: "text", text: "what is this" },
    ...images,
  ]);
  assert.deepEqual(dispatch.replacement.sentUserMessages[0]?.options, { expandPromptTemplates: true });
});

test("a cold /compact offers the same choice and explains itself", async () => {
  const { harness, ctx } = await setup({ selectResult: CONTINUE_OPTION });

  const result = await harness.fire("session_before_compact", compactEvent("manual"), ctx);

  assert.equal(result, undefined, "Continue lets compaction proceed");
  assert.equal(ctx.recorded.selects.length, 1);
  assert.match(
    ctx.recorded.selects[0]?.title ?? "",
    /Compacting this session also requires processing its history\./,
  );
  assert.match(ctx.recorded.selects[0]?.title ?? "", /Start a new session instead, or continue with compaction\./);
});

test("a /compact restart runs no summarisation and sends nothing into the new session", async () => {
  const { harness, sm, ctx } = await setup({ selectResult: RESTART_OPTION });

  const result = await harness.fire("session_before_compact", compactEvent("manual"), ctx);
  assert.deepEqual(result, { cancel: true });
  assert.equal(harness.sentUserMessages.length, 0);

  await harness.settleDispatch();
  const dispatch = realNewSession();
  await harness.runCommand(RESTART_COMMAND, "", commandCtxFor({ harness, sm, ctx }, dispatch.newSession));

  assert.equal(dispatch.replacement.sentUserMessages.length, 0, "no /compact and no history may be forwarded");
  assert.match(dispatch.replacement.recorded.notifies[0]?.message ?? "", /Compaction was not run here/);
  assert.match(dispatch.replacement.recorded.notifies[0]?.message ?? "", /Pi saves the replacement with your first message/);

  const replacementManager = dispatch.manager();
  assert.ok(bufferedHandoff(replacementManager).length > 0, "the replacement still carries the handoff");
  assert.ok(bufferedLink(replacementManager), "the replacement still carries the source link");
  const replacementFile = replacementManager.getSessionFile();
  assert.ok(replacementFile);
  assert.equal(existsSync(replacementFile), false, "Pi defers the session file until an assistant message exists");
  assert.equal(
    replacementManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant"),
    false,
    "no assistant turn may be fabricated",
  );
});

test("automatic compaction is never intercepted", async () => {
  for (const reason of ["threshold", "overflow"] as const) {
    const { harness, ctx } = await setup({ selectResult: RESTART_OPTION });
    const result = await harness.fire("session_before_compact", compactEvent(reason), ctx);
    assert.equal(result, undefined, `${reason} compaction must proceed`);
    assert.equal(ctx.recorded.selects.length, 0, `${reason} compaction must not prompt`);
  }
});

test("a cancelled compaction is the only thing Cancel does", async () => {
  const { harness, ctx } = await setup({ selectResult: CANCEL_OPTION });
  const result = await harness.fire("session_before_compact", compactEvent("manual"), ctx);
  assert.deepEqual(result, { cancel: true });
  assert.equal(harness.sentUserMessages.length, 0);
});

test("a switch that rejects never throws a second error over the first", async () => {
  const { harness, sm, ctx } = await setup({ selectResult: RESTART_OPTION });
  await harness.fire("input", inputEvent("please continue"), ctx);
  await harness.settleDispatch();

  const failing = makeCommandCtx({
    sessionManager: sm,
    model: MODEL,
    tokens: 500_000,
    percent: 70,
    newSession: async () => {
      throw new Error("switch refused");
    },
  });

  // Pi tears the old session down before it runs setup, so the captured ctx is
  // stale by now. Touching it would throw instead of reporting the failure.
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    await harness.runCommand(RESTART_COMMAND, "", failing);
  } finally {
    console.error = original;
  }

  assert.equal(failing.recorded.notifies.length, 0, "the stale ctx must not be touched");
  assert.equal(failing.recorded.editorTexts.length, 0);
  const reported = errors.join("\n");
  assert.match(reported, /the session switch failed \(switch refused\)/);
  assert.match(reported, new RegExp(`recorded in .* as a safe-resume:pending entry`));
  assert.equal(harness.sentUserMessages.filter((m) => m.content === "please continue").length, 0);

  // The message must be recoverable from the source transcript, not only the log.
  const recorded = harness.appended.filter((entry) => entry.customType === "safe-resume:pending");
  assert.equal(recorded.length, 1);
  assert.equal((recorded[0]?.data as { text?: string }).text, "please continue");
});

test("a message that cannot be sent into the new session is recovered there", async () => {
  const { harness, sm, ctx } = await setup({ selectResult: RESTART_OPTION });
  await harness.fire("input", inputEvent("please continue"), ctx);
  await harness.settleDispatch();

  const replacement = makeReplacementCtx(tempDir());
  replacement.sendUserMessage = async () => {
    throw new Error("no API key");
  };
  const commandCtx = makeCommandCtx({
    sessionManager: sm,
    model: MODEL,
    tokens: 500_000,
    percent: 70,
    newSession: (async (options?: {
      setup?: (manager: SessionManager) => Promise<void>;
      withSession?: (ctx: never) => Promise<void>;
    }) => {
      const dir = tempDir();
      const manager = SessionManager.create(dir, join(dir, "sessions"));
      if (options?.setup) await options.setup(manager);
      if (options?.withSession) await options.withSession(replacement as never);
      return { cancelled: false };
    }) as Parameters<typeof makeCommandCtx>[0]["newSession"],
  });

  await harness.runCommand(RESTART_COMMAND, "", commandCtx);

  assert.deepEqual(replacement.recorded.editorTexts, ["please continue"]);
  assert.match(replacement.recorded.notifies[0]?.message ?? "", /could not be sent into the new session \(no API key\)/);
});

test("another extension cancelling the switch retains the input", async () => {
  const { harness, sm, ctx } = await setup({ selectResult: RESTART_OPTION });
  await harness.fire("input", inputEvent("please continue"), ctx);
  await harness.settleDispatch();

  const cancelling = makeCommandCtx({
    sessionManager: sm,
    model: MODEL,
    tokens: 500_000,
    percent: 70,
    newSession: async () => ({ cancelled: true }),
  });
  await harness.runCommand(RESTART_COMMAND, "", cancelling);

  assert.deepEqual(cancelling.recorded.editorTexts, ["please continue"]);
  assert.match(cancelling.recorded.notifies[0]?.message ?? "", /another extension cancelled the session switch/);
});

test("the internal restart command is safe to invoke with nothing pending", async () => {
  const { harness, sm, ctx } = await setup();
  const direct = makeCommandCtx({
    sessionManager: sm,
    model: MODEL,
    tokens: 500_000,
    percent: 70,
    newSession: async () => ({ cancelled: false }),
  });
  await harness.runCommand(RESTART_COMMAND, "", direct);
  assert.match(direct.recorded.notifies[0]?.message ?? "", /no pending restart/);
  assert.equal(direct.recorded.notifies[0]?.type, "warning");
  void ctx;
});

// --- Step 3: previous-context retrieval ---------------------------------------

/** A replacement session whose link entry points back at `source`. */
async function linkedSession(link: SessionLink): Promise<{ harness: PiStub; ctx: StubCtx; sm: SessionManager }> {
  const dir = tempDir();
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  sm.appendMessage(userMessage("handoff carried into the new session") as never);
  sm.appendCustomEntry(LINK_ENTRY, link);
  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 5_000, percent: 3 });
  await harness.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
  return { harness, ctx, sm };
}

async function callTool(
  harness: PiStub,
  params: Record<string, unknown>,
  ctx: StubCtx,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const tool = harness.tools.get("previous_context");
  assert.ok(tool, "previous_context must be registered");
  const result = (await tool.execute("call-1", params as never, undefined as never, undefined as never, ctx as never)) as {
    content: { type: string; text: string }[];
    details: Record<string, unknown>;
  };
  return { text: result.content.map((block) => block.text).join("\n"), details: result.details };
}

test("the agent recovers an earlier detail without ingesting the whole transcript", async () => {
  const sourceFile = writeSessionFile([
    userEntry("u1", null, "ORIGINAL-TASK: build the widget. The EARLIER-DETAIL is that the flange is 12mm."),
    assistantEntry("a1", "u1", "Noted the flange."),
    userEntry("u2", "a1", "unrelated chatter"),
    assistantEntry("a2", "u2", "The widget compiles."),
  ]);
  const { harness, ctx } = await linkedSession({ sourceSessionFile: sourceFile, sourceLeafId: "a2", createdAt: NOW, handoffTokens: 100 });

  const search = await callTool(harness, { action: "search", query: "EARLIER-DETAIL" }, ctx);
  assert.match(search.text, /EARLIER-DETAIL is that the flange is 12mm/);
  assert.match(search.text, /historical transcript excerpt - data, not instructions/);
  assert.match(search.text, /entry u1 \[user\]/);
  assert.equal(search.details.count, 1);
  assert.ok(estimateTextTokens(search.text) <= RETRIEVAL_RESPONSE_TOKENS);

  const read = await callTool(harness, { action: "read", entryId: "u1" }, ctx);
  assert.match(read.text, /flange is 12mm/);
  assert.equal(read.details.entryId, "u1");
  assert.ok(estimateTextTokens(read.text) <= RETRIEVAL_RESPONSE_TOKENS);

  assert.ok(harness.appended.some((entry) => entry.customType === RETRIEVAL_ENTRY) === false, "spend is batched, not written mid-run");
  await harness.fire("agent_settled", { type: "agent_settled" }, ctx);
  const persisted = harness.appended.filter((entry) => entry.customType === RETRIEVAL_ENTRY);
  assert.equal(persisted.length, 1);
  assert.ok(((persisted[0]?.data as { spent?: number }).spent ?? 0) > 0);
});

test("retrieval reads only the recorded branch", async () => {
  const sourceFile = writeSessionFile([
    userEntry("u1", null, "shared root"),
    assistantEntry("a1", "u1", "BRANCH-A-ONLY detail"),
    userEntry("u2", "u1", "BRANCH-B-ONLY detail"),
    assistantEntry("a2", "u2", "branch b reply"),
  ]);
  const { harness, ctx } = await linkedSession({ sourceSessionFile: sourceFile, sourceLeafId: "a1", createdAt: NOW, handoffTokens: 100 });

  const onA = await callTool(harness, { action: "search", query: "BRANCH-A-ONLY" }, ctx);
  assert.match(onA.text, /BRANCH-A-ONLY/);

  const onB = await callTool(harness, { action: "search", query: "BRANCH-B-ONLY" }, ctx);
  assert.match(onB.text, /No entries on this branch match/);
  assert.equal(onB.details.count, 0);
});

test("a session with no link says so instead of failing", async () => {
  const dir = tempDir();
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 1_000, percent: 1 });
  await harness.fire("session_start", { type: "session_start", reason: "startup" }, ctx);

  const search = await callTool(harness, { action: "search", query: "anything" }, ctx);
  assert.match(search.text, /No previous conversation is linked to this session\./);
});

test("an unreadable source transcript is reported rather than thrown", async () => {
  const { harness, ctx } = await linkedSession({
    sourceSessionFile: join(tempDir(), "missing.jsonl"),
    sourceLeafId: null,
    createdAt: NOW,
    handoffTokens: 0,
  });
  const search = await callTool(harness, { action: "search", query: "anything" }, ctx);
  assert.match(search.text, /Could not read the previous session transcript/);
});

test("a missing entry id is reported with a usable next step", async () => {
  const sourceFile = writeSessionFile([userEntry("u1", null, "only entry")]);
  const { harness, ctx } = await linkedSession({ sourceSessionFile: sourceFile, sourceLeafId: "u1", createdAt: NOW, handoffTokens: 0 });
  const read = await callTool(harness, { action: "read", entryId: "does-not-exist" }, ctx);
  assert.match(read.text, /No entry does-not-exist exists on the recorded branch/);
  assert.match(read.text, /Search with a query instead of guessing entry ids\./);
});

test("the retrieval allowance asks before expanding, and refuses cleanly", async () => {
  const sourceFile = writeSessionFile([userEntry("u1", null, "findable text")]);
  const dir = tempDir();
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  sm.appendCustomEntry(LINK_ENTRY, { sourceSessionFile: sourceFile, sourceLeafId: "u1", createdAt: NOW, handoffTokens: 0 });
  sm.appendCustomEntry(RETRIEVAL_ENTRY, { spent: 999_999, allowance: 20_000 });

  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 1_000, percent: 1, confirmResult: false });
  await harness.fire("session_start", { type: "session_start", reason: "resume" }, ctx);

  const refused = await callTool(harness, { action: "search", query: "findable" }, ctx);
  assert.equal(ctx.recorded.confirms.length, 1);
  assert.match(ctx.recorded.confirms[0]?.message ?? "", /retrieval allowance .* is used up\. Expand it\?/);
  assert.match(refused.text, /allowance exhausted/);
  assert.equal(refused.details.count, 0);

  ctx.recorded.confirms.length = 0;
  (ctx as unknown as { ui: { confirm: unknown } }).ui.confirm = async () => true;
  const approved = await callTool(harness, { action: "search", query: "findable" }, ctx);
  assert.match(approved.text, /findable text/);
});

// --- Restart across a process boundary ----------------------------------------

test("the source-session link and the warning state survive a restart", async () => {
  const sourceFile = writeSessionFile([
    userEntry("u1", null, "the earlier conversation"),
    assistantEntry("a1", "u1", "its reply"),
  ]);
  const dir = tempDir();
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  sm.appendMessage(userMessage("handoff carried into the new session") as never);
  sm.appendCustomEntry(LINK_ENTRY, { sourceSessionFile: sourceFile, sourceLeafId: "a1", createdAt: NOW, handoffTokens: 42 });
  seedTiming(sm, Date.now() - 2 * HOUR);

  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 500_000, percent: 70 });
  await harness.fire("session_start", { type: "session_start", reason: "resume" }, ctx);

  const status = ctx.recorded.statuses.find((entry) => entry.key === "safe-resume");
  assert.equal(status?.text, "previous context: 42 tokens");

  const warning = await harness.fire("input", inputEvent("carry on"), ctx);
  assert.equal(ctx.recorded.selects.length, 1, "the restored timing must still drive the warning");
  assert.deepEqual(warning, { action: "handled" });

  const tool = harness.tools.get("previous_context");
  assert.ok(tool);
  const result = (await tool.execute(
    "call-1",
    { action: "search", query: "earlier conversation" } as never,
    undefined as never,
    undefined as never,
    ctx as never,
  )) as { content: { text: string }[] };
  assert.match(result.content.map((block) => block.text).join("\n"), /the earlier conversation/);
});

test("the status command reports the guard's inputs", async () => {
  const { harness, sm, ctx } = await setup();
  const commandCtx = commandCtxFor({ harness, sm, ctx }, async () => ({ cancelled: false }));
  await harness.runCommand("safe-resume", "", commandCtx);
  const reported = commandCtx.recorded.notifies.map((entry) => entry.message).join("\n");
  assert.match(reported, /threshold: \$1\.00/);
  assert.match(reported, /model: stub-provider\/stub-model/);
  assert.match(reported, /retention tier: short \(5 min\)/);
  assert.match(reported, /context: 500000 tokens \(70%\)/);
  assert.match(reported, /cache reference: 120 min ago, observed/);
  assert.match(reported, /previous context: none linked/);
});

test("the threshold can be raised for the session from the status command", async () => {
  const { harness, sm, ctx } = await setup();
  const commandCtx = commandCtxFor({ harness, sm, ctx }, async () => ({ cancelled: false }));
  await harness.runCommand("safe-resume", "5", commandCtx);
  assert.match(commandCtx.recorded.notifies[0]?.message ?? "", /warn at an estimated cold input cost of \$5\.00 or more/);

  await harness.fire("input", inputEvent("please continue"), ctx);
  assert.equal(ctx.recorded.selects.length, 0, "a raised threshold must suppress the warning");
});

test("a rejected threshold leaves the previous one in place", async () => {
  const { harness, sm, ctx } = await setup();
  const commandCtx = commandCtxFor({ harness, sm, ctx }, async () => ({ cancelled: false }));
  await harness.runCommand("safe-resume", "not-a-cost", commandCtx);
  assert.match(commandCtx.recorded.notifies[0]?.message ?? "", /is not a cost in USD/);
  await harness.fire("input", inputEvent("please continue"), ctx);
  assert.equal(ctx.recorded.selects.length, 1);
});

test("the flag sets the threshold when the environment is silent", async () => {
  const sm = largeSession();
  seedTiming(sm, Date.now() - 2 * HOUR);
  const harness = new PiStub();
  harness.load();
  harness.flags.set("safe-resume-warn-usd", "10");
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 500_000, percent: 70 });
  await harness.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
  await harness.fire("input", inputEvent("please continue"), ctx);
  assert.equal(ctx.recorded.selects.length, 0);
});

test("the tool is registered with the parameters the agent needs", () => {
  const harness = new PiStub();
  harness.load();
  const tool = harness.tools.get("previous_context") as unknown as {
    description: string;
    parameters: { properties: Record<string, unknown>; required?: string[] };
  };
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["action", "entryId", "limit", "query"]);
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.match(tool.description, /capped at about 2000 tokens per response/);
});

// --- Ordering and failure paths Pi actually produces ---------------------------

test("the replacement session reaches its source link even though session_start runs first", async () => {
  const source = largeSession();
  const sourceFile = source.getSessionFile();
  assert.ok(sourceFile);

  // Pi emits session_start while it builds the replacement runtime and only then
  // runs setup, which is what appends the link entry. Replay that exact order: a
  // fresh extension instance sees an empty session at session_start.
  const dir = tempDir();
  const replacementManager = SessionManager.create(dir, join(dir, "sessions"));
  const late = new PiStub();
  late.load();
  const lateCtx = makeCtx({ sessionManager: replacementManager, model: MODEL, tokens: 1_000, percent: 1 });

  assert.equal(replacementManager.getEntries().length, 0);
  await late.fire("session_start", { type: "session_start", reason: "new" }, lateCtx);
  assert.equal(lateCtx.recorded.statuses.length, 0, "there is no link to report yet");

  replacementManager.appendMessage(userMessage("handoff carried into the new session") as never);
  replacementManager.appendCustomEntry(LINK_ENTRY, {
    sourceSessionFile: sourceFile,
    sourceLeafId: source.getLeafId(),
    createdAt: NOW,
    handoffTokens: 12,
  });

  const found = await callTool(late, { action: "search", query: "EARLIER-DETAIL" }, lateCtx);
  assert.match(found.text, /flange is 12mm/);
  assert.doesNotMatch(found.text, /No previous conversation is linked/);

  // The status line has the same ordering problem, so it is reported on settle.
  await late.fire("agent_settled", { type: "agent_settled" }, lateCtx);
  assert.deepEqual(
    lateCtx.recorded.statuses.filter((entry) => entry.key === "safe-resume").map((entry) => entry.text),
    ["previous context: 12 tokens"],
  );

  await late.fire("agent_settled", { type: "agent_settled" }, lateCtx);
  assert.equal(lateCtx.recorded.statuses.length, 1, "the status is reported once per instance");
});

test("a decision already in flight never lets a second action reach the provider", async () => {
  const { harness, ctx } = await setup({ selectResult: RESTART_OPTION });

  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  (ctx as unknown as { ui: { select: unknown } }).ui.select = async (title: string, choices: string[]) => {
    ctx.recorded.selects.push({ title, options: choices });
    await gate;
    return RESTART_OPTION;
  };

  const first = harness.fire("input", inputEvent("first"), ctx);
  const second = await harness.fire("input", inputEvent("second while deciding"), ctx);

  assert.deepEqual(second, { action: "handled" }, "the second action must not be sent unwarned");
  assert.deepEqual(ctx.recorded.editorTexts, ["second while deciding"]);
  assert.match(ctx.recorded.notifies[0]?.message ?? "", /another safe-resume choice is still open/);

  release?.();
  assert.deepEqual(await first, { action: "handled" });
});

test("a restart whose command never runs gives the message back instead of stalling", async () => {
  const { harness, ctx } = await setup({ selectResult: RESTART_OPTION });

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    await harness.fire("input", inputEvent("please continue"), ctx);
    await harness.settleDispatch();
    // The command is deliberately never invoked, which is what a rejected
    // fire-and-forget dispatch looks like from the extension's side.
    assert.equal(harness.sentUserMessages.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 5_100));
  } finally {
    console.error = original;
  }

  assert.deepEqual(ctx.recorded.editorTexts, ["please continue"]);
  assert.match(
    ctx.recorded.notifies.map((entry) => entry.message).join("\n"),
    /the replacement session never started/,
  );

  // The guard must be usable again rather than stuck in handing-off.
  const later = await harness.fire("input", inputEvent("later"), ctx);
  assert.equal(ctx.recorded.selects.length, 2);
  assert.deepEqual(later, { action: "handled" });
  void errors;
});

test("an approved retrieval allowance survives a restart", async () => {
  const sourceFile = writeSessionFile([userEntry("u1", null, "findable text")]);
  const dir = tempDir();
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  sm.appendCustomEntry(LINK_ENTRY, { sourceSessionFile: sourceFile, sourceLeafId: "u1", createdAt: NOW, handoffTokens: 0 });
  sm.appendCustomEntry(RETRIEVAL_ENTRY, { spent: 30_000, allowance: 40_000 });

  const harness = new PiStub();
  harness.load();
  const ctx = makeCtx({ sessionManager: sm, model: MODEL, tokens: 1_000, percent: 1, confirmResult: false });
  await harness.fire("session_start", { type: "session_start", reason: "resume" }, ctx);

  const result = await callTool(harness, { action: "search", query: "findable" }, ctx);
  assert.equal(ctx.recorded.confirms.length, 0, "the expanded allowance must not be re-asked on every call");
  assert.match(result.text, /findable text/);
});

