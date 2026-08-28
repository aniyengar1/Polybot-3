// Phase 1 of the Nov 2025 - Jul 2026 continuous walk-forward: computes each of the 9 months'
// strict pre-period holdout table (no-lookahead, same discipline as every prior backtest in
// this thread) using the CURRENT production BUCKETS (4 buckets: NBA/NHL/MLB moneyline + MLB
// spread_1.5). Pure in-memory computation, zero network calls, zero writes -- read-only
// analysis, does not touch buckets.js/scanner.js/orchestrator.js/execution.js/the DB/the VM.
'use strict';
const fs = require('fs');
const path = require('path');
const { computeHoldoutTable } = require('../holdoutTable');

const DATASET_PATH = path.join(__dirname, '..', '..', 'usSportsLiquidityFiltered_v2.json');

const MONTHS = [
  { label: 'NOV 2025', start: new Date('2025-11-01T00:00:00Z'), end: new Date('2025-12-01T00:00:00Z') },
  { label: 'DEC 2025', start: new Date('2025-12-01T00:00:00Z'), end: new Date('2026-01-01T00:00:00Z') },
  { label: 'JAN 2026', start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') },
  { label: 'FEB 2026', start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') },
  { label: 'MAR 2026', start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') },
  { label: 'APR 2026', start: new Date('2026-04-01T00:00:00Z'), end: new Date('2026-05-01T00:00:00Z') },
  { label: 'MAY 2026', start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-06-01T00:00:00Z') },
  { label: 'JUN 2026', start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-07-01T00:00:00Z') },
  { label: 'JUL 2026', start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z') },
];

function main() {
  const records = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  console.log(`Loaded ${records.length} total historical records.\n`);

  const monthlyTables = {};
  for (const m of MONTHS) {
    const table = computeHoldoutTable(records, m.start);
    monthlyTables[m.label] = table;
    console.log(`=== ${m.label} (pre-period cutoff: strictly before ${m.start.toISOString()}) ===`);
    for (const [k, v] of Object.entries(table)) {
      const status = v.n === 0 ? 'NO HOLDOUT DATA -- bucket dormant this month' : v.n < 30 ? `n=${v.n} pTrue=${v.pTrue.toFixed(3)}  [THIN -- capScale=${(v.n/30).toFixed(2)}]` : `n=${v.n} pTrue=${v.pTrue.toFixed(3)}`;
      console.log(`  ${k}: ${status}`);
    }
    console.log();
  }

  fs.writeFileSync(path.join(__dirname, 'continuousWalkForward_monthlyTables.json'), JSON.stringify(monthlyTables, null, 1));
  console.log('Saved continuousWalkForward_monthlyTables.json for phase 2.');
}

main();
