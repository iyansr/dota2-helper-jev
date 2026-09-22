import type { AbilityState, DeathEvent, Fact, MatchState, Role, Side } from "../../shared/match.ts";
import type { GsiAbilities, GsiBuildings, GsiItems, GsiPayload } from "../gsi/types.ts";

/** What changed when a payload was folded in. Feeds the trigger engine (plan §3.1). */
export interface MatchChange {
  /** A new match started, or we returned to hero selection. State was cleared. */
  reset: boolean;
  /** Inventory or stash contents differ from the previous payload. */
  itemsChanged: boolean;
  died: boolean;
  respawned: boolean;
  gameStateChanged: boolean;
  /** Set when the user edited enemies/allies/role, never by GSI. */
  reportChanged: boolean;
}

export const NO_CHANGE: MatchChange = {
  reset: false,
  itemsChanged: false,
  died: false,
  respawned: false,
  gameStateChanged: false,
  reportChanged: false,
};

const fact = <T>(value: T, source: Fact<T>["source"] = "user"): Fact<T> => ({
  source,
  value,
  at: Date.now(),
});

export function emptyMatchState(): MatchState {
  return {
    matchId: null,
    gameState: "",
    clock: 0,
    gameTime: 0,
    paused: false,
    side: null,
    score: { mine: 0, theirs: 0 },
    hero: {
      id: null,
      name: null,
      level: 0,
      alive: true,
      respawnSeconds: 0,
      buybackCost: 0,
      healthPercent: 100,
      manaPercent: 100,
    },
    items: { slots: [], stash: [], neutral: null, teleport: null },
    abilities: [],
    gold: { total: 0, reliable: 0, unreliable: 0, gpm: 0, xpm: 0, netWorth: 0 },
    kda: { kills: 0, deaths: 0, assists: 0 },
    lastHits: 0,
    denies: 0,
    deaths: [],
    towers: { mineLost: 0, theirsLost: 0, myTier1Lost: 0 },
    roshan: { state: null, endSeconds: null },
    reported: {
      enemies: fact<string[]>([]),
      allies: fact<string[]>([]),
      role: fact<Role | null>(null),
      enemyItems: fact<Array<{ hero: string; item: string }>>([]),
    },
    updatedAt: null,
  };
}

const HERO_SELECTION = "DOTA_GAMERULES_STATE_HERO_SELECTION";

/** `empty` is how GSI spells an unused slot; drop it rather than carrying it around. */
function pickItems(items: GsiItems | undefined, prefix: string): string[] {
  if (!items) return [];
  return Object.entries(items)
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([, item]) => item?.name ?? "empty")
    .filter((name) => name !== "empty");
}

/**
 * GSI keys abilities `ability0`..`abilityN` in slot order. We keep the levels because
 * an ability at level 0 is not yet learned — a level-3 Earthshaker has no Echo Slam,
 * and recommending a Blink for an ultimate they cannot cast is noise.
 */
function pickAbilities(abilities: GsiAbilities | undefined): AbilityState[] {
  if (!abilities) return [];
  return Object.entries(abilities)
    .filter(([key]) => /^ability\d+$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .flatMap(([, ability]) =>
      ability?.name && ability.name !== "empty"
        ? [{
            name: ability.name,
            level: ability.level ?? 0,
            ultimate: ability.ultimate === true,
            passive: ability.passive === true,
          }]
        : [],
    );
}

function singleItem(items: GsiItems | undefined, key: string): string | null {
  const name = items?.[key]?.name;
  return !name || name === "empty" ? null : name;
}

/**
 * Towers are counted by disappearance: a destroyed building drops out of the payload,
 * and some patches leave it at 0 hp instead. Remembering every building we have seen
 * standing lets us count losses without hardcoding a building list that changes with
 * the map.
 */
class TowerTracker {
  private seen = { radiant: new Set<string>(), dire: new Set<string>() };

  reset(): void {
    this.seen = { radiant: new Set(), dire: new Set() };
  }

  update(buildings: GsiBuildings | undefined): void {
    for (const side of ["radiant", "dire"] as const) {
      for (const [name, b] of Object.entries(buildings?.[side] ?? {})) {
        if (name.includes("tower") && (b?.health ?? 0) > 0) this.seen[side].add(name);
      }
    }
  }

  /** Towers a side has lost, and how many of those were tier 1. */
  lost(
    buildings: GsiBuildings | undefined,
    side: "radiant" | "dire",
  ): { total: number; tier1: number } {
    const present = new Set(
      Object.entries(buildings?.[side] ?? {})
        .filter(([, b]) => (b?.health ?? 0) > 0)
        .map(([name]) => name),
    );
    let total = 0;
    let tier1 = 0;
    for (const name of this.seen[side]) {
      if (present.has(name)) continue;
      total += 1;
      if (name.includes("tower1")) tier1 += 1;
    }
    return { total, tier1 };
  }
}

export class MatchStore {
  private current: MatchState = emptyMatchState();
  private towers = new TowerTracker();

  state(): MatchState {
    return this.current;
  }

  reset(): void {
    // User-reported heroes do not survive: a new match invalidates them by definition.
    this.current = emptyMatchState();
    this.towers.reset();
  }

  /** Folds one GSI payload into the state and reports what moved. */
  apply(payload: GsiPayload): MatchChange {
    const change: MatchChange = { ...NO_CHANGE };
    const prev = this.current;

    const matchId =
      payload.map?.matchid && payload.map.matchid !== "0" ? payload.map.matchid : null;
    const gameState = payload.map?.game_state ?? prev.gameState;

    const newMatch = matchId !== null && prev.matchId !== null && matchId !== prev.matchId;
    const backToDraft =
      gameState === HERO_SELECTION && prev.gameState !== HERO_SELECTION && prev.gameState !== "";
    if (newMatch || backToDraft) {
      this.reset();
      change.reset = true;
    }

    const s = this.current;
    const before = {
      slots: s.items.slots.join("|"),
      stash: s.items.stash.join("|"),
      alive: s.hero.alive,
      gameState: s.gameState,
    };

    s.matchId = matchId ?? s.matchId;
    s.gameState = gameState;
    s.clock = payload.map?.clock_time ?? s.clock;
    s.gameTime = payload.map?.game_time ?? s.gameTime;
    s.paused = payload.map?.paused ?? s.paused;

    // `Team` is widened with `string & {}` for forward compatibility, so it does not
    // narrow on comparison; spell out the two values we accept.
    const team = payload.player?.team_name;
    const side: Side | null = team === "radiant" ? "radiant" : team === "dire" ? "dire" : s.side;
    s.side = side;

    const radiantScore =
      payload.map?.radiant_score ?? (side === "radiant" ? s.score.mine : s.score.theirs);
    const direScore = payload.map?.dire_score ?? (side === "dire" ? s.score.mine : s.score.theirs);
    s.score =
      side === "dire"
        ? { mine: direScore, theirs: radiantScore }
        : { mine: radiantScore, theirs: direScore };

    if (payload.hero) {
      const h = payload.hero;
      s.hero = {
        id: h.id ?? s.hero.id,
        name: h.name ?? s.hero.name,
        level: h.level ?? s.hero.level,
        alive: h.alive ?? s.hero.alive,
        respawnSeconds: h.respawn_seconds ?? 0,
        buybackCost: h.buyback_cost ?? s.hero.buybackCost,
        healthPercent: h.health_percent ?? s.hero.healthPercent,
        manaPercent: h.mana_percent ?? s.hero.manaPercent,
      };
    }

    if (payload.items) {
      s.items = {
        slots: pickItems(payload.items, "slot"),
        stash: pickItems(payload.items, "stash"),
        neutral: singleItem(payload.items, "neutral0"),
        teleport: singleItem(payload.items, "teleport0"),
      };
    }

    if (payload.abilities) s.abilities = pickAbilities(payload.abilities);

    if (payload.player) {
      const p = payload.player;
      s.gold = {
        total: p.gold ?? s.gold.total,
        reliable: p.gold_reliable ?? s.gold.reliable,
        unreliable: p.gold_unreliable ?? s.gold.unreliable,
        gpm: p.gpm ?? s.gold.gpm,
        xpm: p.xpm ?? s.gold.xpm,
        netWorth: p.net_worth ?? s.gold.netWorth,
      };
      s.kda = {
        kills: p.kills ?? s.kda.kills,
        deaths: p.deaths ?? s.kda.deaths,
        assists: p.assists ?? s.kda.assists,
      };
      s.lastHits = p.last_hits ?? s.lastHits;
      s.denies = p.denies ?? s.denies;
    }

    if (payload.buildings) {
      this.towers.update(payload.buildings);
      if (side) {
        const mine = this.towers.lost(payload.buildings, side);
        const theirs = this.towers.lost(
          payload.buildings,
          side === "radiant" ? "dire" : "radiant",
        );
        s.towers = { mineLost: mine.total, theirsLost: theirs.total, myTier1Lost: mine.tier1 };
      }
    }

    if (payload.map?.roshan_state !== undefined) {
      s.roshan = {
        state: payload.map.roshan_state ?? null,
        endSeconds: payload.map.roshan_state_end_seconds ?? null,
      };
    }

    // Deaths: the alive→dead edge, with the gold that was on the hero at the time.
    // Gold is updated above from this same payload, which still reports the amount
    // carried into the death — the reliable/unreliable split settles a tick later.
    if (before.alive && !s.hero.alive) {
      const death: DeathEvent = { clock: s.clock, goldHeld: s.gold.total };
      s.deaths = [...s.deaths, death];
      change.died = true;
    }
    if (!before.alive && s.hero.alive) change.respawned = true;

    change.itemsChanged =
      before.slots !== s.items.slots.join("|") || before.stash !== s.items.stash.join("|");
    change.gameStateChanged = before.gameState !== s.gameState;
    s.updatedAt = Date.now();

    return change;
  }

  reportEnemies(heroes: string[]): MatchChange {
    this.current.reported.enemies = fact(heroes);
    return { ...NO_CHANGE, reportChanged: true };
  }

  reportAllies(heroes: string[]): MatchChange {
    this.current.reported.allies = fact(heroes);
    return { ...NO_CHANGE, reportChanged: true };
  }

  reportRole(role: Role | null): MatchChange {
    this.current.reported.role = fact(role);
    return { ...NO_CHANGE, reportChanged: true };
  }

  reportEnemyItems(items: Array<{ hero: string; item: string }>): MatchChange {
    this.current.reported.enemyItems = fact(items);
    return { ...NO_CHANGE, reportChanged: true };
  }
}
