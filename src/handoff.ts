/**
 * Local extraction of a bounded handoff, and the session-link record.
 *
 * Preparing a handoff makes zero model calls. It reuses whatever text the
 * transcript already holds, including an existing compaction summary, and
 * labels everything it shortened or left behind.
 */
import {
  buildContextEntries,
  estimateTokens,
  truncateHead,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Handoff, HandoffBlock, SessionLink } from "./types.ts";

/** Imported historical context is capped at roughly this many tokens. */
export const HANDOFF_TOKEN_BUDGET = 4000;
/** Hard text-size limit applied to any single excerpt before token accounting. */
export const HANDOFF_MAX_BYTES = 20_000;
export const HANDOFF_MAX_RECENT_USER_MESSAGES = 6;
/** Below this, a shortened high-priority excerpt is not worth including at all. */
const MIN_USEFUL_TOKENS = 40;

export const CONTINUATION_INSTRUCTION =
  "Continue the current request using the supplied context. Use previous_context when earlier decisions or " +
  "details are needed. Retrieve relevant excerpts rather than loading the entire transcript. Check current " +
  "files before relying on historical code or test results.";

export interface BuildHandoffOptions {
  /** Branch tip to read. Restricting to the recorded tip keeps unrelated branches out. */
  leafId?: string | null;
  budgetTokens?: number;
  maxBytes?: number;
  maxRecentUserMessages?: number;
}

interface TextBlock {
  type: string;
  text?: string;
}

interface MessageLike {
  role?: string;
  content?: unknown;
}

/**
 * Token estimate for a plain string, using Pi's own chars/4 helper.
 *
 * This is the unit every budget in this file and in `history.ts` is expressed
 * in. Byte caps exist only as a secondary safety limit.
 */
export function estimateTextTokens(text: string): number {
  return estimateTokens({ role: "user", content: [{ type: "text", text }], timestamp: 0 } as never);
}

const FALLBACK_SUFFIX = " [truncated]";

/**
 * Bound text to a byte limit, keeping whole lines where possible.
 *
 * `truncateHead` keeps no partial lines, so a single line longer than the limit
 * comes back empty. A pasted blob is exactly that shape, so keep a byte-bounded
 * head of that line and label it instead of dropping the excerpt. The label is
 * counted inside `maxBytes`, and an explicit line limit keeps this a byte cap
 * rather than a byte-and-line cap.
 */
export function capToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const limit = Math.max(0, maxBytes);
  const head = truncateHead(text, { maxBytes: limit, maxLines: Number.MAX_SAFE_INTEGER });
  if (head.content.length > 0 || text.length === 0) {
    return { text: head.content, truncated: head.truncated };
  }
  if (limit <= FALLBACK_SUFFIX.length) {
    // Too small for a label. Keep the head of the text rather than a prefix of
    // the label, so a tiny budget still returns content.
    return { text: text.slice(0, limit), truncated: true };
  }
  const room = limit - Buffer.byteLength(FALLBACK_SUFFIX, "utf8");
  const kept = Buffer.from(text, "utf8").subarray(0, room).toString("utf8").replace(/\uFFFD+$/, "");
  return { text: `${kept}${FALLBACK_SUFFIX}`, truncated: true };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as TextBlock;
    if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
  }
  return parts.join("\n");
}

/** Text and role for an entry, or undefined when the entry carries nothing worth carrying. */
export function extractText(entry: SessionEntry): { role: HandoffBlock["role"]; text: string } | undefined {
  if (entry.type === "compaction") {
    const summary = entry.summary.trim();
    return summary ? { role: "summary", text: summary } : undefined;
  }
  if (entry.type !== "message") return undefined;
  const message = entry.message as unknown as MessageLike;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = contentText(message.content).trim();
  if (!text) return undefined;
  return { role: message.role, text };
}

interface Candidate {
  block: HandoffBlock;
  priority: number;
  order: number;
}

interface Extracted {
  entryId: string;
  role: HandoffBlock["role"];
  text: string;
  order: number;
}

function collectCandidates(branch: SessionEntry[], maxRecentUserMessages: number): Candidate[] {
  const extracted: Extracted[] = [];
  for (const [order, entry] of branch.entries()) {
    const found = extractText(entry);
    if (found) extracted.push({ entryId: entry.id, role: found.role, text: found.text, order });
  }

  const candidates: Candidate[] = [];
  const push = (item: Extracted, priority: number) => {
    candidates.push({ block: { role: item.role, text: item.text, entryId: item.entryId, truncated: false }, priority, order: item.order });
  };

  const summaries = extracted.filter((item) => item.role === "summary");
  const users = extracted.filter((item) => item.role === "user");
  const assistants = extracted.filter((item) => item.role === "assistant");

  const latestSummary = summaries.at(-1);
  if (latestSummary) push(latestSummary, 0);

  const firstUser = users[0];
  if (firstUser) push(firstUser, 1);

  const lastAssistant = assistants.at(-1);
  if (lastAssistant) push(lastAssistant, 2);

  const recentUsers = users
    .slice(1)
    .slice(-maxRecentUserMessages)
    .reverse();
  for (const item of recentUsers) push(item, 3);

  return candidates;
}

function labelFor(candidate: Candidate): string {
  switch (candidate.priority) {
    case 0:
      return "the previous summary";
    case 1:
      return "the original task";
    case 2:
      return "the most recent assistant response";
    default:
      return "a recent user message";
  }
}

function sliceToTokens(text: string, tokens: number): string {
  return text.slice(0, Math.max(0, tokens) * 4).trimEnd();
}

export function buildHandoff(entries: SessionEntry[], options: BuildHandoffOptions = {}): Handoff {
  const budgetTokens = options.budgetTokens ?? HANDOFF_TOKEN_BUDGET;
  const maxBytes = options.maxBytes ?? HANDOFF_MAX_BYTES;
  const maxRecentUserMessages = options.maxRecentUserMessages ?? HANDOFF_MAX_RECENT_USER_MESSAGES;

  const branch = buildContextEntries(entries, options.leafId ?? null);
  const candidates = collectCandidates(branch, maxRecentUserMessages).sort(
    (left, right) => left.priority - right.priority || left.order - right.order,
  );

  const accepted: Candidate[] = [];
  const omitted: string[] = [];
  /** Entry ids already named in `omitted`, so the unrepresented count cannot repeat them. */
  const mentioned = new Set<string>();
  let spent = 0;

  for (const candidate of candidates) {
    const capped = capToBytes(candidate.block.text, maxBytes);
    const tokens = estimateTextTokens(capped.text);
    const remaining = budgetTokens - spent;

    if (tokens <= remaining) {
      accepted.push({ ...candidate, block: { ...candidate.block, text: capped.text, truncated: capped.truncated } });
      spent += tokens;
      if (capped.truncated) omitted.push(`${labelFor(candidate)} was shortened to the text limit`);
      continue;
    }

    if (candidate.priority <= 2 && remaining >= MIN_USEFUL_TOKENS) {
      const text = sliceToTokens(capped.text, remaining);
      accepted.push({ ...candidate, block: { ...candidate.block, text, truncated: true } });
      spent += estimateTextTokens(text);
      omitted.push(`${labelFor(candidate)} was shortened to the handoff budget`);
      continue;
    }

    omitted.push(`${labelFor(candidate)} did not fit the handoff budget`);
    mentioned.add(candidate.block.entryId);
  }

  const represented = new Set(accepted.map((candidate) => candidate.block.entryId));
  const droppedMessages = branch.filter((entry) => {
    if (represented.has(entry.id) || mentioned.has(entry.id)) return false;
    const found = extractText(entry);
    return found !== undefined && found.role !== "summary";
  }).length;
  if (droppedMessages > 0) {
    omitted.push(`${droppedMessages} earlier message${droppedMessages === 1 ? "" : "s"} not represented`);
  }

  const ordered = accepted.sort((left, right) => left.order - right.order);
  return { blocks: ordered.map((candidate) => candidate.block), omitted, tokens: spent };
}

export function buildSessionLink(
  sourceSessionFile: string,
  sourceLeafId: string | null,
  handoff: Handoff,
  now: number,
): SessionLink {
  return { sourceSessionFile, sourceLeafId, createdAt: now, handoffTokens: handoff.tokens };
}

/** The message that seeds the replacement session. */
export function renderHandoff(handoff: Handoff, link: SessionLink, sourceTokens: number | null): string {
  const lines: string[] = [
    "[safe-resume] Continuing from an earlier session. The excerpt below is bounded, not a complete record.",
    "",
    `Previous session: ${link.sourceSessionFile}`,
    `Branch tip: ${link.sourceLeafId ?? "(unknown)"}`,
    sourceTokens === null
      ? `That conversation held an unknown number of tokens; this handoff carries about ${handoff.tokens}.`
      : `That conversation held about ${sourceTokens} tokens; this handoff carries about ${handoff.tokens}.`,
    "",
    "## Earlier context",
    "",
  ];

  for (const block of handoff.blocks) {
    const suffix = block.truncated ? ", shortened" : "";
    lines.push(`[${block.role}${suffix}, entry ${block.entryId}]`);
    lines.push(block.text);
    lines.push("");
  }

  if (handoff.omitted.length > 0) {
    lines.push("## Not included");
    lines.push("");
    for (const item of handoff.omitted) lines.push(`- ${item}`);
    lines.push("");
  }

  lines.push(CONTINUATION_INSTRUCTION);
  return lines.join("\n");
}

/** One-line transcript summary for the replacement session. */
export function formatHandoffSummary(link: SessionLink): string {
  return `Handoff from ${link.sourceSessionFile} (~${link.handoffTokens} tokens, branch tip ${link.sourceLeafId ?? "unknown"})`;
}
