const fs = require('fs');
const { train, test } = JSON.parse(fs.readFileSync('splitRecords.json', 'utf8'));
const { trainStats } = JSON.parse(fs.readFileSync('trainTestStats.json', 'utf8'));

const BANKROLL = 1000;
const FLAT_BET = 50;
const KELLY_FRACTION = 0.225; // midpoint of the requested 20-25% range
const KELLY_CAP_PCT = 0.05; // never more than 5% of bankroll

// The validated signal: moneyline, 0.30-0.40 band, 3-days-out horizon. YES was overpriced
// (bias -19.5pp train / -11.7pp test) -> the trade is BUYING NO, not YES.
const HORIZON_KEY = 'h72';
const BAND_LO = 0.3;
const BAND_HI = 0.4;
const SUBMARKET = 'moneyline';

const trainBandStats = trainStats[SUBMARKET][HORIZON_KEY]['0.30-0.40'];
const pTrueYes = trainBandStats.realizedRate; // train-estimated true P(YES), out-of-sample re: test set
const pTrueNo = 1 - pTrueYes;
console.log(`Train-estimated P(YES) in this band/horizon: ${(pTrueYes * 100).toFixed(1)}% (n=${trainBandStats.n}) -> P(NO) = ${(pTrueNo * 100).toFixed(1)}%\n`);

const testTrades = test.filter((r) => {
  if (r.submarketType !== SUBMARKET) return false;
  const cp = r.checkpoints[HORIZON_KEY];
  if (!cp) return false;
  return cp.price > BAND_LO && cp.price < BAND_HI;
});
console.log(`Test-set trades available: ${testTrades.length}\n`);

function kellyFraction(modelProb, marketPrice) {
  if (marketPrice <= 0 || marketPrice >= 1) return 0;
  const f = (modelProb - marketPrice) / (1 - marketPrice);
  return Math.max(0, Math.min(1, f));
}

// --- Strategy A: flat $50 on NO, every trade ---
let flatPnl = 0;
let flatWins = 0;
const flatReturns = [];
for (const r of testTrades) {
  const yesPrice = r.checkpoints[HORIZON_KEY].price;
  const noPrice = 1 - yesPrice;
  const won = r.yesResolvedTo === 0; // NO wins
  const payout = won ? FLAT_BET / noPrice : 0;
  const pnl = payout - FLAT_BET;
  flatPnl += pnl;
  if (won) flatWins++;
  flatReturns.push(pnl / FLAT_BET);
}
const flatAvgReturn = flatReturns.reduce((s, v) => s + v, 0) / flatReturns.length;

console.log('=== Strategy A: flat $50/bet on NO ===');
console.log(`n=${testTrades.length}, wins=${flatWins} (${((flatWins / testTrades.length) * 100).toFixed(1)}%)`);
console.log(`Total P&L: $${flatPnl.toFixed(2)}`);
console.log(`Avg return per bet: ${(flatAvgReturn * 100).toFixed(1)}%`);

// --- Strategy B: fractional Kelly, capped at 5% of bankroll, sized per-trade off the
// ACTUAL market price for that trade (not the bucket average) ---
let kellyPnl = 0;
let kellyWins = 0;
let totalStaked = 0;
const kellySizes = [];
for (const r of testTrades) {
  const yesPrice = r.checkpoints[HORIZON_KEY].price;
  const noPrice = 1 - yesPrice;
  const rawKelly = kellyFraction(pTrueNo, noPrice);
  const fractional = rawKelly * KELLY_FRACTION;
  const capped = Math.min(fractional, KELLY_CAP_PCT);
  const stake = BANKROLL * capped;
  kellySizes.push(stake);
  if (stake < 1) continue; // skip dust bets, same floor convention as the weather bot
  const won = r.yesResolvedTo === 0;
  const payout = won ? stake / noPrice : 0;
  const pnl = payout - stake;
  kellyPnl += pnl;
  totalStaked += stake;
  if (won) kellyWins++;
}
const nKellyBets = kellySizes.filter((s) => s >= 1).length;

console.log('\n=== Strategy B: fractional Kelly (22.5% of full Kelly, capped at 5% bankroll) ===');
console.log(`n=${nKellyBets}, wins=${kellyWins} (${((kellyWins / nKellyBets) * 100).toFixed(1)}%)`);
console.log(`Avg stake per bet: $${(totalStaked / nKellyBets).toFixed(2)} (cap was $${(BANKROLL * KELLY_CAP_PCT).toFixed(2)})`);
console.log(`Total P&L: $${kellyPnl.toFixed(2)}`);
console.log(`Return on capital staked: ${((kellyPnl / totalStaked) * 100).toFixed(1)}%`);
console.log(`Final bankroll if compounding were NOT applied (flat reference bankroll): $${(BANKROLL + kellyPnl).toFixed(2)}`);
