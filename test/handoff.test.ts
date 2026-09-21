import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHandoff,
  buildSessionLink,
  CONTINUATION_INSTRUCTION,
  estimateTextTokens,
  extractText,
  formatHandoffSummary,
  HANDOFF_TOKEN_BUDGET,
  renderHandoff,
} from "../src/handoff.ts";
import {
  assistantEntry,
  compactionEntry,
  NOW,
  textOfTokens,
  usage,
  userEntry,
} from "./helpers.ts";

const HUGE = textOfTokens(30_000, "detail");

function linear() {
  return [
    userEntry("u1", null, "ORIGINAL-TASK: build the widget"),
    assistantEntry("a1", "u1", "I started on the widget."),
    userEntry("u2", "a1", "keep going"),
    assistantEntry("a2", "u2", "MOST-RECENT: the widget compiles."),
  ];
}

test("an existing compaction summary is reused rather than regenerated", () => {
  const entries = [
    compactionEntry("c1", null, "SUMMARY-MARKER: earlier work was compacted"),
    userEntry("u1", "c1", "ORIGINAL-TASK"),
    assistantEntry("a1", "u1", "MOST-RECENT"),
  ];
  const handoff = buildHandoff(entries, { leafId: "a1" });
  const summary = handoff.blocks.find((block) => block.role === "summary");
  assert.ok(summary, "expected the compaction summary to be carried over");
  assert.match(summary.text, /SUMMARY-MARKER/);
  assert.equal(summary.entryId, "c1");
});

test("the handoff carries the original task and the most recent assistant response", () => {
  const handoff = buildHandoff(linear(), { leafId: "a2" });
  const roles = handoff.blocks.map((block) => block.role);
  assert.ok(roles.includes("user"));
  assert.ok(roles.includes("assistant"));
  const all = handoff.blocks.map((block) => block.text).join("\n");
  assert.match(all, /ORIGINAL-TASK/);
  assert.match(all, /MOST-RECENT/);
  assert.equal(handoff.blocks.find((block) => block.text.includes("MOST-RECENT"))?.entryId, "a2");
});

test("a compaction summary is preferred over a later duplicate", () => {
  const entries = [
    compactionEntry("c1", null, "FIRST-SUMMARY"),
    userEntry("u1", "c1", "task"),
    compactionEntry("c2", "u1", "LATEST-SUMMARY"),
    userEntry("u2", "c2", "more"),
    assistantEntry("a1", "u2", "reply"),
  ];
  const handoff = buildHandoff(entries, { leafId: "a1" });
  const summaries = handoff.blocks.filter((block) => block.role === "summary");
  assert.equal(summaries.length, 1);
  assert.match(summaries[0]?.text ?? "", /LATEST-SUMMARY/);
});

test("the handoff never exceeds its token budget", () => {
  const entries = [
    userEntry("u1", null, HUGE),
    assistantEntry("a1", "u1", HUGE),
    userEntry("u2", "a1", HUGE),
    assistantEntry("a2", "u2", HUGE),
  ];
  const handoff = buildHandoff(entries, { leafId: "a2", budgetTokens: HANDOFF_TOKEN_BUDGET });
  assert.ok(handoff.tokens <= HANDOFF_TOKEN_BUDGET, `handoff spent ${handoff.tokens} tokens`);
  const measured = handoff.blocks.reduce((total, block) => total + estimateTextTokens(block.text), 0);
  assert.ok(measured <= HANDOFF_TOKEN_BUDGET, `measured ${measured} tokens`);
});

test("an oversized excerpt is bounded and labelled as shortened", () => {
  const entries = [userEntry("u1", null, HUGE), assistantEntry("a1", "u1", "short reply")];
  const handoff = buildHandoff(entries, { leafId: "a1", budgetTokens: HANDOFF_TOKEN_BUDGET });
  const shortened = handoff.blocks.filter((block) => block.truncated);
  assert.ok(shortened.length > 0, "expected at least one shortened block");
  assert.ok(
    handoff.omitted.some((label) => /shortened/.test(label)),
    `expected a shortened label, got ${JSON.stringify(handoff.omitted)}`,
  );
});

test("a per-excerpt text limit applies even inside a generous token budget", () => {
  const entries = [userEntry("u1", null, HUGE)];
  const handoff = buildHandoff(entries, { leafId: "u1", budgetTokens: 1_000_000, maxBytes: 2_000 });
  const block = handoff.blocks[0];
  assert.ok(block?.truncated);
  assert.ok(block.text.length > 0, "a single long line must not be dropped entirely");
  assert.ok(block.text.length < HUGE.length);
  assert.match(block.text, /\[truncated\]/);
});

test("dropped material is listed so the handoff never implies completeness", () => {
  const entries = [
    userEntry("u1", null, HUGE),
    assistantEntry("a1", "u1", HUGE),
    userEntry("u2", "a1", HUGE),
    userEntry("u3", "u2", HUGE),
    assistantEntry("a2", "u3", HUGE),
  ];
  const handoff = buildHandoff(entries, { leafId: "a2", budgetTokens: 200 });
  assert.ok(handoff.omitted.length > 0);
  assert.ok(handoff.omitted.some((label) => /not represented/.test(label)));
});

test("the leaf id restricts the handoff to one branch", () => {
  const entries = [
    userEntry("u1", null, "shared root"),
    assistantEntry("a1", "u1", "BRANCH-A-ONLY"),
    userEntry("u2", "u1", "BRANCH-B-ONLY"),
    assistantEntry("a2", "u2", "branch b reply"),
  ];
  const onA = buildHandoff(entries, { leafId: "a1" }).blocks.map((block) => block.text).join("\n");
  assert.match(onA, /BRANCH-A-ONLY/);
  assert.doesNotMatch(onA, /BRANCH-B-ONLY/);

  const onB = buildHandoff(entries, { leafId: "a2" }).blocks.map((block) => block.text).join("\n");
  assert.match(onB, /BRANCH-B-ONLY/);
  assert.doesNotMatch(onB, /BRANCH-A-ONLY/);
});

test("a rendered handoff states that it is bounded and carries the continuation instruction", () => {
  const handoff = buildHandoff(linear(), { leafId: "a2" });
  const link = buildSessionLink("/tmp/source.jsonl", "a2", handoff, NOW);
  const rendered = renderHandoff(handoff, link, 480_000);
  assert.match(rendered, /not a complete record/);
  assert.match(rendered, /\/tmp\/source\.jsonl/);
  assert.match(rendered, /about 480000 tokens/);
  assert.ok(rendered.includes(CONTINUATION_INSTRUCTION));
  assert.match(rendered, /\[user, entry u1\]/);
  assert.match(rendered, /\[assistant, entry a2\]/);
});

test("a shortened block is labelled in the rendered handoff", () => {
  const entries = [userEntry("u1", null, HUGE)];
  const handoff = buildHandoff(entries, { leafId: "u1", budgetTokens: 400 });
  const rendered = renderHandoff(handoff, buildSessionLink("/tmp/s.jsonl", "u1", handoff, NOW), null);
  assert.match(rendered, /shortened/);
  assert.match(rendered, /unknown number of tokens/);
});

test("non-text entries and tool traffic are left out of the handoff", () => {
  const entries = [
    userEntry("u1", null, "task"),
    { type: "message", id: "t1", parentId: "u1", timestamp: new Date(NOW).toISOString(), message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "TOOL-OUTPUT" }] } },
    { type: "model_change", id: "m1", parentId: "t1", timestamp: new Date(NOW).toISOString(), provider: "p", modelId: "m" },
    assistantEntry("a1", "m1", "reply"),
  ] as never;
  const handoff = buildHandoff(entries, { leafId: "a1" });
  const all = handoff.blocks.map((block) => block.text).join("\n");
  assert.doesNotMatch(all, /TOOL-OUTPUT/);
  assert.equal(extractText({ type: "model_change", id: "x", parentId: null, timestamp: "", provider: "p", modelId: "m" } as never), undefined);
});

test("an assistant entry with a compaction summary and no text is skipped", () => {
  assert.equal(extractText(compactionEntry("c1", null, "   ")), undefined);
  assert.deepEqual(extractText(userEntry("u1", null, "  hello  ")), { role: "user", text: "hello" });
  assert.equal(extractText(assistantEntry("a1", null, "")), undefined);
});

test("a session link records the source file, the branch tip, and the handoff size", () => {
  const handoff = buildHandoff(linear(), { leafId: "a2" });
  const link = buildSessionLink("/tmp/source.jsonl", "a2", handoff, NOW);
  assert.deepEqual(link, {
    sourceSessionFile: "/tmp/source.jsonl",
    sourceLeafId: "a2",
    createdAt: NOW,
    handoffTokens: handoff.tokens,
  });
  assert.match(formatHandoffSummary(link), /branch tip a2/);
});

test("assistant usage does not leak into the extracted text", () => {
  const entries = [assistantEntry("a1", null, "visible text", NOW, usage({ input: 10, cacheWrite: 5 }))];
  const handoff = buildHandoff(entries, { leafId: "a1" });
  assert.equal(handoff.blocks.length, 1);
  assert.equal(handoff.blocks[0]?.text, "visible text");
});
