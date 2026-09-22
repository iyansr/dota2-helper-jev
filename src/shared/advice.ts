/** What the renderer receives. Shared between main and renderer. */

/** `jev` = ordered by the model. `unranked` = Jev unavailable; candidates only. */
export type AdviceSource = "jev" | "unranked";

export interface ItemSuggestion {
  key: string;
  displayName: string;
  cost: number;
  /** 0 when affordable right now. */
  goldToGo: number;
  /** The model's `overall` Score, 0..1. This *is* the ordering. */
  rank: number;
  /** One line, rendered from a code template — never model-generated (plan §M5). */
  why: string;
  /** Show it, but mark it: the model reported low confidence, or did not rate it. */
  situational: boolean;
  /** False when the model was not asked about this candidate (uncurated item). */
  rated: boolean;
  breakdown: {
    /** The ordering score and the model's confidence in it. */
    overall: number;
    confidence: number;
    /** Dimensions shown for explanation only — they do not affect the order. */
    fit: number;
    need: number;
    synergy: number;
  };
}

export interface HeroSuggestion {
  id: number;
  name: string;
  displayName: string;
  rank: number;
  why: string;
  situational: boolean;
  rated: boolean;
  breakdown: {
    overall: number;
    confidence: number;
    fillsGap: number;
    vsEnemies: number;
  };
}

export interface Advice {
  source: AdviceSource;
  items: ItemSuggestion[];
  heroes: HeroSuggestion[];
  /** Populated when a Jev request was made: model id, latency, token usage. */
  jev: {
    model: string;
    latencyMs: number;
    inputTokens: number;
    /** Set when the list could not be ranked and is shown unordered. */
    fallbackReason?: string;
  } | null;
  /** ms epoch the advice was produced. */
  at: number;
}

export const EMPTY_ADVICE: Advice = {
  source: "unranked",
  items: [],
  heroes: [],
  jev: null,
  at: 0,
};
