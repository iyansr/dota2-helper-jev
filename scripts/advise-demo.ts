/**
 * M4 + M6 acceptance — run the advisors over a fixture, with no Dota and no UI.
 *
 *   npm run advise:demo fixtures/synthetic-juggernaut-40min.jsonl -- \
 *     --enemies riki,lion,pudge,sniper,axe --role carry
 *
 *   ENABLE_JEV=1 npm run advise:demo fixtures/x.jsonl -- --enemies ... --compare
 *
 * `--compare` prints the raw candidate list next to the ranked one, so you can see
 * what the model reordered. There is no code-side ranking to compare against: Jev
 * owns the order.
 */
import "dotenv/config";
import { adviseItems } from "../src/main/advise/items.ts";
import { adviseDraft } from "../src/main/advise/draft.ts";
import { itemCandidates } from "../src/main/advise/candidates.ts";
import { rankItems } from "../src/main/advise/rank.ts";
import { getHeroByName, heroDisplayName } from "../src/main/data/index.ts";
import { formatClock, situationOf } from "../src/main/match/situation.ts";
import { MatchStore } from "../src/main/match/store.ts";
import { jevStatus } from "../src/main/jev/client.ts";
import type { ItemSuggestion } from "../src/shared/advice.ts";
import type { Role } from "../src/shared/match.ts";
import { readFixture } from "../src/shared/fixture.ts";

function option(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("usage: npm run advise:demo <fixture.jsonl> [-- --enemies riki,lion --role carry --compare]");
  process.exit(1);
}

/** Accepts `riki` or the full `npc_dota_hero_riki`. */
function heroName(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/\s+/g, "_");
  if (trimmed.length === 0) return null;
  const full = trimmed.startsWith("npc_dota_hero_") ? trimmed : `npc_dota_hero_${trimmed}`;
  if (!getHeroByName(full)) {
    console.warn(`unknown hero "${input}" — skipping`);
    return null;
  }
  return full;
}

const enemies = (option("enemies") ?? "").split(",").map(heroName).filter((n): n is string => n !== null);
const allies = (option("allies") ?? "").split(",").map(heroName).filter((n): n is string => n !== null);
const role = (option("role") ?? "carry") as Role;
const compare = process.argv.includes("--compare");

const store = new MatchStore();
store.reportEnemies(enemies);
store.reportAllies(allies);
store.reportRole(role);

const line = (s: ItemSuggestion, index: number): string =>
  `   ${index + 1}. ${s.displayName.padEnd(20)} ${s.rated ? String(Math.round(s.rank * 100)).padStart(3) : "  -"}` +
  `  ${s.goldToGo === 0 ? "affordable" : `${s.goldToGo}g to go`}` +
  `${s.situational ? (s.rated ? "  [low confidence]" : "  [unrated]") : ""}\n      ${s.why}`;

console.log(`Jev: ${jevStatus()}`);
console.log(`enemies: ${enemies.map(heroDisplayName).join(", ") || "none reported"}`);
console.log(`role: ${role}\n`);

let lastPhase = "";
let decisions = 0;

for await (const { payload } of readFixture(file)) {
  const change = store.apply(payload);
  const state = store.state();
  const situation = situationOf(state);

  const phaseChanged = situation.phase !== lastPhase;
  // A decision point, as the trigger engine defines one: phase change, purchase, death.
  if (!phaseChanged && !change.itemsChanged && !change.died) continue;
  if (state.hero.id === null) continue;
  lastPhase = situation.phase;
  decisions += 1;

  const reason = phaseChanged ? `phase → ${situation.phase}` : change.died ? "died" : "bought an item";
  console.log(`\n[${formatClock(state.clock)}] ${reason} · ${state.gold.total} gold · ${situation.team_lead}`);

  const advice = await adviseItems(state);
  if (compare) {
    // There is no code-side ranking to compare against any more — Jev owns the order.
    // What is still worth seeing is the candidate list before it was ranked.
    const raw = rankItems(itemCandidates(state, situation.phase), null);
    console.log("  candidates, unranked:");
    raw.slice(0, 3).forEach((s, i) => console.log(line(s, i)));
    console.log(`  ${advice.source}${advice.jev ? ` (${advice.jev.model}, ${advice.jev.latencyMs}ms)` : ""}:`);
  }
  advice.items.slice(0, 3).forEach((s, i) => console.log(line(s, i)));
  if (advice.jev?.fallbackReason) console.log(`   ! unranked: ${advice.jev.fallbackReason}`);
}

console.log(`\n${decisions} decision points.`);

// The draft panel is judged on the reported picks alone, so it runs once at the end.
if (enemies.length > 0) {
  const draft = await adviseDraft(store.state());
  console.log(`\ndraft suggestions vs ${enemies.map(heroDisplayName).join(", ")} (${draft.source}):`);
  for (const [index, hero] of draft.heroes.slice(0, 5).entries()) {
    console.log(`   ${index + 1}. ${hero.displayName.padEnd(20)} ${hero.rated ? String(Math.round(hero.rank * 100)).padStart(3) : "  -"}${hero.situational ? "  [low confidence]" : ""}\n      ${hero.why}`);
  }
  if (draft.gaps) {
    const gaps = Object.entries(draft.gaps)
      .filter(([, value]) => value > 0.6)
      .map(([key]) => key.replace("lacks", "lacks "));
    console.log(`   model's read on the ally side: ${gaps.length ? gaps.join(", ") : "no clear gaps"}`);
  }
}
