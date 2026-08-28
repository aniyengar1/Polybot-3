// Sports orchestrator. New, separate process from the weather bot's orchestrator/main.ts --
// own scan loop, own DB (db.js -> data/sports-bot.db), zero shared runtime state. Same
// architectural pattern: scan -> decide -> execute -> settle, in a loop.
'use strict';

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { scanOnce } = require('./scanner');
const { checkSportsSettlements } = require('./settlementChecker');
const { openPosition, currentMode, getAccountBalance } = require('./execution');
const { checkRisk } = require('./riskManager');
const { computeHoldoutTable, refreshHoldoutTable, startOfUtcWeek } = require('./holdoutTable');
const { refreshRawData } = require('./dataRefresh');

const HOLDOUT_TABLE_PATH = path.join(__dirname, 'data', 'holdoutTable.json');
const HISTORICAL_RECORDS_PATH = path.join(__dirname, '..', 'usSportsLiquidityFiltered_v2.json');
const PAPER_BANKROLL_USD = Number(process.env.SPORTSBOT_PAPER_BANKROLL_USD || 100);
const SCAN_LOOP_INTERVAL_MS = 20 * 60 * 1000; // same cadence as the weather bot

function log(msg, extra) {
  console.log(`[${new Date().toISOString()}] ${msg}`, extra !== undefined ? JSON.stringify(extra) : '');
}

/**
 * Loads the persisted holdout table, refreshing it if the current UTC week has moved past
 * the table's own trading-window start -- the weekly Monday-00:00-UTC recompute cadence
 * from holdoutTable.js, wired into the scan loop instead of requiring a manual step.
 *
 * On a stale week this now actually re-fetches raw data FIRST, via dataRefresh.js's
 * refreshRawData() (the corrected, side-specific fetch logic, confirmed working live against
 * real MLB games in the prior session's production run), and only then recomputes the table
 * from the refreshed on-disk dataset -- not just recomputing from whatever static snapshot
 * happened to already be sitting on disk, which is what this used to do (that gap is why
 * this was flagged after the VM deployment: the wiring was real, but nothing ever put new
 * data behind it).
 */
async function loadOrRefreshHoldoutTable() {
  const now = new Date();
  const currentWeekStart = startOfUtcWeek(now).toISOString();

  let existing = null;
  if (fs.existsSync(HOLDOUT_TABLE_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(HOLDOUT_TABLE_PATH, 'utf8'));
    } catch {
      existing = null;
    }
  }

  const existingWeekStart = existing ? Object.values(existing).find((b) => b.tradingWindowStart)?.tradingWindowStart : null;
  if (existing && existingWeekStart === currentWeekStart) {
    return existing;
  }

  log('holdout table refresh due', { previousWeekStart: existingWeekStart || 'none', currentWeekStart });

  const refreshResult = await refreshRawData({ outputPath: HISTORICAL_RECORDS_PATH, log: (msg) => log(`raw data refresh: ${msg}`) });
  log('raw data refresh complete', { added: refreshResult.added, replaced: refreshResult.replaced, totalRecords: refreshResult.totalRecords });

  const records = JSON.parse(fs.readFileSync(HISTORICAL_RECORDS_PATH, 'utf8'));
  fs.mkdirSync(path.dirname(HOLDOUT_TABLE_PATH), { recursive: true });
  const table = refreshHoldoutTable(records, { now, outputPath: HOLDOUT_TABLE_PATH });
  log('holdout table refreshed', Object.fromEntries(Object.entries(table).map(([k, v]) => [k, { n: v.n, pTrue: v.pTrue }])));
  return table;
}

async function getBankrollUsd(db) {
  if (currentMode() === 'live') {
    try {
      const bal = await getAccountBalance();
      if (bal !== null) return bal;
    } catch (err) {
      log('failed to fetch live balance, falling back to paper accounting', { err: String(err) });
    }
  }
  const resolved = db.prepare(`SELECT COALESCE(SUM(exit_pnl_usd), 0) AS pnl FROM trades WHERE status IN ('won','lost')`).get();
  const outstanding = db.prepare(`SELECT COALESCE(SUM(stake_usd + fee_usd), 0) AS o FROM trades WHERE status = 'pending'`).get();
  return PAPER_BANKROLL_USD + resolved.pnl - outstanding.o;
}

/** Persists a 'trade' decision from the scanner into the trades table, with every field the phase-2 schema defines. */
function recordTrade(db, scanResult, execResult) {
  const { opp, bucketKey, decision } = scanResult;
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO trades (created_at, mode, order_id, event_slug, market_slug, sport, market_type,
      bucket_key, horizon, band, side, entry_price, quantity, stake_usd, fee_usd,
      holdout_n, holdout_p_true, kelly_fraction_raw, effective_cap_pct, opened_at)
    VALUES (@created_at, @mode, @order_id, @event_slug, @market_slug, @sport, @market_type,
      @bucket_key, @horizon, @band, @side, @entry_price, @quantity, @stake_usd, @fee_usd,
      @holdout_n, @holdout_p_true, @kelly_fraction_raw, @effective_cap_pct, @opened_at)
  `);
  const result = insert.run({
    created_at: now,
    mode: execResult.mode,
    order_id: execResult.orderId,
    // Exact strings the scanner captured at decision time -- not reconstructed here.
    event_slug: opp.eventSlug,
    market_slug: opp.marketSlug,
    sport: opp.sport,
    market_type: opp.marketType,
    bucket_key: bucketKey,
    horizon: opp.horizon,
    band: opp.band,
    side: opp.side,
    entry_price: execResult.entryPrice,
    quantity: execResult.quantity,
    stake_usd: decision.stake,
    fee_usd: decision.fee,
    holdout_n: decision.holdoutN,
    holdout_p_true: decision.holdoutPTrue,
    kelly_fraction_raw: decision.kellyFractionRaw,
    effective_cap_pct: decision.effectiveCapPct,
    opened_at: now,
  });
  return result.lastInsertRowid;
}

async function runScanAndExecute(db, holdoutTable, { dryRun }) {
  const bankrollUsd = await getBankrollUsd(db);
  log('scan starting', { mode: currentMode(), dryRun: Boolean(dryRun), bankrollUsd });

  const results = await scanOnce(holdoutTable, bankrollUsd);
  const tradeCandidates = results.filter((r) => r.decision.action === 'trade');
  const skips = results.filter((r) => r.decision.action !== 'trade');

  log('scan complete', { marketsScanned: results.length, tradeCandidates: tradeCandidates.length, skipped: skips.length });

  const opened = [];
  for (const scanResult of tradeCandidates) {
    const { opp, bucketKey, decision } = scanResult;
    const riskCheck = checkRisk({ marketSlug: opp.marketSlug, eventSlug: opp.eventSlug, bucketKey, stake: decision.stake }, bankrollUsd, db);
    if (!riskCheck.allowed) {
      log('trade candidate blocked by risk manager', { marketSlug: opp.marketSlug, reason: riskCheck.reason });
      continue;
    }

    if (dryRun) {
      log('DRY RUN -- would open position (no order placed, no DB write)', {
        marketSlug: opp.marketSlug, eventSlug: opp.eventSlug, bucketKey, side: opp.side,
        price: decision.price, stake: decision.stake.toFixed(2), fee: decision.fee.toFixed(2),
      });
      opened.push({ dryRun: true, scanResult });
      continue;
    }

    // gatewaySide (not opp.side) -- opp.side is the bucket's canonical proposition side
    // (used for holdout-table lookup); gatewaySide is which side of THIS SPECIFIC gateway
    // marketSlug realizes that proposition, which differ for spread's pos-variant markets
    // (see scanner.js's evaluateGatewayMarket). For moneyline they're always identical.
    const execResult = await openPosition({ marketSlug: opp.marketSlug, side: opp.gatewaySide, price: decision.price, stake: decision.stake });
    if (!execResult.ok) {
      log('execution failed, trade not opened', { marketSlug: opp.marketSlug, reason: execResult.reason });
      continue;
    }
    const tradeId = recordTrade(db, scanResult, execResult);
    log('position opened', { tradeId, marketSlug: opp.marketSlug, mode: execResult.mode, entryPrice: execResult.entryPrice, quantity: execResult.quantity });
    opened.push({ tradeId, scanResult, execResult });
  }

  return { results, opened };
}

/**
 * Settlement pass. Consumes checkSportsSettlements()'s output exactly as designed in phase
 * 1: won/lost update the trade and release exposure; void/unresolvable set
 * needs_manual_review=1 and do NOT touch exit_pnl_usd. This function is the thing phase 2
 * flagged as an untested dependency ("this fail-safe specifically depends on whoever
 * consumes the settlement checker's output actually doing this") -- it's the consumer.
 */
async function runSettlement(db) {
  const openRows = db.prepare(`SELECT * FROM trades WHERE status = 'pending'`).all();
  if (openRows.length === 0) {
    log('settlement pass: no open positions');
    return { won: 0, lost: 0, void: 0, unresolvable: 0, pending: 0 };
  }

  const positions = openRows.map((r) => ({ dbId: r.id, eventSlug: r.event_slug, marketSlug: r.market_slug, side: r.side, quantity: r.quantity, stakeUsd: r.stake_usd, feeUsd: r.fee_usd }));
  const settled = await checkSportsSettlements(positions);

  const now = new Date().toISOString();

  for (const item of settled.won.concat(settled.lost)) {
    const pos = item.position;
    const won = item.status === 'won';
    const payout = won ? pos.quantity : 0;
    const exitPnl = payout - pos.stakeUsd - pos.feeUsd;
    db.prepare(`UPDATE trades SET status = ?, resolved_outcome_prices = ?, exit_pnl_usd = ?, resolved_at = ? WHERE id = ?`)
      .run(item.status, JSON.stringify(item.outcomePrices || null), exitPnl, now, pos.dbId);
    log('position settled', { tradeId: pos.dbId, marketSlug: pos.marketSlug, status: item.status, exitPnl: exitPnl.toFixed(2) });
  }

  for (const item of settled.void.concat(settled.unresolvable)) {
    const pos = item.position;
    // Deliberately NOT setting exit_pnl_usd here -- it stays NULL. A void/unresolvable
    // market didn't produce a real win or loss; crediting either would misstate P&L. This
    // trade drops out of "open exposure" (status no longer 'pending') but is flagged for a
    // human to actually look at, not silently marked settled.
    db.prepare(`UPDATE trades SET status = ?, needs_manual_review = 1, resolved_outcome_prices = ?, resolved_at = ? WHERE id = ?`)
      .run(item.status, JSON.stringify(item.outcomePrices || item.reason || null), now, pos.dbId);
    log('position flagged for manual review', { tradeId: pos.dbId, marketSlug: pos.marketSlug, status: item.status, reason: item.reason });
  }

  log('settlement pass complete', { won: settled.won.length, lost: settled.lost.length, void: settled.void.length, unresolvable: settled.unresolvable.length, pending: settled.pending.length });
  return { won: settled.won.length, lost: settled.lost.length, void: settled.void.length, unresolvable: settled.unresolvable.length, pending: settled.pending.length };
}

async function runOnce({ dryRun = false } = {}) {
  const db = getDb();
  const holdoutTable = await loadOrRefreshHoldoutTable();
  const scanAndExecute = await runScanAndExecute(db, holdoutTable, { dryRun });
  const settlement = dryRun ? null : await runSettlement(db);
  return { holdoutTable, ...scanAndExecute, settlement };
}

async function main() {
  log(`starting -- mode=${currentMode()}`);
  const once = process.argv.includes('--once');
  const dryRun = process.argv.includes('--dry-run');
  if (once) {
    await runOnce({ dryRun });
    return;
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOnce({ dryRun }).catch((err) => log('cycle crashed, will retry next interval', { err: String(err) }));
    await new Promise((r) => setTimeout(r, SCAN_LOOP_INTERVAL_MS));
  }
}

module.exports = { runOnce, runScanAndExecute, runSettlement, loadOrRefreshHoldoutTable, getBankrollUsd, recordTrade };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
