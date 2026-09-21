/**
 * Shared fixtures. No network, no provider calls, no real model catalogue:
 * every model is a plain object carrying only the fields the code reads.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Fixed clock. Nothing in the suite depends on wall time. */
export const NOW = 1_700_000_000_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export interface StubCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface StubModelOptions {
  id?: string;
  provider?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: StubCostTier[];
  promptCache?: { short?: number; long?: number };
  contextWindow?: number;
}

export function stubModel(options: StubModelOptions = {}): Model<any> {
  const cost: Record<string, unknown> = {
    input: options.input ?? 3,
    output: options.output ?? 15,
    cacheRead: options.cacheRead ?? 0.3,
    cacheWrite: options.cacheWrite ?? 3.75,
  };
  if (options.tiers) cost.tiers = options.tiers;
  const model: Record<string, unknown> = {
    id: options.id ?? "stub-model",
    name: "Stub Model",
    api: "anthropic-messages",
    provider: options.provider ?? "stub-provider",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost,
    contextWindow: options.contextWindow ?? 200_000,
    maxTokens: 8192,
  };
  if (options.promptCache) model.promptCache = options.promptCache;
  return model as unknown as Model<any>;
}

export function usage(partial: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...partial,
  };
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

export function userEntry(id: string, parentId: string | null, text: string, at = NOW): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: { role: "user", content: [{ type: "text", text }], timestamp: at },
  } as unknown as SessionEntry;
}

export function assistantEntry(
  id: string,
  parentId: string | null,
  text: string,
  at = NOW,
  messageUsage: Usage = usage(),
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "stub-provider",
      model: "stub-model",
      usage: messageUsage,
      stopReason: "stop",
      timestamp: at,
    },
  } as unknown as SessionEntry;
}

export function compactionEntry(id: string, parentId: string | null, summary: string, at = NOW): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: iso(at),
    summary,
    firstKeptEntryId: id,
    tokensBefore: 500_000,
  } as unknown as SessionEntry;
}

/** A user message in the shape `SessionManager.appendMessage` accepts. */
export function userMessage(text: string, at = NOW): unknown {
  return { role: "user", content: [{ type: "text", text }], timestamp: at };
}

/** An assistant message in the shape `SessionManager.appendMessage` accepts. */
export function assistantMessage(text: string, messageUsage: Usage = usage(), at = NOW): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "stub-provider",
    model: "stub-model",
    usage: messageUsage,
    stopReason: "stop",
    timestamp: at,
  };
}

/** Write a real session JSONL file, header included, into a fresh temp directory. */
export function writeSessionFile(entries: SessionEntry[], name = "session.jsonl"): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-safe-resume-"));
  const file = join(directory, name);
  const header = { type: "session", version: 3, id: "test-session", timestamp: iso(NOW), cwd: directory };
  const lines = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

/** A long string whose char count is close to the requested token count. */
export function textOfTokens(tokens: number, prefix = "word"): string {
  return `${prefix} `.repeat(Math.max(1, tokens));
}

/**
 * A string that `estimateTextTokens` measures as exactly this many tokens.
 * The estimator is chars/4, so four characters per token is exact.
 */
export function textOfExactTokens(tokens: number): string {
  return "x".repeat(Math.max(1, tokens) * 4);
}
