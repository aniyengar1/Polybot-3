// Real-time depth check for production use. Queries live order-book depth via Polymarket
// US's own gateway -- the same endpoint polybot-v2's executor.ts already uses for its spread
// filter (GET /v1/markets/{slug}/bbo) -- rather than gamma-api.polymarket.com (a mirror used
// for backtesting, not something a live bot should depend on for its own position decisions).
//
// This is a genuinely different signal than the backtest's nearbyNotionalUsd (trailing
// REALIZED trade volume within +/-3h of a checkpoint, only computable retrospectively from
// historical trade logs). Live, we check standing order-book depth instead -- the more
// directly actionable "how much could I actually get filled right now" signal, and what the
// live gateway actually exposes (there is no live equivalent of "trailing volume in a
// +/-3h window" without maintaining a rolling trade-log aggregation ourselves, which is more
// machinery than this needs when book depth already answers the same underlying question:
// is there real liquidity here right now).
//
// NOT exercised by the historical reproduction harness (test/reproduceBacktest.js): a past
// game's order book from months ago no longer exists to query, only its historical trade
// log does. The harness feeds the backtest's own nearbyNotionalUsd value straight into
// evaluateOpportunity's availableDepthUsd parameter instead. This module is a genuinely
// separate, not-yet-live-tested piece of the system -- it needs its own validation once a
// real market is open to query (MLB now; NHL/NBA once their seasons start), which the
// reproduction test cannot cover by construction.
'use strict';

const GATEWAY_BASE = 'https://gateway.polymarket.us';

async function fetchJson(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'sports-bot/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
}

/**
 * Returns the available USD depth on the side we'd be taking (buying), at the best
 * ask level. Returns 0 -- not null, not undefined -- on any fetch failure or missing data,
 * so a network hiccup fails safe into "no depth available" (the 20% depth cap then collapses
 * the stake to $0, blocking the trade) rather than an unbounded or undefined depth that
 * could let a stake through uncapped.
 */
async function fetchLiveDepthUsd(marketSlug) {
  try {
    const data = await fetchJson(`${GATEWAY_BASE}/v1/markets/${encodeURIComponent(marketSlug)}/bbo`);
    const md = data && data.marketData;
    if (!md) return 0;
    const askDepth = md.askDepth;
    const bestAskValue = md.bestAsk && md.bestAsk.value ? parseFloat(md.bestAsk.value) : null;
    if (askDepth === undefined || askDepth === null || bestAskValue === null || !Number.isFinite(bestAskValue)) {
      return 0;
    }
    return askDepth * bestAskValue;
  } catch {
    return 0;
  }
}

module.exports = { fetchLiveDepthUsd };
