// Side-specific liquidity audit for the isolated, correctly-parsed 'spread_1.5' bet type
// (full-game +/-1.5 run line, home+away pooled), h3/<=0.30/side=YES -- the bucket that
// cleared the train/test bias bar on the full 2070-event re-fetch (train n=340 bias=+6.5pp,
// test n=272 bias=+5.9pp). Same methodology as auditHoldoutLiquidity.js /
// auditMlbSpreadLiquidity.js: re-fetch real trades for a sample and check the SPECIFIC token
// (not aggregate) actually had >=$50 real notional near the checkpoint. r.gammaSlug here is
// now the exact, unambiguous market slug (e.g. mlb-bal-stl-2026-08-26-spread-away-1pt5), not
// "whichever Gamma listed first" -- that ambiguity is exactly what was fixed.
'use strict';

const fs = require('fs');
const path = require('path');

const CANDIDATE = { sport: 'mlb', marketType: 'spread_1.5', horizon: 'h3', band: '<=0.30', side: 'YES' };
const LIQUIDITY_WINDOW_SEC = 3 * 3600;
const SAMPLE_SIZE = 40;

function bandFor(price) {
  if (price <= 0.3) return '<=0.30';
  if (price < 0.4) return '0.30-0.40';
  return '>=0.40';
}

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
  const records = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'mlbSpread15Only.json'), 'utf8'));
  const eventCache = new Map();
  const b = CANDIDATE;

  const liquidRows = records.filter(
    (r) => r.checkpoints[b.horizon] && r.checkpoints[b.horizon].liquid && bandFor(r.checkpoints[b.horizon].price) === b.band
  );
  const step = Math.max(1, Math.floor(liquidRows.length / SAMPLE_SIZE));
  const sample = [];
  for (let i = 0; i < liquidRows.length && sample.length < SAMPLE_SIZE; i += step) sample.push(liquidRows[i]);

  console.log(`=== ${b.sport} ${b.marketType} ${b.horizon} ${b.band} [side=${b.side}] -- ${liquidRows.length} aggregate-liquid rows, sampling ${sample.length} ===\n`);

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
    if (!market) { sideUnfillable++; unfillableExamples.push({ usSlug: r.usSlug, gammaSlug: r.gammaSlug, reason: 'market not found on re-fetch' }); continue; }
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
      unfillableExamples.push({ usSlug: r.usSlug, gammaSlug: r.gammaSlug, aggregateNotional: totalNotional.toFixed(2), sideNotional: sideLiq.notional.toFixed(2), sideTradeCount: sideLiq.count });
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
  console.log(`mlb|spread_1.5|h3|<=0.30: ${sideUnfillable}/${sample.length} (${rate !== null ? (rate * 100).toFixed(1) + '%' : 'n/a'}) aggregate-liquid-but-not-side-fillable`);
}

main().catch((err) => { console.error(err); process.exit(1); });
