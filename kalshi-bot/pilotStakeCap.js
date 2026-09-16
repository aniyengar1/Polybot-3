// Pilot-period stake cap -- a TEMPORARY override on top of liveSizing.js's Kelly sizing,
// meant to bound per-trade risk during an early live/pilot window regardless of what Kelly
// would otherwise size. Deliberately isolated in its own file (not folded into liveSizing.js)
// so the entire pilot mechanism is one file to delete plus one require line to remove once the
// pilot period ends -- nothing else in this codebase should ever come to depend on this file.
//
// NOT wired in yet. This file is pure, standalone logic -- nothing currently calls
// applyPilotStakeCap from anywhere in the live trading path (orchestrator.js still uses
// liveSizing.js's evaluateOpportunity output completely unmodified).
//
// TO WIRE IN (deferred to a later, separate task):
//   1. Pick the actual PILOT_STAKE_CAP value together (see the placeholder below -- do not
//      guess a number here) and flip PILOT_MODE_ENABLED to true.
//   2. In orchestrator.js's evaluateSeriesCheckpoint, call
//        decision = applyPilotStakeCap(decision, bankrollUsd);
//      immediately after `const decision = evaluateOpportunity(...)` (around line 144, before
//      the `decision.action !== 'trade'` check that follows it) -- so a decision the pilot cap
//      reduces to below 1 contract correctly falls through the existing 'skip' handling, and a
//      capped-but-still-tradeable decision flows into the existing execResult/DB insert exactly
//      as evaluateOpportunity's own output does today.
//   3. To turn the pilot cap back off: set PILOT_MODE_ENABLED = false (or delete this file and
//      the one call site added in step 2) -- no other file needs touching.
'use strict';

const { feeUsd } = require('./liveSizing');

// Single flag, single place to flip. false = completely inert (applyPilotStakeCap is a no-op
// passthrough below) -- this is the "trivially removable" switch.
const PILOT_MODE_ENABLED = false;

// Exactly ONE of these should be set once PILOT_MODE_ENABLED is flipped to true; leave the
// other null. Deliberately left unset -- pick the real number together before launch, this is
// not a value to guess or default.
const PILOT_STAKE_CAP = {
  usd: 1.00, // fixed dollar cap per trade, regardless of bankroll size -- set 2026-09-09, PILOT_MODE_ENABLED left false until actual launch (see header)
  pct: null, // fixed fraction of CURRENT bankroll per trade (decimal, same convention as buckets.js's KELLY_CAP_PCT) -- unused, .usd is set instead
};

/** Resolves PILOT_STAKE_CAP to a dollar figure for the current bankroll. Throws rather than silently no-op-ing if pilot mode is on but no cap was ever configured -- an enabled-but-unconfigured cap is a setup mistake, not a valid "no cap" state. */
function resolvePilotCapUsd(cashUsd) {
  if (PILOT_STAKE_CAP.usd !== null) return PILOT_STAKE_CAP.usd;
  if (PILOT_STAKE_CAP.pct !== null) return cashUsd * PILOT_STAKE_CAP.pct;
  throw new Error('PILOT_MODE_ENABLED is true but neither PILOT_STAKE_CAP.usd nor PILOT_STAKE_CAP.pct is set -- pick the pilot cap value before enabling this.');
}

/**
 * Pure function. Takes a liveSizing.js evaluateOpportunity() output and the current bankroll,
 * and -- ONLY if PILOT_MODE_ENABLED -- clamps the stake DOWN to the pilot cap if Kelly's own
 * sizing (already passed through buckets.js's KELLY_CAP_PCT) would exceed it. Never sizes UP to
 * the cap -- a Kelly stake already below the pilot cap is returned completely unchanged. If the
 * cap can't afford even 1 contract, returns a 'skip' decision (mirrors evaluateOpportunity's own
 * skip shape) rather than a 0-or-negative-contract trade.
 *
 * @param {object} decision - evaluateOpportunity's return value (action 'trade' or 'skip').
 * @param {number} cashUsd - current bankroll, same value evaluateOpportunity was called with.
 * @returns {object} decision, unchanged if pilot mode is off / decision isn't a trade / the
 *   Kelly stake is already under the cap; otherwise a copy with contracts/fee/stakeUsd
 *   recomputed under the cap, or a 'skip' decision if the cap can't afford 1 contract.
 */
function applyPilotStakeCap(decision, cashUsd) {
  if (!PILOT_MODE_ENABLED) return decision;
  if (decision.action !== 'trade') return decision;

  const capUsd = resolvePilotCapUsd(cashUsd);
  if (decision.stakeUsd <= capUsd) {
    return { ...decision, pilotCapApplied: false };
  }

  const feePerContractApprox = 0.07 * decision.marketPrice * (1 - decision.marketPrice);
  let contracts = Math.floor(capUsd / (decision.entryCost + feePerContractApprox));
  while (contracts > 0 && contracts * decision.entryCost + feeUsd(contracts, decision.marketPrice) > capUsd) {
    contracts -= 1;
  }
  if (contracts < 1) {
    return {
      action: 'skip',
      reason: `pilot stake cap ($${capUsd.toFixed(2)}) below 1-contract minimum at entryCost=$${decision.entryCost.toFixed(4)}`,
      bucketKey: decision.bucketKey,
      pilotCapUsd: capUsd,
    };
  }

  const fee = feeUsd(contracts, decision.marketPrice);
  return {
    ...decision,
    contracts,
    fee,
    stakeUsd: contracts * decision.entryCost + fee,
    pilotCapApplied: true,
    pilotCapUsd: capUsd,
  };
}

module.exports = { applyPilotStakeCap, PILOT_MODE_ENABLED, PILOT_STAKE_CAP };
