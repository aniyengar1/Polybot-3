// Holdout win-rate table, generalized from the backtest's hardcoded "strict pre-test-month"
// cutoff into a rolling weekly recompute. Same no-lookahead principle: each week's table
// uses only games resolved strictly before the start of that week, so the trailing window
// currently being traded is always excluded from its own sizing inputs.
'use strict';

const fs = require('fs');
const { BUCKETS, bandFor, makeBucketKey } = require('./buckets');

/**
 * Pure function: computes the holdout win-rate table from a merged records dataset (same
 * shape as usSportsLiquidityFiltered_v2.json), using only rows strictly before
 * `tradingWindowStart`. Output is keyed by bucket_key in the schema's format
 * (sport|market_type|horizon|band) so the sizing module can look it up directly with no
 * translation.
 *
 * Each bucket's pTrue is stored ALREADY side-adjusted (not a raw YES-rate needing a further
 * ternary at lookup time) -- side is intrinsic to each of the 5 validated buckets, not
 * something that varies per-opportunity, so this is the one and only place the side
 * adjustment happens. One less place downstream for a flip bug to hide.
 */
function computeHoldoutTable(records, tradingWindowStart) {
  const table = {};
  for (const b of BUCKETS) {
    const bucketKey = makeBucketKey(b.sport, b.marketType, b.horizon, b.band);
    const typeRecords = records.filter((r) => r.sport === b.sport && r.submarketType === b.marketType);
    const liquidRows = typeRecords.filter((r) => r.checkpoints[b.horizon] && r.checkpoints[b.horizon].liquid);
    const holdoutRows = liquidRows.filter(
      (r) => new Date(r.endDate) < tradingWindowStart && bandFor(r.checkpoints[b.horizon].price) === b.band
    );
    const n = holdoutRows.length;

    if (n === 0) {
      table[bucketKey] = { n: 0, pTrue: null, side: b.side, sport: b.sport, marketType: b.marketType, horizon: b.horizon, band: b.band };
      continue;
    }

    const realizedRateYes = holdoutRows.reduce((s, r) => s + r.yesResolvedTo, 0) / n;
    const pTrue = b.side === 'YES' ? realizedRateYes : 1 - realizedRateYes;
    table[bucketKey] = {
      n,
      pTrue,
      side: b.side,
      sport: b.sport,
      marketType: b.marketType,
      horizon: b.horizon,
      band: b.band,
      tradingWindowStart: tradingWindowStart.toISOString(),
    };
  }
  return table;
}

/** Monday 00:00 UTC of the week containing `date`. */
function startOfUtcWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d;
}

/**
 * Production entry point, intended to be invoked weekly by a scheduler (cron/systemd timer
 * -- the scheduling mechanism itself isn't built here, this is just the function it would
 * call). Computed every Monday, the resulting table trades that week's games and is
 * superseded by next Monday's refresh -- the rolling generalization of the backtest's
 * single fixed "strict pre-period" cutoff.
 *
 * `records` must be supplied by the caller: a fresh pull of resolved games with
 * liquidity-filtered checkpoints, same shape as usSportsLiquidityFiltered_v2.json. This
 * function does not itself fetch/refresh that raw dataset -- turning the one-off
 * fetchLiquidityFiltered.js / fetchMLBFixed.js research scripts into a scheduled live
 * data-refresh job is separate, not-yet-built work (flagged in the earlier build-scoping
 * pass as the one piece of real new engineering the live probability source needs).
 */
function refreshHoldoutTable(records, { now = new Date(), outputPath } = {}) {
  const tradingWindowStart = startOfUtcWeek(now);
  const table = computeHoldoutTable(records, tradingWindowStart);
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(table, null, 1));
  }
  return table;
}

module.exports = { computeHoldoutTable, refreshHoldoutTable, startOfUtcWeek };
