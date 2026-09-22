import { useEffect, useRef, useState } from "react";
import type { HeroOption, Snapshot } from "@shared/ipc.ts";
import { DraftPanel } from "./DraftPanel.tsx";
import { ItemPanel } from "./ItemPanel.tsx";

const HERO_SELECTION = "DOTA_GAMERULES_STATE_HERO_SELECTION";
const STRATEGY_TIME = "DOTA_GAMERULES_STATE_STRATEGY_TIME";

function clock(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const abs = Math.abs(Math.floor(seconds));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

/** Dragging the header moves the window; the position is persisted in main. */
function useDrag(): (event: React.MouseEvent) => void {
  const origin = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const move = (event: MouseEvent): void => {
      if (!origin.current) return;
      window.overlay.moveWindow(event.screenX - origin.current.x, event.screenY - origin.current.y);
      origin.current = { x: event.screenX, y: event.screenY };
    };
    const up = (): void => {
      origin.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return (event) => {
    origin.current = { x: event.screenX, y: event.screenY };
  };
}

export function App(): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [heroes, setHeroes] = useState<HeroOption[]>([]);
  const [draftOpen, setDraftOpen] = useState(false);
  /** Set once the user opens or closes the panel themselves; stops auto-open fighting them. */
  const userSetDraft = useRef(false);
  const onDragStart = useDrag();

  useEffect(() => {
    void window.overlay.requestSnapshot().then(setSnapshot);
    void window.overlay.heroes().then(setHeroes);
    return window.overlay.onSnapshot(setSnapshot);
  }, []);

  const gameState = snapshot?.state.gameState ?? "";
  useEffect(() => {
    if (userSetDraft.current) return;
    // Open automatically during the draft, collapse once the game starts.
    setDraftOpen(gameState === HERO_SELECTION || gameState === STRATEGY_TIME);
  }, [gameState]);

  useEffect(() => {
    document.body.classList.toggle("interactive", snapshot?.status.interactive ?? false);
  }, [snapshot?.status.interactive]);

  if (!snapshot) return null;
  const { status, state, situation, advice } = snapshot;

  return (
    <div className="app">
      <header className="panel header" onMouseDown={onDragStart}>
        <span className={`dot ${status.gsi}`} title={status.gsiError ?? `GSI: ${status.gsi}`} />
        <span className="title">{state.matchId ? clock(state.clock) : "no match"}</span>
        <span className="muted tiny">
          {status.gsiError
            ? status.gsiError
            : state.hero.name
              ? `lvl ${state.hero.level} · ${state.gold.total}g`
              : "waiting for GSI"}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className={status.useJev ? "tag active" : "tag"}
          title={`Jev: ${status.jev}`}
          onClick={() => window.overlay.setUseJev(!status.useJev)}
        >
          {status.useJev ? "jev" : "unranked"}
        </button>
      </header>

      <ItemPanel advice={advice} state={state} situation={situation} />

      <DraftPanel
        advice={advice}
        state={state}
        heroes={heroes}
        expanded={draftOpen}
        onToggle={() => {
          userSetDraft.current = true;
          setDraftOpen((open) => !open);
        }}
      />

      <footer className="panel footer">
        {status.interactive
          ? "Interactive — clicks land here, not in the game. Alt+Shift+D to release."
          : "Click-through. Alt+Shift+D to interact."}
        <br />
        Suggestions are advisory, from Valve's own Game State Integration and what you
        type in. Nothing reads the Dota client.
      </footer>
    </div>
  );
}
