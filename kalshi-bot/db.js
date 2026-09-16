// kalshi-bot's own database. Fully separate file/schema from sports-bot/db.js and
// polybot-v2's db -- no shared connection, no shared table shapes (this bot's checkpoint/
// observation model doesn't map onto either of those). Mirrors the same better-sqlite3 +
// WAL conventions because they're sound and product-agnostic, independently reimplemented.
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'kalshi-bot.db');

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

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function migrate(db) {
  // CREATE TABLE IF NOT EXISTS runs FIRST, unconditionally -- this guarantees every table below
  // exists (whether newly created just now, or already existing from a prior startup) BEFORE any
  // ALTER-based column backfill is attempted. Ordering matters: on a genuinely fresh database,
  // computing "does this table already exist" before CREATE TABLE has run would see zero tables
  // and skip every backfill below -- which is exactly the bug this ordering fixes (found
  // 2026-09-10, during task #12's smoke testing; a fresh DB's very first checkpoint cycle would
  // crash at orchestrator.js's getBankrollUsd(), which queries trades.log_only -- an ALTER-only
  // column that would never have been added, since CREATE TABLE's own base column list predates
  // it and was deliberately never rebuilt to include later-added columns, see the backfill
  // section below for why). Self-heals after exactly one crash-and-restart today; this ordering
  // fix removes the crash entirely.
  db.exec(`
    -- One row per checkpoint evaluation, for EVERY band (not just the 3 traded buckets) --
    -- calibration.js needs the full observation stream to recompute each traded bucket's
    -- walk-forward hit rate daily, exactly like the backtest's own todayAgg fold (see
    -- backtestGoldSilverThreeBucket.js), which updates calibration for every bucket a
    -- window happens to land in, independent of whether that bucket was tradeable that day.
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      series TEXT NOT NULL,                 -- 'KXGOLD15M' | 'KXSILVER15M' | 'KXWTI15M'
      ticker TEXT NOT NULL,
      event_ticker TEXT NOT NULL,
      open_ts INTEGER NOT NULL,
      close_ts INTEGER NOT NULL,
      checkpoint_ts INTEGER NOT NULL,
      checkpoint_price REAL NOT NULL,       -- YES-side price at the checkpoint
      band TEXT NOT NULL,                   -- '0.7-0.8' etc, from bucketOf()
      bucket_key TEXT NOT NULL,             -- '{series}|{band}|cp{checkpointMinutes}'
      checkpoint_date TEXT NOT NULL,        -- UTC calendar date of checkpoint_ts, for the daily fold
      checkpoint_minutes INTEGER NOT NULL DEFAULT 8, -- minutes-before-close this checkpoint fired at
      resolved INTEGER NOT NULL DEFAULT 0,
      yes_resolved_to INTEGER               -- 1 | 0, NULL until resolved
    );
    CREATE INDEX IF NOT EXISTS idx_obs_bucket_key ON observations(bucket_key);
    CREATE INDEX IF NOT EXISTS idx_obs_resolved ON observations(resolved);
    CREATE INDEX IF NOT EXISTS idx_obs_checkpoint_date ON observations(checkpoint_date);
    -- One observation per (market ticker, checkpoint) -- pre-WTI, a given 15-min market only
    -- ever had one checkpoint, so this was just (ticker). WTI's same ticker gets evaluated at
    -- 3 different checkpoints per window (3/6/8 min before close), so the uniqueness has to be
    -- per-checkpoint, not just per-ticker (see orchestrator.js's header).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_ticker_checkpoint_unique ON observations(ticker, checkpoint_minutes);

    -- Paper trades only -- see execution.js: there is no code path in this bot that submits
    -- a real order, so 'mode' is always 'paper' here (kept as a column, not hardcoded away,
    -- in case a genuinely separate live build is ever added later -- see README).
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'paper',
      observation_id INTEGER NOT NULL REFERENCES observations(id),
      series TEXT NOT NULL,
      ticker TEXT NOT NULL,
      bucket_key TEXT NOT NULL,
      side TEXT NOT NULL,                   -- 'yes' | 'no'
      market_price REAL NOT NULL,           -- raw YES-side price at decision time
      entry_cost REAL NOT NULL,             -- per-contract cost of the side we bought
      contracts INTEGER NOT NULL,
      fee_usd REAL NOT NULL,
      stake_usd REAL NOT NULL,              -- contracts*entry_cost + fee_usd (total outlay)

      -- Sizing inputs frozen at trade time, for audit -- same rationale as
      -- sports-bot/db.js's holdout_n/holdout_p_true/kelly_fraction_raw/effective_cap_pct.
      calibration_n INTEGER NOT NULL,
      calibration_p_hat REAL NOT NULL,      -- pre-shrinkage empirical hit rate
      calibration_p_shrunk REAL NOT NULL,   -- post-shrinkage, what sizing actually used
      kelly_fraction_raw REAL NOT NULL,
      kelly_fraction_used REAL NOT NULL,    -- per-bucket fraction actually applied

      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void')),
      exit_pnl_usd REAL,
      opened_at TEXT NOT NULL,
      resolved_at TEXT,

      -- 1 for buckets configured with logOnly:true in buckets.js (none currently -- WTI's
      -- 0.6-0.7/cp6 rule traded log-only from launch through 2026-09-06, then was promoted to
      -- probationary, see its buckets.js entry; kept as live infrastructure for the next rule
      -- that needs this track): the row still records a genuine would-be side/size and is
      -- settled/tracked exactly like a real trade, but stake_usd here was NEVER actually
      -- deducted from the paper bankroll (getBankrollUsd() in orchestrator.js excludes
      -- log_only=1 rows) and node cli.js performance/positions show these separately -- a real
      -- structural distinction, not a kellyFraction:0 approximation.
      log_only INTEGER NOT NULL DEFAULT 0,

      -- 'validated' | 'probationary' -- mirrors buckets.js's BUCKET_CONFIG[bucketKey].status
      -- (defaults to 'validated' when that field is omitted, e.g. gold/silver/WTI). Set once at
      -- insert time in orchestrator.js, not recomputed later -- if a bucket's status in
      -- buckets.js ever changes, existing rows keep recording what was true when they were
      -- opened, same audit rationale as kelly_fraction_used/calibration_p_shrunk above.
      -- Probationary buckets (currently the 7 DOGE/BTC crypto rules) get real paper stakes
      -- like any other bucket -- unlike log_only, which is a SEPARATE, stricter flag (never
      -- staked at all). This tag exists so a decaying probationary rule can be filtered,
      -- reviewed, and pulled from BUCKET_CONFIG individually without touching validated
      -- buckets -- see decayWatch.js's checkProbationReviews and the dashboard.
      bucket_status TEXT NOT NULL DEFAULT 'validated',

      -- Real top-of-book YES-side bid/ask (kalshiClient.js's getOrderbook), captured
      -- immediately before this trade's INSERT -- i.e. as close to the checkpoint's own price
      -- read as this bot's synchronous decision path allows, since there's no I/O between
      -- reading market_price and this insert. Capture-only, added 2026-09-06: does NOT feed
      -- sizing or side selection anywhere -- purpose is a future comparison, once enough trades
      -- accumulate per bucket, between what a real taker fill crossing this spread would have
      -- cost vs. the checkpoint-price-as-fill assumption every backtest and paper trade here
      -- has used. NULL for trades before this was added, and NULL (not a placeholder value) if
      -- the orderbook call itself failed or a side's book was empty at that instant -- a failed
      -- capture never blocks or alters the trade itself.
      yes_bid_at_checkpoint REAL,
      yes_ask_at_checkpoint REAL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_bucket_key ON trades(bucket_key);
    CREATE INDEX IF NOT EXISTS idx_trades_log_only ON trades(log_only);
    CREATE INDEX IF NOT EXISTS idx_trades_bucket_status ON trades(bucket_status);

    -- Live walk-forward calibration accumulator, ON TOP OF the static backtestBaseline in
    -- buckets.js (that baseline is combined with these live counts at read time -- see
    -- calibration.js -- not written into this table). Folded once per UTC calendar day from
    -- observations, matching the backtest's exact daily-recalibration cadence.
    CREATE TABLE IF NOT EXISTS live_calibration (
      bucket_key TEXT PRIMARY KEY,
      n INTEGER NOT NULL DEFAULT 0,
      hits INTEGER NOT NULL DEFAULT 0
    );

    -- Tracks the last UTC date whose settled observations have been folded into
    -- live_calibration, so the fold runs at most once per day per the walk-forward design
    -- (today's decisions must never see today's own outcomes -- no look-ahead).
    CREATE TABLE IF NOT EXISTS calibration_fold_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_folded_date TEXT
    );
    INSERT OR IGNORE INTO calibration_fold_state (id, last_folded_date) VALUES (1, NULL);

    -- Decay-watch alerts -- prominent, persistent record of any bucket trending toward the
    -- collapse pattern already observed live tonight in Silver 0.0-0.1/0.1-0.2. Never
    -- auto-cleared; a human should see and acknowledge these, not have them silently age out.
    CREATE TABLE IF NOT EXISTS decay_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      bucket_key TEXT NOT NULL,
      rolling_n INTEGER NOT NULL,
      rolling_win_rate REAL NOT NULL,
      baseline_win_rate REAL NOT NULL,
      rolling_pnl_usd REAL NOT NULL,
      reason TEXT NOT NULL
    );

    -- One-time trigger, never auto-cleared (same "surface it, don't bury it" philosophy as
    -- decay_alerts): fires exactly once per probationary bucket_key, the first time its live
    -- SETTLED (won/lost) trade count reaches MIN_CALIBRATION_N (30) -- the explicit signal that
    -- there's now enough forward, never-touched data to go evaluate that rule against its
    -- original search/holdout edge, per buckets.js's header. See decayWatch.js's
    -- checkProbationReviews.
    CREATE TABLE IF NOT EXISTS probation_review_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      bucket_key TEXT NOT NULL UNIQUE,
      n_at_trigger INTEGER NOT NULL,
      message TEXT NOT NULL
    );

    -- Shadow execution simulation (added 2026-09-07) -- genuinely separate, additive system:
    -- rides alongside every real trade (same signal/side/contracts) to test a passive
    -- join-the-bid limit order against a 60s timeout, vs. this bot's real paper fills which
    -- have always assumed an instant taker fill at the checkpoint price (see execution.js's
    -- header). NEVER read by getBankrollUsd() or any real trade/P&L query -- real_trade_id and
    -- observation_id below are read-only references OUT of this table into trades/observations,
    -- nothing ever writes back the other direction. See shadowExecution.js.
    --
    -- fee_usd here uses the same real taker-fee formula (liveSizing.js's feeUsd) for BOTH
    -- maker and taker fill_type rows -- there is no confirmed Kalshi maker-fee schedule
    -- implemented anywhere in this project (execution.js: "the fee model this bot uses is the
    -- TAKER schedule"), so this likely UNDERSTATES simulated maker P&L if Kalshi's real maker
    -- fee is lower. Known, named simplification, not an oversight -- see shadowExecution.js.
    CREATE TABLE IF NOT EXISTS shadow_execution_trials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      observation_id INTEGER NOT NULL REFERENCES observations(id),
      real_trade_id INTEGER REFERENCES trades(id),
      series TEXT NOT NULL,
      ticker TEXT NOT NULL,
      bucket_key TEXT NOT NULL,
      side TEXT NOT NULL,                   -- 'yes' | 'no', mirrors the paired real trade
      contracts INTEGER NOT NULL,           -- mirrors the paired real trade's Kelly-sized quantity -- only the fill mechanism is being varied, not the size
      signal_at TEXT NOT NULL,              -- when the real trade decision fired (checkpoint moment)
      limit_price REAL NOT NULL,            -- passive join-the-bid price computed at signal time
      fill_type TEXT NOT NULL CHECK (fill_type IN ('maker','taker')),
      fill_price REAL NOT NULL,             -- maker: equals limit_price (you fill at your resting price). taker: a FRESH poll at the 60s timeout, not the stale signal-time value
      fee_usd REAL NOT NULL,
      seconds_to_fill REAL NOT NULL,        -- maker: actual elapsed time to cross. taker: always ~60 (the timeout)
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void')),
      exit_pnl_usd REAL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_observation_id ON shadow_execution_trials(observation_id);
    CREATE INDEX IF NOT EXISTS idx_shadow_bucket_key ON shadow_execution_trials(bucket_key);
    CREATE INDEX IF NOT EXISTS idx_shadow_status ON shadow_execution_trials(status);

    -- Drawdown breaker state (added 2026-09-09, see drawdownBreaker.js) -- one row per scope
    -- ('global', or a bucket_key for a per-bucket breaker): a durable high-water mark plus halt
    -- record, so a halt survives a process restart (the entire point of persisting this at all --
    -- an in-memory-only halt that silently clears on reboot defeats the breaker). NEVER
    -- auto-cleared by any code in this project: halted=1 stays 1 until a human manually resets
    -- it (there is deliberately no un-halt function anywhere in drawdownBreaker.js). This table
    -- is prerequisite schema only -- nothing in the live checkpoint path reads or writes it yet,
    -- see drawdownBreaker.js's header for what's still needed to wire it in.
    -- Ambiguous live-order-placement alerts (added 2026-09-09, see liveExecution.js's
    -- placeLivePosition). Fires when placeOrderSafely comes back 'unresolved' -- an order
    -- placement attempt whose outcome is genuinely unknown (network failure, timeout, or a 5xx
    -- during the initial POST, AND the list-and-scan resolution afterward found no matching
    -- client_order_id). Deliberately NOT inserted into trades -- a phantom 'pending' row would
    -- misrepresent a fact nobody actually knows (an order may or may not exist on Kalshi's own
    -- book). Same "surfaced, never auto-cleared, a human must look" pattern as decay_alerts /
    -- probation_review_alerts above, not a new design idiom.
    CREATE TABLE IF NOT EXISTS live_order_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      observation_id INTEGER REFERENCES observations(id),
      bucket_key TEXT NOT NULL,
      client_order_id TEXT NOT NULL,
      base TEXT NOT NULL CHECK (base IN ('demo','live')),
      details TEXT NOT NULL,
      resolved_manually INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS drawdown_breaker_state (
      scope TEXT PRIMARY KEY,             -- 'global' | a bucket_key
      peak_value REAL NOT NULL DEFAULT 0, -- high-water mark: bankroll USD for 'global', cumulative realized P&L USD for a bucket
      halted INTEGER NOT NULL DEFAULT 0,
      halted_at TEXT,
      halted_reason TEXT,
      halted_peak_value REAL,
      halted_current_value REAL,
      updated_at TEXT NOT NULL
    );
  `);

  // Additive column upgrades for databases created before the WTI multi-checkpoint refactor, and
  // for every column added to trades/live_order_alerts since -- CREATE TABLE IF NOT EXISTS above
  // won't add columns to a table that already exists, so these need a real ALTER TABLE with a
  // default for old rows. Now that CREATE TABLE IF NOT EXISTS above has already run, every table
  // referenced below is guaranteed to exist (see this function's opening comment) -- columnExists()
  // alone is sufficient to detect a missing column, no separate table-existence guard needed.
  if (!columnExists(db, 'observations', 'checkpoint_minutes')) {
    db.exec(`ALTER TABLE observations ADD COLUMN checkpoint_minutes INTEGER NOT NULL DEFAULT 8`);
  }
  if (!columnExists(db, 'trades', 'log_only')) {
    db.exec(`ALTER TABLE trades ADD COLUMN log_only INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columnExists(db, 'trades', 'bucket_status')) {
    db.exec(`ALTER TABLE trades ADD COLUMN bucket_status TEXT NOT NULL DEFAULT 'validated'`);
  }
  if (!columnExists(db, 'trades', 'yes_bid_at_checkpoint')) {
    db.exec(`ALTER TABLE trades ADD COLUMN yes_bid_at_checkpoint REAL`);
  }
  if (!columnExists(db, 'trades', 'yes_ask_at_checkpoint')) {
    db.exec(`ALTER TABLE trades ADD COLUMN yes_ask_at_checkpoint REAL`);
  }
  // Real-order execution columns (added 2026-09-09, see liveExecution.js) -- all NULL for every
  // existing (paper) row and every future paper row. execution_env gets its own single-column
  // CHECK (valid via ALTER TABLE ADD COLUMN); the mode='live' <-> execution_env-not-null PAIRING
  // is deliberately NOT a DB-level constraint -- SQLite's ALTER TABLE ADD COLUMN cannot add a
  // CHECK that references another column, and a cross-column CHECK could only be added via a
  // full CREATE TABLE rebuild, which this project has never done against a live database with
  // real trade history and isn't starting here. That pairing is enforced in application code
  // instead -- see orchestrator.js's trades INSERT, which never sets execution_env on a paper
  // row or omits it on a live row.
  if (!columnExists(db, 'trades', 'execution_env')) {
    db.exec(`ALTER TABLE trades ADD COLUMN execution_env TEXT CHECK (execution_env IS NULL OR execution_env IN ('demo','live'))`);
  }
  if (!columnExists(db, 'trades', 'client_order_id')) {
    db.exec(`ALTER TABLE trades ADD COLUMN client_order_id TEXT`);
  }
  if (!columnExists(db, 'trades', 'kalshi_order_id')) {
    db.exec(`ALTER TABLE trades ADD COLUMN kalshi_order_id TEXT`);
  }
  if (!columnExists(db, 'trades', 'expiration_time')) {
    db.exec(`ALTER TABLE trades ADD COLUMN expiration_time INTEGER`);
  }
  if (!columnExists(db, 'trades', 'live_fill_checked_at')) {
    db.exec(`ALTER TABLE trades ADD COLUMN live_fill_checked_at TEXT`);
  }
  // Taker-escalation columns (added 2026-09-10, see liveExecution.js). All NULL for paper rows
  // and for any live row that never needed escalation (maker filled within the 60s window).
  // fill_type deliberately mirrors shadow_execution_trials.fill_type's own name/CHECK values,
  // not a differently-named equivalent -- see liveExecution.js's header for why. The
  // maker/taker order id pair is tracked separately (taker_* columns distinct from the
  // existing client_order_id/kalshi_order_id, which stay the MAKER order's identifiers,
  // untouched) so both legs of an escalated trade are independently auditable.
  if (!columnExists(db, 'trades', 'fill_type')) {
    db.exec(`ALTER TABLE trades ADD COLUMN fill_type TEXT CHECK (fill_type IS NULL OR fill_type IN ('maker','taker'))`);
  }
  if (!columnExists(db, 'trades', 'taker_client_order_id')) {
    db.exec(`ALTER TABLE trades ADD COLUMN taker_client_order_id TEXT`);
  }
  if (!columnExists(db, 'trades', 'taker_kalshi_order_id')) {
    db.exec(`ALTER TABLE trades ADD COLUMN taker_kalshi_order_id TEXT`);
  }
  // Set atomically, BEFORE any escalation order is placed -- the guard that stops two racing
  // finalizeLiveOrder calls (the fire-and-forget monitor vs. reconcileLiveOrders) from both
  // placing a taker order for the same unfilled maker leg. See liveExecution.js's header for
  // the crash-recovery handling this column enables (claimed-but-not-yet-recorded vs.
  // recorded-but-not-yet-finalized are distinguishable via this column plus taker_kalshi_order_id).
  if (!columnExists(db, 'trades', 'escalation_claimed_at')) {
    db.exec(`ALTER TABLE trades ADD COLUMN escalation_claimed_at TEXT`);
  }
  // live_order_alerts already exists on both real databases (created earlier tonight) -- same
  // ALTER-TABLE-ADD-COLUMN requirement as the trades columns above, not something the CREATE
  // TABLE IF NOT EXISTS block above can retroactively add. Distinguishes "the very first
  // placement was ambiguous" from "the maker leg placed fine but the taker escalation was
  // ambiguous" -- see liveExecution.js's header.
  if (!columnExists(db, 'live_order_alerts', 'stage')) {
    db.exec(`ALTER TABLE live_order_alerts ADD COLUMN stage TEXT CHECK (stage IS NULL OR stage IN ('initial','escalation'))`);
  }
  db.exec(`DROP INDEX IF EXISTS idx_obs_ticker_unique`); // pre-refactor: unique on ticker alone -- observations is guaranteed to exist by this point, see opening comment

  migrateLegacyBucketKeys(db);
}

/**
 * One-time, idempotent upgrade for databases created before the WTI multi-checkpoint
 * refactor (2026-09-04): bucket_key used to be '{series}|{band}' everywhere -- unambiguous
 * back when every series only ever traded at one checkpoint. Now that a series can have
 * buckets at more than one checkpoint (WTI: 3/6/8min), every bucket_key needs the '|cp{N}'
 * suffix so e.g. 'KXWTI15M|0.3-0.4|cp3' and '...|cp8' don't collide. Gold/silver's
 * pre-existing rows only ever used checkpoint 8, so the rename is unambiguous. Safe to call
 * on every startup: only touches rows that don't already have a '|cp' suffix, so it's a
 * no-op once applied. Existing observations rows also get a default checkpoint_minutes=8 from
 * the column default above, which is correct for the same reason.
 */
function migrateLegacyBucketKeys(db) {
  const legacy = db.prepare(`SELECT DISTINCT bucket_key FROM observations WHERE bucket_key NOT LIKE '%|cp%'`).all();
  if (legacy.length === 0) return;

  const renameObs = db.prepare(`UPDATE observations SET bucket_key = ? WHERE bucket_key = ?`);
  const renameTrades = db.prepare(`UPDATE trades SET bucket_key = ? WHERE bucket_key = ?`);
  const renameCalib = db.prepare(`UPDATE live_calibration SET bucket_key = ? WHERE bucket_key = ?`);
  const renameDecay = db.prepare(`UPDATE decay_alerts SET bucket_key = ? WHERE bucket_key = ?`);
  const tx = db.transaction(() => {
    for (const { bucket_key } of legacy) {
      const newKey = `${bucket_key}|cp8`; // every pre-refactor series only ever used checkpoint 8
      renameObs.run(newKey, bucket_key);
      renameTrades.run(newKey, bucket_key);
      renameCalib.run(newKey, bucket_key);
      renameDecay.run(newKey, bucket_key);
    }
  });
  tx();
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, closeDb, DB_FILE };
