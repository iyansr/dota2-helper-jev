/**
 * M1.1 — write the GSI config Dota reads at launch.
 *
 *   npm run setup:gsi -- --dota-path "C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta"
 *
 * Auto-discovering the Steam library is deliberately out of scope (plan §0); a few
 * default locations are probed as a convenience and nothing more.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_GSI_PATH, DEFAULT_GSI_PORT } from "../src/main/gsi/server.ts";
import { ensureGsiToken, GSI_CFG_NAME, TOKEN_FILE } from "../src/shared/gsi-token.ts";

const DEFAULT_DOTA_PATHS = [
  "C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta",
  "D:\Steam\steamapps\common\dota 2 beta",
  "D:\SteamLibrary\steamapps\common\dota 2 beta",
  join(homedir(), "Library/Application Support/Steam/steamapps/common/dota 2 beta"),
  join(homedir(), ".steam/steam/steamapps/common/dota 2 beta"),
  join(homedir(), ".local/share/Steam/steamapps/common/dota 2 beta"),
];

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function findDotaPath(): string | null {
  const explicit = argValue("--dota-path");
  if (explicit) return resolve(explicit.replace(/^"|"$/g, ""));
  return DEFAULT_DOTA_PATHS.find((p) => existsSync(join(p, "game", "dota"))) ?? null;
}

function cfgBody(token: string, uri: string): string {
  // Valve KeyValues, not JSON. Tabs and quoted values; every data flag is a string.
  const data: Array<[string, "0" | "1"]> = [
    ["provider", "1"],
    ["map", "1"],
    ["player", "1"],
    ["hero", "1"],
    ["abilities", "1"],
    ["items", "1"],
    ["draft", "1"],
    ["events", "1"],
    ["buildings", "1"],
    ["roshan", "1"],
    ["couriers", "1"],
    ["neutralitems", "1"],
    ["minimap", "0"],
    ["wearables", "0"],
    ["league", "0"],
  ];
  const pad = (k: string) => `"${k}"`.padEnd(18);
  return [
    `"dota2-helper-jev"`,
    `{`,
    `    ${pad("uri")}"${uri}"`,
    `    ${pad("timeout")}"5.0"`,
    `    ${pad("buffer")}"0.1"`,
    `    ${pad("throttle")}"0.1"`,
    `    ${pad("heartbeat")}"30.0"`,
    `    "auth"`,
    `    {`,
    `        ${pad("token")}"${token}"`,
    `    }`,
    `    "data"`,
    `    {`,
    ...data.map(([k, v]) => `        ${pad(k)}"${v}"`),
    `    }`,
    `}`,
    ``,
  ].join("\n");
}

function main(): void {
  // Replay-driven development needs the token but not a Dota install (plan §M2), and
  // anyone with an unusual Steam layout can paste the printed cfg in by hand.
  if (process.argv.includes("--token-only")) {
    const token = ensureGsiToken();
    console.log(`Token stored in ${TOKEN_FILE}`);
    console.log(`
Paste this as ${GSI_CFG_NAME} in <dota 2 beta>/game/dota/cfg/gamestate_integration/:
`);
    console.log(cfgBody(token, `http://127.0.0.1:${DEFAULT_GSI_PORT}${DEFAULT_GSI_PATH}`));
    return;
  }

  const dotaPath = findDotaPath();
  if (!dotaPath) {
    console.error(
      [
        "Could not find your Dota 2 install. Pass it explicitly:",
        '  npm run setup:gsi -- --dota-path "C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta"',
        "",
        "If Dota lives in a non-default Steam library, look in steamapps/libraryfolders.vdf",
        "for the library that lists app 570.",
        "",
        "No Dota install here? `npm run setup:gsi -- --token-only` mints the token and",
        "prints the cfg, which is all the replay harness needs.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const cfgDir = join(dotaPath, "game", "dota", "cfg", "gamestate_integration");
  if (!existsSync(join(dotaPath, "game", "dota"))) {
    console.error(`Not a Dota 2 install (no game/dota under it): ${dotaPath}`);
    process.exit(1);
  }

  const token = ensureGsiToken();
  const uri = `http://127.0.0.1:${DEFAULT_GSI_PORT}${DEFAULT_GSI_PATH}`;
  mkdirSync(cfgDir, { recursive: true });
  const cfgFile = join(cfgDir, GSI_CFG_NAME);
  writeFileSync(cfgFile, cfgBody(token, uri), "utf8");

  console.log(
    [
      `Wrote ${cfgFile}`,
      `Token stored in ${TOKEN_FILE} (gitignored — keep it out of commits)`,
      `Endpoint ${uri}`,
      ``,
      `Two things left, both manual:`,
      `  1. Steam → Library → Dota 2 → Properties → Launch Options:  -gamestateintegration`,
      `  2. Settings → Video → Display Mode:  Borderless Windowed`,
      `     (the overlay cannot draw over exclusive fullscreen — plan §5)`,
    ].join("\n"),
  );
}

main();
