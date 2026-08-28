// Targeted historical re-fetch for ONLY the isolated 'spread_1.5' submarket type (full-game
// +/-1.5 run line, home+away pooled -- see fetchMLBFixed.js's parseSpreadSlug/pickSubmarkets
// for the exact-slug fix and pooling rationale). A full fetchMLBFixed.js main() run now
// returns up to ~13 distinct submarkets per event (all point values x home/away x f5,
// correctly disambiguated instead of collapsed) -- correct, but far more API calls per event
// than this specific re-derivation needs, and observed to make a full re-run impractically
// slow. This reuses pickSubmarkets/nearestPrice/notionalNear verbatim (same corrected logic,
// same MIN_NOTIONAL_USD liquidity bar) but filters submarkets down to spread_1.5 BEFORE the
// expensive per-submarket price-history/trades fetches, restoring roughly the original
// per-event cost.
'use strict';
const fs = require('fs');
const path = require('path');
const { pickSubmarkets, nearestPrice, notionalNear } = require('../../fetchMLBFixed');

const CONCURRENCY = 20;
const CHECKPOINTS_HOURS_BEFORE = [168, 72, 24, 3];
const SAFETY_MARGIN_DAYS = 12;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
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

async function processEventSpread15Only(usEvent) {
  const strippedSlug = usEvent.slug.replace(/^aec-|^atc-/, '');
  let gammaEvents;
  try {
    gammaEvents = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${strippedSlug}`);
  } catch {
    return { usSlug: usEvent.slug, mapped: false, records: [] };
  }
  if (!Array.isArray(gammaEvents) || gammaEvents.length === 0) return { usSlug: usEvent.slug, mapped: false, records: [] };
  const gammaEvent = gammaEvents[0];
  const gammaEndTs = Math.floor(new Date(gammaEvent.endDate || usEvent.endDate).getTime() / 1000);
  const fetchWindowStart = gammaEndTs - SAFETY_MARGIN_DAYS * 86400;

  const allSubmarkets = pickSubmarkets(gammaEvent.markets || [], strippedSlug);
  const submarkets = allSubmarkets.filter((sm) => sm.type === 'spread_1.5'); // the ONLY filter difference from fetchMLBFixed.js's processEvent
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
        ? { price: priceInfo.price, nearbyNotionalUsd: liq.notional, nearbyTradeCount: liq.count, liquid: liq.notional >= 50 }
        : null;
    }
    records.push({
      usSlug: usEvent.slug,
      gammaSlug: sm.slug,
      sport: 'mlb',
      submarketType: sm.type,
      endDate: new Date(realEndTs * 1000).toISOString(),
      yesResolvedTo: sm.yesResolvedTo,
      checkpoints,
    });
  }
  return { usSlug: usEvent.slug, mapped: true, records };
}

async function main() {
  const allEvents = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'us_events_census_full.json'), 'utf8'));
  const now = new Date();
  const targetEvents = allEvents.filter((e) => e.closed && e.endDate && new Date(e.endDate) <= now && e.slug.replace(/^aec-|^atc-/, '').startsWith('mlb-'));
  console.log(`Target MLB events: ${targetEvents.length}`);

  const allRecords = [];
  let mappedCount = 0;
  let done = 0;
  for (let i = 0; i < targetEvents.length; i += CONCURRENCY) {
    const batch = targetEvents.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(processEventSpread15Only));
    for (const r of results) {
      if (r.mapped) mappedCount++;
      if (r.records) allRecords.push(...r.records);
    }
    done += batch.length;
    if (done % 200 === 0 || done === targetEvents.length) {
      console.log(`  ${done}/${targetEvents.length} events, ${mappedCount} mapped, ${allRecords.length} spread_1.5 records so far`);
      fs.writeFileSync(path.join(__dirname, '..', '..', 'mlbSpread15Only.json'), JSON.stringify(allRecords, null, 1));
    }
    await sleep(30);
  }

  console.log(`\nMapping rate: ${mappedCount}/${targetEvents.length}`);
  console.log(`Total spread_1.5 records: ${allRecords.length}`);
  fs.writeFileSync(path.join(__dirname, '..', '..', 'mlbSpread15Only.json'), JSON.stringify(allRecords, null, 1));
  console.log('Saved mlbSpread15Only.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
