import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessRisk,
  CacheTimingTracker,
  DEFAULT_UNKNOWN_EXPIRY_MS,
  DEFAULT_WARN_ABOVE_USD,
  estimateColdCost,
  hasPromptCache,
  lastPromptTokens,
  latestCacheReference,
  readWarnAboveUsd,
  resolveRetentionMs,
  resolveRetentionTier,
  timingFromTranscript,
  timingFromWarmEntries,
} from "../src/risk.ts";
import type { CacheTiming } from "../src/types.ts";
import type { RiskInput } from "../src/types.ts";
import { assistantEntry, HOUR, MINUTE, NOW, stubModel, usage, userEntry } from "./helpers.ts";

function closeTo(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
}

function riskInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    model: stubModel({ promptCache: { short: 300 } }),
    contextTokens: 500_000,
    contextPercent: 70,
    timing: { requestStartedAt: NOW - 2 * HOUR, provider: "stub-provider", modelId: "stub-model", observed: true },
    retentionMs: 60 * MINUTE,
    retentionTier: "short",
    now: NOW,
    warnAboveUsd: DEFAULT_WARN_ABOVE_USD,
    unknownExpiryMs: DEFAULT_UNKNOWN_EXPIRY_MS,
    ...overrides,
  };
}

/** A `cache_warm` usage entry, the only record of Pi's own cache warmer. */
function warmEntry(id: string, parentId: string | null, at: number) {
  return {
    type: "usage",
    id,
    parentId,
    timestamp: new Date(at).toISOString(),
    kind: "cache_warm",
    provider: "stub-provider",
    model: "stub-model",
    usage: usage({ cacheRead: 400_000 }),
  } as never;
}

test("a cold continuation is billed as a cache write when the model charges for writes", () => {
  const estimate = estimateColdCost(stubModel(), 500_000);
  assert.equal(estimate.cacheWriteTokens, 500_000);
  assert.equal(estimate.uncachedInputTokens, 0);
  closeTo(estimate.costUsd, 1.875);
});

test("a cold continuation is billed as plain input when the model charges nothing for writes", () => {
  const estimate = estimateColdCost(stubModel({ cacheWrite: 0 }), 500_000);
  assert.equal(estimate.cacheWriteTokens, 0);
  assert.equal(estimate.uncachedInputTokens, 500_000);
  closeTo(estimate.costUsd, 1.5);
});

test("a pricing tier applies to the whole request once its threshold is crossed", () => {
  const tiers = [{ inputTokensAbove: 200_000, input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 }];
  const model = stubModel({ tiers });
  closeTo(estimateColdCost(model, 500_000).costUsd, 3.75);
  closeTo(estimateColdCost(model, 100_000).costUsd, 0.375);
});

test("a model with no prompt caching at all never warns", () => {
  const model = stubModel({ cacheRead: 0, cacheWrite: 0 });
  assert.equal(hasPromptCache(model), false);
  assert.deepEqual(assessRisk(riskInput({ model })), { kind: "pass", reason: "no-prompt-cache" });
});

test("an expensive session past its retention window warns and reports the window it used", () => {
  const assessment = assessRisk(riskInput());
  assert.equal(assessment.kind, "warn");
  if (assessment.kind !== "warn") return;
  assert.equal(assessment.expiry, "expired");
  assert.equal(assessment.idleMs, 2 * HOUR);
  assert.equal(assessment.windowMs, 60 * MINUTE);
  assert.equal(assessment.estimate.contextTokens, 500_000);
  closeTo(assessment.estimate.costUsd, 1.875);
});

test("a session inside its retention window does not warn", () => {
  const timing = { requestStartedAt: NOW - 10 * MINUTE, provider: "p", modelId: "m", observed: true };
  assert.deepEqual(assessRisk(riskInput({ timing })), { kind: "pass", reason: "recent" });
});

test("a cheap cold reload does not warn even when the cache has expired", () => {
  assert.deepEqual(assessRisk(riskInput({ contextTokens: 100_000 })), { kind: "pass", reason: "cheap" });
});

test("raising the threshold above the estimate suppresses the warning", () => {
  assert.deepEqual(assessRisk(riskInput({ warnAboveUsd: 2 })), { kind: "pass", reason: "cheap" });
});

test("a model that publishes no cache lifetime warns as unknown rather than inventing an expiry", () => {
  const assessment = assessRisk(
    riskInput({
      retentionMs: undefined,
      timing: { requestStartedAt: NOW - 30 * MINUTE, provider: "p", modelId: "m", observed: true },
    }),
  );
  assert.equal(assessment.kind, "warn");
  if (assessment.kind !== "warn") return;
  assert.equal(assessment.expiry, "unknown");
  assert.equal(assessment.windowMs, DEFAULT_UNKNOWN_EXPIRY_MS);
  assert.equal(assessment.idleMs, 30 * MINUTE);
});

test("a large unpriced session warns with no dollar figure", () => {
  const model = stubModel({ input: 0, cacheRead: 0.1, cacheWrite: 0 });
  const assessment = assessRisk(riskInput({ model, contextPercent: 80 }));
  assert.equal(assessment.kind, "warn");
  if (assessment.kind !== "warn") return;
  assert.equal(assessment.estimate.costUsd, 0);
});

test("an unpriced session that is not large stays quiet", () => {
  const model = stubModel({ input: 0, cacheRead: 0.1, cacheWrite: 0 });
  assert.deepEqual(assessRisk(riskInput({ model, contextPercent: 20 })), { kind: "pass", reason: "cheap" });
});

test("missing inputs pass through instead of warning", () => {
  assert.deepEqual(assessRisk(riskInput({ model: undefined })), { kind: "pass", reason: "no-model" });
  assert.deepEqual(assessRisk(riskInput({ contextTokens: null })), { kind: "pass", reason: "unknown-context" });
  assert.deepEqual(assessRisk(riskInput({ contextTokens: 0 })), { kind: "pass", reason: "unknown-context" });
  assert.deepEqual(assessRisk(riskInput({ timing: undefined })), { kind: "pass", reason: "no-timing" });
});

test("the retention tier follows PI_CACHE_RETENTION and defaults to short", () => {
  assert.equal(resolveRetentionTier({}), "short");
  assert.equal(resolveRetentionTier({ PI_CACHE_RETENTION: "long" }), "long");
  assert.equal(resolveRetentionTier({ PI_CACHE_RETENTION: "short" }), "short");
  assert.equal(resolveRetentionTier({ PI_CACHE_RETENTION: "none" }), "none");
  assert.equal(resolveRetentionTier({ PI_CACHE_RETENTION: "nonsense" }), "short");
});

test("a long cache write costs twice the base input rate", () => {
  const model = stubModel({ input: 3, cacheWrite: 3.75, promptCache: { short: 300, long: 3600 } });
  closeTo(estimateColdCost(model, 500_000, "short").costUsd, 1.875);
  closeTo(estimateColdCost(model, 500_000, "long").costUsd, 3);
});

test("a long tier does not re-price a provider that charges nothing for writes", () => {
  const model = stubModel({ input: 3, cacheWrite: 0, promptCache: { long: 3600 } });
  closeTo(estimateColdCost(model, 500_000, "long").costUsd, 1.5);
});

test("a long-retention session warns where the short-rate estimate would stay quiet", () => {
  const model = stubModel({ input: 3, cacheWrite: 3.75, promptCache: { short: 300, long: 3600 } });
  const base = riskInput({ model, contextTokens: 250_000, retentionMs: 3_600_000 });
  assert.equal(assessRisk({ ...base, retentionTier: "short" }).kind, "pass");
  const long = assessRisk({ ...base, retentionTier: "long" });
  assert.equal(long.kind, "warn");
  if (long.kind !== "warn") return;
  closeTo(long.estimate.costUsd, 1.5);
});

test("turning caching off stops the warning entirely", () => {
  assert.deepEqual(assessRisk(riskInput({ retentionTier: "none", retentionMs: undefined })), {
    kind: "pass",
    reason: "no-prompt-cache",
  });
});

test("the retention window comes from the model's published metadata", () => {
  const model = stubModel({ promptCache: { short: 300, long: 3600 } });
  assert.equal(resolveRetentionMs(model, "short"), 300_000);
  assert.equal(resolveRetentionMs(model, "long"), 3_600_000);
  assert.equal(resolveRetentionMs(stubModel(), "short"), undefined);
  assert.equal(resolveRetentionMs(stubModel({ promptCache: { long: 3600 } }), "short"), undefined);
});

test("the last prompt size is the sum of every input bucket the provider reported", () => {
  const entries = [
    userEntry("u1", null, "hello"),
    assistantEntry("a1", "u1", "one", NOW, usage({ input: 100, cacheRead: 400_000, cacheWrite: 50 })),
    assistantEntry("a2", "a1", "two", NOW, usage({ input: 7, cacheRead: 20, cacheWrite: 3 })),
  ];
  assert.equal(lastPromptTokens(entries), 30);
  assert.equal(lastPromptTokens([]), 0);
});

test("an assistant entry with no reported usage is skipped", () => {
  const entries = [
    assistantEntry("a1", null, "one", NOW, usage({ input: 10, cacheRead: 90 })),
    { type: "message", id: "a2", parentId: "a1", timestamp: new Date(NOW).toISOString(), message: { role: "assistant", content: [], timestamp: NOW } },
  ] as never;
  assert.equal(lastPromptTokens(entries), 100);
});

test("a request start becomes the cache reference only once a response proves cache use", () => {
  const tracker = new CacheTimingTracker();
  assert.equal(tracker.timing, undefined);
  assert.equal(tracker.confirmCacheRelevant(usage({ cacheRead: 10 })), undefined);

  const model = stubModel();
  tracker.observeRequestStart(NOW, model);
  assert.equal(tracker.timing, undefined);

  assert.equal(tracker.confirmCacheRelevant(usage({ input: 5 })), undefined);
  assert.equal(tracker.timing, undefined);

  const timing = tracker.confirmCacheRelevant(usage({ cacheWrite: 10 }));
  assert.ok(timing);
  assert.equal(timing.requestStartedAt, NOW);
  assert.equal(timing.provider, "stub-provider");
  assert.equal(timing.modelId, "stub-model");
  assert.equal(timing.observed, true);
  assert.deepEqual(tracker.timing, timing);
});

test("a cache read also refreshes the reference", () => {
  const tracker = new CacheTimingTracker();
  tracker.observeRequestStart(NOW - 5 * MINUTE, stubModel());
  assert.ok(tracker.confirmCacheRelevant(usage({ cacheRead: 1 })));
  assert.equal(tracker.timing?.requestStartedAt, NOW - 5 * MINUTE);
});

test("the most recent observed request wins", () => {
  const tracker = new CacheTimingTracker();
  tracker.observeRequestStart(NOW - HOUR, stubModel());
  tracker.observeRequestStart(NOW, stubModel());
  assert.ok(tracker.confirmCacheRelevant(usage({ cacheRead: 1 })));
  assert.equal(tracker.timing?.requestStartedAt, NOW);
});

test("a transcript reference is reconstructed and marked unobserved", () => {
  const entries = [
    userEntry("u1", null, "hello", NOW - 3 * HOUR),
    assistantEntry("a1", "u1", "cached", NOW - 2 * HOUR, usage({ input: 10, cacheWrite: 1000 })),
    assistantEntry("a2", "a1", "uncached", NOW - HOUR, usage({ input: 10 })),
  ];
  const timing = timingFromTranscript(entries, stubModel());
  assert.ok(timing);
  assert.equal(timing.requestStartedAt, NOW - 2 * HOUR);
  assert.equal(timing.observed, false);
  assert.equal(timing.provider, "stub-provider");
});

test("a transcript with no cache-relevant assistant message yields no reference", () => {
  const entries = [userEntry("u1", null, "hello"), assistantEntry("a1", "u1", "plain", NOW, usage({ input: 10 }))];
  assert.equal(timingFromTranscript(entries, stubModel()), undefined);
  assert.equal(timingFromTranscript([], stubModel()), undefined);
});

test("Pi's own cache warming is visible in the transcript", () => {
  const entries = [
    assistantEntry("a1", null, "reply", NOW - 2 * HOUR, usage({ input: 10, cacheWrite: 1000 })),
    warmEntry("w1", "a1", NOW - 20 * MINUTE),
  ];
  const warm = timingFromWarmEntries(entries);
  assert.ok(warm);
  assert.equal(warm.requestStartedAt, NOW - 20 * MINUTE);
  assert.equal(warm.observed, false);
  assert.equal(warm.provider, "stub-provider");
  assert.equal(warm.modelId, "stub-model");
  assert.equal(timingFromWarmEntries([entries[0] as never]), undefined);
});

test("a warm refresh newer than the live observation becomes the reference", () => {
  const entries = [warmEntry("w1", null, NOW - 20 * MINUTE)];
  const observed: CacheTiming = {
    requestStartedAt: NOW - 2 * HOUR,
    provider: "stub-provider",
    modelId: "stub-model",
    observed: true,
  };
  const chosen = latestCacheReference(entries, stubModel(), observed);
  assert.equal(chosen?.requestStartedAt, NOW - 20 * MINUTE);
  assert.equal(chosen?.observed, false);
});

test("a live observation newer than any warm refresh stays the reference", () => {
  const entries = [warmEntry("w1", null, NOW - 2 * HOUR)];
  const observed: CacheTiming = {
    requestStartedAt: NOW - 5 * MINUTE,
    provider: "stub-provider",
    modelId: "stub-model",
    observed: true,
  };
  assert.deepEqual(latestCacheReference(entries, stubModel(), observed), observed);
});

test("without a live observation the warm entry, then the transcript, is used", () => {
  const warmOnly = latestCacheReference([warmEntry("w1", null, NOW - 20 * MINUTE)], stubModel(), undefined);
  assert.equal(warmOnly?.requestStartedAt, NOW - 20 * MINUTE);

  const assistantOnly = latestCacheReference(
    [assistantEntry("a1", null, "reply", NOW - 2 * HOUR, usage({ cacheWrite: 1000 }))],
    stubModel(),
    undefined,
  );
  assert.equal(assistantOnly?.requestStartedAt, NOW - 2 * HOUR);

  assert.equal(latestCacheReference([], stubModel(), undefined), undefined);
});

test("the warning threshold reads the environment, then the flag, then the default", () => {
  assert.equal(readWarnAboveUsd({}, undefined), DEFAULT_WARN_ABOVE_USD);
  assert.equal(readWarnAboveUsd({ PI_SAFE_RESUME_WARN_USD: "2.5" }, undefined), 2.5);
  assert.equal(readWarnAboveUsd({}, "0.25"), 0.25);
  assert.equal(readWarnAboveUsd({ PI_SAFE_RESUME_WARN_USD: "0.5" }, "9"), 0.5);
  assert.equal(readWarnAboveUsd({ PI_SAFE_RESUME_WARN_USD: "garbage" }, undefined), DEFAULT_WARN_ABOVE_USD);
  assert.equal(readWarnAboveUsd({ PI_SAFE_RESUME_WARN_USD: "-1" }, undefined), DEFAULT_WARN_ABOVE_USD);
  assert.equal(readWarnAboveUsd({ PI_SAFE_RESUME_WARN_USD: "0" }, undefined), 0);
});
