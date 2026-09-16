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
// Live track's "starting bankroll" reference point -- NOT auto-derived from a live Kalshi balance
// call (nothing in this codebase re-fetches the real account balance for display purposes; see
// this session's one-off signed GET /portfolio/balance script for that). This is the confirmed
// exchange_index:2 balance ($199.98) as of 2026-09-11 -- the shard the 4 live-eligible series
// actually trade on, confirmed via that real signed balance call -- a FIXED reference point, not
// a live figure. It will NOT automatically track future deposits/withdrawals/transfers; update
// KALSHIBOT_LIVE_STARTING_BANKROLL_USD by hand (and restart kalshi-bot-stats.service) if the real
// funded balance changes meaningfully, same as KALSHIBOT_PAPER_BANKROLL_USD would need updating.
// Purely a display constant for this dashboard -- liveCapitalAtRisk.js's $50 cap (task #17) sums
// stake_usd directly and never reads this value, so changing it cannot affect what the cap
// enforces, only what the live card's Bankroll/equity-curve tiles display as their zero point.
const LIVE_STARTING_BANKROLL = Number(process.env.KALSHIBOT_LIVE_STARTING_BANKROLL_USD || 199.98);
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
    // trades.mode has existed since this table's original schema, default 'paper'. isLive
    // surfaces it to the dashboard; execution_env (added 2026-09-09, see liveExecution.js)
    // distinguishes a demo test of the real order-placement code from genuine production --
    // NULL for every paper row. Both fields depend on their SELECT statements actually
    // including `mode`/`execution_env` in the column list -- see the fix note below.
    isLive: r.mode === 'live',
    executionEnv: r.execution_env,
  };
}

/**
 * One row per UTC calendar day since the first real (log_only=0) stake for this mode,
 * most-recent-first. Past days replay purely from resolved exit_pnl_usd (exact, no look-ahead
 * concerns since they're fully closed); today's end-bankroll uses the already-computed bankrollUsd
 * so it also reflects any currently-pending stake, matching the top-level Bankroll KPI rather than
 * silently disagreeing with it until today's trades settle.
 *
 * Parameterized by mode/startingBankrollUsd (task: live dashboard tab, 2026-09-11) so the exact
 * same replay logic serves both the paper track (mode='paper', STARTING_BANKROLL) and the live
 * track (mode='live', LIVE_STARTING_BANKROLL) -- same query pattern, same shape, just bound to a
 * different mode and zero point, not new logic.
 */
function buildDailyReturns(db, bankrollUsd, mode, startingBankrollUsd) {
  const first = db.prepare(`SELECT MIN(opened_at) AS d FROM trades WHERE log_only = 0 AND mode = ?`).get(mode);
  if (!first.d) return [];
  const firstDate = first.d.slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);

  const resolvedRows = db
    .prepare(`SELECT resolved_at, exit_pnl_usd FROM trades WHERE status IN ('won','lost') AND log_only = 0 AND mode = ? ORDER BY resolved_at ASC`)
    .all(mode);

  const days = [];
  let running = startingBankrollUsd;
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

// Parameterized the same way as buildDailyReturns above, same reasoning.
function buildEquityCurve(db, mode, startingBankrollUsd) {
  const rows = db
    .prepare(`SELECT resolved_at, exit_pnl_usd FROM trades WHERE status IN ('won','lost') AND log_only = 0 AND mode = ? ORDER BY resolved_at ASC`)
    .all(mode);
  let running = startingBankrollUsd;
  const curve = [{ at: null, bankroll: startingBankrollUsd }];
  for (const r of rows) {
    running += r.exit_pnl_usd;
    curve.push({ at: r.resolved_at, bankroll: Math.round(running * 100) / 100 });
  }
  return curve;
}

/**
 * Builds the full stats shape for ONE mode ('paper' or 'live') -- bankroll, totals, bySeries,
 * byBucket, logOnly/probationary breakdowns, equity curve, daily returns, and a MODE-FILTERED
 * recentTrades (task: live dashboard tab, 2026-09-11). Every query here is the exact same pattern
 * getStats() used inline before this refactor, just bound to `mode` instead of the literal
 * 'paper' -- extracted so both tracks reuse identical logic rather than duplicating it.
 *
 * recentTrades here is filtered to this mode (unlike the paper card's pre-existing, deliberately
 * UNCHANGED /bucket-trades drill-down, which stays unfiltered -- see that route below). For the
 * paper mode, this means a live/demo-test row can no longer appear in the top-level Recent Trades
 * tab (it used to, blended in with a LIVE/DEMO TEST badge) -- it will only ever appear on the new
 * live card's own Recent Trades tab now, or in a bucket's drill-down modal (still unfiltered).
 */
function buildModeStats(db, mode, startingBankrollUsd) {
  const bankrollRow = db.prepare(`SELECT COALESCE(SUM(exit_pnl_usd), 0) AS pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0 AND mode = ?`).get(mode);
  const outstandingRow = db.prepare(`SELECT COALESCE(SUM(stake_usd), 0) AS o FROM trades WHERE status = 'pending' AND log_only = 0 AND mode = ?`).get(mode);
  const bankrollUsd = startingBankrollUsd + bankrollRow.pnl - outstandingRow.o;

  const settled = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0 AND mode = ?`).get(mode);
  const openCount = db.prepare(`SELECT COUNT(*) c FROM trades WHERE status = 'pending' AND log_only = 0 AND mode = ?`).get(mode).c;
  const openExposure = db.prepare(`SELECT COALESCE(SUM(stake_usd), 0) s FROM trades WHERE status = 'pending' AND log_only = 0 AND mode = ?`).get(mode).s;

  const bySeriesRows = db
    .prepare(`SELECT series, COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0 AND mode = ? GROUP BY series`)
    .all(mode);
  const bySeries = bySeriesRows.map((r) => ({
    series: r.series,
    trades: r.c,
    winRate: r.c > 0 ? r.w / r.c : null,
    pnl: r.pnl,
  }));

  const byBucketRows = db
    .prepare(`SELECT bucket_key, log_only, COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE status IN ('won','lost') AND mode = ? GROUP BY bucket_key, log_only`)
    .all(mode);
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

  const logOnlyAgg = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE status IN ('won','lost') AND log_only = 1 AND mode = ?`).get(mode);
  // Probationary trades ARE real staked money (unlike log_only) and ARE already included in the
  // `totals` above -- this is just a separate slice for visibility, same idea as bySeries.
  const probationaryAgg = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) w, SUM(exit_pnl_usd) pnl FROM trades WHERE status IN ('won','lost') AND log_only = 0 AND mode = ? AND bucket_status = 'probationary'`).get(mode);

  const recentTrades = db
    .prepare(`
      SELECT id, created_at, mode, execution_env, series, ticker, bucket_key, side, market_price, contracts, stake_usd, status, exit_pnl_usd, opened_at, resolved_at, log_only
      FROM trades WHERE mode = ? ORDER BY id DESC LIMIT 50
    `)
    .all(mode)
    .map(mapTradeRow);

  const dailyReturns = buildDailyReturns(db, bankrollUsd, mode, startingBankrollUsd);

  // Since Inception (2026-09-11) -- deliberately NOT part of buildDailyReturns/buildEquityCurve's
  // day-chaining loop above (that loop's own "today vs. yesterday's close" semantics stay exactly
  // as they are -- explicit instruction, not touched by this addition). A second, always-present
  // metric so "how did today go" and "how has this track done overall" are never ambiguous, which
  // matters most for a track with only a couple days of history where the two can diverge sharply
  // (see the live track's own todaysReturn investigation, same date: a good day 1 followed by a
  // rough day 2 made todaysReturn look far worse than the track's real since-inception position).
  const totalPnlRounded = Math.round((settled.pnl || 0) * 100) / 100;
  const sinceInceptionReturn = startingBankrollUsd !== 0 ? totalPnlRounded / startingBankrollUsd : null;

  return {
    bankrollUsd: Math.round(bankrollUsd * 100) / 100,
    startingBankrollUsd,
    equityCurve: buildEquityCurve(db, mode, startingBankrollUsd),
    dailyReturns,
    todaysReturn: dailyReturns.length > 0 ? dailyReturns[0].returnPct : null,
    sinceInceptionReturn,
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
  };
}

function getStats() {
  const db = getDb();

  const paper = buildModeStats(db, 'paper', STARTING_BANKROLL);
  // Live track (task: live dashboard tab, 2026-09-11) -- zero live rows exist as of this change,
  // so every field below renders correctly empty ($0 bankroll matching LIVE_STARTING_BANKROLL's
  // own starting point plus zero P&L, 0 trades, an equity curve with just its single starting
  // point, "No daily history yet."). See LIVE_STARTING_BANKROLL's own comment above for why its
  // zero point isn't $0.
  const live = buildModeStats(db, 'live', LIVE_STARTING_BANKROLL);

  // decayAlerts/probationReviewAlerts stay paper-scoped by nature of decayWatch.js's own queries
  // (fixed 2026-09-11 to explicitly filter mode='paper' -- see that file) -- not duplicated for
  // the live track here; a bucket's decay/probation alert is a paper-calibration-quality signal,
  // not something that makes sense to show twice or attribute to a specific track's card.
  const decayAlerts = db.prepare(`SELECT * FROM decay_alerts ORDER BY created_at DESC`).all();
  const probationReviewAlerts = db.prepare(`SELECT * FROM probation_review_alerts ORDER BY created_at DESC`).all();

  const lastObs = db.prepare(`SELECT MAX(created_at) t FROM observations`).get().t;

  return {
    bot: 'kalshi-bot',
    lastActivityAt: lastObs,
    ...paper,
    // goLiveGate.current used to be settled.c + a separately-queried pendingForGate -- identical
    // WHERE clause to openCount, so this is the same number via paper.totals.trades +
    // paper.totals.openPositions now, not a behavior change, just one fewer redundant query.
    goLiveGate: { target: GO_LIVE_TRADE_COUNT, current: paper.totals.trades + paper.totals.openPositions, label: `${GO_LIVE_TRADE_COUNT} staked paper trades` },
    decayAlerts,
    probationReviewAlerts,
    minCalibrationN: MIN_CALIBRATION_N,
    live,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/stats' && req.method === 'GET') {
    try {
      const stats = getStats();
      stats.serviceActive = await isServiceActive('kalshi-bot');
      // Same underlying process serves both tracks (there's only one orchestrator.js) -- copy
      // onto the nested live object too so its own healthline renders correctly, rather than
      // adding a second isServiceActive call for an identical answer.
      stats.live.serviceActive = stats.serviceActive;
      stats.live.lastActivityAt = stats.lastActivityAt;
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
      // mode (task: live dashboard tab, 2026-09-11) -- OPTIONAL, omitted by the paper card's own
      // drill-down (unchanged: still shows a bucket's COMPLETE history, both tracks blended,
      // distinguished by mapTradeRow's isLive/executionEnv badges, exactly as before this
      // change). Passed as 'live' by the new live card's own drill-down, so it only ever shows
      // that bucket's live-track history. dashboardServer.js's proxy already forwards every query
      // param verbatim, so no change was needed there for this to reach here.
      const mode = parsed.searchParams.get('mode');
      if (mode !== null && mode !== 'paper' && mode !== 'live') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `invalid mode "${mode}" -- must be "paper" or "live" if provided` }));
        return;
      }
      const db = getDb();
      const baseQuery = `SELECT id, created_at, mode, execution_env, series, ticker, bucket_key, side, market_price, contracts, stake_usd, status, exit_pnl_usd, opened_at, resolved_at, log_only FROM trades WHERE bucket_key = ?`;
      const trades = (mode
        ? db.prepare(`${baseQuery} AND mode = ? ORDER BY id DESC`).all(bucketKey, mode)
        : db.prepare(`${baseQuery} ORDER BY id DESC`).all(bucketKey)
      ).map(mapTradeRow);
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
