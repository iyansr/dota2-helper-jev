import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import { REPO_ROOT } from "../../shared/gsi-token.ts";

/**
 * Every Jev exchange, written whole to `logs/jev-<start>.jsonl` and summarized to the
 * console. When a suggestion looks wrong the question is always "what did the model
 * actually see, and what did it actually say" — so the file keeps the full state,
 * every question, and every answer, not a digest of them.
 *
 * The state contains no credentials (the key lives in the client and never enters a
 * request body we build), so the file is safe to paste into an issue. It is gitignored
 * anyway, because it contains a whole match.
 *
 * `JEV_LOG=0` turns it off; `JEV_LOG_CONSOLE=0` keeps the file but silences the
 * terminal, which is what you want during a real game.
 */

export const LOG_DIR = resolve(REPO_ROOT, "logs");

export interface JevExchange {
  kind: "item" | "draft";
  /** State hash — the same one the freshness guard compares. */
  hash: string;
  state: unknown;
  questions: Questions;
  ok: boolean;
  /** Why the composite fell back to the baseline, when it did. */
  reason?: string;
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  /** Raw answers, exactly as they came back. */
  answers?: Record<string, unknown>;
  /** What the code finally showed, after weights. */
  ranked?: Array<{ name: string; rank: number }>;
}

const enabled = (): boolean => process.env.JEV_LOG !== "0";
const consoleEnabled = (): boolean => process.env.JEV_LOG_CONSOLE !== "0";

let file: string | null = null;
let warned = false;

function logFile(): string {
  if (file) return file;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(LOG_DIR, { recursive: true });
  file = join(LOG_DIR, `jev-${stamp}.jsonl`);
  console.log(`[jev] logging exchanges to ${file}`);
  return file;
}

interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
}

interface NoulAnswer {
  type: "noul";
  noul: number;
}

function isScore(value: unknown): value is ScoreAnswer {
  return typeof value === "object" && value !== null && (value as ScoreAnswer).type === "score";
}

function isNoul(value: unknown): value is NoulAnswer {
  return typeof value === "object" && value !== null && (value as NoulAnswer).type === "noul";
}

/** `fit_item_black_king_bar` → `fit black king bar`, so the summary stays readable. */
const pretty = (name: string): string => name.replace(/^item_|_item_/g, " ").replace(/_/g, " ").trim();

function summarize(exchange: JevExchange): string[] {
  const lines: string[] = [];
  const answers = exchange.answers ?? {};

  const scores = Object.entries(answers)
    .filter((entry): entry is [string, ScoreAnswer] => isScore(entry[1]))
    .sort((a, b) => b[1].score - a[1].score);
  const nouls = Object.entries(answers).filter((entry): entry is [string, NoulAnswer] =>
    isNoul(entry[1]),
  );

  if (scores.length > 0) {
    // Highest-scoring questions first: these are the ones that moved the ranking.
    const top = scores
      .slice(0, 4)
      .map(([name, a]) => `${pretty(name)} ${a.score.toFixed(2)}/${(a.confidence ?? 0).toFixed(2)}`)
      .join(" · ");
    lines.push(`  top scores (score/confidence): ${top}`);
  }
  if (nouls.length > 0) {
    lines.push(
      `  nouls: ${nouls.map(([name, a]) => `${pretty(name)} ${a.noul.toFixed(2)}`).join(" · ")}`,
    );
  }
  if (exchange.ranked && exchange.ranked.length > 0) {
    lines.push(
      `  → shown: ${exchange.ranked
        .slice(0, 3)
        .map((r) => `${r.name} (${Math.round(r.rank * 100)})`)
        .join(", ")}`,
    );
  }
  return lines;
}

export function logJevExchange(exchange: JevExchange): void {
  if (!enabled()) return;

  const record = { at: new Date().toISOString(), ...exchange };
  try {
    appendFileSync(logFile(), `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    // Logging must never take the advisor down with it.
    if (!warned) {
      warned = true;
      console.warn(`[jev] could not write the exchange log: ${String(error)}`);
    }
  }

  if (!consoleEnabled()) return;

  const questionCount = Object.keys(exchange.questions).length;
  if (!exchange.ok) {
    console.warn(`[jev] ${exchange.kind} · ${questionCount} questions · FAILED: ${exchange.reason}`);
    return;
  }

  console.log(
    `[jev] ${exchange.kind} · ${questionCount} questions · ${exchange.model} · ` +
      `${exchange.latencyMs}ms · ${exchange.inputTokens} input tokens · state ${exchange.hash}`,
  );
  for (const line of summarize(exchange)) console.log(line);
  if (exchange.reason) console.warn(`  ! discarded: ${exchange.reason}`);
}
