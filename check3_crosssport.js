// Check 3: does the 30-40c moneyline / 3-days-out mispricing show up in other sports, or is it
// CBB-specific? Same methodology as analyzeUSSports.js, broken out per sport, not pooled.
const fs = require('fs');

const records = JSON.parse(fs.readFileSync('usSportsHistory.json', 'utf8'));
const MIN_TRUSTED_N = 30;

function sportOf(usSlug) {
  return usSlug.replace(/^aec-|^atc-/, '').split('-')[0];
}

const moneylineH72Band = records.filter(
  (r) => r.submarketType === 'moneyline' && r.checkpoints.h72 && r.checkpoints.h72.price > 0.3 && r.checkpoints.h72.price < 0.4
);

const sports = [...new Set(moneylineH72Band.map((r) => sportOf(r.usSlug)))];
console.log(`Sports present in this band/horizon/type: ${sports.join(', ')}\n`);

console.log('sport | split | n | avg_price | realized_rate | bias');
for (const sport of sports) {
  const rows = moneylineH72Band.filter((r) => sportOf(r.usSlug) === sport).sort((a, b) => new Date(a.endDate) - new Date(b.endDate));
  const splitIdx = Math.floor(rows.length / 2);
  const trainRows = rows.slice(0, splitIdx);
  const testRows = rows.slice(splitIdx);

  function summarize(rs) {
    const n = rs.length;
    if (n === 0) return null;
    const avgPrice = rs.reduce((s, r) => s + r.checkpoints.h72.price, 0) / n;
    const realizedRate = rs.reduce((s, r) => s + r.yesResolvedTo, 0) / n;
    return { n, avgPrice, realizedRate, bias: realizedRate - avgPrice };
  }

  const trainS = summarize(trainRows);
  const testS = summarize(testRows);
  const allS = summarize(rows);

  for (const [label, s] of [['ALL', allS], ['train-half', trainS], ['test-half', testS]]) {
    if (!s) {
      console.log(`${sport} | ${label} | 0 | -- | -- | --`);
      continue;
    }
    const flag = s.n < MIN_TRUSTED_N ? '  [THIN]' : '';
    console.log(`${sport} | ${label} | ${s.n} | ${s.avgPrice.toFixed(3)} | ${(s.realizedRate * 100).toFixed(1)}% | ${(s.bias * 100).toFixed(1)}pp${flag}`);
  }
  console.log('');
}
