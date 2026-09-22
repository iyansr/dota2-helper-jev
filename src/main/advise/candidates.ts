import type { MatchState, Phase, Role } from "../../shared/match.ts";
import {
  allHeroes,
  getHeroByName,
  getHeroTags,
  getItem,
  getItemTags,
  itemDisplayName,
  matchupRecord,
  popularityFor,
  providingItems,
  situationalItems,
  threatTagsOf,
  wantsOf,
} from "../data/index.ts";
import type { ProvideTag, ThreatTag } from "./tags.ts";

/**
 * Code-side candidate generation (plan §M4). Jev never names an item or a hero —
 * research §4.2, "Generation": the model selects and rates, the code proposes.
 */

export interface ItemCandidate {
  key: string;
  displayName: string;
  cost: number;
  /** Purchases in the snapshot for this hero at this phase; 0 for pure counter-picks. */
  popularity: number;
  /** Popularity normalized against the most-bought candidate, 0..1. */
  popularityNorm: number;
  /**
   * The same fact as a named bucket. Jev ranks now, and it never sees raw numbers
   * (research §4.2) — so popularity reaches it as words or not at all.
   */
  popularityBucket: string;
  goldToGo: number;
  /** Gold-to-go as a named bucket, for the same reason. */
  costBucket: string;
  /** Threat tags this item answers that the reported enemies actually have. */
  matchedTags: ThreatTag[];
  /** Console names of the enemies those tags came from — what the "why" line may name. */
  matchedHeroes: string[];
  /** What this item provides that the player's own hero actually wants. */
  matchedWants: ProvideTag[];
  /** Curated effect text, or null when the item is uncurated (never sent to Jev). */
  effect: string | null;
  /** Why it is in the list at all. */
  reason: "popular" | "counter" | "synergy";
}

export interface HeroCandidate {
  id: number;
  name: string;
  displayName: string;
  roles: string[];
  /**
   * Win rate against the reported enemies, shrunk toward 50% by how many games back
   * it, or null with no usable matchups.
   */
  matchupWinrate: number | null;
  /** Enemies this candidate has a usable matchup against. */
  matchupSamples: number;
  /** The same fact as a phrase — the model ranks now, and never sees raw numbers. */
  matchupBucket: string;
  threat: string | null;
  tags: ThreatTag[];
}

const MAX_ITEM_CANDIDATES = 10;
const MAX_HERO_CANDIDATES = 12;

/** Items that are never a suggestion even when they top the popularity table. */
const NEVER_SUGGEST = new Set([
  "item_tpscroll",
  "item_clarity",
  "item_flask",
  "item_tango",
  "item_tango_single",
  "item_enchanted_mango",
  "item_ward_observer",
  "item_ward_dispenser",
  "item_bottle",
  "item_smoke_of_deceit",
  "item_dust",
  "item_faerie_fire",
]);

/**
 * An item the snapshot prices at zero is one the shop does not sell: aegis, neutral
 * items, and — the case that actually bit — items Valve has removed, which linger in
 * OpenDota's constants with a null cost and would otherwise be suggested as free.
 */
function buyable(key: string): boolean {
  return (getItem(key)?.cost ?? 0) > 0;
}

/** Everything the player already has: inventory, stash, and what went into it. */
function ownedKeys(state: MatchState): Set<string> {
  const owned = new Set<string>([...state.items.slots, ...state.items.stash]);
  // A Battle Fury in the bag means its components are spent, not still wanted.
  const expand = (key: string, depth = 0): void => {
    if (depth > 3) return;
    for (const component of getItem(key)?.components ?? []) {
      if (owned.has(component)) continue;
      owned.add(component);
      expand(component, depth + 1);
    }
  };
  for (const key of [...owned]) expand(key);
  if (state.items.neutral) owned.add(state.items.neutral);
  return owned;
}

export function itemCandidates(state: MatchState, phase: Phase): ItemCandidate[] {
  const owned = ownedKeys(state);
  const enemies = state.reported.enemies.value;
  const enemyTags = threatTagsOf(enemies);
  const wants = wantsOf(state.hero.name);

  const build = (key: string, popularity: number, reason: ItemCandidate["reason"]): ItemCandidate => {
    const item = getItem(key);
    const tags = getItemTags(key);
    const matched = (tags?.counters ?? []).filter((tag) => enemyTags.has(tag));
    // Only the enemies this item actually answers may be named in the suggestion.
    const matchedHeroes = enemies.filter((hero) =>
      (getHeroTags(hero)?.tags ?? []).some((tag) => matched.includes(tag)),
    );
    return {
      key,
      displayName: itemDisplayName(key),
      cost: item?.cost ?? 0,
      popularity,
      popularityNorm: 0,
      popularityBucket: "not a standard pickup on this hero",
      goldToGo: Math.max(0, (item?.cost ?? 0) - state.gold.total),
      costBucket: describeCost(Math.max(0, (item?.cost ?? 0) - state.gold.total), state.gold.gpm),
      matchedTags: matched,
      matchedHeroes,
      matchedWants: (tags?.provides ?? []).filter((tag) => wants.has(tag)),
      effect: tags?.effect ?? null,
      reason,
    };
  };

  const candidates = new Map<string, ItemCandidate>();

  for (const [key, count] of popularityFor(state.hero.id, phase)) {
    if (owned.has(key) || NEVER_SUGGEST.has(key) || !buyable(key)) continue;
    candidates.set(key, build(key, count, "popular"));
  }

  // The counter-pick half: situational items whose `counters` intersect the union of
  // the reported enemies' threat tags. With no enemies reported this adds nothing, and
  // the advisor degrades to popularity — which is the point (plan §5).
  for (const { key, tags } of situationalItems()) {
    if (owned.has(key) || NEVER_SUGGEST.has(key) || !buyable(key)) continue;
    if (!tags.counters.some((tag) => enemyTags.has(tag))) continue;
    const existing = candidates.get(key);
    if (existing) {
      existing.reason = "counter";
      continue;
    }
    candidates.set(key, build(key, 0, "counter"));
  }

  // The synergy half: items that give the player's own hero what its kit needs.
  // Earthshaker wants a blink because Echo Slam has to land on a group — that is not
  // a counter to anything, so the tag intersection above would never surface it.
  for (const { key, tags } of providingItems()) {
    if (owned.has(key) || NEVER_SUGGEST.has(key) || !buyable(key)) continue;
    if (!(tags.provides ?? []).some((tag) => wants.has(tag))) continue;
    if (candidates.has(key)) continue;
    candidates.set(key, build(key, 0, "synergy"));
  }

  const list = [...candidates.values()];
  const maxPopularity = Math.max(1, ...list.map((c) => c.popularity));
  for (const candidate of list) {
    candidate.popularityNorm = candidate.popularity / maxPopularity;
    candidate.popularityBucket = describePopularity(candidate.popularityNorm, candidate.popularity);
  }

  // Counters sort in on merit, not popularity, so keep them from being crowded out by
  // the top of the popularity table before the ranker has seen them.
  return list
    .sort((a, b) => scoreForShortlist(b) - scoreForShortlist(a))
    .slice(0, MAX_ITEM_CANDIDATES);
}

function describeMatchup(winrate: number | null, samples: number): string {
  if (winrate === null || samples === 0) return "no reliable head-to-head record against their picks";
  if (winrate >= 0.55) return "wins clearly more often than not against their picks";
  if (winrate >= 0.52) return "wins slightly more often than not against their picks";
  if (winrate > 0.48) return "roughly even against their picks";
  if (winrate > 0.45) return "loses slightly more often than not against their picks";
  return "loses clearly more often than not against their picks";
}

/**
 * Games-weighted mean, pulled toward 50% by a prior worth `PRIOR_GAMES` coin flips.
 * Without it a single 61%-over-52-games matchup outranks four solid ones, which is
 * how a small sample turns into a confident-looking recommendation.
 */
const PRIOR_GAMES = 150;

function shrunkWinrate(records: ReadonlyArray<{ games: number; winrate: number }>): number | null {
  if (records.length === 0) return null;
  let games = PRIOR_GAMES;
  let wins = PRIOR_GAMES * 0.5;
  for (const record of records) {
    games += record.games;
    wins += record.games * record.winrate;
  }
  return wins / games;
}

/**
 * Gold-to-go in units the player thinks in: minutes of farm, using their own GPM.
 * The number itself stays in code for the UI; only this phrase reaches the model.
 */
function describeCost(goldToGo: number, gpm: number): string {
  if (goldToGo <= 0) return "affordable right now";
  const minutes = gpm > 0 ? goldToGo / gpm : Infinity;
  if (minutes <= 1) return "about a minute of farm away";
  if (minutes <= 3) return "a few minutes of farm away";
  if (minutes <= 6) return "a long way off, several minutes of farm";
  return "far out of reach for now";
}

function describePopularity(norm: number, raw: number): string {
  if (raw === 0) return "not a standard pickup on this hero at this stage";
  if (norm >= 0.8) return "one of the most bought items on this hero at this stage";
  if (norm >= 0.35) return "commonly built on this hero at this stage";
  return "occasionally built on this hero at this stage";
}

function scoreForShortlist(c: ItemCandidate): number {
  return c.popularityNorm + c.matchedTags.length * 0.5 + c.matchedWants.length * 0.4;
}

/** Heroes the role filter allows. OpenDota roles are coarse; this is a shortlist, not a rule. */
const ROLE_TO_OPENDOTA: Record<Role, string[]> = {
  carry: ["Carry"],
  mid: ["Carry", "Nuker"],
  offlane: ["Initiator", "Durable"],
  "soft support": ["Support", "Nuker", "Disabler"],
  "hard support": ["Support", "Disabler"],
};

export function heroCandidates(state: MatchState): HeroCandidate[] {
  // With nothing reported there is nothing to rank against: every hero would come back
  // with no matchup and no gap to fill, and five "thin data" rows are worse than the
  // panel's prompt to enter the picks.
  if (state.reported.enemies.value.length === 0 && state.reported.allies.value.length === 0) {
    return [];
  }

  const taken = new Set([
    ...state.reported.enemies.value,
    ...state.reported.allies.value,
    // Never suggest the hero already being played.
    ...(state.hero.name ? [state.hero.name] : []),
  ]);
  const enemyIds = state.reported.enemies.value
    .map((name) => getHeroByName(name)?.id)
    .filter((id): id is number => typeof id === "number");
  const role = state.reported.role.value;
  const wanted = role ? ROLE_TO_OPENDOTA[role] : null;

  const scored: HeroCandidate[] = [];
  for (const hero of allHeroes()) {
    if (taken.has(hero.name)) continue;
    if (wanted && !hero.roles.some((r) => wanted.includes(r))) continue;

    const records = enemyIds
      .map((enemyId) => matchupRecord(hero.id, enemyId))
      .filter((r): r is { games: number; winrate: number } => r !== null);
    const tags = getHeroTags(hero.name);
    scored.push({
      id: hero.id,
      name: hero.name,
      displayName: hero.displayName,
      roles: hero.roles,
      matchupWinrate: shrunkWinrate(records),
      matchupSamples: records.length,
      matchupBucket: describeMatchup(shrunkWinrate(records), records.length),
      threat: tags?.threat ?? null,
      tags: tags?.tags ?? [],
    });
  }

  return scored
    .sort((a, b) => (b.matchupWinrate ?? 0.5) - (a.matchupWinrate ?? 0.5))
    .slice(0, MAX_HERO_CANDIDATES);
}
