// Maps all 2,499 US sports events to their Gamma equivalents (prefix-strip, per
// INTEGRATION_NOTES.md's step 1 — 88% match rate confirmed on a 25-event sample), then
// pulls CLOB price history for up to 3 representative submarkets per event (moneyline,
// one spread, one total) to avoid pseudo-replication from many near-duplicate spread/total
// lines per game.
const fs = require('fs');

const CONCURRENCY = 15;
const CHECKPOINTS_HOURS_BEFORE = [168, 72, 24, 3];

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
      await sleep(400 * (attempt + 1));
    }
  }
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

    let type = null;
    if (m.slug === eventSlug) type = 'moneyline';
    else if (m.slug.includes('-team-total-')) continue; // skip, too many near-duplicates, not one of the 3 requested types
    else if (m.slug.includes('-spread-')) type = 'spread';
    else if (m.slug.includes('-total-')) type = 'total';
    if (!type || picks[type]) continue; // one representative per type per event

    picks[type] = {
      slug: m.slug,
      type,
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

async function processEvent(usEvent) {
  const strippedSlug = usEvent.slug.replace(/^aec-|^atc-/, '');
  let gammaEvents;
  try {
    gammaEvents = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${strippedSlug}`);
  } catch (err) {
    return { usSlug: usEvent.slug, mapped: false };
  }
  if (!Array.isArray(gammaEvents) || gammaEvents.length === 0) return { usSlug: usEvent.slug, mapped: false };
  const gammaEvent = gammaEvents[0];
  const endDate = gammaEvent.endDate || usEvent.endDate;
  const endTs = Math.floor(new Date(endDate).getTime() / 1000);

  const submarkets = pickSubmarkets(gammaEvent.markets || [], strippedSlug);
  if (submarkets.length === 0) return { usSlug: usEvent.slug, mapped: true, records: [] };

  const records = [];
  for (const sm of submarkets) {
    const startTs = endTs - 9 * 86400;
    const url = `https://clob.polymarket.com/prices-history?market=${sm.yesToken}&startTs=${startTs}&endTs=${endTs}&fidelity=30`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (err) {
      continue;
    }
    const history = data?.history || [];
    const checkpoints = {};
    for (const hoursBefore of CHECKPOINTS_HOURS_BEFORE) {
      checkpoints[`h${hoursBefore}`] = nearestPrice(history, endTs - hoursBefore * 3600);
    }
    records.push({
      usSlug: usEvent.slug,
      gammaSlug: sm.slug,
      submarketType: sm.type,
      endDate: new Date(endTs * 1000).toISOString(),
      yesResolvedTo: sm.yesResolvedTo,
      checkpoints,
    });
  }
  return { usSlug: usEvent.slug, mapped: true, records };
}

async function main() {
  const events = JSON.parse(fs.readFileSync('us_events_census.json', 'utf8'));
  console.log(`Processing all ${events.length} US sports events...`);

  const allRecords = [];
  let mappedCount = 0;
  let done = 0;
  for (let i = 0; i < events.length; i += CONCURRENCY) {
    const batch = events.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(processEvent));
    for (const r of results) {
      if (r.mapped) mappedCount++;
      if (r.records) allRecords.push(...r.records);
    }
    done += batch.length;
    if (done % 150 === 0 || done === events.length) {
      console.log(`  ${done}/${events.length} events processed, ${mappedCount} mapped, ${allRecords.length} submarket records so far`);
    }
    await sleep(80);
  }

  console.log(`\nMapping rate: ${mappedCount}/${events.length} (${((mappedCount / events.length) * 100).toFixed(0)}%)`);
  console.log(`Total submarket price-history records: ${allRecords.length}`);
  const byType = {};
  for (const r of allRecords) byType[r.submarketType] = (byType[r.submarketType] || 0) + 1;
  console.log('By submarket type:', byType);

  fs.writeFileSync('usSportsHistory.json', JSON.stringify(allRecords, null, 1));
  console.log('Saved to usSportsHistory.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
