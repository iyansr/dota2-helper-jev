/**
 * A scripted fake match, so M2–M6 can be built before a real capture exists.
 *
 *   npm run fixture:synth
 *
 * This is NOT a substitute for the M1 spike: it is written from the documented GSI
 * shape, so it can only ever confirm what we already assumed. Its job is to keep the
 * replay loop, the store and the advisors runnable on day one. Real fixtures from
 * `npm run capture` replace it for anything that matters, and the file it writes is
 * named `synthetic-*` so it is never mistaken for evidence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_DIR } from "../src/main/gsi/capture.ts";
import { serializeLine, type FixtureLine } from "../src/shared/fixture.ts";
import type { GsiAbilities, GsiItems, GsiPayload } from "../src/main/gsi/types.ts";

const MATCH_ID = "7777777777";
const HERO_PRESETS: Record<string, { id: number; name: string }> = {
  juggernaut: { id: 8, name: "npc_dota_hero_juggernaut" },
  earthshaker: { id: 7, name: "npc_dota_hero_earthshaker" },
};
const preset = process.argv.slice(2).find((a) => a.startsWith("--hero="))?.slice(7) ?? "juggernaut";
const HERO = HERO_PRESETS[preset] ?? HERO_PRESETS.juggernaut!;

/** [clock seconds, item] — when the item appears in the inventory, per preset hero. */
const BUILDS: Record<string, Array<[number, string]>> = {
  juggernaut: [
    [-60, "item_quelling_blade"],
    [-45, "item_tango"],
    [60, "item_magic_wand"],
    [4 * 60, "item_power_treads"],
    [11 * 60, "item_bfury"],
    [19 * 60, "item_manta"],
    [27 * 60, "item_black_king_bar"],
    [34 * 60, "item_skadi"],
  ],
  earthshaker: [
    [-60, "item_clarity"],
    [-45, "item_tango"],
    [60, "item_magic_wand"],
    [5 * 60, "item_arcane_boots"],
    [15 * 60, "item_blink"],
    [24 * 60, "item_black_king_bar"],
    [31 * 60, "item_aghanims_shard"],
    [36 * 60, "item_ultimate_scepter"],
  ],
};
const BUILD: Array<[number, string]> = BUILDS[preset] ?? BUILDS.juggernaut!;

/** [clock seconds of death, gold held] */
const DEATHS: Array<[number, number]> = [
  [8 * 60 + 30, 900],
  [14 * 60 + 10, 1800],
  [16 * 60 + 40, 2400],
  [17 * 60 + 50, 700],
];
const RESPAWN = 35;

/** [clock seconds, side that lost it, building key] */
const TOWER_LOSSES: Array<[number, "radiant" | "dire", string]> = [
  [12 * 60, "dire", "dota_badguys_tower1_top"],
  [15 * 60, "radiant", "dota_goodguys_tower1_mid"],
  [18 * 60, "radiant", "dota_goodguys_tower1_bot"],
  [24 * 60, "dire", "dota_badguys_tower1_mid"],
  [28 * 60, "radiant", "dota_goodguys_tower2_mid"],
];

const TOWERS = {
  radiant: ["tower1_top", "tower1_mid", "tower1_bot", "tower2_top", "tower2_mid", "tower2_bot"].map(
    (t) => `dota_goodguys_${t}`,
  ),
  dire: ["tower1_top", "tower1_mid", "tower1_bot", "tower2_top", "tower2_mid", "tower2_bot"].map(
    (t) => `dota_badguys_${t}`,
  ),
};

/** Ability keys per preset hero, in slot order, so the fixture exercises the provider. */
const ABILITIES: Record<string, string[]> = {
  juggernaut: [
    "juggernaut_blade_fury",
    "juggernaut_healing_ward",
    "juggernaut_blade_dance",
    "juggernaut_omni_slash",
  ],
  earthshaker: [
    "earthshaker_fissure",
    "earthshaker_enchant_totem",
    "earthshaker_aftershock",
    "earthshaker_echo_slam",
  ],
};

function abilitiesAt(clock: number, heroLevel: number): GsiAbilities {
  const keys = ABILITIES[preset] ?? [];
  const out: GsiAbilities = {};
  keys.forEach((name, index) => {
    // Rough skill build: the three basics come up first, the ultimate at level 6.
    const isUlt = index === keys.length - 1;
    const level = isUlt
      ? heroLevel >= 6
        ? Math.min(3, 1 + Math.floor((heroLevel - 6) / 6))
        : 0
      : Math.min(4, Math.max(0, Math.floor((heroLevel + 2 - index) / 3)));
    out[`ability${index}`] = { name, level, can_cast: level > 0, passive: index === 2, ultimate: isUlt, cooldown: 0 };
  });
  void clock;
  return out;
}

const ITEM_COST: Record<string, number> = {
  item_quelling_blade: 100,
  item_clarity: 50,
  item_tango: 90,
  item_magic_wand: 500,
  item_arcane_boots: 1000,
  item_power_treads: 1400,
  item_blink: 2250,
  item_bfury: 4100,
  item_manta: 4600,
  item_black_king_bar: 4050,
  item_skadi: 5300,
  item_aghanims_shard: 1400,
  item_ultimate_scepter: 4200,
};

function itemsAt(clock: number): GsiItems {
  const owned = BUILD.filter(([at]) => at <= clock).map(([, item]) => item);
  const items: GsiItems = {};
  for (let i = 0; i < 9; i += 1) items[`slot${i}`] = { name: owned[i] ?? "empty" };
  for (let i = 0; i < 6; i += 1) items[`stash${i}`] = { name: "empty" };
  items.teleport0 = { name: clock > 0 ? "item_tpscroll" : "empty", charges: 1 };
  items.neutral0 = { name: clock > 10 * 60 ? "item_pupil_gift" : "empty" };
  return items;
}

/** Gold earned so far minus what the scripted build spent, so purchases show a dip. */
function goldAt(clock: number): number {
  if (clock <= 0) return 600;
  const earned = 600 + (clock / 60) * 520;
  const spent = BUILD.filter(([at]) => at <= clock).reduce(
    (sum, [, item]) => sum + (ITEM_COST[item] ?? 0),
    0,
  );
  // Saving up reads as a rising bank between purchases.
  return Math.max(0, Math.round(earned - spent));
}

function buildingsAt(clock: number): GsiPayload["buildings"] {
  const fallen = new Set(TOWER_LOSSES.filter(([at]) => at <= clock).map(([, , key]) => key));
  const forSide = (side: "radiant" | "dire"): Record<string, { health: number; max_health: number }> =>
    Object.fromEntries(
      TOWERS[side]
        .filter((key) => !fallen.has(key))
        .map((key) => [key, { health: 1800, max_health: 1800 }]),
    );
  return { radiant: forSide("radiant"), dire: forSide("dire") };
}

function aliveAt(clock: number): { alive: boolean; respawn: number } {
  for (const [at] of DEATHS) {
    if (clock >= at && clock < at + RESPAWN) return { alive: false, respawn: at + RESPAWN - clock };
  }
  return { alive: true, respawn: 0 };
}

function payloadAt(clock: number, gameState: string): GsiPayload {
  const { alive, respawn } = aliveAt(clock);
  const deathsSoFar = DEATHS.filter(([at]) => at <= clock).length;
  const inGame = gameState === "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS";
  const deathGold = DEATHS.find(([at]) => at === clock)?.[1];
  const gold = deathGold ?? goldAt(clock);

  return {
    provider: { name: "Dota 2", appid: 570, version: 47, timestamp: 1_760_000_000 + clock },
    map: {
      name: "start",
      matchid: MATCH_ID,
      game_time: clock + 90,
      clock_time: clock,
      daytime: Math.floor(clock / 300) % 2 === 0,
      nightstalker_night: false,
      radiant_score: inGame ? Math.floor(clock / 150) : 0,
      dire_score: inGame ? Math.floor(clock / 110) : 0,
      game_state: gameState,
      paused: false,
      win_team: "none",
      roshan_state: clock < 22 * 60 ? "alive" : "respawn_variable",
      roshan_state_end_seconds: clock < 22 * 60 ? 0 : 480,
    },
    player: {
      steamid: "76561190000000000",
      accountid: "100000000",
      name: "player",
      activity: "playing",
      kills: inGame ? Math.floor(clock / 400) : 0,
      deaths: deathsSoFar,
      assists: inGame ? Math.floor(clock / 300) : 0,
      last_hits: inGame ? Math.floor(clock / 8) : 0,
      denies: inGame ? Math.floor(clock / 120) : 0,
      team_name: "radiant",
      player_slot: 0,
      gold,
      gold_reliable: Math.round(gold * 0.3),
      gold_unreliable: gold - Math.round(gold * 0.3),
      gpm: inGame ? 520 : 0,
      xpm: inGame ? 610 : 0,
      net_worth: 600 + Math.round((Math.max(0, clock) / 60) * 520),
    },
    hero: {
      id: HERO.id,
      name: HERO.name,
      level: Math.min(30, 1 + Math.floor(Math.max(0, clock) / 95)),
      alive,
      respawn_seconds: respawn,
      buyback_cost: 800 + Math.round(Math.max(0, clock) * 1.2),
      health_percent: alive ? 78 : 0,
      mana_percent: alive ? 62 : 0,
      aghanims_scepter: false,
      aghanims_shard: clock > 20 * 60,
    },
    items: itemsAt(clock),
    abilities: abilitiesAt(clock, Math.min(30, 1 + Math.floor(Math.max(0, clock) / 95))),
    buildings: buildingsAt(clock),
  };
}

function main(): void {
  const lines: FixtureLine[] = [];
  const push = (clock: number, gameState: string, t: number): void => {
    lines.push({ t, payload: payloadAt(clock, gameState) });
  };

  let t = 0;
  const step = 1000; // one payload per wall-clock second, as Dota's throttle roughly gives

  // Draft and pre-game. A *player* gets no `draft` provider content here — that is the
  // assumption the whole manual-input design rests on (plan §0).
  for (let i = 0; i < 20; i += 1) push(-90, "DOTA_GAMERULES_STATE_HERO_SELECTION", (t += step));
  for (let i = 0; i < 10; i += 1) push(-75, "DOTA_GAMERULES_STATE_STRATEGY_TIME", (t += step));
  for (let clock = -60; clock < 0; clock += 5) push(clock, "DOTA_GAMERULES_STATE_PRE_GAME", (t += step));

  // 40 minutes of match, one payload per 5 game-seconds, plus exact death ticks so the
  // alive→dead edge is never skipped over.
  const ticks = new Set<number>();
  for (let clock = 0; clock <= 40 * 60; clock += 5) ticks.add(clock);
  for (const [at] of DEATHS) {
    ticks.add(at);
    ticks.add(at + RESPAWN);
  }
  for (const [at] of TOWER_LOSSES) ticks.add(at);
  for (const [at] of BUILD) if (at > 0) ticks.add(at);

  for (const clock of [...ticks].sort((a, b) => a - b)) {
    push(clock, "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", (t += step));
  }
  for (let i = 0; i < 5; i += 1) push(40 * 60, "DOTA_GAMERULES_STATE_POST_GAME", (t += step));

  mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = join(FIXTURE_DIR, `synthetic-${preset}-40min.jsonl`);
  writeFileSync(file, lines.map(serializeLine).join(""), "utf8");
  console.log(`Wrote ${lines.length} synthetic payloads to ${file}`);
  console.log("Reminder: synthetic. It confirms nothing about what Dota really sends.");
}

main();
