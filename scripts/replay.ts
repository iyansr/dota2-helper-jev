/**
 * M2.1 — replay a recorded session at a running GSI server.
 *
 *   npm run replay fixtures/match-1234567890.jsonl -- --speed 8
 *
 * Everything after M2 is developed against replays: no Dota client, no queue times,
 * and the same decision points every run. `--speed` scales the recorded inter-payload
 * deltas; `--live` waits them out at 1x.
 */
import { DEFAULT_GSI_PATH, DEFAULT_GSI_PORT } from "../src/main/gsi/server.ts";
import { readFixture } from "../src/shared/fixture.ts";
import { readGsiToken } from "../src/shared/gsi-token.ts";

function flag(name: string, fallback: number): number {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  const value = eq ? eq.slice(name.length + 3) : argv[argv.indexOf(`--${name}`) + 1];
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("usage: npm run replay <fixture.jsonl> [-- --speed 8] [--port 52817]");
  process.exit(1);
}

const speed = process.argv.includes("--live") ? 1 : flag("speed", 8);
const port = flag("port", DEFAULT_GSI_PORT);
const token = readGsiToken();
if (!token) {
  console.error("No .gsi-token found. Run `npm run setup:gsi -- --dota-path ...` first.");
  process.exit(1);
}

const endpoint = `http://127.0.0.1:${port}${DEFAULT_GSI_PATH}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`Replaying ${file} → ${endpoint} at ${speed}x`);

let sent = 0;
let failed = 0;
let previousT = 0;

for await (const line of readFixture(file)) {
  const wait = Math.max(0, (line.t - previousT) / speed);
  previousT = line.t;
  if (wait > 1) await sleep(wait);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The fixture has the token stripped (capture never records `auth`); put the
      // local one back so the server's auth check exercises the real path.
      body: JSON.stringify({ ...line.payload, auth: { token } }),
    });
    if (!res.ok) failed += 1;
  } catch (error) {
    failed += 1;
    if (failed === 1) console.error(`POST failed — is the app or \`npm run capture\` running? ${String(error)}`);
  }

  sent += 1;
  if (sent % 50 === 0) process.stdout.write(`\r  ${sent} payloads sent  `);
}

console.log(`\nDone: ${sent} payloads, ${failed} failed.`);
