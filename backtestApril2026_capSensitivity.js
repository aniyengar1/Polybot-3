// Cap-sensitivity sweep. Prior round established NBA shrinkage and the NHL-total exclusion
// don't change the result (cap saturation at NBA's extreme-longshot prices; NHL-total trades
// were already organically zero-edge). This isolates the one lever that does matter: the
// per-trade Kelly cap itself. Reuses cached real-fill data from aprilOpportunities.json.
const fs = require('fs');

const THETA = 0.05;
const KELLY_FRACTION = 0.225;
const DEPTH_CAP_PCT = 0.20;
const MIN_BET_USD = 1;
const START_BANKROLL = 100;

function simulate(opportunities, { capFn, label }) {
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
      const rec = { placementDate: new Date(o.placementTs * 1000).toISOString(), stake, won: o.won };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake, shares });
    } else {
      const { rec, stake, shares } = ev;
      cash += rec.won ? shares : 0;
      outstandingTotal -= stake;
      recordNetWorth();
    }
  }

  const finalNetWorth = cash + outstandingTotal;
  const byDay = {};
  for (const x of tradeLog) { const d = x.placementDate.slice(0, 10); (byDay[d] = byDay[d] || []).push(x); }
  const counts = Object.values(byDay).map((a) => a.length);
  const result = {
    label, n: tradeLog.length, finalNetWorth,
    returnPct: ((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100,
    maxDrawdownAbs, maxDrawdownPct, peakNetWorth,
    betsPerDayMin: counts.length ? Math.min(...counts) : 0,
    betsPerDayMax: counts.length ? Math.max(...counts) : 0,
    betsPerDayAvg: counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0,
    activeDays: Object.keys(byDay).length,
  };
  console.log(`${label.padEnd(38)} | end=$${finalNetWorth.toFixed(2).padStart(12)} | return=${result.returnPct.toFixed(0).padStart(8)}% | maxDD=$${maxDrawdownAbs.toFixed(2).padStart(9)} (${maxDrawdownPct.toFixed(1)}%) | bets/day min=${result.betsPerDayMin} max=${result.betsPerDayMax} avg=${result.betsPerDayAvg.toFixed(2)}`);
  return result;
}

function main() {
  const opportunities = JSON.parse(fs.readFileSync('aprilOpportunities.json', 'utf8'));
  console.log(`Loaded ${opportunities.length} cached April opportunities.\n`);

  const results = [];
  results.push(simulate(opportunities, { capFn: () => 0.05, label: '5% cap (baseline)' }));
  results.push(simulate(opportunities, { capFn: () => 0.02, label: '2% cap' }));
  results.push(simulate(opportunities, { capFn: () => 0.01, label: '1% cap' }));
  results.push(simulate(opportunities, { capFn: () => 0.0025, label: '0.25% cap' }));
  results.push(simulate(opportunities, { capFn: (price) => (price < 0.10 ? 0.01 : 0.05), label: 'extreme-price rule (<10c: 1%, else 5%)' }));

  fs.writeFileSync('backtestApril2026_capSensitivity_results.json', JSON.stringify(results, null, 1));
  console.log('\nSaved backtestApril2026_capSensitivity_results.json');
}

main();
