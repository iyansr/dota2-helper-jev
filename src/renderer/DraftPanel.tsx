import { useState } from "react";
import type { Advice } from "@shared/advice.ts";
import type { HeroOption } from "@shared/ipc.ts";
import type { MatchState, Role } from "@shared/match.ts";
import { ROLES } from "@shared/match.ts";
import { HeroPicker } from "./HeroPicker.tsx";

/**
 * Manual enemy input is the product's hard constraint, not a fallback: as a player,
 * GSI tells us nothing about the other nine heroes (research §1.4). This panel is
 * where that information comes from, so it has to be fast.
 */
export function DraftPanel({
  advice,
  state,
  heroes,
  expanded,
  onToggle,
}: {
  advice: Advice;
  state: MatchState;
  heroes: HeroOption[];
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const [side, setSide] = useState<"enemy" | "ally">("enemy");

  const enemies = state.reported.enemies.value;
  const allies = state.reported.allies.value;
  const taken = new Set([...enemies, ...allies]);
  const byName = new Map(heroes.map((hero) => [hero.name, hero]));
  const label = (name: string): string => byName.get(name)?.displayName ?? name;

  const pick = (hero: HeroOption): void => {
    if (side === "enemy") {
      if (enemies.length >= 5) return;
      window.overlay.reportEnemies([...enemies, hero.name]);
    } else {
      if (allies.length >= 4) return;
      window.overlay.reportAllies([...allies, hero.name]);
    }
  };

  const remove = (name: string, from: "enemy" | "ally"): void => {
    if (from === "enemy") window.overlay.reportEnemies(enemies.filter((n) => n !== name));
    else window.overlay.reportAllies(allies.filter((n) => n !== name));
  };

  return (
    <section className="panel">
      <div className="section-title">
        <span>Draft</span>
        <span style={{ flex: 1 }} />
        <span className="tag">
          {enemies.length}/5 enemy · {allies.length}/4 ally
        </span>
        <button type="button" className="tag" onClick={onToggle}>
          {expanded ? "hide" : "edit"}
        </button>
      </div>

      {(enemies.length > 0 || allies.length > 0) && (
        <div className="chips">
          {enemies.map((name) => (
            <button key={name} type="button" className="chip enemy" onClick={() => remove(name, "enemy")}>
              {label(name)} <span className="muted">×</span>
            </button>
          ))}
          {allies.map((name) => (
            <button key={name} type="button" className="chip ally" onClick={() => remove(name, "ally")}>
              {label(name)} <span className="muted">×</span>
            </button>
          ))}
        </div>
      )}

      {expanded ? (
        <>
          <div className="controls">
            <div className="side-toggle">
              <button
                type="button"
                className={side === "enemy" ? "active" : ""}
                onClick={() => setSide("enemy")}
              >
                Enemy
              </button>
              <button
                type="button"
                className={side === "ally" ? "active" : ""}
                onClick={() => setSide("ally")}
              >
                Ally
              </button>
            </div>
            <select
              value={state.reported.role.value ?? ""}
              onChange={(event) =>
                window.overlay.reportRole(event.target.value === "" ? null : (event.target.value as Role))
              }
            >
              <option value="">role…</option>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>
          <HeroPicker heroes={heroes} taken={taken} onPick={pick} />
        </>
      ) : null}

      {advice.heroes.length > 0 ? (
        <div className="cards">
          {advice.heroes.slice(0, 3).map((hero) => (
            <article className="card" key={hero.name}>
              <span className="name">{hero.displayName}</span>
              <span className="gold">{hero.rated ? Math.round(hero.rank * 100) : "—"}</span>
              <span className="why">
                {hero.situational ? (
                  <span className="tag">{hero.rated ? "low confidence" : "unrated"}</span>
                ) : null}{" "}
                {hero.why}
              </span>
            </article>
          ))}
        </div>
      ) : (
        <p className="empty">
          Add the enemy picks to rank your options. Everything else works with none of
          them — enemy input only improves the result.
        </p>
      )}
    </section>
  );
}
