// Explicit confirmation of the fail-safe flagged back in phase 2: on void/unresolvable
// settlement, needs_manual_review must be set to 1 and exit_pnl_usd must NOT be touched
// (stays null), rather than crediting a phantom win or loss. Void/unresolvable outcomes are
// rare enough that no real example has turned up live in this whole project (confirmed
// again in phase 1's forensic audit), so this seeds 3 real-shaped pending positions and
// stubs settlementChecker's actual network call via Node's require cache -- exercising the
// REAL orchestrator.runSettlement() code path (not a reimplementation of its logic) against
// a controlled, guaranteed-to-include-void/unresolvable input.
'use strict';
const path = require('path');

// Stub settlementChecker BEFORE orchestrator.js (or anything else) requires it, so
// orchestrator's own `const { checkSportsSettlements } = require('./settlementChecker')`
// picks up this fake instead of making real network calls.
const settlementCheckerPath = require.resolve('../settlementChecker');
require.cache[settlementCheckerPath] = {
  id: settlementCheckerPath,
  filename: settlementCheckerPath,
  loaded: true,
  exports: {
    checkSportsSettlements: async (positions) => {
      // positions[0] -> won, positions[1] -> void, positions[2] -> unresolvable.
      // Mirrors classifyMarketOutcome's REAL return shapes exactly (see settlementChecker.js).
      return {
        won: [{ position: positions[0], status: 'won', outcomePrices: ['0.00', '1.00'] }],
        lost: [],
        void: [{ position: positions[1], status: 'void', outcomePrices: ['0.50', '0.50'] }],
        unresolvable: [{ position: positions[2], status: 'unresolvable', reason: 'outcomePrices did not parse' }],
        pending: [],
      };
    },
  },
};

const { getDb } = require('../db');
const { runSettlement } = require('../orchestrator');

const db = getDb();

const now = new Date().toISOString();
const insert = db.prepare(`
  INSERT INTO trades (created_at, mode, event_slug, market_slug, sport, market_type,
    bucket_key, horizon, band, side, entry_price, quantity, stake_usd, fee_usd,
    holdout_n, holdout_p_true, kelly_fraction_raw, effective_cap_pct, opened_at)
  VALUES (@created_at, 'paper', @event_slug, @market_slug, 'mlb', 'moneyline',
    'mlb|moneyline|h24|0.30-0.40', 'h24', '0.30-0.40', 'NO', 0.62, 3.4677, 2.15, 0.07,
    76, 0.7236842105263157, 0.4383, 0.02, @opened_at)
`);
const seedRows = ['won', 'void', 'unresolvable'].map((label) => {
  const r = insert.run({ created_at: now, event_slug: `test-${label}-event`, market_slug: `test-${label}-market`, opened_at: now });
  return { id: r.lastInsertRowid, label };
});
console.log('Seeded 3 pending test positions:', seedRows.map((r) => `#${r.id} (${r.label})`).join(', '));

async function main() {
  await runSettlement(db);

  console.log('\nResulting DB state:');
  let allPass = true;
  for (const { id, label } of seedRows) {
    const row = db.prepare('SELECT status, needs_manual_review, exit_pnl_usd, resolved_outcome_prices FROM trades WHERE id = ?').get(id);
    console.log(`  #${id} (expected ${label}):`, row);

    if (label === 'won') {
      const ok = row.status === 'won' && row.needs_manual_review === 0 && row.exit_pnl_usd !== null;
      if (!ok) allPass = false;
      console.log(`    ${ok ? 'PASS' : 'FAIL'}: won position settled normally, P&L credited, no review flag`);
    } else {
      // void and unresolvable: same fail-safe requirement.
      const ok = row.needs_manual_review === 1 && row.exit_pnl_usd === null && row.status === label;
      if (!ok) allPass = false;
      console.log(`    ${ok ? 'PASS' : 'FAIL'}: ${label} position flagged needs_manual_review=1, exit_pnl_usd left NULL (not auto-credited)`);
    }
  }
  console.log(`\n${allPass ? 'FAIL-SAFE CONFIRMED WORKING' : 'FAIL-SAFE BROKEN -- DO NOT PROCEED'}`);

  db.prepare(`DELETE FROM trades WHERE id IN (${seedRows.map((r) => r.id).join(',')})`).run();
  console.log('(test rows removed)');
}

main().catch((err) => { console.error(err); process.exit(1); });
