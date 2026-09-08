// Walk-forward calibration, matching backtestGoldSilverThreeBucket.js's exact discipline
// (validated live in that backtest: daily-cadence recalibration naturally decayed the 2
// buckets whose edge was closing, with zero explicit decay-detection code -- see
// project-kalshi-gold-silver-walkforward-backtest). Reimplemented independently here for a
// live per-checkpoint caller rather than a batch replay loop, same reason liveSizing.js in
// sports-bot exists separately from its own backtest scripts.
//
// Empirical hit rate for a bucket = tonight's backtested baseline (buckets.js's
// backtestBaseline, the "empirical historical hit-rate rule already established in
// backtesting" the task asked this to use) COMBINED with this bot's own live walk-forward
// observations as they accrue -- not replaced by them. Day 1 live, live n=0, so the combined
// rate equals the backtested baseline exactly; the live component's weight grows over time
// as this bot accrues its own settled observations, exactly mirroring how the original
// backtest's calibration accrued day over day rather than starting from nothing.
'use strict';

const { getDb } = require('./db');
const { BUCKET_CONFIG } = require('./buckets');

function utcDateString(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Folds all RESOLVED observations from `date` (UTC) into live_calibration, once. Safe to
 * call repeatedly -- checks calibration_fold_state and no-ops if `date` was already folded.
 * Mirrors the backtest's end-of-day todayAgg fold: every observation in that bucket that
 * day counts, whether or not it was actually traded (see db.js's observations table header).
 */
function foldDateIfNeeded(db, date) {
  const state = db.prepare(`SELECT last_folded_date FROM calibration_fold_state WHERE id = 1`).get();
  if (state.last_folded_date === date) return { folded: false };

  const rows = db
    .prepare(`SELECT bucket_key, yes_resolved_to FROM observations WHERE checkpoint_date = ? AND resolved = 1`)
    .all(date);

  const agg = new Map();
  for (const r of rows) {
    const a = agg.get(r.bucket_key) || { n: 0, hits: 0 };
    a.n += 1;
    if (r.yes_resolved_to === 1) a.hits += 1;
    agg.set(r.bucket_key, a);
  }

  const upsert = db.prepare(`
    INSERT INTO live_calibration (bucket_key, n, hits) VALUES (@bucket_key, @n, @hits)
    ON CONFLICT(bucket_key) DO UPDATE SET n = n + @n, hits = hits + @hits
  `);
  const tx = db.transaction(() => {
    for (const [bucket_key, a] of agg) upsert.run({ bucket_key, n: a.n, hits: a.hits });
    db.prepare(`UPDATE calibration_fold_state SET last_folded_date = ? WHERE id = 1`).run(date);
  });
  tx();

  return { folded: true, bucketsUpdated: agg.size, observationsFolded: rows.length };
}

/** Call once per checkpoint cycle (cheap no-op if already up to date). Folds every UTC day strictly before `now` that hasn't been folded yet -- catches up cleanly after downtime, not just yesterday. */
function catchUpFolds(now = new Date()) {
  const db = getDb();
  const todayDate = now.toISOString().slice(0, 10);
  const results = [];
  // Bounded loop: fold at most 60 missed days in one call (covers any realistic downtime;
  // prevents an unbounded loop if calibration_fold_state ever gets corrupted).
  for (let i = 0; i < 60; i++) {
    const state = db.prepare(`SELECT last_folded_date FROM calibration_fold_state WHERE id = 1`).get();
    let nextDate;
    if (!state.last_folded_date) {
      // First run ever: fold everything strictly before today in one pass, then stop --
      // there's no "yesterday" pointer yet to increment from.
      const earliest = db.prepare(`SELECT MIN(checkpoint_date) AS d FROM observations WHERE checkpoint_date < ? AND resolved = 1`).get(todayDate);
      if (!earliest.d) break;
      nextDate = earliest.d;
    } else {
      const next = new Date(state.last_folded_date + 'T00:00:00Z');
      next.setUTCDate(next.getUTCDate() + 1);
      nextDate = next.toISOString().slice(0, 10);
    }
    if (nextDate >= todayDate) break; // never fold today's own outcomes -- no look-ahead
    const r = foldDateIfNeeded(db, nextDate);
    if (r.folded) results.push({ date: nextDate, ...r });
    if (!r.folded) break;
  }
  return results;
}

/**
 * Combined empirical hit rate: backtested baseline + live walk-forward counts.
 * @returns {{n, hits, pHat}}
 */
function getCombinedHitRate(bucketKey) {
  const config = BUCKET_CONFIG[bucketKey];
  const db = getDb();
  const live = db.prepare(`SELECT n, hits FROM live_calibration WHERE bucket_key = ?`).get(bucketKey) || { n: 0, hits: 0 };
  const n = config.backtestBaseline.n + live.n;
  const hits = config.backtestBaseline.hits + live.hits;
  return { n, hits, pHat: n > 0 ? hits / n : null };
}

/**
 * Shrinks pHat toward the market's own current price, per the task's explicit requirement:
 * guards against sizing up on an edge that's already fading (the exact failure mode already
 * observed live tonight in Silver 0.0-0.1/0.1-0.2 -- see buckets.js header). Beta-style
 * shrinkage toward a price-centered prior: pShrunk = (hits + k*price) / (n + k). k is the
 * per-bucket shrinkageK from buckets.js (weaker-evidence buckets get a larger k -> pulled
 * harder toward price; Silver 0.8-0.9's stronger, cross-validated evidence gets a smaller k).
 */
function getShrunkHitRate(bucketKey, marketPrice) {
  const config = BUCKET_CONFIG[bucketKey];
  const { n, hits, pHat } = getCombinedHitRate(bucketKey);
  if (n === 0) return { n, hits, pHat: null, pShrunk: null };
  const k = config.shrinkageK;
  const pShrunk = (hits + k * marketPrice) / (n + k);
  return { n, hits, pHat, pShrunk };
}

module.exports = { catchUpFolds, foldDateIfNeeded, getCombinedHitRate, getShrunkHitRate, utcDateString };
