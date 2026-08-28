// Open item #2 from SPORTS_STRATEGY_STATUS.md: the P&L sim so far used idealized
// last-observed-price fills (the CLOB prices-history series), which is a smoothed
// series, not a fill price. This script re-derives realistic entry prices for the
// 4 surviving candidate buckets' test-half trades by pulling the actual nearby taker
// trades and using the nearest same-direction (BUY on our side's token) trade price
// as the fill -- i.e. what a real taker order would actually have paid. It also
// applies Polymarket US's real sports taker fee: fee = shares * theta * p * (1-p),
// theta = 0.05 (confirmed via help.polymarket.com/en/articles/13364478, effective
// July 2026), which is notional * theta * (1-p) in dollar terms.
const fs = require('fs');

const THETA = 0.05;
const BANKROLL = 1000;
const FLAT_BET = 50;
const KELLY_FRACTION = 0.225;
const KELLY_CAP_PCT = 0.05;
const FILL_SEARCH_WINDOW_SEC = 3 * 3600; // same window liquidity was screened with

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

function bandFor(price) {
  if (price <= 0.3) return '<=0.30';
  if (price < 0.4) return '0.30-0.40';
  return '>=0.40';
}

function kellyFraction(modelProb, marketPrice) {
  if (marketPrice <= 0 || marketPrice >= 1) return 0;
  const f = (modelProb - marketPrice) / (1 - marketPrice);
  return Math.max(0, Math.min(1, f));
}

// Best real fill: nearest-in-time BUY trade on the token we'd be buying (side of
// the bias). Falls back to nearest trade of any taker direction on that token if no
// same-direction trade exists in the window (still a real executed price, just not
// guaranteed to be a taker-buy).
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
  return pick ? { price: pick.price, sameDirection: !!bestSameDir } : null;
}

async function main() {
  const rawRecords = JSON.parse(fs.readFileSync('usSportsLiquidityFiltered_v2.json', 'utf8'));
  const records = rawRecords;
  const candidates = JSON.parse(fs.readFileSync('liquidityFilteredCandidates.json', 'utf8'));

  const eventCache = new Map(); // usSlug -> gamma event

  const results = [];
  let grandOld = { flatPnl: 0, n: 0, wins: 0 };
  let grandNew = { flatPnl: 0, n: 0, wins: 0, unfillable: 0 };
  let grandOldKelly = { pnl: 0, staked: 0, n: 0 };
  let grandNewKelly = { pnl: 0, staked: 0, n: 0 };

  for (const c of candidates) {
    const { sport, type, horizon, band, train } = c;
    const side = train.bias > 0 ? 'YES' : 'NO';
    const pTrueYes = train.realizedRate;

    const typeRecords = records.filter((r) => r.sport === sport && r.submarketType === type);
    const liquidRows = typeRecords.filter((r) => r.checkpoints[horizon] && r.checkpoints[horizon].liquid);
    liquidRows.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));
    const splitIdx = Math.floor(liquidRows.length / 2);
    const testRows = liquidRows.slice(splitIdx);
    const testTrades = testRows.filter((r) => bandFor(r.checkpoints[horizon].price) === band);

    console.log(`\n=== ${sport} | ${type} | ${horizon} | ${band} | side=${side} (n=${testTrades.length}) ===`);

    const horizonHours = parseInt(horizon.slice(1), 10);
    let bucketOld = { flatPnl: 0, n: 0, wins: 0 };
    let bucketNew = { flatPnl: 0, n: 0, wins: 0, unfillable: 0, sameDirCount: 0 };
    let bucketOldKelly = { pnl: 0, staked: 0, n: 0 };
    let bucketNewKelly = { pnl: 0, staked: 0, n: 0 };
    const priceDeltas = [];

    let done = 0;
    for (const r of testTrades) {
      done++;
      const oldYesPrice = r.checkpoints[horizon].price;
      const oldPrice = side === 'YES' ? oldYesPrice : 1 - oldYesPrice;
      const pTrue = side === 'YES' ? pTrueYes : 1 - pTrueYes;
      const won = side === 'YES' ? r.yesResolvedTo === 1 : r.yesResolvedTo === 0;

      // old (idealized) flat P&L
      const oldFlatPayout = won ? FLAT_BET / oldPrice : 0;
      bucketOld.flatPnl += oldFlatPayout - FLAT_BET;
      bucketOld.n++;
      if (won) bucketOld.wins++;
      const oldKellyF = kellyFraction(pTrue, oldPrice);
      const oldStake = BANKROLL * Math.min(oldKellyF * KELLY_FRACTION, KELLY_CAP_PCT);
      if (oldStake >= 1) {
        const oldKellyPayout = won ? oldStake / oldPrice : 0;
        bucketOldKelly.pnl += oldKellyPayout - oldStake;
        bucketOldKelly.staked += oldStake;
        bucketOldKelly.n++;
      }

      // resolve conditionId/clobTokenIds for this market
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
      if (!market) {
        bucketNew.unfillable++;
        continue;
      }
      let clobTokenIds;
      try {
        clobTokenIds = JSON.parse(market.clobTokenIds || '[]');
      } catch {
        clobTokenIds = [];
      }
      if (clobTokenIds.length !== 2) {
        bucketNew.unfillable++;
        continue;
      }
      const yesToken = clobTokenIds[0];
      const noToken = clobTokenIds[1];
      const ourToken = side === 'YES' ? yesToken : noToken;

      let trades;
      try {
        trades = await fetchJson(`https://data-api.polymarket.com/trades?market=${market.conditionId}&limit=2000`);
        if (!Array.isArray(trades)) trades = [];
      } catch {
        trades = [];
      }
      await sleep(30);

      const endTs = Math.floor(new Date(r.endDate).getTime() / 1000);
      const targetTs = endTs - horizonHours * 3600;
      const fill = bestFill(trades, ourToken, targetTs);
      if (!fill) {
        bucketNew.unfillable++;
        continue;
      }
      const newPrice = fill.price;
      priceDeltas.push(newPrice - oldPrice);
      if (fill.sameDirection) bucketNew.sameDirCount++;

      // realistic flat P&L: fill at real trade price, pay taker fee on notional
      const shares = FLAT_BET / newPrice;
      const fee = shares * THETA * newPrice * (1 - newPrice);
      const newFlatPayout = won ? shares * 1 - fee : -fee; // buy `shares`, pay fee upfront regardless of outcome
      // cost basis: paid FLAT_BET + fee to acquire `shares`; payout on win = shares (each winning share = $1)
      const netFlatPnl = (won ? shares : 0) - FLAT_BET - fee;
      bucketNew.flatPnl += netFlatPnl;
      bucketNew.n++;
      if (won) bucketNew.wins++;

      const newKellyF = kellyFraction(pTrue, newPrice);
      const newStake = BANKROLL * Math.min(newKellyF * KELLY_FRACTION, KELLY_CAP_PCT);
      if (newStake >= 1) {
        const kShares = newStake / newPrice;
        const kFee = kShares * THETA * newPrice * (1 - newPrice);
        const netKellyPnl = (won ? kShares : 0) - newStake - kFee;
        bucketNewKelly.pnl += netKellyPnl;
        bucketNewKelly.staked += newStake;
        bucketNewKelly.n++;
      }

      if (done % 25 === 0) console.log(`  ...${done}/${testTrades.length} rows fetched`);
    }

    const avgDelta = priceDeltas.length ? priceDeltas.reduce((a, b) => a + b, 0) / priceDeltas.length : null;
    console.log(`  fillable: ${bucketNew.n}/${testTrades.length} (unfillable/no-nearby-trade: ${bucketNew.unfillable}, same-direction taker match: ${bucketNew.sameDirCount}/${bucketNew.n})`);
    console.log(`  avg (realFillPrice - historyPrice) in our trade direction: ${avgDelta === null ? 'n/a' : (avgDelta * 100).toFixed(2) + 'pp'} (positive = real fill was worse/more expensive than the idealized checkpoint price)`);
    console.log(`  OLD (idealized, no fee) flat P&L: n=${bucketOld.n}, wins=${bucketOld.wins} (${((bucketOld.wins / bucketOld.n) * 100).toFixed(1)}%), P&L=$${bucketOld.flatPnl.toFixed(2)}`);
    console.log(`  NEW (real fill + taker fee) flat P&L: n=${bucketNew.n}, wins=${bucketNew.wins} (${bucketNew.n ? ((bucketNew.wins / bucketNew.n) * 100).toFixed(1) : 'n/a'}%), P&L=$${bucketNew.flatPnl.toFixed(2)}`);
    console.log(`  OLD Kelly P&L: $${bucketOldKelly.pnl.toFixed(2)} (n=${bucketOldKelly.n}, staked=$${bucketOldKelly.staked.toFixed(2)})`);
    console.log(`  NEW Kelly P&L: $${bucketNewKelly.pnl.toFixed(2)} (n=${bucketNewKelly.n}, staked=$${bucketNewKelly.staked.toFixed(2)})`);

    results.push({ sport, type, horizon, band, bucketOld, bucketNew, avgDelta, sameDirRate: bucketNew.n ? bucketNew.sameDirCount / bucketNew.n : null });

    grandOld.flatPnl += bucketOld.flatPnl; grandOld.n += bucketOld.n; grandOld.wins += bucketOld.wins;
    grandNew.flatPnl += bucketNew.flatPnl; grandNew.n += bucketNew.n; grandNew.wins += bucketNew.wins; grandNew.unfillable += bucketNew.unfillable;
    grandOldKelly.pnl += bucketOldKelly.pnl; grandOldKelly.staked += bucketOldKelly.staked; grandOldKelly.n += bucketOldKelly.n;
    grandNewKelly.pnl += bucketNewKelly.pnl; grandNewKelly.staked += bucketNewKelly.staked; grandNewKelly.n += bucketNewKelly.n;
  }

  console.log('\n\n=== COMBINED across all 4 candidate buckets ===');
  console.log(`OLD (idealized) flat: n=${grandOld.n}, wins=${grandOld.wins} (${((grandOld.wins / grandOld.n) * 100).toFixed(1)}%), P&L=$${grandOld.flatPnl.toFixed(2)}`);
  console.log(`NEW (real fill + fee) flat: n=${grandNew.n} (unfillable dropped: ${grandNew.unfillable}), wins=${grandNew.wins} (${((grandNew.wins / grandNew.n) * 100).toFixed(1)}%), P&L=$${grandNew.flatPnl.toFixed(2)}`);
  console.log(`OLD Kelly: P&L=$${grandOldKelly.pnl.toFixed(2)}, staked=$${grandOldKelly.staked.toFixed(2)}, n=${grandOldKelly.n}`);
  console.log(`NEW Kelly: P&L=$${grandNewKelly.pnl.toFixed(2)}, staked=$${grandNewKelly.staked.toFixed(2)}, n=${grandNewKelly.n}`);
  console.log(`Degradation (flat): $${(grandOld.flatPnl - grandNew.flatPnl).toFixed(2)} (${(((grandOld.flatPnl - grandNew.flatPnl) / grandOld.flatPnl) * 100).toFixed(1)}% of idealized P&L)`);

  fs.writeFileSync('executionCostResults.json', JSON.stringify({ perBucket: results, grandOld, grandNew, grandOldKelly, grandNewKelly }, null, 1));
  console.log('\nSaved executionCostResults.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
