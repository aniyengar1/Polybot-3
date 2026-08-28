// Phase 2 of the Nov 2025 - Jul 2026 continuous walk-forward: fetches real fillable
// opportunities for each of the 9 months, tagging each with a reference to that SPECIFIC
// month's pre-period holdout table (from phase 1) -- this is what makes the eventual
// simulation a genuine no-lookahead continuous run rather than 9 independent restarts: each
// opportunity is priced/sized using only the holdout signal that existed as of ITS OWN
// month, not a single fixed table for the whole period.
//
// Fetch logic mirrors monthlyBacktestCorrected.js's fetchOpportunitiesForMonth exactly (same
// bestFill, same liquidity/band filters, same REG_SEASON_END exclusion) -- not re-derived,
// just adapted to tag+accumulate across 9 months into one array instead of returning one
// month's worth. Read-only: no writes to buckets.js/scanner.js/orchestrator.js/execution.js/
// the DB, nothing touches the VM.
'use strict';
const fs = require('fs');
const path = require('path');
const { BUCKETS, bandFor, makeBucketKey } = require('../buckets');
const { bestFill } = require('../scanner');

const DATASET_PATH = path.join(__dirname, '..', '..', 'usSportsLiquidityFiltered_v2.json');
const MONTHLY_TABLES_PATH = path.join(__dirname, 'continuousWalkForward_monthlyTables.json');
const OUTPUT_PATH = path.join(__dirname, 'continuousWalkForward_opportunities.json');

const REG_SEASON_END = {
  nba: new Date('2026-04-13T00:00:00Z'),
  nhl: new Date('2026-04-17T00:00:00Z'),
  mlb: new Date('2026-09-28T00:00:00Z'),
};

const MONTHS = [
  { label: 'NOV 2025', start: new Date('2025-11-01T00:00:00Z'), end: new Date('2025-12-01T00:00:00Z') },
  { label: 'DEC 2025', start: new Date('2025-12-01T00:00:00Z'), end: new Date('2026-01-01T00:00:00Z') },
  { label: 'JAN 2026', start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') },
  { label: 'FEB 2026', start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') },
  { label: 'MAR 2026', start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') },
  { label: 'APR 2026', start: new Date('2026-04-01T00:00:00Z'), end: new Date('2026-05-01T00:00:00Z') },
  { label: 'MAY 2026', start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-06-01T00:00:00Z') },
  { label: 'JUN 2026', start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-07-01T00:00:00Z') },
  { label: 'JUL 2026', start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z') },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fetchJson(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'sports-bot/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
}

const CONCURRENCY = 15;

async function fetchOneRow(r, b, bucketKey, monthLabel, eventCache) {
  const eventSlug = r.usSlug.replace(/^aec-|^atc-/, '');
  let event = eventCache.get(eventSlug);
  if (event === undefined) {
    event = (async () => {
      try {
        const evs = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${eventSlug}`);
        return Array.isArray(evs) && evs.length > 0 ? evs[0] : null;
      } catch { return null; }
    })();
    eventCache.set(eventSlug, event);
  }
  event = await event;

  const market = event ? (event.markets || []).find((m) => m.slug === r.gammaSlug) : null;
  if (!market) return null;
  let clobTokenIds;
  try { clobTokenIds = JSON.parse(market.clobTokenIds || '[]'); } catch { clobTokenIds = []; }
  if (clobTokenIds.length !== 2) return null;
  const ourToken = b.side === 'YES' ? clobTokenIds[0] : clobTokenIds[1];

  let trades;
  try {
    trades = await fetchJson(`https://data-api.polymarket.com/trades?market=${market.conditionId}&limit=2000`);
    if (!Array.isArray(trades)) trades = [];
  } catch { trades = []; }

  const endTs = Math.floor(new Date(r.endDate).getTime() / 1000);
  const targetTs = endTs - b.horizonHours * 3600;
  const fill = bestFill(trades, ourToken, targetTs);
  if (!fill) return null;

  const won = b.side === 'YES' ? r.yesResolvedTo === 1 : r.yesResolvedTo === 0;
  return {
    sport: b.sport, marketType: b.marketType, horizon: b.horizon, band: b.band, side: b.side,
    placementTs: fill.timestamp, resolutionTs: endTs, price: fill.price, won,
    nearbyNotionalUsd: r.checkpoints[b.horizon].nearbyNotionalUsd,
    _month: monthLabel, _bucketKey: bucketKey,
  };
}

// Batched concurrency (same pattern as dataRefresh.js/the spread_1.5 historical fetch) --
// the original sequential, one-row-at-a-time version (mirroring monthlyBacktestCorrected.js
// exactly) proved impractically slow at this scale (703 rows across 9 months vs. ~10-80 for
// a single prior month). eventCache now stores in-flight PROMISES (not just resolved values)
// so concurrent rows for the same game share one fetch instead of racing duplicate ones.
async function fetchOpportunitiesForMonth(records, monthLabel, testStart, testEnd, holdoutTable, eventCache) {
  const opportunities = [];

  for (const b of BUCKETS) {
    const bucketKey = makeBucketKey(b.sport, b.marketType, b.horizon, b.band);
    const holdout = holdoutTable[bucketKey];
    if (!holdout || holdout.n === 0) continue;

    const typeRecords = records.filter((r) => r.sport === b.sport && r.submarketType === b.marketType);
    const liquidRows = typeRecords.filter((r) => r.checkpoints[b.horizon] && r.checkpoints[b.horizon].liquid);
    let testRows = liquidRows.filter(
      (r) => new Date(r.endDate) >= testStart && new Date(r.endDate) < testEnd && bandFor(r.checkpoints[b.horizon].price) === b.band
    );
    if (REG_SEASON_END[b.sport]) {
      testRows = testRows.filter((r) => new Date(r.endDate) < REG_SEASON_END[b.sport]);
    }

    for (let i = 0; i < testRows.length; i += CONCURRENCY) {
      const batch = testRows.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((r) => fetchOneRow(r, b, bucketKey, monthLabel, eventCache)));
      for (const opp of results) if (opp) opportunities.push(opp);
      await sleep(30);
    }
  }
  return opportunities;
}

async function main() {
  const records = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  const monthlyTables = JSON.parse(fs.readFileSync(MONTHLY_TABLES_PATH, 'utf8'));
  const eventCache = new Map(); // shared across months -- same game can't recur across different months anyway, but harmless and saves nothing to reset it

  const allOpportunities = [];
  for (const m of MONTHS) {
    const holdoutTable = monthlyTables[m.label];
    const opps = await fetchOpportunitiesForMonth(records, m.label, m.start, m.end, holdoutTable, eventCache);
    allOpportunities.push(...opps);
    console.log(`${m.label}: fetched ${opps.length} fillable opportunities (running total: ${allOpportunities.length})`);
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allOpportunities));
  }

  allOpportunities.sort((a, c) => a.placementTs - c.placementTs);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allOpportunities));
  console.log(`\nDone. Total opportunities across all 9 months: ${allOpportunities.length}`);
  console.log(`Saved ${OUTPUT_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
