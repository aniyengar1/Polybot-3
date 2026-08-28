// For each sampled market, fetches hourly price history covering the final 8 days before
// resolution and extracts price at 4 checkpoints (7d/3d/1d/3h before resolution). Uses
// CLOB's /prices-history (last-trade-price series — no historical bid/ask exists via any
// public endpoint; /book only serves the current/live book, confirmed empty for closed
// markets. This is disclosed, not silently substituted, and matches how large-sample
// academic studies at this scale operate anyway — trade-price series, not reconstructed
// historical order books).
const fs = require('fs');

const SAMPLE_PER_CATEGORY = 350;
const CONCURRENCY = 8;
const CHECKPOINTS_HOURS_BEFORE = [168, 72, 24, 3]; // 7d, 3d, 1d, 3h

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
      await sleep(500 * (attempt + 1));
    }
  }
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
  // Don't accept a match more than 6 hours away from the intended checkpoint — better to
  // report missing than silently use a stale/irrelevant point.
  if (bestDiff > 6 * 3600) return null;
  return { price: best.p, actualTs: best.t, diffSeconds: bestDiff };
}

async function processMarket(m) {
  const endTs = Math.floor(new Date(m.endDate).getTime() / 1000);
  const startTs = endTs - 9 * 86400; // 9-day lookback window covers all checkpoints with margin
  const url = `https://clob.polymarket.com/prices-history?market=${m.yesToken}&startTs=${startTs}&endTs=${endTs}&fidelity=30`;
  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    return { ...m, error: String(err) };
  }
  const history = data?.history || [];
  const checkpoints = {};
  for (const hoursBefore of CHECKPOINTS_HOURS_BEFORE) {
    const targetTs = endTs - hoursBefore * 3600;
    checkpoints[`h${hoursBefore}`] = nearestPrice(history, targetTs);
  }
  return { ...m, nHistoryPoints: history.length, checkpoints };
}

async function main() {
  const all = JSON.parse(fs.readFileSync('markets.json', 'utf8'));
  const byCat = {};
  for (const m of all) {
    if (!byCat[m.category]) byCat[m.category] = [];
    byCat[m.category].push(m);
  }

  const sample = [];
  for (const cat of Object.keys(byCat)) {
    const pool = byCat[cat];
    // Fisher-Yates shuffle, then take the first N — preserves date/time diversity rather
    // than biasing toward however the API happened to paginate (mostly recent-first).
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    sample.push(...pool.slice(0, SAMPLE_PER_CATEGORY));
  }
  console.log(`Sampled ${sample.length} markets (${SAMPLE_PER_CATEGORY}/category target)`);

  const results = [];
  let done = 0;
  for (let i = 0; i < sample.length; i += CONCURRENCY) {
    const batch = sample.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(processMarket));
    results.push(...batchResults);
    done += batch.length;
    if (done % 80 === 0 || done === sample.length) console.log(`  ${done}/${sample.length} processed`);
    await sleep(100);
  }

  fs.writeFileSync('priceHistory.json', JSON.stringify(results, null, 1));
  const errors = results.filter((r) => r.error).length;
  console.log(`\nSaved ${results.length} results to priceHistory.json (${errors} errors)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
