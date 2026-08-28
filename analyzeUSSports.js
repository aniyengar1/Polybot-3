const fs = require('fs');

const records = JSON.parse(fs.readFileSync('usSportsHistory.json', 'utf8'));
const HORIZONS = [
  { key: 'h168', label: '7 days out' },
  { key: 'h72', label: '3 days out' },
  { key: 'h24', label: '1 day out' },
  { key: 'h3', label: '3 hours out' },
];
const SUBMARKET_TYPES = ['moneyline', 'spread', 'total'];
const MIN_TRUSTED_N = 30;

function bandFor(price) {
  if (price <= 0.3) return '<=0.30';
  if (price < 0.4) return '0.30-0.40';
  return '>=0.40';
}
function summarize(rows) {
  const n = rows.length;
  if (n === 0) return null;
  const avgPrice = rows.reduce((s, r) => s + r.price, 0) / n;
  const realizedRate = rows.reduce((s, r) => s + r.yesResolvedTo, 0) / n;
  return { n, avgPrice, realizedRate, bias: realizedRate - avgPrice };
}

// Chronological walk-forward split — no lookahead: estimate bias/edge on the first half by
// TIME, simulate trades on the second half only.
records.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));
const splitIdx = Math.floor(records.length / 2);
const train = records.slice(0, splitIdx);
const test = records.slice(splitIdx);
console.log(`Chronological split: ${train.length} train (up to ${train[train.length - 1]?.endDate}), ${test.length} test (from ${test[0]?.endDate})\n`);

console.log('=== TRAIN: bias by submarket type x horizon x band ===');
console.log('type | horizon | band | n | avg_price | realized_rate | bias');
const trainStats = {}; // [type][horizon][band] = summary, for Kelly p_true lookup later
for (const type of SUBMARKET_TYPES) {
  trainStats[type] = {};
  for (const h of HORIZONS) {
    trainStats[type][h.key] = {};
    const rows = train.filter((r) => r.submarketType === type && r.checkpoints[h.key]).map((r) => ({ price: r.checkpoints[h.key].price, yesResolvedTo: r.yesResolvedTo }));
    const bands = { '<=0.30': [], '0.30-0.40': [], '>=0.40': [] };
    for (const r of rows) bands[bandFor(r.price)].push(r);
    for (const bandName of Object.keys(bands)) {
      const s = summarize(bands[bandName]);
      trainStats[type][h.key][bandName] = s;
      if (!s) {
        console.log(`${type} | ${h.label} | ${bandName} | 0 | -- | -- | --`);
        continue;
      }
      const flag = s.n < MIN_TRUSTED_N ? '  [THIN]' : '';
      console.log(`${type} | ${h.label} | ${bandName} | ${s.n} | ${s.avgPrice.toFixed(3)} | ${(s.realizedRate * 100).toFixed(1)}% | ${(s.bias * 100).toFixed(1)}pp${flag}`);
    }
  }
}

console.log('\n=== TEST: same breakdown, for comparison (does the TRAIN signal hold up out-of-sample?) ===');
console.log('type | horizon | band | n | avg_price | realized_rate | bias');
const testStats = {};
for (const type of SUBMARKET_TYPES) {
  testStats[type] = {};
  for (const h of HORIZONS) {
    testStats[type][h.key] = {};
    const rows = test.filter((r) => r.submarketType === type && r.checkpoints[h.key]).map((r) => ({ price: r.checkpoints[h.key].price, yesResolvedTo: r.yesResolvedTo }));
    const bands = { '<=0.30': [], '0.30-0.40': [], '>=0.40': [] };
    for (const r of rows) bands[bandFor(r.price)].push(r);
    for (const bandName of Object.keys(bands)) {
      const s = summarize(bands[bandName]);
      testStats[type][h.key][bandName] = s;
      if (!s) {
        console.log(`${type} | ${h.label} | ${bandName} | 0 | -- | -- | --`);
        continue;
      }
      const flag = s.n < MIN_TRUSTED_N ? '  [THIN]' : '';
      console.log(`${type} | ${h.label} | ${bandName} | ${s.n} | ${s.avgPrice.toFixed(3)} | ${(s.realizedRate * 100).toFixed(1)}% | ${(s.bias * 100).toFixed(1)}pp${flag}`);
    }
  }
}

fs.writeFileSync('trainTestStats.json', JSON.stringify({ trainStats, testStats, trainN: train.length, testN: test.length }, null, 1));
fs.writeFileSync('splitRecords.json', JSON.stringify({ train, test }, null, 1));
console.log('\nSaved trainTestStats.json and splitRecords.json for the simulation step.');
