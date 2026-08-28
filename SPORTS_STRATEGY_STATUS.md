# Polymarket US Sports Strategy — Session State

**Read this first if you are a fresh Claude Code session with zero prior context.** This file is meant to be self-contained. Directory: `/Users/anirudhiyengar/polymarket-flb-research/`.

---

## How we got here

This research effort grew out of a **separate, prior project**: `polybot-v2` (a different directory, `/Users/anirudhiyengar/polybot-v2/`), a weather-temperature-market trading bot running live on a GCP VM (`polybot-vm`). That bot traded daily-high-temperature markets on Polymarket US across 5 cities (MIA/SFO/NYC/MDW/LAX) using a calibrated meteorological forecast (EMOS/AnEn blend) as its edge.

**The weather bot was shut down as a strategy** after accumulating 30 paper trades at a 6.7% win rate, with performance worsening at every subsequent check-in rather than improving. Along the way, several real infrastructure bugs were found and fixed (P&L reporting dedup, a trade re-entry race condition, a Node.js 24 / better-sqlite3 crash, missing stop-loss and bid-ask spread filters) — but fixing the bugs didn't fix the core problem: **the forecasting edge itself never materialized**. The bot is still running, untouched, in paper mode on its own VM, and will keep running until it reaches 100 total paper trades for a final, statistically firmer read. This sports-research effort is intentionally kept separate from it — do not touch the weather bot or its VM as part of this work.

Losing confidence in the weather angle prompted a pivot: research the academic "favorite-longshot bias" (Campbell & Diebold 2005, among others — the tendency for longshots to be overpriced and favorites underpriced in betting markets) as a *different*, non-weather trading idea on the same underlying platform (Polymarket US).

---

## The critical lesson learned (read this before proposing any new strategy)

**Almost every promising strategy idea sourced from general "Polymarket" research turned out to be about global Polymarket (the open, permissionless DeFi platform at polymarket.com) — not Polymarket US (`polymarket.us`), which is a separate, KYC'd, CFTC-regulated exchange with its own catalog, its own liquidity, and no shared order book with the global platform.**

This mistake killed three candidate strategies in a row before this sports work started:
1. **Crypto markets** — plentiful and well-studied on global Polymarket; essentially don't exist on Polymarket US (confirmed: 6 total crypto events, all still open, zero ever resolved — dead for backtesting).
2. **On-chain wallet tracking** (copy-trading smart money, etc.) — a whole genre of global-Polymarket tooling exists for this because it's a public blockchain ledger. **Polymarket US is not on a public chain in the same way** — this category of strategy is structurally impossible to port over, not just harder.
3. **Market-making** — independently investigated and found unprofitable even for the leading open-source attempt at it (on global Polymarket, let alone US).

**Standing rule going forward: any new strategy idea must be verified against Polymarket US specifically (its actual catalog, actual liquidity, actual data-access surface) before spending research time on it.** Don't trust general Polymarket literature, GitHub bots, or wallet-analytics tools at face value — check whether the underlying mechanism (a market existing, a data feed being public, a technique being platform-agnostic) actually applies to Polymarket US.

---

## Current category map (full detail: `CATEGORY_REFERENCE.md` in this directory)

Built from a full crawl of `gateway.polymarket.us/v1/events` (73,540 total events as of 2026-08-26, spanning 2025-10-30 to 2026-08-25/beyond, all categories, adaptively paginated — the endpoint is unreliable at large offsets/page sizes, see `censusUS_full.js` / `parallelCrawl.js` for the retry logic that was needed).

| category | resolved (past, closed) | verdict |
|---|---|---|
| **sports** | 69,543 | **Only category with real backtestable depth.** This is where all current research effort is focused. |
| climate (weather) | 571 | Real resolved-outcome sample (back to 2026-04-23, not ~Aug 13 as an earlier assumption held), but **not mirrored on Gamma at all** (confirmed zero match) and no confirmed historical price-time-series source — an outcome-based backtest is possible, a price-mispricing backtest currently is not. |
| politics | 50 | Too thin now; almost all real volume (marquee midterm races) is still open, resolving **November 2026**. Revisit after that. |
| culture | 75 | Thin, fragmented across award shows. Not worth research time. |
| macro | 16 | Too thin. |
| technology / finance | 3 / 1 | Negligible, brand-new categories. |
| crypto / geopolitics / science | 0 / 0 / 0 | Confirmed dead — zero resolved events, ever. |

---

## The live finding

**A liquidity-filtered, walk-forward-validated favorite-longshot-style mispricing exists in sports moneyline/spread/total markets — but only very close to game time.**

### Why liquidity filtering is non-negotiable (the CBB cautionary tale)

The first version of this finding was run on college basketball (CBB) alone: a 30-40¢ moneyline price, checked 3 days before game resolution, showed a large (-19.5pp train / -11.7pp test), walk-forward-consistent bias. It looked like a real, tradable edge. **It wasn't.** A follow-up liquidity check (pulling real trade history via `data-api.polymarket.com/trades` for a sample of the actual backtested trades) found that **24/25 sampled trades had zero real trading volume within ±3 hours of that "3-days-out" price point** — the price series was a stale/placeholder quote (literally flat at exactly 0.500 for days), not a real, fillable market belief. The entire "signal" was a stale-quote artifact.

This forced a methodology change: **liquidity filtering must be built into data collection from the start, not checked afterward.** The standard used: for any price checkpoint, require at least $50 of real trade notional within ±3 hours of that checkpoint's timestamp, or discard the checkpoint entirely (don't use it, don't flag-and-keep-it).

### What survived after rebuilding with liquidity filtering from the ground up

Re-running across the full current catalog (NFL/NBA/NHL/CFB/CBB, ~9,274 events, 22,693 submarket records fetched — see `fetchLiquidityFiltered.js` / `usSportsLiquidityFiltered.json`):

- **Checkpoint survival rates confirm the CBB lesson generalizes**: 7-days-out checkpoints are 98.8% filtered out (illiquid), 3-days-out 97.9%, 1-day-out 81.4%, 3-hours-out only 20.1%. **Real, fillable pricing on Polymarket US sports essentially does not exist more than ~1 day before a game**, across every sport checked, not just CBB.
- **Re-tested CBB, liquidity-filtered this time: the original signal is gone.** Every CBB bucket now shows near-zero bias (<2pp) with large n (hundreds to low-thousands per bucket). This *confirms* the original CBB finding was 100% a stale-quote artifact, not a real effect that liquidity filtering merely weakened.
- **Four buckets survive** (n≥30 in both a chronological train half and test half, same sign, >5pp magnitude both sides), all in the 3-hour or 1-day horizon:

| sport / type | horizon | band | train bias (n) | test bias (n) |
|---|---|---|---|---|
| NBA moneyline | 3h | ≤0.30 | -7.4pp (51) | -14.3pp (69) |
| NHL moneyline | 1d | ≥0.40 | +9.1pp (106) | +10.2pp (101) |
| NHL spread | 3h | ≤0.30 | -14.4pp (49) | -7.6pp (39) |
| NHL total | 1d | ≥0.40 | +15.5pp (35) | +10.2pp (35) |

Direction is coherent with classic favorite-longshot bias (favorites/≥0.40 band underpriced, longshots/≤0.30 band overpriced), and NHL's own ≥0.40 bias visibly shrinks approaching resolution (9-15pp at 1-day-out → 3-4pp at 3-hours-out), matching the literature's expected pattern.

**Caution already flagged**: the NBA cell's test result (69/69 = 100% win rate for the trade side) is statistically more extreme than its ~85%-implied price would predict under an efficient-market null (~2×10⁻⁵ tail probability) — the *direction* is credible and echoes NHL's independent result, but that specific *magnitude* is likely inflated by test-set luck. Don't take 100% at face value when sizing anything.

### P&L simulation already run (idealized — see "what's still open" below)

Flat $50/bet + fractional Kelly (22.5% of full Kelly, 5%-of-$1,000-bankroll cap), test-half only, edge estimated from train-half only (no lookahead):

| bucket | Flat $50 | Kelly |
|---|---|---|
| NBA moneyline 3h ≤0.30 | n=69, P&L $604.66 | n=40, P&L $441.22 |
| NHL moneyline 1d ≥0.40 | n=101, P&L $972.17 | n=91, P&L $654.82 |
| NHL spread 3h ≤0.30 | n=39, P&L $198.05 | n=39, P&L $198.05 (cap bound every trade) |
| NHL total 1d ≥0.40 | n=35, P&L $386.97 | n=10, P&L $410.89 |
| **Combined** | **n=244, P&L $2,161.85** | **n=180, P&L $1,704.97, $7,684 staked** |

Unlike the earlier (fake) CBB result, Kelly does not degenerate into flat-betting here — per-trade edge varies enough within each band that Kelly skips/shrinks some trades on their own merits.

**Update 2026-08-26 — realistic execution costs applied, edge survives:** the above used idealized last-observed-price fills. Re-run with real nearby taker-trade fills + Polymarket US's actual 5% sports taker fee: combined flat P&L $2,161.85 → $1,921.58 (11.1% haircut), Kelly $1,704.97 → $1,532.88 (10.1% haircut), 241/244 trades fillable. See "What's still open" item 2 below for detail and `executionCostAnalysis.js`.

---

## What's still open (do this before building anything real)

1. ~~MLB is currently broken and excluded~~ — **RESOLVED 2026-08-26, and the original diagnosis was wrong.** It is *not* a wrong-game mapping bug: exact-slug Gamma lookups correctly and uniquely map every MLB game, preserving order within multi-game series (directly verified on a real 4-game series, `mlb-nyy-bos-2026-06-25` through `-06-28`, each mapping to a distinct, correctly-ordered, correctly-resolved real game). The real bug is that **Gamma's own `endDate` field for MLB events is itself wrong — consistently ~7 days later than the real game** (verified via price-history convergence to a resolved 0/1 outcome, and via last-real-trade timestamps, both landing days before Gamma's claimed `endDate`, right around the date embedded in the US slug instead). `fetchLiquidityFiltered.js` trusted `gammaEvent.endDate` for every sport including MLB and got a systematically wrong reference time for MLB specifically — which is exactly why the original checkpoint liquidity was inverted (dense at "168h before", empty at "72h/24h/3h before"): the 168h-before checkpoint, computed from the wrong end time, was accidentally landing right at the real game time, and the near-game checkpoints were landing after the real game had already resolved and gone quiet. **Fix**: `fetchMLBFixed.js` derives the true end time per-market from the timestamp of the last real trade (a self-correcting signal, immune to either platform's date-metadata bugs) and recomputes all 4 checkpoints against it. Re-ran: MLB's checkpoint liquidity now matches every other sport's shape (3h: 99% liquid, 24h: 40%, 72h: 3%, 168h: ~no data) — confirms the fix is right. See `usMLBFixed.json` and the new finding below.
2. ~~The P&L simulation used idealized last-observed-price fills~~ — **RESOLVED 2026-08-26.** Re-ran all 244 test-half trades in the 4 candidate buckets against real nearby taker trades (see `executionCostAnalysis.js` / `executionCostResults.json`), replacing the smoothed CLOB price-history checkpoint with the nearest actual same-direction fill within ±3h, and applied Polymarket US's real sports taker fee (`fee = shares × 0.05 × p × (1-p)`, confirmed via help.polymarket.com, theta updated to 0.05 as of July 2026). **Result: the edge survives.** 241/244 trades (99%) were fillable against real trade data (3 dropped, no matching taker trade in window). Combined flat P&L: $2,161.85 (idealized) → $1,921.58 (real fill + fee), an **11.1% haircut**. Kelly P&L: $1,704.97 → $1,532.88 (**10.1% haircut**). Win rates essentially unchanged (77.5% → 78.0% flat-bet aggregate). Per-bucket haircuts ranged from a real average fill/history-price gap of 0.29pp (NBA moneyline) up to 1.18pp (NHL total) — all small relative to the 5-15pp biases being traded. **The realistic-cost check does not kill the finding.**
3. ~~NBA/NHL season timing hasn't been confirmed~~ — **RESOLVED 2026-08-26.** Both leagues are currently in the off-season. NHL: preseason starts 2026-09-19, regular season starts 2026-09-29. NBA: regular season starts 2026-10-20. So forward log-only monitoring of the 4 buckets cannot begin with live games for roughly 3.5 weeks (NHL) to 8 weeks (NBA) from today (2026-08-26). This is a natural prep window, not a blocker — infra/monitoring code can be built now and switched on when each season starts.

## Exact next steps

1. ~~Apply realistic execution costs (spread-crossing, fees) to the P&L simulation.~~ Done — see above.
2. ~~Confirm NBA/NHL season timing.~~ Done — see above.
3. ~~Fix the MLB slug-mapping bug, re-run the bias check.~~ **DONE 2026-08-26.** A 5th bucket survives — see below.
4. ~~Give a clear go/no-go readiness call~~ — **DONE, see below.**

---

## The 5th bucket: MLB moneyline

Re-running the same liquidity-filtered, walk-forward bias check on the corrected MLB dataset (`usSportsLiquidityFiltered_v2.json` = non-MLB records unchanged + `usMLBFixed.json`) surfaces one new candidate:

| sport / type | horizon | band | train bias (n) | test bias (n) |
|---|---|---|---|---|
| MLB moneyline | 1d | 0.30-0.40 | -8.5pp (60) | -10.2pp (57) |

Same-sign, walk-forward consistent, comparable magnitude to the NHL buckets. One structural difference worth flagging: this is a **middle-band** effect (0.30-0.40, i.e. a coin-flip-ish game priced as such is *still* overpriced on the YES side), not the extreme-band favorite/longshot pattern the other 4 buckets show — it's a real, validated finding by the same methodology, but it's a different flavor of mispricing than classic FLB, so don't assume it generalizes to MLB's other bands or submarket types (spread/total showed nothing at any horizon/band for MLB).

**Real execution costs applied to this bucket too** (same methodology as the other 4 — real nearby taker fills + Polymarket US's 5% sports taker fee): 56/57 test trades (98%) fillable, flat P&L $441.37 (idealized) → $416.07 (real fill + fee), a 5.7% haircut; Kelly $325.80 → $288.86, an 11.3% haircut. The realized win rate (75.0%, 42/56) against a ~63.5¢ NO price is a normal, well-behaved edge — nothing like NBA moneyline's implausible 100%, so **no shrinkage is warranted for MLB.**

**Updated combined P&L, all 5 buckets, real fill + fee:**

| | flat P&L | Kelly P&L |
|---|---|---|
| Raw (NBA at face value) | $2,337.65 (n=297, 77.4% win) | $1,821.73 (staked $9,748.62, n=233) |
| **Shrunk (NBA downweighted per below)** | **~$2,028** | **~$1,610** |

MLB adds a full, un-shrunk $416.07 flat / $288.86 Kelly on top of the previous 4-bucket shrunk estimate (~$1,612 / ~$1,321) — a meaningful, independent addition to the case for building this now.

---

## FINAL GO/NO-GO CALL (2026-08-26, updated with MLB)

### Verdict: **(a) BUILD NOW — as two phases, not one simultaneous rollout.** Phase 1 (MLB) targets the live-right-now season. Phase 2 (NHL/NBA) targets September/October when those seasons open. Size the 3 NHL buckets + the MLB bucket at full fractional-Kelly weight. Treat NBA moneyline as unconfirmed — trade it at sharply reduced size (or log-only) until live data closes the gap.

Both open risks that could plausibly have killed this (execution realism, season timing) are resolved and didn't kill it, and the MLB re-analysis added a 5th, independently-validated bucket rather than subtracting from the case. There is nothing left that further backtesting can tell us — the remaining uncertainty (does NBA's edge really run near the observed 100% win rate, or is it a small-sample artifact) can only be resolved with live data, not more analysis of the same historical dataset. Given that, delaying the build itself doesn't reduce risk, it just wastes time — and for MLB specifically, wastes a live season that's already running. This project's own history (the weather bot's forecast edge never materializing live; the CBB stale-quote artifact) is exactly why NBA gets downweighted below, not why the whole thing waits.

### Don't trust NBA's 100% at face value — here's the shrunk estimate

The NBA moneyline bucket's test half went 69-for-69 (100%) against an average ~86¢ NO price. That's a ~2×10⁻⁵-probability outcome under the price's own implied null — not a number to build position sizing around. But the *direction* isn't in question (it echoes NHL's independent result), and NBA's own **train**-half result — unaffected by the test-set's small-sample luck — showed a **7.35pp edge** (88.2% realized vs 80.9% priced), not a blown-up one.

That 7.35pp figure is the one to trust, for two reasons: it's NBA's own data, not test-set cherry-picking, and it happens to fall squarely inside the range every other validated bucket in this dataset shows (NHL train/test edges run 7.6pp–15.5pp). That's genuine independent corroboration, not a number invented to be conservative.

Shrunk estimate: **carry NBA's edge forward at ~7.4pp instead of the observed 14.3pp/100%.** Applied to the test half's real-fill average price (~86¢), that implies a forward win rate of **~93%, not 100%.**

Recomputed under that assumption (approximate — this uses average price/fee, not a full per-trade re-simulation, since individual real-fill prices weren't retained from the execution-cost run):

| bucket | flat P&L (real-fill+fee, raw) | flat P&L (shrunk NBA) | Kelly P&L (raw) | Kelly P&L (shrunk NBA) |
|---|---|---|---|---|
| NBA moneyline (n=69) | $569.05 (100% assumed) | **~$259** (93% assumed) | $409.15 | **~$197** |
| NHL moneyline (n=100) | $838.93 | $838.93 (unchanged, not an outlier) | $554.08 | $554.08 |
| NHL spread (n=38) | $132.18 | $132.18 (unchanged) | $131.43 | $131.43 |
| NHL total (n=34) | $381.42 | $381.42 (unchanged) | $438.21 | $438.21 |
| MLB moneyline (n=56) | $416.07 | $416.07 (unchanged, not an outlier — see above) | $288.86 | $288.86 |
| **Combined (5 buckets)** | **$2,337.65** | **~$2,028** | **$1,821.73** | **~$1,610** |

Shrinking NBA to a defensible, corroborated estimate costs about **13%** off the combined real-fill flat P&L ($2,337.65 → ~$2,028) and **12%** off Kelly ($1,821.73 → ~$1,610) — a real haircut, but the strategy is still clearly, comfortably profitable on n=297 fillable opportunities across 3 sports now, not 2. It doesn't come close to flipping the sign. That's the basis for building now rather than waiting: even under the pessimistic, corroborated read of the one questionable bucket, this clears the bar — and clears it more comfortably than before MLB was added.

### What to build — two phases, not one simultaneous rollout

The 5 buckets split cleanly into two rollout phases by whether their season is live right now or not. Build both now (there's no reason for code to sit unwritten), but MLB is the one that can actually start trading immediately.

**Phase 1 — MLB, ships now (regular season live through 2026-09-27, postseason through 2026-10-31):**
1. Market scanner scoped to MLB moneyline only (the only MLB submarket type/band that validated — spread and total showed nothing).
2. Checkpoint/band logic: at ~24h (1 day) before game start, if YES price is in [0.30, 0.40) → buy NO.
3. Same liquidity gate as below (≥$50 real notional within ±3h).
4. Full fractional-Kelly weight — this bucket's test result is well-behaved (75% win rate against a ~63.5¢ price), not a statistical outlier, so it doesn't need NBA's probation treatment. Still subject to the same explicit re-evaluation checkpoint after ~20-30 live trades as everything else (item 7 below), just not pre-emptively downweighted.
5. This is the one part of the system with a real deadline: build and validate it first, since every week of delay is a week of live MLB season not being traded.

**Phase 2 — NHL/NBA, ships when each season opens (NHL 2026-09-29, NBA 2026-10-20):**
1. Market scanner scoped to NBA and NHL, moneyline/spread/total submarkets.
2. Checkpoint/band logic, exactly as backtested — do not generalize beyond what was validated:
   - NHL moneyline: at ~24h before game start, if YES price ≥0.40 → buy YES.
   - NHL spread: at ~3h before, if YES price ≤0.30 → buy NO.
   - NHL total: at ~24h before, if YES price ≥0.40 → buy YES.
   - NBA moneyline: at ~3h before, if YES price ≤0.30 → buy NO. **Reduced size / probation status** (see item 5 below).
3. No live NHL/NBA games exist to trade until their seasons start regardless of when this code is ready — build and dry-run against historical closed markets in the meantime.

**Shared infrastructure (build once, both phases use it):**
4. **Liquidity gate at entry**, reusing the exact standard the backtest used: require ≥$50 real trade notional within ±3h of the checkpoint (same logic as `fetchLiquidityFiltered.js`/`fetchMLBFixed.js`/`executionCostAnalysis.js`) before entering — a price that fails this check is a stale quote, not a real fill, full stop.
5. **Execution**: reuse the existing Polymarket US CLOB auth/order-placement/fill-tracking code from `polybot-v2` — that layer is already built and battle-tested from the weather bot; this project only needs to point it at different markets with different entry logic, not rebuild it.
6. **Position sizing**: fractional Kelly (22.5% of full Kelly, 5%-of-bankroll cap), per the existing simulation methodology, at full weight for the 3 NHL buckets and MLB. For NBA moneyline, either log-only (record the signal, don't trade it) or a hard-capped fraction (e.g. a quarter of the normal Kelly stake) until it accumulates enough live resolved trades to check against the ~93% shrunk estimate.
7. **Logging harness**: record every qualifying opportunity seen (traded or not), its checkpoint price, fill price, fee, and eventual resolution. This *is* the live validation — no separate paper-only phase is needed for the 3 NHL buckets or MLB given how solid their train/test/execution-cost evidence already is, but this log is exactly what will confirm or kill NBA's ~93% shrunk estimate once enough live trades accumulate.
8. **Explicit re-evaluation checkpoint, set up front, per bucket**: re-assess each bucket after its first ~20-30 live resolved trades — check the live win rate against its backtested/shrunk expectation using the same statistical-plausibility framing that flagged NBA's original 100% as implausible. Do not wait until 100 trades to notice a problem the way the weather bot did.

---

## Key files in this directory

- `CATEGORY_REFERENCE.md` — full category reference table (regenerate via `censusUS_full.js` + `parallelCrawl.js` + `analyzeCensusFull.js`)
- `us_events_census_full.json` — full raw crawl of all 73,540 Polymarket US events (all categories)
- `fetchLiquidityFiltered.js` → `usSportsLiquidityFiltered.json` — NFL/NBA/NHL/CFB/CBB/MLB dataset with per-checkpoint liquidity data (`nearbyNotionalUsd`, `nearbyTradeCount`, `liquid` boolean); its MLB records use a buggy `endDate` (see next item) and should not be used directly for MLB
- `fetchMLBFixed.js` → `usMLBFixed.json` — corrected MLB dataset: recomputes each market's true end time from its last real trade timestamp instead of trusting Gamma's `endDate` (which is ~7 days late for MLB specifically); use this for all MLB analysis
- `usSportsLiquidityFiltered_v2.json` — the merged, current dataset (non-MLB records from `usSportsLiquidityFiltered.json` unchanged + corrected records from `usMLBFixed.json`); this is what `analyzeLiquidityFiltered.js` and `executionCostAnalysis.js` now read
- `analyzeLiquidityFiltered.js` → `liquidityFilteredStats.json` / `liquidityFilteredCandidates.json` — the bias-by-bucket analysis and the 5 surviving candidates (4 NBA/NHL + 1 MLB)
- `simulateLiquidity.js` — the flat-$50 / fractional-Kelly P&L simulation (idealized fills, superseded for realism by the next item, kept as baseline; note it still reads the old 4-candidate/non-MLB path and hasn't been updated for the 5th bucket)
- `executionCostAnalysis.js` → `executionCostResults.json` / `executionCostAnalysis_v2_run.log` — realistic-fill version: re-fetches real nearby taker trades + applies Polymarket US's actual sports taker fee for all 301 test-half trades across all 5 buckets; this is the current best P&L estimate
- Superseded/historical (context only, don't re-run as current truth): `discover.js`, `fetchHistory.js`, `analyze.js` (original global-Polymarket discovery, before the US-scope correction), `censusUS.js` / `us_events_census.json` (an earlier, incomplete census that stopped at 2,499 events — superseded by `us_events_census_full.json`), `fetchUSSports.js` / `usSportsHistory.json` / `analyzeUSSports.js` / `simulate.js` / `check1_liquidity.js` / `check3_crosssport.js` (the original, non-liquidity-filtered CBB-only run that produced the now-debunked finding — kept for the historical record of how the liquidity-filtering lesson was learned)
