/**
 * M3 acceptance — what is curated, and what is missing.
 *
 *   npm run data:coverage
 *
 * Uncurated heroes and items are not a crash: they fall back to popularity-only
 * ranking and are never sent to Jev (plan §M3.2 — degrade, don't guess). This report
 * says how much of the game that currently affects, and who to curate next.
 */
import {
  allHeroes,
  curatedItemKeys,
  dataStatus,
  danglingCuration,
  getHeroAbilities,
  getHeroTags,
  getItem,
  getItemTags,
  heroPickVolume,
  providingItems,
  situationalItems,
  unknownTags,
} from "../src/main/data/index.ts";

const status = dataStatus();
console.log("snapshot");
console.log(`  heroes ${status.heroes} · items ${status.items}`);
console.log(`  hero abilities for ${status.heroesWithAbilities}/${status.heroes} heroes`);
console.log(`  item popularity for ${status.popularityHeroes} heroes · matchups for ${status.matchupHeroes}`);
console.log("curated");
console.log(`  hero tags ${status.curatedHeroes}/${status.heroes}`);
console.log(
  `  item tags ${status.curatedItems} (${situationalItems().length} situational, ` +
    `${providingItems().length} with provides)`,
);
// A hero with a `threat` but no `kit` is described as an enemy and invisible as the
// hero you are playing: no synergy question is asked and no synergy term is scored.
const noAbilities = allHeroes().filter((hero) => getHeroAbilities(hero.name).length === 0);
if (noAbilities.length > 0) {
  console.log(`    no ability data: ${noAbilities.map((h) => h.displayName).join(", ")}`);
}

const noKit = allHeroes().filter((hero) => {
  const tags = getHeroTags(hero.name);
  return tags && !tags.kit;
});
console.log(`  hero kits ${status.curatedHeroes - noKit.length}/${status.curatedHeroes} curated heroes`);
if (noKit.length > 0) {
  console.log(`    missing a kit: ${noKit.map((h) => h.displayName).join(", ")}`);
}

const bad = unknownTags();
if (bad.heroes.length || bad.items.length) {
  console.log("\ntags outside the shared vocabulary (typos — fix these first)");
  for (const [name, tag] of bad.heroes) console.log(`  hero ${name}: ${tag}`);
  for (const [key, tag] of bad.items) console.log(`  item ${key}: ${tag}`);
}

const dangling = danglingCuration();
if (dangling.heroes.length || dangling.items.length) {
  console.log("\ncurated entries with no match in the snapshot (renamed or removed)");
  for (const name of dangling.heroes) console.log(`  hero ${name}`);
  for (const key of dangling.items) console.log(`  item ${key}`);
}

// A curated item the shop no longer sells still has an OpenDota entry, just with no
// cost - so a missing-key check does not catch it. This is what removal looks like.
const unbuyable = curatedItemKeys().filter((key) => (getItem(key)?.cost ?? 0) <= 0);
if (unbuyable.length > 0) {
  console.log("");
  console.log("curated items the shop does not sell (removed from the game?)");
  for (const key of unbuyable) console.log(`  ${key}`);
}

const missing = allHeroes()
  .filter((hero) => !getHeroTags(hero.name))
  .map((hero) => ({ ...hero, volume: heroPickVolume(hero.id) }))
  .sort((a, b) => b.volume - a.volume);

if (missing.length > 0) {
  console.log(`\nmost-played heroes with no threat summary (${missing.length} total)`);
  for (const hero of missing.slice(0, 20)) {
    console.log(`  ${hero.displayName.padEnd(22)} ${hero.roles.join(", ")}`);
  }
  if (missing.length > 20) console.log(`  …and ${missing.length - 20} more`);
}

// A situational item nothing can trigger is dead weight in the candidate builder.
const heroTagUniverse = new Set(allHeroes().flatMap((h) => getHeroTags(h.name)?.tags ?? []));
const unreachable = situationalItems().filter(
  ({ key }) => !(getItemTags(key)?.counters ?? []).some((tag) => heroTagUniverse.has(tag)),
);
if (unreachable.length > 0) {
  console.log("\nsituational items no curated hero can trigger");
  for (const { key } of unreachable) console.log(`  ${key}`);
}
