# Research: Dota 2 in-game helper overlay (Electron + GSI + TypeSafe Jev)

_Date: 2026-09-22 · Status: research / pre-design_

Goal: an Electron overlay that detects the current Dota 2 match via Game State
Integration (GSI) and suggests (1) the next item to buy for the current game
phase and situation, and (2) hero picks during the draft. TypeSafe's System One
model **Jev** supplies the situational judgments; code owns everything else.

---

## TL;DR

1. **GSI is Valve's official, read-only push API.** The Dota client POSTs JSON to a
   local HTTP server you run. Enable with the `-gamestateintegration` launch option
   plus a `gamestate_integration_*.cfg` file. No memory reading, no injection.
2. **As a player, GSI only exposes _your own_ hero.** `allplayers` / full-match data
   is only sent to spectators and observers. That means **no teammate data, no enemy
   data, and (most likely) no draft data** while you are playing a matchmaking game.
   This is the biggest constraint on the product, bigger than "can't see enemy items".
3. **Enemy/teammate heroes must come from the user** (click heroes in the overlay
   during draft, or a one-time confirm after loading). Treat these as _user-reported
   facts_, separate from GSI-observed facts.
4. **Jev fits as a selector, not a generator.** Code builds a short candidate list
   (items from OpenDota popularity by phase, heroes from matchup stats), then Jev
   Scores/Nouls each candidate on a few situational dimensions, and code combines them
   with weights. Numbers, timings and gold math stay in code.
5. **ToS risk is real but manageable.** Valve's 2023 warning targets apps that
   "read data from the Dota client". GSI is Valve-provided, but anything beyond it
   (OCR of the screen, parsing client files, memory) moves into banned territory.
   Stay GSI + manual input only.

---

## 1. Dota 2 Game State Integration

### 1.1 How it works

- Dota client acts as an HTTP client: every change (throttled) it `POST`s a JSON body
  to each `uri` configured in a `gamestate_integration_*.cfg` file.
- Disabled by default; requires the Steam launch option `-gamestateintegration`
  ([Rust dota-gsi docs](https://docs.rs/dota-gsi/latest/dota/),
  [Overwolf support](https://support.overwolf.com/support/solutions/articles/9000212745-how-to-enable-game-state-integration-for-dota-2)).
- Config dir: `<Steam library>/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/`
  - Windows default: `C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta\...`
  - macOS default: `~/Library/Application Support/Steam/steamapps/common/dota 2 beta/...`
  - Linux default: `~/.steam/steam/steamapps/common/dota 2 beta/...`
  - Non-default libraries: parse `steamapps/libraryfolders.vdf` to find the one that
    contains app `570`.

### 1.2 Config file

```
"dota2-helper"
{
    "uri"        "http://127.0.0.1:52817/gsi"
    "timeout"    "5.0"
    "buffer"     "0.1"
    "throttle"   "0.1"
    "heartbeat"  "30.0"
    "auth"
    {
        "token"  "<random per-install token>"
    }
    "data"
    {
        "provider"      "1"
        "map"           "1"
        "player"        "1"
        "hero"          "1"
        "abilities"     "1"
        "items"         "1"
        "draft"         "1"
        "events"        "1"
        "buildings"     "1"
        "roshan"        "1"
        "couriers"      "1"
        "neutralitems"  "1"
        "minimap"       "0"
        "wearables"     "0"
        "league"        "0"
    }
}
```

Provider list from [antonpup/Dota2GSI](https://github.com/antonpup/Dota2GSI) and
[xzion/dota2-gsi](https://github.com/xzion/dota2-gsi). Validate `auth.token` on every
request so other local processes can't spoof state.

### 1.3 What each provider gives (local player)

| Provider | Useful fields for this app |
| --- | --- |
| `map` | `matchid`, `game_time`, `clock_time`, `daytime`, `game_state` (hero selection, strategy time, pre-game, in progress, post-game), `radiant_score`, `dire_score`, `paused`, `win_team`, roshan state |
| `player` | `team_name`, K/D/A, last hits, denies, `gold`, `gold_reliable`, `gold_unreliable`, `gpm`, `xpm`, net worth (field availability varies by patch) |
| `hero` | `id`, `name`, `level`, `alive`, `respawn_seconds`, `buyback_cost`, `buyback_cooldown`, health/mana, status flags (stunned, silenced, hexed, magic immune, broken, smoked…), `aghanims_scepter`, `aghanims_shard`, talent array, facet (patch dependent) |
| `abilities` | name, level, cooldown, can_cast, ultimate flag |
| `items` | `slot0-8`, `stash0-5`, `teleport0`, `neutral0` with names like `item_black_king_bar`, charges, cooldowns |
| `draft` | active team, pick flag, time remaining, picks/bans per team — **documented for spectators; confirm in a real matchmaking draft before relying on it** |
| `events` | game events (roshan kill, aegis, courier, tips, bounties…) — shape varies by patch |
| `buildings`, `roshan`, `couriers`, `neutralitems` | tower/rax HP, Roshan phase, courier state, team neutral tier timers |

Names come back in console format (`npc_dota_hero_*`, `item_*`); map them with
OpenDota `/constants/heroes` and `/constants/items`.

### 1.4 The hard limit: player vs spectator

> "the game can expose information about all players in the game while spectating a
> match, but will only expose local player's information when playing a game."
> — [antonpup/Dota2GSI](https://github.com/antonpup/Dota2GSI)

> "Full player data is now available, but only to spectators and observers."
> — [xzion/dota2-gsi](https://github.com/xzion/dota2-gsi)

Consequences:

| Data | While playing | While spectating |
| --- | --- | --- |
| Own hero, items, gold, abilities | ✅ | ✅ (all players) |
| Teammates' heroes/items/levels | ❌ | ✅ |
| Enemy heroes/items/levels | ❌ | ✅ |
| Draft picks/bans | ⚠️ unverified, assume ❌ | ✅ |
| Score, clock, buildings, Roshan | ✅ | ✅ |

So the user's premise "use teammates' condition" also doesn't hold from GSI alone.
Only **own player + global map state** is reliable.

**Spike to run first (1 evening):** log raw payloads to disk through one full
matchmaking game (hero selection → post game) and one spectated game. Diff what each
provider actually contains per `game_state`. Every design decision below depends on it.

---

## 2. Getting the data GSI doesn't give

Rank by safety (ToS) and reliability:

| Source | What it gives | Safety | Notes |
| --- | --- | --- | --- |
| **Manual input in overlay** | enemy + ally heroes, optional enemy key items ("Enemy PA has BKB") | ✅ safe | Hero picker grid during draft; global hotkey to open. 10 clicks per match. Best default. |
| **Own GSI history** | own items/gold timeline, deaths, phase | ✅ | Deaths while holding gold → "buy defensive"; derive tempo in code. |
| **Global map state** | kill score, towers lost, Roshan, clock | ✅ | Proxy for "are we ahead/behind" without enemy data. |
| **OpenDota API** | hero matchups, item popularity by phase, hero constants, player hero pools (needs account IDs) | ✅ | `/heroes/{id}/matchups`, `/heroes/{id}/itemPopularity`, `/constants/*`. Rate limited; cache aggressively. |
| **STRATZ GraphQL** | richer stats (by bracket, by position) | ✅ | Needs API token; good upgrade path. |
| Post-match Steam Web API / OpenDota match | full match data after the game | ✅ | Useful for learning weights later, not live. |
| Screen OCR of top bar / scoreboard | enemy heroes, levels | ⚠️ grey | Not reading the client process, but Valve could treat it as a third-party advantage. Avoid for v1. |
| Parsing client logs/files, console commands, memory | anything | ❌ | Valve disabled introspection commands and banned 40k accounts in Feb 2023. |

Valve (Feb 2023, [dota2.com](https://www.dota2.com/newsentry/3677788723152833273)):
"If you are running any application that reads data from the Dota client as you're
playing games, your account can be permanently banned from playing Dota." The same
update disabled console commands that "could be used to introspect client state"
and broke Overwolf's draft helpers
([esports.gg](https://esports.gg/news/dota-2/dota-2-update-kills-third-party-applications-including-overwolf/)).
GSI itself is the sanctioned channel, but show a disclaimer and never go beyond it.

Data model rule: keep three kinds of facts separate in code and in Jev state:

```ts
type Fact<T> =
  | { source: "gsi"; value: T; at: number }          // observed by the game client
  | { source: "user"; value: T; at: number }         // reported by the user
  | { source: "inferred"; value: T; at: number };    // derived by code/model
```

---

## 3. Electron architecture

```
┌──────────────── Dota 2 client ────────────────┐
│ POST JSON every ~100ms (throttle)             │
└───────────────┬───────────────────────────────┘
                ▼ http://127.0.0.1:52817/gsi (auth token)
┌──────────── Electron main process ────────────┐
│ GSI server → MatchStore (normalized, typed)   │
│ Trigger engine (what changed? debounce)       │
│ Candidate builder (OpenDota cache, rules)     │
│ Jev client (TypeSafe SDK, key never in UI)    │
│ Scorer (weights in code)                      │
└───────────────┬───────────────────────────────┘
                ▼ IPC (contextBridge, typed)
┌──────────── Overlay renderer ─────────────────┐
│ transparent, click-through, always-on-top     │
│ hero picker (draft), item panel, hotkey toggle│
└───────────────────────────────────────────────┘
```

### 3.1 GSI server (main process)

- `node:http` or Fastify bound to `127.0.0.1` only.
- Reply `200` quickly; process async. Dota retries on timeout.
- First payload has no `previously` diff; later payloads include `previously`/`added`
  keys — use those for change detection, or diff yourself against `MatchStore`.
- Reset `MatchStore` when `map.matchid` changes or `game_state` returns to
  hero-selection.
- Ready libs: [`dota2-gsi`](https://www.npmjs.com/package/dota2-gsi) (Node,
  EventEmitter per key). Old; writing a thin typed server is ~100 lines and avoids
  its "no initial emit for some keys" caveat.

### 3.2 Auto-setup

1. Find Steam root (registry on Windows `HKCU\Software\Valve\Steam\SteamPath`,
   default paths on mac/Linux).
2. Parse `libraryfolders.vdf`, find library with app `570`.
3. Write `gamestate_integration_dota2helper.cfg` with a random token.
4. Tell the user to add `-gamestateintegration` to launch options (can't safely edit
   Steam's `localconfig.vdf` while Steam runs).
5. Health check: "waiting for first GSI heartbeat…" in the tray.

### 3.3 Overlay window

```ts
const overlay = new BrowserWindow({
  transparent: true,
  frame: false,
  resizable: false,
  skipTaskbar: true,
  focusable: false,
  hasShadow: false,
  webPreferences: { preload, contextIsolation: true, sandbox: true },
});
overlay.setAlwaysOnTop(true, "screen-saver");
overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // macOS
overlay.setIgnoreMouseEvents(true, { forward: true }); // click-through
globalShortcut.register("Alt+Shift+D", toggleInteractive); // enable clicks for hero picker
```

- Works over **borderless windowed** Dota. Exclusive fullscreen on Windows will hide
  it; instruct users to use borderless. (Overwolf avoids this by injecting into the
  render pipeline — don't.)
- Toggle between click-through (in-game) and interactive (draft picker) modes.
- Keep the panel small and off the minimap/HUD; let the user drag it once and save
  position.

---

## 4. Where TypeSafe Jev fits

Sources: [System One](https://docs.typesafe.ai/concepts/system-one.md),
[How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md),
[Primitives](https://docs.typesafe.ai/primitives.md),
[Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md),
[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md),
[Models](https://docs.typesafe.ai/models.md), [JS SDK](https://docs.typesafe.ai/sdk/javascript.md).

### 4.1 Relevant properties

- Returns typed answers (`choice`, `score`, `noul`) with calibrated probabilities, not text.
- ~100 ms per query; independent questions in one request run in parallel.
- Text-only state (string / JSON object / array). English best.
- Context: 64k tokens per request; 32k for state + longest question.
- Price: $0.042 per million **input** tokens; output free. A 3k-token request ≈
  $0.000126. Even 200 calls/match ≈ $0.03/match.
- Rate limits currently 1,200 req/min, 250k tok/s (docs say these change dynamically).
- JS SDK: `npm install @typesafe-ai/sdk` (Node ≥ 20); `choice()`, `score()`,
  `noul()` helpers; answer types inferred; retries on 408/429/5xx by default;
  `timeout` default 10 s per attempt; `dangerouslyAllowBrowser` defaults `false`.

### 4.2 Known weaknesses → design rules

From the jaggedness page, mapped to this app:

| Jev weakness | Rule for this app |
| --- | --- |
| Math & numbers, counting | Gold affordability, timings, net-worth deltas, win-rate math: **code**. Pass named buckets ("behind by a lot") not raw numbers when a judgment needs them. |
| Date/time comparison | Game phase from `clock_time` computed in code. |
| Large irrelevant state | Send only the fields a question needs. Don't dump the whole GSI payload. |
| Literal reading | Write exact conditions; put boundary cases in criteria. |
| Generation | Never ask Jev to name an item/hero. Code produces candidates; Jev selects/rates. |
| Knowledge in weights | Don't rely on Jev "knowing" what Anti-Mage does. Put short hero/item descriptors from a curated table (OpenDota constants + our tags) in state. |

### 4.3 What stays in code vs what Jev judges

| Code (deterministic) | Jev (situational judgment) |
| --- | --- |
| Game phase buckets (laning 0–10, mid 10–25, late 25+ — tunable) | How much the situation calls for defensive vs. aggressive itemization |
| Candidate items (hero popularity for phase, minus owned, build-path aware) | How well each candidate answers the enemy lineup's threats |
| Affordability, gold-to-go, "buy now vs save" | Whether the user's recent deaths suggest survivability is the bottleneck |
| Candidate heroes (matchup win rates vs picked enemies, role filter, bans removed) | How well a candidate fills what our draft lacks (initiation, save, wave clear…) |
| Hero/item tag table (magic dmg, invis, heal, dispel, BKB-piercing) | Whether enemy picks form a threat pattern (e.g. heavy magic burst, illusions, invisibility) |
| Weights, thresholds, final ranking | Confidence → when to show "unsure" |

### 4.4 Item recommendation flow

1. **Trigger** (code): item bought/sold, death, respawn, crossing a gold threshold of
   the next candidate, phase change, or user reports new enemy item. Debounce 2 s.
   Never call per GSI tick.
2. **Candidates** (code): `itemPopularity[phase]` for own hero → drop owned, drop
   components already covered, keep top ~8–12. Add situational pool from tags
   (BKB, Lotus, Linken, Ghost, Force, Glimmer, Dust/Sentry/Gem, Spirit Vessel…) when
   an enemy tag matches.
3. **One Jev request, fan-out** (speculative, all independent over the same state):
   - per candidate `fit_<item>`: Score, how well it answers the enemy threats.
   - per candidate `need_<item>`: Score, how much the current situation needs what it
     provides (uses deaths, lead/deficit bucket, phase).
   - global Nouls: `survival_is_bottleneck`, `team_is_losing_fights`,
     `enemy_has_invisibility`, `enemy_relies_on_magic_burst`.
4. **Compose** (code): `rank = w1*popularity + w2*fit + w3*need + affordability bonus`;
   show top 3 with gold-to-go. Low Score confidence → show but mark "situational".
5. **Freshness**: store the state hash used for the request; drop the answer if
   items/gold bucket/enemy list changed before it returned.

Example (TypeScript, main process):

```ts
import { noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ timeout: 2000 }); // key from TYPESAFE_API_KEY

const needLevels = [
  "The current situation gives no reason to buy an item with this effect",
  "The effect would help somewhat, but other purchases address more pressing problems",
  "The effect directly addresses the most pressing problem the player has right now",
] as const;

const fitLevels = [
  "The item's effect does nothing against any enemy hero listed in `enemies`",
  "The item's effect counters one enemy hero's main threat",
  "The item's effect counters the main threat of several enemy heroes",
] as const;

async function rateItems(state: ItemState, candidates: ItemInfo[]) {
  const questions = Object.fromEntries(
    candidates.flatMap((item, i) => [
      [
        `fit_${item.key}`,
        score(
          {
            item: { name: item.displayName, effect: item.effectSummary },
            question: "How well does `item` counter the threats of the heroes in `enemies`?",
          },
          fitLevels,
        ),
      ],
      [
        `need_${item.key}`,
        score(
          {
            item: { name: item.displayName, effect: item.effectSummary },
            question: "For the hero in `me`, how much does the current `situation` call for what `item` provides?",
          },
          needLevels,
        ),
      ],
    ]),
  );

  questions.survival_is_bottleneck = noul(
    "Is the player in `me` dying often enough in `situation.recent_deaths` that surviving fights matters more than dealing damage?",
  );

  return client.systemOne({ state, questions });
}
```

State stays small and named:

```json
{
  "me": { "hero": "Juggernaut", "role": "carry", "level": 14, "items": ["Battle Fury", "Phase Boots"] },
  "enemies": [
    { "hero": "Lion", "threat": "single-target disables and burst magic damage", "source": "user" },
    { "hero": "Riki", "threat": "permanent invisibility", "source": "user" }
  ],
  "known_enemy_items": [{ "hero": "Riki", "item": "Diffusal Blade", "source": "user" }],
  "situation": {
    "phase": "mid game",
    "team_lead": "behind by a few kills",
    "recent_deaths": "died 3 times in the last 5 minutes, twice while holding over 1500 gold",
    "towers": "lost both tier-1 towers"
  }
}
```

Notice: numbers are pre-bucketed into phrases by code; hero threat summaries come from
our curated table, not from model knowledge.

### 4.5 Draft suggestion flow

1. **Input** (user + maybe GSI `draft`): ally picks, enemy picks, bans, own intended role.
2. **Candidates** (code): heroes not picked/banned, playable in the user's role; rank
   by summed matchup advantage vs enemy picks from OpenDota `/heroes/{id}/matchups`
   (wins/games, with minimum-games floor) → top ~15.
3. **Jev, one request**:
   - `draft_needs_*` Nouls (global): lacks initiation, lacks save, lacks wave clear,
     lacks physical/magic damage balance, lacks late-game carry.
   - per candidate `fills_gap_<hero>`: Score, how well the hero fills what `allies` lack.
   - per candidate `vs_enemy_<hero>`: Score, how well its kit handles the enemy picks'
     threats (hero descriptors in state).
4. **Compose** (code): `rank = a*matchupWinrate + b*fills_gap + c*vs_enemy + d*user_pool`
   where `user_pool` comes from the user's own OpenDota hero history (own account ID is
   available via GSI `player.accountid` / `steamid`).
5. Show top 5 with one-line "why" from the highest-weighted dimension (a template in
   code, not generated text).

Draft is time-boxed (~30 s per pick). Jev ~100 ms + network is fine; prefetch the
OpenDota data at hero-selection start.

### 4.6 Phase / situation classification

Don't ask Jev "what phase is it" — clock time answers that. Useful Jev questions are
the ones code can't compute from numbers alone:

- Score: "How much is the team in `situation` on the back foot?" with levels describing
  concrete situations (towers lost, deaths, Roshan taken) — but only if code-level
  heuristics prove insufficient. Try the heuristic first.
- Noul: "Has the enemy lineup in `enemies` shown mostly magic damage?" (combined with
  user-reported items).

### 4.7 API key handling in Electron

- SDK only in the **main process**; renderer gets results over IPC. Never
  `dangerouslyAllowBrowser`.
- Shipping a key inside a distributed app still leaks it (asar is readable). For
  anything beyond personal use, put a tiny proxy in front (e.g. Cloudflare Worker) that
  holds the key, rate-limits per install, and only accepts our fixed question templates.

---

## 5. Evaluation plan

- Record GSI payloads + user-entered heroes for ~20 own matches (fixture corpus).
- Hand-label "right next item" for ~50 decision points (or use the item the player
  actually bought, from OpenDota post-match, as weak labels).
- Replay fixtures offline → measure top-3 hit rate for: popularity-only baseline vs.
  popularity + Jev composite. Only keep Jev questions that move the metric.
- Log `response.model` (e.g. `jev-1.13.0`); pin the version once weights/thresholds are
  tuned, since `jev-latest` can move.
- Later: feed Jev probabilities as features into a small classical model trained on
  labeled outcomes (see [autoresearch feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery.md)).

---

## 6. Risks & open questions

| # | Item | Action |
| --- | --- | --- |
| 1 | Does GSI send any `draft` data to a _player_ in matchmaking? | Spike: log a real draft. |
| 2 | Exact `player`/`hero` field names on the current patch (facets, net worth, etc.) | Spike; generate TS types from captured payloads. |
| 3 | Valve policy could tighten (Dota Plus sells built-in item/draft suggestions) | GSI + manual input only; disclaimer; kill switch. |
| 4 | Overlay invisible in exclusive fullscreen | Require borderless windowed; detect & warn. |
| 5 | OpenDota rate limits / `itemPopularity` gaps for some heroes | Cache per patch on disk; fallback to STRATZ or bundled snapshot. |
| 6 | Manual enemy input friction | Fast hero grid with search + recent heroes; optional. App must still work with zero enemy info (popularity + own state only). |
| 7 | Jev hero knowledge vs. curated descriptors | Maintain a hero/item tag table; update per patch. |
| 8 | Latency spikes mid-fight | Suggestions are advisory; stale-result check; 2 s timeout, keep last good result. |

---

## 7. Suggested next steps

1. GSI logging spike (main-process HTTP server + cfg writer) → capture player vs
   spectator payloads, answer open questions 1–2.
2. OpenDota cache module (constants, itemPopularity, matchups) + curated tag table.
3. Code-only baseline recommender (popularity + affordability + phase).
4. Add Jev composite scoring behind a flag; compare on fixture corpus.
5. Overlay UI: click-through item panel + interactive draft picker with hotkey.

## Sources

- [antonpup/Dota2GSI (C#)](https://github.com/antonpup/Dota2GSI)
- [xzion/dota2-gsi (Node)](https://github.com/xzion/dota2-gsi) · [npm dota2-gsi](https://www.npmjs.com/package/dota2-gsi)
- [tomasfarias/dota-gsi (Rust)](https://github.com/tomasfarias/dota-gsi) · [docs.rs dota-gsi](https://docs.rs/dota-gsi/latest/dota/)
- [Overwolf: enable GSI for Dota 2](https://support.overwolf.com/support/solutions/articles/9000212745-how-to-enable-game-state-integration-for-dota-2)
- [Valve: Cheaters Will Never Be Welcome in Dota (Feb 2023)](https://www.dota2.com/newsentry/3677788723152833273)
- [esports.gg: Dota 2 update kills third-party apps incl. Overwolf](https://esports.gg/news/dota-2/dota-2-update-kills-third-party-applications-including-overwolf/)
- [OpenDota API docs](https://docs.opendota.com)
- TypeSafe docs: [index](https://docs.typesafe.ai/llms.txt), [API](https://docs.typesafe.ai/api.md), [Models](https://docs.typesafe.ai/models.md), [Confidence](https://docs.typesafe.ai/confidence.md), [Score](https://docs.typesafe.ai/primitives/score.md), [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md), [JS SDK types v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts)
