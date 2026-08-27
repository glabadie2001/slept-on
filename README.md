# 🏈 War Room — Dynasty Dashboard for Sleeper

A fully client-side dashboard for winning a Sleeper dynasty league against all odds.
Connects to Sleeper's public read-only API straight from the browser — no backend, no
API keys, no passwords. Enter your username, pick your league, and it auto-detects
which roster is yours.

## Run it

```bash
npm install
npm run dev        # local dev server
npm run build      # production build in dist/ (relocatable, hosts anywhere)
```

There's a built-in **demo league** (a seeded 12-team superflex dynasty league,
complete with a regrettable Nacua-for-Mixon trade on the ledger) so every feature
can be explored and screenshot-tested without a network connection.

## What it does

| Tab | Features |
|---|---|
| **Overview** | Power rankings (45% optimal-lineup strength, 30% dynasty roster value, 15% points, 10% record), stat tiles, every team's top assets, your team highlighted |
| **My Team** | Current vs optimal lineup projection, concrete start/sit moves ("start X over Y, +2.2"), injury report with severity, bench ranked by value with hold/sell badges (🌱 young core / ⏳ sell window). Roster management (`lib/roster.ts`): IR hygiene (IR-eligible players wasting active spots, healthy players parked on IR), drop/add upgrade pairs (free agents that outclass a bench hold, margin-gated because drops are forever), taxi squad manager (promote/stash advice — promotions are held to a high bar and carry an explicit ⚠ irreversible warning), and a roster-crunch forecast (incoming rookie picks vs open spots, naming the weakest holds). All advice is read-only — you execute moves in Sleeper |
| **Matchup** | Head-to-head slot-by-slot projections vs this week's opponent, win probability (normal model) |
| **Playoffs** | Seeded Monte Carlo over the remaining schedule: playoff/bye/title odds, seed distribution, per-game leverage ("+21% if you win this one"). Knobs: sim count, results↔projections strength blend, recency half-life, score volatility σ, playoff-spot & median-win overrides, forced W/L what-ifs, per-team ±ppg boosts (trade scenarios), re-rollable seed. Preseason = synthetic round-robin fallback |
| **Waivers** | **Waiver Watchdog** (`lib/watchdog.ts`): breakout detector over recent weeks' actual stat lines for every NFL player — flags free agents whose points spiked past their own baseline with opportunity (targets+carries) climbing week over week, tiered 🚨 breaking-out / 👀 worth-watching with plain-English reasons ("22.6 pts in wk 4 vs 5.3 avg · opportunity up 3 straight weeks · rookie WR"); plus free agents ranked by dynasty value + weekly projection + league-wide add trends, boosted toward your weakest positions; FAAB tracker |
| **Trades** | Suggested trades (partner surplus ↔ your need, priced to be acceptable), interactive trade analyzer with verdicts, trade ledger grading completed trades at today's values — all market-aware once a value source is synced |
| **Draft** | Guide aggregator: upload/paste every draft guide you can find (CSV, spreadsheet, ranked lists from PDFs, tiers) → one consensus board with avg rank, range, disagreement σ, guide coverage, and your value/market columns; bundled scraped guides (FantasyPros ECR, KeepTradeCut, CBS, Matthew Berry — rookie + overall, superflex/1QB auto-matched to the league, see `src/data/bundledGuides.ts`) load with one click; "where your guides disagree" callouts; Sleeper draft-room sync (order, live picks, hide-drafted, on-the-clock); draft intel (`lib/draftIntel.ts`): market-vs-consensus divergence column + "market steals" sort, survival odds ("Lasts %" to your next pick, need-weighted over the teams picking before you, traded picks honored), dead-QB-market detection for 1QB leagues, and an on-the-clock alert card |
| **Dynasty** | Value-weighted core age vs league, contend/rebuild window call, draft-pick capital, young-core and sell-window lists |

## Architecture

```
src/
  api/
    http.ts          fetch with timeout + retry/backoff
    sleeper.ts       typed client: documented v1 endpoints + semi-official
                     projections/stats (api.sleeper.com) with graceful fallback
    idb.ts           tiny shared IndexedDB kv store
    playersCache.ts  ~5MB players blob trimmed to fantasy positions, IndexedDB, 24h TTL
    marketValues.ts  real dynasty market values: FantasyCalc live sync (joins on
                     sleeperId, parameterized by superflex/PPR/size), KTC-style
                     paste import (name matching), demo market; IndexedDB cache
  lib/
    scoring.ts       league scoring_settings × raw stat lines (custom scoring is exact)
    value.ts         dynasty value model: production vs replacement × age curve
                     + youth upside; superflex-aware; pick values
    market.ts        market↔heuristic blending on the 0-100 scale (players + picks)
    guides.ts        draft-guide parsing (forgiving: csv/tsv/ranked text/tiers) and
                     consensus aggregation with name matching + disagreement stats
    lineup.ts        lineup optimizer honoring league roster_positions (flex/superflex),
                     start/sit advice, availability handling (Out/IR = 0)
    roster.ts        roster management: IR hygiene, drop/add upgrade pairs,
                     taxi promote/stash advice (irreversible moves flagged),
                     roster-crunch forecast, hold/sell badges
    log.ts           client-side event log (ring buffer in localStorage) behind
                     the unlisted /analytics page — nothing leaves the browser
    analysis.ts      power rankings, positional needs, waiver targets,
                     trade suggestions/evaluator/ledger, injury alerts, win prob
    watchdog.ts      Waiver Watchdog: breakout detection from recent weekly stat
                     lines (spike vs own baseline, usage streaks, add trends, youth)
    simulator.ts     seeded Monte Carlo season sim: Normal(strength, σ) weekly scores,
                     standings w/ tiebreaks, reseeded bracket, leverage conditioning
    __tests__/       vitest suite for the sim engine, market parsing/blending, demo data
  demo/demoData.ts   deterministic seeded demo league (full 14-wk schedule, 5 played)
  AppContext.tsx     loads the full league bundle (parallel fetches incl. every week's
                     matchups), blends market values, memoized
  views/             Setup, Overview, MyTeam, Matchup, Playoffs, Waivers, Trades, Draft, Dynasty
```

Run `npm test` for the simulation/market/guides/watchdog unit suite (79 tests, no network needed).

Design notes:

- **All analysis is pure functions** over a single `LeagueBundle` — easy to unit test
  and easy to extend without touching data loading.
- **Projections**: weekly rows from `api.sleeper.com/projections` (semi-official,
  what Sleeper's own clients use) scored with *your* league's scoring settings;
  falls back to last-season per-game averages when unavailable (e.g. offseason).
- **Offseason-aware**: no fake matchups in July; waiver/trade/dynasty tools stay live.
- The dynasty value model is a **transparent heuristic** (production, age, market
  interest) — rankings are explainable, not a black-box market price.

## Roadmap (next session)

- [x] Real dynasty market values (KeepTradeCut/FantasyCalc import) alongside the heuristic
- [x] Multi-week schedule outlook + playoff odds simulation (Monte Carlo)
- [x] Draft tab: guide aggregation into a consensus board + Sleeper draft-room sync
- [ ] **Live-draft auto-polling** — hands-free pick sync while a draft is in progress
      (poll `draft/<id>/picks` on an interval while status is `drafting`, pause when idle)
- [ ] **On-the-clock pick recommendations** — when it's your pick, surface the top 3
      options, each with its reasons ("consensus #4, falls 6 spots past ADP, fills your
      thinnest position, market agrees at 5,2k") from consensus rank + guide disagreement
      + roster needs + market/heuristic value
- [ ] Waiver FAAB bid optimizer using league bid history
- [ ] Trade finder for 2-for-1 / pick-included packages
- [ ] News feed / injury push alerts
- [ ] League history (previous_league_id chain) for all-time records
