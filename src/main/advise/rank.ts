import type { HeroSuggestion, ItemSuggestion } from "../../shared/advice.ts";
import type { HeroCandidate, ItemCandidate } from "./candidates.ts";

/**
 * Ordering, and nothing else.
 *
 * **Jev decides the order.** There is no weighted composite here any more, and no
 * hand-tuned constant that can move a suggestion up or down: the rank a candidate gets
 * is the `overall` Score the model returned, full stop. Everything a ranking used to
 * be computed from — popularity, gold-to-go, tag matches, matchup win rate — is now
 * phrased as a named bucket in the state instead, so the model weighs it rather than
 * the code (see `advise/candidates.ts`).
 *
 * What is left in code: which candidates exist, what the state says, and the wording
 * of the one line under each card. None of those is a score.
 */

/**
 * Below this reported confidence a suggestion is shown but labelled "situational".
 * This is Jev's own number, not a weight — it gates a label, never an order.
 * Measured over 462 Score answers on the synthetic fixtures the distribution is
 * p10 0.21, p25 0.27, median 0.39, p90 0.61, so 0.27 flags roughly the least-certain
 * quarter. Provisional until the evaluation loop in plan §7 sets it against labelled
 * outcomes.
 */
export const LOW_CONFIDENCE = 0.27;

export interface JevItemAnswer {
  /** The ranking. 0..1, from the `overall` Score's four-level rubric. */
  overall: number;
  confidence: number;
  /** Dimensions kept for the "why" line and the exchange log; never for ordering. */
  fit: number;
  need: number;
  synergy: number;
}

export interface JevHeroAnswer {
  overall: number;
  confidence: number;
  fillsGap: number;
  vsEnemies: number;
}

/**
 * The one line under each card. A code template, never text from the model (plan §M5):
 * the model's words cannot be checked, and a wrong sentence under a right suggestion
 * is worse than no sentence.
 *
 * Which template is used is decided by comparing Jev's own dimension scores against
 * each other. No weighting is applied — the largest wins, ties fall through in the
 * order listed.
 */
function itemWhy(candidate: ItemCandidate, answer: JevItemAnswer | null): string {
  if (answer) {
    const top = (["synergy", "fit", "need"] as const).reduce((best, key) =>
      answer[key] > answer[best] ? key : best,
    );
    if (answer[top] > 0 && candidate.effect) {
      switch (top) {
        case "synergy":
          return `What this hero's abilities need: ${candidate.effect}.`;
        case "fit":
          return `Answers what they picked: ${candidate.effect}.`;
        case "need":
          return `What the game is asking for right now: ${candidate.effect}.`;
      }
    }
  }
  // Nothing scored, or nothing scored above zero: fall back to plain facts.
  return candidate.effect
    ? `${candidate.effect}. ${candidate.popularityBucket}.`
    : `${candidate.popularityBucket}, ${candidate.costBucket}.`;
}

/**
 * Orders by the model's `overall` Score, breaking ties on its confidence. Candidates
 * the model was not asked about — uncurated, so there is no effect text to judge —
 * carry no score and sort last: they are shown as options, not recommendations.
 */
export function rankItems(
  candidates: ItemCandidate[],
  answers: Map<string, JevItemAnswer> | null,
): ItemSuggestion[] {
  return candidates
    .map((candidate) => {
      const answer = answers?.get(candidate.key) ?? null;
      return {
        key: candidate.key,
        displayName: candidate.displayName,
        cost: candidate.cost,
        goldToGo: candidate.goldToGo,
        rank: answer?.overall ?? 0,
        why: itemWhy(candidate, answer),
        situational: answer ? answer.confidence < LOW_CONFIDENCE : true,
        rated: answer !== null,
        breakdown: {
          overall: answer?.overall ?? 0,
          confidence: answer?.confidence ?? 0,
          fit: answer?.fit ?? 0,
          need: answer?.need ?? 0,
          synergy: answer?.synergy ?? 0,
        },
      } satisfies ItemSuggestion;
    })
    .sort((a, b) => b.rank - a.rank || b.breakdown.confidence - a.breakdown.confidence);
}

function heroWhy(candidate: HeroCandidate, answer: JevHeroAnswer | null): string {
  if (!answer) return candidate.threat ?? "Playable in this role.";
  if (answer.vsEnemies >= answer.fillsGap && candidate.threat) {
    return `Lines up against their picks — ${candidate.threat}.`;
  }
  if (answer.fillsGap > 0) return "Covers what your side is missing.";
  return candidate.threat ?? "Playable in this role.";
}

export function rankHeroes(
  candidates: HeroCandidate[],
  answers: Map<string, JevHeroAnswer> | null,
): HeroSuggestion[] {
  return candidates
    .map((candidate) => {
      const answer = answers?.get(candidate.name) ?? null;
      return {
        id: candidate.id,
        name: candidate.name,
        displayName: candidate.displayName,
        rank: answer?.overall ?? 0,
        why: heroWhy(candidate, answer),
        situational: answer ? answer.confidence < LOW_CONFIDENCE : true,
        rated: answer !== null,
        breakdown: {
          overall: answer?.overall ?? 0,
          confidence: answer?.confidence ?? 0,
          fillsGap: answer?.fillsGap ?? 0,
          vsEnemies: answer?.vsEnemies ?? 0,
        },
      } satisfies HeroSuggestion;
    })
    .sort((a, b) => b.rank - a.rank || b.breakdown.confidence - a.breakdown.confidence);
}
