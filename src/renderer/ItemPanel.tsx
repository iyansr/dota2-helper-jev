import type { Advice } from "@shared/advice.ts";
import type { MatchState, Situation } from "@shared/match.ts";

/**
 * The item panel: three cards, each with a gold-to-go number the player can act on
 * and a one-line reason rendered in code (plan §M5). Nothing here is model-written.
 */
export function ItemPanel({
  advice,
  state,
  situation,
}: {
  advice: Advice;
  state: MatchState;
  situation: Situation;
}): JSX.Element {
  const top = advice.items.slice(0, 3);

  return (
    <section className="panel">
      <div className="section-title">
        <span>Next item</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="tag">{advice.source === "jev" ? "jev" : "unranked"}</span>
        {advice.jev?.latencyMs ? <span className="tag">{advice.jev.latencyMs}ms</span> : null}
      </div>

      {state.hero.id !== null ? (
        <p className="empty" style={{ paddingBottom: 0 }}>
          {situation.phase} · {situation.team_lead} · {situation.recent_deaths}
        </p>
      ) : null}

      {advice.source === "unranked" && top.length > 0 ? (
        <p className="empty" style={{ paddingTop: 0 }}>
          Not ranked{advice.jev?.fallbackReason ? ` — ${advice.jev.fallbackReason}` : ""}. These are
          candidates, in no particular order.
        </p>
      ) : null}

      {top.length === 0 ? (
        <p className="empty">
          {state.hero.id === null
            ? "Waiting for a hero. Suggestions start once the match loads."
            : "No candidates — the item snapshot may be missing. Run npm run data:fetch."}
        </p>
      ) : (
        <div className="cards">
          {top.map((item) => {
            // Recompute against live gold rather than trusting the number frozen when
            // the advice was produced: the ranking may be a few seconds old, but the
            // figure the player acts on should not be.
            const goldToGo = Math.max(0, item.cost - state.gold.total);
            return (
            <article className="card" key={item.key}>
              <span className="name">{item.displayName}</span>
              <span className={`gold${goldToGo === 0 ? " ready" : ""}`}>
                {goldToGo === 0 ? "buy now" : `${goldToGo}g`}
              </span>
              <span className="why">
                {item.situational ? (
                  <span className="tag">{item.rated ? "low confidence" : "unrated"}</span>
                ) : null}{" "}
                {item.why}
              </span>
            </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
