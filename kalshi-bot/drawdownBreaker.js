// Peak-to-trough drawdown breaker -- global (total paper bankroll) and per-bucket (a single
// bucket's own cumulative realized P&L contribution). Deliberately separate from
// pilotStakeCap.js (a sizing limit) even though both are pre-order-placement guards: this is a
// halt, not a size reduction, and the two are independent knobs that should each be reviewable
// and removable on their own.
//
// Wired in (2026-09-09) -- orchestrator.js's evaluateSeriesCheckpoint calls
// evaluateAndPersistDrawdownBreaker() before Kelly sizing is computed, checking both global
// (total bankroll) and this specific bucket's own P&L in one call; see orchestrator.js:166-179
// for the exact call site and ordering rationale. checkDrawdownBreaker() below is the pure-logic
// half; evaluateAndPersistDrawdownBreaker() adds the durable-state layer (drawdown_breaker_state,
// in db.js's schema).
//
// STILL DEFERRED, ON PURPOSE: there is no manual re-enable path anywhere in this file (see
// checkDrawdownBreaker's own header) -- once halted, a scope stays halted until someone edits
// drawdown_breaker_state by hand. A `node cli.js drawdown-reset <scope>` command that clears
// .halted after a human has actually looked at why it fired would be the natural fix, not built
// here on purpose -- an auto-or-easy resume would defeat the entire point of a circuit breaker.
'use strict';

const GLOBAL_DRAWDOWN_THRESHOLD_PCT = 0.10; // halt ALL trading if total bankroll is down >=10% from its own peak
const BUCKET_DRAWDOWN_THRESHOLD_PCT = 0.10; // halt just ONE bucket if its own P&L is down >=10% of PEAK total bankroll -- see checkDrawdownBreaker's header for why peak, not current

function nowIso() {
  return new Date().toISOString();
}

/**
 * Pure verdict function -- no I/O, no mutation. Checks the global breaker first; a global halt
 * takes priority over (and is returned instead of) any bucket-level verdict, since once
 * everything is halted a specific bucket's own state doesn't change the outcome for that call.
 * Returns the FIRST breaker that trips, not both simultaneously.
 *
 * The bucket-level threshold is deliberately measured against globalPeakBankrollUsd (the
 * high-water mark), NOT globalBankrollUsd (the current value) -- using current bankroll would
 * make the dollar bar for halting a bucket shrink as losses (including that same bucket's own
 * losses) pull the portfolio down, a mild self-reinforcing effect: the worse things get, the
 * easier it becomes to trip, purely because the denominator moved, not because the bucket got
 * any worse in absolute terms. Pinning to the peak gives a fixed, auditable dollar amount that
 * only changes when the portfolio makes a new all-time high. Genuine portfolio-wide capital
 * shrinkage is already the global breaker's job (checked first, above) -- the per-bucket
 * breaker's job is to isolate ONE bucket's own bad behavior without being confounded by
 * portfolio-wide effects, including effects that bucket itself is causing.
 *
 * @param {object} currentState
 * @param {number} currentState.globalBankrollUsd - current total paper bankroll
 * @param {number} currentState.globalPeakBankrollUsd - running high-water mark of total bankroll
 * @param {string} [currentState.bucketKey] - omit to skip the bucket-level check entirely
 * @param {number} [currentState.bucketPnlUsd] - this bucket's own cumulative realized P&L right now
 * @param {number} [currentState.bucketPeakPnlUsd] - running high-water mark of this bucket's own P&L
 * @returns {{halted: boolean, scope: 'global'|'bucket'|null, bucketKey?: string, reason: string|null, peakValue: number|null, currentValue: number|null}}
 */
function checkDrawdownBreaker(currentState) {
  const { globalBankrollUsd, globalPeakBankrollUsd, bucketKey, bucketPnlUsd, bucketPeakPnlUsd } = currentState;

  if (typeof globalBankrollUsd === 'number' && typeof globalPeakBankrollUsd === 'number' && globalPeakBankrollUsd > 0) {
    const globalDrawdownPct = (globalPeakBankrollUsd - globalBankrollUsd) / globalPeakBankrollUsd;
    if (globalDrawdownPct >= GLOBAL_DRAWDOWN_THRESHOLD_PCT) {
      return {
        halted: true,
        scope: 'global',
        reason: `global bankroll down ${(globalDrawdownPct * 100).toFixed(2)}% from peak $${globalPeakBankrollUsd.toFixed(2)} (current $${globalBankrollUsd.toFixed(2)}), threshold ${(GLOBAL_DRAWDOWN_THRESHOLD_PCT * 100).toFixed(0)}%`,
        peakValue: globalPeakBankrollUsd,
        currentValue: globalBankrollUsd,
      };
    }
  }

  if (bucketKey && typeof bucketPnlUsd === 'number' && typeof bucketPeakPnlUsd === 'number' && typeof globalPeakBankrollUsd === 'number') {
    const bucketDrawdownUsd = bucketPeakPnlUsd - bucketPnlUsd;
    const bucketThresholdUsd = BUCKET_DRAWDOWN_THRESHOLD_PCT * globalPeakBankrollUsd; // pinned to PEAK, not current -- see header
    if (bucketDrawdownUsd >= bucketThresholdUsd) {
      return {
        halted: true,
        scope: 'bucket',
        bucketKey,
        reason: `bucket ${bucketKey} P&L down $${bucketDrawdownUsd.toFixed(2)} from its own peak $${bucketPeakPnlUsd.toFixed(2)} (current $${bucketPnlUsd.toFixed(2)}), exceeds ${(BUCKET_DRAWDOWN_THRESHOLD_PCT * 100).toFixed(0)}% of peak total bankroll ($${bucketThresholdUsd.toFixed(2)})`,
        peakValue: bucketPeakPnlUsd,
        currentValue: bucketPnlUsd,
      };
    }
  }

  return { halted: false, scope: null, reason: null, peakValue: null, currentValue: null };
}

/**
 * Bucket's own cumulative realized P&L across settled (won/lost), actually-staked (log_only=0),
 * PAPER (mode='paper') trades -- same exclusion convention as orchestrator.js's getBankrollUsd().
 * The mode='paper' filter matters as of 2026-09-09 (see liveExecution.js): without it, the
 * instant a single live or demo-test trade settles, its P&L would get summed into the exact
 * figure this breaker tracks the peak of, corrupting the paper drawdown breaker with real/demo
 * P&L it was never meant to see. This is the value drawdown_breaker_state tracks the peak of for
 * a bucket scope.
 */
function getBucketPnlUsd(db, bucketKey) {
  const row = db.prepare(`SELECT COALESCE(SUM(exit_pnl_usd), 0) AS pnl FROM trades WHERE bucket_key = ? AND status IN ('won','lost') AND log_only = 0 AND mode = 'paper'`).get(bucketKey);
  return row.pnl;
}

/** Reads (initializing at peak=0 if this is the first time this scope has been seen) the durable peak/halt record for a scope ('global' or a bucket_key). */
function getBreakerState(db, scope) {
  let row = db.prepare(`SELECT * FROM drawdown_breaker_state WHERE scope = ?`).get(scope);
  if (!row) {
    db.prepare(`INSERT INTO drawdown_breaker_state (scope, peak_value, halted, updated_at) VALUES (?, 0, 0, ?)`).run(scope, nowIso());
    row = db.prepare(`SELECT * FROM drawdown_breaker_state WHERE scope = ?`).get(scope);
  }
  return row;
}

/** Updates a scope's durable high-water mark to max(existing peak, currentValue). Never lowers the peak (that would defeat the point of a high-water mark) and never touches halted state on its own -- "update the peak" and "declare a halt" are deliberately separate calls (see recordHalt) so they can't be silently conflated. */
function updatePeak(db, scope, currentValue) {
  const state = getBreakerState(db, scope);
  const newPeak = Math.max(state.peak_value, currentValue);
  if (newPeak !== state.peak_value) {
    db.prepare(`UPDATE drawdown_breaker_state SET peak_value = ?, updated_at = ? WHERE scope = ?`).run(newPeak, nowIso(), scope);
  }
  return newPeak;
}

/** Reads whether a scope is currently halted. This is the check a caller (once wired) must make before allowing any order for that scope -- cheaper than re-deriving the drawdown math on every call, and correct, since a halted scope stays halted regardless of what its current peak/value math says this cycle. */
function isHalted(db, scope) {
  return Boolean(getBreakerState(db, scope).halted);
}

/**
 * Durably flips a scope to halted. Idempotent -- calling this on an already-halted scope just
 * refreshes the recorded reason/values/timestamp, it never un-halts anything. This is the ONLY
 * place `halted` is ever set to 1 anywhere in this file; there is deliberately no corresponding
 * "un-halt" function anywhere in this project -- manual re-enable (a human editing
 * drawdown_breaker_state directly, or a future CLI command) is intentionally left outside this
 * file's scope, see the header's "TO WIRE IN" note.
 */
function recordHalt(db, scope, reason, peakValue, currentValue, log) {
  const timestamp = nowIso();
  db.prepare(`
    UPDATE drawdown_breaker_state
    SET halted = 1, halted_at = ?, halted_reason = ?, halted_peak_value = ?, halted_current_value = ?, updated_at = ?
    WHERE scope = ?
  `).run(timestamp, reason, peakValue, currentValue, timestamp, scope);

  const logLine = `!!! DRAWDOWN BREAKER HALTED (${scope}) !!!`;
  const logDetail = { scope, reason, peakValue, currentValue, timestamp };
  if (log) {
    log(logLine, logDetail);
  } else {
    console.error(`[${timestamp}] ${logLine}`, logDetail);
  }
}

/**
 * The full "check before every order placement" flow (once wired -- see header). Checks for an
 * ALREADY-halted scope first (cheap, and re-running the drawdown math on an already-halted
 * scope is pointless -- the halt already happened and stays until a human clears it). Otherwise
 * updates both peaks unconditionally (a high-water mark must keep tracking reality even while
 * not halted) and runs the pure verdict function; if it trips, durably records the halt and logs
 * it. Returns the same {halted, scope, reason, ...} shape as checkDrawdownBreaker, plus
 * `alreadyHalted: true` when the halt predates this call.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} params
 * @param {number} params.globalBankrollUsd
 * @param {string} [params.bucketKey]
 * @param {number} [params.bucketPnlUsd] - typically getBucketPnlUsd(db, bucketKey)
 * @param {function} [log] - orchestrator.js's log(msg, extra) convention; falls back to console.error if omitted
 */
function evaluateAndPersistDrawdownBreaker(db, { globalBankrollUsd, bucketKey, bucketPnlUsd }, log) {
  if (isHalted(db, 'global')) {
    return { halted: true, scope: 'global', reason: 'already halted (see drawdown_breaker_state)', alreadyHalted: true };
  }
  if (bucketKey && isHalted(db, bucketKey)) {
    return { halted: true, scope: 'bucket', bucketKey, reason: 'already halted (see drawdown_breaker_state)', alreadyHalted: true };
  }

  const globalPeakBankrollUsd = updatePeak(db, 'global', globalBankrollUsd);
  const bucketPeakPnlUsd = bucketKey && typeof bucketPnlUsd === 'number' ? updatePeak(db, bucketKey, bucketPnlUsd) : null;

  const verdict = checkDrawdownBreaker({ globalBankrollUsd, globalPeakBankrollUsd, bucketKey, bucketPnlUsd, bucketPeakPnlUsd });
  if (verdict.halted) {
    const scopeForRecord = verdict.scope === 'global' ? 'global' : bucketKey;
    recordHalt(db, scopeForRecord, verdict.reason, verdict.peakValue, verdict.currentValue, log);
  }
  return verdict;
}

module.exports = {
  GLOBAL_DRAWDOWN_THRESHOLD_PCT,
  BUCKET_DRAWDOWN_THRESHOLD_PCT,
  checkDrawdownBreaker,
  getBucketPnlUsd,
  getBreakerState,
  updatePeak,
  isHalted,
  recordHalt,
  evaluateAndPersistDrawdownBreaker,
};
