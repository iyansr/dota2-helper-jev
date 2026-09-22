/**
 * M1 acceptance — what did Dota actually send?
 *
 *   npm run gsi:summarize fixtures/match-1234567890.jsonl
 *
 * Prints, per `game_state`, which top-level providers appeared and which fields each
 * one carried. Answers research open questions #1 (does a *player* get `draft`?) and
 * #2 (exact `player`/`hero` field names on this patch) from evidence rather than docs.
 */
import { readFixture } from "../src/shared/fixture.ts";
import { IS_SPECTATOR_SHAPE } from "../src/main/gsi/types.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run gsi:summarize <fixture.jsonl>");
  process.exit(1);
}

type Seen = Map<string, Set<string>>;
const byState = new Map<string, { count: number; providers: Seen }>();
const allFields: Seen = new Map();
let total = 0;
let spectator = 0;
let draftPayloads = 0;
const matchIds = new Set<string>();

const record = (seen: Seen, provider: string, payload: unknown): void => {
  const set = seen.get(provider) ?? new Set<string>();
  seen.set(provider, set);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    // Collapse indexed keys (slot0..slot8, team2/player0) so the report stays readable.
    for (const key of Object.keys(payload)) set.add(key.replace(/\d+$/, "N"));
  } else {
    set.add(Array.isArray(payload) ? `[array]` : `[${typeof payload}]`);
  }
};

for await (const { payload } of readFixture(file)) {
  total += 1;
  const state = payload.map?.game_state ?? "(no map provider)";
  const entry = byState.get(state) ?? { count: 0, providers: new Map() as Seen };
  entry.count += 1;
  byState.set(state, entry);

  if (payload.map?.matchid && payload.map.matchid !== "0") matchIds.add(payload.map.matchid);
  if (IS_SPECTATOR_SHAPE(payload)) spectator += 1;
  if (payload.draft) draftPayloads += 1;

  for (const [provider, value] of Object.entries(payload)) {
    if (provider === "previously" || provider === "added" || provider === "auth") continue;
    record(entry.providers, provider, value);
    record(allFields, provider, value);
  }
}

console.log(`${file}`);
console.log(`${total} payloads · match ids: ${[...matchIds].join(", ") || "none"}`);
console.log(`spectator-shaped: ${spectator}/${total} · payloads carrying \`draft\`: ${draftPayloads}`);
// A synthetic fixture was written from the same documentation as the types, so it
// cannot answer anything about the real wire format. Say so rather than letting it
// look like evidence.
const synthetic = /(^|[\/])synthetic-/.test(file);
console.log(
  synthetic
    ? "→ synthetic fixture: proves nothing about what Dota sends. Run `npm run capture` for the real thing."
    : draftPayloads === 0
      ? "→ open question #1: no draft data in this capture. Manual enemy input stays mandatory."
      : "→ open question #1: draft data IS present — check below whether picks/bans are filled in.",
);

for (const [state, { count, providers }] of [...byState].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`\n── ${state}  (${count} payloads)`);
  for (const [provider, fields] of [...providers].sort()) {
    console.log(`   ${provider.padEnd(14)} ${[...fields].sort().join(", ")}`);
  }
}
