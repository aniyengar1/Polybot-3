// Idempotent-retry wrapper around kalshiOrders.js's placeLimitOrder. Exists specifically
// because Kalshi's own docs do not confirm the client_order_id dedup guarantee or window (see
// /Users/anirudhiyengar/soccer-research/KALSHI_ORDER_EXECUTION_API_RESEARCH.md, section 7) --
// this file treats that as genuinely unconfirmed, not as a safe assumption to build on.
//
// NOT imported by orchestrator.js, liveSizing.js, or anything in the live checkpoint-cycle
// path -- standalone, independently testable, otherwise inert.
'use strict';

const { placeLimitOrder, listOrders, newClientOrderId } = require('./kalshiOrders');

/**
 * Places an order, generating the client_order_id itself by default so the caller never has to
 * remember to. On success, returns { outcome: 'placed', response }.
 *
 * On an AMBIGUOUS failure (network error, timeout, 5xx -- anything where we can't tell if
 * Kalshi actually received and processed the request), this does NOT retry the POST. It calls
 * resolveAmbiguousOrder to find out what actually happened first. A clean 4xx rejection (e.g.
 * 400 bad request, 401 unauthorized) is NOT ambiguous -- Kalshi definitely received and
 * rejected it, so that's just returned as a failure, no resolution needed.
 *
 * @param {object} params - same shape as kalshiOrders.placeLimitOrder, minus a manual retry loop
 *   (there isn't one -- see above).
 * @param {string} [params.clientOrderId] - added 2026-09-10: optional externally-supplied
 *   client_order_id, for a caller that needs to PERSIST the id before this call resolves (e.g.
 *   liveExecution.js's taker-escalation path, which must be able to look this exact id up via
 *   resolveAmbiguousOrder even if the calling PROCESS itself crashes mid-call -- something this
 *   function's own internal try/catch can't protect against, since it never runs if the process
 *   dies first). Backward-compatible: every existing caller omits this and gets the same
 *   internally-generated id as before, unchanged behavior.
 * @returns {Promise<{outcome: 'placed'|'rejected'|'resolved'|'unresolved', ...}>}
 */
async function placeOrderSafely(params) {
  const clientOrderId = params.clientOrderId || newClientOrderId();
  const sinceTs = Math.floor(Date.now() / 1000);

  let response;
  try {
    response = await placeLimitOrder({ ...params, clientOrderId });
  } catch (err) {
    if (isAmbiguousFailure(err)) {
      // base must match the original call's target -- an ambiguous failure while targeting
      // live must be resolved against live's own order list, never demo's (and vice versa).
      const resolution = await resolveAmbiguousOrder({ ticker: params.ticker, clientOrderId, sinceTs, base: params.base });
      return { outcome: resolution.found ? 'resolved' : 'unresolved', clientOrderId, ...resolution };
    }
    // Clean rejection (4xx other than what looks like a transient gateway issue) -- Kalshi
    // definitely saw and rejected this, nothing ambiguous to resolve.
    return { outcome: 'rejected', clientOrderId, error: String(err) };
  }

  return { outcome: 'placed', clientOrderId, response };
}

/**
 * Distinguishes an ambiguous failure (we genuinely don't know if the order was created) from a
 * clean rejection (Kalshi definitely responded and said no). kalshiClient.js's fetchJson throws
 * plain Error objects with messages like "HTTP 400", "HTTP 429 (retries exhausted)", or the
 * underlying fetch error's own message (e.g. a timeout/abort/DNS failure) -- there's no
 * structured status code on the thrown error to inspect, so this matches on the message text.
 * Treated as ambiguous: no HTTP status recognizable at all (network-level failure), or a 5xx,
 * or 429 (rate-limited -- unclear whether an earlier attempt within the same limiter window
 * landed). Treated as NOT ambiguous: any clean 4xx other than 429 -- Kalshi processed and
 * rejected the request, there is nothing to resolve.
 */
function isAmbiguousFailure(err) {
  const message = String(err && err.message || err);
  const httpMatch = message.match(/HTTP (\d\d\d)/);
  if (!httpMatch) return true; // no recognizable HTTP status -- network-level failure, ambiguous
  const status = Number(httpMatch[1]);
  if (status === 429) return true;
  if (status >= 500) return true;
  return false; // clean 4xx (400, 401, 404, 409, ...) -- not ambiguous, Kalshi definitely rejected it
}

/**
 * Resolves whether an order with the given client_order_id actually got created, by listing
 * recent orders for the ticker and scanning client-side -- there is no server-side
 * client_order_id filter available for a standard account (see kalshiOrders.js's listOrders
 * header). `sinceTs` should be from just before the ambiguous placeLimitOrder call, with a
 * small buffer subtracted for clock skew. `base` must match whichever environment
 * (demo/live) the original ambiguous call was targeting.
 *
 * Returns { found: true, order } if a match was located, or { found: false } if not -- NEVER
 * guesses. A `found: false` result is genuinely inconclusive (the order may not exist, or may
 * exist but fall outside whatever window/limit this scan covered) and must not be silently
 * treated as "safe to retry" by any caller of this function.
 */
async function resolveAmbiguousOrder({ ticker, clientOrderId, sinceTs, base }) {
  const CLOCK_SKEW_BUFFER_SECONDS = 5;
  const { orders } = await listOrders({ ticker, minTs: sinceTs - CLOCK_SKEW_BUFFER_SECONDS, base });
  const match = (orders || []).find((o) => o.client_order_id === clientOrderId);
  return match ? { found: true, order: match } : { found: false };
}

module.exports = { placeOrderSafely, resolveAmbiguousOrder, isAmbiguousFailure };
