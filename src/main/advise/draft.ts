import type { Advice, HeroSuggestion } from "../../shared/advice.ts";
import type { MatchState } from "../../shared/match.ts";
import { ask, hashState, jevEnabled } from "../jev/client.ts";
import { logJevExchange } from "../jev/log.ts";
import { buildDraftQuestions, buildDraftState, parseDraftAnswers, type DraftNouls } from "../jev/questions.ts";
import { AnswerCache } from "./cache.ts";
import { heroCandidates } from "./candidates.ts";
import { rankHeroes, type JevHeroAnswer } from "./rank.ts";

interface CachedAnswers {
  heroes: Map<string, JevHeroAnswer>;
  nouls: DraftNouls;
}

const cache = new AnswerCache<CachedAnswers>();

export function clearDraftCache(): void {
  cache.clear();
}

export interface DraftAdvice {
  heroes: HeroSuggestion[];
  jev: Advice["jev"];
  source: Advice["source"];
  /** What the model thinks the ally side is missing — shown as context, not a ranking. */
  gaps: DraftNouls | null;
}

/**
 * The draft advisor. Same shape as the item advisor, different questions.
 *
 * A draft pick is time-boxed to about thirty seconds, so the same 2s timeout and
 * silent baseline fallback apply; with no enemies reported yet the matchup term is
 * empty and the list degrades to role fit, which is still better than nothing.
 */
export async function adviseDraft(
  state: MatchState,
  isStale: (hash: string) => boolean = () => false,
): Promise<DraftAdvice> {
  const candidates = heroCandidates(state);
  const unrankedList = (reason?: string): DraftAdvice => ({
    heroes: rankHeroes(candidates, null),
    jev: reason ? { model: "none", latencyMs: 0, inputTokens: 0, fallbackReason: reason } : null,
    source: "unranked",
    gaps: null,
  });

  if (candidates.length === 0) return unrankedList();
  if (!jevEnabled()) return unrankedList("Jev is off, so nothing ranks the candidates");

  const jevState = buildDraftState(state);
  const hash = hashState(jevState);

  const cached = cache.get(hash);
  if (cached) {
    return {
      heroes: rankHeroes(candidates, cached.heroes),
      jev: { model: "cached", latencyMs: 0, inputTokens: 0 },
      source: "jev",
      gaps: cached.nouls,
    };
  }

  const questions = buildDraftQuestions(candidates);
  if (Object.keys(questions).length === 0) {
    return unrankedList("no candidate has a curated description for the model to judge");
  }

  const outcome = await ask(jevState, questions);
  if (!outcome.ok) {
    logJevExchange({
      kind: "draft",
      hash,
      state: jevState,
      questions,
      ok: false,
      reason: outcome.reason,
    });
    return unrankedList(outcome.reason);
  }

  if (isStale(hash)) {
    logJevExchange({
      kind: "draft",
      hash,
      state: jevState,
      questions,
      ok: true,
      model: outcome.result.model,
      latencyMs: outcome.result.latencyMs,
      inputTokens: outcome.result.inputTokens,
      answers: outcome.result.answers,
      reason: "picks changed while the request was in flight",
    });
    return unrankedList("picks changed while the request was in flight");
  }

  const parsed = parseDraftAnswers(outcome.result.answers, candidates);
  cache.set(hash, parsed);

  const ranked = rankHeroes(candidates, parsed.heroes);
  logJevExchange({
    kind: "draft",
    hash,
    state: jevState,
    questions,
    ok: true,
    model: outcome.result.model,
    latencyMs: outcome.result.latencyMs,
    inputTokens: outcome.result.inputTokens,
    answers: outcome.result.answers,
    ranked: ranked.map((hero) => ({ name: hero.displayName, rank: hero.rank })),
  });

  return {
    heroes: ranked,
    jev: {
      model: outcome.result.model,
      latencyMs: outcome.result.latencyMs,
      inputTokens: outcome.result.inputTokens,
    },
    source: "jev",
    gaps: parsed.nouls,
  };
}

export function draftStateHash(state: MatchState): string {
  return hashState(buildDraftState(state));
}
