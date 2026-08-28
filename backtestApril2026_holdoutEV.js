// De-lucking recompute: same 1% cap and extreme-price-rule scenarios, but instead of
// compounding through April's actual realized win/loss (which may itself be a lucky month),
// use expected-value compounding -- each trade's payout is pTrue * shares (deterministic),
// where pTrue is the strict pre-April (< 2026-04-01) holdout rate already stored on each
// cached opportunity. This isolates "what would the edge alone produce" from "what April's
// specific historical luck produced."
const fs = require('fs');

const THETA = 0.05;
const KELLY_FRACTION = 0.225;
const DEPTH_CAP_PCT = 0.20;
const MIN_BET_USD = 1;
const START_BANKROLL = 100;

function simulateEV(opportunities, { capFn, label }) {
  let cash = START_BANKROLL;
  let outstandingTotal = 0;
  let peakNetWorth = START_BANKROLL;
  let maxDrawdownAbs = 0, maxDrawdownPct = 0;
  const tradeLog = [];

  function recordNetWorth() {
    const netWorth = cash + outstandingTotal;
    if (netWorth > peakNetWorth) peakNetWorth = netWorth;
    const ddAbs = peakNetWorth - netWorth;
    const ddPct = peakNetWorth > 0 ? (ddAbs / peakNetWorth) * 100 : 0;
    if (ddAbs > maxDrawdownAbs) { maxDrawdownAbs = ddAbs; maxDrawdownPct = ddPct; }
    return netWorth;
  }

  // No resolution-time uncertainty needed (deterministic EV), but keep placement-time
  // ordering and capital lock-up identical to the real simulation: stake is deducted at
  // placement and returned (at expected value) at resolution, same as before.
  let events = opportunities.map((o) => ({ type: 'place', ts: o.placementTs, opp: o }));
  while (events.length > 0) {
    events.sort((a, c) => a.ts - c.ts);
    const ev = events.shift();
    if (ev.type === 'place') {
      const o = ev.opp;
      const kellyFrac = Math.max(0, Math.min(1, (o.pTrue - o.price) / (1 - o.price)));
      const capPct = capFn(o.price);
      let stake = cash * Math.min(kellyFrac * KELLY_FRACTION, capPct);
      const depthCapStake = DEPTH_CAP_PCT * (o.nearbyNotionalUsd || 0);
      stake = Math.min(stake, depthCapStake);
      const feeRatio = THETA * (1 - o.price);
      let totalOutlay = stake * (1 + feeRatio);
      if (totalOutlay > cash) { stake = cash / (1 + feeRatio); totalOutlay = cash; }
      if (stake < MIN_BET_USD || kellyFrac <= 0) continue;
      const shares = stake / o.price;
      const fee = shares * THETA * o.price * (1 - o.price);
      cash -= stake + fee;
      outstandingTotal += stake;
      recordNetWorth();
      const rec = { placementDate: new Date(o.placementTs * 1000).toISOString(), sport: o.sport, type: o.type, stake, pTrue: o.pTrue };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake, shares, pTrue: o.pTrue });
    } else {
      const { rec, stake, shares, pTrue } = ev;
      cash += pTrue * shares; // expected payout, not actual win/loss
      outstandingTotal -= stake;
      rec.netWorthAfterResolution = recordNetWorth();
    }
  }

  const finalNetWorth = cash + outstandingTotal;
  const byDay = {};
  for (const x of tradeLog) { const d = x.placementDate.slice(0, 10); (byDay[d] = byDay[d] || []).push(x); }
  const counts = Object.values(byDay).map((a) => a.length);
  console.log(`${label.padEnd(38)} | end=$${finalNetWorth.toFixed(2).padStart(10)} | return=${(((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100).toFixed(0).padStart(7)}% | maxDD=$${maxDrawdownAbs.toFixed(2).padStart(8)} (${maxDrawdownPct.toFixed(1)}%) | trades=${tradeLog.length} | bets/day min=${counts.length?Math.min(...counts):0} max=${counts.length?Math.max(...counts):0} avg=${counts.length?(counts.reduce((a,b)=>a+b,0)/counts.length).toFixed(2):'0.00'}`);
  return { label, finalNetWorth, maxDrawdownAbs, maxDrawdownPct, n: tradeLog.length };
}

function main() {
  const opportunities = JSON.parse(fs.readFileSync('aprilOpportunities.json', 'utf8'));
  console.log(`Loaded ${opportunities.length} cached opportunities. pTrue on each is already the strict pre-April (<2026-04-01) holdout rate.\n`);
  console.log('=== EXPECTED-VALUE compounding (de-lucked: uses pre-April holdout win rate for payout, not April actual results) ===');
  const r1 = simulateEV(opportunities, { capFn: () => 0.01, label: '1% cap, EV/holdout-based' });
  const r2 = simulateEV(opportunities, { capFn: (price) => (price < 0.10 ? 0.01 : 0.05), label: 'extreme-price rule, EV/holdout-based' });
  fs.writeFileSync('backtestApril2026_holdoutEV_results.json', JSON.stringify({ r1, r2 }, null, 1));
}
main();
