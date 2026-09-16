// Raw order-endpoint HTTP primitives -- the first code in this project capable of placing a
// real order against Kalshi with real money. Built on kalshiClient.js's existing
// signRequest/fetchJson/hasCredentials (reused, not duplicated) -- same RSA-PSS scheme,
// confirmed identical across read and write endpoints in
// /Users/anirudhiyengar/soccer-research/KALSHI_ORDER_EXECUTION_API_RESEARCH.md.
//
// NOT imported by orchestrator.js, liveSizing.js, execution.js, or anything else in the live
// checkpoint-cycle path -- standalone, independently testable, otherwise inert. Paper trading
// runs completely unaffected by this file's existence.
//
// SAFETY: every function here defaults to Kalshi's DEMO environment (mock funds). Reaching
// production requires TWO independent, explicit opt-ins -- passing `{ base: 'live' }` AND
// having `KALSHIBOT_ORDERS_ALLOW_LIVE=true` set -- neither satisfiable by accident. Demo and
// live use entirely separate credentials (Kalshi does not share them between environments),
// read from separate env var pairs so there's no ambiguity about which key targets which host.
//
// Signing confirmed working live against Kalshi's demo environment on 2026-09-08 (getOrder
// against a bogus-but-UUID-shaped order_id, expecting and getting a clean 404). Two real bugs
// were found and fixed via that sanity check before it passed, both worth remembering:
//   1. The demo PEM's header claimed PKCS#8 (`-----BEGIN PRIVATE KEY-----`) but the actual
//      bytes were raw PKCS#1 -- OpenSSL's CLI tools silently auto-detect either format, but
//      Node's crypto.sign() uses a stricter OpenSSL 3.x decoder that requires the header to
//      match the real structure, and threw ERR_OSSL_UNSUPPORTED. Fixed by re-encoding the same
//      key material into a canonical PKCS#8 PEM (`openssl pkey -in old.pem -out new.pem`) --
//      not a code bug, a key-file bug, but worth remembering if a future key ever hits the
//      same error.
//   2. The signed path (authPath, part of the RSA-PSS message: `${timestampMs}${method}${path}`)
//      must include the FULL path as it appears on the wire, INCLUDING the `/trade-api/v2`
//      prefix -- e.g. sign `/trade-api/v2/portfolio/orders/{id}`, not just
//      `/portfolio/orders/{id}`. Confirmed empirically: signing the short path produced a 401
//      on every call; switching to the full prefixed path immediately fixed it (matches what
//      Kalshi's own docs describe for query-string handling in signing -- exclude query
//      params, but nothing suggested dropping the version prefix, which was my own
//      construction error when this file was first written, not anything Kalshi's docs
//      actually said to do). API_VERSION_PATH below exists specifically so every authPath
//      construction in this file gets this right consistently, in one place.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { signRequest, fetchJson } = require('./kalshiClient');

const DEMO_BASE = 'https://external-api.demo.kalshi.co/trade-api/v2';
const LIVE_BASE = 'https://external-api.kalshi.com/trade-api/v2';
const API_VERSION_PATH = '/trade-api/v2'; // must be part of the signed path -- see header

/**
 * Resolves which base URL + credential pair to use. Defaults to demo. Reaching live requires
 * BOTH opts.base === 'live' AND process.env.KALSHIBOT_ORDERS_ALLOW_LIVE === 'true' -- if only
 * one is set, this throws rather than silently choosing either environment.
 *
 * Demo and live resolve their PEM differently (added 2026-09-11): demo reads it directly from
 * KALSHIBOT_ORDERS_DEMO_PRIVATE_KEY_PEM's own env var value, unchanged since this file was
 * written. Live reads it from a FILE at KALSHIBOT_ORDERS_LIVE_PRIVATE_KEY_PEM_PATH instead, via
 * fs.readFileSync -- systemd's EnvironmentFile (/etc/kalshi-bot/env) is plain KEY=VALUE lines
 * with no support for a value containing real embedded newlines the way a bash-sourced
 * .env.local.sh tolerates inside quotes, and a PEM is multi-line. Read at CALL TIME, not cached
 * at import time: resolveTarget is only ever called once per order-related action (placement,
 * cancel, status check), never in a hot loop, so the extra file read is negligible -- and it
 * means a rotated key on disk takes effect without a process restart.
 */
function resolveTarget(opts = {}) {
  const wantsLive = opts.base === 'live';
  const liveAllowed = process.env.KALSHIBOT_ORDERS_ALLOW_LIVE === 'true';

  if (wantsLive && !liveAllowed) {
    throw new Error(
      "Refusing to target Kalshi's LIVE environment: base:'live' was requested but " +
      'KALSHIBOT_ORDERS_ALLOW_LIVE is not set to "true". Both are required -- this is deliberate, not a bug.'
    );
  }
  if (!wantsLive && opts.base !== undefined && opts.base !== 'demo') {
    throw new Error(`Unknown base "${opts.base}" -- expected "demo" (default) or "live".`);
  }

  const isLive = wantsLive && liveAllowed;
  const apiBase = isLive ? LIVE_BASE : DEMO_BASE;
  const keyId = process.env[isLive ? 'KALSHIBOT_ORDERS_LIVE_API_KEY_ID' : 'KALSHIBOT_ORDERS_DEMO_API_KEY_ID'];

  let pem;
  if (isLive) {
    const pemPath = process.env.KALSHIBOT_ORDERS_LIVE_PRIVATE_KEY_PEM_PATH;
    if (!keyId || !pemPath) {
      throw new Error(
        'Missing KALSHIBOT_ORDERS_LIVE_API_KEY_ID / _PRIVATE_KEY_PEM_PATH -- ' +
        'set both before calling any order function against live.'
      );
    }
    try {
      pem = fs.readFileSync(pemPath, 'utf8');
    } catch (err) {
      // Never let the raw fs error (or the path's own content) be the only signal -- name the
      // exact path that failed so a misconfiguration is immediately actionable, without ever
      // touching or logging the PEM content itself (there is none to log here -- the read failed).
      throw new Error(`Failed to read live private key from KALSHIBOT_ORDERS_LIVE_PRIVATE_KEY_PEM_PATH ("${pemPath}"): ${err.message}`);
    }
  } else {
    pem = process.env.KALSHIBOT_ORDERS_DEMO_PRIVATE_KEY_PEM;
    if (!keyId || !pem) {
      throw new Error(
        'Missing KALSHIBOT_ORDERS_DEMO_API_KEY_ID / _PRIVATE_KEY_PEM -- ' +
        'generate a write-scoped API key for this environment before calling any order function.'
      );
    }
  }

  return { apiBase, keyId, pem, isLive };
}

/**
 * kalshiClient.js's signRequest() reads credentials from KALSHIBOT_API_KEY_ID/
 * KALSHIBOT_PRIVATE_KEY_PEM globally -- this project's original (still-unused) read-side
 * credential pair. Order placement needs environment-specific credentials (demo vs live are
 * separate accounts), so this temporarily swaps process.env for the duration of one signed
 * call rather than forking signRequest's implementation.
 *
 * MUST stay `async` with `await fn()` (not `return fn()`): fn() calls fetchJson, an async
 * function that only runs synchronously up to its first `await`. If this were `return fn()`
 * inside a sync try/finally, fetchJson would run synchronously through signRequest() (correct
 * credentials at that point), hit `await fetch(...)`, and yield control back here with a still-
 * pending promise -- the `finally` block would then restore the env vars immediately, in the
 * same tick, well before the network call resolves. That's harmless for placeLimitOrder/
 * cancelOrder (both force retries:0), but getOrder/listOrders/getFills use fetchJson's default
 * retry loop -- a retried attempt (e.g. after a 429) would call signRequest() AGAIN, by which
 * point the credentials would already be restored to nothing, producing a confusing 401 that
 * looks like a signing bug but is actually this timing bug. `await fn()` here makes the
 * `finally` wait for the whole promise chain -- including internal retries -- to settle first.
 */
async function withCredentials(keyId, pem, fn) {
  const prevKeyId = process.env.KALSHIBOT_API_KEY_ID;
  const prevPem = process.env.KALSHIBOT_PRIVATE_KEY_PEM;
  process.env.KALSHIBOT_API_KEY_ID = keyId;
  process.env.KALSHIBOT_PRIVATE_KEY_PEM = pem;
  try {
    return await fn();
  } finally {
    if (prevKeyId === undefined) delete process.env.KALSHIBOT_API_KEY_ID; else process.env.KALSHIBOT_API_KEY_ID = prevKeyId;
    if (prevPem === undefined) delete process.env.KALSHIBOT_PRIVATE_KEY_PEM; else process.env.KALSHIBOT_PRIVATE_KEY_PEM = prevPem;
  }
}

function newClientOrderId() {
  return crypto.randomUUID();
}

/**
 * Places a passive limit order using the GTT mechanism confirmed in the research doc: a single
 * `good_till_canceled` + `expiration_time` order lets Kalshi's own matching engine auto-cancel
 * the resting order at the given time -- no manual poll-and-cancel loop needed for the timeout
 * itself (contrast shadowExecution.js's simulation, which has to poll because it has no real
 * resting order for the exchange to manage).
 *
 * postOnly defaults to true: this primitive's purpose is placing a genuinely PASSIVE order (the
 * maker side of the maker-then-taker design), so rejecting/adjusting instead of letting it
 * immediately cross is the safer default -- override per-call if a marketable order is ever
 * genuinely wanted here.
 *
 * self_trade_prevention_type defaults to 'taker_at_cross', matching Kalshi's own quick-start
 * example -- not independently verified beyond that example existing.
 *
 * Retries are forced to 0 (see kalshiClient.js's fetchJson header): a POST must never be
 * silently retried underneath this call. Any failure -- including an ambiguous one like a
 * timeout -- surfaces immediately to the caller, which should be orderRetrySafety.js's
 * placeOrderSafely, never this function called directly with an automatic-retry assumption.
 *
 * @param {object} params
 * @param {string} params.ticker
 * @param {'yes'|'no'} params.outcomeSide - which contract leg to buy. Internally converted to
 *   the API's side:'bid'|'ask' + price convention (bid=buy YES at price; ask=buy NO at
 *   1-price, i.e. "sell YES" -- see BookSide's documented economic equivalence). Kept as
 *   outcomeSide here rather than raw bid/ask so callers reason in the same yes/no terms the
 *   rest of this codebase (liveSizing.js, buckets.js) already uses.
 * @param {number} params.price - desired price for the outcomeSide leg, 0-1.
 * @param {number} params.count - contract quantity (fixed-point, 0.01 granularity confirmed).
 * @param {number} params.expirationTime - Unix seconds when Kalshi should auto-cancel if unfilled.
 * @param {string} params.clientOrderId - caller-supplied idempotency key (see orderRetrySafety.js).
 * @param {boolean} [params.postOnly=true]
 * @param {number} [params.subaccount]
 * @param {'demo'|'live'} [params.base='demo']
 */
async function placeLimitOrder({ ticker, outcomeSide, price, count, expirationTime, clientOrderId, postOnly = true, subaccount, base }) {
  if (outcomeSide !== 'yes' && outcomeSide !== 'no') {
    throw new Error(`outcomeSide must be 'yes' or 'no', got '${outcomeSide}'`);
  }
  if (!clientOrderId) {
    throw new Error('clientOrderId is required -- generate one with newClientOrderId() before calling, never omit it.');
  }
  const target = resolveTarget({ base });

  // side='bid' means buy YES at `price`; side='ask' means sell YES at `price`, economically
  // equivalent to buying NO at (1-price) -- see BookSide's documented convention.
  const side = outcomeSide === 'yes' ? 'bid' : 'ask';
  const apiPrice = outcomeSide === 'yes' ? price : 1 - price;

  const body = {
    ticker,
    side,
    count: count.toFixed(2),
    price: apiPrice.toFixed(4),
    time_in_force: 'good_till_canceled',
    expiration_time: expirationTime,
    self_trade_prevention_type: 'taker_at_cross',
    post_only: postOnly,
    client_order_id: clientOrderId,
  };
  if (subaccount !== undefined) body.subaccount = subaccount;

  return withCredentials(target.keyId, target.pem, () =>
    fetchJson(`${target.apiBase}/portfolio/events/orders`, {
      method: 'POST',
      body,
      authPath: `${API_VERSION_PATH}/portfolio/events/orders`,
      retries: 0,
    })
  );
}

/**
 * Cancels a resting order. `market_ticker` + `exchange_index=-1` for auto-routing -- confirmed
 * directly against Kalshi's raw OpenAPI spec (DELETE /portfolio/events/orders/{order_id}'s own
 * description: "To auto-route the cancellation, provide `market_ticker` and omit
 * `exchange_index` or set it to `-1`."; the operation's own <Warning> block: "Auto-routing
 * requires `market_ticker`. An `order_id` alone cannot identify the exchange shard."). Passing
 * exchange_index=-1 explicitly alongside market_ticker is redundant with omitting it entirely
 * (both auto-route per the same spec text) but not wrong -- kept explicit here for clarity.
 * Retries forced to 0 for the same reason as placeLimitOrder.
 */
async function cancelOrder({ orderId, marketTicker, base }) {
  const target = resolveTarget({ base });
  const path = `/portfolio/events/orders/${encodeURIComponent(orderId)}`;
  const qs = marketTicker ? `?market_ticker=${encodeURIComponent(marketTicker)}&exchange_index=-1` : '';
  return withCredentials(target.keyId, target.pem, () =>
    fetchJson(`${target.apiBase}${path}${qs}`, { method: 'DELETE', authPath: `${API_VERSION_PATH}${path}`, retries: 0 })
  );
}

/**
 * Full order state -- status ('resting'|'canceled'|'executed'), fill_count_fp/remaining_count_fp.
 * Reads are safe to retry (idempotent), so this uses fetchJson's default retry behavior.
 *
 * GetOrderResponse wraps the actual Order under an `order` key (confirmed against the raw
 * OpenAPI spec: `{required: [order], properties: {order: {$ref: '#/components/schemas/Order'}}}`)
 * -- unwrapped here so callers (executionStrategy.js, etc.) can read `.status`/`.fill_count_fp`
 * directly, matching this function's own doc comment above and avoiding every caller needing
 * to remember the envelope. Found and fixed 2026-09-09, before this had ever been called
 * against a real order -- unwrapping was missing entirely, which would have made every status
 * check silently see `undefined` instead of the real status.
 */
async function getOrder({ orderId, base }) {
  const target = resolveTarget({ base });
  const path = `/portfolio/orders/${encodeURIComponent(orderId)}`;
  const response = await withCredentials(target.keyId, target.pem, () => fetchJson(`${target.apiBase}${path}`, { authPath: `${API_VERSION_PATH}${path}` }));
  return response.order;
}

/**
 * Lists recent orders, optionally filtered by ticker/time range/status. This is the primitive
 * orderRetrySafety.js's ambiguous-failure resolution is built on: there is NO client_order_id
 * filter available on this endpoint for a standard (non-FCM) account (confirmed against the
 * raw OpenAPI spec -- that filter only exists on GET /fcm/orders, gated to institutional
 * accounts) -- so resolving "did my order actually get created" means listing candidates here
 * and scanning the returned Order objects client-side for a matching client_order_id.
 */
async function listOrders({ ticker, minTs, maxTs, status, base } = {}) {
  const target = resolveTarget({ base });
  const params = new URLSearchParams();
  if (ticker) params.set('ticker', ticker);
  if (minTs !== undefined) params.set('min_ts', String(minTs));
  if (maxTs !== undefined) params.set('max_ts', String(maxTs));
  if (status) params.set('status', status);
  const path = '/portfolio/orders';
  const qs = params.toString() ? `?${params.toString()}` : '';
  return withCredentials(target.keyId, target.pem, () => fetchJson(`${target.apiBase}${path}${qs}`, { authPath: `${API_VERSION_PATH}${path}` }));
}

/**
 * Granular per-match fill history for one order -- for reconstructing exact fill prices/
 * timestamps across multiple partial matches, beyond what getOrder's aggregate
 * fill_count_fp/remaining_count_fp gives you.
 */
async function getFills({ orderId, base }) {
  const target = resolveTarget({ base });
  const path = '/portfolio/fills';
  const qs = `?order_id=${encodeURIComponent(orderId)}`;
  return withCredentials(target.keyId, target.pem, () => fetchJson(`${target.apiBase}${path}${qs}`, { authPath: `${API_VERSION_PATH}${path}` }));
}

module.exports = {
  DEMO_BASE,
  LIVE_BASE,
  resolveTarget,
  newClientOrderId,
  placeLimitOrder,
  cancelOrder,
  getOrder,
  listOrders,
  getFills,
};
