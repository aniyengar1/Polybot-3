// Audits whether the historical "liquid" flag (fetchLiquidityFiltered.js / fetchMLBFixed.js)
// -- which is AGGREGATE across both sides of the market, confirmed by code inspection to
// have no per-token filter -- actually had a real fill on the SPECIFIC side each bucket
// trades. Re-fetches real trades for a sample from each of the 5 buckets and re-checks with
// a genuine side-specific bestFill, the same discipline the live scanner already applies.
'use strict';

const fs = require('fs');
const path = require('path');
const { BUCKETS, bandFor } = require('../buckets');

const LIQUIDITY_WINDOW_SEC = 3 * 3600; // same window the original aggregate check used
const SAMPLE_SIZE_PER_BUCKET = 20;

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

  console.log(`Re-checking a sample of ${SAMPLE_SIZE_PER_BUCKET} "aggregate liquid" checkpoints per bucket against a SIDE-SPECIFIC fill requirement.\n`);

  const summary = [];
  for (const b of BUCKETS) {
    const typeRecords = records.filter((r) => r.sport === b.sport && r.submarketType === b.marketType);
    const liquidRows = typeRecords.filter(
      (r) => r.checkpoints[b.horizon] && r.checkpoints[b.horizon].liquid && bandFor(r.checkpoints[b.horizon].price) === b.band
    );
    // Deterministic, evenly-spaced sample across the full date range rather than just the
    // first N (which would bias toward one season/month).
    const step = Math.max(1, Math.floor(liquidRows.length / SAMPLE_SIZE_PER_BUCKET));
    const sample = [];
    for (let i = 0; i < liquidRows.length && sample.length < SAMPLE_SIZE_PER_BUCKET; i += step) sample.push(liquidRows[i]);

    console.log(`=== ${b.sport} ${b.marketType} ${b.horizon} ${b.band} [side=${b.side}] -- ${liquidRows.length} aggregate-liquid rows, sampling ${sample.length} ===`);

    let sideFillable = 0;
    let sideUnfillable = 0;
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
      // total (aggregate, both sides) for comparison
      const totalNotional = trades.filter((tr) => Math.abs(tr.timestamp - targetTs) <= LIQUIDITY_WINDOW_SEC).reduce((s, tr) => s + tr.size * tr.price, 0);

      if (sideLiq.notional >= 50) {
        sideFillable++;
      } else {
        sideUnfillable++;
        unfillableExamples.push({ usSlug: r.usSlug, aggregateNotional: totalNotional.toFixed(2), sideNotional: sideLiq.notional.toFixed(2), sideTradeCount: sideLiq.count });
      }
    }

    console.log(`  side-specific fillable (>=$50 on our own side): ${sideFillable}/${sample.length}`);
    console.log(`  side-specific UNFILLABLE (aggregate said liquid, our side wasn't): ${sideUnfillable}/${sample.length}`);
    if (unfillableExamples.length) {
      console.log('  examples:');
      for (const ex of unfillableExamples.slice(0, 5)) console.log('   ', JSON.stringify(ex));
    }
    console.log();

    summary.push({ bucket: `${b.sport}|${b.marketType}|${b.horizon}|${b.band}`, sampled: sample.length, sideFillable, sideUnfillable, rateUnfillable: sample.length ? sideUnfillable / sample.length : null });
  }

  console.log('\n=== SUMMARY ===');
  for (const s of summary) {
    console.log(`${s.bucket}: ${s.sideUnfillable}/${s.sampled} sampled checkpoints (${s.rateUnfillable !== null ? (s.rateUnfillable * 100).toFixed(1) + '%' : 'n/a'}) were aggregate-liquid but NOT side-specific-fillable`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
