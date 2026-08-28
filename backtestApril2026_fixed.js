// Applies the two fixes identified from the depth-cap + MLB-sensitivity + NHL-total-tradability
// round: (1) NBA moneyline uses the previously-established shrunk ~93% forward win rate
// instead of the naively pre-April-pooled ~94.3%, since the go/no-go call already flagged
// NBA's raw test-set win rate as overconfident and anchored a defensible ~93% estimate; (2)
// NHL total skips the last 2 weeks of the NHL regular season (2026-04-02 onward, since the
// season ends 2026-04-16), the window empirically shown to have a broken checkpoint-vs-real-
// fill-price relationship in April but not in January.
//
// Reuses the cached real-fill data from aprilOpportunities.json (backtestApril2026_depthcap.js)
// -- no need to refetch. Keeps the 20% depth cap. Runs 4 scenarios to isolate each fix's
// individual contribution: baseline (depth-cap only, reproduces the prior $21,082.26 result),
// +NBA shrink only, +NHL-total exclusion only, +both (the final, credible number).
const fs = require('fs');

const THETA = 0.05;
const KELLY_FRACTION = 0.225;
const KELLY_CAP_PCT = 0.05;
const DEPTH_CAP_PCT = 0.20;
const MIN_BET_USD = 1;
const START_BANKROLL = 100;

const NBA_SHRUNK_PTRUE = 0.93; // previously established in the go/no-go call
const NHL_TOTAL_EXCLUDE_FROM = new Date('2026-04-02T00:00:00Z'); // last ~2 weeks of the season (ends 2026-04-16)

function simulate(opportunities, { applyNbaShrink, applyNhlTotalExclusion, label }) {
  let pool = opportunities;
  if (applyNhlTotalExclusion) {
    pool = pool.filter((o) => !(o.sport === 'nhl' && o.type === 'total' && new Date(o.resolutionTs * 1000) >= NHL_TOTAL_EXCLUDE_FROM));
  }
  pool = pool.map((o) => {
    if (applyNbaShrink && o.sport === 'nba' && o.type === 'moneyline') {
      // o.side is 'NO' for this bucket; pTrue stored is already side-adjusted (prob of NO winning)
      return { ...o, pTrue: NBA_SHRUNK_PTRUE };
    }
    return o;
  });

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
    const ddAbs = peakNetWorth - netWorth;
    const ddPct = peakNetWorth > 0 ? (ddAbs / peakNetWorth) * 100 : 0;
    if (ddAbs > maxDrawdownAbs) { maxDrawdownAbs = ddAbs; maxDrawdownPct = ddPct; }
    return netWorth;
  }

  let events = pool.map((o) => ({ type: 'place', ts: o.placementTs, opp: o }));
  while (events.length > 0) {
    events.sort((a, c) => a.ts - c.ts);
    const ev = events.shift();
    if (ev.type === 'place') {
      const o = ev.opp;
      const kellyFrac = Math.max(0, Math.min(1, (o.pTrue - o.price) / (1 - o.price)));
      let stake = cash * Math.min(kellyFrac * KELLY_FRACTION, KELLY_CAP_PCT);
      const depthCapStake = DEPTH_CAP_PCT * (o.nearbyNotionalUsd || 0);
      const depthCapped = depthCapStake < stake;
      stake = Math.min(stake, depthCapStake);
      const feeRatio = THETA * (1 - o.price);
      let totalOutlay = stake * (1 + feeRatio);
      if (totalOutlay > cash) { stake = cash / (1 + feeRatio); totalOutlay = cash; }
      if (stake < MIN_BET_USD || kellyFrac <= 0) {
        skipped.push({ ...o, reason: kellyFrac <= 0 ? 'zero/negative edge' : 'below minimum' });
        continue;
      }
      const shares = stake / o.price;
      const fee = shares * THETA * o.price * (1 - o.price);
      cash -= stake + fee;
      outstandingTotal += stake;
      const netWorthAfterPlacement = recordNetWorth();
      const rec = {
        placementDate: new Date(o.placementTs * 1000).toISOString(),
        sport: o.sport, type: o.type, band: o.band, side: o.side, usSlug: o.usSlug,
        price: o.price, pTrue: o.pTrue, stake, fee, netWorthAfterPlacement, won: o.won,
      };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake, shares });
    } else {
      const { rec, stake, shares } = ev;
      const payout = rec.won ? shares : 0;
      cash += payout;
      outstandingTotal -= stake;
      rec.netWorthAfterResolution = recordNetWorth();
    }
  }

  const finalNetWorth = cash + outstandingTotal;
  const byDay = {};
  for (const x of tradeLog) { const d = x.placementDate.slice(0, 10); (byDay[d] = byDay[d] || []).push(x); }
  const counts = Object.values(byDay).map((a) => a.length);
  const stakes = tradeLog.map((x) => x.stake);

  console.log(`\n=== ${label} ===`);
  console.log(`Trades: ${tradeLog.length} (skipped: ${skipped.length})`);
  console.log(`End-of-month bankroll: $${finalNetWorth.toFixed(2)}  (return: ${(((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100).toFixed(1)}%)`);
  console.log(`Max drawdown: $${maxDrawdownAbs.toFixed(2)} (${maxDrawdownPct.toFixed(1)}% of peak $${peakNetWorth.toFixed(2)})`);
  if (counts.length) {
    console.log(`Bets/day: min=${Math.min(...counts)}, max=${Math.max(...counts)}, avg=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)} (${Object.keys(byDay).length} active days)`);
    console.log(`Stake/trade: min=$${Math.min(...stakes).toFixed(2)}, max=$${Math.max(...stakes).toFixed(2)}, avg=$${(stakes.reduce((a, b) => a + b, 0) / stakes.length).toFixed(2)}`);
  }
  return { label, tradeLog, skipped, finalNetWorth, maxDrawdownAbs, maxDrawdownPct, peakNetWorth };
}

function main() {
  const opportunities = JSON.parse(fs.readFileSync('aprilOpportunities.json', 'utf8'));
  console.log(`Loaded ${opportunities.length} cached April opportunities.`);

  const baseline = simulate(opportunities, { applyNbaShrink: false, applyNhlTotalExclusion: false, label: 'BASELINE (depth-cap only, reproduces prior result)' });
  const nbaOnly = simulate(opportunities, { applyNbaShrink: true, applyNhlTotalExclusion: false, label: 'DEPTH-CAP + NBA SHRINK ONLY' });
  const nhlOnly = simulate(opportunities, { applyNbaShrink: false, applyNhlTotalExclusion: true, label: 'DEPTH-CAP + NHL-TOTAL EXCLUSION ONLY' });
  const both = simulate(opportunities, { applyNbaShrink: true, applyNhlTotalExclusion: true, label: 'DEPTH-CAP + BOTH FIXES (FINAL)' });

  console.log('\n\n=== FINAL (both fixes) full trade log ===');
  console.log('date       | bucket                        | side | price  | pTrue  | stake      | won | net worth after');
  for (const x of both.tradeLog) {
    console.log([
      x.placementDate.slice(0, 10), (x.sport + ' ' + x.type + ' ' + x.band).padEnd(29), x.side.padEnd(4),
      x.price.toFixed(3).padEnd(6), x.pTrue.toFixed(3).padEnd(6), ('$' + x.stake.toFixed(2)).padEnd(10),
      x.won ? 'W  ' : 'L  ', '$' + x.netWorthAfterResolution.toFixed(2),
    ].join(' | '));
  }

  fs.writeFileSync('backtestApril2026_fixed_results.json', JSON.stringify({ baseline, nbaOnly, nhlOnly, both }, null, 1));
  console.log('\nSaved backtestApril2026_fixed_results.json');
}

main();
