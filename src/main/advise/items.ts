import type { Advice, ItemSuggestion } from "../../shared/advice.ts";
import type { MatchState, Situation } from "../../shared/match.ts";
import { ask, hashState, jevEnabled } from "../jev/client.ts";
import { logJevExchange } from "../jev/log.ts";
import { buildItemQuestions, buildItemState, parseItemAnswers } from "../jev/questions.ts";
import { situationOf } from "../match/situation.ts";
import { AnswerCache } from "./cache.ts";
import { itemCandidates } from "./candidates.ts";
import { rankItems, type JevItemAnswer } from "./rank.ts";

const cache = new AnswerCache<Map<string, JevItemAnswer>>();

export function clearItemCache(): void {
  cache.clear();
}

export interface ItemAdvice {
  items: ItemSuggestion[];
  jev: Advice["jev"];
  source: Advice["source"];
}

/**
 * The item advisor.
 *
 * Jev owns the ordering, so when it is unavailable there is no second opinion to fall
 * back to: the candidate list comes back **unranked**, marked as such, and the UI says
 * so. That is the trade for removing the code-side composite — the panel still never
 * blocks or blanks, but it stops claiming to know which item is best.
 *
 * `isStale` is checked after the response lands: items bought or enemies edited in the
 * meantime invalidate the answer (plan §3.5).
 */
export async function adviseItems(
  state: MatchState,
  isStale: (hash: string) => boolean = () => false,
): Promise<ItemAdvice> {
  const situation: Situation = situationOf(state);
  const candidates = itemCandidates(state, situation.phase);
  const unranked = (reason?: string): ItemAdvice => ({
    items: rankItems(candidates, null),
    jev: reason ? { model: "none", latencyMs: 0, inputTokens: 0, fallbackReason: reason } : null,
    source: "unranked",
  });

  if (candidates.length === 0) return unranked();
  if (!jevEnabled()) return unranked("Jev is off, so nothing ranks the candidates");

  const jevState = buildItemState(state, situation);
  const hash = hashState(jevState);

  const cached = cache.get(hash);
  if (cached) {
    return {
      items: rankItems(candidates, cached),
      jev: { model: "cached", latencyMs: 0, inputTokens: 0 },
      source: "jev",
    };
  }

  const questions = buildItemQuestions(candidates, jevState.me.abilities.length > 0);
  // Every question is per-candidate now: with nothing the model can judge, there is
  // nothing to ask and nothing to rank.
  if (Object.keys(questions).length === 0) {
    return unranked("no candidate has a curated description for the model to judge");
  }

  const outcome = await ask(jevState, questions);
  if (!outcome.ok) {
    logJevExchange({
      kind: "item",
      hash,
      state: jevState,
      questions,
      ok: false,
      reason: outcome.reason,
    });
    return unranked(outcome.reason);
  }

  if (isStale(hash)) {
    logJevExchange({
      kind: "item",
      hash,
      state: jevState,
      questions,
      ok: true,
      model: outcome.result.model,
      latencyMs: outcome.result.latencyMs,
      inputTokens: outcome.result.inputTokens,
      answers: outcome.result.answers,
      reason: "state changed while the request was in flight",
    });
    return unranked("state changed while the request was in flight");
  }

  const parsed = parseItemAnswers(outcome.result.answers, candidates);
  cache.set(hash, parsed);

  const ranked = rankItems(candidates, parsed);
  logJevExchange({
    kind: "item",
    hash,
    state: jevState,
    questions,
    ok: true,
    model: outcome.result.model,
    latencyMs: outcome.result.latencyMs,
    inputTokens: outcome.result.inputTokens,
    answers: outcome.result.answers,
    ranked: ranked.map((item) => ({ name: item.displayName, rank: item.rank })),
  });

  return {
    items: ranked,
    jev: {
      model: outcome.result.model,
      latencyMs: outcome.result.latencyMs,
      inputTokens: outcome.result.inputTokens,
    },
    source: "jev",
  };
}

/** The hash the current state would produce — for the caller's staleness check. */
export function itemStateHash(state: MatchState): string {
  return hashState(buildItemState(state, situationOf(state)));
}
