// Reproduction test: replays December 2025 / January 2026 / April 2026 through the
// refactored, one-opportunity-at-a-time module (holdoutTable.js + liveSizing.js) instead of
// the original batch-replay backtest scripts, and checks whether it lands on the same
// validated numbers. This is the actual verification step for the whole refactor -- if it
// doesn't match, something changed in translation and needs to be found before this touches
// real trades.
//
// Design of the test: reuses the ALREADY-FETCHED real market data cached by the original
// backtest runs (real fill prices, actual win/loss outcomes, nearbyNotionalUsd) -- re-fetching
// live market data isn't part of what this task refactors (the task is the SIZING logic,
// not the market-scanning/fill-price logic, which is an existing, separate concern). What
// IS freshly recomputed end-to-end through the new code is the holdout table itself
// (computeHoldoutTable, not the cached pTrue/holdoutN fields) and every sizing decision
// (evaluateOpportunity, not the original inlined Kelly math) -- that's the part this task
// actually changed, and the part this test needs to prove is still correct.
'use strict';

const fs = require('fs');
const path = require('path');
const { computeHoldoutTable } = require('../holdoutTable');
const { evaluateOpportunity, THETA, capScale, KELLY_CAP_PCT } = require('../liveSizing');

const PARENT = path.join(__dirname, '..', '..'); // polymarket-flb-research/
const START_BANKROLL = 100;

function simulateMonth(records, opportunities, tradingWindowStart, { useEV, applyCapScaling }) {
  const holdoutTable = computeHoldoutTable(records, tradingWindowStart);

  // If applyCapScaling is false, force capScale to a no-op by inflating every bucket's n to
  // effectively bypass the n=30 threshold -- this reproduces the PRE-cap-scaling-rule
  // baseline for comparison, without duplicating evaluateOpportunity's logic in the test.
  const effectiveTable = applyCapScaling
    ? holdoutTable
    : Object.fromEntries(Object.entries(holdoutTable).map(([k, v]) => [k, { ...v, n: v.n > 0 ? 1e9 : v.n }]));

  let cash = START_BANKROLL;
  let outstandingTotal = 0;
  let peakNetWorth = START_BANKROLL;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  const tradeLog = [];
  const skipped = [];

  function recordNetWorth() {
    const netWorth = cash + outstandingTotal;
    if (netWorth > peakNetWorth) peakNetWorth = netWorth;
    const dd = peakNetWorth - netWorth;
    const ddPct = peakNetWorth > 0 ? (dd / peakNetWorth) * 100 : 0;
    if (dd > maxDrawdownAbs) {
      maxDrawdownAbs = dd;
      maxDrawdownPct = ddPct;
    }
  }

  let events = opportunities.map((o) => ({ type: 'place', ts: o.placementTs, opp: o }));
  while (events.length > 0) {
    events.sort((a, c) => a.ts - c.ts);
    const ev = events.shift();
    if (ev.type === 'place') {
      const o = ev.opp;
      const decision = evaluateOpportunity(
        {
          sport: o.sport,
          marketType: o.type,
          horizon: bucketHorizonFor(o),
          band: o.band,
          side: o.side,
          price: o.price,
          resolutionDate: new Date(o.resolutionTs * 1000),
          availableDepthUsd: o.nearbyNotionalUsd,
        },
        cash,
        effectiveTable
      );
      if (decision.action !== 'trade') {
        skipped.push({ ...o, reason: decision.reason });
        continue;
      }
      cash -= decision.stake + decision.fee;
      outstandingTotal += decision.stake;
      recordNetWorth();
      const rec = { ...decision, won: o.won, sport: o.sport, type: o.type };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake: decision.stake, shares: decision.quantity, pTrue: decision.holdoutPTrue });
    } else {
      const { rec, stake, shares, pTrue } = ev;
      const payout = useEV ? pTrue * shares : (rec.won ? shares : 0);
      cash += payout;
      outstandingTotal -= stake;
      recordNetWorth();
    }
  }

  const finalNetWorth = cash + outstandingTotal;
  return {
    finalNetWorth,
    returnPct: ((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100,
    maxDrawdownAbs,
    maxDrawdownPct,
    n: tradeLog.length,
    wins: tradeLog.filter((t) => t.won).length,
    holdoutTable,
  };
}

// The cached opportunity files don't carry `horizon` explicitly (only band/type/sport) --
// reconstruct it from the same rule the buckets use (nba/nhl-spread => h3, else h24).
function bucketHorizonFor(o) {
  if (o.sport === 'nba' && o.type === 'moneyline') return 'h3';
  if (o.sport === 'nhl' && o.type === 'spread') return 'h3';
  return 'h24';
}

function run(label, recordsFile, oppsFile, tradingWindowStart, targets) {
  const records = JSON.parse(fs.readFileSync(path.join(PARENT, recordsFile), 'utf8'));
  const opportunities = JSON.parse(fs.readFileSync(path.join(PARENT, oppsFile), 'utf8'));

  const withCap = simulateMonth(records, opportunities, tradingWindowStart, { useEV: false, applyCapScaling: true });
  const withoutCap = simulateMonth(records, opportunities, tradingWindowStart, { useEV: false, applyCapScaling: false });

  console.log(`\n=== ${label} ===`);
  console.log(`Refactored module, WITH n=30 cap (current, correct behavior): $${withCap.finalNetWorth.toFixed(2)} (${withCap.returnPct.toFixed(1)}%), maxDD $${withCap.maxDrawdownAbs.toFixed(2)} (${withCap.maxDrawdownPct.toFixed(1)}%), n=${withCap.n}, ${withCap.wins}W/${withCap.n - withCap.wins}L`);
  console.log(`Refactored module, WITHOUT cap (pre-cap-rule baseline, for the cited target):  $${withoutCap.finalNetWorth.toFixed(2)} (${withoutCap.returnPct.toFixed(1)}%), maxDD $${withoutCap.maxDrawdownAbs.toFixed(2)} (${withoutCap.maxDrawdownPct.toFixed(1)}%), n=${withoutCap.n}, ${withoutCap.wins}W/${withoutCap.n - withoutCap.wins}L`);
  console.log(`Target cited in this task (pre-cap-rule number):                                 $${targets.preCap.toFixed(2)}`);
  console.log(`Target from the previous (cap-scaling) task's validated result:                  $${targets.postCap.toFixed(2)}`);

  const matchesPreCap = Math.abs(withoutCap.finalNetWorth - targets.preCap) < 0.02;
  const matchesPostCap = Math.abs(withCap.finalNetWorth - targets.postCap) < 0.02;
  console.log(`WITHOUT-cap reproduction matches cited pre-cap target: ${matchesPreCap ? 'YES (exact match)' : 'NO -- discrepancy, see below'}`);
  console.log(`WITH-cap reproduction matches previous cap-scaling-task result: ${matchesPostCap ? 'YES (exact match)' : 'NO -- discrepancy, see below'}`);

  return { withCap, withoutCap, matchesPreCap, matchesPostCap };
}

function main() {
  const results = {};
  results.december = run(
    'DECEMBER 2025',
    'usSportsLiquidityFiltered_v2.json',
    'walkForward_DEC2025_opportunities.json',
    new Date('2025-12-01T00:00:00Z'),
    { preCap: 98.71, postCap: 99.02 }
  );
  results.january = run(
    'JANUARY 2026',
    'usSportsLiquidityFiltered_v2.json',
    'walkForward_JAN2026_opportunities.json',
    new Date('2026-01-01T00:00:00Z'),
    { preCap: 141.54, postCap: 132.97 }
  );
  results.april = run(
    'APRIL 2026',
    'usSportsLiquidityFiltered_v2.json',
    'finalWalkForwardApril2026_opportunities.json',
    new Date('2026-04-01T00:00:00Z'),
    { preCap: 115.03, postCap: 114.08 }
  );

  console.log('\n\n=== SUMMARY ===');
  for (const [label, r] of Object.entries(results)) {
    console.log(`${label}: without-cap matches pre-cap target = ${r.matchesPreCap}, with-cap matches previous cap-scaling result = ${r.matchesPostCap}`);
  }
}

main();
