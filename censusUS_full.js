// Full fresh census of gateway.polymarket.us/v1/events as of now (Aug 2026).
// The catalog has grown far beyond the 2,499 seen in the last census (that one stopped
// early, and pagination itself is unreliable at scale: large offsets sometimes hit slow
// records, e.g. World Cup markets, that blow the gateway's ~10s timeout at bigger page
// sizes). This crawls adaptively: response time controls page size.
const fs = require('fs');

const MAX_PAGE_SIZE = 25;
const MIN_PAGE_SIZE = 1;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const startOffset = Number(process.argv[2] || 0);
  const all = startOffset > 0 ? JSON.parse(fs.readFileSync('us_events_census_full.json', 'utf8')) : [];
  let offset = startOffset;
  let pageSize = 10;
  let consecutiveFastSuccesses = 0;

  while (true) {
    const url = `https://gateway.polymarket.us/v1/events?limit=${pageSize}&offset=${offset}`;
    const t0 = Date.now();
    let data;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'flb-research/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.error(`offset ${offset} pageSize ${pageSize} failed after ${elapsed}ms: ${err.message}`);
      pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 3));
      consecutiveFastSuccesses = 0;
      await sleep(300);
      continue; // retry same offset with smaller page
    }
    const elapsed = Date.now() - t0;
    const events = data.events || [];
    if (events.length === 0) break;

    for (const e of events) {
      all.push({
        slug: e.slug,
        category: e.category,
        closed: e.closed,
        active: e.active,
        startDate: e.startDate,
        endDate: e.endDate,
        createdAt: e.createdAt,
        marketCount: (e.markets || []).length,
      });
    }
    offset += events.length;

    if (elapsed > 3000) {
      pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2));
      consecutiveFastSuccesses = 0;
    } else if (elapsed < 800) {
      consecutiveFastSuccesses++;
      if (consecutiveFastSuccesses >= 3 && pageSize < MAX_PAGE_SIZE) {
        pageSize = Math.min(MAX_PAGE_SIZE, pageSize + 5);
        consecutiveFastSuccesses = 0;
      }
    }

    if (all.length % 2000 < pageSize + 5) console.log(`  fetched ${all.length} so far (offset ${offset}, pageSize ${pageSize})...`);
    if (offset % 1000 < pageSize + 5) fs.writeFileSync('us_events_census_full.json', JSON.stringify(all, null, 1));
    await sleep(30);
  }
  console.log(`\nTotal events fetched: ${all.length}\n`);
  fs.writeFileSync('us_events_census_full.json', JSON.stringify(all, null, 1));
  console.log('Saved us_events_census_full.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
