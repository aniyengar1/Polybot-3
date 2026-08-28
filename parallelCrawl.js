const fs = require('fs');

const TOTAL_ESTIMATE = 74000; // known end is between 72000-74000 from earlier probing
const START = Number(process.argv[2] || 40006);
const WORKERS = 6;
const chunkSize = Math.ceil((TOTAL_ESTIMATE - START) / WORKERS);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function crawlRange(rangeStart, rangeEnd, workerId) {
  const results = [];
  let offset = rangeStart;
  let pageSize = 10;
  let consecutiveFast = 0;
  while (offset < rangeEnd) {
    const limit = Math.min(pageSize, rangeEnd - offset);
    const url = `https://gateway.polymarket.us/v1/events?limit=${limit}&offset=${offset}`;
    const t0 = Date.now();
    let data;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'flb-research/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      pageSize = Math.max(1, Math.floor(pageSize / 3));
      await sleep(300);
      continue;
    }
    const elapsed = Date.now() - t0;
    const events = data.events || [];
    if (events.length === 0) break; // reached the real end before our estimated boundary
    for (const e of events) {
      results.push({
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
      pageSize = Math.max(1, Math.floor(pageSize / 2));
      consecutiveFast = 0;
    } else if (elapsed < 800) {
      consecutiveFast++;
      if (consecutiveFast >= 3 && pageSize < 20) {
        pageSize = Math.min(20, pageSize + 5);
        consecutiveFast = 0;
      }
    }
    await sleep(20);
  }
  console.log(`worker ${workerId} [${rangeStart}-${rangeEnd}) done: ${results.length} events`);
  return results;
}

async function main() {
  const ranges = [];
  for (let i = 0; i < WORKERS; i++) {
    const rangeStart = START + i * chunkSize;
    const rangeEnd = Math.min(TOTAL_ESTIMATE + 5000, rangeStart + chunkSize); // pad end in case real total > estimate
    ranges.push([rangeStart, rangeEnd]);
  }
  console.log('Ranges:', ranges);
  const allResults = await Promise.all(ranges.map(([s, e], i) => crawlRange(s, e, i)));
  const merged = allResults.flat();
  console.log(`Total new events fetched: ${merged.length}`);

  const existing = JSON.parse(fs.readFileSync('us_events_census_full.json', 'utf8'));
  const bySlug = new Map();
  for (const e of existing) bySlug.set(e.slug, e);
  for (const e of merged) bySlug.set(e.slug, e);
  const combined = [...bySlug.values()];
  fs.writeFileSync('us_events_census_full.json', JSON.stringify(combined, null, 1));
  console.log(`Combined total (deduped): ${combined.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
