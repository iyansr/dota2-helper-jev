# Build notes

_Companion to [implementation-plan.md](implementation-plan.md). What got built, what
the first run taught us, and what is still open._

## Milestone status

| | Milestone | State |
| --- | --- | --- |
| M1 | GSI cfg writer, server, capture, summarizer | **Code complete. The spike itself is unrun** — it needs one real matchmaking game and one spectated game. Everything else was built against a synthetic fixture. |
| M2 | Replay harness, match store, situation buckets | Done. `npm run state <fixture>` drives a whole match offline. |
| M3 | OpenDota snapshot + curated tags | Done. 127 heroes, 416 items; 66 hero threat summaries, 45 item entries (33 situational). |
| M4 | Code-only baseline advisor | Done, and it ships behind the header toggle as the thing Jev has to beat. |
| M5 | Overlay UI | Done. Transparent, click-through, `Alt+Shift+D`, tray health, draggable, position persisted. |
| M6 | Jev integration | Done and verified live against `jev-1.13.0` at 330–850 ms per decision point. |

**The M1 gap matters.** `src/main/gsi/types.ts` is still written from documentation, not
from captured payloads, and every field in it is optional for that reason. Research
open questions #1 (does a *player* receive `draft` data?) and #2 (exact field names on
this patch) remain formally unanswered. The plan's assumption — no draft data for a
player, so manual input is mandatory — is what the whole design rests on, and it is
still an assumption. Run `npm run capture`, then `npm run gsi:summarize`, and narrow
the types from what actually arrived.

`fixtures/synthetic-juggernaut-40min.jsonl` exists only to unblock M2–M6 before that
capture. It was written from the same documentation as the types, so it can confirm
nothing about the real wire format. Its name says `synthetic` for exactly that reason.

## What the first live run showed

Running the composite over a 40-minute fixture with Riki/Lion/Pudge/Sniper/Axe as the
reported enemies:

- **Jev reorders meaningfully.** After three deaths while carrying 1500+ gold, the
  composite promoted Aeon Disk and Manta Style over the baseline's popularity-led list.
  That is the behaviour research §4.4 predicted, and it is visible in the toggle.
- **One request per decision point costs ~2k input tokens** and answers 24 questions.
  Latency was 330–850 ms, comfortably inside the 2 s timeout.
- **The freshness guard fires constantly during fast replays** and almost never at 1x.
  That is correct — at 30x a 2 s debounce spans a minute of game time — but it means
  fast replays exercise the fallback path, not the composite path. Use `--speed 4` or
  the offline `advise:demo` when you want to see composite output.

### Open quality problem: items the model rates for the wrong player

The composite repeatedly put **Glimmer Cape** near the top for a carry Juggernaut. The
state names the role (`me.role: "carry"`) and the effect text says the item is cast on
an ally, and Jev still rated the need high. This is a curation problem before it is a
weight problem, which is the order the plan asks for:

- `data/item-tags.json` describes *what an item does*, never *who buys it*. A support
  item and a carry item read identically to the model.
- The cheapest fix to try first is a role hint in the item table, evaluated against
  labelled decision points — not a new weight.

Do not tune `WEIGHTS` to paper over this. The evaluation loop in plan §7 is what
should decide it.

## Added after the first build: hero-kit synergy

The original design described each hero only as a *threat* — what it does to you. That
left the item advisor unable to see what the hero **you are playing** actually does:
`me` was a bare name, level and item list. Earthshaker wants a Blink Dagger because
Echo Slam has to land on a group, which counters nothing and so could never surface
through the tag intersection.

So heroes are now described twice. `threat`/`tags` drive the counter half of the
candidate list; `kit`/`wants` drive a new synergy half, matched against a `provides`
field on items. In the composite this is a third Score per candidate
(`synergy_<item>`), asked only when the played hero has a curated kit — weights are
`popularity 0.25 · fit 0.22 · need 0.28 · synergy 0.25`.

Effect, measured on an Earthshaker fixture versus Riki/Lion/Sniper: Blink Dagger goes
to first in both the baseline and the composite, and Kaya and Sange enters the list at
all. It cost 25 new item entries (the table had no Kaya line, Octarine, Scepter, boots
or damage items — nothing bought for your own kit was in it) and a `kit`/`wants` pair
for all 66 curated heroes. A request is 34 questions instead of 24.

**We had no ability data at all, and that was the bigger gap.** `heroes.json` carried
only name, roles and primary attribute, and the `kit` field above is hand-written
prose. Meanwhile the cfg requests GSI's `abilities` provider and the store was
discarding it. Both are fixed: `npm run data:fetch` now writes `data/abilities.json`
from `/constants/hero_abilities` + `/constants/abilities` (126 of 127 heroes — name,
in-game description, cast behaviour, damage type, BKB pierce, ultimate flag), and the
match store keeps ability levels from GSI.

The model now receives the real ability text rather than only a paraphrase, narrowed
to the abilities actually learned — a level-1 Earthshaker is described with Fissure
alone, and Echo Slam appears at six. Because the file is generated, the synergy
question is asked for every hero, not just the curated ones; `wants` tags still gate
which items get *added* to the candidate list, so uncurated heroes degrade to rating
the popularity-driven list rather than getting nothing.

**The "situational" threshold was recalibrated as a result.** Measured over 462 Score
answers, Jev's confidence here runs p10 0.21, p25 0.27, median 0.39, p90 0.61. The
plan's 0.4 therefore flagged about half of every list — including an obviously correct
Blink Dagger — so the label carried no information. It is now 0.27, applied to a
confidence weighted the way the rank is weighted rather than a `min` across three
dimensions, where one barely-contributing term could hedge a confident pick. Still
provisional until the evaluation loop sets it against labelled outcomes.

## Jev ranks; the code-side composite is gone

On request, the weighted composite of plan §3.4 was removed. There is no `WEIGHTS`
object any more, no `0.35 * popularity + 0.30 * fit + …`, no affordability bonus and no
Noul-driven modifiers. A card's position is the `overall` Score Jev returned for it,
ties broken on the model's own confidence.

The facts the composite used to weigh were not deleted — they were **moved into the
state as named buckets**, so the model weighs them instead of the code:

| Was a number in the ranking | Is now a phrase in the state |
| --- | --- |
| `popularityNorm` 0..1 | "one of the most bought items on this hero at this stage" |
| `goldToGo` + affordability curve | "about a minute of farm away" (computed from the player's own GPM) |
| shrunk matchup win rate | "wins clearly more often than not against their picks" |
| tag-match counts | already in the state as enemy threats and hero abilities |

Each candidate now gets four Scores: `overall` (the ranking) plus `fit`, `need` and
`synergy`, which no longer affect the order and survive only because the one-line
"why" names whichever of the three the model scored highest, and because the exchange
log is unreadable without them. The four global item Nouls were deleted outright: they
existed solely to drive modifier arithmetic that no longer exists.

**What this costs, stated plainly.** Research §4.2 lists arithmetic and comparison
among Jev's weak points, which is exactly why the plan kept ordering in code — so the
ordering now rests on the part of the model the research says to be careful with. Two
concrete consequences: the code-only baseline that plan §M6 exists to measure Jev
against is gone, so "does Jev beat the baseline" can no longer be answered from inside
the app; and when Jev times out there is no second opinion, so the panel shows the
candidate list unranked and labelled rather than an order it cannot justify. A request
went from 34 questions and ~5,000 input tokens to 40 and ~8,000.

Mitigations kept: the candidate list is still built entirely in code, the state still
contains no raw numbers, `npm run advise:demo -- --compare` still prints the unranked
candidates beside the ranked list, and every exchange is still logged in full.

## Defects found and fixed while building

Kept because each one is a trap the next change could walk back into.

- **A sandboxed preload must be CommonJS.** The package is `"type": "module"`, so
  electron-vite emitted `index.mjs` and Electron refused it — leaving a transparent
  window that rendered nothing and reported nothing. The preload build now pins
  `format: "cjs"`, and the main process forwards renderer console output and load
  failures, so an invisible overlay can never again be silent.
- **Two curated items had been removed from the game.** Hood of Defiance and Medallion
  of Courage still exist in OpenDota's constants with a null cost, so they passed the
  "does this key exist" check and were suggested as free items ("buy now" at 0 gold).
  Candidate generation now requires a positive cost, and `npm run data:coverage`
  reports curated items the shop does not sell.
- **Four curated heroes used display names, not console names** (`clockwerk` vs
  `rattletrap`, `wraith_king` vs `skeleton_king`, `shadow_fiend` vs `nevermore`,
  `lifestealer` vs `life_stealer`). They silently contributed nothing. The coverage
  report now catches this class outright.
- **The matchup floor of 200 games kept only 6.5% of the table.** The snapshot's median
  sample is 50 games (p10 = 11, p90 = 164). The floor is now 50, and the mean is shrunk
  toward 50% by sample size — without that, one 61%-over-52-games matchup outranked
  four solid ones.
- **The "why" line named every enemy**, not the ones the item actually counters
  ("Answers Riki and 4 others" for an item that answered one of them). It now names
  only matched heroes.
- **When `need` dominated, all three cards carried one identical sentence.** The
  template is now keyed on the item's own effect.
- **Requests were being spent that could not change anything.** With no enemies
  reported and no curated candidate in the list, `buildItemQuestions` produced only the
  four global Nouls — and those only ever boost a candidate whose matched tags say it
  answers a reported enemy, so with nothing matched the answer could not move the
  ranking. The exchange log made this obvious ("4 questions" per request); the advisor
  now skips the call outright. On the synthetic fixture with no enemies entered that
  is 9 requests instead of 15.
- **A busy GSI port left the overlay saying "waiting" forever**, with the failure only
  in a console nobody sees. `EADDRINUSE` and a missing token now surface in the header
  and the tray.

## Deliberate deviations from the plan

- **There is no code-side ranking at all**, by explicit request — see "Jev ranks"
  above. This supersedes plan §3.4 and the M4 baseline.
- **`Situation` carries two extra buckets** beyond the plan's four — `net_worth` (own
  farm pace, since enemy net worth is invisible to a player) and `roshan`.
- **The draft panel returns nothing when no picks are reported.** Ranking every hero on
  an empty matchup set produced five "thin data" rows, which is worse than the prompt
  to enter the picks.

## Next

1. **Run the M1 spike.** Everything above is built on an assumed wire format.
2. Curate the 61 uncurated heroes, most-played first — `npm run data:coverage` lists
   them in that order.
3. Start the fixture corpus (plan §7): record real games, label decision points, and
   measure top-3 hit rate for baseline versus composite. Drop any Jev question that
   does not move the metric. Only then touch the weights.
