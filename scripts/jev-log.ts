/**
 * Read back a Jev exchange log.
 *
 *   npm run jev:log                  # last 5 exchanges from the newest log
 *   npm run jev:log -- --n 20
 *   npm run jev:log -- --hash 905bc2072213a390    # one exchange in full
 *   npm run jev:log -- --file logs/jev-....jsonl
 *
 * The console output during a game is a summary; this is where you go when a
 * suggestion looked wrong and you need the exact state, question and answer.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR, type JevExchange } from "../src/main/jev/log.ts";

function option(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function newestLog(): string | null {
  let files: string[];
  try {
    files = readdirSync(LOG_DIR).filter((f) => f.startsWith("jev-") && f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  // Names are ISO timestamps, so lexical order is chronological.
  const newest = files.sort().at(-1);
  return newest ? join(LOG_DIR, newest) : null;
}

const file = option("file") ?? newestLog();
if (!file) {
  console.error(`No Jev logs in ${LOG_DIR}. Run the app or the demo with ENABLE_JEV=1 first.`);
  process.exit(1);
}

type Entry = JevExchange & { at: string };

const entries: Entry[] = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Entry);

console.log(`${file} — ${entries.length} exchanges\n`);

const wanted = option("hash");
if (wanted) {
  const entry = entries.find((e) => e.hash.startsWith(wanted));
  if (!entry) {
    console.error(`No exchange with a hash starting "${wanted}".`);
    process.exit(1);
  }
  // Full dump: state, every question with its criteria, every answer.
  console.log(JSON.stringify(entry, null, 2));
  process.exit(0);
}

const count = Number(option("n") ?? 5);
for (const entry of entries.slice(-Math.max(1, count))) {
  const time = entry.at.slice(11, 19);
  if (!entry.ok) {
    console.log(`${time}  ${entry.kind}  FAILED: ${entry.reason}`);
    continue;
  }
  console.log(
    `${time}  ${entry.kind}  ${entry.model}  ${entry.latencyMs}ms  ` +
      `${entry.inputTokens} tok  hash ${entry.hash}${entry.reason ? `  (discarded: ${entry.reason})` : ""}`,
  );

  const state = entry.state as { me?: { hero?: string; level?: number }; enemies?: Array<{ hero: string }>; situation?: Record<string, string> };
  if (state.me?.hero) console.log(`    ${"me".padEnd(14)}${state.me.hero} lvl ${state.me.level ?? "?"}`);
  if (state.enemies?.length) {
    console.log(`    ${"enemies".padEnd(14)}${state.enemies.map((e) => e.hero).join(", ")}`);
  }
  if (state.situation) {
    for (const [key, value] of Object.entries(state.situation)) {
      console.log(`    ${key.padEnd(14)}${value}`);
    }
  }
  if (entry.ranked?.length) {
    console.log(`    ${"shown".padEnd(14)}${entry.ranked.slice(0, 3).map((r) => r.name).join(", ")}`);
  }
  console.log(`    (npm run jev:log -- --hash ${entry.hash}  for the full exchange)\n`);
}
