import type { OverlayApi } from "../shared/ipc.ts";

declare global {
  interface Window {
    overlay: OverlayApi;
  }
}

export {};
