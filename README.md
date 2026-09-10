# Charonsol

Merges [Kaiser.Charon](.)'s Solana token screening with [meridiancx](.)'s Meteora DLMM
pool screening into one pipeline: a token has to pass charon's token-level filters
**and** have a Meteora/SOL pool that passes meridian-style pool scoring before it's
recorded as an LP candidate.

**Phase 1 scope (this build): dry-run screening only.** Nothing here places an order,
opens a position, or touches a wallet. It just watches charon's signal sources, screens
tokens, screens pools for the survivors, and writes everything to SQLite — same DB
persistence philosophy as charon itself.

## How it works

```
signal sources (pumpportal / pregrad / trending / trenches / fee-claim / graduated)
        │
        ▼
charon token filters (candidateBuilder.js, preScorer.js, momentumFilter.js)
        │  passed → written to `candidates` table (same schema as charon)
        ▼
Meteora DLMM pool discovery for the mint (src/pool/poolDiscovery.js)
        │
        ▼
meridian-style pool scoring: fee/active-TVL ratio, volume, TVL bounds, Degen Score
(src/pool/screening.js, src/pool/screeningScales.js)
        │
        ▼
merged result written to `lp_candidates` table (src/db/lpCandidates.js)
```

A token that has no Meteora/SOL pool, or whose best pool fails the thresholds, still
gets a row in `lp_candidates` (status `no_pool_found` or `pool_rejected`) — nothing is
silently dropped, so you can go back and see the full universe of what showed up, same
as charon's own "log everything, drop nothing" philosophy.

## Overlapping-cycle guard

Ported from a sibling project (charonhood), found via real production log analysis
there: a `setInterval` poller has no idea whether its own previous invocation finished —
it just fires on a fixed schedule. If a cycle's real work (network calls, especially
under rate-limit backoff — confirmed directly in this project's own logs, GMGN backoffs
stretching well past a minute) ever takes longer than its own poll interval, the next
tick starts a second, fully concurrent run competing for the exact same rate-limited
queues its predecessor is still waiting on — actively worsening the timeout it was
already having, not just wasting a tick.

`guardCycle(label, fn)` (`src/utils.js`) wraps a poller so an overlapping tick is skipped
(logged, not silently dropped) instead of running concurrently. Applied to every
network-heavy poller in `app.js`: server-mode signals, trenches (both modes), dip-alert
monitoring, graduation polling, trending, the meridian token source, and the LP-sim
monitor — the last of those is the most exposed cycle in this project for exactly this
problem, since it makes one Meteora call *per open position*, sequentially, and a real
log showed 600+ open positions at once. Verified directly: a simulated 500ms cycle fired
every 100ms for 2 seconds correctly completed only 3 runs (never more than 1 concurrent
execution), and the guard correctly resets even after a thrown error rather than
permanently wedging that cycle.

## Backtest — which filter/param actually correlates with a better outcome

Once you have enough closed `lp_sim_positions` (same bar charon's own backtest scripts
use — under 10 closed positions and it refuses to run, telling you to let the bot run
longer instead), `scripts/backtest.js` sweeps a set of candidate thresholds against
**realized** outcomes and ranks them by improvement over the full-population baseline —
ported from charon's own `scripts/general_filter_backtest.py` methodology.

```bash
npm run backtest                                 # all-time
npm run backtest -- --days 7                     # last 7 days
npm run backtest -- --since 2026-08-20
npm run backtest -- --combo-size 3               # N-way AND/OR combos instead of the default 2
npm run backtest -- --sort-by n                  # rank by raw N instead of ΔYield% (default)
npm run backtest -- --top 10                     # show 10 rows per table instead of the default 30 (singles) / 20 (combos)
npm run backtest -- --sort-by tvl_drained_delta,yield_delta   # multi-key: tie-break on yield if two filters have the same drain rate
npm run backtest -- --min-n 20                   # combo tables only: hide any combo with fewer than 20 matching positions
npm run backtest -- --combo-op AND               # combo tables only: AND-combos only (or OR, or the default BOTH)
```

`--sort-by` accepts a comma-separated list for multi-key sorting, same semantics as
SQL's `ORDER BY col1, col2`: the second key only breaks an exact tie on the first, it
never overrides it. Each key keeps its own direction (only `tvl_drained_delta` sorts
ascending) regardless of where it sits in the list.

`--min-n` applies to the **combo tables only** (single-filter tables aren't affected —
those are usually large enough on their own that a min-N cutoff matters less, and hiding
one there by default would make "why did this filter disappear" a confusing failure
mode). A combo with a tiny N can show a dramatic-looking ΔYield% that's really just noise
from a small sample — exactly the trap that burned an earlier real recommendation in this
project (a filter that looked like the best pick at N=4 turned out negative at N=208 once
more data came in). Filtered combos are excluded entirely, not just hidden from the
printed table — a noisy small-N combo also can't become the featured "top combo" for the
`filter_compound_groups`/`pool_compound_groups` translator or the `SIDE-BY-SIDE` section.

`--combo-op` (ported from a sibling project, charonhood, which built this before
Charonsol had it) restricts the combo tables to one operator — `AND` (stricter, fewer
positions kept — the kind most directly expressible as a single `filter_compound_groups`/
`pool_compound_groups` branch), `OR` (looser, more kept), or the default `BOTH`.
Restricted at generation time, not just hidden at print time — an `AND`-only run
genuinely evaluates half as many combos, confirmed directly (186 combos at `BOTH` vs. 93
at `AND`-only, same combo-size).

`--sort-by` options: `yield_delta` (default), `yield` (raw avgYield%), `nonzero`
(fraction that earned any fee), `tvl_drained_delta` (ascending — a filter that *reduces*
this ranks first, same "lower is better" treatment charon's own `sl_delta` sort gets),
`n` (raw count), `pct_keep` (% of baseline retained — surfaces broadly applicable
filters over narrow ones), `yield_tvl_ratio` (see below).

Every table also shows a **`yield/tvlDrn`** column — `avgYield%` divided by
`tvlDrained%`, a risk-adjusted efficiency figure: how much yield a filter produced per
percentage point of tvl-drain risk it carried, not just how much yield it produced in
total. A filter with high raw yield but a high tvl_drained rate might just be earning
well right up until it frequently gets rugged; this column separates that from a filter
earning the same yield with a much lower drain rate. `∞` means 0% tvl_drained with
positive yield — the best possible risk profile, sorts to the top of a descending sort
rather than showing a misleadingly precise huge number.

This is a genuinely different tool from `filter-report`: that one counts *rejections*
(no outcome data needed, useful from minute one); this one correlates thresholds against
*what actually happened* to positions that made it through (needs real closed-position
history to say anything at all).

Results print as three separately-ranked groups, same split `filter-report` already
uses — a merged single table would rank pool and token signals against each other, which
doesn't map to any one action you'd take, since they're adjusted through different
commands:

- **POOL-LEVEL** — `degen_score`, `fee_active_tvl_ratio`, `active_tvl`, `pools_found`,
  `bin_step`, all Charonsol-specific — adjust via `npm run setting -- pool_*`.
- **TOKEN-LEVEL** — market cap, liquidity, holders, bonding curve, organic score, same
  fields charon's own backtest sweeps (`candidate_json` is the same shape charon
  produces) — adjust via `npm run stratset -- sniper *` for strategy-config fields, or
  `npm run setting` for the settings-table ones (see `filter-report`'s section on which
  is which).
- **BY SOURCE** — not a threshold to tune, but which signal sources are worth screening
  at all; the lever there is a whole source's `*_ENABLED` flag, not a per-candidate value.

### Top combo suggestions

Below the three single-filter tables, `backtest.js` also generates **N-way AND/OR
combos** (default 2, `--combo-size` to change) — ported from charon's own combo
generator: only filters from *different* categories within POOL or TOKEN are ever
combined (two filters testing the same underlying signal, like `mcap<20K` AND
`mcap<100K`, are either redundant or contradictory, never a useful combo), and both
directions get tested — AND (stricter, fewer positions kept) and OR (looser, more kept).
The exact combo count is printed before the (much more expensive) evaluation loop runs,
since it grows roughly `^comboSize`.

A **SIDE-BY-SIDE** section follows each combo table, comparing the single best filter
against the single best combo on whatever `--sort-by` metric you asked for — sometimes a
combo genuinely beats every individual filter tested, sometimes the strongest single
signal alone still wins and combining just diluted it. Both outcomes are worth knowing
before assuming a combo is automatically better.

**Deploying a combo is different for each group.** A TOKEN-LEVEL AND-combo is directly
deployable via `filter_compound_groups` (see below) — the report even prints a
best-effort translated command to paste. A POOL-LEVEL AND-combo needs no special
mechanism at all: pool screening already ANDs every `pool_*` threshold together, so
setting several of them tight simultaneously already *is* an AND-combo. There's no
pool-side equivalent of `filter_compound_groups` for an OR-combo (e.g. "either high fee
ratio OR high volume") — that would need new code, not built here.

## Deploying a backtest combo as a real filter — `filter_compound_groups`

`backtest.js`'s TOKEN-LEVEL combos (`liq>=5K + holders>=50 + maxHolder<20%`) or
POOL-LEVEL combos are correlations, not filters — finding one that looks good doesn't by
itself make it enforced. `filter_compound_groups` is how you actually deploy one: an
OR-of-AND expression that gives a candidate an alternate path through.

**Rescue-only semantics (Charonsol's own design, corrected 2026-09-07) — this is not
what charon's own code does, on purpose.** It only ever matters for a candidate that
already failed ≥1 of the 8 known keys below — satisfying a branch forgives those specific
failures, exactly like `filter_or_groups`. A candidate with zero known-key failures is
completely unaffected, regardless of whether it satisfies any branch: there's nothing to
rescue it from, so the branches aren't even evaluated for it. Charon's own 2026-09-03
revision makes this mandatory instead — every candidate must satisfy a branch or gets
rejected outright, even ones with nothing to forgive in the first place. That version was
ported faithfully at first, then corrected once real data showed the cost: one hour of
real screening had 459 of 674 candidates rejected specifically by "compound group
required but not satisfied," the overwhelming majority of which had none of the 8 known
failures to begin with — the mandatory version was acting as an unintended extra gate on
top of everything else, not the rescue mechanism it was meant to be.

```bash
npm run setting -- filter_compound_groups "bondingCurve>=40,top20<=40|liq>=10000,mcap<=40000"
# route-scoped instead of global:
npm run setting -- "filter_compound_groups:pumpportal_graduated" "bondingCurve>=40,top20<=40"
```

Syntax: `alias>=N` or `alias<=N` conditions, comma-separated within a branch (AND), pipe-
separated between branches (OR). Known aliases — **deliberately a separate set from the
existing hard-filter fields**, matching `backtest.js`'s own field sources exactly rather
than whatever a similarly-named filter happens to read (e.g. `ho` reads
`candidate.holders.count`, but the existing `min_holders` filter reads
`candidate.metrics.holderCount` — a different enrichment source; `top20` reads
`candidate.holders.top20Percent`, sum of the top 20 holders, but `max_top20_holder_percent`
reads `candidate.holders.maxHolderPercent`, the single biggest holder — a different
signal despite the similar name). Reusing the existing fields here would silently test
different data than whatever a backtest combo actually measured:

| Alias | Reads |
|---|---|
| `mcap` | `metrics.marketCapUsd` |
| `gmgnFees` | `metrics.gmgnTotalFeesSol` |
| `ho` | `holders.count` |
| `top20` | `holders.top20Percent` |
| `maxHolder` | `holders.maxHolderPercent` |
| `liq` | `metrics.liquidityUsd` |
| `bondingCurve` | `jupiterAsset.bondingCurve` |
| `organic` | `jupiterAsset.organicScore` |

## Deploying a POOL-LEVEL backtest combo — `pool_compound_groups`

`filter_compound_groups` above only ever sees token-side `candidate_json` — it runs
inside `candidateBuilder.js`, entirely before pool screening happens, so it structurally
cannot express a condition on `active_tvl`, `bin_step`, `volume_window`, `pools_found`,
or `fee_active_tvl_ratio` (none of those exist yet at that point in the pipeline). A
POOL-LEVEL OR-of-AND combo needs its own mechanism — `pool_compound_groups`, evaluated in
`lpOrchestrator.js`'s `screenPoolsForCandidate()` once those fields actually exist.

Same expression language, same rescue-only shape (only matters for a pool-side reason
already present — see `filter_compound_groups` above for why), same route-scoping
precedence as `filter_compound_groups` — just a different alias set and a different
setting key:

```bash
npm run setting -- pool_compound_groups "activeTvl>=10000,activeTvl<=49999,binStep>=91,volumeWindow>=100000|binStep>=91,feeRatio>=1.0,volumeWindow>=100000"
# route-scoped instead of global:
npm run setting -- "pool_compound_groups:meridian_gmgn_rank" "degenScore>=50,feeRatio>=0.5"
```

| Alias | Reads |
|---|---|
| `activeTvl` | the winning pool's active TVL |
| `binStep` | the winning pool's bin step |
| `volumeWindow` | the winning pool's volume over the screening timeframe |
| `poolsFound` | how many Meteora pools the mint has |
| `feeRatio` | `fee_active_tvl_ratio` over the screening timeframe |
| `degenScore` | the winning pool's Degen Score |

A plain `pool_* ` setting (`pool_min_tvl`, `pool_min_fee_active_tvl_ratio`, etc.) already
handles a single AND-combo fine, since pool screening ANDs every one of those thresholds
together — `pool_compound_groups` is specifically for an **OR** between branches (e.g.
"either a tight-TVL pool with a high bin step, or a wide-TVL pool with multiple pools
found"), which a handful of separate flat settings can't express at all. `backtest.js`'s
own POOL-LEVEL combo output prints a best-effort translated `pool_compound_groups`
command for its top combo, same as `filter_compound_groups`'s translator — same caveat
too: a strict `>`/`<` in the original combo becomes an off-by-one `>=`/`<=`, since the
expression language only supports inclusive comparisons.

When a candidate satisfies a branch, it also forgives any already-recorded failure on
one of 8 known hard-filter keys (`min_dex_liquidity_usd`, `min_holders`,
`max_top20_holder_percent`, `min_bonding_curve_progress`, `min_organic_score`,
`min_mcap_usd`, `max_mcap_usd`, `min_gmgn_total_fee_sol`) — same forgiveness mechanism
`filter_or_groups` uses, just reachable via a genuine AND-within-OR condition instead of
a flat "any one of these passing" list. Malformed conditions or unknown aliases log a
warning and get skipped rather than crashing candidate screening — a bad setting value
degrades to "no effect," never breaks the pipeline. Unset (empty string, the default) has
zero effect on anything.

Each group is ranked independently, so the top pick in POOL isn't competing against the
top pick in TOKEN for a spot in the list.

Same fee-yield-only framing as everywhere else in Phase 2 — "avgAPY%" is realized yield
extrapolated to an annual rate (only computed for positions held ≥1h; shorter holds are
excluded from that specific average since extrapolating a few minutes to a year produces
a meaningless number — you'll see this if you ever get an "n/a" there), never a forward
guarantee, and there's no PnL/win-rate in the charon sense since impermanent loss isn't
modeled. If `bypass_hard_filters_dryrun_only` was on while this data was collected, the
tool tells you so up front — that's not necessarily bad (it removes the selection bias
of only ever seeing survivors of your current filters), but it does mean the dataset
includes weaker candidates than a fully-filtered run would ever send to pool screening.

## Pausing screening without stopping the bot

`screening_enabled` (default `true`, a setting — `npm run setting -- screening_enabled false`)
is a genuine kill switch for **new candidates only**, ported from charon. Checked at the
very top of `processCandidateFromSignals()` — the one choke point every signal source
funnels through — before any work happens: no DB write, no enrichment call, nothing.
`monitorOpenSimPositions()` (the separate loop that applies `tvl_drained`/`max_hold`/
`fee_stall`) is completely untouched, so anything already open keeps being tracked and
closed normally. Useful for pausing new screening while you inspect a backtest or reset
the DB, without losing visibility into positions already in flight. Turn it back on with
`npm run setting -- screening_enabled true`.

`prescore_enabled` (default `true`, also ported from charon — `npm run setting --
prescore_enabled false`) is narrower: it skips only the soft-score `preScoreCandidate()`
gate, not the whole pipeline. A candidate that already passed the hard filters (and any
`filter_compound_groups`) goes straight to the pre-pool-screening filter re-check instead
of being scored on smart-degen/organic-score/etc. Different from `bypassActive` (this
project's own extension, not charon's): that one only fires when a candidate already
*failed* prescore and `bypass_hard_filters_dryrun_only` is on, letting it through anyway
for data capture; `prescore_enabled=false` skips running the check at all, unconditionally,
with no dependency on the bypass flag. Both can be on at once with no conflict.

## Testing with all filters open

`bypass_hard_filters_dryrun_only` (a setting, same as charon's own — `npm run setting --
bypass_hard_filters_dryrun_only true`) lets every candidate flow all the way to pool
screening regardless of what would normally reject it, so you can see what a broader
population of tokens actually does instead of only ever observing survivors of the
current filter set. Only takes effect while `trading_mode` is `dry_run` (always true in
this project — there's no live mode to accidentally affect).

In charon, this flag only covers the hard-reject filters in `filterCandidate()`.
Charonsol layers two more gates on top that charon's own flag has no knowledge of —
`preScoreCandidate`'s soft-score threshold and the momentum ML filter — so the flag is
extended here (in `lpOrchestrator.js`) to bypass those too, matching its own stated
intent of "let everything through for data capture." A bypassed candidate still gets its
real score logged (`bypassed (data capture) ... score 20/35`) so you can see what it
would have failed, same distinction charon's own bypass logging makes.

Turn it back off (`npm run setting -- bypass_hard_filters_dryrun_only false`) once you've
seen what you needed — leaving it on means `lp_candidates`/`lp_sim_positions` fill with
low-quality tokens that would normally never reach pool screening at all.

## Scheduling and thresholds

Same two-layer config as charon: an env var (`.env`, `config.js`) sets the deploy-time
default, and most actual poll intervals and thresholds are read live from the `settings`
table on every call (`numSetting`/`setting`/`boolSetting`) — so they're tunable while the
bot is running, without a restart, by updating a row in `settings`. Editing `.env` only
changes what a *fresh* database seeds as the fallback; it does nothing to an existing
`charonsol.sqlite` that already has a value for that key.

This applies to everything Charonsol added, same as charon's own `trenches_poll_ms` /
`trending_min_volume_usd` pattern:

- Pool-screening thresholds (`pool_screening_timeframe`, `pool_min_tvl`, `pool_max_tvl`,
  `pool_min_fee_active_tvl_ratio`, `pool_min_volume`, `pool_min_degen_score`,
  `pool_discovery_limit`) — read in `src/pipeline/lpOrchestrator.js`. Also
  `pool_min_pools_found` (default 1/off; backtest-supported at 2 — see git history /
  config.js comment for the finding).
- Meridian token source poll interval and rank-fetch params (`meridian_tokens_poll_ms`,
  `meridian_tokens_interval`, `meridian_tokens_limit`, `meridian_tokens_order_by`) and its
  sanity-filter thresholds (`meridian_tokens_min_volume_usd`, `..._min_liquidity_usd`,
  `..._min_holders`, `..._min_mcap_usd`, `..._max_mcap_usd`, `..._max_rug_ratio`,
  `..._max_bundler_rate`, `..._max_top10_rate`) — read in `src/signals/meridianTokens.js`.
- Meteora queue pacing (`meteora_request_delay_ms`, `meteora_max_retries`) — read in
  `src/enrichment/meteora.js`.
- Fee-claim WebSocket reconnect backoff (`ws_reconnect_base_ms`, `ws_reconnect_max_ms`) —
  read in `src/signals/feeClaim.js`. A connection must stay open ≥10s to count as
  recovered and reset the backoff; one that opens and closes quickly keeps escalating.

The one exception, matching charon's own inconsistency here: a couple of knobs
(`MERIDIAN_TOKENS_ENABLED`, `MERIDIAN_TOKENS_POOL_CHECK_LIMIT`) are env-only, read once at
process startup — same as charon's `TRENDING_POLL_MS`. Anything gating whether an entire
source runs at all, or a hard ceiling on API call volume per cycle, is deliberately
env-only so it can't be changed mid-run without a deploy.

There's no settings-editing UI in this phase-1 build, but the CLI covers it — same
pattern as charon's own `npm run setting`:

```bash
npm run setting                              # list everything currently stored
npm run setting -- pool_max_tvl              # show one key
npm run setting -- pool_max_tvl 200000       # set it
npm run unset -- pool_max_tvl                # remove the override, back to its .env default
```

## Queued API calls

Every outbound API call in this project — charon's original Jupiter/GMGN calls and
everything added for Charonsol — goes through a per-provider priority queue
(`src/enrichment/priorityQueue.js`), never a raw `fetch()`/`axios` call directly against
an external API. One queue instance per provider (never shared/mixed across providers),
with pacing, shared backoff on 429/403, and exponential retry — see
`src/enrichment/gmgn.js` or `src/enrichment/jupiter.js` for the original pattern this
follows.

`src/enrichment/meteora.js` is Charonsol's queue for Meteora's API — `src/pool/*.js`
routes every Meteora call through it. **Any new provider added to this project needs its
own queue module shaped the same way** (dedicated `createPriorityQueue` instance, own
backoff state, own `getXQueueStats()` wired into `app.js`'s `queue_stats` snapshot) —
never reuse another provider's queue or call `fetch()` unqueued.

## What's reused vs. new

**Reused unchanged from charonkaiserx** (`src/signals/`, `src/enrichment/`,
`src/pipeline/candidateBuilder.js`, `preScorer.js`, `momentumFilter.js`, `src/db/`
except `lpCandidates.js`, `src/utils.js`, `src/format.js`): all of charon's token-side
logic, filters, and settings — nothing here was modified.

**Reused (ported, not copied) from meridiancx**: `src/pool/poolDiscovery.js`
(`fetchTopMeteoraDlmmPoolsForMint` / `fetchPoolDetailDirect` / `pickBestPool` from
`tools/gmgn.js`), `src/pool/screening.js` (`scoreCandidate` / `degenScore` from
`tools/screening.js`), `src/pool/screeningScales.js` (copied verbatim — no deps).
meridian's blacklists, dev-block, chart-indicator confirmation, and LP-trade decision
logic were left behind — those are meridian's own trade-management layer, not part of
screening.

**New**: `src/pipeline/lpOrchestrator.js` (the merge point), `src/db/lpCandidates.js`
(schema + helpers for the merged table), `src/app.js` / `index.js` (trimmed entrypoint,
no telegram/execution/LLM/dashboard), `scripts/cli.js`.

## Setup

```bash
npm install
cp .env.example .env
# fill in at minimum: HELIUS_API_KEY, GMGN_API_KEY
npm run check   # syntax check
npm start
```

The SQLite DB (`DB_PATH`, default `./charonsol.sqlite`) is created automatically on
first run, same as charon.

### Signal sources

Runs the same sources charon does, all on by default except where noted:

- **Trenches** (GMGN) — always on, no key needed.
- **Graduation polling** — always on.
- **Trending** (Jupiter/GMGN) — always on.
- **Fee-claim** — always on (WebSocket, needs `SOLANA_WS_URL`/`HELIUS_API_KEY`).
- **PumpPortal** (real-time graduated + pre-grad feed) — needs `PUMPPORTAL_API_KEY`,
  set `PUMPPORTAL_ENABLED=false` to skip.
- **Pre-graduation scanner** — on by default, `PREGRAD_ENABLED=false` to skip.
- **Meridian token source** (`src/signals/meridianTokens.js`, new — not in charon) — on by
  default, `MERIDIAN_TOKENS_ENABLED=false` to skip. See below.
- **Fee-graduated / smart-money routes** — only available via charon's private
  `SIGNAL_SERVER_URL`/`SIGNAL_SERVER_KEY` (contact the charon maintainer for access);
  leave blank to run in trenches-only mode. Note: `src/signals/smartMoney.js` exists as
  a standalone module but isn't wired into `app.js` — it wasn't wired into charon's own
  `app.js` either; "smart money" candidates only flow through the signal-server path in
  both projects.

#### Meridian token source

Every other charon source — `trenches.js`, `trending.js`'s GMGN branch, and dead-code
`gmgnSignal.js` — hard-filters to mints ending in `pump` (pump.fun tokens only). That's a
real gap for LP screening specifically: pump.fun graduates land on PumpSwap/Raydium far
more often than Meteora, so a pump.fun-only universe rarely produces a token that actually
has a Meteora pool (confirmed by a real run — see the log in this project's history: 3
tokens passed charon's filter, 0 had a Meteora pool).

`src/signals/meridianTokens.js` fixes this by querying GMGN's broad `/v1/market/rank`
endpoint with **no** pump-suffix restriction (any Solana token, any platform) — the same
endpoint meridian's own `tools/gmgn.js discoverGmgnPools()` uses to find tokens in the
first place — then, crucially, confirms a **real Meteora/SOL pool already exists** for a
token (via `src/pool/poolDiscovery.js`) before ever forwarding it as a candidate. A token
from this source still goes through charon's full token-level filter same as every other
source; it's just guaranteed to have somewhere to actually screen a pool for if it passes.

Tunable via `MERIDIAN_TOKENS_*` in `.env.example`, plus `meridian_tokens_*` settings in
the DB (`min_volume_usd`, `min_liquidity_usd`, `min_holders`, `min_mcap_usd`,
`max_mcap_usd`, `max_rug_ratio`, `max_bundler_rate`, `max_top10_rate`) — a separate
namespace from `trending_*`, since this source's job (find real Meteora liquidity) is
different enough from trending's (find fresh pump.fun momentum) to warrant independent
tuning. `MERIDIAN_TOKENS_POOL_CHECK_LIMIT` bounds how many Meteora pool-existence checks
run per poll cycle, to keep Meteora API usage reasonable.


### Pool screening thresholds

All in `.env.example`, `POOL_*` — timeframe-scaled minimums for fee/active-TVL ratio and
volume come from `src/pool/screeningScales.js` (same table meridian uses); `POOL_MIN_TVL`
/ `POOL_MAX_TVL` / `POOL_MIN_DEGEN_SCORE` are flat floors. Tune these once you've seen a
few days of real `lp_candidates` data — the defaults are meridian's own defaults, not
tuned for charon's token universe specifically.

## Inspecting results

```bash
npm run stats                    # funnel counts: seen → token-passed → pool-passed
npm run lp-candidates             # last 20 lp_candidates rows
npm run lp-candidates -- 50 --passed   # only ones that passed pool screening
npm run queue-status              # Jupiter/GMGN/Meteora queue health (needs the bot running/ran recently)
npm run dbsize                    # DB file size + row counts per table
npm run events                    # tail logs/events.jsonl, if anything's logged to it
npm run prune                     # delete telemetry rows past their retention window
npm run vacuum                    # reclaim disk space after a prune
```

Or query `lp_candidates` / `candidates` directly — `candidate_id` on `lp_candidates`
joins back to `candidates.id` for the full token-side data (`candidate_json`,
`filter_result_json`).

Run `node scripts/cli.js help` (or `npm run cli -- help`) for the full command list —
same dispatcher shape as charon's own `scripts/cli.js`, just with only the commands that
apply to a screening-only project (charon's position/execution/strategy/LLM-learning
commands — `positions`, `sl`, `strategy`, `stratset`, `wallets`, `pnl`, `learn`, `mode`,
etc. — aren't ported since none of that exists here).

## Phase 2 — dry-run LP fee-yield simulation

When a `lp_candidates` row passes pool screening, Charonsol now opens a **simulated**
position (`lp_sim_positions` table) at a fixed notional (`lp_sim_notional_usd`, default
$100) and periodically re-checks it (`src/pipeline/lpSimulator.js`). No wallet, no RPC,
no on-chain reads — this is a pure estimation layer on top of the same public
pool-discovery-api data phase 1 already uses.

**One open position per mint at a time.** A mint can have several real Meteora pools
(`pools_found > 1` isn't rare) — `pool/screening.js`'s `pickBestPool()` already picks the
single best one per screening pass, so a second pool for the same mint isn't a second
thing worth tracking, it's the same asset. `screenPoolsForCandidate()` checks
`hasOpenSimPositionForMint()` before spending any Meteora API call, and `openSimPosition()`
checks it again before writing a row — belt and suspenders against the same race class
`recentCandidate`'s 10-minute dedup window already has (see `lpOrchestrator.js`'s
comment on that check). Added 2026-09-05 after real log evidence: a token got re-detected
as a "new" candidate 11 times in ~3 hours (re-poll intervals of 10.5–29.8 min, every one
just past the 10-minute window), opening 11 fully-independent positions for the same
underlying asset; when its pool actually drained, 5 still-open ones closed within 19
seconds of each other — 5 correlated re-observations of one real event, not 5 independent
trials, which would have quietly inflated `backtest.js`'s apparent sample size.

**The model:** `fee_active_tvl_ratio` (fees earned by the pool over the timeframe window
÷ active TVL) is a real number Meteora itself reports — meridian's own `definitions.js`
describes the equivalent metric as *"the current APY of the pool."* Each monitoring pass
converts that windowed percentage into a per-millisecond rate and accrues
`notional_usd × rate × elapsed_ms` since the last snapshot, so accrual always reflects
current pool conditions, not a value frozen at entry.

**The caveat — read this before trusting a number out of it:** this estimates **fee
income only**. There is no token-price data anywhere in this project, so impermanent
loss isn't modeled, and "in range" is approximated from pool health (`active_tvl` /
`fee_active_tvl_ratio` staying above a floor) rather than real bin-level price tracking,
which needs the actual DLMM SDK + RPC (see the on-chain-accurate alternative discussed
when this phase was scoped — not built here). Every number this produces is a fee-yield
estimate, never full LP PnL.

**Exit rules** (checked every monitoring pass, in order): `tvl_drained` (active TVL falls
below `lp_sim_min_active_tvl`) → `max_hold` (`lp_sim_max_hold_ms`, default 24h) →
`fee_stall`. All are live-tunable settings, same pattern as everything else in this project.

`fee_stall` is ported directly from meridian's own `fee-stall-guard.js`, not a rough
approximation: it tracks **time since lifetime fees last genuinely increased**
(`lp_sim_fee_stall_threshold_hours`, default 6h — same default meridian uses), not a
trailing average or a count of low readings. The reason, straight from meridian's own
header comment: a position that earned well for its first few hours and has generated
exactly $0 since can still look "fine" on an average — this catches that case well before
an average ever would, because the clock only resets on an actual observed fee increase,
never just the passage of time. `lp_sim_fee_stall_min_age_minutes` (default 60, also
meridian's own default) skips the check entirely until a position's had a fair chance to
earn anything at all.

```bash
npm run lp-sim                    # recent lp_sim_positions rows
npm run lp-sim -- --open          # only still-open positions
npm run lp-sim-report             # aggregate report: avg yield, close-reason breakdown, avg annualized yield
```

## Known limits of this phase-1 build

- No execution — this only decides "would this be an LP candidate," it doesn't deploy
  one. That's the natural next phase once the screening thresholds have been validated
  against real data.
- No telegram/dashboard — `src/telegram/send.js` is a no-op stub so the two signal
  files that still call it (`pumpportal.js`, `pumpfunPregrad.js`, for outage alerts)
  don't need forking. Swap it for a real notifier later if useful.
- Pool scoring targets (`targetVolRatio`/`targetLpCount`/`targetFeeRatio`/
  `targetLiquidity` in `degenScore`) are meridian's un-tuned defaults.
