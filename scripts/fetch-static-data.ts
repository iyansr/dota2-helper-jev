/**
 * M3.1 — snapshot OpenDota into `data/*.json`.
 *
 *   npm run data:fetch            # everything
 *   npm run data:fetch -- --constants-only
 *
 * Runs by hand, once per patch. Nothing in the app fetches at runtime (plan §0): a
 * bundled snapshot removes rate limits, caching, and every offline failure mode from
 * the product. Slow is fine here — the free tier allows ~60 calls a minute and there
 * are two calls per hero.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../src/shared/gsi-token.ts";

const DATA_DIR = resolve(REPO_ROOT, "data");
const API = "https://api.opendota.com/api";
/** ~1 request/second keeps us inside the unauthenticated free-tier limit. */
const SPACING_MS = 1100;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function get<T>(path: string, attempt = 1): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 5) throw new Error(`${path}: ${res.status} after ${attempt} attempts`);
    const wait = Math.min(30_000, 2000 * 2 ** (attempt - 1));
    console.warn(`  ${path} → ${res.status}, retrying in ${wait / 1000}s`);
    await sleep(wait);
    return get<T>(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

interface OdHero {
  id: number;
  name: string;
  localized_name: string;
  roles: string[];
  primary_attr: string;
  attack_type: string;
}

interface OdItem {
  id?: number;
  dname?: string;
  cost?: number | null;
  components?: string[] | null;
  qual?: string;
}

interface OdHeroAbilities {
  /** Mostly plain keys; a hero with alternate forms nests two keys in one slot. */
  abilities: Array<string | string[]>;
  talents?: Array<{ name: string; level: number }>;
}

interface OdAbility {
  dname?: string;
  desc?: string;
  behavior?: string | string[];
  dmg_type?: string;
  bkbpierce?: string;
  mc?: string | string[];
  cd?: string | string[];
}

interface OdItemPopularity {
  start_game_items?: Record<string, number>;
  early_game_items?: Record<string, number>;
  mid_game_items?: Record<string, number>;
  late_game_items?: Record<string, number>;
}

type OdMatchup = Array<{ hero_id: number; games_played: number; wins: number }>;

/** Our phases are the ones `match/situation.ts` produces, not OpenDota's four. */
export type DataPhase = "laning" | "mid game" | "late game";

const write = (name: string, value: unknown): void => {
  const file = join(DATA_DIR, name);
  writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`, "utf8");
  console.log(`  wrote ${file}`);
};

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const constantsOnly = process.argv.includes("--constants-only");

  console.log("constants…");
  const heroesRaw = await get<Record<string, OdHero>>("/constants/heroes");
  const itemsRaw = await get<Record<string, OdItem>>("/constants/items");

  const heroes: Record<string, { name: string; displayName: string; roles: string[]; primaryAttr: string; attackType: string }> = {};
  for (const hero of Object.values(heroesRaw)) {
    heroes[String(hero.id)] = {
      name: hero.name,
      displayName: hero.localized_name,
      roles: hero.roles ?? [],
      primaryAttr: hero.primary_attr,
      attackType: hero.attack_type,
    };
  }
  write("heroes.json", heroes);

  // Key items the way GSI spells them (`item_black_king_bar`) so lookups from match
  // state need no translation. Recipes are dropped: they are never a recommendation.
  const items: Record<string, { id: number; displayName: string; cost: number; components: string[] }> = {};
  const idToKey = new Map<number, string>();
  for (const [key, item] of Object.entries(itemsRaw)) {
    if (key.startsWith("recipe_") || item.id === undefined) continue;
    const gsiKey = `item_${key}`;
    idToKey.set(item.id, gsiKey);
    items[gsiKey] = {
      id: item.id,
      displayName: item.dname ?? key,
      cost: item.cost ?? 0,
      components: (item.components ?? []).map((c) => `item_${c}`),
    };
  }
  write("items.json", items);

  // Real ability data, so the model is not asked to judge items for a hero it only
  // knows by name (research §4.2). This is generated, not curated, so it covers every
  // hero — unlike the hand-written `kit` summaries, which cover the curated ones.
  console.log("hero abilities…");
  const heroAbilities = await get<Record<string, OdHeroAbilities>>("/constants/hero_abilities");
  const abilityDetail = await get<Record<string, OdAbility>>("/constants/abilities");

  const first = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

  const abilities: Record<string, Array<{
    key: string;
    name: string;
    description: string;
    behavior: string | null;
    damageType: string | null;
    piercesSpellImmunity: boolean;
    ultimate: boolean;
  }>> = {};

  for (const [heroName, entry] of Object.entries(heroAbilities)) {
    const list = [];
    for (const [index, slot] of (entry.abilities ?? []).entries()) {
      // A slot usually holds one key; heroes with alternate forms nest several. The
      // slot index is what identifies the ultimate, so expand without losing it.
      for (const key of Array.isArray(slot) ? slot : [slot]) {
        // `generic_hidden` pads the array to fixed slots; it is not an ability.
        if (typeof key !== "string" || key.startsWith("generic_hidden")) continue;
        const detail = abilityDetail[key];
        if (!detail?.dname || !detail.desc) continue;
        list.push({
          key,
          name: detail.dname,
          description: detail.desc,
          behavior: first(detail.behavior),
          damageType: detail.dmg_type ?? null,
          piercesSpellImmunity: detail.bkbpierce === "Yes",
          // The ultimate sits in slot 5 of the padded array on every hero.
          ultimate: index === 5,
        });
      }
    }
    if (list.length > 0) abilities[heroName] = list;
  }
  write("abilities.json", abilities);

  if (constantsOnly) {
    console.log("--constants-only: skipping per-hero stats.");
    return;
  }

  const heroIds = Object.values(heroesRaw).map((h) => h.id).sort((a, b) => a - b);
  console.log(`per-hero stats for ${heroIds.length} heroes (~${Math.round((heroIds.length * 2 * SPACING_MS) / 60000)} min)…`);

  const popularity: Record<string, Record<DataPhase, Array<[string, number]>>> = {};
  const matchups: Record<string, Record<string, { g: number; w: number }>> = {};

  const rank = (counts: Record<string, number> | undefined, into: Map<string, number>): void => {
    for (const [id, count] of Object.entries(counts ?? {})) {
      const key = idToKey.get(Number(id));
      if (!key) continue; // unknown/removed item id from an older patch
      into.set(key, (into.get(key) ?? 0) + count);
    }
  };
  const top = (m: Map<string, number>, n: number): Array<[string, number]> =>
    [...m].sort((a, b) => b[1] - a[1]).slice(0, n);

  for (const [index, id] of heroIds.entries()) {
    process.stdout.write(`\r  ${index + 1}/${heroIds.length} (hero ${id})   `);

    const pop = await get<OdItemPopularity>(`/heroes/${id}/itemPopularity`);
    await sleep(SPACING_MS);
    const laning = new Map<string, number>();
    // Start-game and early-game both belong to our single laning phase.
    rank(pop.start_game_items, laning);
    rank(pop.early_game_items, laning);
    const mid = new Map<string, number>();
    rank(pop.mid_game_items, mid);
    const late = new Map<string, number>();
    rank(pop.late_game_items, late);
    popularity[String(id)] = {
      laning: top(laning, 25),
      "mid game": top(mid, 25),
      "late game": top(late, 25),
    };

    const raw = await get<OdMatchup>(`/heroes/${id}/matchups`);
    await sleep(SPACING_MS);
    const vs: Record<string, { g: number; w: number }> = {};
    for (const m of raw) {
      if (m.games_played <= 0) continue;
      vs[String(m.hero_id)] = {
        g: m.games_played,
        w: Math.round((m.wins / m.games_played) * 1000) / 1000,
      };
    }
    matchups[String(id)] = vs;
  }

  process.stdout.write("\r");
  write("itemPopularity.json", popularity);
  write("matchups.json", matchups);
  write("meta.json", {
    fetchedAt: new Date().toISOString(),
    source: "https://api.opendota.com",
    heroes: heroIds.length,
    note: "Regenerate after every gameplay patch — item popularity and matchups both move.",
  });
}

await main();
