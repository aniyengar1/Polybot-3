const fs = require('fs');

const results = JSON.parse(fs.readFileSync('priceHistory.json', 'utf8'));
const HORIZONS = [
  { key: 'h168', label: '7 days out' },
  { key: 'h72', label: '3 days out' },
  { key: 'h24', label: '1 day out' },
  { key: 'h3', label: '3 hours out' },
];
const CATEGORIES = ['politics', 'sports', 'crypto'];
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
  const bias = realizedRate - avgPrice; // positive = underpriced (buying YES was profitable on average), negative = overpriced
  return { n, avgPrice, realizedRate, bias };
}

console.log('=== Favorite-longshot bias: 3-band breakdown, per category x horizon ===');
console.log('bias = realized YES rate - avg price. Negative = overpriced (bought too dear); positive = underpriced.\n');

for (const h of HORIZONS) {
  console.log(`--- Horizon: ${h.label} ---`);
  console.log('category | band | n | avg_price | realized_rate | bias');
  for (const cat of CATEGORIES) {
    const rowsForCatHorizon = results
      .filter((r) => r.category === cat && r.checkpoints && r.checkpoints[h.key])
      .map((r) => ({ price: r.checkpoints[h.key].price, yesResolvedTo: r.yesResolvedTo }));

    const bands = { '<=0.30': [], '0.30-0.40': [], '>=0.40': [] };
    for (const r of rowsForCatHorizon) bands[bandFor(r.price)].push(r);

    for (const bandName of Object.keys(bands)) {
      const s = summarize(bands[bandName]);
      if (!s) {
        console.log(`${cat} | ${bandName} | 0 | -- | -- | -- (no data)`);
        continue;
      }
      const flag = s.n < MIN_TRUSTED_N ? '  [THIN — n<30, do not trust]' : '';
      console.log(`${cat} | ${bandName} | ${s.n} | ${s.avgPrice.toFixed(3)} | ${(s.realizedRate * 100).toFixed(1)}% | ${(s.bias * 100).toFixed(1)}pp${flag}`);
    }
  }
  console.log('');
}

console.log('\n=== Pooled across categories (larger n, supports finer deciles) — per horizon ===');
for (const h of HORIZONS) {
  const rows = results.filter((r) => r.checkpoints && r.checkpoints[h.key]).map((r) => ({ price: r.checkpoints[h.key].price, yesResolvedTo: r.yesResolvedTo }));
  console.log(`--- ${h.label} (pooled n=${rows.length}) ---`);
  console.log('decile | n | avg_price | realized_rate | bias');
  const deciles = Array.from({ length: 10 }, () => []);
  for (const r of rows) {
    const idx = Math.min(9, Math.floor(r.price * 10));
    deciles[idx].push(r);
  }
  deciles.forEach((rowsInDecile, i) => {
    const s = summarize(rowsInDecile);
    if (!s) {
      console.log(`${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)} | 0 | -- | -- | --`);
      return;
    }
    const flag = s.n < MIN_TRUSTED_N ? '  [THIN]' : '';
    console.log(`${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)} | ${s.n} | ${s.avgPrice.toFixed(3)} | ${(s.realizedRate * 100).toFixed(1)}% | ${(s.bias * 100).toFixed(1)}pp${flag}`);
  });
  console.log('');
}

console.log('\n=== Does the bias shrink near resolution? 3-band bias by horizon, pooled across categories ===');
console.log('horizon | <=0.30 bias (n) | 0.30-0.40 bias (n) | >=0.40 bias (n)');
for (const h of HORIZONS) {
  const rows = results.filter((r) => r.checkpoints && r.checkpoints[h.key]).map((r) => ({ price: r.checkpoints[h.key].price, yesResolvedTo: r.yesResolvedTo }));
  const bands = { '<=0.30': [], '0.30-0.40': [], '>=0.40': [] };
  for (const r of rows) bands[bandFor(r.price)].push(r);
  const parts = Object.keys(bands).map((b) => {
    const s = summarize(bands[b]);
    return s ? `${(s.bias * 100).toFixed(1)}pp (n=${s.n})` : 'n/a';
  });
  console.log(`${h.label} | ${parts.join(' | ')}`);
}

console.log('\n=== Missing-checkpoint coverage (markets where that horizon had no price point within 6h) ===');
for (const h of HORIZONS) {
  const total = results.length;
  const missing = results.filter((r) => !r.checkpoints || !r.checkpoints[h.key]).length;
  console.log(`${h.label}: ${missing}/${total} missing (${((missing / total) * 100).toFixed(0)}%)`);
}
