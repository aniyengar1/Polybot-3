// Checkpoint scheduler. Unlike sports-bot's fixed 20-minute poll loop, this computes the
// exact checkpoint instant(s) for each 15-minute window and sleeps until each in turn, rather
// than polling -- avoids ever missing or double-firing a window's checkpoint moments, and
// avoids the drift a fixed-poll loop would accumulate against a 15-minute-lived market.
//
// GENERALIZED 2026-09-04 for WTI: gold/silver both only ever traded at one checkpoint
// (close_time - 8min = open_time + 7min, confirmed both series share the same
// :00/:15/:30/:45-aligned grid live 2026-09-04), so there used to be exactly one
// CHECKPOINT_MINUTES_BEFORE_CLOSE constant and one sleep-target per window. WTI's 3 rules
// fire at 3 different checkpoints (3/6/8 min before close) within the SAME window, so the
// scheduler now derives the full set of distinct checkpoint-minutes values from
// buckets.js's BUCKET_CONFIG (allCheckpointMinutes()), computes each one's absolute instant
// for the current window, and sleeps to the next one in the merged sequence across all of
// them -- not WTI-specific: a future series/checkpoint just needs a new BUCKET_CONFIG entry,
// no scheduler code changes. Reduces to the exact original single-checkpoint behavior when
// only one distinct checkpoint-minutes value exists (gold/silver's case) -- verified this is
// a strict generalization, not a behavior change, before this refactor was merged (see
// scratchpad regression check referenced in the PR/task report).
'use strict';

const { getDb } = require('./db');
const { BUCKET_CONFIG, bucketOf, makeBucketKey, isAllowedBucket, allCheckpointMinutes, seriesForCheckpointMinutes } = require('./buckets');
const { getOpenMarkets, getCandlesticks, getOrderbook } = require('./kalshiClient');
const { catchUpFolds, utcDateString } = require('./calibration');
const { evaluateOpportunity } = require('./liveSizing');
const { openPosition, currentMode } = require('./execution');
const { settlePendingObservations, settlePendingTrades } = require('./settlement');
const { runDecayWatch, checkProbationReviews } = require('./decayWatch');
const { runShadowSimulation, settleShadowTrials } = require('./shadowExecution');
const { evaluateAndPersistDrawdownBreaker, getBucketPnlUsd } = require('./drawdownBreaker');
const { applyPilotStakeCap } = require('./pilotStakeCap');
const { placeLivePosition, reconcileLiveOrders } = require('./liveExecution');
// Neither monitorAndFinalizeLiveOrder nor executionStrategy.js's LIVE_EXECUTION_STRATEGY_CONFIG
// is imported here anymore (task #12) -- placeLivePosition now owns its own full lifecycle,
// including firing its own fire-and-forget monitor (and reading restMs for it) internally, once
// it has confirmed a real order exists. See liveExecution.js's header.

const WINDOW_SECONDS = 15 * 60;
const STARTING_BANKROLL = Number(process.env.KALSHIBOT_PAPER_BANKROLL_USD || 200); // matches the backtest's own $200 start, for direct comparability
// Same constant as statsServer.js's own LIVE_STARTING_BANKROLL (identical env var, identical
// default $199.98 -- the confirmed exchange_index:2 balance as of 2026-09-11, see that file's own
// comment for full provenance). Defined independently here rather than imported/shared, matching
// this file's existing STARTING_BANKROLL/statsServer.js's STARTING_BANKROLL precedent -- the two
// files are deliberately separate systemd services (statsServer.js's own header) and don't import
// from each other. Added 2026-09-15 to fix a real bug: live Kelly sizing was reading
// getBankrollUsd() (mode='paper', frozen at $237.52 since paper trading stopped 2026-09-11) while
// the real live bankroll had drifted to ~$217 -- see getLiveBankrollUsd() below.
const LIVE_STARTING_BANKROLL = Number(process.env.KALSHIBOT_LIVE_STARTING_BANKROLL_USD || 199.98);

// Real-order execution gate (added 2026-09-09, see liveExecution.js) -- a THIRD, independent
// gate on top of kalshiOrders.js's own double opt-in ({base:'live'} AND
// KALSHIBOT_ORDERS_ALLOW_LIVE='true'). Default 'off' (unset) means the live branch in
// evaluateSeriesCheckpoint never runs at all -- paper path, byte-for-byte unchanged.
const LIVE_EXECUTION_MODE = process.env.KALSHIBOT_LIVE_EXECUTION_MODE || 'off'; // 'off' | 'demo' | 'live'

function offsetSecondsFor(checkpointMinutes) {
  return (15 - checkpointMinutes) * 60; // seconds after open_time
}

function checkpointMinutesForOffset(offsetSeconds) {
  return 15 - offsetSeconds / 60;
}

function log(msg, extra) {
  console.log(`[${new Date().toISOString()}] ${msg}`, extra !== undefined ? JSON.stringify(extra) : '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function windowOpenTsFor(ts) {
  return Math.floor(ts / WINDOW_SECONDS) * WINDOW_SECONDS;
}

/** Nearest 1-min candle close at-or-before targetTs, within 4 min tolerance -- identical rule to the backtest fetch script's nearestPriceAtOrBefore, reimplemented for a live caller. */
function nearestPriceAtOrBefore(candles, targetTs) {
  let best = null, bestDiff = Infinity;
  for (const c of candles) {
    if (c.end_period_ts > targetTs) continue;
    const diff = targetTs - c.end_period_ts;
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  if (!best || bestDiff > 240) return null;
  const p = parseFloat(best.price?.close_dollars ?? best.price?.close ?? 'NaN');
  return Number.isNaN(p) ? null : p;
}

function getBankrollUsd(db) {
  // log_only=0: excludes any bucket configured with logOnly:true in buckets.js (none
  // currently -- WTI's 0.6-0.7/cp6 rule traded this way through 2026-09-06, then was promoted
  // to probationary; the flag stays live infrastructure for the next rule that needs it).
  // Those rows record genuine would-be trades that were never actually staked -- excluded from
  // real bankroll math, same as if they didn't exist.
  //
  // mode='paper' (added 2026-09-09): this bankroll figure drives every bucket's Kelly sizing --
  // without this filter, the instant a single live (or even demo-test) trade settles, its P&L
  // would get summed in here too, silently corrupting every future paper sizing decision. Live
  // trading does not yet have its own separate bankroll concept; this function stays exclusively
  // the paper track, same as it always was.
  const resolved = db.prepare(`SELECT COALESCE(SUM(exit_pnl_usd), 0) AS pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0 AND mode = 'paper'`).get();
  const outstanding = db.prepare(`SELECT COALESCE(SUM(stake_usd), 0) AS o FROM trades WHERE status = 'pending' AND log_only = 0 AND mode = 'paper'`).get();
  return STARTING_BANKROLL + resolved.pnl - outstanding.o;
}

/**
 * Live-track equivalent of getBankrollUsd() above -- identical query shape (same
 * resolved/outstanding pattern, same log_only=0 exclusion), just mode='live' instead of
 * mode='paper' and LIVE_STARTING_BANKROLL instead of STARTING_BANKROLL as the zero point.
 * Added 2026-09-15 (see LIVE_STARTING_BANKROLL's own comment above for the bug this fixes) --
 * used ONLY to size live trades in evaluateSeriesCheckpoint below. Every other consumer of a
 * bankroll figure in this file (the drawdown breaker's global halt check, the per-cycle log
 * line) deliberately keeps using the existing paper getBankrollUsd() -- unchanged on purpose,
 * see evaluateSeriesCheckpoint's own comment at its call site.
 */
function getLiveBankrollUsd(db) {
  const resolved = db.prepare(`SELECT COALESCE(SUM(exit_pnl_usd), 0) AS pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0 AND mode = 'live'`).get();
  const outstanding = db.prepare(`SELECT COALESCE(SUM(stake_usd), 0) AS o FROM trades WHERE status = 'pending' AND log_only = 0 AND mode = 'live'`).get();
  return LIVE_STARTING_BANKROLL + resolved.pnl - outstanding.o;
}

/** One series' evaluation at a specific checkpoint instant/minutes-before-close. Returns a summary object for logging; never throws (caller runs series in parallel and a single series' failure shouldn't sink the other). */
async function evaluateSeriesCheckpoint(series, checkpointTs, checkpointMinutes, db, bankrollUsd) {
  let openMarkets;
  try {
    openMarkets = await getOpenMarkets(series);
  } catch (err) {
    return { series, outcome: 'error', reason: `market discovery failed: ${err}` };
  }

  // The market whose own checkpoint (close_time - checkpointMinutes*60) matches the instant we
  // scheduled for. NOT offsetSecondsFor(checkpointMinutes) (that's minutes-AFTER-open, used by
  // the scheduler to compute checkpointTs itself) -- found and fixed during WTI verification:
  // reusing that value here happened to sit exactly on this 60s tolerance's edge for cp8
  // (the only checkpoint ever exercised pre-WTI: |120*8-900|=60), which is why gold/silver
  // never surfaced this, but was off by minutes for cp3/cp6 (|120*3-900|=540s, |120*6-900|=180s
  // -- both far outside tolerance, both reproduced live before this fix).
  const market = openMarkets.find((m) => {
    const closeTs = Math.floor(new Date(m.close_time).getTime() / 1000);
    return Math.abs((closeTs - checkpointMinutes * 60) - checkpointTs) <= 60;
  });
  if (!market) {
    return { series, checkpointMinutes, outcome: 'skip', reason: 'no open market matched this checkpoint (gap in listings or window boundary drift)' };
  }

  const openTs = Math.floor(new Date(market.open_time).getTime() / 1000);
  const closeTs = Math.floor(new Date(market.close_time).getTime() / 1000);

  let candles;
  try {
    candles = await getCandlesticks(series, market.ticker, openTs, checkpointTs);
  } catch (err) {
    return { series, checkpointMinutes, outcome: 'error', reason: `candlestick fetch failed: ${err}` };
  }
  const price = nearestPriceAtOrBefore(candles, checkpointTs);
  if (price === null) {
    return { series, checkpointMinutes, outcome: 'skip', reason: 'no candlestick close within tolerance of checkpoint' };
  }

  const band = bucketOf(price);
  const bucketKey = makeBucketKey(series, band, checkpointMinutes);
  const checkpointDate = utcDateString(checkpointTs);

  try {
    db.prepare(`
      INSERT OR IGNORE INTO observations (created_at, series, ticker, event_ticker, open_ts, close_ts, checkpoint_ts, checkpoint_price, band, bucket_key, checkpoint_date, checkpoint_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), series, market.ticker, market.event_ticker, openTs, closeTs, checkpointTs, price, band, bucketKey, checkpointDate, checkpointMinutes);
  } catch (err) {
    return { series, checkpointMinutes, outcome: 'error', reason: `observation insert failed: ${err}` };
  }
  const observationId = db.prepare(`SELECT id FROM observations WHERE ticker = ? AND checkpoint_minutes = ?`).get(market.ticker, checkpointMinutes).id;

  if (!isAllowedBucket(bucketKey)) {
    return { series, checkpointMinutes, outcome: 'observed', ticker: market.ticker, bucketKey, price, reason: 'not one of the traded buckets' };
  }

  // Retired buckets (buckets.js's status:'retired', currently just Silver 0.8-0.9/cp8 -- see
  // its header comment) stay in BUCKET_CONFIG so they keep resolving to a real label on the
  // dashboard, but must never produce a new trade -- this is the one and only place a live
  // trade could get created for a bucket, so this single early-return is sufficient (no gate
  // needed in liveSizing.js/execution.js). The observation row above is still recorded either
  // way, matching db.js's "every band, not just traded buckets" design.
  if (BUCKET_CONFIG[bucketKey].status === 'retired') {
    // reason now sourced from each bucket's own retiredReason field (see buckets.js) rather
    // than a hardcoded string here -- with two retired buckets now carrying different reasons
    // (a calibration bug vs. organic decay), a single shared string could no longer serve both.
    return { series, checkpointMinutes, outcome: 'observed', ticker: market.ticker, bucketKey, price, reason: BUCKET_CONFIG[bucketKey].retiredReason };
  }

  // Drawdown breaker (added 2026-09-09, see drawdownBreaker.js) -- checked here, before Kelly
  // sizing is even computed, for the same reason the retired-bucket check above sits at this
  // exact position: a halted scope shouldn't have sizing math run for it at all. Checks both
  // global (total bankroll) and this specific bucket's own P&L in one call; global takes
  // priority. Both halts are durable (drawdown_breaker_state) and require manual re-enable --
  // there is no auto-resume anywhere in drawdownBreaker.js.
  const breakerVerdict = evaluateAndPersistDrawdownBreaker(db, {
    globalBankrollUsd: bankrollUsd,
    bucketKey,
    bucketPnlUsd: getBucketPnlUsd(db, bucketKey),
  }, log);
  if (breakerVerdict.halted) {
    return { series, checkpointMinutes, outcome: 'observed', ticker: market.ticker, bucketKey, price, reason: `drawdown breaker halted (${breakerVerdict.scope}): ${breakerVerdict.reason}` };
  }

  // Sizing bankroll (added 2026-09-15, fixes the mode='paper'-only bankroll bug found tonight):
  // a checkpoint whose decision will actually be placed live must size against the REAL live
  // bankroll, not the frozen paper one -- reuses the exact same condition
  // evaluateSeriesCheckpoint's own live-execution branch below checks (LIVE_EXECUTION_MODE on,
  // AND not log-only; log-only signals never place a live order regardless of LIVE_EXECUTION_MODE,
  // see that branch's own comment, so they must keep sizing off the paper bankroll same as today).
  // Every other bankroll consumer in this function (drawdownBreaker's globalBankrollUsd above,
  // the per-cycle log line below) deliberately keeps using the original paper `bankrollUsd`
  // unchanged -- this is the one and only place live sizing itself needed to change.
  const sizingBankrollUsd = (LIVE_EXECUTION_MODE !== 'off' && BUCKET_CONFIG[bucketKey].logOnly !== true)
    ? getLiveBankrollUsd(db)
    : bankrollUsd;

  let decision = evaluateOpportunity({ bucketKey, price }, sizingBankrollUsd);
  // Pilot stake cap (added 2026-09-09, see pilotStakeCap.js) -- a no-op unless PILOT_MODE_ENABLED
  // is flipped on there, applied AFTER evaluateOpportunity's own KELLY_CAP_PCT logic, never
  // replacing it. Slots in front of the existing action!=='trade' check below so an ordinary
  // Kelly-skip and a pilot-cap-induced skip flow through the exact same line -- no new branching.
  decision = applyPilotStakeCap(decision, sizingBankrollUsd);
  if (decision.action !== 'trade') {
    return { series, checkpointMinutes, outcome: 'observed', ticker: market.ticker, bucketKey, price, reason: decision.reason };
  }

  const isLogOnly = BUCKET_CONFIG[bucketKey].logOnly === true;
  const bucketStatus = BUCKET_CONFIG[bucketKey].status || 'validated';

  // Spread-capture instrumentation (added 2026-09-06): fetched right before the insert below,
  // not earlier in this function -- there's no I/O between the price read above and here, so
  // this is effectively still "at the checkpoint," while avoiding an orderbook call for the
  // large majority of observations that never become a trade. Capture-only: a failure here
  // (network error, unexpected shape) must never block or alter the trade itself, so any
  // failure just leaves both fields null rather than throwing.
  let yesBidAtCheckpoint = null;
  let yesAskAtCheckpoint = null;
  try {
    const book = await getOrderbook(market.ticker);
    yesBidAtCheckpoint = book.bestYesBid;
    yesAskAtCheckpoint = book.bestYesAsk;
  } catch (err) {
    // leave both null -- see comment above
  }

  const now = new Date().toISOString();

  // Real-order execution path (added 2026-09-09, see liveExecution.js) -- OFF by default.
  // LIVE_EXECUTION_MODE is a THIRD, independent gate on top of kalshiOrders.js's own double
  // opt-in ({base:'live'} AND KALSHIBOT_ORDERS_ALLOW_LIVE='true') -- with it unset ('off'), this
  // whole branch never runs and everything below falls through to the unchanged paper path.
  // Log-only buckets NEVER reach the live path regardless of LIVE_EXECUTION_MODE -- log-only
  // means "record what would have happened, never actually stake anything," which applies
  // identically to paper and live; a log-only signal always takes the paper branch below.
  if (LIVE_EXECUTION_MODE !== 'off' && !isLogOnly) {
    // placeLivePosition (task #12, 2026-09-10) now owns its ENTIRE DB lifecycle internally --
    // the early INSERT (before any Kalshi call, closing the crash gap described in its own
    // header), the outcome UPDATE, live_order_alerts on ambiguity, and firing its own
    // fire-and-forget monitor once a real order is confirmed. This branch's only job now is to
    // call it and translate the outcome into this checkpoint cycle's own log/return summary --
    // it issues no trades/live_order_alerts SQL of its own anymore.
    let placement;
    try {
      placement = await placeLivePosition(decision, {
        ticker: market.ticker, base: LIVE_EXECUTION_MODE, observationId, bucketKey,
        series, bucketStatus, yesBidAtCheckpoint, yesAskAtCheckpoint,
      }, db, log);
    } catch (err) {
      // Only a resolveTarget misconfiguration throws out here -- it happens before
      // placeLivePosition writes anything, so no trades row exists to worry about; same
      // behavior as before this fix.
      return { series, checkpointMinutes, outcome: 'error', ticker: market.ticker, bucketKey, reason: `live order placement failed: ${err}` };
    }

    if (placement.outcome === 'capital_blocked') {
      // No trades row exists for this attempt at all -- checkLiveCapitalAtRisk blocked it inside
      // placeLivePosition's own db.transaction(), before the early INSERT ever ran (task #17,
      // 2026-09-11). Same treatment as any other pre-trade skip reason (Kelly skip, drawdown
      // halt) -- observed this cycle, re-evaluated fresh next cycle, not a durable halt.
      return { series, checkpointMinutes, outcome: 'observed', ticker: market.ticker, bucketKey, price, reason: placement.reason };
    }
    if (placement.outcome === 'stale_price_skip') {
      // Also no trades row -- the fresh-orderbook repricing check (2026-09-11, see
      // makerPriceFreshness.js) found the checkpoint's candlestick price would have crossed the
      // real book and, after repricing to a safe level, the edge no longer cleared fee -- or the
      // fresh orderbook read itself failed/came back thin. Same no-footprint, re-evaluate-next-
      // cycle treatment as capital_blocked above.
      return { series, checkpointMinutes, outcome: 'observed', ticker: market.ticker, bucketKey, price, reason: placement.reason };
    }
    if (placement.outcome === 'rejected') {
      return { series, checkpointMinutes, outcome: 'observed', ticker: market.ticker, bucketKey, price, reason: `live order rejected: ${placement.reason}` };
    }
    if (placement.outcome === 'unresolved') {
      return { series, checkpointMinutes, outcome: 'observed', ticker: market.ticker, bucketKey, price, reason: 'live order placement unresolved -- see live_order_alerts' };
    }
    if (placement.outcome === 'error') {
      // A trades row already exists at this point (placeLivePosition inserted it before
      // attempting the Kalshi call) and has already been alerted+finalized internally -- this
      // is purely a log/return-value distinction from 'rejected'/'unresolved', not a different
      // DB state to handle here.
      return { series, checkpointMinutes, outcome: 'error', ticker: market.ticker, bucketKey, reason: `live order placement failed after being recorded -- see live_order_alerts: ${placement.reason}` };
    }

    // 'placed' or 'resolved' -- placeLivePosition already inserted the row, recorded
    // kalshi_order_id, and fired its own monitor internally.
    return { series, checkpointMinutes, outcome: 'trade', ticker: market.ticker, bucketKey, side: decision.side, price, contracts: decision.contracts, stakeUsd: decision.stakeUsd, logOnly: false, bucketStatus, mode: 'live', executionEnv: placement.base };
  }

  const execResult = openPosition(decision);
  const insertResult = db.prepare(`
    INSERT INTO trades (created_at, mode, observation_id, series, ticker, bucket_key, side, market_price, entry_cost, contracts, fee_usd, stake_usd,
      calibration_n, calibration_p_hat, calibration_p_shrunk, kelly_fraction_raw, kelly_fraction_used, log_only, bucket_status,
      yes_bid_at_checkpoint, yes_ask_at_checkpoint, opened_at)
    VALUES (@created_at, @mode, @observation_id, @series, @ticker, @bucket_key, @side, @market_price, @entry_cost, @contracts, @fee_usd, @stake_usd,
      @calibration_n, @calibration_p_hat, @calibration_p_shrunk, @kelly_fraction_raw, @kelly_fraction_used, @log_only, @bucket_status,
      @yes_bid_at_checkpoint, @yes_ask_at_checkpoint, @opened_at)
  `).run({
    created_at: now,
    mode: execResult.mode,
    observation_id: observationId,
    series,
    ticker: market.ticker,
    bucket_key: bucketKey,
    side: decision.side,
    market_price: decision.marketPrice,
    entry_cost: decision.entryCost,
    contracts: decision.contracts,
    fee_usd: decision.fee,
    stake_usd: decision.stakeUsd,
    calibration_n: decision.calibrationN,
    calibration_p_hat: decision.calibrationPHat,
    calibration_p_shrunk: decision.calibrationPShrunk,
    kelly_fraction_raw: decision.kellyFractionRaw,
    kelly_fraction_used: decision.kellyFractionUsed,
    log_only: isLogOnly ? 1 : 0,
    bucket_status: bucketStatus,
    yes_bid_at_checkpoint: yesBidAtCheckpoint,
    yes_ask_at_checkpoint: yesAskAtCheckpoint,
    opened_at: now,
  });

  // Shadow execution simulation (see shadowExecution.js) -- fire-and-forget, deliberately NOT
  // awaited. This must never block this function's return: it can run for up to 60s, and
  // awaiting it here would delay runCheckpointCycle's return, which delays the main loop's next
  // sleep target -- checkpoints have fired as little as 60s apart live, so an awaited shadow sim
  // could make the real bot miss its next checkpoint. The real trade above is already fully
  // recorded by this point; nothing below can alter it.
  runShadowSimulation({
    observationId,
    realTradeId: insertResult.lastInsertRowid,
    series,
    ticker: market.ticker,
    bucketKey,
    side: decision.side,
    contracts: decision.contracts,
    signalAt: now,
    yesBidAtSignal: yesBidAtCheckpoint,
    yesAskAtSignal: yesAskAtCheckpoint,
  }, log).catch((err) => log('shadow simulation failed', { bucketKey, err: String(err) }));

  return { series, checkpointMinutes, outcome: isLogOnly ? 'logged (unstaked)' : 'trade', ticker: market.ticker, bucketKey, side: decision.side, price, contracts: decision.contracts, stakeUsd: decision.stakeUsd, logOnly: isLogOnly, bucketStatus };
}

async function runCheckpointCycle(checkpointTs) {
  const db = getDb();
  catchUpFolds(new Date());
  const bankrollUsd = getBankrollUsd(db);

  const checkpointMinutes = checkpointMinutesForOffset(checkpointTs - windowOpenTsFor(checkpointTs));
  const activeSeries = seriesForCheckpointMinutes(checkpointMinutes);

  const results = await Promise.all(activeSeries.map((series) => evaluateSeriesCheckpoint(series, checkpointTs, checkpointMinutes, db, bankrollUsd)));
  log('checkpoint cycle', { checkpointTs, checkpointIso: new Date(checkpointTs * 1000).toISOString(), checkpointMinutes, bankrollUsd: bankrollUsd.toFixed(2), results });

  const obsResult = await settlePendingObservations(log);
  const tradeResult = settlePendingTrades(log);
  if (obsResult.resolved > 0 || tradeResult.settled > 0) {
    log('settlement pass', { ...obsResult, ...tradeResult });
  }

  // Settles shadow_execution_trials only -- reads/writes exclusively the new shadow table,
  // same additive pattern as decayWatch's calls below already sit alongside real settlement
  // without touching real trade data.
  const shadowResult = settleShadowTrials(log);
  if (shadowResult.settled > 0) {
    log('shadow trials settled', shadowResult);
  }

  // Durable backstop for live orders (see liveExecution.js's reconcileLiveOrders) -- catches any
  // live order whose in-memory monitorAndFinalizeLiveOrder promise chain was lost (process
  // restart, or a silent failure that didn't crash the process). No-op (checked:0) while
  // LIVE_EXECUTION_MODE is 'off', since no live trades exist to reconcile.
  const liveReconcileResult = await reconcileLiveOrders(db, log);
  if (liveReconcileResult.reconciled > 0) {
    log('live orders reconciled', liveReconcileResult);
  }

  const alerts = runDecayWatch(log);
  if (alerts.length > 0) {
    log(`!!! ${alerts.length} DECAY ALERT(S) THIS CYCLE !!!`, alerts);
  }

  const probationReviews = checkProbationReviews(log);
  if (probationReviews.length > 0) {
    log(`!!! ${probationReviews.length} PROBATIONARY BUCKET(S) READY FOR REVIEW !!!`, probationReviews);
  }

  return { results, obsResult, tradeResult, shadowResult, liveReconcileResult, alerts, probationReviews };
}

/**
 * Next checkpoint instant strictly after `now` (unix seconds), across ALL distinct
 * checkpoint-minutes-before-close values in BUCKET_CONFIG -- e.g. with gold/silver's {8} and
 * WTI's {3,6,8} both configured, this merges to a 3-checkpoint-per-window sequence (cp8 fires
 * first chronologically at open+7min, then cp6 at open+9min, then cp3 at open+12min). Reduces
 * exactly to the old single-checkpoint formula when only one distinct value exists. Exported
 * for tests/cli.
 */
function nextCheckpointAfter(now) {
  const openTs = windowOpenTsFor(now);
  let best = Infinity;
  for (const cm of allCheckpointMinutes()) {
    const thisCheckpoint = openTs + offsetSecondsFor(cm);
    const candidate = now < thisCheckpoint ? thisCheckpoint : thisCheckpoint + WINDOW_SECONDS;
    if (candidate < best) best = candidate;
  }
  return best;
}

async function main() {
  log(`starting -- mode=${currentMode()}, startingBankroll=$${STARTING_BANKROLL}, checkpoints=${allCheckpointMinutes().join(',')}min-before-close`);
  const once = process.argv.includes('--once');

  if (once) {
    const now = Math.floor(Date.now() / 1000);
    // For --once (manual/smoke-test invocation): evaluate every checkpoint in the CURRENT
    // window that's already passed, in chronological order, rather than sleeping -- a live
    // human running this by hand wants an immediate result, not a wait. Falls back to waiting
    // for the next upcoming checkpoint only if none in the current window have fired yet.
    const openTs = windowOpenTsFor(now);
    const passedInWindow = allCheckpointMinutes()
      .map((cm) => openTs + offsetSecondsFor(cm))
      .filter((ts) => ts <= now)
      .sort((a, b) => a - b);

    if (passedInWindow.length > 0) {
      for (const ts of passedInWindow) await runCheckpointCycle(ts);
      return;
    }

    const target = nextCheckpointAfter(now);
    log(`--once: waiting ${target - now}s for next checkpoint`);
    await sleep((target - now) * 1000);
    await runCheckpointCycle(target);
    return;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Math.floor(Date.now() / 1000);
    const target = nextCheckpointAfter(now);
    const waitMs = (target - now) * 1000;
    if (waitMs > 0) {
      log(`sleeping ${Math.round(waitMs / 1000)}s until next checkpoint`, { targetIso: new Date(target * 1000).toISOString() });
      await sleep(waitMs);
    }
    await runCheckpointCycle(target).catch((err) => log('cycle crashed, will retry next checkpoint', { err: String(err) }));
  }
}

module.exports = { runCheckpointCycle, nextCheckpointAfter, getBankrollUsd, getLiveBankrollUsd, evaluateSeriesCheckpoint, nearestPriceAtOrBefore, windowOpenTsFor };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
