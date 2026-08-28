// Step 3 of MLB spread candidate validation: live scanner integration test. Same in-memory
// BUCKETS mutation technique as mlbSpreadWalkForward.js (avoids ever writing a test-copy file
// that could drift from the real buckets.js) -- production buckets.js on disk is untouched.
// Runs one real scan pass (scanner.js's scanOnce, unmodified) against whatever MLB spread
// markets are actually open right now, same dry-pass discipline as the original phase-4
// scanner build: report the real output, don't force-fit it to expectations.
'use strict';

const path = require('path');
const fs = require('fs');
const bucketsModule = require('../buckets');
const { computeHoldoutTable } = require('../holdoutTable');
const { scanOnce } = require('../scanner');

const MLB_SPREAD_CANDIDATE = { sport: 'mlb', marketType: 'spread', horizon: 'h3', horizonHours: 3, band: '<=0.30', side: 'YES' };

async function main() {
  bucketsModule.BUCKETS.push(MLB_SPREAD_CANDIDATE);
  console.log('BUCKETS for this scan:', bucketsModule.BUCKETS.map((b) => `${b.sport}|${b.marketType}|${b.horizon}|${b.band}|side=${b.side}`));

  const records = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'usSportsLiquidityFiltered_v2.json'), 'utf8'));
  const now = new Date();
  const holdoutTable = computeHoldoutTable(records, now);
  console.log('\nLive holdout table (as of right now, 4 buckets):');
  for (const [k, v] of Object.entries(holdoutTable)) console.log(`  ${k}: n=${v.n}, pTrue=${v.n ? v.pTrue.toFixed(3) : 'n/a'}, side=${v.side}`);

  console.log('\nRunning real scan against live markets...\n');
  const results = await scanOnce(holdoutTable, 100);

  const spreadResults = results.filter((r) => r.sport === 'mlb' && r.marketType === 'spread');
  const others = results.filter((r) => !(r.sport === 'mlb' && r.marketType === 'spread'));

  console.log(`Total markets scanned: ${results.length}`);
  console.log(`  MLB spread markets: ${spreadResults.length}`);
  console.log(`  All other (unchanged buckets): ${others.length}`);

  console.log('\n=== MLB spread scan results (full detail) ===');
  for (const r of spreadResults) {
    console.log(JSON.stringify(r, null, 1));
  }

  const spreadDecisionCounts = {};
  for (const r of spreadResults) {
    const key = r.decision?.action === 'trade' ? 'trade' : (r.decision?.reason || r.decision?.action || 'unknown');
    spreadDecisionCounts[key] = (spreadDecisionCounts[key] || 0) + 1;
  }
  console.log('\nMLB spread decision breakdown:', spreadDecisionCounts);

  const otherDecisionCounts = {};
  for (const r of others) {
    const key = r.decision?.action === 'trade' ? 'trade' : (r.decision?.reason || r.decision?.action || 'unknown');
    otherDecisionCounts[key] = (otherDecisionCounts[key] || 0) + 1;
  }
  console.log('Other-buckets decision breakdown (should match a normal scan, unaffected by the candidate):', otherDecisionCounts);
}

main().catch((err) => { console.error(err); process.exit(1); });
