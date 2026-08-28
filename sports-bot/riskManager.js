// Portfolio-level risk gates -- independent implementation of the GENERIC gates from
// polybot-v2/src/execution/riskManager.ts (daily loss circuit breaker, re-entry guard, max
// concurrent positions, max exposure per bucket/event). "City" there is repurposed as
// bucket_key here, per the original build-scoping report's finding that riskManager.ts's
// gates were sport-agnostic by construction. Deliberately NOT porting
// nbmDivergenceSizeMultiplier -- that's a weather-forecast-model-specific sizing gate
// (divergence between two temperature models) with no sports analogue; nothing in this
// project's validated methodology calls for an equivalent.
'use strict';

const MAX_CONCURRENT_POSITIONS = Number(process.env.SPORTSBOT_MAX_CONCURRENT_POSITIONS || 10);
const MAX_EXPOSURE_PER_BUCKET_PCT = Number(process.env.SPORTSBOT_MAX_EXPOSURE_PER_BUCKET_PCT || 0.30);
const MAX_EXPOSURE_PER_EVENT_PCT = Number(process.env.SPORTSBOT_MAX_EXPOSURE_PER_EVENT_PCT || 0.10);
const MAX_DAILY_LOSS_PCT_BANKROLL = Number(process.env.SPORTSBOT_MAX_DAILY_LOSS_PCT || 0.10);

function getPortfolioState(db) {
  const rows = db.prepare(`SELECT bucket_key, event_slug, market_slug, stake_usd FROM trades WHERE status = 'pending'`).all();
  const state = { openCount: rows.length, bucketExposureUsd: {}, eventExposureUsd: {}, openMarketSlugs: new Set(), totalExposureUsd: 0 };
  for (const r of rows) {
    state.bucketExposureUsd[r.bucket_key] = (state.bucketExposureUsd[r.bucket_key] || 0) + r.stake_usd;
    state.eventExposureUsd[r.event_slug] = (state.eventExposureUsd[r.event_slug] || 0) + r.stake_usd;
    state.openMarketSlugs.add(r.market_slug);
    state.totalExposureUsd += r.stake_usd;
  }
  return state;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getTodayRealizedPnl(db) {
  const row = db
    .prepare(`SELECT COALESCE(SUM(exit_pnl_usd), 0) AS pnl FROM trades WHERE status IN ('won','lost') AND substr(resolved_at, 1, 10) = ?`)
    .get(todayStr());
  return row ? row.pnl : 0;
}

function isDailyLossBreakerTriggered(bankrollUsd, db) {
  const pnl = getTodayRealizedPnl(db);
  const limit = -MAX_DAILY_LOSS_PCT_BANKROLL * bankrollUsd;
  return pnl <= limit;
}

/**
 * Portfolio-level gates the pure sizing function (evaluateOpportunity) can't apply on its
 * own -- it doesn't see live position state. Runs immediately before order placement.
 * Re-entry is blocked outright (matches riskManager.ts's rationale: evaluateOpportunity
 * recomputes a fresh decision every scan cycle with no memory of an existing position, so
 * without this gate a still-qualifying opportunity would re-fire every cycle) -- backstopped
 * at the DB level too by db.js's idx_trades_open_market_unique partial unique index.
 */
function checkRisk(decision, bankrollUsd, db) {
  if (isDailyLossBreakerTriggered(bankrollUsd, db)) {
    return { allowed: false, reason: 'daily loss circuit breaker triggered -- no new positions today' };
  }

  const portfolio = getPortfolioState(db);
  if (portfolio.openMarketSlugs.has(decision.marketSlug)) {
    return { allowed: false, reason: `already holding an open position in market ${decision.marketSlug} -- skipping re-entry` };
  }
  if (portfolio.openCount >= MAX_CONCURRENT_POSITIONS) {
    return { allowed: false, reason: `max concurrent positions (${MAX_CONCURRENT_POSITIONS}) reached` };
  }

  const bucketCap = MAX_EXPOSURE_PER_BUCKET_PCT * bankrollUsd;
  const bucketUsed = portfolio.bucketExposureUsd[decision.bucketKey] || 0;
  const bucketRoom = bucketCap - bucketUsed;
  if (bucketRoom <= 0) {
    return { allowed: false, reason: `max exposure for bucket ${decision.bucketKey} reached ($${bucketCap.toFixed(2)} cap)` };
  }

  const eventCap = MAX_EXPOSURE_PER_EVENT_PCT * bankrollUsd;
  const eventUsed = portfolio.eventExposureUsd[decision.eventSlug] || 0;
  const eventRoom = eventCap - eventUsed;
  if (eventRoom <= 0) {
    return { allowed: false, reason: `max exposure for event ${decision.eventSlug} reached ($${eventCap.toFixed(2)} cap)` };
  }

  const adjustedStake = Math.max(0, Math.min(decision.stake, bucketRoom, eventRoom));
  if (adjustedStake < 1) {
    return { allowed: false, reason: 'adjusted stake below $1 minimum after exposure caps' };
  }

  return { allowed: true, adjustedStake };
}

module.exports = { getPortfolioState, getTodayRealizedPnl, isDailyLossBreakerTriggered, checkRisk };
