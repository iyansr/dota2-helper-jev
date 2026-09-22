import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../../shared/gsi-token.ts";
import type { HeroTags, ItemTags, ProvideTag, ThreatTag } from "../advise/tags.ts";
import { isProvideTag, isThreatTag } from "../advise/tags.ts";
import type { Phase } from "../../shared/match.ts";

/**
 * The static snapshot. Read once at startup from `data/`, never fetched at runtime
 * (plan §0) — no rate limits, no caching layer, no offline failure mode.
 *
 * `DOTA_HELPER_DATA_DIR` lets the packaged main process point at its resources dir;
 * everything else resolves relative to the repo.
 */
export const DATA_DIR = resolve(process.env.DOTA_HELPER_DATA_DIR ?? join(REPO_ROOT, "data"));

export interface HeroEntry {
  name: string;
  displayName: string;
  roles: string[];
  primaryAttr: string;
  attackType: string;
}

export interface ItemEntry {
  id: number;
  displayName: string;
  cost: number;
  components: string[];
}

export interface AbilityEntry {
  key: string;
  name: string;
  description: string;
  behavior: string | null;
  damageType: string | null;
  piercesSpellImmunity: boolean;
  ultimate: boolean;
}

type PopularityFile = Record<string, Record<Phase, Array<[string, number]>>>;
type MatchupsFile = Record<string, Record<string, { g: number; w: number }>>;

function load<T>(file: string, fallback: T): T {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) {
    console.warn(`data/${file} missing — run \`npm run data:fetch\`. Falling back to empty.`);
    return fallback;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** `_comment` keys document the curated files in place; strip them on load. */
function stripComments<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith("_")) out[key] = value;
  }
  return out;
}

const heroesById = load<Record<string, HeroEntry>>("heroes.json", {});
const items = load<Record<string, ItemEntry>>("items.json", {});
const popularity = load<PopularityFile>("itemPopularity.json", {});
const abilities = load<Record<string, AbilityEntry[]>>("abilities.json", {});
const matchups = load<MatchupsFile>("matchups.json", {});
const heroTags = stripComments(load<Record<string, HeroTags>>("hero-tags.json", {}));
const itemTags = stripComments(load<Record<string, ItemTags>>("item-tags.json", {}));

const heroesByName = new Map<string, HeroEntry & { id: number }>();
for (const [id, hero] of Object.entries(heroesById)) {
  heroesByName.set(hero.name, { ...hero, id: Number(id) });
}

export const allHeroes = (): Array<HeroEntry & { id: number }> => [...heroesByName.values()];

export function getHero(id: number): HeroEntry | null {
  return heroesById[String(id)] ?? null;
}

export function getHeroByName(name: string): (HeroEntry & { id: number }) | null {
  return heroesByName.get(name) ?? null;
}

export function heroDisplayName(name: string | null): string {
  if (!name) return "unknown hero";
  return heroesByName.get(name)?.displayName ?? name.replace("npc_dota_hero_", "").replace(/_/g, " ");
}

export function getItem(key: string): ItemEntry | null {
  return items[key] ?? null;
}

export function itemDisplayName(key: string): string {
  return items[key]?.displayName ?? key.replace("item_", "").replace(/_/g, " ");
}

export function getHeroTags(name: string): HeroTags | null {
  return heroTags[name] ?? null;
}

export function getItemTags(key: string): ItemTags | null {
  return itemTags[key] ?? null;
}

/**
 * A hero's real abilities, from OpenDota. Generated rather than curated, so this
 * covers every hero — unlike the hand-written `kit` summary, which covers the ones
 * someone has written up.
 */
export function getHeroAbilities(heroName: string | null): AbilityEntry[] {
  if (!heroName) return [];
  return abilities[heroName] ?? [];
}

/** What the hero in the player's seat needs from its items, by console name. */
export function wantsOf(heroName: string | null): Set<ProvideTag> {
  const wants = new Set<ProvideTag>();
  if (!heroName) return wants;
  for (const tag of getHeroTags(heroName)?.wants ?? []) {
    if (isProvideTag(tag)) wants.add(tag);
  }
  return wants;
}

/** Every item that provides anything, for the synergy half of candidate generation. */
export function providingItems(): Array<{ key: string; tags: ItemTags }> {
  return Object.entries(itemTags)
    .filter(([, tags]) => (tags.provides ?? []).length > 0)
    .map(([key, tags]) => ({ key, tags }));
}

/** Every key in the curated item table, curated or not, for coverage reporting. */
export function curatedItemKeys(): string[] {
  return Object.keys(itemTags);
}

/** Every curated situational item, for the counter-pick half of candidate generation. */
export function situationalItems(): Array<{ key: string; tags: ItemTags }> {
  return Object.entries(itemTags)
    .filter(([, tags]) => tags.situational)
    .map(([key, tags]) => ({ key, tags }));
}

/** Popularity ranking for a hero at a phase: `[itemKey, purchases][]`, most first. */
export function popularityFor(heroId: number | null, phase: Phase): Array<[string, number]> {
  if (heroId === null) return [];
  return popularity[String(heroId)]?.[phase] ?? [];
}

/**
 * Win rate of `heroId` against `vsHeroId`, or null when the sample is too small to
 * mean anything. The floor matters: OpenDota reports matchups with a handful of games.
 *
 * 50 is the median sample size in the current snapshot (p10 = 11, p90 = 164), so it
 * keeps about half the table. A win rate off 50 games still carries several points of
 * noise — which is why the draft ranker stretches the 45–55% band rather than reading
 * small differences as meaningful, and why this floor is one of the first things the
 * post-POC evaluation loop should tune against labelled outcomes.
 */
export function matchupWinrate(heroId: number, vsHeroId: number, minGames = 50): number | null {
  return matchupRecord(heroId, vsHeroId, minGames)?.winrate ?? null;
}

/** The same lookup, keeping the sample size so callers can weight by it. */
export function matchupRecord(
  heroId: number,
  vsHeroId: number,
  minGames = 50,
): { games: number; winrate: number } | null {
  const entry = matchups[String(heroId)]?.[String(vsHeroId)];
  if (!entry || entry.g < minGames) return null;
  return { games: entry.g, winrate: entry.w };
}

/** Union of the threat tags of a set of heroes, by console name. */
export function threatTagsOf(heroNames: readonly string[]): Set<ThreatTag> {
  const tags = new Set<ThreatTag>();
  for (const name of heroNames) {
    for (const tag of getHeroTags(name)?.tags ?? []) {
      if (isThreatTag(tag)) tags.add(tag);
    }
  }
  return tags;
}

export interface DataStatus {
  heroes: number;
  items: number;
  heroesWithAbilities: number;
  popularityHeroes: number;
  matchupHeroes: number;
  curatedHeroes: number;
  curatedItems: number;
}

export function dataStatus(): DataStatus {
  return {
    heroes: Object.keys(heroesById).length,
    items: Object.keys(items).length,
    heroesWithAbilities: Object.keys(abilities).length,
    popularityHeroes: Object.keys(popularity).length,
    matchupHeroes: Object.keys(matchups).length,
    curatedHeroes: Object.keys(heroTags).length,
    curatedItems: Object.keys(itemTags).length,
  };
}

/** Curated entries pointing at heroes/items that no longer exist in the snapshot. */
export function danglingCuration(): { heroes: string[]; items: string[] } {
  return {
    heroes: Object.keys(heroTags).filter((name) => !heroesByName.has(name)),
    items: Object.keys(itemTags).filter((key) => !items[key]),
  };
}

/** Curated tags that are not in the shared vocabulary — a typo check for the tables. */
export function unknownTags(): { heroes: Array<[string, string]>; items: Array<[string, string]> } {
  const heroes: Array<[string, string]> = [];
  const itemsOut: Array<[string, string]> = [];
  for (const [name, entry] of Object.entries(heroTags)) {
    for (const tag of entry.tags) if (!isThreatTag(tag)) heroes.push([name, tag]);
  }
  for (const [name, entry] of Object.entries(heroTags)) {
    for (const tag of entry.wants ?? []) if (!isProvideTag(tag)) heroes.push([name, tag]);
  }
  for (const [key, entry] of Object.entries(itemTags)) {
    for (const tag of entry.counters) if (!isThreatTag(tag)) itemsOut.push([key, tag]);
    for (const tag of entry.provides ?? []) if (!isProvideTag(tag)) itemsOut.push([key, tag]);
  }
  return { heroes, items: itemsOut };
}

/**
 * Total games in a hero's matchup table — a decent stand-in for how often the hero is
 * picked, which is what decides who is worth curating next.
 */
export function heroPickVolume(id: number): number {
  const vs = matchups[String(id)];
  if (!vs) return 0;
  let total = 0;
  for (const entry of Object.values(vs)) total += entry.g;
  return total;
}
