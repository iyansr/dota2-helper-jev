import type { Advice } from "./advice.ts";
import type { MatchState, Role, Situation } from "./match.ts";

/** The one typed surface between main and renderer. Channel names live only here. */

export type GsiHealth = "waiting" | "live" | "stale" | "error";

export interface OverlayStatus {
  gsi: GsiHealth;
  /** ms since the last GSI payload, or null before the first. */
  sinceLastPayload: number | null;
  /** Set when the listener could not start, or no token exists — nothing will arrive. */
  gsiError: string | null;
  /** Human-readable Jev state, e.g. "on" or "off (ENABLE_JEV is not 1)". */
  jev: string;
  /** True while the overlay accepts clicks (Alt+Shift+D). */
  interactive: boolean;
  /** When false, the UI shows the code-only baseline even if Jev is available. */
  useJev: boolean;
}

export interface HeroOption {
  id: number;
  name: string;
  displayName: string;
  roles: string[];
}

export interface Snapshot {
  status: OverlayStatus;
  state: MatchState;
  /** The bucketed view the advisors reason over — shown so the advice is legible. */
  situation: Situation;
  advice: Advice;
}

export const CHANNELS = {
  /** main → renderer: the whole world, on every meaningful change. */
  snapshot: "overlay:snapshot",
  /** renderer → main, invoke: pull the current snapshot (first paint, or after reload). */
  requestSnapshot: "overlay:request-snapshot",
  /** renderer → main: the static hero list for the picker. */
  heroes: "overlay:heroes",
  /** renderer → main: user-reported facts. */
  reportEnemies: "overlay:report-enemies",
  reportAllies: "overlay:report-allies",
  reportRole: "overlay:report-role",
  /** renderer → main: baseline/composite toggle (plan §M6 acceptance). */
  setUseJev: "overlay:set-use-jev",
  /** renderer → main: persist the dragged window position. */
  moveWindow: "overlay:move-window",
} as const;

/** What `window.overlay` exposes. Mirrored in `src/preload/index.d.ts`. */
export interface OverlayApi {
  onSnapshot(handler: (snapshot: Snapshot) => void): () => void;
  requestSnapshot(): Promise<Snapshot>;
  heroes(): Promise<HeroOption[]>;
  reportEnemies(heroes: string[]): void;
  reportAllies(heroes: string[]): void;
  reportRole(role: Role | null): void;
  setUseJev(value: boolean): void;
  moveWindow(dx: number, dy: number): void;
}
