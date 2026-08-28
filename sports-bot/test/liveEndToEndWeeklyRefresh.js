// Real, unstubbed end-to-end proof: backdate the persisted holdout table's week-start, call
// the real loadOrRefreshHoldoutTable() (no stubbing anywhere), and confirm it actually hits
// live APIs via dataRefresh.js's refreshRawData(), updates the on-disk raw dataset, then
// recomputes the table from the freshly-updated data. Complements
// verifyWeeklyRefreshWiring.js (which proves the *trigger logic* fast and deterministically
// via a stub) by proving the *whole real chain* works together, not just the wiring.
'use strict';
const path = require('path');
const fs = require('fs');
const { loadOrRefreshHoldoutTable } = require('../orchestrator');

const HOLDOUT_TABLE_PATH = path.join(__dirname, '..', 'data', 'holdoutTable.json');
const DATASET_PATH = path.join(__dirname, '..', '..', 'usSportsLiquidityFiltered_v2.json');

const originalTable = fs.readFileSync(HOLDOUT_TABLE_PATH, 'utf8');
const datasetCountBefore = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8')).length;

async function main() {
  const staleTable = JSON.parse(originalTable);
  const staleDate = '2026-01-05T00:00:00.000Z';
  for (const k of Object.keys(staleTable)) staleTable[k].tradingWindowStart = staleDate;
  fs.writeFileSync(HOLDOUT_TABLE_PATH, JSON.stringify(staleTable, null, 1));
  console.log(`Backdated holdoutTable.json's tradingWindowStart to ${staleDate} (real Monday would be later), dataset had ${datasetCountBefore} records before this run.\n`);

  const table = await loadOrRefreshHoldoutTable();

  const datasetCountAfter = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8')).length;
  console.log(`\nDataset record count AFTER: ${datasetCountAfter} (was ${datasetCountBefore})`);
  console.log('Resulting table:', JSON.stringify(Object.fromEntries(Object.entries(table).map(([k, v]) => [k, { n: v.n, pTrue: v.pTrue, tradingWindowStart: v.tradingWindowStart }])), null, 2));
}

main()
  .catch((err) => { console.error(err); process.exit(1); });
