// Census of the ACTUAL Polymarket US catalog via gateway.polymarket.us/v1/events
// (unauthenticated, confirmed working 2026-08-26 — this is the same host the weather bot
// uses for scanning, just used here as a full-catalog bulk listing instead of a
// slug/search lookup). api.polymarket.us itself requires an API key even for reads
// (confirmed: 401 "Missing required API key headers" on GET /v1/markets) so this is the
// only accessible unauthenticated census surface.
const PAGE_SIZE = 500;
const MAX_PAGES = 60; // generous ceiling; loop breaks early once a short page is seen

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'flb-research/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const all = [];
  const seenSlugs = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const url = `https://gateway.polymarket.us/v1/events?limit=${PAGE_SIZE}&offset=${offset}`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (err) {
      console.error(`page ${page} failed: ${err.message}`);
      break;
    }
    const events = data.events || [];
    let newCount = 0;
    for (const e of events) {
      if (seenSlugs.has(e.slug)) continue;
      seenSlugs.add(e.slug);
      all.push(e);
      newCount++;
    }
    console.log(`page ${page} (offset ${offset}): ${events.length} returned, ${newCount} new, ${all.length} total so far`);
    if (events.length < PAGE_SIZE || newCount === 0) break; // end of data or looping
    await sleep(150);
  }

  console.log(`\n=== Total distinct events: ${all.length} ===\n`);

  const byCat = new Map();
  for (const e of all) {
    const cat = e.category || '(none)';
    if (!byCat.has(cat)) byCat.set(cat, { total: 0, closed: 0, open: 0, marketsTotal: 0, marketsClosed: 0 });
    const s = byCat.get(cat);
    s.total++;
    if (e.closed) s.closed++;
    else s.open++;
    for (const m of e.markets || []) {
      s.marketsTotal++;
      if (m.closed) s.marketsClosed++;
    }
  }

  console.log('category | events(total) | events(closed) | events(open) | markets(total) | markets(closed)');
  const sorted = [...byCat.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [cat, s] of sorted) {
    console.log(`${cat} | ${s.total} | ${s.closed} | ${s.open} | ${s.marketsTotal} | ${s.marketsClosed}`);
  }

  require('fs').writeFileSync('us_events_census.json', JSON.stringify(all, null, 1));
  console.log('\nSaved full census to us_events_census.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
