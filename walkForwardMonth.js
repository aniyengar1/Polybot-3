// Parameterized version of finalWalkForwardApril2026.js -- same fixed pricing, same caps,
// same holdout discipline (strict pre-test-month data, no lookahead), run against an
// arbitrary month instead of hardcoded to April. Used to confirm April wasn't a uniquely
// easy month by re-running December 2025 and January 2026.
//
// Reconnaissance (2026-08-26) already showed December has ZERO pre-period holdout data for
// any NHL bucket (NHL history only starts appearing ~2025-12-06) -- so December can only
// test NBA moneyline under strict walk-forward discipline. MLB has zero data in both months
// (season doesn't start until ~2026-03-22) -- structural, not a bug. Buckets with holdout
// n=0 are skipped entirely (reported, not silently dropped) rather than faked.
const fs = require('fs');

const THETA = 0.05;
const KELLY_FRACTION = 0.225;
const KELLY_CAP_PCT = 0.02;
// Sample-size-aware position cap -- see finalWalkForwardApril2026.js for the full derivation.
// December's real-outcomes run (n=23 holdout) showed 95.7% modeled vs 80.0% realized, costly
// because the 2% cap was already binding regardless of the probability estimate; probability
// shrinkage alone doesn't reduce exposure in that regime, only capping the position size does.
// Threshold=30 matches this project's pre-existing MIN_TRUSTED_N convention; buckets at or
// above it are untouched.
const CAP_SHRINK_THRESHOLD = 30;
function capScale(n) {
  return Math.min(1, n / CAP_SHRINK_THRESHOLD);
}
const DEPTH_CAP_PCT = 0.20;
const MIN_BET_USD = 1;
const START_BANKROLL = 100;
const FILL_SEARCH_WINDOW_SEC = 3 * 3600;

const NHL_SEASON_END_EXCLUDE_FROM = new Date('2026-04-02T00:00:00Z'); // only relevant if testing April

const ALL_BUCKETS = [
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

async function getOpportunities(testStart, testEnd, label) {
  const records = JSON.parse(fs.readFileSync('usSportsLiquidityFiltered_v2.json', 'utf8'));

  console.log(`=== ${label}: holdout (strict data before ${testStart.toISOString()}) ===`);
  const bucketInfo = [];
  for (const b of ALL_BUCKETS) {
    const typeRecords = records.filter((r) => r.sport === b.sport && r.submarketType === b.type);
    const liquidRows = typeRecords.filter((r) => r.checkpoints[b.horizon] && r.checkpoints[b.horizon].liquid);
    const holdoutRows = liquidRows.filter((r) => new Date(r.endDate) < testStart && bandFor(r.checkpoints[b.horizon].price) === b.band);
    const n = holdoutRows.length;

    let testRows = liquidRows.filter((r) => new Date(r.endDate) >= testStart && new Date(r.endDate) < testEnd && bandFor(r.checkpoints[b.horizon].price) === b.band);
    let nhlExclusionApplied = false;
    if (b.sport === 'nhl' && b.type === 'total') {
      const before = testRows.length;
      testRows = testRows.filter((r) => new Date(r.endDate) < NHL_SEASON_END_EXCLUDE_FROM);
      nhlExclusionApplied = before !== testRows.length; // no-op (false) for Dec/Jan, only bites near season end
    }

    if (n === 0) {
      console.log(`  ${b.sport} ${b.type} ${b.horizon} ${b.band}: holdout n=0 -- NO PRE-PERIOD DATA, bucket skipped entirely for this month (not faked).`);
      continue;
    }
    const realizedRateYes = holdoutRows.reduce((s, r) => s + r.yesResolvedTo, 0) / n;
    const pTrue = b.side === 'YES' ? realizedRateYes : 1 - realizedRateYes;
    console.log(`  ${b.sport} ${b.type} ${b.horizon} ${b.band} [side=${b.side}]: holdout n=${n}${n < 30 ? ' [THIN]' : ''}, pTrue=${pTrue.toFixed(3)}, test-month opportunities=${testRows.length}${nhlExclusionApplied ? ' (seasonal exclusion applied)' : ''}`);
    bucketInfo.push({ ...b, holdoutN: n, pTrue, testRows });
  }
  console.log();

  const eventCache = new Map();
  const opportunities = [];
  for (const b of bucketInfo) {
    for (const r of b.testRows) {
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
      opportunities.push({
        sport: b.sport, type: b.type, band: b.band, side: b.side, usSlug: r.usSlug,
        placementTs: fill.timestamp, resolutionTs: endTs,
        price: fill.price, pTrue: b.pTrue, holdoutN: b.holdoutN,
        won, nearbyNotionalUsd: r.checkpoints[b.horizon].nearbyNotionalUsd,
      });
    }
  }
  opportunities.sort((a, c) => a.placementTs - c.placementTs);
  return opportunities;
}

function simulate(opportunities, { useEV, label }) {
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
      const effectiveCapPct = KELLY_CAP_PCT * capScale(o.holdoutN);
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
      recordNetWorth();
      const rec = { placementDate: new Date(o.placementTs * 1000).toISOString(), sport: o.sport, type: o.type, stake, won: o.won };
      tradeLog.push(rec);
      events.push({ type: 'resolve', ts: o.resolutionTs, rec, stake, shares, pTrue: o.pTrue });
    } else {
      const { rec, stake, shares, pTrue } = ev;
      const payout = useEV ? pTrue * shares : (rec.won ? shares : 0);
      cash += payout;
      outstandingTotal -= stake;
      recordNetWorth();
      rec.netWorthAfterResolution = cash + outstandingTotal;
    }
  }

  const finalNetWorth = cash + outstandingTotal;
  const byDay = {};
  for (const x of tradeLog) { const d = x.placementDate.slice(0, 10); (byDay[d] = byDay[d] || []).push(x); }
  const counts = Object.values(byDay).map((a) => a.length);
  const stakes = tradeLog.map((x) => x.stake);
  const wins = tradeLog.filter((x) => x.won).length;

  console.log(`--- ${label} ---`);
  console.log(`Trades: ${tradeLog.length} (${wins}W/${tradeLog.length - wins}L, ${tradeLog.length ? ((wins / tradeLog.length) * 100).toFixed(1) : 'n/a'}% realized win rate) | skipped: ${skipped.length}`);
  console.log(`End-of-month bankroll: $${finalNetWorth.toFixed(2)} (return: ${(((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100).toFixed(1)}%)`);
  console.log(`Max drawdown: $${maxDrawdownAbs.toFixed(2)} (${maxDrawdownPct.toFixed(1)}% of peak $${peakNetWorth.toFixed(2)})`);
  if (counts.length) {
    console.log(`Bets/day: min=${Math.min(...counts)}, max=${Math.max(...counts)}, avg=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)} (${Object.keys(byDay).length} active days)`);
    console.log(`Stake/trade: min=$${Math.min(...stakes).toFixed(2)}, max=$${Math.max(...stakes).toFixed(2)}, avg=$${(stakes.reduce((a, b) => a + b, 0) / stakes.length).toFixed(2)}`);
  }
  return { finalNetWorth, returnPct: ((finalNetWorth - START_BANKROLL) / START_BANKROLL) * 100, maxDrawdownAbs, maxDrawdownPct, n: tradeLog.length, wins };
}

async function runMonth(testStart, testEnd, label) {
  const opportunities = await getOpportunities(testStart, testEnd, label);
  fs.writeFileSync(`walkForward_${label}_opportunities.json`, JSON.stringify(opportunities, null, 1));
  console.log(`Fetched ${opportunities.length} fillable opportunities for ${label}.\n`);
  const ev = simulate(opportunities, { useEV: true, label: `${label} EV/holdout-based` });
  const real = simulate(opportunities, { useEV: false, label: `${label} REAL outcomes` });
  console.log();
  return { ev, real };
}

async function main() {
  const dec = await runMonth(new Date('2025-12-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'), 'DEC2025');
  const jan = await runMonth(new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'), 'JAN2026');
  fs.writeFileSync('walkForwardMonth_summary.json', JSON.stringify({ dec, jan }, null, 1));
  console.log('Saved walkForwardMonth_summary.json');
}
main().catch((err) => { console.error(err); process.exit(1); });
