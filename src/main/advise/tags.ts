/**
 * The shared vocabulary between `data/hero-tags.json` (what an enemy threatens with)
 * and `data/item-tags.json` (what an item answers). Candidate generation is an
 * intersection of the two, so the two files have to agree on spelling — hence one
 * closed list rather than free text.
 *
 * Research §4.2: never rely on Jev knowing what a hero does. The `threat` strings in
 * the hero table are what actually reaches the model; these tags are for code.
 */
export const THREAT_TAGS = [
  "invisibility",
  "magic-burst",
  "physical",
  "illusions",
  "summons",
  "disable",
  "silence",
  "healing",
  "initiation",
  "channeled-ultimate",
  "pure-damage",
  "damage-over-time",
  "mana-burn",
  "armor-reduction",
  "aoe-teamfight",
  "slow",
  "high-mobility",
  "ranged-poke",
  "tanky",
  "evasion",
  "passive-reliant",
  "blink-escape",
] as const;

export type ThreatTag = (typeof THREAT_TAGS)[number];

/**
 * The second vocabulary: what an item *provides*, and what a hero *wants*.
 *
 * `THREAT_TAGS` answer "what is the enemy doing to me". These answer "what does my own
 * hero need to do its job" — Earthshaker wants a blink because his ultimate has to
 * land on a group, which is a different question from countering anything.
 */
export const PROVIDE_TAGS = [
  "blink",
  "mobility",
  "initiation",
  "spell-amplification",
  "mana-sustain",
  "mana-pool",
  "cooldown-reduction",
  "cast-range",
  "attack-speed",
  "attack-damage",
  "critical-strike",
  "lifesteal",
  "survivability",
  "armor",
  "magic-resistance",
  "status-resistance",
  "dispel",
  "save-ally",
  "farming-speed",
  "wave-clear",
  "illusion-scaling",
  "summon-scaling",
  "extra-disable",
  "ultimate-upgrade",
] as const;

export type ProvideTag = (typeof PROVIDE_TAGS)[number];

const TAG_SET: ReadonlySet<string> = new Set(THREAT_TAGS);
const PROVIDE_SET: ReadonlySet<string> = new Set(PROVIDE_TAGS);

export function isThreatTag(value: string): value is ThreatTag {
  return TAG_SET.has(value);
}

export function isProvideTag(value: string): value is ProvideTag {
  return PROVIDE_SET.has(value);
}

/** Hero entry as curated in `data/hero-tags.json`. */
export interface HeroTags {
  /** What this hero does *to you*. One clause, read inside a Jev question about enemies. */
  threat: string;
  tags: ThreatTag[];
  /**
   * What this hero does *from your own seat* — the abilities an item has to serve.
   * Optional: an uncurated kit means the hero simply contributes no synergy signal.
   */
  kit?: string;
  /** What the kit needs, for the code-side half of synergy matching. */
  wants?: ProvideTag[];
}

/** Item entry as curated in `data/item-tags.json`. */
export interface ItemTags {
  /** What the item does, in plain language. Also goes to Jev verbatim. */
  effect: string;
  /** Threat tags this item answers. Empty means "good item, not a counter-pick". */
  counters: ThreatTag[];
  /** What the item gives its owner, matched against a hero's `wants`. */
  provides?: ProvideTag[];
  /** True for items only worth buying when a matching threat exists. */
  situational: boolean;
}
