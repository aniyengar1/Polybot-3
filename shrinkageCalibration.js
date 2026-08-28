// Calibrates the sample-size-aware shrinkage function against the 3 already-fetched months
// (no network calls -- reuses cached opportunities with real fills + holdout pTrue + actual
// April/Jan/Dec outcomes already on disk). Tests candidate k values, picks the one that fixes
// December without disturbing April/January.
//
// Formula: shrunk_p = (n * raw_p + k * prior_p) / (n + k)  -- standard Bayesian/Beta-Binomial-
// style shrinkage toward a prior, weighted by a pseudo-count k. At n >> k, shrunk ~= raw
// (large samples dominate). At n << k, shrunk ~= prior (thin samples get pulled hard toward
// the conservative reference). prior_p = 0.775, the midpoint of this project's validated
// 60-95% win-rate range across all buckets (NHL moneyline ~60% up to NBA ~95%).
const fs = require('fs');

const THETA = 0.05;
const KELLY_FRACTION = 0.225;
const KELLY_CAP_PCT = 0.02;
const DEPTH_CAP_PCT = 0.20;
const MIN_BET_USD = 1;
const START_BANKROLL = 100;
const PRIOR_P = 0.775;

function shrink(rawP, n, k) {
  return (n * rawP + k * PRIOR_P) / (n + k);
}

function capScale(n, threshold) {
  return Math.min(1, n / threshold);
}

function simulate(opportunities, { useEV, k, capThreshold }) {
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
  }

  let events = opportunities.map((o) => ({ type: 'place', ts: o.placementTs, opp: o }));
  while (events.length > 0) {
    events.sort((a, c) => a.ts - c.ts);
    const ev = events.shift();
    if (ev.type === 'place') {
      const o = ev.opp;
      const n = o.holdoutN !== undefined ? o.holdoutN : o.preAprilN;
      const pTrue = k === null ? o.pTrue : shrink(o.pTrue, n, k); // k=null => no shrinkage (baseline)
      const effectiveCap = capThreshold ? KELLY_CAP_PCT * capScale(n, capThreshold) : KELLY_CAP_PCT;
      const kellyFrac = Math.max(0, Math.min(1, (pTrue - o.price) / (1 - o.price)));
      let stake = cash * Math.min(kellyFrac * KELLY_FRACTION, effectiveCap);
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
      const rec = { won: o.won };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake, shares, pTrue });
    } else {
      const { rec, stake, shares, pTrue } = ev;
      const payout = useEV ? pTrue * shares : (rec.won ? shares : 0);
      cash += payout;
      outstandingTotal -= stake;
      recordNetWorth();
    }
  }
  const finalNetWorth = cash + outstandingTotal;
  return { finalNetWorth, returnPct: ((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100, maxDrawdownAbs, maxDrawdownPct, n: tradeLog.length };
}

function main() {
  const months = {
    APRIL: JSON.parse(fs.readFileSync('finalWalkForwardApril2026_opportunities.json', 'utf8')),
    JAN: JSON.parse(fs.readFileSync('walkForward_JAN2026_opportunities.json', 'utf8')),
    DEC: JSON.parse(fs.readFileSync('walkForward_DEC2025_opportunities.json', 'utf8')),
  };

  console.log('holdout n and raw vs shrunk pTrue by bucket, for candidate k values:\n');
  const seen = new Set();
  for (const [label, opps] of Object.entries(months)) {
    for (const o of opps) {
      const n = o.holdoutN !== undefined ? o.holdoutN : o.preAprilN;
      const key = label + o.sport + o.type + n;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = [10, 15, 20, 30].map((k) => shrink(o.pTrue, n, k).toFixed(3));
      console.log(`${label} ${o.sport} ${o.type} n=${n} raw=${o.pTrue.toFixed(3)} -> k=10:${row[0]} k=15:${row[1]} k=20:${row[2]} k=30:${row[3]}`);
    }
  }

  console.log('\n\nProbability-shrinkage-only sweep, real-outcomes return by month:');
  console.log('k     | December return | January return | April return');
  for (const k of [null, 10, 15, 20, 25, 30, 40]) {
    const dec = simulate(months.DEC, { useEV: false, k, capThreshold: null });
    const jan = simulate(months.JAN, { useEV: false, k, capThreshold: null });
    const apr = simulate(months.APRIL, { useEV: false, k, capThreshold: null });
    console.log(`${String(k).padEnd(5)} | ${dec.returnPct.toFixed(1).padStart(6)}% (n=${dec.n}, DD ${dec.maxDrawdownPct.toFixed(1)}%) | ${jan.returnPct.toFixed(1).padStart(6)}% (n=${jan.n}, DD ${jan.maxDrawdownPct.toFixed(1)}%) | ${apr.returnPct.toFixed(1).padStart(6)}% (n=${apr.n}, DD ${apr.maxDrawdownPct.toFixed(1)}%)`);
  }

  console.log('\n\nCap-scaling (+ modest k=15 prob shrinkage) sweep, real-outcomes return by month:');
  console.log('capThreshold | December return | January return | April return');
  for (const capThreshold of [null, 15, 20, 30, 40, 50]) {
    const dec = simulate(months.DEC, { useEV: false, k: 15, capThreshold });
    const jan = simulate(months.JAN, { useEV: false, k: 15, capThreshold });
    const apr = simulate(months.APRIL, { useEV: false, k: 15, capThreshold });
    console.log(`${String(capThreshold).padEnd(12)} | ${dec.returnPct.toFixed(1).padStart(6)}% (n=${dec.n}, DD ${dec.maxDrawdownPct.toFixed(1)}%) | ${jan.returnPct.toFixed(1).padStart(6)}% (n=${jan.n}, DD ${jan.maxDrawdownPct.toFixed(1)}%) | ${apr.returnPct.toFixed(1).padStart(6)}% (n=${apr.n}, DD ${apr.maxDrawdownPct.toFixed(1)}%)`);
  }
}
main();
