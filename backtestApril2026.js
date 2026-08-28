// Genuine walk-forward, compounding, single-shared-bankroll simulation for April 2026
// regular-season games across the 5 validated buckets. Different from simulateLiquidity.js /
// executionCostAnalysis.js, which sized every bucket against its own independent $1,000
// bankroll in parallel -- this uses ONE $100 bankroll, shared across all 5 buckets, updated
// trade-by-trade in real chronological (placement-time) order, so it can actually go broke,
// get capital-constrained by overlapping open positions, etc.
//
// Lookahead check (see console output): NBA/NHL buckets' original train/test split already
// puts April 2026 inside the *test* half (test starts Jan/Feb 2026), so no contamination
// there. MLB's original train half (n=60) spans 2026-03-22 to 2026-06-13 -- i.e. it's mostly
// APRIL-JUNE data, not pre-April data. Using the original MLB train stat to size April bets
// would be lookahead. Fix: every bucket's model probability here is re-derived using ONLY
// liquid, band-matching rows with endDate < 2026-04-01, independent of the original
// train/test split.
const fs = require('fs');

const THETA = 0.05;
const KELLY_FRACTION = 0.225;
const KELLY_CAP_PCT = 0.05;
const MIN_BET_USD = 1; // Polymarket's real market-order minimum
const START_BANKROLL = 100;
const FILL_SEARCH_WINDOW_SEC = 3 * 3600;

const APR_START = new Date('2026-04-01T00:00:00Z');
const APR_END = new Date('2026-05-01T00:00:00Z');
// Regular-season cutoffs confirmed via web search: NBA 2025-26 regular season ends 2026-04-12,
// NHL 2025-26 regular season ends 2026-04-16, MLB 2026 regular season runs through 2026-09-27
// (all of April is regular season for MLB).
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    if (diff < bestAnyDiff) {
      bestAnyDiff = diff;
      bestAny = tr;
    }
    if (tr.side === 'BUY' && diff < bestSameDirDiff) {
      bestSameDirDiff = diff;
      bestSameDir = tr;
    }
  }
  const pick = bestSameDir || bestAny;
  return pick ? { price: pick.price, timestamp: pick.timestamp, sameDirection: !!bestSameDir } : null;
}

async function main() {
  const records = JSON.parse(fs.readFileSync('usSportsLiquidityFiltered_v2.json', 'utf8'));
  const eventCache = new Map();

  console.log('=== Step 1: lookahead check + pre-April edge re-derivation ===\n');
  const bucketInfo = [];
  for (const b of BUCKETS) {
    const typeRecords = records.filter((r) => r.sport === b.sport && r.submarketType === b.type);
    const liquidRows = typeRecords.filter((r) => r.checkpoints[b.horizon] && r.checkpoints[b.horizon].liquid);
    liquidRows.sort((a, c) => new Date(a.endDate) - new Date(c.endDate));
    const splitIdx = Math.floor(liquidRows.length / 2);
    const trainRange = liquidRows.length ? [liquidRows[0].endDate, liquidRows[splitIdx - 1]?.endDate] : null;
    const testRange = liquidRows.length ? [liquidRows[splitIdx]?.endDate, liquidRows[liquidRows.length - 1].endDate] : null;

    const preApril = liquidRows.filter((r) => new Date(r.endDate) < APR_START && bandFor(r.checkpoints[b.horizon].price) === b.band);
    const n = preApril.length;
    const avgPrice = preApril.reduce((s, r) => s + r.checkpoints[b.horizon].price, 0) / n;
    const realizedRateYes = preApril.reduce((s, r) => s + r.yesResolvedTo, 0) / n;

    const aprAll = liquidRows.filter((r) => new Date(r.endDate) >= APR_START && new Date(r.endDate) < APR_END && bandFor(r.checkpoints[b.horizon].price) === b.band);
    const aprRegSeason = aprAll.filter((r) => new Date(r.endDate) < REG_SEASON_END[b.sport]);

    const contaminated = trainRange && new Date(trainRange[1]) >= APR_START;
    console.log(`${b.sport} ${b.type} ${b.horizon} ${b.band} [side=${b.side}]`);
    console.log(`  original train range: ${trainRange[0]?.slice(0, 10)} .. ${trainRange[1]?.slice(0, 10)}  ${contaminated ? '*** ORIGINAL TRAIN OVERLAPS APRIL -- lookahead if reused ***' : '(clean, entirely pre-April)'}`);
    console.log(`  pre-April-only re-derived: n=${n}, avgPrice(YES)=${avgPrice.toFixed(3)}, realizedRate(YES)=${realizedRateYes.toFixed(3)}, bias=${((realizedRateYes - avgPrice) * 100).toFixed(1)}pp${n < 30 ? '  [THIN -- below the 30-obs threshold used everywhere else in this project]' : ''}`);
    console.log(`  April opportunities: all=${aprAll.length}, regular-season-only=${aprRegSeason.length}\n`);

    bucketInfo.push({ ...b, preAprilN: n, realizedRateYes, aprRows: aprRegSeason });
  }

  console.log('=== Step 2: fetching real fills for April regular-season opportunities ===\n');
  const opportunities = [];
  for (const b of bucketInfo) {
    for (const r of b.aprRows) {
      const eventSlug = r.usSlug.replace(/^aec-|^atc-/, '');
      let event = eventCache.get(eventSlug);
      if (event === undefined) {
        try {
          const evs = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${eventSlug}`);
          event = Array.isArray(evs) && evs.length > 0 ? evs[0] : null;
        } catch {
          event = null;
        }
        eventCache.set(eventSlug, event);
        await sleep(30);
      }
      const market = event ? (event.markets || []).find((m) => m.slug === r.gammaSlug) : null;
      if (!market) continue;
      let clobTokenIds;
      try {
        clobTokenIds = JSON.parse(market.clobTokenIds || '[]');
      } catch {
        clobTokenIds = [];
      }
      if (clobTokenIds.length !== 2) continue;
      const yesToken = clobTokenIds[0];
      const noToken = clobTokenIds[1];
      const ourToken = b.side === 'YES' ? yesToken : noToken;

      let trades;
      try {
        trades = await fetchJson(`https://data-api.polymarket.com/trades?market=${market.conditionId}&limit=2000`);
        if (!Array.isArray(trades)) trades = [];
      } catch {
        trades = [];
      }
      await sleep(30);

      const endTs = Math.floor(new Date(r.endDate).getTime() / 1000);
      const targetTs = endTs - b.horizonHours * 3600;
      const fill = bestFill(trades, ourToken, targetTs);
      if (!fill) {
        console.log(`  SKIP (unfillable): ${b.sport} ${b.type} ${r.usSlug}`);
        continue;
      }

      const pTrueYes = b.realizedRateYes;
      const pTrue = b.side === 'YES' ? pTrueYes : 1 - pTrueYes;
      // bestFill was called with ourToken (already side-selected), so fill.price is already
      // the price of the side we bought -- no further flip needed. The old `b.side === 'YES'
      // ? fill.price : 1 - fill.price` double-inverted the NO-side price back into the YES
      // price, understating true cost by 3-7x for NBA/NHL-spread/MLB (confirmed by forensic
      // audit 2026-08-26).
      const price = fill.price;
      const won = b.side === 'YES' ? r.yesResolvedTo === 1 : r.yesResolvedTo === 0;

      opportunities.push({
        sport: b.sport,
        type: b.type,
        band: b.band,
        side: b.side,
        usSlug: r.usSlug,
        placementTs: fill.timestamp,
        resolutionTs: endTs,
        price,
        pTrue,
        preAprilN: b.preAprilN,
        won,
      });
    }
  }
  opportunities.sort((a, c) => a.placementTs - c.placementTs);
  console.log(`\nTotal fillable April regular-season opportunities: ${opportunities.length}\n`);

  console.log('=== Step 3: event-driven walk-forward simulation, $100 shared bankroll ===\n');
  let cash = START_BANKROLL;
  let outstandingTotal = 0;
  let peakNetWorth = START_BANKROLL;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  const tradeLog = [];
  const skipped = [];

  // Build a merged timeline: a 'place' event per opportunity, and a 'resolve' event once we
  // know the stake (created at placement time, fired at resolutionTs).
  const timeline = opportunities.map((o) => ({ type: 'place', ts: o.placementTs, opp: o }));
  // Process placements in order; resolutions get inserted dynamically as we go, then the
  // whole thing is re-sorted incrementally via a simple pointer since resolution times are
  // always >= placement times and horizons are short (<=24h) relative to the month span.
  let events = [...timeline];

  function recordNetWorth(label, ts) {
    const netWorth = cash + outstandingTotal;
    if (netWorth > peakNetWorth) peakNetWorth = netWorth;
    const ddAbs = peakNetWorth - netWorth;
    const ddPct = peakNetWorth > 0 ? (ddAbs / peakNetWorth) * 100 : 0;
    if (ddAbs > maxDrawdownAbs) {
      maxDrawdownAbs = ddAbs;
      maxDrawdownPct = ddPct;
    }
    return netWorth;
  }

  while (events.length > 0) {
    events.sort((a, c) => a.ts - c.ts);
    const ev = events.shift();
    if (ev.type === 'place') {
      const o = ev.opp;
      const kellyFrac = Math.max(0, Math.min(1, (o.pTrue - o.price) / (1 - o.price)));
      let stake = cash * Math.min(kellyFrac * KELLY_FRACTION, KELLY_CAP_PCT);
      const feeRatio = THETA * (1 - o.price); // fee as a fraction of stake, see executionCostAnalysis.js derivation
      let totalOutlay = stake * (1 + feeRatio);
      if (totalOutlay > cash) {
        stake = cash / (1 + feeRatio);
        totalOutlay = cash;
      }
      if (stake < MIN_BET_USD || kellyFrac <= 0) {
        skipped.push({ ...o, reason: stake < MIN_BET_USD ? `stake $${stake.toFixed(2)} below $${MIN_BET_USD} minimum` : 'zero/negative Kelly edge' });
        continue;
      }
      const shares = stake / o.price;
      const fee = shares * THETA * o.price * (1 - o.price);
      const cashBefore = cash;
      cash -= stake + fee;
      outstandingTotal += stake;
      const netWorthAfterPlacement = recordNetWorth('place', ev.ts);
      const rec = {
        placementDate: new Date(o.placementTs * 1000).toISOString(),
        resolutionDate: new Date(o.resolutionTs * 1000).toISOString(),
        sport: o.sport, type: o.type, band: o.band, side: o.side, usSlug: o.usSlug,
        price: o.price, pTrue: o.pTrue, preAprilN: o.preAprilN,
        stake, fee, cashBefore, cashAfterPlacement: cash, netWorthAfterPlacement,
        won: o.won, resolved: false,
      };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake, shares });
    } else {
      const { rec, stake, shares } = ev;
      const payout = rec.won ? shares : 0;
      cash += payout;
      outstandingTotal -= stake;
      const netWorthAfterResolution = recordNetWorth('resolve', ev.ts);
      rec.resolved = true;
      rec.payout = payout;
      rec.pnl = payout - stake - rec.fee;
      rec.cashAfterResolution = cash;
      rec.netWorthAfterResolution = netWorthAfterResolution;
    }
  }

  console.log(`Trades placed: ${tradeLog.length}`);
  console.log(`Trades skipped (below minimum / no edge): ${skipped.length}`);
  for (const s of skipped) console.log(`  SKIPPED: ${s.sport} ${s.type} ${s.usSlug} -- ${s.reason}`);

  fs.writeFileSync('backtestApril2026_results.json', JSON.stringify({ tradeLog, skipped, finalCash: cash, maxDrawdownAbs, maxDrawdownPct, peakNetWorth }, null, 1));
  console.log('\nSaved backtestApril2026_results.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
