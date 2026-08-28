// Diagnostic: is NHL total's "checkpoint price vs real achievable fill price" divergence
// (which zeroed out all 16 April opportunities) an April-specific fluke, or does it show up
// in other months too? January 2026 has a comparable count of qualifying opportunities (23,
// vs April's 23) in the same >=0.40 band at the same h24 horizon, so it's a fair comparison.
const fs = require('fs');

const FILL_SEARCH_WINDOW_SEC = 3 * 3600;
const JAN_START = new Date('2026-01-01T00:00:00Z');
const JAN_END = new Date('2026-02-01T00:00:00Z');

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
  const typeRecords = records.filter((r) => r.sport === 'nhl' && r.submarketType === 'total');
  const liquidRows = typeRecords.filter((r) => r.checkpoints.h24 && r.checkpoints.h24.liquid);
  const janRows = liquidRows.filter((r) => {
    const d = new Date(r.endDate);
    return d >= JAN_START && d < JAN_END && bandFor(r.checkpoints.h24.price) === '>=0.40';
  });
  console.log(`January 2026 NHL total >=0.40 h24 candidates: ${janRows.length}\n`);

  // Use the same pre-period-only model prob a live strategy would have had in January: derive
  // from data strictly before January 2026 (mirrors the April methodology's discipline).
  const preJan = liquidRows.filter((r) => new Date(r.endDate) < JAN_START && bandFor(r.checkpoints.h24.price) === '>=0.40');
  const pTrueYes = preJan.reduce((s, r) => s + r.yesResolvedTo, 0) / preJan.length;
  console.log(`Pre-January model: n=${preJan.length}, pTrue(YES)=${pTrueYes.toFixed(3)}\n`);

  const eventCache = new Map();
  let zeroEdgeCount = 0;
  let positiveEdgeCount = 0;
  const rows = [];
  for (const r of janRows) {
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
    const yesToken = clobTokenIds[0];

    let trades;
    try {
      trades = await fetchJson(`https://data-api.polymarket.com/trades?market=${market.conditionId}&limit=2000`);
      if (!Array.isArray(trades)) trades = [];
    } catch { trades = []; }
    await sleep(30);

    const endTs = Math.floor(new Date(r.endDate).getTime() / 1000);
    const targetTs = endTs - 24 * 3600;
    const fill = bestFill(trades, yesToken, targetTs);
    const checkpointPrice = r.checkpoints.h24.price;
    if (!fill) {
      console.log(`  ${r.usSlug}: UNFILLABLE`);
      continue;
    }
    const gap = fill.price - checkpointPrice;
    const edge = pTrueYes - fill.price;
    if (edge <= 0) zeroEdgeCount++; else positiveEdgeCount++;
    rows.push({ usSlug: r.usSlug, checkpointPrice, realFillPrice: fill.price, gap, edge });
    console.log(`  ${r.usSlug}: checkpoint=${checkpointPrice.toFixed(3)}  realFill=${fill.price.toFixed(3)}  gap=${(gap*100).toFixed(1)}pp  edge-vs-pTrue(${pTrueYes.toFixed(3)})=${(edge*100).toFixed(1)}pp  ${edge<=0?'[ZERO/NEG EDGE]':''}`);
  }

  console.log(`\nJanuary 2026: ${positiveEdgeCount} positive-edge / ${zeroEdgeCount} zero-or-negative-edge out of ${rows.length} fillable`);
  const avgGap = rows.reduce((s, r) => s + r.gap, 0) / rows.length;
  console.log(`Average (realFill - checkpoint) gap: ${(avgGap * 100).toFixed(1)}pp`);
  fs.writeFileSync('nhlTotalJan2026Check.json', JSON.stringify(rows, null, 1));
}

main().catch((err) => { console.error(err); process.exit(1); });
