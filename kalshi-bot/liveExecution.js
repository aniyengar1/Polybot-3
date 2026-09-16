// Real-order execution -- the live counterpart to execution.js's paper openPosition(), kept in
// its own file for the same reason orderRetrySafety.js sits apart from kalshiOrders.js: one file
// per concern. execution.js itself is untouched; its header already said real trading "needs a
// new, explicit, separately-reviewed function, not a mode switch," and this file is that
// function, not a flag threaded through the paper path.
//
// SAFETY: this file adds NOTHING new to the demo/live gating -- kalshiOrders.js's resolveTarget
// (double opt-in: {base:'live'} AND KALSHIBOT_ORDERS_ALLOW_LIVE='true') is untouched and is
// called from here exactly as it always was. What's new is a THIRD, orchestrator-level gate:
// nothing in this file is even reachable unless orchestrator.js's own KALSHIBOT_LIVE_EXECUTION_MODE
// is explicitly 'demo' or 'live' (default 'off' = paper path, unchanged).
//
// Deliberate deviation from executionStrategy.js: executeWithStrategy() bundles
// placement+wait+check into one blocking async call, which doesn't fit here --
// orchestrator.js's checkpoint cycle must never block for up to 60s (the same constraint that
// made shadowExecution.js's simulation fire-and-forget; checkpoints have fired as little as 60s
// apart live). This file reimplements the same "wait then check" shape as two separate,
// independently-triggerable steps. It DOES reuse executionStrategy.js's already-decided
// LIVE_EXECUTION_STRATEGY_CONFIG values -- the NUMBERS, not the blocking function.
//
// TAKER ESCALATION (added 2026-09-10): if the maker leg is unfilled when its GTT expires,
// finalizeLiveOrder re-checks the edge and a hard price cap against the CURRENT touch price
// (LIVE_EXECUTION_STRATEGY_CONFIG.escalationPriceCapUsd/escalationOrderBufferUsd) and, if both
// clear, places a marketable LIMIT order (never a true market order -- kalshiOrders.js has no
// market-order code path at all) priced at currentTouchPrice + a small buffer. Three possible
// end states: maker-filled, taker-filled, or genuinely void.
//
// ORIGINAL-PLACEMENT CRASH GAP CLOSED (added 2026-09-10, task #12): placeLivePosition now owns
// its own full DB lifecycle (previously orchestrator.js only INSERTed a trades row AFTER a
// confirmed placement return -- a crash during the placeOrderSafely call itself left ZERO
// durable trace of the attempt anywhere, worse than the escalation gap, since there wasn't even
// an existing row to anchor recovery to). Same fix shape as escalation: generate clientOrderId
// and persist a COMPLETE trades row (every column the row will ever need, not a minimal one
// enriched later -- see plan for why a crash immediately after the insert makes a two-step
// insert unsafe) BEFORE calling placeOrderSafely, so a crash at any point after that has a
// durable trail to recover from. Unlike escalation, no atomic "claim" is needed here -- there is
// no multi-caller race for the original placement (evaluateSeriesCheckpoint calls
// placeLivePosition exactly once, synchronously, per checkpoint decision, and the scheduler
// never retries an interrupted checkpoint) -- only the identifier-persist-before-call +
// resolveAmbiguousOrder-recovery half of the escalation pattern applies, not the claim half.
// The recovery logic itself (resolveUnknownOrder below) is now SHARED between the original leg
// and the escalation leg -- they need the identical resolution (a client_order_id was persisted,
// the outcome was never confirmed, scan Kalshi's own order list) against different column pairs.
'use strict';

const { resolveTarget, getOrder, cancelOrder, newClientOrderId } = require('./kalshiOrders');
const { placeOrderSafely, resolveAmbiguousOrder } = require('./orderRetrySafety');
const { LIVE_EXECUTION_STRATEGY_CONFIG } = require('./executionStrategy');
const { getOrderbook } = require('./kalshiClient');
const { edgeClearsFeeAtPrice, feeUsd } = require('./liveSizing');
const { computeFreshMakerPrice } = require('./makerPriceFreshness');
const { checkLiveCapitalAtRisk } = require('./liveCapitalAtRisk');

// How long resolveUnknownOrder tolerates a "not found" scan result before treating it as
// terminal (alert + stop retrying) -- added 2026-09-10 (task #20) after a real demo smoke test
// showed Kalshi's own order-list endpoint can lag a just-placed order by several minutes (not
// found ~0.4s after placement, found again on manual re-check ~4 minutes later, same
// client_order_id, confirmed via a real listOrders call). Decided at 10 minutes, deliberately
// conservative off a single real data point (not the n=67+ sample other tunables in this file
// are grounded in) -- during the wait, the row stays 'pending' with no capital newly at risk (no
// duplicate order gets placed; this is purely a re-SCAN of Kalshi's existing order list) and no
// guess is ever made about won/lost/filled, so the cost of waiting longer is low. Revisit once
// more real data exists.
const NOT_FOUND_RETRY_WINDOW_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Guarded UPDATE for a confirmed fill (maker or taker) -- shared by both finalize paths so the SET list/guard can't drift apart between them. Returns true iff THIS call did the finalizing. */
function finalizeAsFilled(db, tradeId, fillType, filledContracts, fillCostTotalUsd, feesTotalUsd, log, bucketKey, requestedContracts) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE trades
    SET status = 'pending', contracts = @contracts, entry_cost = @entryCost, fee_usd = @feeUsd,
        stake_usd = @stakeUsd, exit_pnl_usd = NULL, fill_type = @fillType, live_fill_checked_at = @now
    WHERE id = @tradeId AND live_fill_checked_at IS NULL
  `).run({
    contracts: filledContracts,
    entryCost: fillCostTotalUsd / filledContracts,
    feeUsd: feesTotalUsd,
    stakeUsd: fillCostTotalUsd + feesTotalUsd,
    fillType,
    now,
    tradeId,
  });
  if (result.changes > 0) {
    log(`live order filled (${fillType})`, { tradeId, bucketKey, contracts: filledContracts, requestedContracts });
  }
  return result.changes > 0;
}

/** Guarded UPDATE for a genuine void (no capital ever at risk) -- shared by every void path (cap/edge failure, rejected placement/escalation, unreadable book, etc.) so they can't silently diverge in what fields get zeroed. */
function finalizeAsVoid(db, tradeId, bucketKey, reason, log) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE trades
    SET status = 'void', contracts = 0, fee_usd = 0, stake_usd = 0, exit_pnl_usd = 0, live_fill_checked_at = @now
    WHERE id = @tradeId AND live_fill_checked_at IS NULL
  `).run({ now, tradeId });
  if (result.changes > 0) {
    log('live order voided', { tradeId, bucketKey, reason });
  }
  return result.changes > 0;
}

/** Writes a live_order_alerts row and logs loudly -- a human must look, this is never auto-resolved. `stage` distinguishes an ambiguous ORIGINAL placement from an ambiguous ESCALATION (see db.js's live_order_alerts.stage CHECK, which already included 'initial' for exactly this reuse). */
function writeOrderAlert(db, { observationId, bucketKey, clientOrderId, base, stage }, details, log) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO live_order_alerts (created_at, observation_id, bucket_key, client_order_id, base, details, stage)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(now, observationId, bucketKey, clientOrderId, base, details, stage);
  log('!!! LIVE ORDER PLACEMENT UNRESOLVED -- manual check needed !!!', { stage, bucketKey, clientOrderId, base, details });
}

/**
 * Shared crash-recovery resolution -- a client_order_id was persisted before a Kalshi call, but
 * the call's outcome was never durably recorded (process died mid-call, or between the call
 * returning and the result being written down). Resolves via the SAME list-and-scan primitive
 * orderRetrySafety.js already uses for its own in-call ambiguity (resolveAmbiguousOrder), not a
 * reinvented check. Parameterized by which column pair to check/update so both the original
 * placement's own (kalshi_order_id) and the escalation leg's (taker_kalshi_order_id) columns
 * share this one implementation instead of two near-identical copies.
 *
 * @param {string} firstAttemptedAtIso - added 2026-09-10 (task #20): the ORIGINAL moment this
 *   order attempt began (existing.created_at for the original-placement recovery branch,
 *   existing.escalation_claimed_at for the escalation recovery branch -- callers already have
 *   this value on hand, it's the same source sinceTs is itself derived from). Used ONLY to decide
 *   whether a not-found result is genuinely terminal yet -- see NOT_FOUND_RETRY_WINDOW_MS.
 * @returns {Promise<{resolved: boolean, kalshiOrderId?: string}>} resolved:true means the order
 *   was found and its id persisted -- caller should let a later pass (or itself) proceed with
 *   normal finalization. resolved:false with the row still non-terminal (live_fill_checked_at
 *   still NULL) means genuinely not found YET, within NOT_FOUND_RETRY_WINDOW_MS of the first
 *   attempt -- reconcileLiveOrders will naturally re-scan this row next cycle, no caller action
 *   needed. resolved:false with the row now terminal means an alert was written -- caller should
 *   just return.
 */
async function resolveUnknownOrder(db, { tradeId, ticker, clientOrderId, kalshiOrderIdColumn, sinceTs, base, observationId, bucketKey, stage, firstAttemptedAtIso }, log) {
  if (kalshiOrderIdColumn !== 'kalshi_order_id' && kalshiOrderIdColumn !== 'taker_kalshi_order_id') {
    throw new Error(`resolveUnknownOrder: unexpected kalshiOrderIdColumn "${kalshiOrderIdColumn}"`); // defensive -- this value is always an internal literal, never external input, but never interpolate an unvalidated column name into SQL
  }

  let resolution;
  try {
    resolution = await resolveAmbiguousOrder({ ticker, clientOrderId, sinceTs, base });
  } catch (err) {
    log('resolveUnknownOrder: resolveAmbiguousOrder failed, will retry next cycle', { tradeId, stage, err: String(err) });
    return { resolved: false };
  }

  if (resolution.found) {
    db.prepare(`UPDATE trades SET ${kalshiOrderIdColumn} = ? WHERE id = ? AND ${kalshiOrderIdColumn} IS NULL`).run(resolution.order.order_id, tradeId);
    log(`resolveUnknownOrder: recovered ${kalshiOrderIdColumn} after a crashed/interrupted attempt`, { tradeId, stage, kalshiOrderId: resolution.order.order_id });
    return { resolved: true, kalshiOrderId: resolution.order.order_id };
  }

  // Not found -- but Kalshi's own order-list endpoint can genuinely lag a just-placed order by
  // several minutes (confirmed live, see NOT_FOUND_RETRY_WINDOW_MS's own comment), so a not-found
  // result this soon after the attempt is NOT necessarily conclusive. Within the retry window:
  // stay quiet, leave live_fill_checked_at NULL so reconcileLiveOrders' own next-cycle scan
  // (its WHERE clause already just checks live_fill_checked_at IS NULL -- no change needed there)
  // naturally retries this row -- no sleep, no blocking, leans entirely on the existing
  // once-per-checkpoint cadence.
  const elapsedMs = Date.now() - new Date(firstAttemptedAtIso).getTime();
  if (elapsedMs < NOT_FOUND_RETRY_WINDOW_MS) {
    log('resolveUnknownOrder: not found yet, within retry window -- will re-scan next reconcile cycle', { tradeId, stage, elapsedMs, retryWindowMs: NOT_FOUND_RETRY_WINDOW_MS });
    return { resolved: false };
  }

  // Genuinely unresolved even after the retry window elapsed -- alert, and stop retrying (this
  // also correctly covers the case where the Kalshi call was never even reached at all, e.g. a
  // crash right after the early INSERT -- indistinguishable from "crashed during the call" purely
  // from DB state, so both are conservatively treated the same: alert, don't guess). Status is
  // deliberately left as-is (still 'pending') rather than guessed as won/lost/void -- nobody
  // knows what actually happened, and the alert is what drives a human to find out.
  writeOrderAlert(
    db,
    { observationId, bucketKey, clientOrderId, base, stage },
    `${stage === 'escalation' ? 'Escalation' : 'Original'} placement outcome unknown after a crashed/interrupted attempt -- client_order_id=${clientOrderId} not found in Kalshi's order list after ${NOT_FOUND_RETRY_WINDOW_MS / 60000} minutes of retrying. Check Kalshi's UI directly.`,
    log
  );
  db.prepare(`UPDATE trades SET live_fill_checked_at = ? WHERE id = ? AND live_fill_checked_at IS NULL`).run(new Date().toISOString(), tradeId);
  return { resolved: false };
}

/**
 * Places one real (postOnly maker) order from a 'trade' decision (liveSizing.js's
 * evaluateOpportunity output, already passed through the drawdown breaker and pilotStakeCap.js).
 * Owns its full DB lifecycle end-to-end (early INSERT, outcome UPDATE, live_order_alerts on
 * ambiguity) -- matches finalizeLiveOrder's already-accepted model of owning every read/write for
 * the order lifecycle it's responsible for, rather than splitting placement-time writes into the
 * caller. See this file's header for why the early INSERT closes a real crash gap.
 *
 * Calls resolveTarget({ base }) itself, FIRST, before any DB write -- deliberate: a
 * misconfiguration (base:'live' without KALSHIBOT_ORDERS_ALLOW_LIVE, or missing credentials)
 * throws right here, before any row exists, and propagates OUT to the caller's own try/catch
 * unchanged (orchestrator.js still wraps this call) -- a config problem never gets a trades row
 * at all, same as before this fix.
 *
 * decision.entryCost maps directly onto placeLimitOrder's `price` param: liveSizing.js's
 * entryCost for a 'no' decision is already `1 - marketPrice`, and placeLimitOrder's own internal
 * `1 - price` conversion for outcomeSide:'no' turns that back into the raw market price Kalshi's
 * `ask` side expects -- round-trips correctly, no extra conversion needed here.
 *
 * @param {object} decision - a 'trade'-action decision from evaluateOpportunity (post pilot cap).
 * @param {object} context
 * @param {string} context.ticker
 * @param {'demo'|'live'} context.base
 * @param {number} context.observationId
 * @param {string} context.bucketKey
 * @param {string} context.series
 * @param {string} context.bucketStatus
 * @param {number|null} context.yesBidAtCheckpoint
 * @param {number|null} context.yesAskAtCheckpoint
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{outcome:'placed'|'resolved'|'rejected'|'unresolved'|'error'|'capital_blocked'|'stale_price_skip', tradeId?:number, clientOrderId?:string, kalshiOrderId?:string, base:string, expirationTime?:number, reason?:string}>}
 *   'capital_blocked' (task #17, 2026-09-11): the ONLY outcome with no tradeId/clientOrderId --
 *   checkLiveCapitalAtRisk blocked this candidate BEFORE the early INSERT ever ran (inside the
 *   same db.transaction() as that INSERT, see below), so unlike every other outcome, no trades
 *   row exists for this attempt at all.
 *   'stale_price_skip' (2026-09-11, see makerPriceFreshness.js): also no trades row -- either
 *   the fresh orderbook read failed, the relevant side of the book was empty, or the edge no
 *   longer clears fee once repriced off the fresh book. Same no-footprint treatment as
 *   'capital_blocked': the checkpoint simply didn't trade this cycle, re-evaluated fresh next time.
 */
async function placeLivePosition(decision, context, db, log) {
  const { ticker, base, observationId, bucketKey, series, bucketStatus, yesBidAtCheckpoint, yesAskAtCheckpoint } = context;

  resolveTarget({ base }); // throws here if misconfigured -- see header, no DB write yet

  // Fresh-orderbook repricing (2026-09-11, see makerPriceFreshness.js's own header for the full
  // investigation) -- decision.entryCost/marketPrice were priced off the checkpoint's
  // CANDLESTICK, which real historical data shows disagrees with the live book often enough
  // (43.1% of 420 real trades) to make the resulting maker order cross and get rejected outright
  // (confirmed live, 2026-09-11: the very first real order hit exactly this). Read the book
  // fresh, right here, BEFORE the capital-check transaction below, so a skip here leaves zero DB
  // footprint -- same treatment as a Kelly-skip, not a wasted trades row.
  let book;
  try {
    book = await getOrderbook(ticker, base);
  } catch (err) {
    return { outcome: 'stale_price_skip', base, reason: `fresh orderbook read failed, skipping this cycle: ${err}` };
  }
  const { freshMarketPrice, freshEntryCost } = computeFreshMakerPrice(decision.side, decision.entryCost, book, LIVE_EXECUTION_STRATEGY_CONFIG.makerPriceSafetyBufferUsd);
  if (freshEntryCost === null) {
    return { outcome: 'stale_price_skip', base, reason: 'no current price available for fresh repricing check (thin book)' };
  }
  // Re-validate the edge at the FRESH (possibly repriced) cost -- reuses the exact same
  // edgeClearsFeeAtPrice already trusted for the escalation leg's own price re-check (below).
  // Without this, repricing to avoid a cross could silently force through a trade that no longer
  // has real edge, purely to dodge an HTTP 400.
  if (!edgeClearsFeeAtPrice(decision.side, decision.calibrationPShrunk, freshEntryCost)) {
    return { outcome: 'stale_price_skip', base, reason: `edge no longer clears fee after fresh-orderbook repricing (candlestick-based entryCost=${decision.entryCost}, fresh entryCost=${freshEntryCost})` };
  }
  // contracts stays fixed at the original Kelly-sized count -- only price changes, so fee/stake
  // are recomputed for the fresh price to keep the $50 cap's accounting accurate. Re-running full
  // Kelly sizing at the fresh price is deliberately out of scope for this fix.
  const freshFee = feeUsd(decision.contracts, freshMarketPrice);
  const freshStakeUsd = decision.contracts * freshEntryCost + freshFee;

  const expirationTime = Math.floor((Date.now() + LIVE_EXECUTION_STRATEGY_CONFIG.restMs) / 1000);
  const clientOrderId = newClientOrderId();
  const now = new Date().toISOString();

  // The durable record of this attempt, written BEFORE any Kalshi call. Populates EVERY column
  // the row will ever need for later finalization (see plan: a crash can happen immediately
  // after this commits, before any second write, so there is no safe "insert identifiers now,
  // enrich later" split) -- only kalshi_order_id stays NULL until the placement outcome is known.
  // status='pending' + kalshi_order_id IS NULL together are the "unconfirmed" sentinel, the same
  // convention escalation already uses for taker_kalshi_order_id IS NULL.
  //
  // Wrapped in db.transaction() together with checkLiveCapitalAtRisk's own SELECT (task #17,
  // 2026-09-11): evaluateSeriesCheckpoint evaluates multiple series concurrently (Promise.all,
  // orchestrator.js), so without this, two series could each read the SAME pre-trade capital
  // total, both see room under the limit, and both insert -- exceeding it even though each
  // individual check looked clean. Wrapping check+insert in one transaction makes this
  // self-enforcing, not just convention: better-sqlite3 throws immediately
  // ("Transaction function cannot return a promise") if this inner function is ever made async,
  // rather than the race silently reopening. The Kalshi network call (placeOrderSafely, below)
  // stays OUTSIDE/after this transaction, unchanged -- only the local capital-accounting step
  // needs atomicity, not the actual order placement.
  const attempt = db.transaction(() => {
    const capitalCheck = checkLiveCapitalAtRisk(db, freshStakeUsd);
    if (capitalCheck.blocked) {
      return { inserted: false, capitalCheck };
    }
    const insertResult = db.prepare(`
      INSERT INTO trades (created_at, mode, observation_id, series, ticker, bucket_key, side, market_price, entry_cost, contracts, fee_usd, stake_usd,
        calibration_n, calibration_p_hat, calibration_p_shrunk, kelly_fraction_raw, kelly_fraction_used, log_only, bucket_status,
        yes_bid_at_checkpoint, yes_ask_at_checkpoint, opened_at,
        execution_env, client_order_id, expiration_time)
      VALUES (@created_at, @mode, @observation_id, @series, @ticker, @bucket_key, @side, @market_price, @entry_cost, @contracts, @fee_usd, @stake_usd,
        @calibration_n, @calibration_p_hat, @calibration_p_shrunk, @kelly_fraction_raw, @kelly_fraction_used, @log_only, @bucket_status,
        @yes_bid_at_checkpoint, @yes_ask_at_checkpoint, @opened_at,
        @execution_env, @client_order_id, @expiration_time)
    `).run({
      created_at: now,
      mode: 'live', // never 'paper' on this path -- see the mode='paper' filters on getBankrollUsd/getBucketPnlUsd/statsServer.js's aggregates
      observation_id: observationId,
      series,
      ticker,
      bucket_key: bucketKey,
      side: decision.side,
      market_price: freshMarketPrice, // fresh-orderbook-derived, not decision.marketPrice -- see header
      entry_cost: freshEntryCost, // fresh-orderbook-derived, not decision.entryCost -- see header
      contracts: decision.contracts,
      fee_usd: freshFee,
      stake_usd: freshStakeUsd,
      calibration_n: decision.calibrationN,
      calibration_p_hat: decision.calibrationPHat,
      calibration_p_shrunk: decision.calibrationPShrunk,
      kelly_fraction_raw: decision.kellyFractionRaw,
      kelly_fraction_used: decision.kellyFractionUsed,
      log_only: 0,
      bucket_status: bucketStatus,
      yes_bid_at_checkpoint: yesBidAtCheckpoint,
      yes_ask_at_checkpoint: yesAskAtCheckpoint,
      opened_at: now,
      execution_env: base, // never set on a paper row -- see db.js's migrate() comment on why this pairing is app-code-enforced, not a DB CHECK
      client_order_id: clientOrderId,
      expiration_time: expirationTime,
    });
    return { inserted: true, tradeId: insertResult.lastInsertRowid };
  })();

  if (!attempt.inserted) {
    // No row was ever created for this attempt -- unlike every other outcome, there is nothing
    // to alert on or later reconcile; the checkpoint simply didn't trade this cycle.
    return { outcome: 'capital_blocked', base, reason: attempt.capitalCheck.reason };
  }
  const tradeId = attempt.tradeId;

  let placement;
  try {
    placement = await placeOrderSafely({
      ticker,
      outcomeSide: decision.side,
      price: freshEntryCost, // fresh-orderbook-derived, not decision.entryCost -- see header
      count: decision.contracts,
      expirationTime,
      clientOrderId, // the SAME id just persisted above, not a new one
      base,
      postOnly: true,
    });
  } catch (err) {
    // Truly unexpected (not one of placeOrderSafely's own structured outcomes) -- can't
    // distinguish this from "maybe it landed anyway" with confidence, so alert rather than
    // assume void, same treatment as escalation's own unexpected-throw handling.
    writeOrderAlert(
      db,
      { observationId, bucketKey, clientOrderId, base, stage: 'initial' },
      `Original placement threw unexpectedly outside placeOrderSafely's own handling: ${err}. Check Kalshi's UI directly.`,
      log
    );
    db.prepare(`UPDATE trades SET live_fill_checked_at = ? WHERE id = ? AND live_fill_checked_at IS NULL`).run(new Date().toISOString(), tradeId);
    return { outcome: 'error', tradeId, clientOrderId, base, reason: String(err) };
  }

  if (placement.outcome === 'rejected') {
    // Kalshi definitely created nothing -- but unlike the pre-fix design, a row already exists
    // (inserted above) and must still reach a terminal state, or reconcileLiveOrders would try
    // it forever (its query only checks live_fill_checked_at/expiration_time). Void, not deleted
    // -- this codebase never deletes real rows, and a void row IS the accurate record: an
    // attempt was made, definitively nothing came of it.
    finalizeAsVoid(db, tradeId, bucketKey, `original placement rejected: ${placement.error}`, log);
    return { outcome: 'rejected', tradeId, clientOrderId, base, reason: placement.error };
  }

  if (placement.outcome === 'unresolved') {
    writeOrderAlert(
      db,
      { observationId, bucketKey, clientOrderId, base, stage: 'initial' },
      `Original placement outcome unresolved -- Kalshi's own order list did not show a match for clientOrderId=${clientOrderId}. Check Kalshi's UI directly.`,
      log
    );
    db.prepare(`UPDATE trades SET live_fill_checked_at = ? WHERE id = ? AND live_fill_checked_at IS NULL`).run(new Date().toISOString(), tradeId);
    return { outcome: 'unresolved', tradeId, clientOrderId, base };
  }

  // 'placed' or 'resolved' -- a real order genuinely exists on Kalshi's book. Record its id now
  // that it's known -- a crash from here on is recoverable via resolveUnknownOrder, which scans
  // for exactly the clientOrderId already persisted above.
  const kalshiOrderId = placement.outcome === 'placed' ? placement.response.order_id : placement.order.order_id;
  db.prepare(`UPDATE trades SET kalshi_order_id = ? WHERE id = ?`).run(kalshiOrderId, tradeId);

  // Fire-and-forget, deliberately NOT awaited -- same non-blocking rationale as shadow
  // simulation: this can run for up to LIVE_EXECUTION_STRATEGY_CONFIG.restMs (60s), and awaiting
  // it here would delay the checkpoint cycle's return. NOT the durable mechanism --
  // reconcileLiveOrders (called every cycle in orchestrator.js) is the actual guarantee if this
  // promise chain is ever lost.
  monitorAndFinalizeLiveOrder({ tradeId, kalshiOrderId, base, restMs: LIVE_EXECUTION_STRATEGY_CONFIG.restMs }, db, log)
    .catch((err) => log('live order monitor failed -- reconcileLiveOrders will catch it next cycle', { bucketKey, err: String(err) }));

  return { outcome: placement.outcome, tradeId, clientOrderId, kalshiOrderId, base, expirationTime };
}

// fetchJson (kalshiClient.js) throws a plain Error whose .message is exactly `HTTP ${status}` --
// no structured status field, no response body attached (confirmed by reading fetchJson itself;
// the body is never parsed on a non-ok response). This is the same regex idiom orderRetrySafety.js's
// isAmbiguousFailure already uses to recover a status code from that shape -- kept local here
// (rather than imported) since isAmbiguousFailure returns a differently-scoped ambiguous/not
// verdict, not a raw status.
function extractHttpStatus(err) {
  const match = String((err && err.message) || err).match(/HTTP (\d\d\d)/);
  return match ? Number(match[1]) : null;
}

/**
 * Shared disambiguation for "cancelOrder reported nothing left to cancel" (task #26,
 * 2026-09-11) -- reached either via a clean reduced_by:0 response (a genuine 200) or via
 * cancelOrder THROWING a 404 (confirmed empirically against Kalshi's real demo API: an order
 * already in a terminal state, e.g. GTT-auto-expired to 'canceled', returns 404 not_found on
 * cancel, not a clean 200 with reduced_by:0 as the OpenAPI spec's response schema alone implied).
 * Both carry the identical information -- nothing is left for THIS cancel to have caught -- so
 * both route through the same follow-up getOrder call and three-way branch.
 *
 * @returns {Promise<boolean>} true means the caller should fall through to escalation (genuinely
 *   zero fill, confirmed). false means this function already fully handled the row (a fill was
 *   recorded, or an inconsistent state was logged for next-cycle retry) -- caller should return.
 */
async function resolveNoReductionState(db, { tradeId, kalshiOrderId, base, bucketKey, requestedContracts, reasonForLog }, log) {
  const order = await getOrder({ orderId: kalshiOrderId, base });
  const makerFilled = Number(order.fill_count_fp) || 0;
  if (order.status === 'executed') {
    finalizeAsFilled(db, tradeId, 'maker', requestedContracts, Number(order.maker_fill_cost_dollars), Number(order.maker_fees_dollars), log, bucketKey, requestedContracts);
    return false;
  }
  if (order.status === 'canceled' && makerFilled > 0 && makerFilled < requestedContracts) {
    finalizeAsFilled(db, tradeId, 'maker', makerFilled, Number(order.maker_fill_cost_dollars), Number(order.maker_fees_dollars), log, bucketKey, requestedContracts);
    return false;
  }
  if (order.status === 'canceled' && makerFilled === 0) {
    return true;
  }
  log('finalizeLiveOrder: no-reduction cancel followed by an inconsistent order state, will retry next cycle', { tradeId, reasonForLog, status: order.status, makerFilled, requestedContracts });
  return false;
}

/**
 * Checks Kalshi's own order status and durably finalizes the trades row. Idempotent throughout
 * -- every write is a guarded UPDATE conditioned on live_fill_checked_at IS NULL (maker/taker
 * fill, void) or escalation_claimed_at IS NULL (the escalation claim itself, combined atomically
 * with taker_client_order_id), so calling this twice for the same row -- the in-memory monitor
 * and a reconciliation pass racing for it, or a genuine repeat call -- is always a safe no-op on
 * whichever call loses the race.
 */
async function finalizeLiveOrder(db, { tradeId, kalshiOrderId, base }, log) {
  const existing = db.prepare(`
    SELECT ticker, side, entry_cost, calibration_p_shrunk, contracts AS requested_contracts,
           bucket_key, observation_id, created_at, client_order_id,
           escalation_claimed_at, taker_client_order_id, taker_kalshi_order_id
    FROM trades WHERE id = ?
  `).get(tradeId);
  if (!existing) {
    log('finalizeLiveOrder: trade row not found, nothing to finalize', { tradeId, kalshiOrderId });
    return;
  }

  // --- Recovery: the ORIGINAL placement's own kalshi_order_id was never confirmed (arrives here
  // as the `kalshiOrderId` parameter, sourced from reconcileLiveOrders' SELECT of the trades row
  // -- a crashed placeLivePosition call leaves this column NULL). MUST run before the maker-fill
  // check below, which would otherwise call getOrder({orderId: null, base}) -- a malformed
  // request, not a clean recovery path. Uses the SAME resolveUnknownOrder primitive escalation's
  // own recovery uses, just against kalshi_order_id/client_order_id instead of the taker_*
  // columns. This should never fire for an escalation-related row -- escalation is only ever
  // reached once the maker leg's OWN kalshi_order_id is already confirmed non-null, so the two
  // recovery paths are mutually exclusive by construction, not by an extra check. ---
  if (!kalshiOrderId) {
    if (!existing.client_order_id) {
      // Should never happen given placeLivePosition always persists client_order_id before any
      // Kalshi call -- defensive log, not a guess at what to do next.
      log('finalizeLiveOrder: kalshi_order_id AND client_order_id both missing -- cannot recover, needs manual investigation', { tradeId });
      return;
    }
    const sinceTs = Math.floor(new Date(existing.created_at).getTime() / 1000) - 5; // small clock-skew buffer, same convention as escalation's own recovery
    const result = await resolveUnknownOrder(db, {
      tradeId, ticker: existing.ticker, clientOrderId: existing.client_order_id,
      kalshiOrderIdColumn: 'kalshi_order_id', sinceTs, base,
      observationId: existing.observation_id, bucketKey: existing.bucket_key, stage: 'initial',
      firstAttemptedAtIso: existing.created_at,
    }, log);
    if (result.resolved) {
      log('finalizeLiveOrder: recovered kalshi_order_id after a crashed original placement -- will finalize next cycle', { tradeId, kalshiOrderId: result.kalshiOrderId });
    }
    return;
  }

  // --- Maker leg check (task #21, 2026-09-10): explicitly CANCELS the maker leg rather than
  // relying on Kalshi's own GTT auto-expiration timing, which this project has no documented
  // confirmation of. Canceling first, before any other read, closes a real gap where escalation
  // could place a taker order while the maker order might still technically be resting.
  //
  // CancelOrderV2Response ({order_id, client_order_id, reduced_by, ts_ms} -- confirmed against
  // the raw OpenAPI spec) has NO distinct error status for "too late, already filled" -- a
  // cancel against an already-fully-filled or already-canceled order still returns 200; reduced_by
  // (the remaining count that got pulled) tells you what actually happened:
  //   - reduced_by === requested contracts: nothing filled, cleanly canceled -- proceed to
  //     escalation below, same as before this fix.
  //   - 0 < reduced_by < requested contracts: a genuine partial fill this cancel just caught --
  //     recorded via finalizeAsFilled at the filled amount. The unfilled remainder is still
  //     deliberately out of scope (unchanged from the original escalation plan's own scoping) --
  //     no escalation for a partial fill either way.
  //   - reduced_by === 0: genuinely ambiguous from reduced_by alone -- either already fully
  //     filled, or already canceled by something else (a racing finalizeLiveOrder call -- the
  //     fire-and-forget monitor vs. a reconcileLiveOrders pass, both legitimately reachable for
  //     the same row at expiration_time -- or Kalshi's own GTT beating this cancel to the punch)
  //     with zero fill. Resolved via one follow-up getOrder call, using status (OrderStatus:
  //     'resting'|'canceled'|'executed', confirmed against the raw spec -- 'executed' is the
  //     only status reachable once fully matched, since 'resting' means live remaining quantity
  //     and 'canceled' means remaining quantity was pulled) together with fill_count_fp:
  //       - status 'executed': a full fill -- finalizeAsFilled at the full requested amount.
  //       - status 'canceled', 0 < fill_count_fp < requested: a partial fill already resolved
  //         before this cancel landed (the racing-caller case) -- same finalizeAsFilled(partial)
  //         treatment as the direct partial-reduction branch, not a fall-through to either of
  //         the other two outcomes.
  //       - status 'canceled', fill_count_fp === 0: genuinely zero fill, already canceled by
  //         something else -- proceed to escalation, same as the clean full-reduction case. This
  //         is the EXPECTED signature of the racing-callers scenario above; both callers reaching
  //         "proceed to escalation" independently is fine -- the atomic escalation_claimed_at
  //         claim further below (pre-existing, unchanged by this fix) is what arbitrates who wins.
  //       - anything else (e.g. status still 'resting' despite a successful reduced_by:0 cancel):
  //         a genuine contract inconsistency, not a legitimate race outcome -- logged and left
  //         untouched, same fail-closed treatment as cancelOrder itself throwing, below.
  //
  // 404-ON-CANCEL (task #26, 2026-09-11): a real demo smoke test showed cancelOrder can THROW
  // `Error('HTTP 404')` (kalshiOrders.js's fetchJson has no structured status/body on a thrown
  // error, only that message string -- see extractHttpStatus above) instead of returning a clean
  // 200/reduced_by:0, when the order is already terminal (here: GTT-auto-expired to 'canceled'
  // moments before this cancel landed). kalshiOrderId is only ever a previously-CONFIRMED order
  // id by the time this code runs (set either by a confirmed placeOrderSafely return or by
  // resolveUnknownOrder finding a real match), so a 404 here cannot mean "this id was never
  // valid." It carries exactly the same information a reduced_by:0 response would -- "nothing is
  // left for me to cancel" -- so it's routed into the identical resolveNoReductionState
  // disambiguation rather than the generic retry-and-bail path below. This is safe even if a 404
  // ever had some other cause (e.g. a ticker/exchange_index routing mismatch): resolveNoReductionState's
  // own getOrder call is an independent, order-id-scoped lookup that re-derives ground truth
  // regardless of why the cancel itself failed. Anything other than 404 (401, 500, 429, network
  // errors -- confirmed against the OpenAPI spec's documented response codes for this endpoint)
  // is genuinely ambiguous/transient and stays on the unchanged generic retry path.
  let cancelResult;
  try {
    cancelResult = await cancelOrder({ orderId: kalshiOrderId, marketTicker: existing.ticker, base });
  } catch (err) {
    const httpStatus = extractHttpStatus(err);
    if (httpStatus !== 404) {
      log('finalizeLiveOrder: maker-leg cancelOrder failed, will retry next cycle', { tradeId, err: String(err) });
      return;
    }
    const proceedToEscalation = await resolveNoReductionState(db, { tradeId, kalshiOrderId, base, bucketKey: existing.bucket_key, requestedContracts: existing.requested_contracts, reasonForLog: '404-on-cancel' }, log);
    if (!proceedToEscalation) return;
    // falls through to escalation below, same as a confirmed canceled+zero-fill via reduced_by:0
  }

  const requestedContracts = existing.requested_contracts;

  if (cancelResult) {
    const reducedBy = parseFloat(cancelResult.reduced_by);
    if (!Number.isFinite(reducedBy) || reducedBy < 0 || reducedBy > requestedContracts) {
      log('finalizeLiveOrder: maker-leg cancelOrder returned an invalid reduced_by, will retry next cycle', { tradeId, rawReducedBy: cancelResult.reduced_by, requestedContracts });
      return;
    }

    if (reducedBy > 0 && reducedBy < requestedContracts) {
      // Partial reduction -- reduced_by is the remaining count pulled, so filled = requested - reduced_by.
      const filledContracts = requestedContracts - reducedBy;
      const order = await getOrder({ orderId: kalshiOrderId, base });
      finalizeAsFilled(db, tradeId, 'maker', filledContracts, Number(order.maker_fill_cost_dollars), Number(order.maker_fees_dollars), log, existing.bucket_key, requestedContracts);
      return;
    }

    if (reducedBy === 0) {
      const proceedToEscalation = await resolveNoReductionState(db, { tradeId, kalshiOrderId, base, bucketKey: existing.bucket_key, requestedContracts, reasonForLog: 'reduced_by_zero' }, log);
      if (!proceedToEscalation) return;
    }
  }

  // reducedBy === requestedContracts (clean full cancel), or a confirmed canceled+zero-fill
  // state via either the reduced_by:0 path or the 404 path (see above) -- both mean nothing
  // filled, proceed to escalation.

  // --- Recovery: a taker order was already placed in a prior (possibly crashed) call --
  // taker_kalshi_order_id is only ever set once we have real confirmation an order exists (see
  // the fresh-attempt path below), so if it's present, check THAT order directly rather than
  // re-claiming or re-placing anything. ---
  if (existing.escalation_claimed_at && existing.taker_kalshi_order_id) {
    let takerOrder;
    try {
      takerOrder = await getOrder({ orderId: existing.taker_kalshi_order_id, base });
    } catch (err) {
      log('finalizeLiveOrder: recovery getOrder failed, will retry next cycle', { tradeId, err: String(err) });
      return;
    }
    const takerFilled = Number(takerOrder.fill_count_fp) || 0;
    if (takerFilled > 0) {
      finalizeAsFilled(db, tradeId, 'taker', takerFilled, Number(takerOrder.taker_fill_cost_dollars), Number(takerOrder.taker_fees_dollars), log, existing.bucket_key, existing.requested_contracts);
    } else if (takerOrder.status !== 'resting') {
      finalizeAsVoid(db, tradeId, existing.bucket_key, 'taker escalation order resolved unfilled (recovery path)', log);
    }
    // else still resting -- its own short GTT will resolve it soon; leave it, next cycle rechecks.
    return;
  }

  // --- Recovery: escalation_claimed_at and taker_client_order_id were set together (see the
  // fresh-escalation-attempt branch below -- they are NEVER written except atomically, in the
  // same statement), but we crashed before ever learning whether the placement actually
  // succeeded (taker_kalshi_order_id still NULL). Shares resolveUnknownOrder with the
  // original-placement recovery branch above -- same resolution, different column pair. ---
  if (existing.escalation_claimed_at && !existing.taker_kalshi_order_id && existing.taker_client_order_id) {
    const sinceTs = Math.floor(new Date(existing.escalation_claimed_at).getTime() / 1000) - 5;
    const result = await resolveUnknownOrder(db, {
      tradeId, ticker: existing.ticker, clientOrderId: existing.taker_client_order_id,
      kalshiOrderIdColumn: 'taker_kalshi_order_id', sinceTs, base,
      observationId: existing.observation_id, bucketKey: existing.bucket_key, stage: 'escalation',
      firstAttemptedAtIso: existing.escalation_claimed_at,
    }, log);
    if (result.resolved) {
      log('finalizeLiveOrder: recovered taker_kalshi_order_id after a crashed escalation attempt -- will finalize next cycle', { tradeId, kalshiOrderId: result.kalshiOrderId });
    }
    return;
  }

  // --- Fresh escalation attempt. Read-only checks FIRST (getOrderbook, price cap, edge
  // recheck) -- safe to re-run redundantly if two calls race for the same unclaimed row, since
  // neither mutates anything. The actual claim (below) is what decides who proceeds. ---
  // getOrderbook's second arg (task #19, 2026-09-10) -- MUST be this escalation's own `base`,
  // not omitted: omitting it would read PRODUCTION's orderbook even for a demo order (the exact
  // bug task #19 closes -- confirmed live via a real demo smoke test on 2026-09-10, which showed
  // this silently succeeding against the wrong environment's data for tickers that happen to
  // exist on both demo and production, e.g. KXBTC/KXETH -- not just failing closed as first
  // assumed).
  let book;
  try {
    book = await getOrderbook(existing.ticker, base);
  } catch (err) {
    finalizeAsVoid(db, tradeId, existing.bucket_key, `orderbook read failed during escalation check: ${err}`, log);
    return;
  }
  // Side-converted, matching shadowExecution.js's exact currentTouchPrice convention -- same
  // units as entry_cost, NOT a raw YES-side price.
  const currentTouchPrice = existing.side === 'yes'
    ? book.bestYesAsk
    : (book.bestYesBid === null ? null : 1 - book.bestYesBid);
  if (currentTouchPrice === null) {
    finalizeAsVoid(db, tradeId, existing.bucket_key, 'no current price available for escalation check (thin book)', log);
    return;
  }

  const priceMoveUsd = Math.abs(currentTouchPrice - existing.entry_cost);
  if (priceMoveUsd > LIVE_EXECUTION_STRATEGY_CONFIG.escalationPriceCapUsd) {
    finalizeAsVoid(db, tradeId, existing.bucket_key, `price moved $${priceMoveUsd.toFixed(4)}, exceeds $${LIVE_EXECUTION_STRATEGY_CONFIG.escalationPriceCapUsd} hard cap -- not chasing`, log);
    return;
  }
  if (!edgeClearsFeeAtPrice(existing.side, existing.calibration_p_shrunk, currentTouchPrice)) {
    finalizeAsVoid(db, tradeId, existing.bucket_key, 'edge no longer clears fee at current price -- not chasing', log);
    return;
  }

  // --- Both checks passed -- NOW claim, atomically combined with persisting
  // taker_client_order_id in the SAME statement (a crash between them would leave a row with
  // escalation_claimed_at set but no taker id at all, a state no recovery branch could detect --
  // found during the escalation work's own review). Whichever racing call's UPDATE executes
  // first in the single-threaded event loop wins; the other sees changes:0 and backs off. ---
  const claimedAt = new Date().toISOString();
  const takerClientOrderId = newClientOrderId();
  const claim = db.prepare(`
    UPDATE trades SET escalation_claimed_at = ?, taker_client_order_id = ?
    WHERE id = ? AND escalation_claimed_at IS NULL
  `).run(claimedAt, takerClientOrderId, tradeId);
  if (claim.changes === 0) {
    return; // someone else already claimed this row (with their own client_order_id) -- they'll finalize it
  }

  // Marketable LIMIT order (never a true market order -- kalshiOrders.js has no market-order
  // code path; postOnly:false only permits crossing, it doesn't remove the price bound). Priced
  // at currentTouchPrice + buffer so it (a) reliably crosses even with a little more movement
  // before landing, and (b) never pays worse than that bound.
  const escalationPrice = currentTouchPrice + LIVE_EXECUTION_STRATEGY_CONFIG.escalationOrderBufferUsd;
  const expirationTime = Math.floor(Date.now() / 1000) + LIVE_EXECUTION_STRATEGY_CONFIG.escalationOrderExpirationSeconds;

  let escalation;
  try {
    escalation = await placeOrderSafely({
      ticker: existing.ticker,
      outcomeSide: existing.side,
      price: escalationPrice,
      count: existing.requested_contracts,
      expirationTime,
      clientOrderId: takerClientOrderId, // the SAME id just persisted above, not a new one
      base,
      postOnly: false,
    });
  } catch (err) {
    writeOrderAlert(
      db,
      { observationId: existing.observation_id, bucketKey: existing.bucket_key, clientOrderId: takerClientOrderId, base, stage: 'escalation' },
      `Escalation placement threw unexpectedly outside placeOrderSafely's own handling: ${err}. Check Kalshi's UI directly.`,
      log
    );
    db.prepare(`UPDATE trades SET live_fill_checked_at = ? WHERE id = ? AND live_fill_checked_at IS NULL`).run(new Date().toISOString(), tradeId);
    return;
  }

  if (escalation.outcome === 'rejected') {
    finalizeAsVoid(db, tradeId, existing.bucket_key, `taker escalation rejected: ${escalation.reason}`, log);
    return;
  }
  if (escalation.outcome === 'unresolved') {
    writeOrderAlert(
      db,
      { observationId: existing.observation_id, bucketKey: existing.bucket_key, clientOrderId: takerClientOrderId, base, stage: 'escalation' },
      `Escalation placement outcome unresolved -- Kalshi's own order list did not show a match for clientOrderId=${takerClientOrderId}. Check Kalshi's UI directly.`,
      log
    );
    db.prepare(`UPDATE trades SET live_fill_checked_at = ? WHERE id = ? AND live_fill_checked_at IS NULL`).run(new Date().toISOString(), tradeId);
    return;
  }

  // 'placed' or 'resolved' -- a real taker order exists. Record its id immediately (before the
  // wait below) so a crash from here on is recoverable via the "taker order already recorded"
  // branch above, not the weaker list-and-scan branch.
  const takerKalshiOrderId = escalation.outcome === 'placed' ? escalation.response.order_id : escalation.order.order_id;
  db.prepare(`UPDATE trades SET taker_kalshi_order_id = ? WHERE id = ?`).run(takerKalshiOrderId, tradeId);

  await sleep(LIVE_EXECUTION_STRATEGY_CONFIG.escalationOrderExpirationSeconds * 1000);
  const takerOrder = await getOrder({ orderId: takerKalshiOrderId, base });
  const takerFilled = Number(takerOrder.fill_count_fp) || 0;
  if (takerFilled > 0) {
    finalizeAsFilled(db, tradeId, 'taker', takerFilled, Number(takerOrder.taker_fill_cost_dollars), Number(takerOrder.taker_fees_dollars), log, existing.bucket_key, existing.requested_contracts);
  } else {
    finalizeAsVoid(db, tradeId, existing.bucket_key, 'taker escalation order expired unfilled', log);
  }
}

/**
 * Fire-and-forget convenience wrapper: waits restMs, then finalizes. Exists purely for dashboard
 * responsiveness -- this is explicitly NOT the durable mechanism. If this promise chain is lost
 * (process restart, or a silent failure that doesn't crash the process), the order is not lost --
 * reconcileLiveOrders below is the actual guarantee.
 */
async function monitorAndFinalizeLiveOrder({ tradeId, kalshiOrderId, base, restMs }, db, log) {
  await sleep(restMs);
  await finalizeLiveOrder(db, { tradeId, kalshiOrderId, base }, log);
}

/**
 * The durable backstop -- call once per checkpoint cycle. Finds any live order whose GTT should
 * have already resolved (filled or expired) on Kalshi's side but whose trade row was never
 * finalized locally -- a lost monitorAndFinalizeLiveOrder promise chain, a crashed escalation
 * attempt, or (as of this fix) a crashed ORIGINAL placement attempt, would otherwise leave stuck.
 *
 * Deliberately NOT filtered by execution_env -- demo rows get the exact same durable
 * reconciliation as live rows.
 */
async function reconcileLiveOrders(db, log) {
  const nowTs = Math.floor(Date.now() / 1000);
  const stale = db.prepare(`
    SELECT id AS trade_id, kalshi_order_id, execution_env
    FROM trades
    WHERE mode = 'live'
      AND status = 'pending'
      AND live_fill_checked_at IS NULL
      AND expiration_time <= ?
  `).all(nowTs);

  let reconciled = 0;
  for (const row of stale) {
    try {
      await finalizeLiveOrder(db, { tradeId: row.trade_id, kalshiOrderId: row.kalshi_order_id, base: row.execution_env }, log);
      reconciled += 1;
    } catch (err) {
      // One bad row must not block the rest -- same per-item try/catch discipline as
      // settlement.js's settlePendingObservations loop. Left 'pending', picked up again next cycle.
      log('reconcileLiveOrders: finalize failed, will retry next cycle', { tradeId: row.trade_id, kalshiOrderId: row.kalshi_order_id, err: String(err) });
    }
  }
  return { checked: stale.length, reconciled };
}

module.exports = { placeLivePosition, finalizeLiveOrder, monitorAndFinalizeLiveOrder, reconcileLiveOrders };
