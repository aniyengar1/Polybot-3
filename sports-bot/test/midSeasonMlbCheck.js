// Checks whether April's near-zero MLB moneyline trade volume was a season-start edge case
// or reflects the corrected fill requirement being generally more restrictive. Runs the
// exact same corrected walk-forward methodology (test/monthlyBacktestCorrected.js's
// runMonth) against July 2026 -- a genuine mid-season month, chosen over June because it has
// a larger pre-period holdout (n=54 vs June's n=42), both far healthier than April's n=8.
'use strict';
const { runMonth } = require('./monthlyBacktestCorrected');

async function main() {
  const july = await runMonth('JULY 2026 (mid-season MLB check)', new Date('2026-07-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
  console.log('\nSaved results in memory (see log above for full detail).');
  return july;
}

main().catch((err) => { console.error(err); process.exit(1); });
