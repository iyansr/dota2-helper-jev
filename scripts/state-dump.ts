/**
 * M2 acceptance — watch `MatchState` + `Situation` evolve, with no Dota running.
 *
 *   npm run state fixtures/synthetic-juggernaut-40min.jsonl   # offline, as fast as it reads
 *   npm run state                                             # live: listens, then `npm run replay`
 *
 * Prints only when something interesting moves, so a 40-minute game fits on a screen.
 */
import { createGsiServer, DEFAULT_GSI_PORT } from "../src/main/gsi/server.ts";
import { formatClock, situationOf } from "../src/main/match/situation.ts";
import { MatchStore, type MatchChange } from "../src/main/match/store.ts";
import type { GsiPayload } from "../src/main/gsi/types.ts";
import { readFixture } from "../src/shared/fixture.ts";
import { readGsiToken } from "../src/shared/gsi-token.ts";

const store = new MatchStore();
let lastSituation = "";

function report(change: MatchChange): void {
  const state = store.state();
  const situation = situationOf(state);
  const key = JSON.stringify(situation);
  const situationMoved = key !== lastSituation;

  const reasons = [
    change.reset && "RESET",
    change.gameStateChanged && `state=${state.gameState.replace("DOTA_GAMERULES_STATE_", "")}`,
    change.itemsChanged && "items",
    change.died && "died",
    change.respawned && "respawned",
    situationMoved && "situation",
  ].filter(Boolean) as string[];
  if (reasons.length === 0) return;
  lastSituation = key;

  console.log(
    `\n[${formatClock(state.clock)}] ${reasons.join(" · ")}` +
      `\n  hero      ${state.hero.name ?? "—"} lvl ${state.hero.level}` +
      ` ${state.hero.alive ? "alive" : `dead (${state.hero.respawnSeconds}s)`}` +
      `\n  gold      ${state.gold.total} (net worth ${state.gold.netWorth}, ${state.gold.gpm} gpm)` +
      `\n  items     ${state.items.slots.join(", ") || "none"}` +
      `${state.items.neutral ? `  [neutral: ${state.items.neutral}]` : ""}` +
      `\n  score     ${state.score.mine}-${state.score.theirs} · kda ${state.kda.kills}/${state.kda.deaths}/${state.kda.assists}` +
      `\n  situation ${situation.phase} · ${situation.team_lead}` +
      `\n            ${situation.recent_deaths}` +
      `\n            ${situation.towers}` +
      `\n            ${situation.net_worth} · ${situation.roshan}`,
  );
}

const file = process.argv[2];

if (file) {
  for await (const line of readFixture(file)) report(store.apply(line.payload));
  const state = store.state();
  console.log(
    `\n─── end of ${file}: match ${state.matchId ?? "?"}, ${state.deaths.length} deaths,` +
      ` ${state.items.slots.length} items, ${state.towers.mineLost} towers lost`,
  );
} else {
  const token = readGsiToken();
  if (!token) {
    console.error("No .gsi-token found. Run `npm run setup:gsi -- --dota-path ...` first.");
    process.exit(1);
  }
  const server = createGsiServer({
    token,
    onPayload: (payload: GsiPayload) => report(store.apply(payload)),
    onReject: (reason) => console.warn(`rejected: ${reason}`),
  });
  await server.start();
  console.log(`Listening on http://127.0.0.1:${DEFAULT_GSI_PORT}/gsi — replay or play. Ctrl+C to stop.`);
}
