// Per-checkpoint Kelly sizing. Same "go slow, no ternary hiding a re-flip bug" discipline as
// sports-bot/liveSizing.js's header describes -- independently reimplemented for Kalshi's own
// contract/fee mechanics, not shared code.
//
// Fee schedule: real, verified quadratic taker formula (Theta=0.07), confirmed via
// /Users/anirudhiyengar/soccer-research/KALSHI_15MIN_FEE_SURVIVAL.md and re-confirmed
// specifically for gold/silver in KALSHI_GOLD_SILVER_15MIN_TEST.md ("standard quadratic (same
// formula as rest of session)", no maker-fee override the way MLB has one). This bot only
// ever holds to settlement (single entry, no round-trip), matching what was backtested.
//
// IMPORTANT deliberate deviation from backtestGoldSilverThreeBucket.js's own fee
// approximation: that script computed a PER-CONTRACT fee (ceil-to-cent on ONE contract) and
// multiplied by contract count. The real, verified formula (fee_survival memory) rounds up
// ONCE on the aggregate: round_up(0.07 * contracts * p * (1-p)). Per-contract-then-multiply
// systematically overstates fees once contracts>1 (e.g. p=0.5, 10 contracts: aggregate
// ceil(17.5)=18c vs per-contract-summed 10*ceil(1.75)=20c). The task asked for "realistic
// P&L tracking", so this uses the real aggregate formula, not the backtest script's
// per-contract simplification -- a deliberate improvement, not an inconsistency with the
// backtested numbers (which were dollar-conservative, if anything).
'use strict';

const { BUCKET_CONFIG, KELLY_CAP_PCT, MIN_CALIBRATION_N } = require('./buckets');
const { getShrunkHitRate } = require('./calibration');

/** Real Kalshi quadratic fee, rounded up once on the whole order. p = price of the side being priced (already side-adjusted by the caller). */
function feeUsd(contracts, p) {
  return Math.ceil(0.07 * contracts * p * (1 - p) * 100) / 100;
}

/**
 * Given an ALREADY-DECIDED side and an already-calibrated pShrunk (frozen at the original
 * signal), checks whether the edge still clears the fee at a NEW price. Built 2026-09-10 for
 * liveExecution.js's taker-escalation price re-check (see its own header) -- does NOT re-select
 * a side or re-run calibration, those are fixed by the time escalation happens; this only
 * answers "is the edge still there at this price."
 *
 * `costOfSide` MUST be the cost of buying the given `side` -- i.e. the SAME convention as
 * decision.entryCost and shadowExecution.js's own currentTouchPrice (side==='yes' ?
 * book.bestYesAsk : (1 - book.bestYesBid)), NOT a raw YES-side market price. This is
 * deliberately a single side-agnostic formula (pRelevant - costOfSide), not two branches that
 * each do their own "1 - price" conversion the way evaluateOpportunity's inline edgeYes/edgeNo
 * do below -- caught during review that feeding an already-side-converted price into that
 * two-branch shape double-converts on the 'no' side and silently produces the wrong (and not
 * just wrongly-scaled, economically meaningless) edge value. This shape can't be fed the wrong
 * convention by construction: it takes exactly the value every call site already has on hand
 * (a "cost of my side" figure), with no conversion step left for a caller to get wrong.
 * Verified algebraically equivalent to evaluateOpportunity's edgeYes/edgeNo when given a raw
 * price ((1-pShrunk)-(1-rawPrice) simplifies to rawPrice-pShrunk, same as pRelevant-costOfSide
 * when costOfSide=1-rawPrice) -- not a behavior change for existing math, just a shape that
 * can't silently double-convert.
 */
function edgeClearsFeeAtPrice(side, pShrunk, costOfSide) {
  const feePerContractApprox = 0.07 * costOfSide * (1 - costOfSide); // symmetric under p vs 1-p -- same value regardless of which side's convention costOfSide is already in
  const pRelevant = side === 'yes' ? pShrunk : (1 - pShrunk);
  return (pRelevant - costOfSide) > feePerContractApprox;
}

/**
 * Evaluates one checkpoint against current bankroll. Pure except for the calibration read
 * (getShrunkHitRate hits the DB but takes no other I/O / mutation here).
 *
 * @param {object} opp
 * @param {string} opp.bucketKey - '{series}|{band}', must be a key in BUCKET_CONFIG
 * @param {number} opp.price - raw YES-side market price at the checkpoint
 * @param {number} cashUsd - current paper bankroll
 */
function evaluateOpportunity(opp, cashUsd) {
  const config = BUCKET_CONFIG[opp.bucketKey];
  if (!config) {
    return { action: 'skip', reason: `bucket ${opp.bucketKey} not in the 3 allowed buckets`, bucketKey: opp.bucketKey };
  }

  const { n, pHat, pShrunk } = getShrunkHitRate(opp.bucketKey, opp.price);
  if (n < MIN_CALIBRATION_N) {
    return { action: 'skip', reason: `calibration n=${n} below floor ${MIN_CALIBRATION_N}`, bucketKey: opp.bucketKey };
  }

  // Which side has positive edge, using the SHRUNK rate (never the raw pHat) for the
  // decision -- shrinkage is applied before the edge is computed, not just before sizing,
  // so a fading bucket's edge actually disappears from the decision, not just gets sized
  // smaller. price = cost of buying YES; (1-price) = cost of buying NO.
  const feePerContractApprox = 0.07 * opp.price * (1 - opp.price); // pre-rounding, for the edge-vs-fee comparison only
  const edgeYes = pShrunk - opp.price;
  const edgeNo = (1 - pShrunk) - (1 - opp.price); // = opp.price - pShrunk, i.e. -edgeYes -- kept explicit, not derived, so a future edit to one side's formula can't silently desync from the other
  let side, entryCost, pRelevant;
  if (edgeYes > feePerContractApprox && edgeYes >= edgeNo) {
    side = 'yes'; entryCost = opp.price; pRelevant = pShrunk;
  } else if (edgeNo > feePerContractApprox) {
    side = 'no'; entryCost = 1 - opp.price; pRelevant = 1 - pShrunk;
  } else {
    return { action: 'skip', reason: 'no edge clears fee on either side', bucketKey: opp.bucketKey, n, pHat, pShrunk };
  }

  // Validated-direction constraint (added 2026-09-08, see buckets.js's header): every bucket
  // was search+holdout confirmed for exactly ONE direction, but the edge formula above has no
  // concept of that -- it happily fires whichever side currently clears the fee, including the
  // untested direction whenever live calibration crosses price the "wrong" way. A live
  // diagnostic found 7/154 real trades doing exactly this, all losses. This is the one and only
  // place `side` gets decided, so this is the one and only place that needs the check.
  if (side !== config.validatedSide) {
    return {
      action: 'skip',
      reason: `computed side '${side}' contradicts this bucket's validated direction '${config.validatedSide}' (edgeYes=${edgeYes.toFixed(4)}, edgeNo=${edgeNo.toFixed(4)})`,
      bucketKey: opp.bucketKey, n, pHat, pShrunk,
    };
  }

  const kellyFractionRaw = Math.max(0, Math.min(1, (pRelevant - entryCost) / (1 - entryCost)));
  if (kellyFractionRaw <= 0) {
    return { action: 'skip', reason: 'zero/negative Kelly fraction after side selection', bucketKey: opp.bucketKey, n, pHat, pShrunk };
  }

  const kellyFractionUsed = config.kellyFraction;
  const targetStakePct = Math.min(kellyFractionRaw * kellyFractionUsed, KELLY_CAP_PCT);
  const riskDollars = cashUsd * targetStakePct;

  // Solve contracts under the REAL (non-approximated) aggregate fee formula: start from the
  // fee-free estimate and decrement until affordable -- contract counts here are always
  // small (bankroll-capped at 1%), so this loop is a handful of iterations at most.
  let contracts = Math.floor(riskDollars / (entryCost + feePerContractApprox));
  while (contracts > 0 && contracts * entryCost + feeUsd(contracts, opp.price) > riskDollars) {
    contracts -= 1;
  }
  if (contracts < 1) {
    return { action: 'skip', reason: 'below 1-contract minimum after 1% cap', bucketKey: opp.bucketKey, n, pHat, pShrunk, kellyFractionRaw };
  }

  const fee = feeUsd(contracts, opp.price);
  const stakeUsd = contracts * entryCost + fee;

  return {
    action: 'trade',
    bucketKey: opp.bucketKey,
    side,
    marketPrice: opp.price,
    entryCost,
    contracts,
    fee,
    stakeUsd,
    calibrationN: n,
    calibrationPHat: pHat,
    calibrationPShrunk: pShrunk,
    kellyFractionRaw,
    kellyFractionUsed,
  };
}

module.exports = { evaluateOpportunity, feeUsd, edgeClearsFeeAtPrice };
