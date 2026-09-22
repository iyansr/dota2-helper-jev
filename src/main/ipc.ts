import { ipcMain, type BrowserWindow } from "electron";
import { CHANNELS, type HeroOption, type Snapshot } from "../shared/ipc.ts";
import type { Role } from "../shared/match.ts";
import { allHeroes } from "./data/index.ts";

/**
 * Typed channel wiring. The renderer can ask for state and report user facts, and
 * nothing else — no API key, no file access, no raw GSI.
 */
export interface IpcHandlers {
  snapshot(): Snapshot;
  reportEnemies(heroes: string[]): void;
  reportAllies(heroes: string[]): void;
  reportRole(role: Role | null): void;
  setUseJev(value: boolean): void;
  moveWindow(dx: number, dy: number): void;
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function registerIpc(handlers: IpcHandlers): void {
  ipcMain.handle(CHANNELS.requestSnapshot, () => handlers.snapshot());

  ipcMain.handle(CHANNELS.heroes, (): HeroOption[] =>
    allHeroes()
      .map((hero) => ({
        id: hero.id,
        name: hero.name,
        displayName: hero.displayName,
        roles: hero.roles,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  );

  ipcMain.on(CHANNELS.reportEnemies, (_event, heroes: unknown) => {
    handlers.reportEnemies(asStringArray(heroes));
  });
  ipcMain.on(CHANNELS.reportAllies, (_event, heroes: unknown) => {
    handlers.reportAllies(asStringArray(heroes));
  });
  ipcMain.on(CHANNELS.reportRole, (_event, role: unknown) => {
    handlers.reportRole(typeof role === "string" ? (role as Role) : null);
  });
  ipcMain.on(CHANNELS.setUseJev, (_event, value: unknown) => {
    handlers.setUseJev(value === true);
  });
  ipcMain.on(CHANNELS.moveWindow, (_event, dx: unknown, dy: unknown) => {
    if (typeof dx === "number" && typeof dy === "number") handlers.moveWindow(dx, dy);
  });
}

export function pushSnapshot(window: BrowserWindow | null, snapshot: Snapshot): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(CHANNELS.snapshot, snapshot);
}
