// Constructed test (NOT a live occurrence -- clearly labeled as such): today's live scan
// found zero markets within the horizon window, so recordTrade()'s DB-write path was never
// actually exercised by the real dry pass. This feeds a fully realistic (real market slugs,
// real price, real decision shape from evaluateOpportunity()'s actual return contract) but
// manually-assembled scan result through the exact same recordTrade() function the
// orchestrator itself uses, to confirm every phase-2 schema field gets written correctly.
'use strict';
const { getDb, DB_FILE } = require('../db');
const { recordTrade } = require('../orchestrator');

const db = getDb();

// Shaped exactly like a real scanner.js result whose decision.action === 'trade' -- field
// names and nesting match evaluateGatewayMarket()'s actual return value and
// evaluateOpportunity()'s actual 'trade' return value verbatim.
const scanResult = {
  sport: 'mlb',
  eventSlug: 'mlb-example-away-home-2026-08-29',
  marketSlug: 'aec-mlb-example-away-home-2026-08-29',
  marketType: 'moneyline',
  gameStartTime: '2026-08-30T00:00:00Z',
  bucketKey: 'mlb|moneyline|h24|0.30-0.40',
  opp: {
    sport: 'mlb', marketType: 'moneyline', horizon: 'h24', band: '0.30-0.40', side: 'NO',
    price: 0.62, resolutionDate: new Date('2026-08-30T00:00:00Z'), availableDepthUsd: 150,
    marketSlug: 'aec-mlb-example-away-home-2026-08-29', eventSlug: 'mlb-example-away-home-2026-08-29',
  },
  decision: {
    action: 'trade', bucketKey: 'mlb|moneyline|h24|0.30-0.40', price: 0.62,
    stake: 2.15, fee: 0.07, quantity: 3.4677, totalOutlay: 2.22,
    holdoutN: 76, holdoutPTrue: 0.7236842105263157, kellyFractionRaw: 0.4383, effectiveCapPct: 0.02,
  },
};
const execResult = { ok: true, mode: 'paper', orderId: 'paper-TEST-12345', entryPrice: 0.62, quantity: 3.4677 };

const tradeId = recordTrade(db, scanResult, execResult);
console.log('Wrote trade id', tradeId, 'to', DB_FILE);

const row = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
console.log('\nFull row as persisted:');
console.log(row);

// Verify every phase-2 schema field that should come from the scan result actually matches
// -- not just "a row was written," but "the RIGHT values landed in the RIGHT columns."
const checks = [
  ['event_slug', row.event_slug, scanResult.opp.eventSlug],
  ['market_slug', row.market_slug, scanResult.opp.marketSlug],
  ['sport', row.sport, scanResult.opp.sport],
  ['market_type', row.market_type, scanResult.opp.marketType],
  ['bucket_key', row.bucket_key, scanResult.bucketKey],
  ['horizon', row.horizon, scanResult.opp.horizon],
  ['band', row.band, scanResult.opp.band],
  ['side', row.side, scanResult.opp.side],
  ['entry_price', row.entry_price, execResult.entryPrice],
  ['quantity', row.quantity, execResult.quantity],
  ['stake_usd', row.stake_usd, scanResult.decision.stake],
  ['fee_usd', row.fee_usd, scanResult.decision.fee],
  ['holdout_n', row.holdout_n, scanResult.decision.holdoutN],
  ['holdout_p_true', row.holdout_p_true, scanResult.decision.holdoutPTrue],
  ['kelly_fraction_raw', row.kelly_fraction_raw, scanResult.decision.kellyFractionRaw],
  ['effective_cap_pct', row.effective_cap_pct, scanResult.decision.effectiveCapPct],
  ['status', row.status, 'pending'],
  ['mode', row.mode, execResult.mode],
  ['order_id', row.order_id, execResult.orderId],
];
let allPass = true;
for (const [field, actual, expected] of checks) {
  const ok = actual === expected;
  if (!ok) allPass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${field}: ${actual} ${ok ? '==' : '!='} ${expected}`);
}
console.log(`\n${allPass ? 'ALL FIELDS CORRECT' : 'MISMATCH FOUND'}`);

// Clean up -- this was a constructed test row, not a real position.
db.prepare('DELETE FROM trades WHERE id = ?').run(tradeId);
console.log('(test row removed)');
