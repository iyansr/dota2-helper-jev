import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, Menu, nativeImage, screen, Tray } from "electron";
import "dotenv/config";
import { EMPTY_ADVICE, type Advice } from "../shared/advice.ts";
import type { GsiHealth, OverlayStatus, Snapshot } from "../shared/ipc.ts";
import type { Role } from "../shared/match.ts";
import { adviseDraft, draftStateHash } from "./advise/draft.ts";
import { adviseItems, itemStateHash } from "./advise/items.ts";
import { DraftTrigger, ItemTrigger } from "./advise/triggers.ts";
import { dataStatus } from "./data/index.ts";
import { createGsiServer, DEFAULT_GSI_PATH, DEFAULT_GSI_PORT } from "./gsi/server.ts";
import { jevStatus, setJevRuntimeEnabled } from "./jev/client.ts";
import { pushSnapshot, registerIpc } from "./ipc.ts";
import { situationOf } from "./match/situation.ts";
import { MatchStore, type MatchChange } from "./match/store.ts";
import { readGsiToken } from "../shared/gsi-token.ts";

/** A heartbeat is configured at 30s; twice that with nothing means Dota is gone. */
const STALE_AFTER_MS = 65_000;
const HERO_SELECTION = "DOTA_GAMERULES_STATE_HERO_SELECTION";

const store = new MatchStore();
let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let interactive = false;
let useJev = true;
let advice: Advice = EMPTY_ADVICE;
let lastPayloadAt: number | null = null;
let gsiError: string | null = null;

// ─── window position, persisted ──────────────────────────────────────────────
interface Persisted {
  x: number;
  y: number;
  useJev: boolean;
}

const settingsFile = (): string => join(app.getPath("userData"), "overlay.json");

function loadSettings(): Partial<Persisted> {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8")) as Partial<Persisted>;
  } catch {
    return {};
  }
}

function saveSettings(): void {
  if (!overlay || overlay.isDestroyed()) return;
  const [x = 0, y = 0] = overlay.getPosition();
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ x, y, useJev } satisfies Persisted), "utf8");
  } catch (error) {
    console.warn(`could not save overlay position: ${String(error)}`);
  }
}

// ─── status ──────────────────────────────────────────────────────────────────
function gsiHealth(): GsiHealth {
  if (gsiError) return "error";
  if (lastPayloadAt === null) return "waiting";
  return Date.now() - lastPayloadAt > STALE_AFTER_MS ? "stale" : "live";
}

function status(): OverlayStatus {
  return {
    gsi: gsiHealth(),
    sinceLastPayload: lastPayloadAt === null ? null : Date.now() - lastPayloadAt,
    gsiError,
    jev: jevStatus(),
    interactive,
    useJev,
  };
}

function snapshot(): Snapshot {
  const state = store.state();
  return { status: status(), state, situation: situationOf(state), advice };
}

function publish(): void {
  pushSnapshot(overlay, snapshot());
  updateTray();
}

// ─── advice loop ─────────────────────────────────────────────────────────────
const itemTrigger = new ItemTrigger((reason) => {
  void refreshItems(reason);
});
const draftTrigger = new DraftTrigger(() => {
  void refreshDraft();
});

let itemsInFlight = false;

async function refreshItems(reason: string): Promise<void> {
  if (itemsInFlight) return;
  itemsInFlight = true;
  try {
    const state = store.state();
    const requestedHash = itemStateHash(state);
    const result = await adviseItems(
      state,
      // The state may have moved on while the request was out: items bought, enemies
      // edited. Comparing the hash of the *current* state is the freshness guard.
      (hash) => hash !== itemStateHash(store.state()) && hash === requestedHash,
    );
    advice = { ...advice, items: result.items, source: result.source, jev: result.jev, at: Date.now() };
    itemTrigger.watchCost(result.items[0]?.cost ?? null);
    if (result.jev?.fallbackReason) {
      console.warn(`item advice is unranked (${reason}): ${result.jev.fallbackReason}`);
    }
    publish();
  } finally {
    itemsInFlight = false;
  }
}

let draftInFlight = false;

async function refreshDraft(): Promise<void> {
  if (draftInFlight) return;
  draftInFlight = true;
  try {
    const state = store.state();
    const requestedHash = draftStateHash(state);
    const result = await adviseDraft(
      state,
      (hash) => hash !== draftStateHash(store.state()) && hash === requestedHash,
    );
    advice = { ...advice, heroes: result.heroes, at: Date.now() };
    publish();
  } finally {
    draftInFlight = false;
  }
}

function onChange(change: MatchChange): void {
  const state = store.state();
  itemTrigger.consider(state, change);
  if (change.reset || change.reportChanged || state.gameState === HERO_SELECTION) {
    draftTrigger.bump();
  }
  publish();
}

// ─── windows ─────────────────────────────────────────────────────────────────
function createOverlay(): void {
  const settings = loadSettings();
  useJev = settings.useJev ?? true;
  setJevRuntimeEnabled(useJev);
  const display = screen.getPrimaryDisplay().workAreaSize;

  overlay = new BrowserWindow({
    width: 380,
    height: 620,
    x: settings.x ?? display.width - 400,
    y: settings.y ?? 80,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    // Never steal focus from the game. The hero picker needs clicks, not focus.
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // "screen-saver" is the level that stays above a borderless-windowed game.
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void overlay.loadURL(devUrl);
  } else {
    void overlay.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  // A transparent window that fails to render looks exactly like a working one that
  // happens to be empty, so the renderer's console and load failures come to us.
  overlay.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level >= 2) console.warn(`[renderer] ${source}:${line} ${message}`);
  });
  overlay.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[renderer] failed to load: ${description} (${code})`);
  });
  overlay.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason}`);
  });
  if (process.env.OVERLAY_DEVTOOLS === "1") {
    overlay.webContents.openDevTools({ mode: "detach" });
  }

  overlay.on("moved", saveSettings);
  overlay.on("closed", () => {
    overlay = null;
  });
}

function setUseJev(value: boolean): void {
  useJev = value;
  setJevRuntimeEnabled(value);
  saveSettings();
  void refreshItems("toggle");
  void refreshDraft();
}

function setInteractive(value: boolean): void {
  interactive = value;
  if (!overlay || overlay.isDestroyed()) return;
  // `forward: true` keeps hover working in click-through mode so the panel can still
  // react visually without swallowing clicks meant for the game.
  overlay.setIgnoreMouseEvents(!interactive, { forward: true });
  publish();
}

// ─── tray ────────────────────────────────────────────────────────────────────
const TRAY_LABEL: Record<GsiHealth, string> = {
  waiting: "waiting for first GSI heartbeat",
  live: "match live",
  stale: "no GSI heartbeat for a minute — is Dota running?",
  error: "GSI listener is not running",
};

function trayLabel(health: GsiHealth): string {
  return health === "error" && gsiError ? `GSI: ${gsiError}` : TRAY_LABEL[health];
}

function updateTray(): void {
  if (!tray) return;
  const health = gsiHealth();
  tray.setToolTip(`Dota 2 helper — ${trayLabel(health)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayLabel(health), enabled: false },
      { label: `Jev: ${status().jev}`, enabled: false },
      { type: "separator" },
      {
        label: "Interactive (Alt+Shift+D)",
        type: "checkbox",
        checked: interactive,
        click: () => setInteractive(!interactive),
      },
      {
        label: "Use Jev ranking",
        type: "checkbox",
        checked: useJev,
        click: () => {
          setUseJev(!useJev);
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

function createTray(): void {
  // A 16×16 transparent image keeps the tray entry present without shipping an asset;
  // the tooltip and menu carry the actual status.
  tray = new Tray(nativeImage.createEmpty());
  updateTray();
}

// ─── boot ────────────────────────────────────────────────────────────────────
function startGsi(): void {
  const token = readGsiToken();
  if (!token) {
    gsiError = "no .gsi-token — run `npm run setup:gsi`";
    console.error(
      "No .gsi-token found. Run `npm run setup:gsi -- --dota-path ...` first — the overlay will start but will never receive a payload.",
    );
    publish();
    return;
  }

  const server = createGsiServer({
    token,
    onPayload(payload) {
      lastPayloadAt = Date.now();
      onChange(store.apply(payload));
    },
    onReject(reason) {
      console.warn(`GSI rejected: ${reason}`);
    },
  });

  server
    .start()
    .then(() => {
      gsiError = null;
      console.log(`GSI listening on http://127.0.0.1:${DEFAULT_GSI_PORT}${DEFAULT_GSI_PATH}`);
      publish();
    })
    .catch((error: unknown) => {
      // Usually another copy of the app, or `npm run capture`, already holds the port.
      // Silence here would leave the overlay saying "waiting" forever.
      const code = (error as { code?: string }).code;
      gsiError =
        code === "EADDRINUSE"
          ? `port ${DEFAULT_GSI_PORT} is already in use — another copy running?`
          : String(error);
      console.error(`GSI server failed to start: ${String(error)}`);
      publish();
    });
}

void app.whenReady().then(() => {
  const data = dataStatus();
  if (data.heroes === 0) {
    console.warn("data/ is empty — run `npm run data:fetch`. Suggestions will be empty until then.");
  }

  createOverlay();
  createTray();
  startGsi();

  registerIpc({
    snapshot,
    reportEnemies(heroes) {
      onChange(store.reportEnemies(heroes));
      draftTrigger.bump();
    },
    reportAllies(heroes) {
      onChange(store.reportAllies(heroes));
      draftTrigger.bump();
    },
    reportRole(role: Role | null) {
      onChange(store.reportRole(role));
      draftTrigger.bump();
    },
    setUseJev,
    moveWindow(dx, dy) {
      if (!overlay || overlay.isDestroyed()) return;
      const [x = 0, y = 0] = overlay.getPosition();
      overlay.setPosition(Math.round(x + dx), Math.round(y + dy));
    },
  });

  if (!globalShortcut.register("Alt+Shift+D", () => setInteractive(!interactive))) {
    console.warn("Could not register Alt+Shift+D — another app may already own it.");
  }

  // Health ticks so "stale" shows up without waiting for a payload that never comes.
  setInterval(publish, 5000);

  // First paint: candidates, unranked, until GSI gives us something to rank.
  void refreshItems("startup");
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  itemTrigger.dispose();
  draftTrigger.dispose();
});
