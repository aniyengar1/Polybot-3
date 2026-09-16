// Active decay-watch, per the task's explicit requirement: this exact product already
// showed a bucket's edge collapsing to near-zero DURING testing tonight (Silver 0.0-0.1,
// Silver 0.1-0.2 -- see buckets.js header). This module makes that pattern visible and loud
// if it starts recurring in one of the 3 buckets actually being traded, rather than letting
// the bot quietly keep trading a dying edge until someone happens to check.
//
// This is a MONITOR, not a second sizing control -- calibration.js's shrinkage + daily
// walk-forward recalibration already self-corrects a fading bucket's Kelly edge toward zero
// (validated live in project-kalshi-gold-silver-walkforward-backtest: trade frequency and
// losses on the 2 fading buckets shrank to near-zero with NO explicit decay-detection code).
// This module doesn't duplicate that control; it surfaces what's happening so a human sees
// it prominently instead of it aging silently into "why did this bucket stop firing."
'use strict';

const { getDb } = require('./db');
const { BUCKET_CONFIG, MIN_CALIBRATION_N } = require('./buckets');

const ROLLING_WINDOW_N = 30; // trailing trades, matches this project's standard n>=30 floor
const MIN_ROLLING_N_TO_FLAG = 10; // don't flag on noise from a handful of trades
const WIN_RATE_DEFICIT_THRESHOLD = 0.20; // 20pp below backtested baseline
const PROBATION_REVIEW_N = MIN_CALIBRATION_N; // same n=30 floor, shared with the probation-review gate below

/**
 * Checks one bucket's trailing settled trades against its backtested baseline. Returns an
 * alert object if triggered, else null. Pure read -- callers decide whether/how to persist
 * or log.
 *
 * Probationary buckets (buckets.js's status:'probationary') are skipped here until they clear
 * their OWN n>=PROBATION_REVIEW_N review gate (checkProbationReviews below) -- found live
 * 2026-09-06: a brand-new probationary bucket at n=12 tripped this check almost immediately,
 * firing a loud decay alert against a backtested baseline that isn't even
 * independence-confirmed yet for that bucket. Comparing noisy n=12 rolling performance
 * against an unproven number is a confusing signal, not a useful one -- the probation-review
 * gate is the right, purpose-built check for these buckets before n=30; decay-watch picks up
 * from there, once there's an actual live track record worth protecting.
 */
function checkBucketDecay(bucketKey) {
  const config = BUCKET_CONFIG[bucketKey];
  const db = getDb();

  // Retired buckets (status:'retired', currently just Silver 0.8-0.9/cp8 -- see buckets.js's
  // header) never produce new trades (gated in orchestrator.js), so their trade history is
  // frozen forever and no new evidence will ever arrive either way -- monitoring a dead bucket
  // for decay is just noise, not a useful signal. Explicit exclusion rather than relying on the
  // de-dup logic below staying silent on its own: unambiguous, and avoids a bucket that had
  // zero decay_alert rows before retirement still firing one final alert on the next cycle.
  if (config.status === 'retired') return null;

  // Both queries below filter on side = config.validatedSide (added 2026-09-08, see buckets.js's
  // header): a bucket's backtestBaseline.winRate is specifically the VALIDATED side's own win
  // rate, so comparing a rolling window that also includes opposite-direction trades (now gated
  // off going forward in liveSizing.js, but 7 already exist historically -- BTC 0.8-0.9/cp9 has
  // 4, DOGE 0.8-0.9/cp6 has 1, both currently probationary) against that baseline is comparing
  // apples to a partially-oranges mix. Without this filter, those opposite-direction losses drag
  // down the rolling win rate/P&L and inflate progress toward the n=30 probation-review trigger
  // with trades that never tested the validated hypothesis at all.
  // mode = 'paper' (added 2026-09-11, ahead of the live flip): without this, a bucket's rolling
  // decay window would silently blend real-money and paper-money trades together the instant any
  // live trade settles -- this alerting exists specifically to protect the paper track's
  // calibration signal, and probationary buckets (the exact buckets going live tonight) are the
  // ones most likely to have both paper and live history at once. Paper-scoped by design now,
  // not by accident of zero live rows existing.
  if (config.status === 'probationary') {
    const settled = db.prepare(`SELECT COUNT(*) c FROM trades WHERE bucket_key = ? AND side = ? AND status IN ('won','lost') AND mode = 'paper'`).get(bucketKey, config.validatedSide).c;
    if (settled < PROBATION_REVIEW_N) return null;
  }

  const rows = db
    .prepare(`SELECT status, exit_pnl_usd FROM trades WHERE bucket_key = ? AND side = ? AND status IN ('won','lost') AND mode = 'paper' ORDER BY resolved_at DESC LIMIT ?`)
    .all(bucketKey, config.validatedSide, ROLLING_WINDOW_N);

  if (rows.length < MIN_ROLLING_N_TO_FLAG) return null;

  const wins = rows.filter((r) => r.status === 'won').length;
  const rollingWinRate = wins / rows.length;
  const rollingPnl = rows.reduce((s, r) => s + (r.exit_pnl_usd || 0), 0);
  const baselineWinRate = config.backtestBaseline.winRate;

  const winRateDeficit = baselineWinRate - rollingWinRate;
  const pnlNegativeAndBaselineWasPositive = rollingPnl < 0 && config.backtestBaseline.pnlPerTrade > 0;

  if (winRateDeficit > WIN_RATE_DEFICIT_THRESHOLD || pnlNegativeAndBaselineWasPositive) {
    return {
      bucketKey,
      rollingN: rows.length,
      rollingWinRate,
      baselineWinRate,
      rollingPnlUsd: rollingPnl,
      reason:
        winRateDeficit > WIN_RATE_DEFICIT_THRESHOLD
          ? `rolling win rate ${(rollingWinRate * 100).toFixed(1)}% is ${(winRateDeficit * 100).toFixed(1)}pp below backtested baseline ${(baselineWinRate * 100).toFixed(1)}%`
          : `rolling P&L $${rollingPnl.toFixed(2)} over last ${rows.length} trades is negative despite a positive backtested baseline ($${config.backtestBaseline.pnlPerTrade.toFixed(3)}/trade)`,
    };
  }
  return null;
}

/**
 * Runs the check across every bucket, persists any NEW alert, and returns the list -- call
 * once per settlement cycle.
 *
 * De-duplicated (found live 2026-09-06: with no gate at all, the exact same rolling-window
 * state re-inserted an identical row on every single checkpoint cycle -- 40 copies of one
 * message, since nothing about the underlying trades had changed between cycles). Only
 * inserts a new row when a trade has actually settled for this bucket since its last alert --
 * i.e. the rolling window has genuinely moved, not just been re-evaluated. A bucket that's
 * still decaying with no new settlements simply doesn't re-alert until there's new evidence
 * either way; this mirrors probation_review_alerts' "surface once, not on a timer" philosophy
 * while still allowing a bucket to alert again later if it decays, recovers, and decays again.
 */
function runDecayWatch(log = () => {}) {
  const db = getDb();
  const alerts = [];
  for (const bucketKey of Object.keys(BUCKET_CONFIG)) {
    const alert = checkBucketDecay(bucketKey);
    if (!alert) continue;

    const lastAlert = db.prepare(`SELECT created_at FROM decay_alerts WHERE bucket_key = ? ORDER BY created_at DESC LIMIT 1`).get(bucketKey);
    if (lastAlert) {
      // mode = 'paper' -- a newly-settled LIVE trade must never be treated as "the rolling window
      // moved" for this alert's own re-fire gate; checkBucketDecay's own window is paper-only now
      // (see above), so this de-dup check needs the same scoping or it could re-fire on live-only
      // settlement activity that the alert itself never actually looked at.
      const newerSettlement = db
        .prepare(`SELECT 1 FROM trades WHERE bucket_key = ? AND status IN ('won','lost') AND mode = 'paper' AND resolved_at > ? LIMIT 1`)
        .get(bucketKey, lastAlert.created_at);
      if (!newerSettlement) continue; // nothing new since the last alert -- don't re-fire
    }

    alerts.push(alert);
    db.prepare(`
      INSERT INTO decay_alerts (created_at, bucket_key, rolling_n, rolling_win_rate, baseline_win_rate, rolling_pnl_usd, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), alert.bucketKey, alert.rollingN, alert.rollingWinRate, alert.baselineWinRate, alert.rollingPnlUsd, alert.reason);
    log('!!! DECAY ALERT !!!', alert);
  }
  return alerts;
}

/**
 * One-time trigger per probationary bucket (buckets.js's BUCKET_CONFIG[key].status ===
 * 'probationary' -- currently the 7 DOGE/BTC crypto rules added 2026-09-06): the first time a
 * bucket's live SETTLED trade count reaches PROBATION_REVIEW_N, this is the explicit signal
 * that enough never-touched forward data now exists to go evaluate that rule against its
 * original search/holdout edge (the actual Stage 1 independence check those rules still need
 * -- see buckets.js's header). Fires exactly once per bucket_key (UNIQUE constraint on
 * probation_review_alerts.bucket_key), never auto-cleared, same "surface it, don't bury it"
 * philosophy as decay_alerts -- this is NOT a decay check, it fires on reaching a sample size,
 * regardless of whether performance looks good or bad so far.
 */
function checkProbationReviews(log = () => {}) {
  const db = getDb();
  const triggered = [];
  const probationaryKeys = Object.entries(BUCKET_CONFIG)
    .filter(([, config]) => config.status === 'probationary')
    .map(([key]) => key);

  for (const bucketKey of probationaryKeys) {
    const existing = db.prepare(`SELECT id FROM probation_review_alerts WHERE bucket_key = ?`).get(bucketKey);
    if (existing) continue;

    // side = validatedSide (added 2026-09-08, see buckets.js's header): this trigger is
    // specifically about reaching enough live data to evaluate the VALIDATED hypothesis --
    // an opposite-direction trade (now gated off going forward in liveSizing.js) never tested
    // that hypothesis, so it shouldn't count toward the n=30 sample-size trigger for it.
    // mode = 'paper' (added 2026-09-11, ahead of the live flip) -- same reasoning as
    // checkBucketDecay above: this is specifically the paper-track review gate ("enough
    // never-touched PAPER data to evaluate the original search/holdout edge"), not a count of
    // real-money fills, which would reach n=30 for a different, unrelated reason.
    const settled = db.prepare(`SELECT COUNT(*) c FROM trades WHERE bucket_key = ? AND side = ? AND status IN ('won','lost') AND mode = 'paper'`).get(bucketKey, BUCKET_CONFIG[bucketKey].validatedSide).c;
    if (settled < PROBATION_REVIEW_N) continue;

    const message = `${bucketKey} reached n=${settled} settled live paper trades -- enough forward, never-touched data now exists to evaluate this rule against its original search/holdout edge. See buckets.js's header for that rule's provenance doc.`;
    db.prepare(`
      INSERT INTO probation_review_alerts (created_at, bucket_key, n_at_trigger, message)
      VALUES (?, ?, ?, ?)
    `).run(new Date().toISOString(), bucketKey, settled, message);
    triggered.push({ bucketKey, nAtTrigger: settled, message });
    log('!!! PROBATION REVIEW READY !!!', { bucketKey, n: settled });
  }
  return triggered;
}

module.exports = {
  checkBucketDecay,
  runDecayWatch,
  checkProbationReviews,
  ROLLING_WINDOW_N,
  MIN_ROLLING_N_TO_FLAG,
  WIN_RATE_DEFICIT_THRESHOLD,
  PROBATION_REVIEW_N,
};
