import type { MatchState, Phase } from "../../shared/match.ts";
import { phaseOf } from "../match/situation.ts";
import type { MatchChange } from "../match/store.ts";

/**
 * When to ask for new advice (plan §3.1). Never per GSI tick: Dota throttles to about
 * ten payloads a second, and a request per tick would be both useless and expensive.
 *
 * Item advisor fires on: item bought or sold · death · respawn · gold crossing the
 * cost of the current top candidate · phase change · the user editing the enemy list.
 * Draft advisor fires on any change to picks, bans, or role.
 */
const ITEM_DEBOUNCE_MS = 2000;
const DRAFT_DEBOUNCE_MS = 1000;

export type TriggerReason =
  | "items"
  | "death"
  | "respawn"
  | "gold"
  | "phase"
  | "enemies"
  | "reset";

export class ItemTrigger {
  private phase: Phase | null = null;
  private lastFiredAt = 0;
  private pending: TriggerReason | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Cost of the current top suggestion; crossing it is a decision point. */
  private watchedCost: number | null = null;
  private couldAfford = false;

  constructor(private readonly fire: (reason: TriggerReason) => void) {}

  /** Called by the advice loop whenever a new top suggestion is rendered. */
  watchCost(cost: number | null): void {
    if (cost !== this.watchedCost) {
      this.watchedCost = cost;
      this.couldAfford = false;
    }
  }

  consider(state: MatchState, change: MatchChange): void {
    const phase = phaseOf(state.clock);
    const phaseChanged = this.phase !== null && phase !== this.phase;
    this.phase = phase;

    const canAfford = this.watchedCost !== null && state.gold.total >= this.watchedCost;
    const crossedGold = canAfford && !this.couldAfford;
    this.couldAfford = canAfford;

    const reason: TriggerReason | null = change.reset
      ? "reset"
      : change.died
        ? "death"
        : change.respawned
          ? "respawn"
          : change.itemsChanged
            ? "items"
            : change.reportChanged
              ? "enemies"
              : phaseChanged
                ? "phase"
                : crossedGold
                  ? "gold"
                  : null;

    if (reason) this.schedule(reason);
  }

  private schedule(reason: TriggerReason): void {
    this.pending = reason;
    if (this.timer) return;
    // Trailing debounce: a burst of purchases in the shop is one decision, not six.
    const wait = Math.max(0, ITEM_DEBOUNCE_MS - (Date.now() - this.lastFiredAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.pending;
      this.pending = null;
      if (!pending) return;
      this.lastFiredAt = Date.now();
      this.fire(pending);
    }, Math.max(wait, ITEM_DEBOUNCE_MS / 4));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Draft changes only ever come from the user, so this is a plain debounce. */
export class DraftTrigger {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly fire: () => void) {}

  bump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire();
    }, DRAFT_DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
