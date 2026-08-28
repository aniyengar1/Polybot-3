// Weekly raw-data ingestion pipeline -- the piece explicitly flagged as separate,
// not-yet-built work throughout this project ("turning the one-off fetchLiquidityFiltered.js
// / fetchMLBFixed.js research scripts into a scheduled live data-refresh job"). This is that
// job: discovers recently-closed NBA/NHL/MLB games and re-fetches them using the exact same
// corrected (side-specific) logic from those two scripts, then merges the results into
// usSportsLiquidityFiltered_v2.json -- the actual dataset computeHoldoutTable() reads from.
//
// Discovery mechanism, verified live 2026-08-26/27 before building on it:
//   - gateway.polymarket.us's /v1/search never returns closed events (tested directly,
//     confirmed 0/50 across all 3 sports regardless of query params tried) -- not usable.
//   - gateway.polymarket.us's raw /v1/events?limit&offset is ascending-creation-order and
//     supports no sport/date filter; the tail of the catalog is dominated by esports and
//     international tennis/soccer at far higher volume than NBA/NHL/MLB, so backward
//     pagination from the tail is impractically expensive (1500+ events span ~1 day of
//     catalog growth, with target-sport events comparatively rare in that mix).
//   - gamma-api.polymarket.com DOES support targeted, efficient filtering:
//     ?series_id={id}&closed=true&limit=N&order=endDate&ascending=false -- confirmed
//     working live for all 3 sports (MLB series_id=3, NBA series_id=10345, NHL
//     series_id=10346), returning genuinely sport-specific closed events sorted
//     newest-first, so pagination can stop as soon as endDate falls outside the lookback
//     window instead of traversing the whole catalog.
'use strict';

const fs = require('fs');
const path = require('path');
const nonMlbFetcher = require('../fetchLiquidityFiltered');
const mlbFetcher = require('../fetchMLBFixed');

const DATASET_PATH = path.join(__dirname, '..', 'usSportsLiquidityFiltered_v2.json');
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const PAGE_SIZE = 50;
const CONCURRENCY = 15;

const SERIES = {
  mlb: { seriesId: '3', processEvent: mlbFetcher.processEvent },
  nba: { seriesId: '10345', processEvent: nonMlbFetcher.processEvent },
  nhl: { seriesId: '10346', processEvent: nonMlbFetcher.processEvent },
};

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

/**
 * Paginates gamma-api's series-scoped, endDate-descending closed-events listing, stopping
 * as soon as an event's endDate falls outside the lookback window (safe because results are
 * sorted newest-first) rather than reading the whole series history every time.
 */
async function discoverRecentlyClosedEvents(sport, lookbackDays) {
  const { seriesId } = SERIES[sport];
  const cutoff = Date.now() - lookbackDays * 86400000;
  const seen = new Map(); // slug -> event, dedupes the page-boundary overlap that occurs
  // when multiple events share an identical endDate (confirmed live -- offset-based
  // pagination re-includes ties that straddle a page edge; a plain "add to array" approach
  // produced 8 duplicates out of 354 in testing). Map insertion order still gives a stable
  // discovery order, so ordering isn't disturbed by de-duping this way.
  let offset = 0;
  while (true) {
    const data = await fetchJson(`${GAMMA_BASE}/events?series_id=${seriesId}&closed=true&limit=${PAGE_SIZE}&order=endDate&ascending=false&offset=${offset}`);
    const page = Array.isArray(data) ? data : data.events || [];
    if (page.length === 0) break;
    let hitCutoff = false;
    for (const e of page) {
      if (!e.endDate || new Date(e.endDate).getTime() < cutoff) {
        hitCutoff = true;
        break;
      }
      seen.set(e.slug, { slug: e.slug, endDate: e.endDate });
    }
    if (hitCutoff || page.length < PAGE_SIZE) break;
    offset += page.length;
    await sleep(30);
  }
  return [...seen.values()];
}

/** Merges fresh records into the existing dataset, keyed by (usSlug, submarketType) -- fresh entries replace stale ones for the same key, everything else is preserved untouched. */
function mergeRecords(existingRecords, freshRecords) {
  const byKey = new Map();
  for (const r of existingRecords) byKey.set(`${r.usSlug}|${r.submarketType}`, r);
  let added = 0, replaced = 0;
  for (const r of freshRecords) {
    const key = `${r.usSlug}|${r.submarketType}`;
    if (byKey.has(key)) replaced++; else added++;
    byKey.set(key, r);
  }
  return { merged: [...byKey.values()], added, replaced };
}

/**
 * Full weekly refresh: discovers recently-closed games for all 3 sports, re-fetches them
 * with the corrected fetch logic, and merges into the on-disk dataset. lookbackDays should
 * comfortably exceed the actual weekly cadence to tolerate a missed cycle -- default 14
 * gives a full week of safety margin.
 */
async function refreshRawData({ lookbackDays = 14, sports = ['nba', 'nhl', 'mlb'], outputPath = DATASET_PATH, log = console.log } = {}) {
  const existingRecords = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : [];
  const allFreshRecords = [];
  const summary = {};

  for (const sport of sports) {
    const { processEvent } = SERIES[sport];
    const discovered = await discoverRecentlyClosedEvents(sport, lookbackDays);
    log(`${sport}: discovered ${discovered.length} closed events in the last ${lookbackDays} days`);

    let mapped = 0;
    for (let i = 0; i < discovered.length; i += CONCURRENCY) {
      const batch = discovered.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((e) => processEvent({ slug: e.slug, endDate: e.endDate }).catch(() => ({ mapped: false, records: [] })))
      );
      for (const r of results) {
        if (r.mapped) mapped++;
        allFreshRecords.push(...(r.records || []));
      }
      await sleep(30);
    }
    summary[sport] = { discovered: discovered.length, mapped };
    log(`${sport}: mapped ${mapped}/${discovered.length} events, ${allFreshRecords.length} total submarket records fetched so far`);
  }

  const { merged, added, replaced } = mergeRecords(existingRecords, allFreshRecords);
  fs.writeFileSync(outputPath, JSON.stringify(merged));
  log(`Merge complete: ${added} new records added, ${replaced} existing records refreshed, ${merged.length} total (was ${existingRecords.length})`);

  return { summary, added, replaced, totalRecords: merged.length, freshRecordsFetched: allFreshRecords.length };
}

module.exports = { discoverRecentlyClosedEvents, mergeRecords, refreshRawData, SERIES };

if (require.main === module) {
  const lookbackDays = Number(process.argv[2] || 14);
  refreshRawData({ lookbackDays }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
