# Dota 2 helper overlay (POC)

An Electron overlay that reads your own match state through Valve's **Game State
Integration**, takes the enemy picks from you by hand, and suggests what to buy next
and who to pick. TypeSafe's **Jev** decides the ranking; code decides which candidates
exist, what the model is told, and every word shown on screen.

Design docs: [research](research/dota2-gsi-electron-overlay.md) ·
[implementation plan](docs/implementation-plan.md) ·
[build notes and findings](docs/build-notes.md)

---

## What it can and cannot see

GSI is Valve's own read-only push API, and **as a player it only reports your own
hero**. Teammates, enemies and (as far as this build assumes) the draft are not sent
to you — that is a property of the API, not a limitation of this app. So:

- Own hero, items, gold, deaths, clock, score, towers, Roshan → from GSI.
- Enemy and ally heroes → **typed in by you**, in the draft panel.
- Everything else → computed in code from those two.

Nothing reads the Dota client: no OCR, no file parsing, no memory access, no injection.
Valve's [February 2023 statement](https://www.dota2.com/newsentry/3677788723152833273)
warns that applications which *read data from the Dota client* can get an account
permanently banned. GSI is the sanctioned channel and the only one used here. If you
extend this, keep it that way.

## Setup

```bash
npm install
npm run setup:gsi -- --dota-path "C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta"
npm run data:fetch          # one OpenDota snapshot, ~5 minutes, per patch
npm run dev
```

`setup:gsi` writes `gamestate_integration_jev.cfg` into Dota's config directory and
mints a token into `.gsi-token` (gitignored). Two steps stay manual:

1. **Launch options:** Steam → Dota 2 → Properties → `-gamestateintegration`
2. **Display mode:** Settings → Video → **Borderless Windowed**. An overlay cannot
   draw over exclusive fullscreen.

No Dota install on this machine? `npm run setup:gsi -- --token-only` mints the token
and prints the cfg to paste in by hand. The replay harness needs nothing else.

### Jev (optional)

```bash
cp .env.example .env    # then set TYPESAFE_API_KEY and ENABLE_JEV=1
```

With `ENABLE_JEV` unset there is no ranking: the overlay shows the candidate list
unordered and labels it. The toggle in the header does the same thing on demand.

> **Personal use only.** The key is read in the main process and never crosses IPC,
> but a key inside a distributed app is a published key regardless (asar is readable).
> Shipping this to anyone else requires the proxy described in research §4.7 first.

### Seeing what Jev was asked and what it answered

Every exchange is logged whenever a request is made — during `npm run dev`, a capture,
or an offline demo. The terminal gets a summary per request:

```
[jev] item · 22 questions · jev-1.13.0 · 341ms · 3472 input tokens · state 705ab90b
  top scores (score/confidence): fit sheepstick 1.88/0.81 · fit aeon disk 1.68/0.52
  nouls: survival is bottleneck 0.52 · enemy has invisibility 0.89 · team is losing fights 0.08
  → shown: Manta Style (92), Aeon Disk (76), Blink Dagger (74)
```

and `logs/jev-<start>.jsonl` gets the whole thing: the exact state sent, every question
with its criteria, every answer with per-level probabilities and confidence, and the
final ranking after weights. Read it back with:

```bash
npm run jev:log                        # last 5 exchanges, summarized
npm run jev:log -- --n 20
npm run jev:log -- --hash 705ab90b     # one exchange, in full
```

Two numbers to watch. **Question count** tells you how much of the candidate list is
curated — four questions per rateable candidate, so 40 means ten were judged. **`state <hash>`** is what the freshness guard compares — a
`discarded` line means the answer arrived after the game had moved on.

`JEV_LOG=0` turns logging off; `JEV_LOG_CONSOLE=0` keeps the file and silences the
terminal, which is what you want during a real game.

## Using it

| | |
| --- | --- |
| `Alt+Shift+D` | toggle interactive mode — needed to click the hero picker. A gold border shows when clicks land on the overlay instead of the game. |
| header dot | GSI health: green live, amber waiting, red stale or misconfigured. |
| `jev` / `unranked` | whether the list is ordered by the model or just a candidate list. |
| drag the header | moves the overlay; the position is remembered. |

The draft panel opens by itself during hero selection and collapses once the game
starts. Everything works with zero enemy heroes entered — they only improve the result.

## Developing without Dota

The replay harness is the development loop. Nothing below needs the game running.

```bash
npm run fixture:synth                         # a scripted fake match to work against
npm run state fixtures/synthetic-*.jsonl      # MatchState + Situation, offline
npm run advise:demo fixtures/synthetic-*.jsonl -- --enemies riki,lion,pudge --role carry --compare
npm run data:coverage                         # what is curated, what is missing
```

Against a live app (or `npm run capture`), `npm run replay <fixture> -- --speed 8`
posts a recorded session back at the GSI server at the recorded pace.

### Recording real fixtures

```bash
npm run capture           # then play one game, and spectate one
npm run gsi:summarize fixtures/match-<id>.jsonl
```

The summary prints, per `game_state`, which providers and fields actually arrived —
which is how the GSI types get narrowed from evidence instead of from documentation.
This is the one step nobody has run yet; see [build notes](docs/build-notes.md).

## Layout

```
data/       generated OpenDota snapshot (heroes, items, abilities, popularity,
            matchups) + the two curated tag tables
fixtures/   recorded (and synthetic) GSI sessions
scripts/    setup, capture, replay, data fetch, offline demos
src/main/   GSI server · match store · situation buckets · advisors · Jev client
src/shared/ types crossing the main/renderer boundary
src/renderer/ the overlay itself
```

Three rules hold everywhere:

- **Jev decides the order.** There is no weighted composite and no hand-tuned constant
  that can move a suggestion up or down; a card's rank is the `overall` Score the model
  returned. Code still chooses the candidates and writes the state.
- **Numbers become named buckets before the model sees them.** Popularity, gold-to-go
  and head-to-head win rate reach Jev as phrases ("one of the most bought items on this
  hero at this stage", "about a minute of farm away"), never as digits — research §4.2
  is clear that Jev is weak at arithmetic.
- **Every word on screen comes from a code template.** The model rates candidates; it
  never writes copy or names an item.

With Jev off or unreachable there is nothing to rank with, so the panel shows the
candidate list **unranked** and says so, rather than inventing an order.

## The two curated tables

`data/hero-tags.json` and `data/item-tags.json` are hand-written and they decide output
quality more than any weight does. Each hero is described twice, because the two
descriptions answer different questions:

```json
"npc_dota_hero_earthshaker": {
  "threat": "chained area stuns and burst area damage that scales with how many heroes are grouped",
  "tags": ["initiation", "disable", "aoe-teamfight", "magic-burst"],
  "kit": "sets up with a fissure and a blind, then lands an area ultimate whose damage scales with how many heroes it catches",
  "wants": ["blink", "cooldown-reduction", "spell-amplification", "mana-sustain", "survivability", "status-resistance"]
}
```

`threat`/`tags` are what the hero does **to you**, and drive the counter-pick half of
the item list. `kit`/`wants` are what the hero does **from your seat**, and drive the
synergy half — this is why Earthshaker is offered a Blink Dagger. Items mirror it with
`counters` (threats answered) and `provides` (what the owner gets).

Alongside the curated `kit` summary, the model receives the hero's **real abilities**
from `data/abilities.json` — name, in-game description, cast behaviour, damage type,
and which one is the ultimate. That file is generated from OpenDota, so it covers every
hero rather than the curated 66, and it is narrowed live by GSI to the abilities you
have actually levelled: a level-3 Earthshaker is described without Echo Slam.

An uncurated hero or item is never sent to the model and simply contributes no signal.
`npm run data:coverage` reports what is missing, most-played heroes first, and catches
console-name typos and items the shop no longer sells.
