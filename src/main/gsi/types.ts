/**
 * Hand-written GSI payload types.
 *
 * Every field is optional on purpose: Dota only sends the providers enabled in the
 * cfg, only sends the keys that exist for the current `game_state`, and renames
 * fields between patches. The narrowing pass belongs after a real capture
 * (`npm run capture` → `npm run gsi:summarize`), which is milestone M1 step 4.
 *
 * Nothing downstream of `match/store.ts` may import these types — the store is the
 * only place allowed to know GSI's shape.
 */

export type GameState =
  | "DOTA_GAMERULES_STATE_INIT"
  | "DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD"
  | "DOTA_GAMERULES_STATE_HERO_SELECTION"
  | "DOTA_GAMERULES_STATE_STRATEGY_TIME"
  | "DOTA_GAMERULES_STATE_TEAM_SHOWCASE"
  | "DOTA_GAMERULES_STATE_PRE_GAME"
  | "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"
  | "DOTA_GAMERULES_STATE_POST_GAME"
  | "DOTA_GAMERULES_STATE_DISCONNECT"
  | (string & {});

export type Team = "radiant" | "dire" | (string & {});

export interface GsiProvider {
  name?: string;
  appid?: number;
  version?: number;
  timestamp?: number;
}

export interface GsiMap {
  name?: string;
  matchid?: string;
  game_time?: number;
  clock_time?: number;
  daytime?: boolean;
  nightstalker_night?: boolean;
  radiant_score?: number;
  dire_score?: number;
  game_state?: GameState;
  paused?: boolean;
  win_team?: Team | "none";
  customgamename?: string;
  roshan_state?: "alive" | "respawn_base" | "respawn_variable" | (string & {});
  roshan_state_end_seconds?: number;
  radiant_ward_purchase_cooldown?: number;
  dire_ward_purchase_cooldown?: number;
}

export interface GsiPlayer {
  steamid?: string;
  accountid?: string;
  name?: string;
  activity?: string;
  kills?: number;
  deaths?: number;
  assists?: number;
  last_hits?: number;
  denies?: number;
  kill_streak?: number;
  commands_issued?: number;
  team_name?: Team;
  player_slot?: number;
  team_slot?: number;
  gold?: number;
  gold_reliable?: number;
  gold_unreliable?: number;
  gold_from_hero_kills?: number;
  gold_from_creep_kills?: number;
  gold_from_income?: number;
  gold_from_shared?: number;
  gpm?: number;
  xpm?: number;
  net_worth?: number;
}

export interface GsiHero {
  /** OpenDota / Valve numeric hero id. */
  id?: number;
  /** Console name, e.g. `npc_dota_hero_juggernaut`. */
  name?: string;
  level?: number;
  xp?: number;
  alive?: boolean;
  respawn_seconds?: number;
  buyback_cost?: number;
  buyback_cooldown?: number;
  health?: number;
  max_health?: number;
  health_percent?: number;
  mana?: number;
  max_mana?: number;
  mana_percent?: number;
  silenced?: boolean;
  stunned?: boolean;
  disarmed?: boolean;
  magicimmune?: boolean;
  hexed?: boolean;
  muted?: boolean;
  break?: boolean;
  aghanims_scepter?: boolean;
  aghanims_shard?: boolean;
  smoked?: boolean;
  has_debuff?: boolean;
  talent_1?: boolean;
  talent_2?: boolean;
  talent_3?: boolean;
  talent_4?: boolean;
  talent_5?: boolean;
  talent_6?: boolean;
  talent_7?: boolean;
  talent_8?: boolean;
  /** Patch-dependent (facets shipped in 7.36). Present as a number id when sent. */
  facet?: number;
}

export interface GsiItem {
  /** `item_black_king_bar`, or `empty` for an unused slot. */
  name?: string;
  purchaser?: number;
  item_level?: number;
  contains_rune?: string;
  can_cast?: boolean;
  cooldown?: number;
  passive?: boolean;
  charges?: number;
}

/** Keys observed: `slot0`..`slot8`, `stash0`..`stash5`, `teleport0`, `neutral0`. */
export type GsiItems = Record<string, GsiItem | undefined>;

export interface GsiAbility {
  name?: string;
  level?: number;
  can_cast?: boolean;
  passive?: boolean;
  ability_active?: boolean;
  cooldown?: number;
  ultimate?: boolean;
}

export type GsiAbilities = Record<string, GsiAbility | undefined>;

export interface GsiDraftTeam {
  home_team?: boolean;
  pick0_id?: number;
  pick0_class?: string;
  ban0_id?: number;
  ban0_class?: string;
  [key: string]: unknown;
}

export interface GsiDraft {
  activeteam?: number;
  pick?: boolean;
  activeteam_time_remaining?: number;
  radiant_bonus_time?: number;
  dire_bonus_time?: number;
  team2?: GsiDraftTeam;
  team3?: GsiDraftTeam;
}

export interface GsiBuilding {
  health?: number;
  max_health?: number;
}

export interface GsiBuildings {
  radiant?: Record<string, GsiBuilding | undefined>;
  dire?: Record<string, GsiBuilding | undefined>;
}

export interface GsiAuth {
  token?: string;
}

/**
 * One POST body. `previously` / `added` mirror the payload's shape with the values
 * that changed; we ignore them and diff against `MatchStore` instead, because the
 * first payload of a session carries neither.
 */
export interface GsiPayload {
  provider?: GsiProvider;
  map?: GsiMap;
  player?: GsiPlayer;
  hero?: GsiHero;
  abilities?: GsiAbilities;
  items?: GsiItems;
  draft?: GsiDraft;
  events?: unknown[];
  buildings?: GsiBuildings;
  roshan?: Record<string, unknown>;
  couriers?: Record<string, unknown>;
  neutralitems?: Record<string, unknown>;
  auth?: GsiAuth;
  previously?: Partial<GsiPayload>;
  added?: Partial<GsiPayload>;
}

/**
 * Spectator payloads nest per-player data under `player.team2.player0` etc. We never
 * consume it (the POC is player-side only), but capture records it so the M1 spike can
 * diff player vs spectator shapes.
 */
export const IS_SPECTATOR_SHAPE = (payload: GsiPayload): boolean =>
  typeof payload.player === "object" &&
  payload.player !== null &&
  Object.keys(payload.player).some((k) => /^team\d+$/.test(k));
