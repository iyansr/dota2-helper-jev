import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { GsiPayload } from "../main/gsi/types.ts";

/**
 * One line of a recorded GSI session. `t` is milliseconds since the start of the
 * capture — replay needs the inter-payload deltas, and the payload's own
 * `provider.timestamp` is second-resolution and pauses with the game.
 */
export interface FixtureLine {
  t: number;
  payload: GsiPayload;
}

export function serializeLine(line: FixtureLine): string {
  return `${JSON.stringify(line)}\n`;
}

/** Streams a `.jsonl` fixture, skipping blank and unparseable lines. */
export async function* readFixture(file: string): AsyncGenerator<FixtureLine> {
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo += 1;
    const text = raw.trim();
    if (text.length === 0) continue;
    try {
      const parsed = JSON.parse(text) as FixtureLine;
      if (typeof parsed.t === "number" && parsed.payload) yield parsed;
    } catch {
      console.warn(`skipping unparseable line ${lineNo} of ${file}`);
    }
  }
}
