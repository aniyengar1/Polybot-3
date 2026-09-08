// kalshi-bot's own Kalshi API client. Independent implementation -- not a wrapper around any
// existing repo code (there is no existing Kalshi client in this project; the soccer-research
// backtest scripts this bot's strategy is grounded in are read-only fetch scripts, not a
// reusable client, and this bot doesn't import them).
//
// Base URL and endpoint shapes confirmed live 2026-09-04 (curled directly, not assumed from
// docs): api.elections.kalshi.com/trade-api/v2 (NOT api.kalshi.com -- that's the historical
// find from /Users/anirudhiyengar/soccer-research/fetchKalshiGoldSilver15Min.js, re-verified
// live here). GET /markets?series_ticker=X&status=open returns the currently-open market(s)
// with real-time fields (last_price_dollars, yes_bid/ask_dollars, close_time). GET
// /series/{series}/markets/{ticker}/candlesticks?start_ts&end_ts&period_interval=1 works
// identically for still-open markets as it does historically (same response shape).
//
// Auth (KALSHI-ACCESS-KEY / -SIGNATURE / -TIMESTAMP, RSA-PSS over
// timestamp+method+path, confirmed from kalshi_openapi.yaml's securitySchemes) is
// implemented here for completeness -- SPORTSBOT-style credential-gated client, its own env
// vars (KALSHIBOT_*, not any other project's) -- but is NEVER wired into any order-placement
// call anywhere in this codebase. There is no orders.create() equivalent in this file or
// anywhere else in kalshi-bot. Every market-data read used by this bot is the public,
// unauthenticated path (confirmed live, zero API key required) -- auth exists only so a
// future, deliberate live-trading build (not this one) wouldn't need to start from zero, and
// so authenticated reads (higher rate-limit tier) are available if ever needed. See README:
// "No real capital -- paper mode only" is enforced structurally, not by a flag.
'use strict';

const crypto = require('crypto');

const API_BASE = process.env.KALSHIBOT_API_URL || 'https://api.elections.kalshi.com/trade-api/v2';

function hasCredentials() {
  return Boolean(process.env.KALSHIBOT_API_KEY_ID && process.env.KALSHIBOT_PRIVATE_KEY_PEM);
}

/** RSA-PSS signs `${timestampMs}${method}${path}` per KALSHI-ACCESS-SIGNATURE's documented scheme. Unused unless an authenticated call is made -- none currently are. */
function signRequest(method, path) {
  const keyId = process.env.KALSHIBOT_API_KEY_ID;
  const pem = process.env.KALSHIBOT_PRIVATE_KEY_PEM;
  if (!keyId || !pem) {
    throw new Error('KALSHIBOT_API_KEY_ID / KALSHIBOT_PRIVATE_KEY_PEM missing -- required for any authenticated call.');
  }
  const timestampMs = Date.now().toString();
  const message = `${timestampMs}${method}${path}`;
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    'KALSHI-ACCESS-TIMESTAMP': timestampMs,
  };
}

async function fetchJson(url, { retries = 2, authPath = null, method = 'GET' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = { 'User-Agent': 'kalshi-bot/1.0' };
      if (authPath) Object.assign(headers, signRequest(method, authPath));
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        if (attempt === retries) throw new Error('HTTP 429 (retries exhausted)');
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

/** Currently open market(s) for a series. Public, unauthenticated -- confirmed live. */
async function getOpenMarkets(seriesTicker) {
  const data = await fetchJson(`${API_BASE}/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=10`);
  return (data && data.markets) || [];
}

/** Single market's current snapshot (used by settlement.js to check `result`). Public. */
async function getMarket(ticker) {
  const data = await fetchJson(`${API_BASE}/markets/${encodeURIComponent(ticker)}`);
  return data && data.market;
}

/** 1-minute candlesticks, live or historical (same endpoint serves both -- confirmed live). Public. */
async function getCandlesticks(seriesTicker, ticker, startTs, endTs) {
  const data = await fetchJson(
    `${API_BASE}/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`
  );
  return (data && data.candlesticks) || [];
}

/**
 * Top-of-book YES-side bid/ask, for comparing the checkpoint's assumed fill price (a
 * candlestick close, used for sizing everywhere else in this bot) against what a real taker
 * order would actually have crossed. Public, confirmed live 2026-09-06.
 *
 * Real shape (confirmed live, NOT what the endpoint name might suggest): the response is
 * `{ orderbook_fp: { yes_dollars: [[price, size], ...], no_dollars: [[price, size], ...] } }`.
 * Both arrays are RESTING BUY orders only (bids), ascending by price -- there is no separate
 * ask array for either side. The best (highest) bid is the LAST entry in each array. The ask
 * for one side is derived from the complementary side's best bid, since selling YES at price P
 * is equivalent to buying NO at (1-P): bestYesAsk = 1 - bestNoBid, bestNoAsk = 1 - bestYesBid.
 * Returns nulls (never throws past this function) if the book is empty on a side or the
 * response shape is unexpected -- a missing quote is a real, valid capture outcome (thin book),
 * not an error the caller needs to handle specially.
 */
async function getOrderbook(ticker) {
  const data = await fetchJson(`${API_BASE}/markets/${encodeURIComponent(ticker)}/orderbook`);
  const book = data && data.orderbook_fp;
  const yesLevels = (book && book.yes_dollars) || [];
  const noLevels = (book && book.no_dollars) || [];
  const bestYesBid = yesLevels.length > 0 ? parseFloat(yesLevels[yesLevels.length - 1][0]) : null;
  const bestNoBid = noLevels.length > 0 ? parseFloat(noLevels[noLevels.length - 1][0]) : null;
  const round4 = (v) => Math.round(v * 10000) / 10000;
  return {
    bestYesBid: Number.isFinite(bestYesBid) ? bestYesBid : null,
    bestYesAsk: Number.isFinite(bestNoBid) ? round4(1 - bestNoBid) : null,
  };
}

module.exports = { API_BASE, hasCredentials, signRequest, fetchJson, getOpenMarkets, getMarket, getCandlesticks, getOrderbook };
