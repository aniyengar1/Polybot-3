// Full re-run of the monthly walk-forward backtest on CORRECTED data, for the 3 surviving
// buckets only. This does NOT reuse the old cached opportunity files (walkForward_DEC2025_
// opportunities.json etc.) -- those were built from the OLD, contaminated liquidity flag,
// which gates candidate SELECTION, not just the holdout win rate. Reusing them would still
// be testing against "was this checkpoint aggregate-liquid," not "was it side-specific-
// fillable," for the question of which games even count as opportunities that month. This
// regenerates candidates fresh from the corrected usSportsLiquidityFiltered_v2.json,
// restricted to whatever's currently in buckets.js (dynamically -- see the phase 4 scanner
// audit at the bottom of this file's companion report for why that matters).
'use strict';

const fs = require('fs');
const path = require('path');
const { BUCKETS, bandFor, makeBucketKey } = require('../buckets');
const { computeHoldoutTable } = require('../holdoutTable');
const { evaluateOpportunity } = require('../liveSizing');
const { bestFill } = require('../scanner');

const PARENT = path.join(__dirname, '..', '..');
const START_BANKROLL = 100;
// BUG FIX (2026-08-26): mlb was previously set to 2026-05-01, copied from the NBA/NHL
// end-of-regular-season pattern without checking the value made sense for MLB -- whose
// actual regular season runs through 2026-09-27 (postseason through 2026-10-31, both
// already established earlier in this project). That wrong cutoff silently excluded ALL
// MLB data after May 1st, which never showed up testing April (naturally before May 1) but
// produced a false "zero opportunities" result when this same code was later reused to
// check July. Not a live-data finding -- a bug in this harness. Fixed to MLB's real
// regular-season end.
const REG_SEASON_END = {
  nba: new Date('2026-04-13T00:00:00Z'),
  nhl: new Date('2026-04-17T00:00:00Z'),
  mlb: new Date('2026-09-28T00:00:00Z'),
};

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

async function fetchOpportunitiesForMonth(records, testStart, testEnd, holdoutTable) {
  const eventCache = new Map();
  const opportunities = [];

  for (const b of BUCKETS) {
    const bucketKey = makeBucketKey(b.sport, b.marketType, b.horizon, b.band);
    const holdout = holdoutTable[bucketKey];
    if (!holdout || holdout.n === 0) continue; // no holdout data this month -- e.g. Dec's NHL/MLB

    const typeRecords = records.filter((r) => r.sport === b.sport && r.submarketType === b.marketType);
    const liquidRows = typeRecords.filter((r) => r.checkpoints[b.horizon] && r.checkpoints[b.horizon].liquid);
    let testRows = liquidRows.filter(
      (r) => new Date(r.endDate) >= testStart && new Date(r.endDate) < testEnd && bandFor(r.checkpoints[b.horizon].price) === b.band
    );
    if (REG_SEASON_END[b.sport]) {
      testRows = testRows.filter((r) => new Date(r.endDate) < REG_SEASON_END[b.sport]);
    }

    for (const r of testRows) {
      const eventSlug = r.usSlug.replace(/^aec-|^atc-/, '');
      let event = eventCache.get(eventSlug);
      if (event === undefined) {
        try {
          const evs = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${eventSlug}`);
          event = Array.isArray(evs) && evs.length > 0 ? evs[0] : null;
        } catch { event = null; }
        eventCache.set(eventSlug, event);
        await sleep(30);
      }
      const market = event ? (event.markets || []).find((m) => m.slug === r.gammaSlug) : null;
      if (!market) continue;
      let clobTokenIds;
      try { clobTokenIds = JSON.parse(market.clobTokenIds || '[]'); } catch { clobTokenIds = []; }
      if (clobTokenIds.length !== 2) continue;
      const ourToken = b.side === 'YES' ? clobTokenIds[0] : clobTokenIds[1];

      let trades;
      try {
        trades = await fetchJson(`https://data-api.polymarket.com/trades?market=${market.conditionId}&limit=2000`);
        if (!Array.isArray(trades)) trades = [];
      } catch { trades = []; }
      await sleep(30);

      const endTs = Math.floor(new Date(r.endDate).getTime() / 1000);
      const targetTs = endTs - b.horizonHours * 3600;
      const fill = bestFill(trades, ourToken, targetTs);
      if (!fill) continue;

      const won = b.side === 'YES' ? r.yesResolvedTo === 1 : r.yesResolvedTo === 0;
      opportunities.push({
        sport: b.sport, marketType: b.marketType, horizon: b.horizon, band: b.band, side: b.side,
        placementTs: fill.timestamp, resolutionTs: endTs, price: fill.price, won,
        // Same nearbyNotionalUsd field every prior backtest in this thread used for the
        // depth cap -- now side-specific (yesToken-scoped) rather than aggregate, same
        // pre-existing simplification as before (not side-matched to whichever side we
        // actually trade), not something this re-run is trying to fix.
        nearbyNotionalUsd: r.checkpoints[b.horizon].nearbyNotionalUsd,
      });
    }
  }
  opportunities.sort((a, c) => a.placementTs - c.placementTs);
  return opportunities;
}

function simulateMonth(opportunities, holdoutTable) {
  let cash = START_BANKROLL;
  let outstandingTotal = 0;
  let peakNetWorth = START_BANKROLL;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  const tradeLog = [];

  function recordNetWorth() {
    const netWorth = cash + outstandingTotal;
    if (netWorth > peakNetWorth) peakNetWorth = netWorth;
    const dd = peakNetWorth - netWorth;
    const ddPct = peakNetWorth > 0 ? (dd / peakNetWorth) * 100 : 0;
    if (dd > maxDrawdownAbs) { maxDrawdownAbs = dd; maxDrawdownPct = ddPct; }
  }

  let events = opportunities.map((o) => ({ type: 'place', ts: o.placementTs, opp: o }));
  while (events.length > 0) {
    events.sort((a, c) => a.ts - c.ts);
    const ev = events.shift();
    if (ev.type === 'place') {
      const o = ev.opp;
      const decision = evaluateOpportunity(
        { ...o, resolutionDate: new Date(o.resolutionTs * 1000), availableDepthUsd: o.nearbyNotionalUsd },
        cash,
        holdoutTable
      );
      if (decision.action !== 'trade') continue;
      cash -= decision.stake + decision.fee;
      outstandingTotal += decision.stake;
      recordNetWorth();
      const rec = { ...decision, won: o.won, sport: o.sport, marketType: o.marketType, placementTs: o.placementTs };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake: decision.stake, shares: decision.quantity });
    } else {
      const { rec, stake, shares } = ev;
      cash += rec.won ? shares : 0;
      outstandingTotal -= stake;
      recordNetWorth();
    }
  }

  const finalNetWorth = cash + outstandingTotal;
  return { finalNetWorth, returnPct: ((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100, maxDrawdownAbs, maxDrawdownPct, tradeLog };
}

async function runMonth(label, testStart, testEnd) {
  const records = JSON.parse(fs.readFileSync(path.join(PARENT, 'usSportsLiquidityFiltered_v2.json'), 'utf8'));
  const holdoutTable = computeHoldoutTable(records, testStart);
  console.log(`\n=== ${label} ===`);
  console.log('Holdout table (corrected, 3-bucket):');
  for (const [k, v] of Object.entries(holdoutTable)) console.log(`  ${k}: n=${v.n}, pTrue=${v.n ? v.pTrue.toFixed(3) : 'n/a'}`);

  const opportunities = await fetchOpportunitiesForMonth(records, testStart, testEnd, holdoutTable);
  console.log(`Fetched ${opportunities.length} fillable opportunities this month (3-bucket set).`);

  const result = simulateMonth(opportunities, holdoutTable);
  const wins = result.tradeLog.filter((t) => t.won).length;
  const losses = result.tradeLog.length - wins;

  const byDay = {};
  for (const t of result.tradeLog) {
    const d = new Date(t.placementTs * 1000).toISOString().slice(0, 10);
    (byDay[d] = byDay[d] || []).push(t);
  }
  const dayCounts = Object.values(byDay).map((a) => a.length);
  const betsPerDay = dayCounts.length
    ? { min: Math.min(...dayCounts), max: Math.max(...dayCounts), avg: dayCounts.reduce((a, b) => a + b, 0) / dayCounts.length, activeDays: dayCounts.length }
    : { min: 0, max: 0, avg: 0, activeDays: 0 };

  console.log(`Trades: ${result.tradeLog.length} (${wins}W/${losses}L${result.tradeLog.length ? ', ' + ((wins / result.tradeLog.length) * 100).toFixed(1) + '%' : ''})`);
  console.log(`End-of-month bankroll: $${result.finalNetWorth.toFixed(2)} (return: ${result.returnPct.toFixed(1)}%)`);
  console.log(`Max drawdown: $${result.maxDrawdownAbs.toFixed(2)} (${result.maxDrawdownPct.toFixed(1)}%)`);
  console.log(`Bets/day: min=${betsPerDay.min}, max=${betsPerDay.max}, avg=${betsPerDay.avg.toFixed(2)} (${betsPerDay.activeDays} active days)`);

  const byBucket = {};
  for (const t of result.tradeLog) { const k = t.sport + ' ' + t.marketType; byBucket[k] = (byBucket[k] || 0) + 1; }
  console.log('Trades by bucket:', byBucket);

  return { label, opportunities, result, wins, losses, betsPerDay };
}

async function main() {
  const dec = await runMonth('DECEMBER 2025', new Date('2025-12-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  const jan = await runMonth('JANUARY 2026', new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
  const apr = await runMonth('APRIL 2026', new Date('2026-04-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));

  fs.writeFileSync(
    path.join(__dirname, 'monthlyBacktestCorrected_results.json'),
    JSON.stringify({ dec, jan, apr }, null, 1)
  );
  console.log('\nSaved monthlyBacktestCorrected_results.json');
}

module.exports = { runMonth };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
