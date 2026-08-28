// Re-derives the historical bias signal for the isolated, correctly-parsed 'spread_1.5'
// submarket type (full-game +/-1.5 run line, home+away pooled per the confirmed design --
// see fetchMLBFixed.js's parseSpreadSlug/pickSubmarkets), from a fresh full historical
// re-fetch (test/../../usMLBFixed.json, produced by re-running fetchMLBFixed.js's main()
// against the full 2070-event census with the corrected parser). Same exact methodology as
// analyzeLiquidityFiltered.js's Step 2 (liquid-only, chronological half-split train/test,
// bias = realizedRate - avgPrice) -- scoped to sport=mlb, submarketType=spread_1.5, across
// ALL horizons/bands (not assuming the old h3/<=0.30 finding still applies to a fundamentally
// different, cleaner population).
'use strict';
const fs = require('fs');
const path = require('path');

const HORIZONS = [
  { key: 'h168', label: '7d' },
  { key: 'h72', label: '3d' },
  { key: 'h24', label: '1d' },
  { key: 'h3', label: '3h' },
];
const MIN_TRUSTED_N = 30;

function bandFor(price) {
  if (price <= 0.3) return '<=0.30';
  if (price < 0.4) return '0.30-0.40';
  return '>=0.40';
}

function summarize(rows, horizonKey) {
  const n = rows.length;
  if (n === 0) return null;
  const avgPrice = rows.reduce((s, r) => s + r.checkpoints[horizonKey].price, 0) / n;
  const realizedRate = rows.reduce((s, r) => s + r.yesResolvedTo, 0) / n;
  return { n, avgPrice, realizedRate, bias: realizedRate - avgPrice };
}

function main() {
  const records = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'mlbSpread15Only.json'), 'utf8'));
  const spreadRecords = records.filter((r) => r.submarketType === 'spread_1.5');
  console.log(`Total spread_1.5 records (all horizons, liquid+illiquid, both away/home pooled): ${spreadRecords.length}`);

  const bySlug = new Set(spreadRecords.map((r) => r.usSlug));
  console.log(`Unique games contributing a spread_1.5 record: ${bySlug.size}`);

  const candidates = [];
  console.log('\nhorizon | band | split | n | avg_price | realized_rate | bias');
  for (const h of HORIZONS) {
    const liquidRows = spreadRecords.filter((r) => r.checkpoints[h.key] && r.checkpoints[h.key].liquid);
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
      for (const [label, s] of [['train', trainS], ['test', testS]]) {
        if (!s) {
          console.log(`${h.label} | ${bandName} | ${label} | 0 | -- | -- | --`);
          continue;
        }
        const flag = s.n < MIN_TRUSTED_N ? '  [THIN]' : '';
        console.log(`${h.label} | ${bandName} | ${label} | ${s.n} | ${s.avgPrice.toFixed(3)} | ${(s.realizedRate * 100).toFixed(1)}% | ${(s.bias * 100).toFixed(1)}pp${flag}`);
      }
      if (trainS && testS && trainS.n >= MIN_TRUSTED_N && testS.n >= MIN_TRUSTED_N) {
        const sameSign = Math.sign(trainS.bias) === Math.sign(testS.bias) && trainS.bias !== 0;
        if (sameSign && Math.abs(trainS.bias) > 0.05 && Math.abs(testS.bias) > 0.05) {
          candidates.push({ horizon: h.label, band: bandName, train: trainS, test: testS });
        }
      }
    }
  }

  console.log('\n=== Candidate signals (train & test both n>=30, same sign, |bias|>5pp both sides) ===');
  if (candidates.length === 0) {
    console.log('NONE. No horizon/band combination for the isolated spread_1.5 bet type clears the same bar the original 3 buckets cleared.');
  } else {
    for (const c of candidates) {
      console.log(`${c.horizon} | ${c.band} | train n=${c.train.n} bias=${(c.train.bias * 100).toFixed(1)}pp | test n=${c.test.n} bias=${(c.test.bias * 100).toFixed(1)}pp`);
    }
  }
}

main();
