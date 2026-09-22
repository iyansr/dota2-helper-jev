import { noul, score, type Question, type Questions } from "@typesafe-ai/sdk";
import type { MatchState, Situation } from "../../shared/match.ts";
import type { HeroCandidate, ItemCandidate } from "../advise/candidates.ts";
import type { JevHeroAnswer, JevItemAnswer } from "../advise/rank.ts";
import { getHeroAbilities, getHeroTags, heroDisplayName } from "../data/index.ts";

/**
 * Every question, in one place (plan §3.3). Nothing else in the codebase talks to the
 * model's vocabulary.
 *
 * Two rules hold throughout:
 *   - State is small, named, and pre-bucketed. No raw gold, no timestamps, no win
 *     rates — Jev is weak at arithmetic and at large irrelevant state (research §4.2).
 *   - Jev never names an item or a hero. Code proposes candidates; the model rates them.
 */

/**
 * The ranking question. One Score per candidate, and its value *is* the order shown —
 * there is no code-side weighting left to combine anything (see §"Jev ranks" in the
 * build notes). Everything the decision depends on is in the state, in words: what the
 * item does, how affordable it is, how standard it is on this hero, the enemies, the
 * situation, and the player's own abilities.
 */
export const OVERALL_LEVELS = [
  "Buying this next would be a mistake: it does nothing for this hero's abilities, the enemies listed, or the current situation",
  "A defensible item for this hero eventually, but clearly not the right next purchase",
  "A good next purchase, among the strongest options available right now",
  "Plainly the right next purchase: it answers the most pressing problem and this hero can use it well",
] as const;

export const FIT_LEVELS = [
  "The item's effect does nothing against any enemy hero listed in `enemies`",
  "The item's effect counters one enemy hero's main threat",
  "The item's effect counters the main threat of several enemy heroes",
] as const;

export const SYNERGY_LEVELS = [
  "The item does nothing for any ability listed in `me.abilities`",
  "The item helps one ability listed in `me.abilities` work better",
  "The item is what the abilities listed in `me.abilities` most need in order to work well",
] as const;

export const NEED_LEVELS = [
  "The current situation gives no reason to buy an item with this effect",
  "The effect would help somewhat, but other purchases address more pressing problems",
  "The effect directly addresses the most pressing problem the player has right now",
] as const;

/** The draft ranking question. Same contract as `OVERALL_LEVELS` for items. */
export const HERO_OVERALL_LEVELS = [
  "A poor pick here: it does nothing about the heroes in `enemies` and adds nothing the heroes in `allies` lack",
  "A playable pick, but clearly weaker than other options against this draft",
  "A strong pick for this draft, among the best options available",
  "Plainly the best kind of pick here: it answers the enemy draft and covers what this side is missing",
] as const;

export const GAP_LEVELS = [
  "This hero adds nothing the heroes in `allies` are missing",
  "This hero partly covers something the heroes in `allies` are missing",
  "This hero directly covers the biggest thing the heroes in `allies` are missing",
] as const;

export const VS_LEVELS = [
  "This hero's abilities are ineffective against the threats listed in `enemies`",
  "This hero's abilities handle one of the threats listed in `enemies`",
  "This hero's abilities handle several of the threats listed in `enemies`",
] as const;

/** Score levels are 0..n-1; normalize to 0..1 before any weight touches them. */
const normalize = (value: number, levels: number): number =>
  Math.max(0, Math.min(1, value / (levels - 1)));

interface HeroInState {
  hero: string;
  threat: string;
}

/** One ability as the model sees it: real game text, trimmed, never our paraphrase. */
interface AbilityInState {
  name: string;
  does: string;
  cast: string | null;
  damage?: string;
  ultimate?: true;
}

export interface ItemState {
  me: {
    hero: string;
    /** One clause of curated playstyle; null when the hero is not curated. */
    playstyle: string | null;
    /** The abilities actually learned, from the static table filtered by GSI levels. */
    abilities: AbilityInState[];
    role: string;
    level: number;
    items: string[];
  };
  enemies: HeroInState[];
  known_enemy_items: Array<{ hero: string; item: string }>;
  situation: Situation;
}

/** Only curated heroes reach the model: an uncurated threat string would be a guess. */
function describedHeroes(names: readonly string[]): HeroInState[] {
  const out: HeroInState[] = [];
  for (const name of names) {
    const tags = getHeroTags(name);
    if (!tags) continue;
    out.push({ hero: heroDisplayName(name), threat: tags.threat });
  }
  return out;
}

/** Long enough to carry the mechanic, short enough that ten of them stay cheap. */
const DESCRIPTION_CAP = 220;

/**
 * The abilities to send. Real game text from `data/abilities.json`, narrowed to the
 * ones the player has actually learned — a level-3 Earthshaker has no Echo Slam, and
 * judging a Blink against an ability they cannot cast is noise. Before GSI sends the
 * `abilities` provider the whole kit goes, which is the right default during the draft.
 */
export function abilitiesInState(state: MatchState): AbilityInState[] {
  const known = getHeroAbilities(state.hero.name);
  const levels = new Map(state.abilities.map((ability) => [ability.name, ability.level]));
  const learned = levels.size > 0 ? known.filter((a) => (levels.get(a.key) ?? 0) > 0) : known;

  return learned.map((ability) => ({
    name: ability.name,
    does:
      ability.description.length > DESCRIPTION_CAP
        ? `${ability.description.slice(0, DESCRIPTION_CAP).trimEnd()}…`
        : ability.description,
    cast: ability.behavior,
    ...(ability.damageType ? { damage: ability.damageType } : {}),
    ...(ability.ultimate ? { ultimate: true as const } : {}),
  }));
}

export function buildItemState(state: MatchState, situation: Situation): ItemState {
  return {
    me: {
      hero: heroDisplayName(state.hero.name),
      // Curated playstyle, plus the hero's real abilities. Without these the model is
      // asked to judge items for a bare name, which research §4.2 ("Knowledge in
      // weights") says never to rely on.
      playstyle: (state.hero.name ? getHeroTags(state.hero.name)?.kit : null) ?? null,
      abilities: abilitiesInState(state),
      role: state.reported.role.value ?? "unspecified",
      level: state.hero.level,
      items: state.items.slots.map((key) => key.replace("item_", "").replace(/_/g, " ")),
    },
    enemies: describedHeroes(state.reported.enemies.value),
    known_enemy_items: state.reported.enemyItems.value.map((entry) => ({
      hero: heroDisplayName(entry.hero),
      item: entry.item.replace("item_", "").replace(/_/g, " "),
    })),
    situation,
  };
}

/** Item keys are `[a-z0-9_]`, so they are safe to use directly as question names. */
const fitKey = (key: string): string => `fit_${key}`;
const needKey = (key: string): string => `need_${key}`;
const synergyKey = (key: string): string => `synergy_${key}`;
const overallKey = (key: string): string => `overall_${key}`;

export function buildItemQuestions(
  candidates: readonly ItemCandidate[],
  /** True when `me.abilities` carries something to judge against. */
  hasAbilities = false,
): Questions {
  const questions: Record<string, Question> = {};

  for (const candidate of candidates) {
    // An uncurated item has no effect text; sending its name alone would ask the model
    // to supply the knowledge, which is exactly what research §4.2 forbids.
    if (!candidate.effect) continue;
    const item = {
      name: candidate.displayName,
      effect: candidate.effect,
      cost: candidate.costBucket,
      how_standard: candidate.popularityBucket,
    };
    questions[overallKey(candidate.key)] = score(
      {
        item,
        question:
          "Taking `me`, `enemies` and `situation` together, how strongly should this player buy `item` as their next purchase?",
      },
      OVERALL_LEVELS,
    );
    questions[fitKey(candidate.key)] = score(
      {
        item,
        question: "How well does `item` counter the threats of the heroes in `enemies`?",
      },
      FIT_LEVELS,
    );
    questions[needKey(candidate.key)] = score(
      {
        item,
        question:
          "For the hero in `me`, how much does the current `situation` call for what `item` provides?",
      },
      NEED_LEVELS,
    );
    if (hasAbilities) {
      questions[synergyKey(candidate.key)] = score(
        {
          item,
          question: "How well does `item` serve the abilities listed in `me.abilities`?",
        },
        SYNERGY_LEVELS,
      );
    }
  }

  return questions;
}

type AnswerBag = Record<string, unknown>;

function scoreOf(answers: AnswerBag, key: string, levels: number): { value: number; confidence: number } | null {
  const answer = answers[key];
  if (!answer || typeof answer !== "object") return null;
  const record = answer as { type?: string; score?: number; confidence?: number };
  if (record.type !== "score" || typeof record.score !== "number") return null;
  return { value: normalize(record.score, levels), confidence: record.confidence ?? 0 };
}

function noulOf(answers: AnswerBag, key: string): number {
  const answer = answers[key];
  if (!answer || typeof answer !== "object") return 0;
  const record = answer as { type?: string; noul?: number };
  return record.type === "noul" && typeof record.noul === "number" ? record.noul : 0;
}

export function parseItemAnswers(
  answers: AnswerBag,
  candidates: readonly ItemCandidate[],
): Map<string, JevItemAnswer> {
  const items = new Map<string, JevItemAnswer>();
  for (const candidate of candidates) {
    // `overall` is the ranking. Without it the candidate cannot be placed at all.
    const overall = scoreOf(answers, overallKey(candidate.key), OVERALL_LEVELS.length);
    if (!overall) continue;
    // The three dimensions no longer feed the order. They are kept because the "why"
    // line names whichever one the model scored highest, and because the exchange log
    // is unreadable without them.
    const fit = scoreOf(answers, fitKey(candidate.key), FIT_LEVELS.length);
    const need = scoreOf(answers, needKey(candidate.key), NEED_LEVELS.length);
    const synergy = scoreOf(answers, synergyKey(candidate.key), SYNERGY_LEVELS.length);
    items.set(candidate.key, {
      overall: overall.value,
      confidence: overall.confidence,
      fit: fit?.value ?? 0,
      need: need?.value ?? 0,
      synergy: synergy?.value ?? 0,
    });
  }
  return items;
}

export interface DraftState {
  me: { role: string };
  allies: HeroInState[];
  enemies: HeroInState[];
}

export function buildDraftState(state: MatchState): DraftState {
  return {
    me: { role: state.reported.role.value ?? "unspecified" },
    allies: describedHeroes(state.reported.allies.value),
    enemies: describedHeroes(state.reported.enemies.value),
  };
}

const gapKey = (name: string): string => `gap_${name.replace("npc_dota_hero_", "")}`;
const vsKey = (name: string): string => `vs_${name.replace("npc_dota_hero_", "")}`;
const heroOverallKey = (name: string): string => `pick_${name.replace("npc_dota_hero_", "")}`;

export function buildDraftQuestions(candidates: readonly HeroCandidate[]): Questions {
  const questions: Record<string, Question> = {};

  for (const candidate of candidates) {
    if (!candidate.threat) continue; // uncurated: no description to judge, so no question
    const hero = {
      name: candidate.displayName,
      abilities: candidate.threat,
      head_to_head: candidate.matchupBucket,
      role: candidate.roles.join(", "),
    };
    questions[heroOverallKey(candidate.name)] = score(
      {
        hero,
        question:
          "Taking `allies`, `enemies` and the role in `me` together, how strong a pick is `hero` for this player right now?",
      },
      HERO_OVERALL_LEVELS,
    );
    questions[gapKey(candidate.name)] = score(
      { hero, question: "How well does `hero` cover what the heroes in `allies` are missing?" },
      GAP_LEVELS,
    );
    questions[vsKey(candidate.name)] = score(
      { hero, question: "How well does `hero` handle the threats of the heroes in `enemies`?" },
      VS_LEVELS,
    );
  }

  questions.draft_lacks_initiation = noul(
    "Do the heroes in `allies` lack a way to start a fight on their terms?",
  );
  questions.draft_lacks_save = noul(
    "Do the heroes in `allies` lack a way to rescue an ally who is being focused?",
  );
  questions.draft_lacks_waveclear = noul(
    "Do the heroes in `allies` lack a way to clear waves of creeps quickly?",
  );
  questions.draft_lacks_lategame = noul(
    "Do the heroes in `allies` lack a hero who becomes stronger than the rest late in a long game?",
  );

  return questions;
}

export interface DraftNouls {
  lacksInitiation: number;
  lacksSave: number;
  lacksWaveclear: number;
  lacksLategame: number;
}

export function parseDraftAnswers(
  answers: AnswerBag,
  candidates: readonly HeroCandidate[],
): { heroes: Map<string, JevHeroAnswer>; nouls: DraftNouls } {
  const heroes = new Map<string, JevHeroAnswer>();
  for (const candidate of candidates) {
    // `pick` is the ranking; the other two only explain it.
    const overall = scoreOf(answers, heroOverallKey(candidate.name), HERO_OVERALL_LEVELS.length);
    if (!overall) continue;
    const gap = scoreOf(answers, gapKey(candidate.name), GAP_LEVELS.length);
    const vs = scoreOf(answers, vsKey(candidate.name), VS_LEVELS.length);
    heroes.set(candidate.name, {
      overall: overall.value,
      confidence: overall.confidence,
      fillsGap: gap?.value ?? 0,
      vsEnemies: vs?.value ?? 0,
    });
  }

  return {
    heroes,
    nouls: {
      lacksInitiation: noulOf(answers, "draft_lacks_initiation"),
      lacksSave: noulOf(answers, "draft_lacks_save"),
      lacksWaveclear: noulOf(answers, "draft_lacks_waveclear"),
      lacksLategame: noulOf(answers, "draft_lacks_lategame"),
    },
  };
}
