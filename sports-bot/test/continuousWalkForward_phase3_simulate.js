// Phase 3 of the Nov 2025 - Jul 2026 continuous walk-forward: ONE continuous, compounding
// bankroll simulation across all 9 months (not 9 independent $100 restarts). Reuses
// evaluateOpportunity() verbatim (the same validated Kelly/cap sizing logic every prior
// backtest in this thread used) -- each opportunity is evaluated against the SPECIFIC
// holdout table that was valid as of ITS OWN month (from phase 1), preserving strict
// no-lookahead discipline across the whole span, not just within each month.
'use strict';
const fs = require('fs');
const path = require('path');
const { evaluateOpportunity } = require('../liveSizing');

const OPPORTUNITIES_PATH = path.join(__dirname, 'continuousWalkForward_opportunities.json');
const MONTHLY_TABLES_PATH = path.join(__dirname, 'continuousWalkForward_monthlyTables.json');
const START_BANKROLL = 100;

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

function main() {
  const opportunities = JSON.parse(fs.readFileSync(OPPORTUNITIES_PATH, 'utf8'));
  const monthlyTables = JSON.parse(fs.readFileSync(MONTHLY_TABLES_PATH, 'utf8'));

  let cash = START_BANKROLL;
  let outstandingTotal = 0;
  let peakNetWorth = START_BANKROLL;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  let maxDrawdownAt = null;
  const tradeLog = [];
  const netWorthHistory = [];

  function recordNetWorth(ts) {
    const netWorth = cash + outstandingTotal;
    netWorthHistory.push({ ts, netWorth });
    if (netWorth > peakNetWorth) peakNetWorth = netWorth;
    const dd = peakNetWorth - netWorth;
    const ddPct = peakNetWorth > 0 ? (dd / peakNetWorth) * 100 : 0;
    if (dd > maxDrawdownAbs) {
      maxDrawdownAbs = dd;
      maxDrawdownPct = ddPct;
      maxDrawdownAt = ts;
    }
    return netWorth;
  }

  // Build one continuous event queue: 'place' for every opportunity, 'resolve' for its
  // eventual settlement, plus a synthetic 'snapshot' at each month boundary so the
  // month-by-month report can show real starting/ending bankroll without breaking the
  // single continuous compounding run.
  let events = [];
  for (const o of opportunities) {
    events.push({ type: 'place', ts: o.placementTs, opp: o });
  }
  const monthSnapshots = {}; // label -> { startTs, startNetWorth, endTs, endNetWorth }
  for (const m of MONTHS) {
    events.push({ type: 'snapshot', ts: Math.floor(m.start.getTime() / 1000), label: m.label, kind: 'start' });
    events.push({ type: 'snapshot', ts: Math.floor(m.end.getTime() / 1000) - 1, label: m.label, kind: 'end' });
  }

  events.sort((a, c) => a.ts - c.ts);
  while (events.length > 0) {
    // Re-sort defensively since 'resolve' events get pushed mid-loop with their own ts,
    // which can land earlier than later items still queued (same pattern as every prior
    // event-driven backtest in this thread).
    events.sort((a, c) => a.ts - c.ts);
    const ev = events.shift();

    if (ev.type === 'snapshot') {
      const netWorth = recordNetWorth(ev.ts);
      if (!monthSnapshots[ev.label]) monthSnapshots[ev.label] = {};
      if (ev.kind === 'start') { monthSnapshots[ev.label].startTs = ev.ts; monthSnapshots[ev.label].startNetWorth = netWorth; }
      else { monthSnapshots[ev.label].endTs = ev.ts; monthSnapshots[ev.label].endNetWorth = netWorth; }
      continue;
    }

    if (ev.type === 'place') {
      const o = ev.opp;
      const holdoutTable = monthlyTables[o._month];
      const decision = evaluateOpportunity(
        { ...o, resolutionDate: new Date(o.resolutionTs * 1000), availableDepthUsd: o.nearbyNotionalUsd },
        cash,
        holdoutTable
      );
      if (decision.action !== 'trade') continue;
      cash -= decision.stake + decision.fee;
      outstandingTotal += decision.stake;
      recordNetWorth(o.placementTs);
      const rec = {
        ...decision, won: o.won, sport: o.sport, marketType: o.marketType, side: o.side,
        placementTs: o.placementTs, resolutionTs: o.resolutionTs, month: o._month,
      };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake: decision.stake, shares: decision.quantity });
    } else if (ev.type === 'resolve') {
      const { rec, stake, shares } = ev;
      cash += rec.won ? shares : 0;
      outstandingTotal -= stake;
      recordNetWorth(ev.ts);
    }
  }

  const finalNetWorth = cash + outstandingTotal;
  const wins = tradeLog.filter((t) => t.won).length;
  const losses = tradeLog.length - wins;

  const result = {
    startBankroll: START_BANKROLL,
    finalNetWorth,
    returnPct: ((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100,
    maxDrawdownAbs,
    maxDrawdownPct,
    maxDrawdownAt: maxDrawdownAt !== null ? new Date(maxDrawdownAt * 1000).toISOString() : null,
    totalTrades: tradeLog.length,
    wins,
    losses,
    winRatePct: tradeLog.length ? (wins / tradeLog.length) * 100 : null,
    monthSnapshots,
    tradeLog,
  };

  fs.writeFileSync(path.join(__dirname, 'continuousWalkForward_result.json'), JSON.stringify(result, null, 1));

  console.log('=== OVERALL SUMMARY (Nov 2025 - Jul 2026, continuous $100 start) ===');
  console.log(`Final bankroll: $${finalNetWorth.toFixed(2)} (return: ${result.returnPct.toFixed(1)}%)`);
  console.log(`Max drawdown: $${maxDrawdownAbs.toFixed(2)} (${maxDrawdownPct.toFixed(1)}%) at ${result.maxDrawdownAt}`);
  console.log(`Total trades: ${tradeLog.length} (${wins}W/${losses}L${tradeLog.length ? ', ' + result.winRatePct.toFixed(1) + '%' : ''})`);

  console.log('\n=== MONTH-BY-MONTH ===');
  for (const m of MONTHS) {
    const snap = monthSnapshots[m.label] || {};
    const monthTrades = tradeLog.filter((t) => t.month === m.label);
    const mWins = monthTrades.filter((t) => t.won).length;
    const mLosses = monthTrades.length - mWins;
    const holdoutTable = monthlyTables[m.label];
    const activeBuckets = Object.entries(holdoutTable).filter(([, v]) => v.n > 0).map(([k, v]) => `${k}(n=${v.n})`);
    const monthReturn = snap.startNetWorth ? ((snap.endNetWorth - snap.startNetWorth) / snap.startNetWorth) * 100 : null;
    console.log(`${m.label}: start=$${snap.startNetWorth?.toFixed(2)} end=$${snap.endNetWorth?.toFixed(2)} (${monthReturn !== null ? monthReturn.toFixed(1) + '%' : 'n/a'}) | trades=${monthTrades.length} (${mWins}W/${mLosses}L) | active buckets: ${activeBuckets.length ? activeBuckets.join(', ') : 'NONE'}`);
  }

  console.log('\nSaved continuousWalkForward_result.json (full trade log + snapshots).');
}

main();
