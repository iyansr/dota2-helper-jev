import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { serializeLine } from "../../shared/fixture.ts";
import { REPO_ROOT } from "../../shared/gsi-token.ts";
import type { GsiPayload } from "./types.ts";

export const FIXTURE_DIR = resolve(REPO_ROOT, "fixtures");

/**
 * Appends every payload to `fixtures/<matchid|timestamp>.jsonl`.
 *
 * The file is chosen lazily from the first payload that carries a `matchid`, so a
 * session that starts in the main menu still lands in one file per match. Writes are
 * synchronous and unbuffered: a capture that survives an Alt+F4 is worth more than a
 * fast one, and Dota throttles to ~10 payloads/s.
 */
export function createCaptureSink(dir: string = FIXTURE_DIR): {
  write(payload: GsiPayload): void;
  currentFile(): string;
  count(): number;
} {
  mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  const fallbackName = `session-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}`;
  let name: string | null = null;
  let written = 0;

  const file = (): string => join(dir, `${name ?? fallbackName}.jsonl`);

  return {
    write(payload) {
      const matchid = payload.map?.matchid;
      // "0" is what Dota reports outside a match; don't let it name the file.
      if (name === null && matchid && matchid !== "0") {
        const from = file();
        name = `match-${matchid}`;
        // Everything captured before the match id arrived (menu, queue, loading)
        // belongs to this match too — carry it over instead of splitting the session.
        if (existsSync(from) && !existsSync(file())) renameSync(from, file());
      }
      appendFileSync(file(), serializeLine({ t: Date.now() - startedAt, payload }), "utf8");
      written += 1;
    },
    currentFile: file,
    count: () => written,
  };
}
