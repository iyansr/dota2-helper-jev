import { createHash } from "node:crypto";
import { TypeSafeClient, type Questions } from "@typesafe-ai/sdk";

/**
 * The only place the SDK is constructed, and it lives in the main process (research
 * §4.7): the key never crosses IPC and `dangerouslyAllowBrowser` stays false.
 *
 * The POC reads `TYPESAFE_API_KEY` from `.env` and is personal-use only. Distributing
 * it needs the proxy from research §4.7 first — a key inside a packaged app is a
 * published key, asar or not.
 */

/** 2s: a suggestion that arrives after the fight is worse than no suggestion. */
const TIMEOUT_MS = 2000;

let client: TypeSafeClient | null = null;
let disabledReason: string | null = null;
/** The overlay's ranking toggle. The env gate still has the final say. */
let runtimeEnabled = true;

export function setJevRuntimeEnabled(value: boolean): void {
  runtimeEnabled = value;
}

export function jevEnabled(): boolean {
  return runtimeEnabled && process.env.ENABLE_JEV === "1" && Boolean(process.env.TYPESAFE_API_KEY);
}

export function jevStatus(): string {
  if (process.env.ENABLE_JEV !== "1") return "off (ENABLE_JEV is not 1)";
  if (!process.env.TYPESAFE_API_KEY) return "off (TYPESAFE_API_KEY is not set)";
  if (!runtimeEnabled) return "off (ranking turned off in the overlay)";
  return disabledReason ?? "on";
}

function getClient(): TypeSafeClient | null {
  if (!jevEnabled()) return null;
  if (client) return client;
  try {
    client = new TypeSafeClient({ timeout: TIMEOUT_MS });
    return client;
  } catch (error) {
    disabledReason = `off (client failed to construct: ${String(error)})`;
    return null;
  }
}

/** Stable hash of the state the request was built from, for the freshness check. */
export function hashState(state: unknown): string {
  return createHash("sha1").update(JSON.stringify(state)).digest("hex").slice(0, 16);
}

export interface AskResult {
  answers: Record<string, unknown>;
  model: string;
  latencyMs: number;
  inputTokens: number;
}

export type AskOutcome =
  | { ok: true; result: AskResult }
  | { ok: false; reason: string };

/**
 * One request, all questions. Never throws: on timeout, rate limit or any other
 * failure the caller shows the candidates unranked — advisory UI must never block or
 * blank (plan §3.5).
 */
export async function ask(state: unknown, questions: Questions): Promise<AskOutcome> {
  const c = getClient();
  if (!c) return { ok: false, reason: jevStatus() };
  if (Object.keys(questions).length === 0) return { ok: false, reason: "no questions to ask" };

  const startedAt = Date.now();
  try {
    const response = await c.systemOne({ state: state as Parameters<typeof c.systemOne>[0]["state"], questions });
    return {
      ok: true,
      result: {
        answers: response.answers as Record<string, unknown>,
        // Logged per request so a tuned setup can pin the version: `jev-latest` moves.
        model: response.model,
        latencyMs: Date.now() - startedAt,
        inputTokens: response.usage.input_tokens,
      },
    };
  } catch (error) {
    return { ok: false, reason: `${error instanceof Error ? error.name : "error"}: ${String(error)}` };
  }
}
