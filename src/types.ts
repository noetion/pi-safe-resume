/**
 * Frozen data shapes for the extension. Every module and the test suite depend
 * on this file, so it changes last and deliberately.
 */
import type { ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** What the developer was doing when the guard intercepted the action. */
export type PendingAction =
  | { kind: "message"; text: string; images?: ImageContent[] }
  | { kind: "compact" };

/** Price of one cold continuation, excluding output tokens. */
export interface ColdCostEstimate {
  contextTokens: number;
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  /** Full input-side price of the request in USD. 0 when the model's rates are zero or unknown. */
  costUsd: number;
}

/** The retention tier a request asks the provider for. `"none"` means caching is off. */
export type CacheRetentionTier = "none" | "short" | "long";

/**
 * When the prompt cache entry touched by the last cache-relevant request was
 * created. Providers run retention from the start of the request that writes or
 * reads the entry, so this is a request-start time, never a response-end time.
 */
export interface CacheTiming {
  requestStartedAt: number;
  provider: string;
  modelId: string;
  /** False when reconstructed from a transcript timestamp instead of observed live. */
  observed: boolean;
}

/** Why the guard let an action through. */
export type PassReason =
  | "no-model"
  | "no-prompt-cache"
  | "unknown-context"
  | "no-timing"
  | "recent"
  | "cheap";

export type RiskAssessment =
  | { kind: "pass"; reason: PassReason }
  | {
      kind: "warn";
      /** "expired" means the retention window has passed; "unknown" means no lifetime metadata exists. */
      expiry: "expired" | "unknown";
      estimate: ColdCostEstimate;
      idleMs: number;
      windowMs: number;
    };

/** A bounded, role-labelled excerpt carried into the replacement session. */
export interface HandoffBlock {
  role: "summary" | "user" | "assistant";
  text: string;
  entryId: string;
  /** True when the block was shortened to fit the budget. */
  truncated: boolean;
}

export interface Handoff {
  blocks: HandoffBlock[];
  /** Human-readable labels for material left behind, so the handoff never implies completeness. */
  omitted: string[];
  tokens: number;
}

/** Durable pointer from a replacement session back to the conversation it came from. */
export interface SessionLink {
  sourceSessionFile: string;
  /** Branch tip in the source session, so retrieval cannot wander into unrelated branches. */
  sourceLeafId: string | null;
  createdAt: number;
  handoffTokens: number;
}

/** One search hit or read result from the source transcript. */
export interface HistoryExcerpt {
  entryId: string;
  role: string;
  text: string;
  truncated: boolean;
}

/** The transcript a `previous_context` call reads from. */
export interface HistorySource {
  sessionFile: string;
  leafId: string | null;
}

/**
 * Everything `assessRisk` needs, passed explicitly so the decision is a pure
 * function of its inputs and the test suite can drive it without Pi.
 */
export interface RiskInput {
  model: Model<any> | undefined;
  contextTokens: number | null;
  contextPercent: number | null;
  timing: CacheTiming | undefined;
  /** Lifetime in ms of the entry the last cache-relevant request wrote. Undefined when metadata is missing. */
  retentionMs: number | undefined;
  /** The tier the request asks for. Drives the long-retention cache-write price. */
  retentionTier: CacheRetentionTier;
  now: number;
  warnAboveUsd: number;
  unknownExpiryMs: number;
}

/** A live request whose response has not landed yet. */
export interface PendingRequestObservation {
  requestStartedAt: number;
  provider: string;
  modelId: string;
}

export type { ImageContent, Model, SessionEntry, Usage };
