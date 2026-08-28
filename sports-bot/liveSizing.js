// Per-opportunity live sizing. This replaces the batch-replay loop in the backtest scripts
// with a single function that evaluates ONE live opportunity at a time -- the shape a real
// orchestrator actually needs (scan a market, decide, move on), not a month replayed in one
// pass.
//
// GO SLOW HERE: this re-implements the exact Kelly/pricing math that had a one-line bug
// hide inside it for five iterations (backtestApril2026.js:165 -- `side==='YES' ? fill.price
// : 1-fill.price` double-inverted an already side-correct price). The fix that mattered
// wasn't a smarter formula, it was removing a redundant operation. This function is
// structured so that operation has nowhere left to hide: `opp.price` is documented as
// already being the price of the side we're buying, and nothing in this file touches it
// beyond reading it directly into the Kelly formula. No ternary on price, anywhere.
'use strict';

const { makeBucketKey } = require('./buckets');

const THETA = 0.05; // Polymarket US sports taker fee rate
const KELLY_FRACTION = 0.225; // fractional Kelly (22.5% of full Kelly)
const KELLY_CAP_PCT = 0.02; // per-trade cap, 2% of current bankroll
const DEPTH_CAP_PCT = 0.20; // never stake more than 20% of available depth
const MIN_BET_USD = 1; // Polymarket's real market-order minimum
const CAP_SHRINK_THRESHOLD = 30; // matches MIN_TRUSTED_N used throughout this project

/** capScale(n) = min(1, n/30) -- untouched at n>=30, tapers the cap down for thinner holdouts. */
function capScale(n) {
  return Math.min(1, n / CAP_SHRINK_THRESHOLD);
}

/**
 * Evaluates one live opportunity against current bankroll and the holdout table. Pure
 * function: no I/O, no mutation of its arguments, so it's directly unit-testable and
 * directly replayable in the historical reproduction harness with no adapter layer.
 *
 * @param {object} opp
 * @param {'nba'|'nhl'|'mlb'} opp.sport
 * @param {'moneyline'|'spread'|'total'} opp.marketType
 * @param {'h3'|'h24'} opp.horizon
 * @param {string} opp.band
 * @param {'YES'|'NO'} opp.side - which side WE hold. Must match the bucket's own defined
 *   side (checked below) -- this function doesn't choose a side, that's fixed per bucket.
 * @param {number} opp.price - the price of the side we are buying, from a real fill/quote.
 *   NOT the opposing side's price. NOT re-flipped by this function under any circumstance.
 * @param {number} opp.availableDepthUsd - real-time available liquidity for the depth cap.
 *   Production: depthCheck.js's live BBO query. Historical reproduction harness: the
 *   backtest's own nearbyNotionalUsd value (see harness for why).
 * @param {number} cashUsd - current available (uncommitted) bankroll.
 * @param {object} holdoutTable - output of computeHoldoutTable/refreshHoldoutTable, keyed
 *   by bucket_key (sport|marketType|horizon|band).
 */
function evaluateOpportunity(opp, cashUsd, holdoutTable) {
  // The NHL-total seasonal exclusion check that used to live here is gone along with the
  // NHL total bucket itself (dropped 2026-08-26, failed re-validation on corrected data --
  // see buckets.js). There's no longer a resolutionDate-dependent gate at this stage.
  const bucketKey = makeBucketKey(opp.sport, opp.marketType, opp.horizon, opp.band);
  const holdout = holdoutTable[bucketKey];
  if (!holdout || holdout.n === 0 || holdout.pTrue === null) {
    return { action: 'skip', reason: `no holdout data for bucket ${bucketKey}`, bucketKey };
  }
  if (holdout.side !== opp.side) {
    // Defensive: if the opportunity's side and the bucket's defined side disagree,
    // something upstream mismatched a market to the wrong bucket. Refuse rather than
    // silently size a trade in the wrong direction.
    return { action: 'skip', reason: `side mismatch: opportunity side ${opp.side} != bucket-defined side ${holdout.side}`, bucketKey };
  }

  // opp.price is already the price of the side we're buying. No adjustment applied here --
  // see module header for why that matters.
  const price = opp.price;

  const kellyFractionRaw = Math.max(0, Math.min(1, (holdout.pTrue - price) / (1 - price)));
  if (kellyFractionRaw <= 0) {
    return { action: 'skip', reason: 'zero/negative edge', bucketKey, holdoutN: holdout.n, holdoutPTrue: holdout.pTrue };
  }

  const effectiveCapPct = KELLY_CAP_PCT * capScale(holdout.n);
  let stake = cashUsd * Math.min(kellyFractionRaw * KELLY_FRACTION, effectiveCapPct);

  const depthCapStake = DEPTH_CAP_PCT * (opp.availableDepthUsd || 0);
  stake = Math.min(stake, depthCapStake);

  const feeRatio = THETA * (1 - price);
  let totalOutlay = stake * (1 + feeRatio);
  if (totalOutlay > cashUsd) {
    stake = cashUsd / (1 + feeRatio);
    totalOutlay = cashUsd;
  }

  if (stake < MIN_BET_USD) {
    return {
      action: 'skip',
      reason: 'below $1 minimum after caps',
      bucketKey,
      holdoutN: holdout.n,
      holdoutPTrue: holdout.pTrue,
      kellyFractionRaw,
      effectiveCapPct,
    };
  }

  const quantity = stake / price;
  const fee = quantity * THETA * price * (1 - price);

  return {
    action: 'trade',
    bucketKey,
    price,
    stake,
    fee,
    quantity,
    totalOutlay: stake + fee,
    holdoutN: holdout.n,
    holdoutPTrue: holdout.pTrue,
    kellyFractionRaw,
    effectiveCapPct,
  };
}

module.exports = {
  evaluateOpportunity,
  capScale,
  CAP_SHRINK_THRESHOLD,
  KELLY_CAP_PCT,
  KELLY_FRACTION,
  DEPTH_CAP_PCT,
  MIN_BET_USD,
  THETA,
};
