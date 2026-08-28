// Depth-capped, MLB-sensitivity variant of backtestApril2026.js. Same lookahead-clean
// pre-April edge derivation and real-fill fetch as before, but stake is now also capped at
// DEPTH_CAP_PCT of the real nearby trade notional observed at that checkpoint (not just the
// fractional-Kelly/bankroll cap) -- the original run showed stakes reaching 10-18x the real
// observed market activity by mid-April, which isn't achievable in reality.
//
// Runs two scenarios with the depth cap applied: all 5 buckets, and MLB excluded (to see how
// much of the result depends on MLB's thin 14-observation pre-April sample vs the more solid
// NBA/NHL buckets).
const fs = require('fs');

const THETA = 0.05;
const KELLY_FRACTION = 0.225;
const KELLY_CAP_PCT = 0.05;
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
  return pick ? { price: pick.price, timestamp: pick.timestamp, sameDirection: !!bestSameDir } : null;
}

async function getOpportunities() {
  const records = JSON.parse(fs.readFileSync('usSportsLiquidityFiltered_v2.json', 'utf8'));
  const eventCache = new Map();
  const bucketInfo = [];
  for (const b of BUCKETS) {
    const typeRecords = records.filter((r) => r.sport === b.sport && r.submarketType === b.type);
    const liquidRows = typeRecords.filter((r) => r.checkpoints[b.horizon] && r.checkpoints[b.horizon].liquid);
    const preApril = liquidRows.filter((r) => new Date(r.endDate) < APR_START && bandFor(r.checkpoints[b.horizon].price) === b.band);
    const n = preApril.length;
    const avgPrice = preApril.reduce((s, r) => s + r.checkpoints[b.horizon].price, 0) / n;
    const realizedRateYes = preApril.reduce((s, r) => s + r.yesResolvedTo, 0) / n;
    const aprAll = liquidRows.filter((r) => new Date(r.endDate) >= APR_START && new Date(r.endDate) < APR_END && bandFor(r.checkpoints[b.horizon].price) === b.band);
    const aprRegSeason = aprAll.filter((r) => new Date(r.endDate) < REG_SEASON_END[b.sport]);
    bucketInfo.push({ ...b, preAprilN: n, realizedRateYes, aprRows: aprRegSeason });
  }

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

      const pTrueYes = b.realizedRateYes;
      const pTrue = b.side === 'YES' ? pTrueYes : 1 - pTrueYes;
      // fill.price is already the price of the side we bought (bestFill was called with
      // ourToken) -- no further flip. See backtestApril2026.js for the bug this fixes.
      const price = fill.price;
      const won = b.side === 'YES' ? r.yesResolvedTo === 1 : r.yesResolvedTo === 0;
      const nearbyNotionalUsd = r.checkpoints[b.horizon].nearbyNotionalUsd;

      opportunities.push({
        sport: b.sport, type: b.type, band: b.band, side: b.side, usSlug: r.usSlug,
        placementTs: fill.timestamp, resolutionTs: endTs, price, pTrue, preAprilN: b.preAprilN,
        won, nearbyNotionalUsd,
      });
    }
  }
  opportunities.sort((a, c) => a.placementTs - c.placementTs);
  return opportunities;
}

function simulate(opportunities, { excludeMLB, label }) {
  const pool = excludeMLB ? opportunities.filter((o) => o.sport !== 'mlb') : opportunities;
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
        skipped.push({ ...o, reason: kellyFrac <= 0 ? 'zero/negative edge' : `stake $${stake.toFixed(2)} below $${MIN_BET_USD} minimum` });
        continue;
      }
      const shares = stake / o.price;
      const fee = shares * THETA * o.price * (1 - o.price);
      const cashBefore = cash;
      cash -= stake + fee;
      outstandingTotal += stake;
      const netWorthAfterPlacement = recordNetWorth();
      const rec = {
        placementDate: new Date(o.placementTs * 1000).toISOString(),
        sport: o.sport, type: o.type, band: o.band, side: o.side, usSlug: o.usSlug,
        price: o.price, nearbyNotionalUsd: o.nearbyNotionalUsd, depthCapped,
        stake, fee, cashBefore, netWorthAfterPlacement, won: o.won,
      };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake, shares });
    } else {
      const { rec, stake, shares } = ev;
      const payout = rec.won ? shares : 0;
      cash += payout;
      outstandingTotal -= stake;
      rec.netWorthAfterResolution = recordNetWorth();
      rec.payout = payout;
    }
  }

  console.log(`\n=== ${label} ===`);
  console.log(`Trades: ${tradeLog.length} (skipped: ${skipped.length}, of which depth-capped-to-zero-or-below-min: ${skipped.filter(s=>s.reason.includes('minimum')).length})`);
  const depthCappedCount = tradeLog.filter((t) => t.depthCapped).length;
  console.log(`Depth cap actually bound on ${depthCappedCount}/${tradeLog.length} trades`);
  console.log('date       | bucket                        | side | price  | stake      | depth-capped | won | net worth after');
  for (const x of tradeLog) {
    console.log([
      x.placementDate.slice(0, 10), (x.sport + ' ' + x.type + ' ' + x.band).padEnd(29), x.side.padEnd(4),
      x.price.toFixed(3).padEnd(6), ('$' + x.stake.toFixed(2)).padEnd(10), (x.depthCapped ? 'YES' : 'no').padEnd(12),
      x.won ? 'W  ' : 'L  ', '$' + x.netWorthAfterResolution.toFixed(2),
    ].join(' | '));
  }
  const byDay = {};
  for (const x of tradeLog) { const d = x.placementDate.slice(0, 10); (byDay[d] = byDay[d] || []).push(x); }
  const counts = Object.values(byDay).map((a) => a.length);
  const stakes = tradeLog.map((x) => x.stake);
  const finalNetWorth = cash + outstandingTotal;
  console.log(`\nEnd-of-month bankroll: $${finalNetWorth.toFixed(2)}  (return: ${(((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100).toFixed(1)}%)`);
  console.log(`Max drawdown: $${maxDrawdownAbs.toFixed(2)} (${maxDrawdownPct.toFixed(1)}% of peak $${peakNetWorth.toFixed(2)})`);
  console.log(`Bets/day: min=${Math.min(...counts)}, max=${Math.max(...counts)}, avg=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)} (over ${Object.keys(byDay).length} active days)`);
  console.log(`Stake/trade: min=$${Math.min(...stakes).toFixed(2)}, max=$${Math.max(...stakes).toFixed(2)}, avg=$${(stakes.reduce((a, b) => a + b, 0) / stakes.length).toFixed(2)}`);
  return { tradeLog, skipped, finalNetWorth, maxDrawdownAbs, maxDrawdownPct, peakNetWorth };
}

async function main() {
  console.log('Fetching real fills for all 63 April regular-season opportunities (cached to aprilOpportunities.json)...');
  const opportunities = await getOpportunities();
  fs.writeFileSync('aprilOpportunities.json', JSON.stringify(opportunities, null, 1));
  console.log(`Got ${opportunities.length} fillable opportunities.\n`);

  const withMLB = simulate(opportunities, { excludeMLB: false, label: 'DEPTH-CAPPED (20% of nearby notional), ALL 5 BUCKETS' });
  const noMLB = simulate(opportunities, { excludeMLB: true, label: 'DEPTH-CAPPED (20% of nearby notional), MLB EXCLUDED' });

  fs.writeFileSync('backtestApril2026_depthcap_results.json', JSON.stringify({ withMLB, noMLB }, null, 1));
  console.log('\nSaved backtestApril2026_depthcap_results.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
