// Step 4 of the isolated spread_1.5 bucket's validation: live scanner integration test.
// Same in-memory BUCKETS mutation technique as before (production buckets.js untouched).
// Unlike the walk-forward step, computeHoldoutTable() takes records as a direct parameter
// (not a hardcoded file read), so the spread_1.5 records can be merged purely in memory here
// -- no disk write/restore needed at all for this step.
'use strict';

const path = require('path');
const fs = require('fs');
const bucketsModule = require('../buckets');
const { computeHoldoutTable } = require('../holdoutTable');
const { scanOnce } = require('../scanner');

const CANDIDATE = { sport: 'mlb', marketType: 'spread_1.5', horizon: 'h3', horizonHours: 3, band: '<=0.30', side: 'YES' };

async function main() {
  bucketsModule.BUCKETS.push(CANDIDATE);
  console.log('BUCKETS for this scan:', bucketsModule.BUCKETS.map((b) => `${b.sport}|${b.marketType}|${b.horizon}|${b.band}|side=${b.side}`));

  const productionRecords = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'usSportsLiquidityFiltered_v2.json'), 'utf8'));
  const spread15Records = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'mlbSpread15Only.json'), 'utf8'));
  const records = productionRecords.concat(spread15Records); // in-memory only, no disk write
  console.log(`Records for holdout computation: ${productionRecords.length} production + ${spread15Records.length} spread_1.5 = ${records.length}`);

  const now = new Date();
  const holdoutTable = computeHoldoutTable(records, now);
  console.log('\nLive holdout table (as of right now, 4 buckets):');
  for (const [k, v] of Object.entries(holdoutTable)) console.log(`  ${k}: n=${v.n}, pTrue=${v.n ? v.pTrue.toFixed(3) : 'n/a'}, side=${v.side}`);

  console.log('\nRunning real scan against live markets...\n');
  const results = await scanOnce(holdoutTable, 100);

  const spreadResults = results.filter((r) => r.sport === 'mlb' && r.marketType === 'spread');
  const others = results.filter((r) => !(r.sport === 'mlb' && r.marketType === 'spread'));

  console.log(`Total markets scanned: ${results.length}`);
  console.log(`  MLB spread markets (all lines, gateway's coarse type): ${spreadResults.length}`);
  console.log(`  All other: ${others.length}`);

  // Break spread results down by which specific line they were (parsed from marketSlug),
  // since the bucket only validates the 1.5 full-game line -- everything else should skip
  // with "no validated bucket for mlb/spread_X.X", proving the disambiguation actually works
  // live, not just against historical data.
  const byLine = {};
  for (const r of spreadResults) {
    const m = r.marketSlug.match(/-(f5-)?(pos|neg)-(\d+pt\d+)$/);
    const line = m ? `${m[1] ? 'f5_' : ''}${m[3].replace('pt', '.')}` : 'UNPARSEABLE';
    byLine[line] = (byLine[line] || 0) + 1;
  }
  console.log('\nSpread markets by parsed line value:', byLine);

  const spreadDecisionCounts = {};
  const spread15Decisions = [];
  for (const r of spreadResults) {
    const key = r.decision?.action === 'trade' ? 'trade' : (r.decision?.reason || r.decision?.action || 'unknown');
    spreadDecisionCounts[key] = (spreadDecisionCounts[key] || 0) + 1;
    if (r.opp && r.opp.marketType === 'spread_1.5') spread15Decisions.push(r);
  }
  console.log('\nAll spread-type decision breakdown (should show 1.5-line markets reaching real pricing/trade logic, other lines skipping cleanly with "no validated bucket"):');
  console.log(spreadDecisionCounts);

  console.log(`\n=== spread_1.5-specific results (${spread15Decisions.length} markets reached the bucket) ===`);
  for (const r of spread15Decisions) {
    console.log(JSON.stringify({ marketSlug: r.marketSlug, gatewaySide: r.opp.gatewaySide, side: r.opp.side, bucketKey: r.bucketKey, decision: r.decision }, null, 1));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
