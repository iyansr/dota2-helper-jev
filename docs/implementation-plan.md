# Implementation Plan: Dota 2 helper overlay (POC)

_Date: 2026-09-22 · Scope: proof of concept · Companion to [research/dota2-gsi-electron-overlay.md](../research/dota2-gsi-electron-overlay.md)_

## 0. What this POC is and isn't

**Goal:** prove that GSI + a curated data table + Jev produce *usefully better* item
and draft suggestions than a popularity-only baseline, inside a working overlay.

**In scope**

- GSI server + cfg writer (own player state only).
- Transparent always-on-top overlay with two panels: item suggestions, draft picker.
- Manual enemy-hero input — the research doc's hard constraint: GSI gives a *player*
  nothing about the other nine.
- One Jev request per decision point, fan-out over candidates, code does the ranking.
- A replay harness so 90% of development happens without Dota running.

**Out of scope** (named so they don't creep in)

- Auto-detecting the Steam library or editing launch options. A `npm run setup:gsi`
  script that takes a path is enough.
- Live OpenDota calls at runtime → bundle a **static snapshot** fetched at build time.
  Kills rate limits, caching, offline failure modes, and a whole module.
- API-key proxy, packaging/installer, auto-update, multi-monitor, macOS/Linux.
- Fixture corpus + weight tuning (§7 keeps the door open, but it is post-POC).
- Anything that reads the Dota client beyond GSI. Non-negotiable.

**Assumption made up front:** assume GSI sends a *player* no `draft` data (research
open question #1). The draft panel is manual-input-first. If the M1 spike proves
otherwise, auto-fill is a free addition on top — not a redesign.

---

## 1. Stack

| Choice | Why |
| --- | --- |
| Electron + `electron-vite` + TypeScript | One toolchain for main/preload/renderer, HMR on the overlay. |
| React in the renderer | The hero picker (grid + search + chips) is the only real UI; React pays for itself there. |
| `node:http` for the GSI server | ~80 lines. No Fastify, no `dota2-gsi` package (old, has "no initial emit" caveats). |
| `@typesafe-ai/sdk` in **main only** | Key never crosses IPC. `dangerouslyAllowBrowser` stays false. |
| Static JSON in `data/` | No runtime network except Jev. |
| No test framework yet | The replay harness *is* the test loop. Add Vitest when weights get tuned. |

```
dota2-helper-jev/
├─ data/                      # generated + curated, committed
│  ├─ heroes.json             # id → { name, displayName, roles }         (generated)
│  ├─ items.json              # key → { displayName, cost, components }   (generated)
│  ├─ itemPopularity.json     # heroId → phase → [itemKey, count][]       (generated)
│  ├─ matchups.json           # heroId → vs heroId → winrate              (generated)
│  ├─ hero-tags.json          # CURATED: threat summary + tags per hero
│  └─ item-tags.json          # CURATED: effect summary + counters-tags
├─ scripts/
│  ├─ fetch-static-data.ts    # OpenDota → data/*.json (manual, per patch)
│  ├─ write-gsi-cfg.ts        # writes gamestate_integration_jev.cfg + token
│  └─ replay.ts               # POSTs a recorded .jsonl back at the GSI server
├─ fixtures/                  # recorded GSI sessions (.jsonl)
└─ src/
   ├─ main/
   │  ├─ index.ts             # app + windows + hotkey
   │  ├─ gsi/server.ts        # http listener, auth check, emit
   │  ├─ gsi/types.ts         # hand-written types, narrowed after the M1 spike
   │  ├─ match/store.ts       # normalized MatchState + reset rules
   │  ├─ match/situation.ts   # numbers → named buckets (the Jev-facing view)
   │  ├─ advise/candidates.ts # code-side candidate generation
   │  ├─ advise/items.ts      # item advisor: candidates → Jev → ranked
   │  ├─ advise/draft.ts      # draft advisor
   │  ├─ jev/client.ts        # TypeSafeClient + freshness guard
   │  ├─ jev/questions.ts     # every question + criteria, in one place
   │  └─ ipc.ts               # typed channel definitions
   ├─ preload/index.ts        # contextBridge, one typed surface
   └─ renderer/               # App.tsx, ItemPanel, DraftPanel, HeroPicker
```

---

## 2. Milestones

Ordered so each one is independently demoable, and so the riskiest unknown — what GSI
actually sends a player — is answered on day one.

### M1 — GSI spike + capture _(half a day)_

1. `scripts/write-gsi-cfg.ts`: takes `--dota-path`, writes the cfg from research §1.2
   with a random token into `.gsi-token` (gitignored). Prints the reminder to add
   `-gamestateintegration` to launch options.
2. `src/main/gsi/server.ts`: bind `127.0.0.1:52817`, validate `auth.token` on every
   POST, reply `200` immediately, hand the body to a callback.
3. Append every payload as one JSON line to `fixtures/<matchid|timestamp>.jsonl`.
4. Play one matchmaking game, spectate one game.

**Acceptance:** two `.jsonl` files exist; a short script prints, per `game_state`,
which top-level keys appeared. **This answers open questions #1 and #2** — then
hand-write `gsi/types.ts` from what was actually observed, not from the docs.

### M2 — Replay harness + match store _(half a day)_

1. `scripts/replay.ts <file.jsonl> [--speed 4]`: replays a fixture at the running
   server using the recorded inter-payload deltas. **Everything after this point is
   developed against replays.**
2. `match/store.ts`: normalized `MatchState` — own hero, level, items (slots + stash +
   neutral), gold split, KDA, deaths with timestamps, clock, score, towers lost, Roshan,
   plus user-reported enemy heroes/items kept in a separate branch of the tree (the
   `Fact<T>` source rule from research §2). Reset on `matchid` change or on return to
   hero-selection.
3. `match/situation.ts`: the deterministic layer — **all numbers become named buckets
   here and nowhere else.**

```ts
phase          = clock < 10 * 60 ? "laning" : clock < 25 * 60 ? "mid game" : "late game";
teamLead       = bucket(myScore - theirScore);
               // "far ahead" | "ahead" | "even" | "behind by a few kills" | "far behind"
recentDeaths   = describeDeaths(deaths, clock);
               // "died 3 times in the last 5 minutes, twice while holding over 1500 gold"
goldToGo(item) = Math.max(0, item.cost - gold);   // stays a raw number, code-side only
```

**Acceptance:** `npm run replay fixtures/x.jsonl` drives a console dump of `MatchState`
+ `Situation` through a whole game with no Dota client running.

### M3 — Static data + curated tags _(half a day)_

1. `scripts/fetch-static-data.ts` pulls `/constants/heroes`, `/constants/items`,
   `/heroes/{id}/itemPopularity`, `/heroes/{id}/matchups` once and writes `data/*.json`.
   Slow and rate-limited is fine — it runs manually, not at runtime.
2. **Curate by hand.** This is the part that decides output quality (research §4.2:
   never rely on Jev knowing what Anti-Mage does):
   - `hero-tags.json`, ~30 commonly-picked heroes to start:
     `{ "threat": "permanent invisibility and item-draining attacks",
        "tags": ["invisibility", "physical", "carry"] }`
   - `item-tags.json`, ~40 situational items:
     `{ "effect": "grants spell immunity for a few seconds",
        "counters": ["magic-burst", "disable"] }`

   Anything uncurated falls back to popularity-only ranking and is never sent to Jev —
   degrade, don't guess.

**Acceptance:** `getHeroTags("npc_dota_hero_riki")` and `getItemTags("item_black_king_bar")`
resolve; a coverage report prints what's missing.

### M4 — Code-only baseline advisor _(half a day)_

`advise/candidates.ts`:

- **Items:** `itemPopularity[phase]` for own hero → drop owned/stashed → drop components
  already consumed → add situational items whose `counters` tags intersect the union of
  enemy hero `tags` → cap at 10.
- **Draft:** heroes not picked/banned, playable in the user's role, ranked by summed
  matchup advantage vs enemy picks (with a minimum-games floor) → top 12.

Rank on popularity + affordability alone. **This baseline ships in the UI behind a
toggle and stays there** — it is what Jev has to beat, and the fallback when Jev
times out.

**Acceptance:** replaying a fixture prints a plausible top-3 at each phase change.

### M5 — Overlay UI _(one day)_

- Overlay window exactly as research §3.3: transparent, frameless, `focusable: false`,
  `setAlwaysOnTop(true, "screen-saver")`, `setIgnoreMouseEvents(true, { forward: true })`.
- `Alt+Shift+D` toggles interactive mode (needed for the hero picker); a visible border
  appears while interactive so the state is never ambiguous.
- **ItemPanel:** top 3 cards — icon, name, gold-to-go, and a one-line "why" rendered
  from a *code template* keyed on the highest-weighted dimension. Never model-generated text.
- **DraftPanel:** hero grid with fuzzy search, click to add to `enemies` / `allies`,
  chips with click-to-remove, role selector. Opens automatically when `game_state` is
  hero-selection; collapses to a small badge otherwise.
- Position draggable once, persisted under `app.getPath("userData")`.
- Tray icon showing GSI health: "waiting for first heartbeat" → "match live".

**Acceptance:** overlay renders over borderless-windowed Dota, click-through works,
the picker takes ten clicks to fill an enemy team.

### M6 — Jev integration _(one day)_ ← the actual point of the POC

Details in §3. Ships behind `ENABLE_JEV=1` so the baseline stays comparable.

**Acceptance:** a toggle in the overlay shows baseline top-3 vs composite top-3 on the
same state; end-to-end latency stays around a second.

---

## 3. Jev design

One request per decision point. Never per GSI tick.

### 3.1 Triggers (code, debounced 2s)

Item advisor fires on: item bought or sold · death · respawn · gold crossing the cost of
the current #1 candidate · phase change · user edits the enemy list. Nothing else.
Draft advisor fires on any change to picks/bans/role, debounced 1s.

### 3.2 State — small, named, pre-bucketed

Send only what the questions reference (research §4.2: large irrelevant state hurts).

```json
{
  "me": { "hero": "Juggernaut", "role": "carry", "level": 14,
          "items": ["Battle Fury", "Phase Boots"] },
  "enemies": [
    { "hero": "Lion", "threat": "single-target disables and burst magic damage" },
    { "hero": "Riki", "threat": "permanent invisibility" }
  ],
  "known_enemy_items": [{ "hero": "Riki", "item": "Diffusal Blade" }],
  "situation": {
    "phase": "mid game",
    "team_lead": "behind by a few kills",
    "recent_deaths": "died 3 times in the last 5 minutes, twice while holding over 1500 gold",
    "towers": "lost both tier-1 towers"
  }
}
```

Threat strings come from `hero-tags.json`. No raw gold, no timestamps, no win rates —
those stay in code and are combined after the answers come back.

### 3.3 Questions (all defined in `jev/questions.ts`)

Two Scores per item candidate, kept separate because code weights them differently:

```ts
import { noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const fitLevels = [
  "The item's effect does nothing against any enemy hero listed in `enemies`",
  "The item's effect counters one enemy hero's main threat",
  "The item's effect counters the main threat of several enemy heroes",
] as const;

const needLevels = [
  "The current situation gives no reason to buy an item with this effect",
  "The effect would help somewhat, but other purchases address more pressing problems",
  "The effect directly addresses the most pressing problem the player has right now",
] as const;

score(
  { item: { name, effect },
    question: "How well does `item` counter the threats of the heroes in `enemies`?" },
  fitLevels,
);
score(
  { item: { name, effect },
    question: "For the hero in `me`, how much does the current `situation` call for what `item` provides?" },
  needLevels,
);
```

Plus four global Nouls in the same request (speculative fan-out — code decides which
answers it uses): `survival_is_bottleneck` · `enemy_relies_on_magic_burst` ·
`enemy_has_invisibility` · `team_is_losing_fights`.

Budget: 10 candidates × 2 + 4 = **24 questions in one request**, ~2–3k tokens, well
under a tenth of a cent. Latency is one round trip, not 24.

The draft advisor has the same shape: `fills_gap_<hero>` and `vs_enemy_<hero>` Scores
per candidate, plus `draft_lacks_initiation` / `_save` / `_waveclear` / `_lategame` Nouls.

> Verify the exact `score`/`noul` helper signatures against the installed SDK's
> `src/types.ts` on first use — the docs site shows the request-object shape
> (`{ type, instructions, criteria }`) and only `choice` is demonstrated inline.

### 3.4 Composition — code owns every number

```ts
rank = 0.35 * popularityNorm     // from data/itemPopularity.json
     + 0.30 * (fit.score / 2)    // Score → 0..1 over 3 levels
     + 0.35 * (need.score / 2)
     + affordabilityBonus;       // 1.0 if affordable now, decaying by gold-to-go
```

- Weights live in one exported `WEIGHTS` object. Changing them **must not** trigger a
  new Jev request — raw answers are cached against the state hash.
- `confidence < 0.4` on a candidate's Scores → still show it, labeled "situational".
- Nouls are **modifiers, not rankers**: `survival_is_bottleneck > 0.7` adds a bonus to
  items tagged `survivability`. Keeping them out of the per-item Scores is what makes a
  low-confidence Noul harmless.

### 3.5 Failure and freshness

- `timeout: 2000`, SDK default retries. On failure or timeout → render the baseline
  ranking silently. Advisory UI must never block or blank.
- Hash the state object before the request; if the hash changed when the response lands
  (items bought, enemies edited), discard the answer.
- Log `response.model` per request; pin the version once anything is tuned.
- `TYPESAFE_API_KEY` from `.env` via `dotenv` in main; `.env` gitignored. The POC is
  personal-use only — the proxy in research §4.7 is a prerequisite for distributing it,
  and the README must say so.

---

## 4. Order of work

```
M1 spike ──► M2 replay+store ──┬─► M3 data/tags ──┐
                               └─► M5 overlay UI ─┴─► M4 baseline ──► M6 Jev
```

M3 and M5 are independent once the replay harness exists. Roughly four days of focused
work to a demoable POC.

---

## 5. Things that will bite, and the answer

| Risk | Answer in this plan |
| --- | --- |
| Overlay invisible in exclusive fullscreen | README requires borderless windowed; tray warns when no GSI heartbeat arrives. |
| Manual enemy entry too slow mid-draft | Everything works with zero enemy heroes (popularity + own state). Enemy input only *improves* the result. |
| Jev doesn't beat the baseline | That's a finding, and the toggle makes it visible. Curated tags are the first thing to improve — not the weights. |
| Patch changes GSI field names | Types are written from captured payloads (M1); replay fixtures catch breakage immediately. |
| Valve policy tightens | GSI + manual input only. Disclaimer in the UI. No OCR, no file parsing, no memory. |

---

## 6. Definition of done

1. Fresh clone → `npm i` → `npm run setup:gsi -- --dota-path=...` → launch → overlay
   shows suggestions in a live game.
2. Item panel updates on item purchase and on death within ~2s.
3. Draft panel takes manual enemy picks and returns a ranked top-5.
4. Baseline/Jev toggle demonstrates the difference on at least one recorded fixture.
5. README documents the ToS position and the personal-use key caveat.

---

## 7. Immediately after the POC

Record fixtures during normal play → hand-label ~50 decision points → replay to measure
top-3 hit rate, baseline vs composite → drop any Jev question that doesn't move the
metric. That is the loop research §5 describes, and it needs nothing this plan doesn't
already build.
