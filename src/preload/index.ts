import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type HeroOption, type OverlayApi, type Snapshot } from "../shared/ipc.ts";
import type { Role } from "../shared/match.ts";

/**
 * One typed surface, nothing else. `contextIsolation` stays on and the renderer never
 * sees `ipcRenderer` — the TypeSafe key lives in the main process and must never be
 * reachable from a page (research §4.7).
 */
const api: OverlayApi = {
  onSnapshot(handler) {
    const listener = (_event: unknown, snapshot: Snapshot): void => handler(snapshot);
    ipcRenderer.on(CHANNELS.snapshot, listener);
    return () => ipcRenderer.removeListener(CHANNELS.snapshot, listener);
  },
  requestSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke(CHANNELS.requestSnapshot),
  heroes: (): Promise<HeroOption[]> => ipcRenderer.invoke(CHANNELS.heroes),
  reportEnemies: (heroes: string[]) => ipcRenderer.send(CHANNELS.reportEnemies, heroes),
  reportAllies: (heroes: string[]) => ipcRenderer.send(CHANNELS.reportAllies, heroes),
  reportRole: (role: Role | null) => ipcRenderer.send(CHANNELS.reportRole, role),
  setUseJev: (value: boolean) => ipcRenderer.send(CHANNELS.setUseJev, value),
  moveWindow: (dx: number, dy: number) => ipcRenderer.send(CHANNELS.moveWindow, dx, dy),
};

contextBridge.exposeInMainWorld("overlay", api);
