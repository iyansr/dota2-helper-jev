import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo root, resolved from this file rather than `process.cwd()` so scripts and the
 * packaged main process agree. POC-only: a real install would use
 * `app.getPath("userData")`.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const TOKEN_FILE = resolve(REPO_ROOT, ".gsi-token");

/** The name Dota uses for the cfg file, and the block name inside it. */
export const GSI_CFG_NAME = "gamestate_integration_jev.cfg";

export function readGsiToken(): string | null {
  if (!existsSync(TOKEN_FILE)) return null;
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  return token.length > 0 ? token : null;
}

/** Reads the existing token, or mints and persists a new one. */
export function ensureGsiToken(): string {
  const existing = readGsiToken();
  if (existing) return existing;
  const token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, `${token}\n`, "utf8");
  return token;
}
