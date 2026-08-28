// Root-cause finding (2026-08-26): MLB was excluded on a misdiagnosis. The real bug isn't
// "wrong game grabbed within a series" -- exact-slug Gamma lookups correctly and uniquely
// map each MLB event, preserving series order (verified on real 4-game series). The actual
// problem is that Gamma's own `endDate` field for MLB events is itself wrong -- consistently
// ~7 days LATER than the real game (verified: price history converges to a resolved 0/1
// outcome, and the last real trade lands, days before Gamma's claimed endDate, right around
// the date embedded in the US slug). fetchLiquidityFiltered.js trusted `gammaEvent.endDate`
// for MLB and got a systematically wrong reference time, which explains why liquidity only
// ever showed up at the "168h before" checkpoint (that checkpoint, computed from the wrong
// endDate, was accidentally landing right at the REAL game time) and never at 72h/24h/3h
// (which, computed from the wrong endDate, landed AFTER the real game had already resolved
// and gone quiet).
//
// Fix: don't trust either platform's `endDate` metadata for MLB. Derive the real end time
// directly from the market's own trade activity -- the timestamp of the last real trade is
// a robust, self-correcting signal of when the game actually resolved, immune to whatever
// slug/date bug either platform has. Recompute all 4 checkpoints against that corrected time.
const fs = require('fs');

const CONCURRENCY = 20;
const CHECKPOINTS_HOURS_BEFORE = [168, 72, 24, 3];
const LIQUIDITY_WINDOW_SEC = 3 * 3600;
const MIN_NOTIONAL_USD = 50;
// Observed offset is ~7-8 days; use a generous safety margin for the price-history fetch
// window since it's just a fetch bound, not the real endTs computation.
const SAFETY_MARGIN_DAYS = 12;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, retries = 2) {
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

// FIX (2026-08-27): identical bug and identical fix as fetchLiquidityFiltered.js's
// pickSubmarkets -- see that file for the full finding (a single MLB event can list up to 6
// structurally different spread contracts, previously collapsed into whichever Gamma listed
// first). Same exact-slug parser, same pooled-by-favorite convention.
function parseSpreadSlug(slug, eventSlug) {
  const suffix = slug.slice(eventSlug.length);
  const m = suffix.match(/^-(f5-)?spread-(home|away)-(\d+pt\d+)$/);
  if (!m) return null;
  return { isF5: Boolean(m[1]), side: m[2], points: parseFloat(m[3].replace('pt', '.')) };
}

function pickSubmarkets(gammaMarkets, eventSlug) {
  const picks = {};
  for (const m of gammaMarkets) {
    let outcomePrices;
    try {
      outcomePrices = JSON.parse(m.outcomePrices || '[]');
    } catch {
      continue;
    }
    if (!(outcomePrices.length === 2 && ((outcomePrices[0] === '1' && outcomePrices[1] === '0') || (outcomePrices[0] === '0' && outcomePrices[1] === '1')))) continue;
    let clobTokenIds;
    try {
      clobTokenIds = JSON.parse(m.clobTokenIds || '[]');
    } catch {
      continue;
    }
    if (clobTokenIds.length !== 2) continue;

    let dedupeKey = null;
    let type = null;
    if (m.slug === eventSlug) {
      dedupeKey = type = 'moneyline';
    } else if (m.slug.includes('-team-total-')) {
      continue;
    } else if (m.slug.includes('-spread-')) {
      const parsed = parseSpreadSlug(m.slug, eventSlug);
      if (!parsed) continue;
      dedupeKey = `spread_${parsed.isF5 ? 'f5' : 'full'}_${parsed.side}_${parsed.points}`;
      type = `spread${parsed.isF5 ? '_f5' : ''}_${parsed.points}`;
    } else if (m.slug.includes('-total-')) {
      // NOTE: 'total' markets likely have the same multi-line ambiguity spread did --
      // unaddressed here, out of scope for this fix. Flagging, not fixing.
      dedupeKey = type = 'total';
    }
    if (!type || picks[dedupeKey]) continue;

    picks[dedupeKey] = {
      slug: m.slug,
      type,
      conditionId: m.conditionId,
      yesToken: clobTokenIds[0],
      yesResolvedTo: outcomePrices[0] === '1' ? 1 : 0,
    };
  }
  return Object.values(picks);
}

function nearestPrice(history, targetTs) {
  if (!history || history.length === 0) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const pt of history) {
    const diff = Math.abs(pt.t - targetTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = pt;
    }
  }
  if (bestDiff > 6 * 3600) return null;
  return { price: best.p };
}

// FIX (2026-08-26): was aggregate across both sides -- same bug and same fix as
// fetchLiquidityFiltered.js's notionalNear (this function was copy-forward from there when
// this MLB-specific script was written, carrying the bug along unexamined). See that file
// for the full audit finding.
function notionalNear(trades, tokenId, targetTs) {
  let notional = 0;
  let count = 0;
  for (const tr of trades) {
    if (tr.asset !== tokenId) continue;
    if (Math.abs(tr.timestamp - targetTs) <= LIQUIDITY_WINDOW_SEC) {
      notional += tr.size * tr.price;
      count++;
    }
  }
  return { notional, count };
}

async function processEvent(usEvent) {
  const strippedSlug = usEvent.slug.replace(/^aec-|^atc-/, '');
  let gammaEvents;
  try {
    gammaEvents = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${strippedSlug}`);
  } catch {
    return { usSlug: usEvent.slug, mapped: false, records: [] };
  }
  if (!Array.isArray(gammaEvents) || gammaEvents.length === 0) return { usSlug: usEvent.slug, mapped: false, records: [] };
  const gammaEvent = gammaEvents[0];
  // Upper-bound-only guess, just to size the price-history fetch window -- not used as the
  // real endTs. Real endTs comes from actual trade activity, computed per-submarket below.
  const gammaEndTs = Math.floor(new Date(gammaEvent.endDate || usEvent.endDate).getTime() / 1000);
  const fetchWindowStart = gammaEndTs - SAFETY_MARGIN_DAYS * 86400;

  const submarkets = pickSubmarkets(gammaEvent.markets || [], strippedSlug);
  if (submarkets.length === 0) return { usSlug: usEvent.slug, mapped: true, records: [] };

  const records = [];
  for (const sm of submarkets) {
    let history, trades;
    try {
      const [histData, tradesData] = await Promise.all([
        fetchJson(`https://clob.polymarket.com/prices-history?market=${sm.yesToken}&startTs=${fetchWindowStart}&endTs=${gammaEndTs}&fidelity=30`),
        fetchJson(`https://data-api.polymarket.com/trades?market=${sm.conditionId}&limit=2000`),
      ]);
      history = histData?.history || [];
      trades = Array.isArray(tradesData) ? tradesData : [];
    } catch {
      continue;
    }

    // Real endTs: last real trade timestamp (most robust, self-correcting signal). Fall
    // back to the last price-history point if a market genuinely has zero trades.
    let realEndTs = null;
    if (trades.length > 0) {
      realEndTs = Math.max(...trades.map((t) => t.timestamp));
    } else if (history.length > 0) {
      realEndTs = history[history.length - 1].t;
    }
    if (realEndTs === null) continue;

    const checkpoints = {};
    for (const hoursBefore of CHECKPOINTS_HOURS_BEFORE) {
      const targetTs = realEndTs - hoursBefore * 3600;
      const priceInfo = nearestPrice(history, targetTs);
      const liq = notionalNear(trades, sm.yesToken, targetTs);
      checkpoints[`h${hoursBefore}`] = priceInfo
        ? { price: priceInfo.price, nearbyNotionalUsd: liq.notional, nearbyTradeCount: liq.count, liquid: liq.notional >= MIN_NOTIONAL_USD }
        : null;
    }
    records.push({
      usSlug: usEvent.slug,
      gammaSlug: sm.slug,
      sport: 'mlb',
      submarketType: sm.type,
      endDate: new Date(realEndTs * 1000).toISOString(),
      gammaEndDateRaw: gammaEvent.endDate,
      yesResolvedTo: sm.yesResolvedTo,
      checkpoints,
    });
  }
  return { usSlug: usEvent.slug, mapped: true, records };
}

async function main() {
  const allEvents = JSON.parse(fs.readFileSync('us_events_census_full.json', 'utf8'));
  const now = new Date();
  const targetEvents = allEvents.filter((e) => e.closed && e.endDate && new Date(e.endDate) <= now && e.slug.replace(/^aec-|^atc-/, '').startsWith('mlb-'));
  console.log(`Target MLB events: ${targetEvents.length}`);

  const allRecords = [];
  let mappedCount = 0;
  let done = 0;
  for (let i = 0; i < targetEvents.length; i += CONCURRENCY) {
    const batch = targetEvents.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(processEvent));
    for (const r of results) {
      if (r.mapped) mappedCount++;
      if (r.records) allRecords.push(...r.records);
    }
    done += batch.length;
    if (done % 200 === 0 || done === targetEvents.length) {
      console.log(`  ${done}/${targetEvents.length} events, ${mappedCount} mapped, ${allRecords.length} submarket records so far`);
      fs.writeFileSync('usMLBFixed.json', JSON.stringify(allRecords, null, 1));
    }
    await sleep(30);
  }

  console.log(`\nMapping rate: ${mappedCount}/${targetEvents.length}`);
  console.log(`Total submarket records: ${allRecords.length}`);
  fs.writeFileSync('usMLBFixed.json', JSON.stringify(allRecords, null, 1));
  console.log('Saved usMLBFixed.json');
}

module.exports = { processEvent, pickSubmarkets, parseSpreadSlug, nearestPrice, notionalNear };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
