// Walk-forward simulation for the isolated, correctly-parsed 'spread_1.5' bucket (h3,
// <=0.30, side=YES) -- step 3 of its validation, run after the liquidity audit came back
// clean (test/auditMlbSpread15Liquidity.js: 0/40, 0.0% contamination).
//
// monthlyBacktestCorrected.js's runMonth() reads records from a HARDCODED path
// (usSportsLiquidityFiltered_v2.json, the real production dataset) rather than an injectable
// one -- reusing it faithfully (not re-deriving separate simulation logic) means temporarily
// merging the new spread_1.5 records into that file, running the test, then restoring the
// ORIGINAL content in a finally block. Same backup/restore discipline already used
// elsewhere this session (holdoutTable.json backdating tests) -- the real production dataset
// is back to byte-identical before this script exits, success or failure.
'use strict';
const fs = require('fs');
const path = require('path');

const bucketsModule = require('../buckets');
const { runMonth } = require('./monthlyBacktestCorrected');

const JULY_START = new Date('2026-07-01T00:00:00Z');
const JULY_END = new Date('2026-08-01T00:00:00Z');
const CANDIDATE = { sport: 'mlb', marketType: 'spread_1.5', horizon: 'h3', horizonHours: 3, band: '<=0.30', side: 'YES' };

const DATASET_PATH = path.join(__dirname, '..', '..', 'usSportsLiquidityFiltered_v2.json');
const SPREAD15_PATH = path.join(__dirname, '..', '..', 'mlbSpread15Only.json');

async function main() {
  const originalDataset = fs.readFileSync(DATASET_PATH, 'utf8');
  try {
    console.log('##### CONTROL: production 3-bucket set (July 2026, dataset unmerged) #####');
    const control = await runMonth('JULY 2026 -- CONTROL (3 buckets, no spread_1.5)', JULY_START, JULY_END);

    console.log('\nMerging spread_1.5 records into a working copy of the dataset for this test run...');
    const existing = JSON.parse(originalDataset);
    const spread15Records = JSON.parse(fs.readFileSync(SPREAD15_PATH, 'utf8'));
    const merged = existing.concat(spread15Records);
    fs.writeFileSync(DATASET_PATH, JSON.stringify(merged));
    console.log(`Merged: ${existing.length} + ${spread15Records.length} spread_1.5 = ${merged.length} total records (working copy only)`);

    bucketsModule.BUCKETS.push(CANDIDATE);
    console.log('\n\n##### CANDIDATE: 3 buckets + MLB spread_1.5 h3 <=0.30 side=YES (July 2026) #####');
    console.log('BUCKETS now:', bucketsModule.BUCKETS.map((b) => `${b.sport}|${b.marketType}|${b.horizon}|${b.band}`));
    const withSpread = await runMonth('JULY 2026 -- WITH MLB SPREAD_1.5 CANDIDATE', JULY_START, JULY_END);

    console.log('\n\n##### SIDE-BY-SIDE #####');
    console.log(`Control (3 buckets):      ${control.result.tradeLog.length} trades, end bankroll $${control.result.finalNetWorth.toFixed(2)} (${control.result.returnPct.toFixed(1)}%), max DD $${control.result.maxDrawdownAbs.toFixed(2)} (${control.result.maxDrawdownPct.toFixed(1)}%)`);
    console.log(`With spread_1.5 (4):      ${withSpread.result.tradeLog.length} trades, end bankroll $${withSpread.result.finalNetWorth.toFixed(2)} (${withSpread.result.returnPct.toFixed(1)}%), max DD $${withSpread.result.maxDrawdownAbs.toFixed(2)} (${withSpread.result.maxDrawdownPct.toFixed(1)}%)`);

    const spreadTrades = withSpread.result.tradeLog.filter((t) => t.sport === 'mlb' && t.marketType === 'spread_1.5');
    const spreadWins = spreadTrades.filter((t) => t.won).length;
    console.log(`\nspread_1.5's own contribution this month: ${spreadTrades.length} trades (${spreadWins}W/${spreadTrades.length - spreadWins}L${spreadTrades.length ? ', ' + ((spreadWins / spreadTrades.length) * 100).toFixed(1) + '%' : ''})`);
    for (const t of spreadTrades) {
      console.log(`  placed ${new Date(t.placementTs * 1000).toISOString()} @ price=${t.price}, stake=$${t.stake.toFixed(2)}, ${t.won ? 'WON' : 'LOST'}`);
    }
  } finally {
    fs.writeFileSync(DATASET_PATH, originalDataset);
    const restored = fs.readFileSync(DATASET_PATH, 'utf8');
    console.log(`\n(restored original dataset -- byte-identical: ${restored === originalDataset})`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
