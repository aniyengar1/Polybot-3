// Discovers resolved, binary (Yes/No), sufficiently-liquid markets across categories via
// Gamma API's tag_slug filtering (confirmed working 2026-08-26 — INTEGRATION_NOTES.md
// only documents Gamma for Polymarket-US-scoped discovery; this uses the same host but
// the full global-Polymarket catalog, since that's where the cited studies' cross-category
// sample (politics/sports/crypto) actually lives).
const fs = require('fs');

const CATEGORIES = ['politics', 'sports', 'crypto'];
const MIN_VOLUME = 5000; // filters out dust/toy markets with too few real trades to trust a price
const PAGE_SIZE = 100; // Gamma caps at 100 regardless of requested limit (verified)
const MAX_PAGES_PER_CATEGORY = 15; // ~1500 events/category before filtering

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'flb-research/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function discoverCategory(tagSlug) {
  const markets = [];
  for (let page = 0; page < MAX_PAGES_PER_CATEGORY; page++) {
    const offset = page * PAGE_SIZE;
    const url = `https://gamma-api.polymarket.com/events?tag_slug=${tagSlug}&closed=true&limit=${PAGE_SIZE}&offset=${offset}`;
    let events;
    try {
      events = await fetchJson(url);
    } catch (err) {
      console.error(`  page ${page} failed: ${err.message}`);
      break;
    }
    if (!Array.isArray(events) || events.length === 0) break;

    for (const ev of events) {
      for (const m of ev.markets || []) {
        let outcomePrices;
        try {
          outcomePrices = JSON.parse(m.outcomePrices || '[]');
        } catch {
          continue;
        }
        // Only clean binary resolutions: exactly one of ["1","0"] / ["0","1"].
        if (!(outcomePrices.length === 2 && ((outcomePrices[0] === '1' && outcomePrices[1] === '0') || (outcomePrices[0] === '0' && outcomePrices[1] === '1')))) {
          continue;
        }
        const volume = Number(m.volumeNum ?? m.volume ?? 0);
        if (volume < MIN_VOLUME) continue;
        let clobTokenIds;
        try {
          clobTokenIds = JSON.parse(m.clobTokenIds || '[]');
        } catch {
          continue;
        }
        if (clobTokenIds.length !== 2) continue;
        const endDate = m.closedTime || m.endDate;
        if (!endDate) continue;

        markets.push({
          category: tagSlug,
          slug: m.slug,
          eventSlug: ev.slug,
          volume,
          endDate: new Date(endDate).toISOString(),
          yesToken: clobTokenIds[0],
          yesResolvedTo: outcomePrices[0] === '1' ? 1 : 0,
        });
      }
    }
    console.log(`  ${tagSlug} page ${page}: ${events.length} events, ${markets.length} qualifying markets so far`);
    if (events.length < PAGE_SIZE) break; // last page
    await sleep(150);
  }
  return markets;
}

async function main() {
  const all = [];
  for (const cat of CATEGORIES) {
    console.log(`=== ${cat} ===`);
    const markets = await discoverCategory(cat);
    console.log(`  total qualifying: ${markets.length}`);
    all.push(...markets);
  }
  fs.writeFileSync('markets.json', JSON.stringify(all, null, 1));
  console.log(`\nSaved ${all.length} markets to markets.json`);
  const byCat = {};
  for (const m of all) byCat[m.category] = (byCat[m.category] || 0) + 1;
  console.log('By category:', byCat);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
