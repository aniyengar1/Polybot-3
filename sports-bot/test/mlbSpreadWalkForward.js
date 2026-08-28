// Walk-forward simulation for the MLB spread CANDIDATE bucket (h3, <=0.30, side=YES) -- step
// 2 of its validation, run only after the execution-cost/liquidity audit came back clean
// (test/auditMlbSpreadLiquidity.js: 0/40, 0.0% contamination).
//
// Does NOT touch buckets.js on disk. Instead mutates the live BUCKETS array in memory --
// CommonJS module caching means every consumer (holdoutTable.js, monthlyBacktestCorrected.js,
// scanner.js) that does `const { BUCKETS } = require('./buckets')` holds a reference to the
// SAME array object, so pushing the candidate here is visible everywhere for the rest of
// this process, without ever writing a "test copy" file to disk that could drift from the
// real one. Process exits when the script ends, so nothing persists.
//
// Reuses July 2026 -- same month test/midSeasonMlbCheck.js already validated MLB moneyline
// against (mid-season, n=54 pre-period holdout, clean of the season-start edge case April
// had) -- run twice back to back on the SAME (freshly refreshed) dataset: once with the
// current 3-bucket production set as a control, once with MLB spread added, for a true
// apples-to-apples "what would spread have added on top of moneyline" comparison.
'use strict';

const bucketsModule = require('../buckets');
const { runMonth } = require('./monthlyBacktestCorrected');

const JULY_START = new Date('2026-07-01T00:00:00Z');
const JULY_END = new Date('2026-08-01T00:00:00Z');

const MLB_SPREAD_CANDIDATE = { sport: 'mlb', marketType: 'spread', horizon: 'h3', horizonHours: 3, band: '<=0.30', side: 'YES' };

async function main() {
  console.log('##### CONTROL: production 3-bucket set (July 2026) #####');
  const control = await runMonth('JULY 2026 -- CONTROL (3 buckets, no spread)', JULY_START, JULY_END);

  console.log('\n\n##### CANDIDATE: 3 buckets + MLB spread h3 <=0.30 side=YES (July 2026) #####');
  bucketsModule.BUCKETS.push(MLB_SPREAD_CANDIDATE);
  console.log('BUCKETS now:', bucketsModule.BUCKETS.map((b) => `${b.sport}|${b.marketType}|${b.horizon}|${b.band}`));
  const withSpread = await runMonth('JULY 2026 -- WITH MLB SPREAD CANDIDATE', JULY_START, JULY_END);

  console.log('\n\n##### SIDE-BY-SIDE #####');
  console.log(`Control (3 buckets):      ${control.result.tradeLog.length} trades, end bankroll $${control.result.finalNetWorth.toFixed(2)} (${control.result.returnPct.toFixed(1)}%), max DD $${control.result.maxDrawdownAbs.toFixed(2)} (${control.result.maxDrawdownPct.toFixed(1)}%)`);
  console.log(`With MLB spread (4):      ${withSpread.result.tradeLog.length} trades, end bankroll $${withSpread.result.finalNetWorth.toFixed(2)} (${withSpread.result.returnPct.toFixed(1)}%), max DD $${withSpread.result.maxDrawdownAbs.toFixed(2)} (${withSpread.result.maxDrawdownPct.toFixed(1)}%)`);

  const spreadTrades = withSpread.result.tradeLog.filter((t) => t.sport === 'mlb' && t.marketType === 'spread');
  const spreadWins = spreadTrades.filter((t) => t.won).length;
  console.log(`\nMLB spread's own contribution this month: ${spreadTrades.length} trades (${spreadWins}W/${spreadTrades.length - spreadWins}L${spreadTrades.length ? ', ' + ((spreadWins / spreadTrades.length) * 100).toFixed(1) + '%' : ''})`);
  for (const t of spreadTrades) {
    console.log(`  placed ${new Date(t.placementTs * 1000).toISOString()} @ price=${t.price}, stake=$${t.stake.toFixed(2)}, ${t.won ? 'WON' : 'LOST'}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
