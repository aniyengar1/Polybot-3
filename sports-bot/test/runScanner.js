'use strict';
const fs = require('fs');
const path = require('path');
const { computeHoldoutTable } = require('../holdoutTable');
const { scanOnce } = require('../scanner');

const PARENT = path.join(__dirname, '..', '..');
const CASH_USD = 100;

function printResults(results) {
  for (const r of results) {
    if (r.decision.action === 'trade') {
      console.log(`TRADE  ${r.sport} ${r.marketType} ${r.marketSlug}`);
      console.log(`       side=${r.decision ? r.opp.side : ''} price=${r.opp.price.toFixed(3)} bucketKey=${r.bucketKey}`);
      console.log(`       holdoutN=${r.decision.holdoutN} holdoutPTrue=${r.decision.holdoutPTrue.toFixed(3)} kellyFractionRaw=${r.decision.kellyFractionRaw.toFixed(4)} effectiveCapPct=${(r.decision.effectiveCapPct * 100).toFixed(2)}%`);
      console.log(`       stake=$${r.decision.stake.toFixed(2)} fee=$${r.decision.fee.toFixed(2)} quantity=${r.decision.quantity.toFixed(3)}`);
      console.log(`       eventSlug=${r.eventSlug}`);
    } else {
      console.log(`skip   ${r.sport} ${r.marketType || ''} ${r.marketSlug || ''} -- ${r.decision.reason}`);
    }
  }
}

async function main() {
  // Holdout table computed from the same merged historical dataset used throughout this
  // project (usSportsLiquidityFiltered_v2.json) -- there is no live-refreshing raw-data
  // pipeline yet (flagged as separate, not-yet-built work in the earlier build-scoping
  // pass), so this uses the most recent available data as the trading-window cutoff.
  const records = JSON.parse(fs.readFileSync(path.join(PARENT, 'usSportsLiquidityFiltered_v2.json'), 'utf8'));
  const tradingWindowStart = new Date(); // "now" -- use everything resolved to date
  const holdoutTable = computeHoldoutTable(records, tradingWindowStart);
  console.log('Holdout table (from historical data, cutoff = now):');
  for (const [k, v] of Object.entries(holdoutTable)) {
    console.log(`  ${k}: n=${v.n}, pTrue=${v.pTrue === null ? 'null' : v.pTrue.toFixed(3)}`);
  }

  console.log('\n=== REAL SCAN, actual current time ===');
  const realResults = await scanOnce(holdoutTable, CASH_USD);
  printResults(realResults);
  const realTrades = realResults.filter((r) => r.decision.action === 'trade');
  console.log(`\n${realResults.length} markets scanned, ${realTrades.length} trade decision(s).`);

  // Diagnostic only: prove the full pipeline (Gamma pricing, band matching, live depth,
  // evaluateOpportunity) actually works end to end against REAL live market data, by
  // pretending "now" is within the eligible horizon window for whichever real MLB game is
  // soonest. Not a production code path -- nowOverride only exists for this test.
  console.log('\n=== DIAGNOSTIC SCAN: same real markets, clock shifted to simulate being inside the horizon window ===');
  const { findGatewayMarkets } = require('../scanner');
  const mlbMarkets = await findGatewayMarkets('mlb');
  const moneylines = mlbMarkets.filter((m) => m.marketType === 'moneyline').sort((a, b) => new Date(a.gameStartTime) - new Date(b.gameStartTime));
  if (moneylines.length === 0) {
    console.log('No open MLB moneyline markets found for the diagnostic run.');
  } else {
    const soonest = moneylines[0];
    const gameStartTs = new Date(soonest.gameStartTime).getTime();
    const simulatedNow = new Date(gameStartTs - 24 * 3600 * 1000); // exactly the h24 checkpoint moment
    console.log(`Using ${soonest.marketSlug} (real game start ${soonest.gameStartTime}), simulated now = ${simulatedNow.toISOString()}`);
    const diagResults = await scanOnce(holdoutTable, CASH_USD, { nowOverride: simulatedNow });
    const diagForThisMarket = diagResults.find((r) => r.marketSlug === soonest.marketSlug);
    console.log('\nResult for that one market under the simulated clock:');
    printResults(diagForThisMarket ? [diagForThisMarket] : []);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
