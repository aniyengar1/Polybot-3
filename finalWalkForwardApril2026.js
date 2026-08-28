// Final, clean April 2026 walk-forward: $100 shared bankroll, one script, everything
// validated in this thread combined and nothing reused from the buggy lineage
// (backtestApril2026*.js / aprilOpportunities.json). Specifically:
//   - Pricing fix: bestFill already returns the price of the side actually bought (it's
//     called with ourToken, already side-selected) -- no re-flip. The old `side==='YES' ?
//     fill.price : 1-fill.price` double-inverted NO-side prices, understating true cost by
//     3-7x for NBA moneyline / NHL spread / MLB moneyline (forensic audit, 2026-08-26).
//   - Multi-month, strict pre-April (<2026-04-01) holdout win rate per bucket, used for BOTH
//     Kelly sizing and the payout itself (expected-value compounding, not April's actual
//     realized win/loss -- avoids relying on whatever luck April specifically had).
//   - NHL total: excluded from 2026-04-02 onward (last ~2 weeks of the regular season, the
//     window shown to have a broken checkpoint-vs-real-fill-price relationship in April but
//     not in January).
//   - Depth cap: stake <= 20% of real nearby trade notional at the checkpoint.
//   - Per-trade Kelly cap: 2% of current bankroll (requested as a reasonable middle ground;
//     1% was shown to be non-operable at $100 starting capital -- collides with Polymarket's
//     $1 minimum order size before the bankroll can grow -- and 5% was shown to compound to
//     implausible levels even before the pricing bug was found).
const fs = require('fs');

const THETA = 0.05;
const KELLY_FRACTION = 0.225;
const KELLY_CAP_PCT = 0.02;
// Sample-size-aware position cap (added 2026-08-26, calibrated against Dec2025/Jan2026/April2026).
// December's real-outcomes run showed the failure mode directly: NBA's holdout (n=23) modeled
// 95.7% but realized 80.0% -- a costly miss because the 2% cap was ALREADY binding on every
// trade (raw Kelly wanted 11-19% of bankroll), so probability shrinkage alone can't reduce
// exposure -- it has to touch the cap directly. capScale(n) = min(1, n/CAP_SHRINK_THRESHOLD)
// scales the effective cap down linearly for any bucket whose holdout n is below the
// threshold; buckets at or above it are untouched (scale=1). CAP_SHRINK_THRESHOLD=30 matches
// this project's pre-existing MIN_TRUSTED_N convention (analyzeLiquidityFiltered.js) and sits
// just below December's n=23 (which needed protection) while every large-n bucket tested
// (April NBA n=106, NHL moneyline n=200, NHL spread n=69; January NBA n=48, NHL moneyline
// n=92) sits comfortably above it and is left fully alone.
const CAP_SHRINK_THRESHOLD = 30;
function capScale(n) {
  return Math.min(1, n / CAP_SHRINK_THRESHOLD);
}
const DEPTH_CAP_PCT = 0.20;
const MIN_BET_USD = 1;
const START_BANKROLL = 100;
const FILL_SEARCH_WINDOW_SEC = 3 * 3600;

const APR_START = new Date('2026-04-01T00:00:00Z');
const APR_END = new Date('2026-05-01T00:00:00Z');
const REG_SEASON_END = {
  nba: new Date('2026-04-13T00:00:00Z'),
  nhl: new Date('2026-04-17T00:00:00Z'),
  mlb: APR_END,
};
const NHL_TOTAL_EXCLUDE_FROM = new Date('2026-04-02T00:00:00Z');

const BUCKETS = [
  { sport: 'nba', type: 'moneyline', horizon: 'h3', horizonHours: 3, band: '<=0.30', side: 'NO' },
  { sport: 'nhl', type: 'moneyline', horizon: 'h24', horizonHours: 24, band: '>=0.40', side: 'YES' },
  { sport: 'nhl', type: 'spread', horizon: 'h3', horizonHours: 3, band: '<=0.30', side: 'NO' },
  { sport: 'nhl', type: 'total', horizon: 'h24', horizonHours: 24, band: '>=0.40', side: 'YES' },
  { sport: 'mlb', type: 'moneyline', horizon: 'h24', horizonHours: 24, band: '0.30-0.40', side: 'NO' },
];

function bandFor(price) {
  if (price <= 0.3) return '<=0.30';
  if (price < 0.4) return '0.30-0.40';
  return '>=0.40';
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fetchJson(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'flb-research/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
}
function bestFill(trades, tokenId, targetTs) {
  let bestSameDir = null, bestSameDirDiff = Infinity;
  let bestAny = null, bestAnyDiff = Infinity;
  for (const tr of trades) {
    if (tr.asset !== tokenId) continue;
    const diff = Math.abs(tr.timestamp - targetTs);
    if (diff > FILL_SEARCH_WINDOW_SEC) continue;
    if (diff < bestAnyDiff) { bestAnyDiff = diff; bestAny = tr; }
    if (tr.side === 'BUY' && diff < bestSameDirDiff) { bestSameDirDiff = diff; bestSameDir = tr; }
  }
  const pick = bestSameDir || bestAny;
  return pick ? { price: pick.price, timestamp: pick.timestamp } : null;
}

async function main() {
  const records = JSON.parse(fs.readFileSync('usSportsLiquidityFiltered_v2.json', 'utf8'));

  console.log('=== Step 1: strict pre-April (<2026-04-01) holdout win rate per bucket ===\n');
  const bucketInfo = [];
  for (const b of BUCKETS) {
    const typeRecords = records.filter((r) => r.sport === b.sport && r.submarketType === b.type);
    const liquidRows = typeRecords.filter((r) => r.checkpoints[b.horizon] && r.checkpoints[b.horizon].liquid);
    const preApril = liquidRows.filter((r) => new Date(r.endDate) < APR_START && bandFor(r.checkpoints[b.horizon].price) === b.band);
    const n = preApril.length;
    const realizedRateYes = preApril.reduce((s, r) => s + r.yesResolvedTo, 0) / n;
    const pTrue = b.side === 'YES' ? realizedRateYes : 1 - realizedRateYes;

    let aprAll = liquidRows.filter((r) => new Date(r.endDate) >= APR_START && new Date(r.endDate) < APR_END && bandFor(r.checkpoints[b.horizon].price) === b.band);
    aprAll = aprAll.filter((r) => new Date(r.endDate) < REG_SEASON_END[b.sport]);
    if (b.sport === 'nhl' && b.type === 'total') {
      aprAll = aprAll.filter((r) => new Date(r.endDate) < NHL_TOTAL_EXCLUDE_FROM);
    }

    console.log(`${b.sport} ${b.type} ${b.horizon} ${b.band} [side=${b.side}]: pre-April n=${n}, pTrue=${pTrue.toFixed(3)}, April opportunities (post all filters)=${aprAll.length}`);
    bucketInfo.push({ ...b, preAprilN: n, pTrue, aprRows: aprAll });
  }

  console.log('\n=== Step 2: fresh fetch of real fills (correct pricing, no cache reuse) ===\n');
  const eventCache = new Map();
  const opportunities = [];
  for (const b of bucketInfo) {
    for (const r of b.aprRows) {
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
      const oldBuggyPrice = 1 - fill.price; // for the record only, not used in sizing

      opportunities.push({
        sport: b.sport, type: b.type, band: b.band, side: b.side, usSlug: r.usSlug,
        placementTs: fill.timestamp, resolutionTs: endTs,
        price: fill.price, oldBuggyPrice, pTrue: b.pTrue, preAprilN: b.preAprilN,
        won, nearbyNotionalUsd: r.checkpoints[b.horizon].nearbyNotionalUsd,
      });
    }
  }
  opportunities.sort((a, c) => a.placementTs - c.placementTs);
  fs.writeFileSync('finalWalkForwardApril2026_opportunities.json', JSON.stringify(opportunities, null, 1));
  console.log(`Fetched ${opportunities.length} fillable opportunities (fresh, correct pricing).\n`);

  console.log('=== For the record: old buggy price vs correct price, NBA/NHL-spread/MLB (side=NO buckets) ===');
  const noSideTrades = opportunities.filter((o) => o.side === 'NO');
  for (const o of noSideTrades.slice(0, 10)) {
    const correctShares = 1 / o.price;
    const buggyShares = 1 / o.oldBuggyPrice;
    console.log(`  ${o.sport} ${o.usSlug}: correct price=${o.price.toFixed(3)} (${correctShares.toFixed(2)} shares/$1) | old buggy price=${o.oldBuggyPrice.toFixed(3)} (${buggyShares.toFixed(2)} shares/$1) | inflation=${(buggyShares / correctShares).toFixed(2)}x`);
  }
  const avgInflation = noSideTrades.reduce((s, o) => s + (1 / o.oldBuggyPrice) / (1 / o.price), 0) / noSideTrades.length;
  console.log(`  ... (${noSideTrades.length} total NO-side trades this month; average payout-multiple inflation from the bug: ${avgInflation.toFixed(2)}x)\n`);

  console.log('=== Step 3: event-driven walk-forward, $100 shared bankroll, EV/holdout-based compounding, 2% cap + 20% depth cap ===\n');
  let cash = START_BANKROLL;
  let outstandingTotal = 0;
  let peakNetWorth = START_BANKROLL;
  let maxDrawdownAbs = 0, maxDrawdownPct = 0;
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
      const netWorthAfterPlacement = recordNetWorth();
      const rec = {
        placementDate: new Date(o.placementTs * 1000).toISOString(), sport: o.sport, type: o.type,
        band: o.band, side: o.side, usSlug: o.usSlug, price: o.price, pTrue: o.pTrue,
        stake, fee, netWorthAfterPlacement, actualWon: o.won,
      };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake, shares, pTrue: o.pTrue });
    } else {
      const { rec, stake, shares, pTrue } = ev;
      cash += pTrue * shares; // expected-value payout (holdout rate), not April's actual outcome
      outstandingTotal -= stake;
      rec.netWorthAfterResolution = recordNetWorth();
    }
  }

  const finalNetWorth = cash + outstandingTotal;
  console.log('date       | bucket                        | side | price  | pTrue  | stake      | net worth after');
  for (const x of tradeLog) {
    console.log([
      x.placementDate.slice(0, 10), (x.sport + ' ' + x.type + ' ' + x.band).padEnd(29), x.side.padEnd(4),
      x.price.toFixed(3).padEnd(6), x.pTrue.toFixed(3).padEnd(6), ('$' + x.stake.toFixed(2)).padEnd(10),
      '$' + x.netWorthAfterResolution.toFixed(2),
    ].join(' | '));
  }

  const byDay = {};
  for (const x of tradeLog) { const d = x.placementDate.slice(0, 10); (byDay[d] = byDay[d] || []).push(x); }
  const counts = Object.values(byDay).map((a) => a.length);
  const stakes = tradeLog.map((x) => x.stake);

  console.log(`\nTrades: ${tradeLog.length} (skipped: ${skipped.length})`);
  console.log(`End-of-month bankroll: $${finalNetWorth.toFixed(2)}  (return: ${(((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100).toFixed(1)}%)`);
  console.log(`Max drawdown: $${maxDrawdownAbs.toFixed(2)} (${maxDrawdownPct.toFixed(1)}% of peak $${peakNetWorth.toFixed(2)})`);
  console.log(`Bets/day: min=${Math.min(...counts)}, max=${Math.max(...counts)}, avg=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)} (${Object.keys(byDay).length} active days)`);
  console.log(`Stake/trade: min=$${Math.min(...stakes).toFixed(2)}, max=$${Math.max(...stakes).toFixed(2)}, avg=$${(stakes.reduce((a, b) => a + b, 0) / stakes.length).toFixed(2)}`);

  fs.writeFileSync('finalWalkForwardApril2026_results.json', JSON.stringify({ tradeLog, skipped, finalNetWorth, maxDrawdownAbs, maxDrawdownPct, peakNetWorth }, null, 1));
  console.log('\nSaved finalWalkForwardApril2026_results.json');
}

main().catch((err) => { console.error(err); process.exit(1); });
