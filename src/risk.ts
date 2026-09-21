/**
 * Timing and cold-cost estimation.
 *
 * This module deliberately owns no model catalogue. It reads the pricing and
 * cache-retention metadata Pi already resolves onto `ctx.model`, and prices a
 * request with Pi's own `calculateCost`, so request-wide tiers and the Anthropic
 * one-hour cache-write rule stay in one place. That rule applies only when the
 * resolved tier is `long`, which `estimateColdCost` takes as an argument.
 */
import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { getLastAssistantUsage, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  CacheRetentionTier,
  CacheTiming,
  ColdCostEstimate,
  PendingRequestObservation,
  RiskAssessment,
  RiskInput,
} from "./types.ts";

/** Product default, not a vendor limit. */
export const DEFAULT_WARN_ABOVE_USD = 1;

/**
 * Fallback window used when a model reports cache pricing but no cache
 * lifetime. Pi cannot warm such a cache, and this extension must not invent an
 * expiry, so the dialog says "unknown" and this value only gates how long the
 * session must sit idle before the warning is worth showing.
 */
export const DEFAULT_UNKNOWN_EXPIRY_MS = 15 * 60_000;

/** Context occupancy at or above which a session counts as large when no price is available. */
export const LARGE_CONTEXT_PERCENT = 50;

/**
 * The retention tier this process asks for.
 *
 * Pi resolves `options.cacheRetention` first, then `PI_CACHE_RETENTION`, then
 * `short`. Every provider adapter reads that variable as `"long"` or nothing, so
 * the environment can never turn caching off. Only the per-request option can,
 * and an extension cannot see it. This therefore never returns `none`.
 */
export function resolveRetentionTier(env: Record<string, string | undefined>): CacheRetentionTier {
  return env.PI_CACHE_RETENTION === "long" ? "long" : "short";
}

/** Lifetime in ms of the entry a request writes, from the model's own retention metadata. */
export function resolveRetentionMs(model: Model<any>, tier: CacheRetentionTier): number | undefined {
  if (tier === "none") return undefined;
  const seconds = model.promptCache?.[tier];
  return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Whether the model has prompt caching at all. Without it every request is
 * already full price, so a "cold reload" warning would be pure noise.
 */
export function hasPromptCache(model: Model<any>): boolean {
  return model.promptCache !== undefined || model.cost.cacheRead > 0 || model.cost.cacheWrite > 0;
}

/**
 * Prompt size of the most recent real request on the branch, as reported by the
 * provider. Used as the fallback when `ctx.getContextUsage()` cannot estimate.
 */
export function lastPromptTokens(entries: SessionEntry[]): number {
  const usage: Usage | undefined = getLastAssistantUsage(entries);
  if (!usage) return 0;
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function price(model: Model<any>, tokens: Partial<Usage>): number {
  return calculateCost(model, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...tokens,
  } as Usage).total;
}

/**
 * Price the input side of one continuation that finds no usable cache entry.
 *
 * A provider that charges for cache writes re-establishes the entry, so the
 * whole prompt is billed as a write; one that does not bills it as plain input.
 * A long-retention write costs twice the base input rate, which Pi's
 * `calculateCost` applies from `cacheWrite1h`. Only Anthropic Messages and
 * Bedrock Converse report that split, so the rate applies only when the model
 * publishes a long lifetime of its own. Output tokens are excluded by
 * construction.
 */
export function estimateColdCost(
  model: Model<any>,
  contextTokens: number,
  tier: CacheRetentionTier = "short",
): ColdCostEstimate {
  const billsCacheWrite = model.cost.cacheWrite > 0;
  const cacheWriteTokens = billsCacheWrite ? contextTokens : 0;
  const uncachedInputTokens = billsCacheWrite ? 0 : contextTokens;
  const billsLongWrite = tier === "long" && cacheWriteTokens > 0 && model.promptCache?.long !== undefined;
  const longWrite = billsLongWrite ? { cacheWrite1h: cacheWriteTokens } : {};
  return {
    contextTokens,
    uncachedInputTokens,
    cacheWriteTokens,
    costUsd: price(model, { input: uncachedInputTokens, cacheWrite: cacheWriteTokens, ...longWrite }),
  };
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const {
    model,
    contextTokens,
    contextPercent,
    timing,
    retentionMs,
    retentionTier,
    now,
    warnAboveUsd,
    unknownExpiryMs,
  } = input;

  if (!model) return { kind: "pass", reason: "no-model" };
  // Only a caller that resolved a per-request tier can reach this. The
  // environment cannot, so it stays quiet rather than claiming Pi's caching is
  // off when it is not.
  if (retentionTier === "none") return { kind: "pass", reason: "no-prompt-cache" };
  if (!hasPromptCache(model)) return { kind: "pass", reason: "no-prompt-cache" };
  if (contextTokens === null || contextTokens <= 0) return { kind: "pass", reason: "unknown-context" };
  if (!timing) return { kind: "pass", reason: "no-timing" };

  const expiry: "expired" | "unknown" = retentionMs === undefined ? "unknown" : "expired";
  const windowMs = retentionMs ?? unknownExpiryMs;
  const idleMs = now - timing.requestStartedAt;
  if (idleMs < windowMs) return { kind: "pass", reason: "recent" };

  const estimate = estimateColdCost(model, contextTokens, retentionTier);

  if (estimate.costUsd <= 0) {
    // No usable price. Warn only for a genuinely large session and show no
    // dollar figure rather than inventing one.
    if (contextPercent === null || contextPercent < LARGE_CONTEXT_PERCENT) {
      return { kind: "pass", reason: "cheap" };
    }
    return { kind: "warn", expiry, estimate, idleMs, windowMs };
  }

  if (estimate.costUsd < warnAboveUsd) return { kind: "pass", reason: "cheap" };
  return { kind: "warn", expiry, estimate, idleMs, windowMs };
}

/**
 * Records when the in-flight request started, then promotes that start time to
 * the cache reference only once a response proves the request read or wrote a
 * cache entry. Retention runs from request start, so a long generation must not
 * appear to extend the entry's life.
 */
export class CacheTimingTracker {
  private pending: PendingRequestObservation | undefined;
  private current: CacheTiming | undefined;

  get timing(): CacheTiming | undefined {
    return this.current;
  }

  /** Called from `before_provider_request`, which fires immediately before the request is sent. */
  observeRequestStart(now: number, model: Model<any> | undefined): void {
    if (!model) return;
    this.pending = { requestStartedAt: now, provider: model.provider, modelId: model.id };
  }

  /**
   * Called when an assistant message lands. Returns the new reference when this
   * response touched the prompt cache, or undefined when it did not.
   */
  confirmCacheRelevant(usage: Usage | undefined): CacheTiming | undefined {
    if (!this.pending) return undefined;
    if (!usage || (usage.cacheRead <= 0 && usage.cacheWrite <= 0)) return undefined;
    this.current = { ...this.pending, observed: true };
    return this.current;
  }

  /** Restore a reference observed in this process, or reconstructed from a transcript. */
  restore(timing: CacheTiming | undefined): void {
    this.current = timing;
  }

  reset(): void {
    this.pending = undefined;
    this.current = undefined;
  }
}

/**
 * Reconstruct a cache reference from assistant messages, for a session this
 * process never observed.
 *
 * The entry timestamp marks the response, which is later than the request start.
 * A later start understates the idle time, so this fallback warns less often
 * than a live observation would. That direction avoids false positives but
 * misses real cold reloads, which is why a live observation is preferred
 * whenever one exists.
 */
export function timingFromTranscript(entries: SessionEntry[], model: Model<any> | undefined): CacheTiming | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (!usage || (usage.cacheRead <= 0 && usage.cacheWrite <= 0)) continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at)) return undefined;
    return {
      requestStartedAt: at,
      provider: model?.provider ?? entry.message.provider,
      modelId: model?.id ?? entry.message.model,
      observed: false,
    };
  }
  return undefined;
}

/**
 * The last time Pi's own cache warmer refreshed an entry.
 *
 * The warmer replays a request directly through the model runtime, so it never
 * reaches `before_provider_request` and `CacheTimingTracker` cannot observe it.
 * It does record a `cache_warm` usage entry, which is the only evidence that the
 * entry was alive after the agent's last request.
 */
export function timingFromWarmEntries(entries: SessionEntry[]): CacheTiming | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || entry.type !== "usage" || entry.kind !== "cache_warm") continue;
    if (entry.usage.cacheRead <= 0 && entry.usage.cacheWrite <= 0) continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at)) return undefined;
    return { requestStartedAt: at, provider: entry.provider, modelId: entry.model, observed: false };
  }
  return undefined;
}

/**
 * The most recent evidence that a cache entry was alive.
 *
 * A live observation is an exact request start, so it wins over a transcript
 * timestamp, which marks a response end. A warm entry beats a live observation
 * only when it is newer, because Pi's warmer can refresh an entry after the
 * agent's last request.
 *
 * Without a live observation, both remaining sources are response ends for
 * separate events, so the newer one is the better evidence. Taking the warm
 * entry unconditionally would let a stale refresh hide a much later request.
 */
export function latestCacheReference(
  entries: SessionEntry[],
  model: Model<any> | undefined,
  observed: CacheTiming | undefined,
): CacheTiming | undefined {
  const warm = timingFromWarmEntries(entries);
  if (observed) {
    return warm && warm.requestStartedAt > observed.requestStartedAt ? warm : observed;
  }
  const fromTranscript = timingFromTranscript(entries, model);
  if (warm && fromTranscript) {
    return warm.requestStartedAt >= fromTranscript.requestStartedAt ? warm : fromTranscript;
  }
  return warm ?? fromTranscript;
}

/** Read the warning threshold from the environment, falling back to the CLI flag. */
export function readWarnAboveUsd(env: Record<string, string | undefined>, flagValue: string | undefined): number {
  const raw = env.PI_SAFE_RESUME_WARN_USD ?? flagValue;
  if (raw === undefined) return DEFAULT_WARN_ABOVE_USD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_WARN_ABOVE_USD;
  return parsed;
}
