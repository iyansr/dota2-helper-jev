import { useMemo, useState } from "react";
import type { HeroOption } from "@shared/ipc.ts";

/**
 * Ten clicks to fill an enemy team is the bar (plan §M5 acceptance), so: one search
 * box, a two-column grid, and a side switch that stays where you left it.
 */
export function HeroPicker({
  heroes,
  taken,
  onPick,
}: {
  heroes: HeroOption[];
  taken: ReadonlySet<string>;
  onPick: (hero: HeroOption) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const available = heroes.filter((hero) => !taken.has(hero.name));
    if (needle.length === 0) return available.slice(0, 40);
    // Prefix matches first: typing "sn" should offer Sniper before Shadow Fiend.
    const scored = available
      .map((hero) => {
        const name = hero.displayName.toLowerCase();
        const index = name.indexOf(needle);
        if (index === 0) return { hero, score: 0 };
        if (index > 0) return { hero, score: 1 };
        // Fall back to initials, so "pa" finds Phantom Assassin.
        const initials = name
          .split(/[\s'-]+/)
          .map((word) => word[0] ?? "")
          .join("");
        return initials.startsWith(needle) ? { hero, score: 2 } : null;
      })
      .filter((entry): entry is { hero: HeroOption; score: number } => entry !== null)
      .sort((a, b) => a.score - b.score);
    return scored.slice(0, 40).map((entry) => entry.hero);
  }, [heroes, query, taken]);

  return (
    <>
      <div className="controls">
        <input
          type="search"
          placeholder="Search heroes…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="grid">
        {matches.map((hero) => (
          <button
            key={hero.name}
            type="button"
            title={hero.roles.join(", ")}
            onClick={() => {
              onPick(hero);
              setQuery("");
            }}
          >
            {hero.displayName}
          </button>
        ))}
        {matches.length === 0 ? <p className="empty">No hero matches that.</p> : null}
      </div>
    </>
  );
}
