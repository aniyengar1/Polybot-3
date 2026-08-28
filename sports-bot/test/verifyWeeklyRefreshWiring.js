// Verifies loadOrRefreshHoldoutTable() actually invokes dataRefresh.js's refreshRawData()
// on a stale week, not just holdoutTable.js's recompute -- the gap flagged after the VM
// deployment (wiring existed, nothing ever re-fetched raw data behind it).
//
// Stubs ./dataRefresh via require.cache BEFORE orchestrator.js is required, same technique
// already used for the settlement fail-safe test -- isolates "does orchestrator call the
// refresh at the right time" from "does the refresh's own network logic work" (that part
// was already confirmed live, 627 events, in the prior session's production run).
'use strict';
const path = require('path');
const fs = require('fs');

const dataRefreshPath = require.resolve('../dataRefresh');
let refreshCalls = [];
require.cache[dataRefreshPath] = {
  id: dataRefreshPath,
  filename: dataRefreshPath,
  loaded: true,
  exports: {
    refreshRawData: async (opts) => {
      refreshCalls.push(opts);
      return { added: 0, replaced: 0, totalRecords: 20510, summary: {} };
    },
    SERIES: {},
  },
};

const { loadOrRefreshHoldoutTable } = require('../orchestrator');

const HOLDOUT_TABLE_PATH = path.join(__dirname, '..', 'data', 'holdoutTable.json');
const original = fs.readFileSync(HOLDOUT_TABLE_PATH, 'utf8');

async function main() {
  let allPass = true;

  // --- Case 1: table is fresh (current week) -- refresh must NOT fire ---
  refreshCalls = [];
  const now = new Date();
  const day = now.getUTCDay();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);
  const freshTable = JSON.parse(original);
  for (const k of Object.keys(freshTable)) freshTable[k].tradingWindowStart = monday.toISOString();
  fs.writeFileSync(HOLDOUT_TABLE_PATH, JSON.stringify(freshTable, null, 1));

  await loadOrRefreshHoldoutTable();
  const freshOk = refreshCalls.length === 0;
  console.log(`Case 1 (fresh table, current week=${monday.toISOString()}): refreshRawData called ${refreshCalls.length} times -- ${freshOk ? 'PASS' : 'FAIL'} (expected 0)`);
  if (!freshOk) allPass = false;

  // --- Case 2: table is stale (backdated week-start) -- refresh MUST fire before recompute ---
  refreshCalls = [];
  const staleTable = JSON.parse(original);
  const staleDate = '2026-01-05T00:00:00.000Z'; // an old Monday, months before now
  for (const k of Object.keys(staleTable)) staleTable[k].tradingWindowStart = staleDate;
  fs.writeFileSync(HOLDOUT_TABLE_PATH, JSON.stringify(staleTable, null, 1));

  await loadOrRefreshHoldoutTable();
  const staleOk = refreshCalls.length === 1 && refreshCalls[0].outputPath && refreshCalls[0].outputPath.endsWith('usSportsLiquidityFiltered_v2.json');
  console.log(`Case 2 (stale table, backdated to ${staleDate}): refreshRawData called ${refreshCalls.length} time(s) with outputPath=${refreshCalls[0]?.outputPath} -- ${staleOk ? 'PASS' : 'FAIL'} (expected exactly 1 call, targeting the real dataset path)`);
  if (!staleOk) allPass = false;

  // Confirm the recompute actually ran too (table's week-start moved to current week, not stuck on the stale/backdated one).
  const after = JSON.parse(fs.readFileSync(HOLDOUT_TABLE_PATH, 'utf8'));
  const afterWeekStart = Object.values(after)[0]?.tradingWindowStart;
  const recomputeOk = afterWeekStart === monday.toISOString();
  console.log(`Recompute also ran: table's tradingWindowStart is now ${afterWeekStart} -- ${recomputeOk ? 'PASS' : 'FAIL'} (expected ${monday.toISOString()})`);
  if (!recomputeOk) allPass = false;

  fs.writeFileSync(HOLDOUT_TABLE_PATH, original);
  console.log('(restored original holdoutTable.json)');

  console.log(`\n${allPass ? 'WIRING CONFIRMED: stale week triggers refreshRawData() before recompute, fresh week does not' : 'WIRING BROKEN -- see failures above'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  fs.writeFileSync(HOLDOUT_TABLE_PATH, original);
  console.error(err);
  process.exit(1);
});
