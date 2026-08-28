const fs = require('fs');

const rawRecords = JSON.parse(fs.readFileSync('usSportsLiquidityFiltered.json', 'utf8'));
const records = rawRecords.filter((r) => r.sport !== 'mlb');
const candidates = JSON.parse(fs.readFileSync('liquidityFilteredCandidates.json', 'utf8'));

const BANKROLL = 1000;
const FLAT_BET = 50;
const KELLY_FRACTION = 0.225;
const KELLY_CAP_PCT = 0.05;

function bandFor(price) {
  if (price <= 0.3) return '<=0.30';
  if (price < 0.4) return '0.30-0.40';
  return '>=0.40';
}

function kellyFraction(modelProb, marketPrice) {
  if (marketPrice <= 0 || marketPrice >= 1) return 0;
  const f = (modelProb - marketPrice) / (1 - marketPrice);
  return Math.max(0, Math.min(1, f));
}

let grandFlatPnl = 0;
let grandFlatN = 0;
let grandFlatWins = 0;
let grandKellyPnl = 0;
let grandKellyStaked = 0;
let grandKellyWins = 0;
let grandKellyN = 0;

for (const c of candidates) {
  const { sport, type, horizon, band, train } = c;
  const side = train.bias > 0 ? 'YES' : 'NO'; // positive bias = YES underpriced -> buy YES; negative = buy NO
  const pTrueYes = train.realizedRate;

  // Recompute the exact test-half rows for this bucket (liquid checkpoints, chronological
  // second half, filtered to this band) -- same logic as the analysis script.
  const typeRecords = records.filter((r) => r.sport === sport && r.submarketType === type);
  const liquidRows = typeRecords.filter((r) => r.checkpoints[horizon] && r.checkpoints[horizon].liquid);
  liquidRows.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));
  const splitIdx = Math.floor(liquidRows.length / 2);
  const testRows = liquidRows.slice(splitIdx);
  const testTrades = testRows.filter((r) => bandFor(r.checkpoints[horizon].price) === band);

  console.log(`\n=== ${sport} | ${type} | ${horizon} | ${band} | side=${side} | train p(YES)=${(pTrueYes * 100).toFixed(1)}% (n=${train.n}) ===`);
  console.log(`test trades: ${testTrades.length} (should match candidate n=${c.test.n})`);

  let flatPnl = 0;
  let flatWins = 0;
  let kellyPnl = 0;
  let kellyStaked = 0;
  let kellyWins = 0;
  let kellyBets = 0;

  for (const r of testTrades) {
    const yesPrice = r.checkpoints[horizon].price;
    const price = side === 'YES' ? yesPrice : 1 - yesPrice;
    const pTrue = side === 'YES' ? pTrueYes : 1 - pTrueYes;
    const won = side === 'YES' ? r.yesResolvedTo === 1 : r.yesResolvedTo === 0;

    // flat
    const flatPayout = won ? FLAT_BET / price : 0;
    flatPnl += flatPayout - FLAT_BET;
    if (won) flatWins++;

    // kelly
    const rawKelly = kellyFraction(pTrue, price);
    const stake = BANKROLL * Math.min(rawKelly * KELLY_FRACTION, KELLY_CAP_PCT);
    if (stake >= 1) {
      const payout = won ? stake / price : 0;
      kellyPnl += payout - stake;
      kellyStaked += stake;
      kellyBets++;
      if (won) kellyWins++;
    }
  }

  console.log(`  Flat $50: n=${testTrades.length}, wins=${flatWins} (${((flatWins / testTrades.length) * 100).toFixed(1)}%), P&L=$${flatPnl.toFixed(2)}, avg return=${((flatPnl / (testTrades.length * FLAT_BET)) * 100).toFixed(1)}%`);
  console.log(`  Kelly:    n=${kellyBets}, wins=${kellyWins} (${((kellyWins / kellyBets) * 100).toFixed(1)}%), P&L=$${kellyPnl.toFixed(2)}, avg stake=$${(kellyStaked / kellyBets).toFixed(2)}, return on staked=${((kellyPnl / kellyStaked) * 100).toFixed(1)}%`);

  grandFlatPnl += flatPnl;
  grandFlatN += testTrades.length;
  grandFlatWins += flatWins;
  grandKellyPnl += kellyPnl;
  grandKellyStaked += kellyStaked;
  grandKellyWins += kellyWins;
  grandKellyN += kellyBets;
}

console.log('\n\n=== COMBINED across all 4 candidate buckets ===');
console.log(`Flat $50: n=${grandFlatN}, wins=${grandFlatWins} (${((grandFlatWins / grandFlatN) * 100).toFixed(1)}%), total P&L=$${grandFlatPnl.toFixed(2)}, avg return/bet=${((grandFlatPnl / (grandFlatN * FLAT_BET)) * 100).toFixed(1)}%`);
console.log(`Kelly:    n=${grandKellyN}, wins=${grandKellyWins} (${((grandKellyWins / grandKellyN) * 100).toFixed(1)}%), total P&L=$${grandKellyPnl.toFixed(2)}, total staked=$${grandKellyStaked.toFixed(2)}, return on staked=${((grandKellyPnl / grandKellyStaked) * 100).toFixed(1)}%`);
