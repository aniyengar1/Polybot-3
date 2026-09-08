// kalshi-bot status CLI. Independent implementation, mirrors sports-bot/cli.js's shape
// (same commander-based status/positions/performance commands) but reads this bot's own DB
// and adds a `checkpoint` command for the go-live eligibility gate (see README).
'use strict';

const { Command } = require('commander');
const { getDb } = require('./db');
const { getBankrollUsd } = require('./orchestrator');
const { BUCKET_CONFIG } = require('./buckets');

const GO_LIVE_TRADE_COUNT = 500; // see README for the reasoning behind this number

const program = new Command();
program.name('kalshi-bot').description('Kalshi KXGOLD15M/KXSILVER15M 15-min band strategy -- paper trading status CLI');

program
  .command('status')
  .description('Bot health: bankroll, open exposure, decay + probation-review alerts')
  .action(() => {
    const db = getDb();
    const bankroll = getBankrollUsd(db);
    // log_only rows (none currently -- WTI's 0.6-0.7/cp6 rule traded this way through
    // 2026-09-06, then was promoted to probationary) never staked real bankroll -- see
    // buckets.js/db.js -- so open exposure/position counts here are staked positions only;
    // `node cli.js positions` shows any log-only signals separately, not folded into these.
    const openCount = db.prepare(`SELECT COUNT(*) AS c FROM trades WHERE status = 'pending' AND log_only = 0`).get().c;
    const openExposure = db.prepare(`SELECT COALESCE(SUM(stake_usd),0) AS s FROM trades WHERE status = 'pending' AND log_only = 0`).get().s;
    const openLogOnlyCount = db.prepare(`SELECT COUNT(*) AS c FROM trades WHERE status = 'pending' AND log_only = 1`).get().c;
    const alertCount = db.prepare(`SELECT COUNT(*) AS c FROM decay_alerts`).get().c;
    const probationCount = db.prepare(`SELECT COUNT(*) AS c FROM probation_review_alerts`).get().c;

    if (alertCount > 0) {
      const recent = db.prepare(`SELECT * FROM decay_alerts ORDER BY created_at DESC LIMIT 5`).all();
      console.log('='.repeat(60));
      console.log(`!!! ${alertCount} DECAY ALERT(S) ON RECORD -- run \`node cli.js decay\` !!!`);
      for (const a of recent) console.log(`  [${a.created_at}] ${a.bucket_key}: ${a.reason}`);
      console.log('='.repeat(60));
    }

    if (probationCount > 0) {
      const recent = db.prepare(`SELECT * FROM probation_review_alerts ORDER BY created_at DESC LIMIT 5`).all();
      console.log('='.repeat(60));
      console.log(`!!! ${probationCount} PROBATIONARY BUCKET(S) READY FOR REVIEW -- run \`node cli.js probation\` !!!`);
      for (const a of recent) console.log(`  [${a.created_at}] ${a.bucket_key}: n=${a.n_at_trigger}`);
      console.log('='.repeat(60));
    }

    console.log(`Mode:              PAPER (no live order path exists in this bot)`);
    console.log(`Bankroll:          $${bankroll.toFixed(2)}`);
    console.log(`Open positions:    ${openCount} (staked)${openLogOnlyCount > 0 ? ` + ${openLogOnlyCount} log-only (unstaked, see \`positions\`)` : ''}`);
    console.log(`Open exposure:     $${openExposure.toFixed(2)}`);
  });

function printPositionsTable(rows) {
  console.log('ID   Bucket                    Side  Price   Qty   Stake    Opened               Ticker');
  for (const r of rows) {
    console.log(
      [
        String(r.id).padEnd(4),
        r.bucket_key.padEnd(25),
        r.side.padEnd(5),
        `$${r.market_price.toFixed(2)}`.padEnd(7),
        String(r.contracts).padEnd(5),
        `$${r.stake_usd.toFixed(2)}`.padEnd(8),
        r.opened_at.padEnd(20),
        r.ticker,
      ].join(' ')
    );
  }
}

program
  .command('positions')
  .description('List open (pending) positions -- staked and log-only, shown separately')
  .action(() => {
    const db = getDb();
    const staked = db.prepare(`SELECT id, bucket_key, side, market_price, contracts, stake_usd, opened_at, ticker FROM trades WHERE status = 'pending' AND log_only = 0 ORDER BY opened_at DESC`).all();
    const logOnly = db.prepare(`SELECT id, bucket_key, side, market_price, contracts, stake_usd, opened_at, ticker FROM trades WHERE status = 'pending' AND log_only = 1 ORDER BY opened_at DESC`).all();

    if (staked.length === 0) {
      console.log('No open (staked) positions.');
    } else {
      printPositionsTable(staked);
    }

    if (logOnly.length > 0) {
      console.log(`\nLOG-ONLY signals (would-be size shown, NOT staked -- see buckets.js):`);
      printPositionsTable(logOnly);
    }
  });

program
  .command('performance')
  .description('Closed-trade performance, overall and by bucket -- staked and log-only reported separately')
  .action(() => {
    const db = getDb();
    const allRows = db.prepare(`SELECT bucket_key, exit_pnl_usd, status, log_only FROM trades WHERE status IN ('won','lost')`).all();
    const rows = allRows.filter((r) => r.log_only === 0);
    const logOnlyRows = allRows.filter((r) => r.log_only === 1);

    if (rows.length === 0) {
      console.log('No settled staked trades yet.');
    } else {
      const wins = rows.filter((r) => r.status === 'won').length;
      const totalPnl = rows.reduce((s, r) => s + r.exit_pnl_usd, 0);
      console.log(`Settled staked trades: ${rows.length}`);
      console.log(`Win rate:              ${((wins / rows.length) * 100).toFixed(1)}%`);
      console.log(`Total P&L:             $${totalPnl.toFixed(2)}`);
    }

    console.log('\nBy bucket (live vs backtested baseline):');
    for (const [bucketKey, config] of Object.entries(BUCKET_CONFIG)) {
      const b = rows.filter((r) => r.bucket_key === bucketKey);
      const tag = config.logOnly ? ' [LOG-ONLY, not staked]' : config.status === 'probationary' ? ' [PROBATIONARY]' : '';
      if (b.length === 0) {
        console.log(`  ${config.label}${tag}: no settled ${config.logOnly ? 'signals' : 'trades'} yet (backtested baseline: ${(config.backtestBaseline.winRate * 100).toFixed(1)}% win rate, $${config.backtestBaseline.pnlPerTrade.toFixed(3)}/trade)`);
        continue;
      }
      const bw = b.filter((r) => r.status === 'won').length;
      const bp = b.reduce((s, r) => s + r.exit_pnl_usd, 0);
      console.log(`  ${config.label}${tag}: ${b.length} trades, ${((bw / b.length) * 100).toFixed(1)}% win rate, $${bp.toFixed(2)} P&L  (baseline: ${(config.backtestBaseline.winRate * 100).toFixed(1)}%, $${config.backtestBaseline.pnlPerTrade.toFixed(3)}/trade)`);
    }

    if (logOnlyRows.length > 0) {
      const lw = logOnlyRows.filter((r) => r.status === 'won').length;
      const lp = logOnlyRows.reduce((s, r) => s + r.exit_pnl_usd, 0);
      console.log(`\nLOG-ONLY overall (would-be P&L, never actually staked): ${logOnlyRows.length} signals, ${((lw / logOnlyRows.length) * 100).toFixed(1)}% win rate, $${lp.toFixed(2)} would-be P&L`);
    }
  });

program
  .command('decay')
  .description('Full decay-alert history')
  .action(() => {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM decay_alerts ORDER BY created_at DESC`).all();
    if (rows.length === 0) {
      console.log('No decay alerts on record.');
      return;
    }
    for (const a of rows) {
      console.log(`[${a.created_at}] ${a.bucket_key}`);
      console.log(`  ${a.reason}`);
      console.log(`  rolling: n=${a.rolling_n} winRate=${(a.rolling_win_rate * 100).toFixed(1)}% pnl=$${a.rolling_pnl_usd.toFixed(2)} | baseline winRate=${(a.baseline_win_rate * 100).toFixed(1)}%`);
    }
  });

program
  .command('probation')
  .description('Probationary buckets (unconfirmed-on-live-data rules): status and review-ready alerts')
  .action(() => {
    const db = getDb();
    const probationaryEntries = Object.entries(BUCKET_CONFIG).filter(([, c]) => c.status === 'probationary');
    if (probationaryEntries.length === 0) {
      console.log('No probationary buckets configured.');
      return;
    }
    console.log(`${probationaryEntries.length} probationary bucket(s) -- see buckets.js header for provenance:\n`);
    for (const [bucketKey, config] of probationaryEntries) {
      const settled = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE bucket_key = ? AND status IN ('won','lost')`).get(bucketKey);
      const reviewAlert = db.prepare(`SELECT * FROM probation_review_alerts WHERE bucket_key = ?`).get(bucketKey);
      const winRate = settled.c > 0 ? ((settled.w / settled.c) * 100).toFixed(1) + '%' : '—';
      const pnl = settled.c > 0 ? `$${settled.pnl.toFixed(2)}` : '—';
      console.log(`  ${config.label}: n=${settled.c}, win rate ${winRate}, P&L ${pnl}  (baseline: ${(config.backtestBaseline.winRate * 100).toFixed(1)}%, $${config.backtestBaseline.pnlPerTrade.toFixed(3)}/trade)`);
      if (reviewAlert) {
        console.log(`    >>> READY FOR REVIEW since ${reviewAlert.created_at} (triggered at n=${reviewAlert.n_at_trigger}) <<<`);
      } else {
        console.log(`    ${settled.c}/30 toward review trigger`);
      }
    }
  });

program
  .command('checkpoint')
  .description(`Go-live eligibility gate: reports progress toward ${GO_LIVE_TRADE_COUNT} staked paper trades (log-only signals don't count)`)
  .action(() => {
    const db = getDb();
    const settled = db.prepare(`SELECT COUNT(*) AS c FROM trades WHERE status IN ('won','lost') AND log_only = 0`).get().c;
    const pending = db.prepare(`SELECT COUNT(*) AS c FROM trades WHERE status = 'pending' AND log_only = 0`).get().c;
    const total = settled + pending;
    const pct = ((total / GO_LIVE_TRADE_COUNT) * 100).toFixed(1);
    console.log(`Trades so far: ${total} / ${GO_LIVE_TRADE_COUNT} (${pct}%)`);
    console.log(`  settled: ${settled}, pending: ${pending}`);
    if (total >= GO_LIVE_TRADE_COUNT) {
      console.log('\nCheckpoint reached -- eligible for a go-live discussion.');
      console.log('This is a volume gate only, NOT a performance gate: reaching it means there is');
      console.log('enough paper history to have that conversation, not that the numbers necessarily');
      console.log('support it. Check `performance` and `decay` before that conversation, not just this count.');
    } else {
      console.log(`\n${GO_LIVE_TRADE_COUNT - total} trades remaining (~${Math.ceil((GO_LIVE_TRADE_COUNT - total) / 15.7)} days at the backtested ~15.7/day pace).`);
    }
  });

program
  .command('shadow')
  .description('Shadow execution simulation: passive-limit-vs-taker fill comparison against real recorded trades (see shadowExecution.js)')
  .action(() => {
    const db = getDb();
    const rows = db
      .prepare(`
        SELECT s.*, t.exit_pnl_usd AS real_exit_pnl
        FROM shadow_execution_trials s
        LEFT JOIN trades t ON t.id = s.real_trade_id
        WHERE s.status IN ('won','lost')
      `)
      .all();

    if (rows.length === 0) {
      console.log('No settled shadow trials yet.');
      return;
    }

    const maker = rows.filter((r) => r.fill_type === 'maker').length;
    const taker = rows.filter((r) => r.fill_type === 'taker').length;
    const avgSecondsToFill = rows.reduce((s, r) => s + r.seconds_to_fill, 0) / rows.length;
    const shadowPnl = rows.reduce((s, r) => s + r.exit_pnl_usd, 0);
    const realPnl = rows.reduce((s, r) => s + (r.real_exit_pnl || 0), 0);

    console.log(`Settled shadow trials: ${rows.length}  (maker: ${maker}, taker/timeout: ${taker})`);
    console.log(`Average seconds-to-fill: ${avgSecondsToFill.toFixed(1)}s`);
    console.log(`Shadow simulated P&L (same signals): $${shadowPnl.toFixed(2)}`);
    console.log(`Real recorded P&L (same signals):    $${realPnl.toFixed(2)}`);
    console.log(`Difference (shadow - real):          $${(shadowPnl - realPnl).toFixed(2)}`);
    console.log('\nNote: maker fills are taxed at this bot\'s real TAKER fee formula (no confirmed');
    console.log('Kalshi maker-fee schedule exists anywhere in this project) -- shadow maker P&L');
    console.log('above likely understates the real number if Kalshi\'s actual maker fee is lower.');

    console.log('\nBy bucket:');
    const byBucket = new Map();
    for (const r of rows) {
      if (!byBucket.has(r.bucket_key)) byBucket.set(r.bucket_key, []);
      byBucket.get(r.bucket_key).push(r);
    }
    for (const [bucketKey, brows] of byBucket) {
      const bMaker = brows.filter((r) => r.fill_type === 'maker').length;
      const bTaker = brows.filter((r) => r.fill_type === 'taker').length;
      const bAvgSec = brows.reduce((s, r) => s + r.seconds_to_fill, 0) / brows.length;
      const bShadowPnl = brows.reduce((s, r) => s + r.exit_pnl_usd, 0);
      const bRealPnl = brows.reduce((s, r) => s + (r.real_exit_pnl || 0), 0);
      const tooEarly = brows.length < 15 ? '  [n<15, too early to conclude from]' : '';
      console.log(
        `  ${bucketKey}: n=${brows.length}${tooEarly} maker=${bMaker} taker=${bTaker} ` +
        `avgFillSec=${bAvgSec.toFixed(1)} shadowPnl=$${bShadowPnl.toFixed(2)} realPnl=$${bRealPnl.toFixed(2)}`
      );
    }
  });

program.parseAsync(process.argv);
