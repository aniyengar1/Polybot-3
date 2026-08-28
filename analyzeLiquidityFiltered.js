const fs = require('fs');

// MLB fix (2026-08-26): the original exclusion diagnosis was wrong (it's not a wrong-game
// mapping issue -- exact-slug Gamma lookups correctly and uniquely map every MLB game). The
// real bug: Gamma's own `endDate` field for MLB events is itself ~7 days too late (verified
// via price-history convergence and last-trade timestamps). fetchMLBFixed.js recomputes MLB
// checkpoints using each market's last real trade as the true resolution time instead of
// trusting either platform's `endDate` metadata. usSportsLiquidityFiltered_v2.json is the
// merged dataset (all non-MLB records unchanged + corrected MLB records).
const rawRecords = JSON.parse(fs.readFileSync('usSportsLiquidityFiltered_v2.json', 'utf8'));
const records = rawRecords;
const HORIZONS = [
  { key: 'h168', label: '7d' },
  { key: 'h72', label: '3d' },
  { key: 'h24', label: '1d' },
  { key: 'h3', label: '3h' },
];
const SPORTS = ['nfl', 'nba', 'nhl', 'cfb', 'cbb', 'mlb'];
const TYPES = ['moneyline', 'spread', 'total'];
const MIN_TRUSTED_N = 30;

function bandFor(price) {
  if (price <= 0.3) return '<=0.30';
  if (price < 0.4) return '0.30-0.40';
  return '>=0.40';
}

// --- Step 1: liquidity filter rate by sport ---
console.log('=== Step 1: checkpoint liquidity filter rate, by sport (all horizons/types pooled) ===');
console.log('sport | total checkpoints seen | liquid (kept) | filtered out | filter-out rate');
const filterStats = {};
for (const sport of SPORTS) {
  const rows = records.filter((r) => r.sport === sport);
  let total = 0;
  let liquid = 0;
  for (const r of rows) {
    for (const h of HORIZONS) {
      const cp = r.checkpoints[h.key];
      if (!cp) continue;
      total++;
      if (cp.liquid) liquid++;
    }
  }
  filterStats[sport] = { total, liquid };
  const rate = total > 0 ? (((total - liquid) / total) * 100).toFixed(1) : 'n/a';
  console.log(`${sport} | ${total} | ${liquid} | ${total - liquid} | ${rate}%`);
}

console.log('\n=== Same, broken out by horizon (pooled across sports) ===');
console.log('horizon | total | liquid | filter-out rate');
for (const h of HORIZONS) {
  let total = 0;
  let liquid = 0;
  for (const r of records) {
    const cp = r.checkpoints[h.key];
    if (!cp) continue;
    total++;
    if (cp.liquid) liquid++;
  }
  const rate = total > 0 ? (((total - liquid) / total) * 100).toFixed(1) : 'n/a';
  console.log(`${h.label} | ${total} | ${liquid} | ${rate}%`);
}

// --- Step 2: bias per sport x horizon x type x band, liquid-only, chronological half split ---
function summarize(rows, horizonKey) {
  const n = rows.length;
  if (n === 0) return null;
  const avgPrice = rows.reduce((s, r) => s + r.checkpoints[horizonKey].price, 0) / n;
  const realizedRate = rows.reduce((s, r) => s + r.yesResolvedTo, 0) / n;
  return { n, avgPrice, realizedRate, bias: realizedRate - avgPrice };
}

const allStats = {}; // [sport][type][horizon][band] = { train, test }
console.log('\n=== Step 2: bias by sport x type x horizon x band (LIQUID CHECKPOINTS ONLY) ===');
for (const sport of SPORTS) {
  allStats[sport] = {};
  const sportRecords = records.filter((r) => r.sport === sport);
  console.log(`\n----- ${sport.toUpperCase()} -----`);
  for (const type of TYPES) {
    allStats[sport][type] = {};
    const typeRecords = sportRecords.filter((r) => r.submarketType === type);
    if (typeRecords.length === 0) continue;
    console.log(`-- ${type} --`);
    console.log('horizon | band | split | n | avg_price | realized_rate | bias');
    for (const h of HORIZONS) {
      allStats[sport][type][h.key] = {};
      const liquidRows = typeRecords.filter((r) => r.checkpoints[h.key] && r.checkpoints[h.key].liquid);
      liquidRows.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));
      const splitIdx = Math.floor(liquidRows.length / 2);
      const trainRows = liquidRows.slice(0, splitIdx);
      const testRows = liquidRows.slice(splitIdx);

      const bandsOf = (rows) => {
        const bands = { '<=0.30': [], '0.30-0.40': [], '>=0.40': [] };
        for (const r of rows) bands[bandFor(r.checkpoints[h.key].price)].push(r);
        return bands;
      };
      const trainBands = bandsOf(trainRows);
      const testBands = bandsOf(testRows);

      for (const bandName of Object.keys(trainBands)) {
        const trainS = summarize(trainBands[bandName], h.key);
        const testS = summarize(testBands[bandName], h.key);
        allStats[sport][type][h.key][bandName] = { train: trainS, test: testS };
        for (const [label, s] of [['train', trainS], ['test', testS]]) {
          if (!s) {
            console.log(`${h.label} | ${bandName} | ${label} | 0 | -- | -- | --`);
            continue;
          }
          const flag = s.n < MIN_TRUSTED_N ? '  [THIN]' : '';
          console.log(`${h.label} | ${bandName} | ${label} | ${s.n} | ${s.avgPrice.toFixed(3)} | ${(s.realizedRate * 100).toFixed(1)}% | ${(s.bias * 100).toFixed(1)}pp${flag}`);
        }
      }
    }
  }
}

// --- Flag candidate signals: both train & test n>=30, same sign, both |bias|>5pp ---
console.log('\n\n=== Candidate signals (train & test both n>=30, same sign, |bias|>5pp both sides) ===');
const candidates = [];
for (const sport of SPORTS) {
  for (const type of TYPES) {
    if (!allStats[sport][type]) continue;
    for (const h of HORIZONS) {
      for (const bandName of ['<=0.30', '0.30-0.40', '>=0.40']) {
        const cell = allStats[sport][type][h.key]?.[bandName];
        if (!cell || !cell.train || !cell.test) continue;
        const { train, test } = cell;
        if (train.n < MIN_TRUSTED_N || test.n < MIN_TRUSTED_N) continue;
        const sameSign = Math.sign(train.bias) === Math.sign(test.bias) && train.bias !== 0;
        if (sameSign && Math.abs(train.bias) > 0.05 && Math.abs(test.bias) > 0.05) {
          candidates.push({ sport, type, horizon: h.key, band: bandName, train, test });
          console.log(`${sport} | ${type} | ${h.label} | ${bandName} | train n=${train.n} bias=${(train.bias * 100).toFixed(1)}pp | test n=${test.n} bias=${(test.bias * 100).toFixed(1)}pp`);
        }
      }
    }
  }
}
if (candidates.length === 0) console.log('(none found)');

fs.writeFileSync('liquidityFilteredStats.json', JSON.stringify(allStats, null, 1));
fs.writeFileSync('liquidityFilteredCandidates.json', JSON.stringify(candidates, null, 1));
console.log('\nSaved liquidityFilteredStats.json and liquidityFilteredCandidates.json');
