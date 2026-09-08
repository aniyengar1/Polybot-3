// Read-only JSON stats API for the monitoring dashboard. Deliberately its own systemd service,
// separate from orchestrator.js -- a bug or restart in the stats HTTP layer should never be
// able to touch the trading process, and vice versa. Only ever reads this bot's own db.js /
// buckets.js; never opens a network listener beyond localhost (see kalshi-bot.service's
// dashboard counterpart on this same VM, which is the only intended caller -- this port is not
// meant to be reachable from outside this machine).
'use strict';

const http = require('http');
const { execFile } = require('child_process');
const { getDb } = require('./db');
const { BUCKET_CONFIG, MIN_CALIBRATION_N, isAllowedBucket } = require('./buckets');

const PORT = Number(process.env.KALSHIBOT_STATS_PORT || 7001);
const HOST = process.env.KALSHIBOT_STATS_HOST || '127.0.0.1';
const STARTING_BANKROLL = Number(process.env.KALSHIBOT_PAPER_BANKROLL_USD || 200);
const GO_LIVE_TRADE_COUNT = 500; // matches cli.js's own GO_LIVE_TRADE_COUNT

function isServiceActive(unitName) {
  return new Promise((resolve) => {
    execFile('systemctl', ['is-active', unitName], (err, stdout) => {
      resolve((stdout || '').trim() === 'active');
    });
  });
}

function mapTradeRow(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    series: r.series,
    ticker: r.ticker,
    bucketKey: r.bucket_key,
    side: r.side,
    price: r.market_price,
    contracts: r.contracts,
    stakeUsd: r.stake_usd,
    status: r.status,
    exitPnl: r.exit_pnl_usd,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    logOnly: Boolean(r.log_only),
  };
}

/**
 * One row per UTC calendar day since the first real (log_only=0) stake, most-recent-first.
 * Past days replay purely from resolved exit_pnl_usd (exact, no look-ahead concerns since
 * they're fully closed); today's end-bankroll uses the live bankrollUsd (already computed by
 * the caller) so it also reflects any currently-pending stake, matching the top-level
 * Bankroll KPI rather than silently disagreeing with it until today's trades settle.
 */
function buildDailyReturns(db, bankrollUsd) {
  const first = db.prepare(`SELECT MIN(opened_at) AS d FROM trades WHERE log_only = 0`).get();
  if (!first.d) return [];
  const firstDate = first.d.slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);

  const resolvedRows = db
    .prepare(`SELECT resolved_at, exit_pnl_usd FROM trades WHERE status IN ('won','lost') AND log_only = 0 ORDER BY resolved_at ASC`)
    .all();

  const days = [];
  let running = STARTING_BANKROLL;
  let idx = 0;
  let d = firstDate;
  while (d <= todayDate) {
    const startBankroll = running;
    let trades = 0;
    while (idx < resolvedRows.length && resolvedRows[idx].resolved_at.slice(0, 10) === d) {
      running += resolvedRows[idx].exit_pnl_usd;
      trades += 1;
      idx += 1;
    }
    const endBankroll = d === todayDate ? bankrollUsd : running;
    // Round to cents before computing returnPct, not after -- start/end bankroll are computed
    // via different code paths (incremental JS sum here vs. a separate SQL aggregate for
    // today's live bankrollUsd), so raw unrounded values can differ by float-noise epsilons on
    // a zero-trade day; rounding first keeps returnPct consistent with the displayed figures
    // (exactly 0 when displayed start === displayed end) instead of showing e.g. "-0.00%".
    const startRounded = Math.round(startBankroll * 100) / 100;
    const endRounded = Math.round(endBankroll * 100) / 100;
    days.push({
      date: d,
      startBankroll: startRounded,
      endBankroll: endRounded,
      trades,
      returnPct: startRounded !== 0 ? (endRounded - startRounded) / startRounded : null,
    });
    const next = new Date(d + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    d = next.toISOString().slice(0, 10);
  }
  return days.reverse();
}

function buildEquityCurve(db) {
  const rows = db
    .prepare(`SELECT resolved_at, exit_pnl_usd FROM trades WHERE status IN ('won','lost') AND log_only = 0 ORDER BY resolved_at ASC`)
    .all();
  let running = STARTING_BANKROLL;
  const curve = [{ at: null, bankroll: STARTING_BANKROLL }];
  for (const r of rows) {
    running += r.exit_pnl_usd;
    curve.push({ at: r.resolved_at, bankroll: Math.round(running * 100) / 100 });
  }
  return curve;
}

function getStats() {
  const db = getDb();

  const bankrollRow = db.prepare(`SELECT COALESCE(SUM(exit_pnl_usd), 0) AS pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0`).get();
  const outstandingRow = db.prepare(`SELECT COALESCE(SUM(stake_usd), 0) AS o FROM trades WHERE status = 'pending' AND log_only = 0`).get();
  const bankrollUsd = STARTING_BANKROLL + bankrollRow.pnl - outstandingRow.o;

  const settled = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0`).get();
  const openCount = db.prepare(`SELECT COUNT(*) c FROM trades WHERE status = 'pending' AND log_only = 0`).get().c;
  const openExposure = db.prepare(`SELECT COALESCE(SUM(stake_usd), 0) s FROM trades WHERE status = 'pending' AND log_only = 0`).get().s;
  const pendingForGate = db.prepare(`SELECT COUNT(*) c FROM trades WHERE status = 'pending' AND log_only = 0`).get().c;

  const bySeriesRows = db
    .prepare(`SELECT series, COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0 GROUP BY series`)
    .all();
  const bySeries = bySeriesRows.map((r) => ({
    series: r.series,
    trades: r.c,
    winRate: r.c > 0 ? r.w / r.c : null,
    pnl: r.pnl,
  }));

  const byBucketRows = db
    .prepare(`SELECT bucket_key, log_only, COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE status IN ('won','lost') GROUP BY bucket_key, log_only`)
    .all();
  const byBucket = Object.entries(BUCKET_CONFIG).map(([bucketKey, config]) => {
    const row = byBucketRows.find((r) => r.bucket_key === bucketKey && r.log_only === (config.logOnly ? 1 : 0));
    return {
      bucketKey,
      label: config.label,
      series: config.series,
      band: config.band,
      checkpointMinutes: config.checkpointMinutes,
      logOnly: Boolean(config.logOnly),
      status: config.status || 'validated',
      trades: row ? row.c : 0,
      winRate: row && row.c > 0 ? row.w / row.c : null,
      pnl: row ? row.pnl : 0,
      baselineWinRate: config.backtestBaseline.winRate,
      baselinePnlPerTrade: config.backtestBaseline.pnlPerTrade,
    };
  });

  const logOnlyAgg = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE status IN ('won','lost') AND log_only = 1`).get();
  // Probationary trades ARE real staked money (unlike log_only) and ARE already included in the
  // `totals` above -- this is just a separate slice for visibility, same idea as bySeries.
  const probationaryAgg = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0 AND bucket_status = 'probationary'`).get();
  const probationReviewAlerts = db.prepare(`SELECT * FROM probation_review_alerts ORDER BY created_at DESC`).all();

  const recentTrades = db
    .prepare(`
      SELECT id, created_at, series, ticker, bucket_key, side, market_price, contracts, stake_usd, status, exit_pnl_usd, opened_at, resolved_at, log_only
      FROM trades ORDER BY id DESC LIMIT 50
    `)
    .all()
    .map(mapTradeRow);

  const decayAlerts = db.prepare(`SELECT * FROM decay_alerts ORDER BY created_at DESC`).all();

  const lastObs = db.prepare(`SELECT MAX(created_at) t FROM observations`).get().t;

  const dailyReturns = buildDailyReturns(db, bankrollUsd);

  return {
    bot: 'kalshi-bot',
    lastActivityAt: lastObs,
    bankrollUsd: Math.round(bankrollUsd * 100) / 100,
    startingBankrollUsd: STARTING_BANKROLL,
    equityCurve: buildEquityCurve(db),
    dailyReturns,
    todaysReturn: dailyReturns.length > 0 ? dailyReturns[0].returnPct : null,
    goLiveGate: { target: GO_LIVE_TRADE_COUNT, current: settled.c + pendingForGate, label: `${GO_LIVE_TRADE_COUNT} staked paper trades` },
    totals: {
      trades: settled.c,
      winRate: settled.c > 0 ? settled.w / settled.c : null,
      totalPnl: settled.pnl || 0,
      openPositions: openCount,
      openExposureUsd: openExposure,
    },
    bySeries,
    byBucket,
    logOnly: { signals: logOnlyAgg.c, winRate: logOnlyAgg.c > 0 ? logOnlyAgg.w / logOnlyAgg.c : null, pnl: logOnlyAgg.pnl || 0 },
    probationary: {
      trades: probationaryAgg.c,
      winRate: probationaryAgg.c > 0 ? probationaryAgg.w / probationaryAgg.c : null,
      pnl: probationaryAgg.pnl || 0,
      note: 'Included in totals above (real staked trades) -- shown separately for visibility only.',
    },
    recentTrades,
    decayAlerts,
    probationReviewAlerts,
    minCalibrationN: MIN_CALIBRATION_N,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/stats' && req.method === 'GET') {
    try {
      const stats = getStats();
      stats.serviceActive = await isServiceActive('kalshi-bot');
      stats.generatedAt = new Date().toISOString();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // Full trade history for one bucket -- for the dashboard's per-bucket drill-down (see
  // dashboardServer.js's /api/kalshi/bucket-trades proxy). Deliberately no LIMIT and no status
  // filter, unlike /stats's recentTrades: the whole point is auditing a bucket's complete
  // record, not a recent-N slice.
  if (req.url.startsWith('/bucket-trades') && req.method === 'GET') {
    try {
      const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
      const bucketKey = parsed.searchParams.get('bucketKey');
      if (!bucketKey || !isAllowedBucket(bucketKey)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown or missing bucketKey' }));
        return;
      }
      const db = getDb();
      const trades = db
        .prepare(`
          SELECT id, created_at, series, ticker, bucket_key, side, market_price, contracts, stake_usd, status, exit_pnl_usd, opened_at, resolved_at, log_only
          FROM trades WHERE bucket_key = ? ORDER BY id DESC
        `)
        .all(bucketKey)
        .map(mapTradeRow);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bucketKey, trades }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] kalshi-bot stats server listening on ${HOST}:${PORT}`);
});
