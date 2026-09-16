// Pre-trade capital-at-risk gate for the live-execution path -- bounds how much real capital can
// be committed to still-unresolved live orders at once, regardless of what any single trade's
// own Kelly sizing would otherwise allow. Deliberately isolated in its own file (same convention
// as pilotStakeCap.js/drawdownBreaker.js): one independently reviewable, removable concern, not
// folded into orchestrator.js or liveExecution.js.
//
// Unlike pilotStakeCap.js/drawdownBreaker.js (both built standalone, wired in as a LATER,
// separate task), this file is wired into liveExecution.js as part of the SAME task that adds it
// -- no reason to defer wiring a pre-live-money safety gate the way those two optional tunables
// were deliberately deferred. Called from INSIDE placeLivePosition's own db.transaction() (see
// that function's header for why), not from orchestrator.js directly -- the check needs to be
// atomic with the trades INSERT it gates, not just called sometime before it.
'use strict';

// Fixed dollar ceiling on total capital committed to unresolved live orders at any moment -- NOT
// derived from account balance/bankroll. Decided 2026-09-11 at $50, deliberately a placeholder
// pending real live trading history -- revisit once the bot has actually run live for a while and
// there's real data to size this against (same "decide the number together, don't guess"
// discipline as every other real-money constant in this project).
const LIVE_CAPITAL_AT_RISK_LIMIT_USD = 50;

/**
 * Computes current live capital-at-risk (SUM of stake_usd across every still-unresolved live
 * trades row) and checks whether admitting `candidateStakeUsd` on top of that would reach or
 * exceed LIVE_CAPITAL_AT_RISK_LIMIT_USD. A momentary capacity check, not a durable halt --
 * re-evaluated fresh every call, nothing persisted (contrast drawdownBreaker.js's own durable
 * halted state, which latches until a human clears it).
 *
 * status = 'pending' alone is the correct filter for every state that represents real or
 * possibly-real capital: an early-inserted-but-unconfirmed row, a resting maker order, a
 * confirmed fill awaiting market resolution, an in-flight escalation, and a genuinely-unresolved
 * row still inside task #20's 10-minute retry window (which never gets voided, so stake_usd stays
 * at its original non-zero value) all stay 'pending'. A cleanly voided row (finalizeAsVoid) already
 * zeroes stake_usd AND flips status to 'void', so it's excluded either way.
 *
 * Fails CLOSED: if the query itself throws (a genuine DB-level failure -- COALESCE already
 * handles the "no rows" case, so this only fires for something actually wrong), treated as
 * "capacity unknown, assume at limit," blocking the candidate trade. Undercounting capital at
 * risk is strictly worse than overcounting (a missed trade), so an unknown state must never be
 * read as "clear to trade."
 *
 * Comparison is >=, not >: reaching the limit exactly is treated as "no more room," not just
 * exceeding it -- the more conservative reading of a ceiling.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} candidateStakeUsd - the stake this checkpoint's own decision would commit if
 *   allowed to proceed (decision.stakeUsd, post pilot-cap).
 * @returns {{blocked: boolean, reason: string|null, currentAtRiskUsd: number|null, candidateStakeUsd: number, limitUsd: number}}
 *   blocked:false means the trade may proceed; reason is always null in that case.
 *   blocked:true always carries a non-null, human-readable reason (limit reached/exceeded, OR a
 *   query failure).
 */
function checkLiveCapitalAtRisk(db, candidateStakeUsd) {
  let currentAtRiskUsd;
  try {
    currentAtRiskUsd = db.prepare(`SELECT COALESCE(SUM(stake_usd), 0) AS s FROM trades WHERE mode = 'live' AND status = 'pending'`).get().s;
  } catch (err) {
    return {
      blocked: true,
      reason: `live capital-at-risk query failed, assuming at capacity: ${err}`,
      currentAtRiskUsd: null,
      candidateStakeUsd,
      limitUsd: LIVE_CAPITAL_AT_RISK_LIMIT_USD,
    };
  }

  const projectedAtRiskUsd = currentAtRiskUsd + candidateStakeUsd;
  if (projectedAtRiskUsd >= LIVE_CAPITAL_AT_RISK_LIMIT_USD) {
    return {
      blocked: true,
      reason: `live capital-at-risk limit would be reached or exceeded: $${currentAtRiskUsd.toFixed(2)} already at risk + $${candidateStakeUsd.toFixed(2)} candidate stake = $${projectedAtRiskUsd.toFixed(2)}, limit is $${LIVE_CAPITAL_AT_RISK_LIMIT_USD.toFixed(2)}`,
      currentAtRiskUsd,
      candidateStakeUsd,
      limitUsd: LIVE_CAPITAL_AT_RISK_LIMIT_USD,
    };
  }

  return { blocked: false, reason: null, currentAtRiskUsd, candidateStakeUsd, limitUsd: LIVE_CAPITAL_AT_RISK_LIMIT_USD };
}

module.exports = { checkLiveCapitalAtRisk, LIVE_CAPITAL_AT_RISK_LIMIT_USD };
