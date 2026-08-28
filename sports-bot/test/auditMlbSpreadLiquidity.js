// Same side-specific liquidity audit methodology as auditHoldoutLiquidity.js, applied to the
// MLB spread CANDIDATE bucket (not yet in production buckets.js) before it's allowed anywhere
// near the live scanner. Candidate definition taken from liquidityFilteredCandidates.json:
// sport=mlb, type=spread, horizon=h3, band=<=0.30, train bias +0.051 (n=121), test bias
// +0.088 (n=37) -- both POSITIVE, so per the same sign convention already confirmed for the
// 3 live buckets (positive bias -> YES underpriced -> buy YES; negative bias -> buy NO), this
// candidate's side is YES.
'use strict';

const fs = require('fs');
const path = require('path');
const { bandFor } = require('../buckets');

const CANDIDATE = { sport: 'mlb', marketType: 'spread', horizon: 'h3', band: '<=0.30', side: 'YES' };
const LIQUIDITY_WINDOW_SEC = 3 * 3600;
const SAMPLE_SIZE = 40;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fetchJson(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'sports-bot/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
}

function sideSpecificNotional(trades, tokenId, targetTs) {
  let notional = 0, count = 0;
  for (const tr of trades) {
    if (tr.asset !== tokenId) continue;
    if (Math.abs(tr.timestamp - targetTs) <= LIQUIDITY_WINDOW_SEC) {
      notional += tr.size * tr.price;
      count++;
    }
  }
  return { notional, count };
}

async function main() {
  const records = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'usSportsLiquidityFiltered_v2.json'), 'utf8'));
  const eventCache = new Map();
  const b = CANDIDATE;

  const typeRecords = records.filter((r) => r.sport === b.sport && r.submarketType === b.marketType);
  const liquidRows = typeRecords.filter(
    (r) => r.checkpoints[b.horizon] && r.checkpoints[b.horizon].liquid && bandFor(r.checkpoints[b.horizon].price) === b.band
  );
  const step = Math.max(1, Math.floor(liquidRows.length / SAMPLE_SIZE));
  const sample = [];
  for (let i = 0; i < liquidRows.length && sample.length < SAMPLE_SIZE; i += step) sample.push(liquidRows[i]);

  console.log(`=== ${b.sport} ${b.marketType} ${b.horizon} ${b.band} [side=${b.side}] (CANDIDATE, not in production buckets.js) -- ${liquidRows.length} aggregate-liquid rows, sampling ${sample.length} ===\n`);

  let sideFillable = 0, sideUnfillable = 0;
  const unfillableExamples = [];

  for (const r of sample) {
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
    if (!market) { sideUnfillable++; unfillableExamples.push({ usSlug: r.usSlug, reason: 'market not found on re-fetch' }); continue; }
    let clobTokenIds;
    try { clobTokenIds = JSON.parse(market.clobTokenIds || '[]'); } catch { clobTokenIds = []; }
    if (clobTokenIds.length !== 2) { sideUnfillable++; unfillableExamples.push({ usSlug: r.usSlug, reason: 'bad clobTokenIds' }); continue; }
    const ourToken = b.side === 'YES' ? clobTokenIds[0] : clobTokenIds[1];

    let trades;
    try {
      trades = await fetchJson(`https://data-api.polymarket.com/trades?market=${market.conditionId}&limit=2000`);
      if (!Array.isArray(trades)) trades = [];
    } catch {
      trades = [];
    }
    await sleep(30);

    const endTs = Math.floor(new Date(r.endDate).getTime() / 1000);
    const targetTs = endTs - parseInt(b.horizon.slice(1), 10) * 3600;
    const sideLiq = sideSpecificNotional(trades, ourToken, targetTs);
    const totalNotional = trades.filter((tr) => Math.abs(tr.timestamp - targetTs) <= LIQUIDITY_WINDOW_SEC).reduce((s, tr) => s + tr.size * tr.price, 0);

    if (sideLiq.notional >= 50) {
      sideFillable++;
    } else {
      sideUnfillable++;
      unfillableExamples.push({ usSlug: r.usSlug, aggregateNotional: totalNotional.toFixed(2), sideNotional: sideLiq.notional.toFixed(2), sideTradeCount: sideLiq.count });
    }
  }

  console.log(`side-specific fillable (>=$50 on our own side): ${sideFillable}/${sample.length}`);
  console.log(`side-specific UNFILLABLE (aggregate said liquid, our side wasn't): ${sideUnfillable}/${sample.length}`);
  if (unfillableExamples.length) {
    console.log('examples:');
    for (const ex of unfillableExamples.slice(0, 8)) console.log(' ', JSON.stringify(ex));
  }

  const rate = sample.length ? sideUnfillable / sample.length : null;
  console.log(`\n=== RESULT ===`);
  console.log(`mlb|spread|h3|<=0.30: ${sideUnfillable}/${sample.length} (${rate !== null ? (rate * 100).toFixed(1) + '%' : 'n/a'}) aggregate-liquid-but-not-side-fillable`);
  console.log('For reference, the 3 live buckets audited clean, and NHL spread/total were dropped at 40%/20% contamination.');
}

main().catch((err) => { console.error(err); process.exit(1); });
