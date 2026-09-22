/**
 * M1.3 — standalone capture. No Electron, no UI: just record what Dota sends.
 *
 *   npm run capture
 *
 * Run it, play one matchmaking game (hero selection → post game), then spectate one.
 * The two fixtures that fall out answer research open questions #1 and #2, and
 * `npm run gsi:summarize` reports what actually arrived.
 */
import { createCaptureSink, FIXTURE_DIR } from "../src/main/gsi/capture.ts";
import { createGsiServer, DEFAULT_GSI_PORT } from "../src/main/gsi/server.ts";
import { IS_SPECTATOR_SHAPE } from "../src/main/gsi/types.ts";
import { readGsiToken } from "../src/shared/gsi-token.ts";

const token = readGsiToken();
if (!token) {
  console.error("No .gsi-token found. Run `npm run setup:gsi -- --dota-path ...` first.");
  process.exit(1);
}

const sink = createCaptureSink();
let lastState = "";
let sawSpectator = false;

const server = createGsiServer({
  token,
  onPayload(payload) {
    sink.write(payload);

    const state = payload.map?.game_state ?? "(no map)";
    if (state !== lastState) {
      lastState = state;
      console.log(`[${new Date().toLocaleTimeString()}] game_state → ${state}`);
    }
    if (!sawSpectator && IS_SPECTATOR_SHAPE(payload)) {
      sawSpectator = true;
      console.log("  ↑ spectator-shaped payload (per-player data present)");
    }
    if (sink.count() % 100 === 0) {
      process.stdout.write(`\r  ${sink.count()} payloads → ${sink.currentFile()}   `);
    }
  },
  onReject(reason) {
    console.warn(`rejected: ${reason}`);
  },
});

await server.start();
console.log(`Listening on http://127.0.0.1:${DEFAULT_GSI_PORT}/gsi`);
console.log(`Writing to ${FIXTURE_DIR}`);
console.log("Waiting for the first heartbeat — launch Dota with -gamestateintegration. Ctrl+C to stop.\n");

const shutdown = async (): Promise<void> => {
  console.log(`\n${sink.count()} payloads written to ${sink.currentFile()}`);
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
