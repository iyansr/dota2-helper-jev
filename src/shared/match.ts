/**
 * The normalized match model. Shared between main and renderer; nothing here knows
 * about GSI's wire shape (that stops at `main/match/store.ts`).
 */

/**
 * Research §2: never let user-reported state and GSI-observed state blur together.
 * Everything the game did not tell us carries its provenance.
 */
export type FactSource = "gsi" | "user" | "inferred";

export interface Fact<T> {
  source: FactSource;
  value: T;
  /** ms epoch when this value was recorded. */
  at: number;
}

export type Role = "carry" | "mid" | "offlane" | "soft support" | "hard support";

export const ROLES: readonly Role[] = ["carry", "mid", "offlane", "soft support", "hard support"];

export type Side = "radiant" | "dire";

export interface HeroState {
  /** Valve/OpenDota numeric id, or null before hero selection resolves. */
  id: number | null;
  /** Console name, e.g. `npc_dota_hero_juggernaut`. */
  name: string | null;
  level: number;
  alive: boolean;
  respawnSeconds: number;
  buybackCost: number;
  healthPercent: number;
  manaPercent: number;
}

/** One of the player's own abilities, as GSI reports it live. */
export interface AbilityState {
  /** Console key, e.g. `earthshaker_echo_slam`. */
  name: string;
  level: number;
  ultimate: boolean;
  passive: boolean;
}

export interface ItemsState {
  /** Console item names in the six inventory slots + three backpack slots. */
  slots: string[];
  stash: string[];
  neutral: string | null;
  teleport: string | null;
}

export interface GoldState {
  total: number;
  reliable: number;
  unreliable: number;
  gpm: number;
  xpm: number;
  netWorth: number;
}

export interface DeathEvent {
  /** `clock_time` in seconds when the death was first observed. */
  clock: number;
  /** Gold held at the moment of death — the "died on a big bank" signal. */
  goldHeld: number;
}

export interface ReportedState {
  enemies: Fact<string[]>;
  allies: Fact<string[]>;
  role: Fact<Role | null>;
  enemyItems: Fact<Array<{ hero: string; item: string }>>;
}

export interface MatchState {
  matchId: string | null;
  gameState: string;
  /** Seconds since horn; negative during pre-game. */
  clock: number;
  gameTime: number;
  paused: boolean;
  side: Side | null;
  score: { mine: number; theirs: number };
  hero: HeroState;
  items: ItemsState;
  /** Own abilities and their levels. Empty until GSI sends the `abilities` provider. */
  abilities: AbilityState[];
  gold: GoldState;
  kda: { kills: number; deaths: number; assists: number };
  lastHits: number;
  denies: number;
  /** Every death this match, oldest first. */
  deaths: DeathEvent[];
  towers: { mineLost: number; theirsLost: number; myTier1Lost: number };
  roshan: { state: string | null; endSeconds: number | null };
  reported: ReportedState;
  /** ms epoch of the last GSI payload folded in, or null before the first. */
  updatedAt: number | null;
}

export type Phase = "laning" | "mid game" | "late game";

export type LeadBucket =
  | "far ahead"
  | "ahead"
  | "even"
  | "behind by a few kills"
  | "far behind";

/**
 * The Jev-facing view of the match: every number already turned into a named bucket.
 * Plan §2/M2 — this conversion happens in `match/situation.ts` and nowhere else.
 */
export interface Situation {
  phase: Phase;
  team_lead: LeadBucket;
  recent_deaths: string;
  towers: string;
  net_worth: string;
  roshan: string;
}
