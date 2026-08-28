// Same fixed-pricing, same-caps simulation as finalWalkForwardApril2026.js, but compounds
// through April's actual realized win/loss sequence instead of expected-value payouts.
// Reuses the already-fetched, correctly-priced opportunities (finalWalkForwardApril2026_
// opportunities.json) -- no new fetches, just a different payout rule at resolution time.
// Sizing still uses the pre-April holdout pTrue (unchanged); only the outcome realization
// changes: won ? shares : 0, instead of pTrue * shares.
const fs = require('fs');

const THETA = 0.05;
const KELLY_FRACTION = 0.225;
const KELLY_CAP_PCT = 0.02;
// Sample-size-aware position cap -- see finalWalkForwardApril2026.js for full derivation.
const CAP_SHRINK_THRESHOLD = 30;
function capScale(n) {
  return Math.min(1, n / CAP_SHRINK_THRESHOLD);
}
const DEPTH_CAP_PCT = 0.20;
const MIN_BET_USD = 1;
const START_BANKROLL = 100;

function main() {
  const opportunities = JSON.parse(fs.readFileSync('finalWalkForwardApril2026_opportunities.json', 'utf8'));
  console.log(`Loaded ${opportunities.length} cached, correctly-priced opportunities.\n`);

  let cash = START_BANKROLL;
  let outstandingTotal = 0;
  let peakNetWorth = START_BANKROLL;
  let maxDrawdownAbs = 0, maxDrawdownPct = 0;
  let maxDrawdownDate = null;
  const tradeLog = [];
  const skipped = [];

  function recordNetWorth(ts) {
    const netWorth = cash + outstandingTotal;
    if (netWorth > peakNetWorth) peakNetWorth = netWorth;
    const ddAbs = peakNetWorth - netWorth;
    const ddPct = peakNetWorth > 0 ? (ddAbs / peakNetWorth) * 100 : 0;
    if (ddAbs > maxDrawdownAbs) { maxDrawdownAbs = ddAbs; maxDrawdownPct = ddPct; maxDrawdownDate = ts; }
    return netWorth;
  }

  let events = opportunities.map((o) => ({ type: 'place', ts: o.placementTs, opp: o }));
  while (events.length > 0) {
    events.sort((a, c) => a.ts - c.ts);
    const ev = events.shift();
    if (ev.type === 'place') {
      const o = ev.opp;
      const kellyFrac = Math.max(0, Math.min(1, (o.pTrue - o.price) / (1 - o.price)));
      const effectiveCapPct = KELLY_CAP_PCT * capScale(o.preAprilN);
      let stake = cash * Math.min(kellyFrac * KELLY_FRACTION, effectiveCapPct);
      const depthCapStake = DEPTH_CAP_PCT * (o.nearbyNotionalUsd || 0);
      stake = Math.min(stake, depthCapStake);
      const feeRatio = THETA * (1 - o.price);
      let totalOutlay = stake * (1 + feeRatio);
      if (totalOutlay > cash) { stake = cash / (1 + feeRatio); totalOutlay = cash; }
      if (stake < MIN_BET_USD || kellyFrac <= 0) {
        skipped.push({ ...o, reason: kellyFrac <= 0 ? 'zero/negative edge' : 'below $1 minimum' });
        continue;
      }
      const shares = stake / o.price;
      const fee = shares * THETA * o.price * (1 - o.price);
      cash -= stake + fee;
      outstandingTotal += stake;
      const netWorthAfterPlacement = recordNetWorth(o.placementTs);
      const rec = {
        placementDate: new Date(o.placementTs * 1000).toISOString(), sport: o.sport, type: o.type,
        band: o.band, side: o.side, usSlug: o.usSlug, price: o.price, pTrue: o.pTrue,
        stake, fee, netWorthAfterPlacement, won: o.won,
      };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake, shares });
    } else {
      const { rec, stake, shares } = ev;
      const payout = rec.won ? shares : 0; // ACTUAL realized outcome, not expected value
      cash += payout;
      outstandingTotal -= stake;
      rec.netWorthAfterResolution = recordNetWorth(ev.ts);
      rec.payout = payout;
      rec.pnl = payout - stake - rec.fee;
    }
  }

  const finalNetWorth = cash + outstandingTotal;
  console.log('date       | bucket                        | side | price  | stake      | won | pnl      | net worth after');
  for (const x of tradeLog) {
    const pnlStr = x.pnl >= 0 ? `+$${x.pnl.toFixed(2)}` : `-$${Math.abs(x.pnl).toFixed(2)}`;
    console.log([
      x.placementDate.slice(0, 10), (x.sport + ' ' + x.type + ' ' + x.band).padEnd(29), x.side.padEnd(4),
      x.price.toFixed(3).padEnd(6), ('$' + x.stake.toFixed(2)).padEnd(10), x.won ? 'W  ' : 'L  ',
      pnlStr.padEnd(9), '$' + x.netWorthAfterResolution.toFixed(2),
    ].join(' | '));
  }

  const byDay = {};
  for (const x of tradeLog) { const d = x.placementDate.slice(0, 10); (byDay[d] = byDay[d] || []).push(x); }
  const counts = Object.values(byDay).map((a) => a.length);
  const stakes = tradeLog.map((x) => x.stake);
  const wins = tradeLog.filter((x) => x.won).length;
  const losses = tradeLog.length - wins;

  console.log(`\nTrades: ${tradeLog.length} (${wins}W / ${losses}L, ${((wins / tradeLog.length) * 100).toFixed(1)}% win rate) | skipped: ${skipped.length}`);
  console.log(`End-of-month bankroll: $${finalNetWorth.toFixed(2)}  (return: ${(((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100).toFixed(1)}%)`);
  console.log(`Max drawdown: $${maxDrawdownAbs.toFixed(2)} (${maxDrawdownPct.toFixed(1)}% of peak $${peakNetWorth.toFixed(2)}), hit around ${maxDrawdownDate ? new Date(maxDrawdownDate * 1000).toISOString().slice(0, 10) : 'n/a'}`);
  console.log(`Bets/day: min=${Math.min(...counts)}, max=${Math.max(...counts)}, avg=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)} (${Object.keys(byDay).length} active days)`);
  console.log(`Stake/trade: min=$${Math.min(...stakes).toFixed(2)}, max=$${Math.max(...stakes).toFixed(2)}, avg=$${(stakes.reduce((a, b) => a + b, 0) / stakes.length).toFixed(2)}`);

  console.log('\nLosing trades (for context on the drawdown):');
  for (const x of tradeLog.filter((t) => !t.won)) {
    console.log(`  ${x.placementDate.slice(0, 10)} ${x.sport} ${x.type} price=${x.price.toFixed(3)} stake=$${x.stake.toFixed(2)} pnl=-$${Math.abs(x.pnl).toFixed(2)} netWorthAfter=$${x.netWorthAfterResolution.toFixed(2)}`);
  }

  fs.writeFileSync('finalWalkForwardApril2026_realized_results.json', JSON.stringify({ tradeLog, skipped, finalNetWorth, maxDrawdownAbs, maxDrawdownPct, peakNetWorth, maxDrawdownDate }, null, 1));
  console.log('\nSaved finalWalkForwardApril2026_realized_results.json');
}
main();
