// Settlement polling. Independent implementation -- Kalshi resolves a market by setting
// `result: "yes"|"no"` on GET /markets/{ticker} (confirmed via the real historical fetch
// script's check, m.result === 'yes' || 'no', and live market snapshots showing result: ""
// pre-resolution). No separate oracle needed, same shape as sports-bot's
// settlementChecker.js polling gateway.polymarket.us's market status -- independently
// reimplemented for Kalshi's own field names, not shared code.
//
// Settles ALL unresolved observations (every band, not just the 3 traded buckets) -- the
// walk-forward calibration fold (calibration.js) needs every band's real outcome, not just
// the traded ones, exactly mirroring the backtest's own full-observation-stream fold.
'use strict';

const { getDb } = require('./db');
const { getMarket } = require('./kalshiClient');

async function settlePendingObservations(log = () => {}) {
  const db = getDb();
  const nowTs = Math.floor(Date.now() / 1000);
  // Only bother polling observations whose market has actually closed -- polling a still-open
  // 15-min market for a result is a wasted call, it can't have resolved yet.
  const pending = db.prepare(`SELECT id, ticker, close_ts FROM observations WHERE resolved = 0 AND close_ts < ?`).all(nowTs);
  if (pending.length === 0) return { checked: 0, resolved: 0 };

  let resolvedCount = 0;
  for (const obs of pending) {
    let market;
    try {
      market = await getMarket(obs.ticker);
    } catch (err) {
      log('settlement fetch failed, will retry next cycle', { ticker: obs.ticker, err: String(err) });
      continue;
    }
    if (!market || (market.result !== 'yes' && market.result !== 'no')) continue; // not resolved yet

    const yesResolvedTo = market.result === 'yes' ? 1 : 0;
    db.prepare(`UPDATE observations SET resolved = 1, yes_resolved_to = ? WHERE id = ?`).run(yesResolvedTo, obs.id);
    resolvedCount += 1;
  }

  return { checked: pending.length, resolved: resolvedCount };
}

/** Settles trades whose underlying observation is now resolved. Run AFTER settlePendingObservations in the same cycle. */
function settlePendingTrades(log = () => {}) {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT t.id AS trade_id, t.side, t.contracts, t.stake_usd, o.yes_resolved_to
      FROM trades t JOIN observations o ON o.id = t.observation_id
      WHERE t.status = 'pending' AND o.resolved = 1
    `)
    .all();

  const now = new Date().toISOString();
  let settledCount = 0;
  for (const r of rows) {
    const won = r.side === 'yes' ? r.yes_resolved_to === 1 : r.yes_resolved_to === 0;
    const payout = won ? r.contracts : 0; // $1/contract on the winning side, $0 on the losing side
    const exitPnl = payout - r.stake_usd;
    db.prepare(`UPDATE trades SET status = ?, exit_pnl_usd = ?, resolved_at = ? WHERE id = ?`)
      .run(won ? 'won' : 'lost', exitPnl, now, r.trade_id);
    settledCount += 1;
    log('trade settled', { tradeId: r.trade_id, status: won ? 'won' : 'lost', exitPnl: exitPnl.toFixed(4) });
  }
  return { settled: settledCount };
}

module.exports = { settlePendingObservations, settlePendingTrades };
