// Sports-specific equivalent of polybot-v2/src/cli.ts, reading from this project's own DB.
'use strict';

const { Command } = require('commander');
const { getDb } = require('./db');
const { getPortfolioState, getTodayRealizedPnl } = require('./riskManager');
const { currentMode } = require('./execution');
const { getBankrollUsd } = require('./orchestrator');

const program = new Command();
program.name('sports-bot').description('Sports-bot status CLI -- Polymarket US NBA/NHL/MLB moneyline trading bot');

program
  .command('status')
  .description("Bot health: mode, bankroll, open exposure, today's P&L")
  .action(async () => {
    const db = getDb();
    const mode = currentMode();
    const bankroll = await getBankrollUsd(db);
    const portfolio = getPortfolioState(db);
    const todayPnl = getTodayRealizedPnl(db);
    const reviewCount = db.prepare(`SELECT COUNT(*) AS c FROM trades WHERE needs_manual_review = 1`).get().c;

    console.log(`Mode:              ${mode.toUpperCase()}${mode === 'paper' ? ' (SPORTSBOT_CONFIRM_LIVE not set to "yes")' : ''}`);
    console.log(`Bankroll:          $${bankroll.toFixed(2)}`);
    console.log(`Open positions:    ${portfolio.openCount}`);
    console.log(`Open exposure:     $${portfolio.totalExposureUsd.toFixed(2)}`);
    console.log(`Today's P&L:       $${todayPnl.toFixed(2)}`);
    console.log(`Needs manual review: ${reviewCount}${reviewCount > 0 ? '  <-- run `sports-bot review`' : ''}`);
    console.log('Exposure by bucket:');
    for (const [bucket, usd] of Object.entries(portfolio.bucketExposureUsd)) {
      console.log(`  ${bucket}: $${usd.toFixed(2)}`);
    }
  });

program
  .command('positions')
  .description('List open (pending) positions')
  .action(() => {
    const db = getDb();
    const rows = db
      .prepare(`SELECT id, sport, market_type, bucket_key, side, entry_price, quantity, stake_usd, opened_at, market_slug FROM trades WHERE status = 'pending' ORDER BY opened_at DESC`)
      .all();
    if (rows.length === 0) {
      console.log('No open positions.');
      return;
    }
    console.log('ID   Bucket                          Side  Entry   Qty      Stake    Opened               Market');
    for (const r of rows) {
      console.log(
        [
          String(r.id).padEnd(4),
          r.bucket_key.padEnd(31),
          r.side.padEnd(5),
          `$${r.entry_price.toFixed(2)}`.padEnd(7),
          String(r.quantity).padEnd(8),
          `$${r.stake_usd.toFixed(2)}`.padEnd(8),
          r.opened_at.padEnd(20),
          r.market_slug,
        ].join(' ')
      );
    }
  });

program
  .command('review')
  .description('Positions flagged needs_manual_review=1 (void/unresolvable settlements -- never auto-credited a win or loss)')
  .action(() => {
    const db = getDb();
    const rows = db
      .prepare(`SELECT id, market_slug, event_slug, status, stake_usd, resolved_outcome_prices, resolved_at FROM trades WHERE needs_manual_review = 1 ORDER BY resolved_at DESC`)
      .all();
    if (rows.length === 0) {
      console.log('Nothing needs manual review.');
      return;
    }
    console.log(`${rows.length} position(s) need manual review (P&L was NOT auto-credited for these):\n`);
    for (const r of rows) {
      console.log(`  #${r.id} ${r.market_slug} -- status=${r.status}, stake=$${r.stake_usd.toFixed(2)}, resolved_at=${r.resolved_at}`);
      console.log(`     event=${r.event_slug}, raw resolution data=${r.resolved_outcome_prices}`);
    }
  });

program
  .command('performance')
  .description('Recent closed-trade performance summary')
  .option('-d, --days <n>', 'lookback window in days', '30')
  .action((opts) => {
    const db = getDb();
    const since = new Date(Date.now() - Number(opts.days) * 86400000).toISOString();
    const rows = db
      .prepare(`SELECT bucket_key, exit_pnl_usd, status FROM trades WHERE status IN ('won','lost') AND resolved_at >= ?`)
      .all(since);

    if (rows.length === 0) {
      console.log(`No settled trades (won/lost) in the last ${opts.days} days.`);
      return;
    }

    const wins = rows.filter((r) => r.status === 'won').length;
    const totalPnl = rows.reduce((s, r) => s + r.exit_pnl_usd, 0);
    console.log(`Settled trades (last ${opts.days}d): ${rows.length}`);
    console.log(`Win rate:          ${((wins / rows.length) * 100).toFixed(1)}%`);
    console.log(`Total P&L:         $${totalPnl.toFixed(2)}`);
    console.log(`Avg P&L/trade:     $${(totalPnl / rows.length).toFixed(2)}`);

    const byBucket = new Map();
    for (const r of rows) {
      const s = byBucket.get(r.bucket_key) || { n: 0, wins: 0, pnl: 0 };
      s.n++;
      if (r.status === 'won') s.wins++;
      s.pnl += r.exit_pnl_usd;
      byBucket.set(r.bucket_key, s);
    }
    console.log('\nBy bucket:');
    for (const [bucket, s] of byBucket) {
      console.log(`  ${bucket}: ${s.n} trades, ${((s.wins / s.n) * 100).toFixed(1)}% win rate, $${s.pnl.toFixed(2)} P&L`);
    }
  });

program.parseAsync(process.argv);
