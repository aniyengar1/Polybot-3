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

const WINDOW_SECONDS = 15 * 60;
const STARTING_BANKROLL = Number(process.env.KALSHIBOT_PAPER_BANKROLL_USD || 200); // matches the backtest's own $200 start, for direct comparability

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
  const resolved = db.prepare(`SELECT COALESCE(SUM(exit_pnl_usd), 0) AS pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0`).get();
  const outstanding = db.prepare(`SELECT COALESCE(SUM(stake_usd), 0) AS o FROM trades WHERE status = 'pending' AND log_only = 0`).get();
  return STARTING_BANKROLL + resolved.pnl - outstanding.o;
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
    return { series, checkpointMinutes, outcome: 'observed', ticker: market.ticker, bucketKey, price, reason: 'bucket retired from live trading (calibration bug found 2026-09-07)' };
  }

  const decision = evaluateOpportunity({ bucketKey, price }, bankrollUsd);
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

  const execResult = openPosition(decision);
  const now = new Date().toISOString();
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

  const alerts = runDecayWatch(log);
  if (alerts.length > 0) {
    log(`!!! ${alerts.length} DECAY ALERT(S) THIS CYCLE !!!`, alerts);
  }

  const probationReviews = checkProbationReviews(log);
  if (probationReviews.length > 0) {
    log(`!!! ${probationReviews.length} PROBATIONARY BUCKET(S) READY FOR REVIEW !!!`, probationReviews);
  }

  return { results, obsResult, tradeResult, shadowResult, alerts, probationReviews };
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

module.exports = { runCheckpointCycle, nextCheckpointAfter, getBankrollUsd, evaluateSeriesCheckpoint, nearestPriceAtOrBefore, windowOpenTsFor };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
