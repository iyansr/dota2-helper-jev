import type { LeadBucket, MatchState, Phase, Situation } from "../../shared/match.ts";

/**
 * The deterministic layer. **All numbers become named buckets here and nowhere else**
 * (plan §2/M2) — Jev is bad at arithmetic and comparison, so it never sees a raw
 * number. Anything still numeric below this line stays inside code.
 */

const LANING_ENDS = 10 * 60;
const MID_GAME_ENDS = 25 * 60;

export function phaseOf(clock: number): Phase {
  if (clock < LANING_ENDS) return "laning";
  if (clock < MID_GAME_ENDS) return "mid game";
  return "late game";
}

export function leadBucket(mine: number, theirs: number): LeadBucket {
  const diff = mine - theirs;
  if (diff >= 10) return "far ahead";
  if (diff >= 3) return "ahead";
  if (diff > -3) return "even";
  if (diff > -10) return "behind by a few kills";
  return "far behind";
}

const RECENT_WINDOW = 5 * 60;
/** Roughly two item components' worth — enough that dying for it hurts. */
const BIG_BANK = 1500;

export function describeDeaths(state: MatchState): string {
  const recent = state.deaths.filter((d) => state.clock - d.clock <= RECENT_WINDOW);
  if (state.deaths.length === 0) return "has not died yet";
  if (recent.length === 0) {
    return `died ${state.deaths.length} time${state.deaths.length === 1 ? "" : "s"} this game, but not in the last five minutes`;
  }
  const rich = recent.filter((d) => d.goldHeld >= BIG_BANK).length;
  const base = `died ${recent.length} time${recent.length === 1 ? "" : "s"} in the last five minutes`;
  if (rich === 0) return base;
  return `${base}, ${rich === recent.length ? "each time" : rich === 1 ? "once" : `${rich} times`} while holding over ${BIG_BANK} gold`;
}

export function describeTowers(state: MatchState): string {
  const { mineLost, theirsLost, myTier1Lost } = state.towers;
  if (mineLost === 0 && theirsLost === 0) return "no towers have fallen on either side";
  if (mineLost === 0) return `the enemy has lost ${theirsLost} tower${theirsLost === 1 ? "" : "s"}`;
  if (theirsLost === 0) {
    return myTier1Lost === mineLost
      ? `lost ${mineLost} tier-one tower${mineLost === 1 ? "" : "s"} and the enemy has lost none`
      : `lost ${mineLost} towers including towers past tier one, and the enemy has lost none`;
  }
  if (mineLost > theirsLost) return "losing the tower race — more of our towers have fallen than theirs";
  if (mineLost < theirsLost) return "winning the tower race — more of their towers have fallen than ours";
  return "towers have fallen evenly on both sides";
}

/**
 * Own farm tempo. We cannot see enemy net worth as a player (research §1.4), so this
 * compares GPM against a rough pace for the phase rather than against the other team.
 */
export function describeFarm(state: MatchState): string {
  const gpm = state.gold.gpm;
  if (gpm === 0) return "no farm data yet";
  const pace = state.clock < LANING_ENDS ? 350 : state.clock < MID_GAME_ENDS ? 500 : 600;
  if (gpm >= pace * 1.25) return "farming faster than usual for this point in the game";
  if (gpm >= pace * 0.8) return "roughly on pace with farm for this point in the game";
  return "behind on farm for this point in the game";
}

export function describeRoshan(state: MatchState): string {
  switch (state.roshan.state) {
    case "alive":
      return "Roshan is up";
    case "respawn_base":
    case "respawn_variable":
      return "Roshan has been killed and has not respawned";
    default:
      return "Roshan's state is unknown";
  }
}

export function situationOf(state: MatchState): Situation {
  return {
    phase: phaseOf(state.clock),
    team_lead: leadBucket(state.score.mine, state.score.theirs),
    recent_deaths: describeDeaths(state),
    towers: describeTowers(state),
    net_worth: describeFarm(state),
    roshan: describeRoshan(state),
  };
}

/**
 * Code-side only — never sent to Jev. The gap between the gold on hand and an item's
 * cost, which the ranker turns into an affordability bonus and the UI renders as a
 * number the player can act on.
 */
export function goldToGo(state: MatchState, cost: number): number {
  return Math.max(0, cost - state.gold.total);
}

/** Seconds of formatted clock, as the game's own timer shows it. */
export function formatClock(clock: number): string {
  const sign = clock < 0 ? "-" : "";
  const abs = Math.abs(Math.floor(clock));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}
