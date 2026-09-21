import assert from "node:assert/strict";
import { test } from "node:test";
import { Guard } from "../src/guard.ts";
import type { PendingAction } from "../src/types.ts";

const message: PendingAction = { kind: "message", text: "continue the task" };
const compact: PendingAction = { kind: "compact" };

test("an armed guard intercepts and captures the action", () => {
  const guard = new Guard();
  assert.equal(guard.phase.kind, "armed");
  assert.equal(guard.intercept(message), true);
  assert.deepEqual(guard.phase, { kind: "awaiting-choice", action: message });
});

test("a guard that is not armed lets the action through", () => {
  const guard = new Guard();
  assert.equal(guard.intercept(message), true);
  assert.equal(guard.intercept(compact), false);
  assert.deepEqual(guard.phase, { kind: "awaiting-choice", action: message });
});

test("Continue records the accepted action, and settling re-arms the guard", () => {
  const guard = new Guard();
  guard.intercept(message);
  guard.accept();
  assert.deepEqual(guard.phase, { kind: "accepted", action: message });
  guard.settle();
  assert.equal(guard.phase.kind, "armed");
});

test("a settled guard can warn again on a later idle period", () => {
  const guard = new Guard();
  guard.intercept(message);
  guard.accept();
  guard.settle();
  assert.equal(guard.intercept(compact), true);
});

test("Cancel sends nothing and re-arms the guard", () => {
  const guard = new Guard();
  guard.intercept(message);
  guard.cancel();
  assert.equal(guard.phase.kind, "armed");
  assert.equal(guard.intercept(message), true);
});

test("a handoff hands the captured action to the transition, then re-arms", () => {
  const guard = new Guard();
  guard.intercept(compact);
  assert.deepEqual(guard.beginHandoff(), compact);
  assert.deepEqual(guard.phase, { kind: "handing-off", action: compact });
  guard.completeHandoff();
  assert.equal(guard.phase.kind, "armed");
});

test("a failed handoff still re-arms, so nothing continues silently", () => {
  const guard = new Guard();
  guard.intercept(message);
  guard.beginHandoff();
  guard.completeHandoff();
  assert.equal(guard.phase.kind, "armed");
  assert.equal(guard.intercept(message), true);
});

test("out-of-phase transitions are ignored rather than corrupting the phase", () => {
  const guard = new Guard();
  guard.accept();
  guard.settle();
  guard.cancel();
  guard.completeHandoff();
  assert.equal(guard.phase.kind, "armed");

  guard.intercept(message);
  guard.beginHandoff();
  assert.equal(guard.beginHandoff(), undefined);
  assert.equal(guard.intercept(compact), false);
  assert.deepEqual(guard.phase, { kind: "handing-off", action: message });
});

test("reset forgets everything", () => {
  const guard = new Guard();
  guard.intercept(message);
  guard.reset();
  assert.equal(guard.phase.kind, "armed");
});
