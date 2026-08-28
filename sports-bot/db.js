// Sports bot's own database -- fully separate file from polybot-v2 (the weather bot). Its
// trades table has weather-specific NOT NULL columns (city, bracket_label,
// settlement_target_date) baked into the INSERT statement; none of that maps to sports, and
// this module shares no file, connection, or schema with it. Mirrors polybot-v2's
// lib/db.ts conventions (better-sqlite3, WAL mode, busy_timeout, startup checkpoint,
// idempotent CREATE TABLE IF NOT EXISTS migration) since those are sound and sport-agnostic
// -- but this is an independent implementation, not a shared/imported module.
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'sports-bot.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_FILE);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('wal_checkpoint(TRUNCATE)');
  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      mode TEXT NOT NULL,                       -- 'paper' | 'live'
      order_id TEXT,

      -- Market identity, persisted VERBATIM -- never reconstructed later. The settlement
      -- checker found market-level slugs carry their own type prefix (aec-/asc-/tsc-) that
      -- isn't reliably derivable from the event slug or from a template, so whatever opens
      -- the position must save the exact strings the API returned at trade time.
      event_slug TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      sport TEXT NOT NULL,                      -- 'nba' | 'nhl' | 'mlb'
      market_type TEXT NOT NULL,                -- 'moneyline' | 'spread' | 'total'

      -- Bucket identity (sport x market_type x horizon x band) -- what the holdout
      -- win-rate table and the n=30 sample-size-scaled cap are keyed on.
      bucket_key TEXT NOT NULL,                 -- e.g. 'nba|moneyline|h3|<=0.30'
      horizon TEXT NOT NULL,                    -- 'h3' | 'h24'
      band TEXT NOT NULL,                       -- '<=0.30' | '0.30-0.40' | '>=0.40'

      -- What we actually bought.
      side TEXT NOT NULL,                       -- 'YES' | 'NO'
      entry_price REAL NOT NULL,
      quantity REAL NOT NULL,
      stake_usd REAL NOT NULL,
      fee_usd REAL NOT NULL DEFAULT 0,

      -- Sizing inputs frozen at trade time, for audit. The holdout table gets recomputed
      -- periodically (see project findings on the sample-size-scaled cap) -- this records
      -- exactly what was used for THIS trade, not whatever the table says if queried later.
      holdout_n INTEGER NOT NULL,
      holdout_p_true REAL NOT NULL,
      kelly_fraction_raw REAL NOT NULL,
      effective_cap_pct REAL NOT NULL,          -- post n=30 sample-size scaling

      -- Resolution -- mirrors settlementChecker.js's output states exactly, so its results
      -- can be written straight into this column with no translation layer.
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void','unresolvable')),
      needs_manual_review INTEGER NOT NULL DEFAULT 0,  -- set on 'void' or 'unresolvable', never auto-cleared
      resolved_outcome_prices TEXT,             -- raw ["x","y"] from the API, kept for audit
      exit_pnl_usd REAL,
      opened_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_bucket_key ON trades(bucket_key);

    -- Same re-entry defense pattern as the weather bot's idx_trades_open_market_unique:
    -- a partial unique index rejects a second open position in the same market outright,
    -- at the DB level, regardless of whether the application-layer check raced.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_open_market_unique ON trades(market_slug) WHERE status = 'pending';
  `);
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, closeDb, DB_FILE };
