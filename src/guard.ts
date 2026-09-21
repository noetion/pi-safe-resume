/**
 * The guard is a four-phase state machine, one instance per session.
 *
 *   armed ──intercept──▶ awaiting-choice ──accept──▶ accepted ──settle──▶ armed
 *                              │
 *                              └──beginHandoff──▶ handing-off ──complete──▶ armed
 *
 * Modelling it as a phase rather than a set of booleans is what keeps the
 * "do not ask twice" and "do not silently continue expensively" rules provable:
 * only `armed` intercepts, and every path out of `awaiting-choice` ends
 * somewhere explicit.
 */
import type { PendingAction } from "./types.ts";

export type GuardPhase =
  | { kind: "armed" }
  | { kind: "awaiting-choice"; action: PendingAction }
  | { kind: "accepted"; action: PendingAction }
  | { kind: "handing-off"; action: PendingAction };

export class Guard {
  private state: GuardPhase = { kind: "armed" };

  get phase(): GuardPhase {
    return this.state;
  }

  /**
   * Claim an action for the guard. Returns false when the guard is not armed,
   * in which case the caller must let the action through untouched.
   */
  intercept(action: PendingAction): boolean {
    if (this.state.kind !== "armed") return false;
    this.state = { kind: "awaiting-choice", action };
    return true;
  }

  /** The developer chose Continue: the original action proceeds and the guard stops asking. */
  accept(): void {
    if (this.state.kind !== "awaiting-choice") return;
    this.state = { kind: "accepted", action: this.state.action };
  }

  /** The developer cancelled: nothing is sent and the message stays recoverable. */
  cancel(): void {
    if (this.state.kind !== "awaiting-choice") return;
    this.state = { kind: "armed" };
  }

  /** The developer chose a replacement session. Hands the captured action to the transition. */
  beginHandoff(): PendingAction | undefined {
    if (this.state.kind !== "awaiting-choice") return undefined;
    const { action } = this.state;
    this.state = { kind: "handing-off", action };
    return action;
  }

  /** The transition finished, or failed. Either way the guard returns to armed. */
  completeHandoff(): void {
    if (this.state.kind !== "handing-off") return;
    this.state = { kind: "armed" };
  }

  /** A run settled. Re-arm after an accepted continuation so a later idle period reassesses. */
  settle(): void {
    if (this.state.kind !== "accepted") return;
    this.state = { kind: "armed" };
  }

  /** Forget everything, used when the session runtime is replaced. */
  reset(): void {
    this.state = { kind: "armed" };
  }
}
