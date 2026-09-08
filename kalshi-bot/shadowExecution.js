// Shadow execution simulation. Genuinely separate, additive system -- see db.js's
// shadow_execution_trials header for the full rationale and the two known simplifications
// (taker fee formula applied to maker fills too; no confirmed Kalshi maker-fee schedule exists
// anywhere in this project to use instead). Rides alongside every real paper trade (same
// signal/side/contracts) to test a passive join-the-bid limit order against a 60s timeout,
// instead of this bot's real fills, which have always assumed an instant taker fill at the
// checkpoint price (execution.js's header).
//
// Called fire-and-forget (no `await`) from orchestrator.js, right after the real trade INSERT.
// This MUST stay fire-and-forget: an awaited 60s simulation would block runCheckpointCycle,
// which would delay the main loop's next-checkpoint sleep target -- checkpoints have fired as
// little as 60s apart live, so that could make the real bot miss its next checkpoint entirely.
// Every failure path here is caught and logged by the caller, never thrown into the real
// trade path.
'use strict';

const { getDb } = require('./db');
const { getOrderbook } = require('./kalshiClient');
const { feeUsd } = require('./liveSizing');

const POLL_INTERVAL_MS = 2000; // conservative choice, not a confirmed Kalshi rate-limit figure -- see plan/header. Every 429 the poller hits is logged so this is empirically checkable.
const TIMEOUT_MS = 60000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} signal
 * @param {number} signal.observationId
 * @param {number} signal.realTradeId
 * @param {string} signal.series
 * @param {string} signal.ticker
 * @param {string} signal.bucketKey
 * @param {'yes'|'no'} signal.side
 * @param {number} signal.contracts
 * @param {string} signal.signalAt
 * @param {number|null} signal.yesBidAtSignal
 * @param {number|null} signal.yesAskAtSignal
 */
async function runShadowSimulation(signal, log = () => {}) {
  const { observationId, realTradeId, series, ticker, bucketKey, side, contracts, signalAt, yesBidAtSignal, yesAskAtSignal } = signal;

  // Same null-safety the real spread-capture already relies on (orchestrator.js) -- a missing
  // signal-time quote is a valid, expected outcome (thin book), not something to guess a price
  // for. No row written, no error.
  if (yesBidAtSignal === null || yesAskAtSignal === null || yesBidAtSignal === undefined || yesAskAtSignal === undefined) {
    log('shadow sim skipped: no signal-time bid/ask captured', { bucketKey, ticker });
    return;
  }

  // Passive limit price: join the current best bid on the side being bought, rather than
  // crossing to the ask like every real fill (and every backtest) assumes -- the whole point of
  // this simulation. NO-side price via the same complementary-market algebra kalshiClient.js's
  // getOrderbook already documents (bestNoBid = 1 - bestYesAsk) -- computed locally here rather
  // than changing getOrderbook's own return shape, since the real trade path also calls it and
  // must stay untouched.
  const limitPrice = side === 'yes' ? yesBidAtSignal : (1 - yesAskAtSignal);

  const startMs = Date.now();
  let filled = false;
  let rateLimitHits = 0;

  while (Date.now() - startMs < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    let book;
    try {
      book = await getOrderbook(ticker);
    } catch (err) {
      if (String(err).includes('429')) rateLimitHits += 1;
      continue; // a single failed poll just retries next interval, doesn't abort the trial
    }
    if (book.bestYesBid === null || book.bestYesAsk === null) continue;

    // "Price crossed the resting limit" = the current touch price on our side has reached our
    // resting price -- in a real matching engine this means our earlier-resting order would
    // have filled AT our price (price-time priority), not at the touch price.
    const currentTouchPrice = side === 'yes' ? book.bestYesAsk : (1 - book.bestYesBid);
    if (currentTouchPrice <= limitPrice) {
      filled = true;
      break;
    }
  }

  let fillType, fillPrice, secondsToFill;
  if (filled) {
    fillType = 'maker';
    fillPrice = limitPrice; // fills at the resting price, never the crossing price
    secondsToFill = (Date.now() - startMs) / 1000;
  } else {
    fillType = 'taker';
    secondsToFill = TIMEOUT_MS / 1000;
    // Fresh poll at the timeout moment -- not the stale signal-time value.
    try {
      const book = await getOrderbook(ticker);
      fillPrice = book.bestYesBid === null || book.bestYesAsk === null
        ? null
        : (side === 'yes' ? book.bestYesAsk : (1 - book.bestYesBid));
    } catch (err) {
      fillPrice = null;
    }
    if (fillPrice === null) {
      log('shadow sim: taker fallback poll failed, discarding trial', { bucketKey, ticker });
      return; // no usable fill price -- don't record a row with a fabricated one
    }
  }

  const fee = feeUsd(contracts, fillPrice); // symmetric in price/complement (p*(1-p)), no side-conversion needed

  const db = getDb();
  db.prepare(`
    INSERT INTO shadow_execution_trials (created_at, observation_id, real_trade_id, series, ticker, bucket_key, side, contracts, signal_at, limit_price, fill_type, fill_price, fee_usd, seconds_to_fill)
    VALUES (@created_at, @observation_id, @real_trade_id, @series, @ticker, @bucket_key, @side, @contracts, @signal_at, @limit_price, @fill_type, @fill_price, @fee_usd, @seconds_to_fill)
  `).run({
    created_at: new Date().toISOString(),
    observation_id: observationId,
    real_trade_id: realTradeId,
    series,
    ticker,
    bucket_key: bucketKey,
    side,
    contracts,
    signal_at: signalAt,
    limit_price: limitPrice,
    fill_type: fillType,
    fill_price: fillPrice,
    fee_usd: fee,
    seconds_to_fill: secondsToFill,
  });
  log('shadow trial recorded', { bucketKey, fillType, fillPrice, secondsToFill, rateLimitHits: rateLimitHits || undefined });
}

/** Settles trades whose underlying observation is now resolved. Same shape as settlement.js's settlePendingTrades, kept as a separate function since this is a genuinely separate system. Run alongside settlePendingTrades in the same cycle. */
function settleShadowTrials(log = () => {}) {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT s.id AS shadow_id, s.side, s.contracts, s.fill_price, s.fee_usd, o.yes_resolved_to
      FROM shadow_execution_trials s JOIN observations o ON o.id = s.observation_id
      WHERE s.status = 'pending' AND o.resolved = 1
    `)
    .all();

  const now = new Date().toISOString();
  let settledCount = 0;
  for (const r of rows) {
    const won = r.side === 'yes' ? r.yes_resolved_to === 1 : r.yes_resolved_to === 0;
    const payout = won ? r.contracts : 0;
    const exitPnl = payout - (r.contracts * r.fill_price + r.fee_usd);
    db.prepare(`UPDATE shadow_execution_trials SET status = ?, exit_pnl_usd = ?, resolved_at = ? WHERE id = ?`)
      .run(won ? 'won' : 'lost', exitPnl, now, r.shadow_id);
    settledCount += 1;
  }
  return { settled: settledCount };
}

module.exports = { runShadowSimulation, settleShadowTrials, POLL_INTERVAL_MS, TIMEOUT_MS };
