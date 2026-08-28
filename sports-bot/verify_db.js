'use strict';
const { getDb, DB_FILE } = require('./db');
const path = require('path');

const db = getDb();

console.log('Sports DB file:', DB_FILE);
console.log('Weather DB file (for comparison, not touched):', path.resolve(__dirname, '..', '..', 'polybot-v2', 'data', 'polybot.db'));
console.log('Same file?', DB_FILE === path.resolve(__dirname, '..', '..', 'polybot-v2', 'data', 'polybot.db'));

console.log('\nSchema (PRAGMA table_info(trades)):');
for (const col of db.prepare('PRAGMA table_info(trades)').all()) {
  console.log(`  ${col.name.padEnd(28)} ${col.type.padEnd(8)} ${col.notnull ? 'NOT NULL' : ''} ${col.dflt_value ? 'DEFAULT ' + col.dflt_value : ''}`);
}

console.log('\nIndexes:');
for (const idx of db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='trades'`).all()) {
  console.log(`  ${idx.name}`);
}

// Round-trip: insert a paper trade, confirm it lands as 'pending', then transition it to
// 'won' the way the settlement checker's output would drive it, and confirm the CHECK
// constraint rejects a bogus status.
const insert = db.prepare(`
  INSERT INTO trades (created_at, mode, event_slug, market_slug, sport, market_type,
    bucket_key, horizon, band, side, entry_price, quantity, stake_usd, fee_usd,
    holdout_n, holdout_p_true, kelly_fraction_raw, effective_cap_pct, opened_at)
  VALUES (@created_at, @mode, @event_slug, @market_slug, @sport, @market_type,
    @bucket_key, @horizon, @band, @side, @entry_price, @quantity, @stake_usd, @fee_usd,
    @holdout_n, @holdout_p_true, @kelly_fraction_raw, @effective_cap_pct, @opened_at)
`);
const now = new Date().toISOString();
const result = insert.run({
  created_at: now, mode: 'paper',
  event_slug: 'mlb-wsh-phi-2026-03-31', market_slug: 'aec-mlb-wsh-phi-2026-03-31',
  sport: 'mlb', market_type: 'moneyline',
  bucket_key: 'mlb|moneyline|h24|0.30-0.40', horizon: 'h24', band: '0.30-0.40',
  side: 'NO', entry_price: 0.62, quantity: 3.22, stake_usd: 2.0, fee_usd: 0.06,
  holdout_n: 14, holdout_p_true: 0.7857142857142857, kelly_fraction_raw: 0.4358,
  effective_cap_pct: 0.02 * (14 / 30), opened_at: now,
});
console.log('\nInserted trade id:', result.lastInsertRowid, '-- status defaults to:', db.prepare('SELECT status FROM trades WHERE id = ?').get(result.lastInsertRowid).status);

db.prepare(`UPDATE trades SET status = 'won', resolved_outcome_prices = '["0","1"]', exit_pnl_usd = 1.19, resolved_at = ? WHERE id = ?`)
  .run(new Date().toISOString(), result.lastInsertRowid);
console.log('After settlement-checker-driven update:', db.prepare('SELECT status, exit_pnl_usd FROM trades WHERE id = ?').get(result.lastInsertRowid));

try {
  db.prepare(`UPDATE trades SET status = 'bogus_status' WHERE id = ?`).run(result.lastInsertRowid);
  console.log('\nCHECK constraint test: FAILED (bogus status was accepted)');
} catch (err) {
  console.log('\nCHECK constraint test: PASSED -- rejected bogus status:', err.message);
}

// Re-entry guard test: try to insert a second 'pending' trade on the same market_slug.
const insert2 = db.prepare(`
  INSERT INTO trades (created_at, mode, event_slug, market_slug, sport, market_type,
    bucket_key, horizon, band, side, entry_price, quantity, stake_usd, fee_usd,
    holdout_n, holdout_p_true, kelly_fraction_raw, effective_cap_pct, opened_at)
  VALUES (@created_at, @mode, @event_slug, 'DIFFERENT-SLUG-not-a-dup', @sport, @market_type,
    @bucket_key, @horizon, @band, @side, @entry_price, @quantity, @stake_usd, @fee_usd,
    @holdout_n, @holdout_p_true, @kelly_fraction_raw, @effective_cap_pct, @opened_at)
`);
insert2.run({
  created_at: now, mode: 'paper', event_slug: 'x', sport: 'mlb', market_type: 'moneyline',
  bucket_key: 'x', horizon: 'h24', band: '0.30-0.40', side: 'NO', entry_price: 0.5,
  quantity: 1, stake_usd: 1, fee_usd: 0, holdout_n: 1, holdout_p_true: 0.5,
  kelly_fraction_raw: 0, effective_cap_pct: 0.02, opened_at: now,
});
try {
  insert2.run({
    created_at: now, mode: 'paper', event_slug: 'x', sport: 'mlb', market_type: 'moneyline',
    bucket_key: 'x', horizon: 'h24', band: '0.30-0.40', side: 'NO', entry_price: 0.5,
    quantity: 1, stake_usd: 1, fee_usd: 0, holdout_n: 1, holdout_p_true: 0.5,
    kelly_fraction_raw: 0, effective_cap_pct: 0.02, opened_at: now,
  });
  console.log('Re-entry guard test: FAILED (duplicate pending row on same market_slug was accepted)');
} catch (err) {
  console.log('Re-entry guard test: PASSED -- rejected duplicate pending row:', err.message);
}

db.prepare(`DELETE FROM trades WHERE market_slug IN ('aec-mlb-wsh-phi-2026-03-31', 'DIFFERENT-SLUG-not-a-dup')`).run();
console.log('\n(test rows cleaned up)');
