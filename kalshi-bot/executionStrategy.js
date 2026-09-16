// Swappable escalation-strategy orchestration -- how long to wait passively, whether to re-peg,
// when to fall back to a taker fill. Deliberately ships with ZERO opinion on the actual numbers:
// the shadow-execution module's 60s/2s-poll parameters (shadowExecution.js) are a simulation's
// choice, not copied in here as a default. Tuning the real strategy later means supplying a
// different strategyConfig to executeWithStrategy, never touching this file's logic.
//
// NOT imported by orchestrator.js, liveSizing.js, or anything in the live checkpoint-cycle
// path -- standalone, independently testable, otherwise inert.
'use strict';

const { placeOrderSafely } = require('./orderRetrySafety');
const { getOrder } = require('./kalshiOrders');

/**
 * The data-justified strategyConfig for the real execution engine, decided 2026-09-09 from
 * shadow-execution's fill-time data (n=182 settled trials, see the shadow_execution_trials
 * report from that date). A values-only export -- executeWithStrategy still takes
 * strategyConfig as a required argument with no default (that lack of a default was a
 * deliberate earlier fix to force explicit config, not something this constant should undo).
 * Nothing currently imports this; wiring it into the orchestrator is a separate, later task.
 *
 * restMs: 60000 (60s) -- chosen on data from BOTH directions, not inherited as a default:
 *   - Maker fill times are heavily front-loaded: median 6.2s, 83.5% of maker fills complete
 *     within 30s. A shorter timeout (e.g. 30s) would sacrifice the remaining 16.5% that land in
 *     the 30-60s tail, converting them into taker_timeout trades instead -- which the same
 *     dataset shows cost roughly 6x more per trade in relative P&L terms, for no offsetting
 *     benefit (the trades that would be cut off are still real, still-plausible maker fills,
 *     not stragglers). This rules out shortening the window.
 *   - A longer timeout isn't supported either: only 0.8% of maker fills happen anywhere near
 *     the current 60s boundary, so there's little unclaimed upside from waiting longer. There is
 *     no data on whether currently-unfilled orders would eventually fill given more time, since
 *     the shadow-execution model itself never let a trial run past 60s -- extending the real
 *     timeout beyond what was ever measured would be a guess, not a data-backed choice.
 *   60 seconds is therefore the boundary the fill-time distribution itself points to on both
 *   sides, not just the value shadow-execution happened to use first.
 *
 * STILL DEFERRED, ON PURPOSE (revisited 2026-09-11, after the first live flip found the
 * candlestick-vs-live-orderbook staleness bug -- see makerPriceFreshness.js): a resting maker
 * order is never re-validated against a moving book for the full 60s window -- only the
 * escalation leg gets an edge re-check. Deliberately NOT adding one. Three things were actually
 * checked, not assumed, before concluding this:
 *   - Exposure is hard-bounded regardless: every resting order carries status='pending', which
 *     is exactly what liveCapitalAtRisk.js's $50 cap sums. Adjacent checkpoint-minute values
 *     (e.g. cp8/cp9) are only 60s apart, so simultaneous resting orders across buckets are a
 *     routine occurrence, not a rare edge case -- but the cap bounds the total regardless of how
 *     many are resting at once.
 *   - The staleness noise a resting order is exposed to isn't a NEW risk introduced by going
 *     live: execution.js's own header states the paper fill model assumes a taker fill at the
 *     checkpoint's own (candlestick) observed price, matching the backtest's own methodology --
 *     so whatever edge survived 476 real paper trades already reflects this exact noise source.
 *   - Shortening restMs as a cheaper lever than active re-validation was considered and rejected
 *     with data, not a guess: the 16.5% maker-fill tail this constant already protects (see
 *     above) would convert into ~6x-costlier taker escalations -- a quantified cost, not a free
 *     win, for a risk that's already hard-capped and already priced into the backtest.
 * Revisit if real live volume ever produces evidence this reasoning doesn't hold (e.g. a
 * pattern of losses specifically attributable to stale-quote fills) -- not on a schedule, and
 * not by reflex.
 *
 * rePegRule: deliberately left unset (key omitted, not set to null/undefined explicitly) --
 * matches executionStrategy.js's existing rePegNotImplemented() stub. No re-peg design exists
 * yet; supplying a rePegRule here would make executeWithStrategy throw immediately the first
 * time an order goes unfilled, which is correct today (there's genuinely nothing to run) but
 * would need revisiting once a real re-peg strategy is designed -- not before.
 *
 * escalationPriceCapUsd / escalationOrderBufferUsd: added 2026-09-10, decided together (not
 * guessed) for liveExecution.js's taker-escalation logic -- see that file's own header for how
 * they're used. Two genuinely different numbers, not one:
 *   - escalationPriceCapUsd (0.20): the outer bound on how far price may have moved during the
 *     60s maker wait before escalation is abandoned in favor of voiding. Set above the real
 *     shadow-execution p90 ($0.15, n=67 settled taker_timeout trials) so it doesn't interfere
 *     with the bulk of legitimately profitable escalations, while still blocking the kind of
 *     $0.25-$0.33 outlier moves the worst observed trials (all WTI) actually showed.
 *   - escalationOrderBufferUsd (0.02): a much smaller number, added to the current touch price
 *     when pricing the escalation order itself (a marketable LIMIT, not a true market order --
 *     kalshiOrders.js has no market-order code path). Protects against ordinary network/API
 *     latency between the price check and the order landing on Kalshi's book, NOT against real
 *     market movement -- that's what escalationPriceCapUsd already governs. Starts conservative
 *     since no data exists yet on actual sub-second check-to-landing movement; revisit once
 *     demo testing produces real numbers for that specific gap.
 *
 * escalationOrderExpirationSeconds: NOT part of the reviewed plan -- added during implementation
 * because the escalation order (a real GTT order, same mechanism as the maker leg) needs SOME
 * expiration_time, and leaving it resting indefinitely at a marketable price would be its own
 * unbounded-exposure mistake. Chosen short (10s) since the order is deliberately priced to cross
 * immediately against current liquidity -- if it hasn't filled within 10s, waiting longer
 * doesn't help (the touch price will likely have moved again by then anyway, which is exactly
 * the risk escalationPriceCapUsd already exists to bound at the point of decision, not something
 * worth re-litigating by waiting). Flagged here explicitly since it's a real-money-relevant
 * timing parameter I picked, not one you decided.
 *
 * makerPriceSafetyBufferUsd: added 2026-09-11 (see makerPriceFreshness.js), same magnitude and
 * same "protects against normal check-to-landing latency, not real market movement" reasoning as
 * escalationOrderBufferUsd above -- kept as a separate field (not reused) since the two guard
 * genuinely different call sites and could reasonably diverge later.
 */
const LIVE_EXECUTION_STRATEGY_CONFIG = {
  restMs: 60000,
  escalationPriceCapUsd: 0.20,
  escalationOrderBufferUsd: 0.02,
  escalationOrderExpirationSeconds: 10,
  makerPriceSafetyBufferUsd: 0.02,
};

function rePegNotImplemented() {
  throw new Error(
    'rePegRule was supplied but re-pegging logic is not implemented yet -- this is an ' +
    'intentional stub, not a bug. See executionStrategy.js header: the escalation strategy is ' +
    'still being shaped by shadow-execution data, and re-peg specifically has no design yet.'
  );
}

/**
 * Orchestrates one maker-then-(optionally)taker attempt using a caller-supplied strategy
 * config. strategyConfig is REQUIRED and has no default -- calling this without one throws a
 * TypeError rather than silently falling back to some baked-in number.
 *
 * placeOrderSafely (orderRetrySafety.js) can come back with four outcomes, and this function
 * treats them as three genuinely different cases, not one generic failure:
 *   - 'placed': normal success. Order details live in `placement.response`
 *     (CreateOrderV2Response shape: order_id, fill_count, remaining_count -- no `_fp` suffix).
 *   - 'resolved': the initial POST failed ambiguously, but resolveAmbiguousOrder confirmed a
 *     real order IS resting on Kalshi's book. This is a LIVE order and gets the exact same
 *     wait-then-check monitoring as 'placed' -- it must never be silently abandoned just
 *     because the placement call itself had a rough ride. Order details live in
 *     `placement.order` instead (Order shape: order_id, fill_count_fp, remaining_count_fp --
 *     WITH the `_fp` suffix; a different schema than CreateOrderV2Response for the same kind of
 *     data, so the two paths read from different fields, not just different object paths).
 *   - 'rejected' / 'unresolved': genuine early-return cases, given their own honest stage names
 *     rather than one shared "placement_failed" label. 'rejected' means Kalshi definitely never
 *     created anything -- nothing to monitor. 'unresolved' means genuinely unknown whether an
 *     order exists (the list-scan didn't find a match, but Kalshi's own dedup/creation
 *     guarantee isn't confirmed either way -- see orderRetrySafety.js) -- this can't be acted
 *     on programmatically and needs a human to check Kalshi's UI directly, not a stage name
 *     that could be mistaken for "nothing to worry about."
 *
 * @param {object} order - { ticker, outcomeSide, price, count } -- same shape kalshiOrders.js's
 *   placeLimitOrder uses.
 * @param {object} strategyConfig - REQUIRED, no default.
 * @param {number} strategyConfig.restMs - how long to let the order rest passively before
 *   checking on it, in milliseconds. Converted to a GTT expiration_time (Unix seconds) on the
 *   order itself, so Kalshi's own matching engine handles the auto-cancel -- no manual polling
 *   loop needed for the timeout itself, unlike shadowExecution.js's simulation (which has to
 *   poll because it has no real resting order for the exchange to manage). For a 'resolved'
 *   order, this wait is measured from now (when we learned the order exists), not from whenever
 *   it actually started resting -- deliberately conservative (may over-wait slightly) rather
 *   than guessing at an unknown true start time.
 * @param {function} [strategyConfig.rePegRule] - optional. If provided, this function is
 *   currently ALWAYS a stub that throws (see rePegNotImplemented) -- supplying it signals
 *   intent but does not yet do anything real.
 * @param {function} [strategyConfig.escalateToTaker] - optional async function, called with
 *   `{ placement, order }` if the order is still unfilled after restMs. Its return value is
 *   passed straight through -- this file does not implement a taker fallback itself, the
 *   caller's function IS the escalation strategy, matching "swappable, not hardcoded."
 * @param {'demo'|'live'} [base]
 * @returns {Promise<{stage: string, ...}>}
 */
async function executeWithStrategy(order, strategyConfig, base) {
  if (!strategyConfig || typeof strategyConfig.restMs !== 'number') {
    throw new TypeError('executeWithStrategy requires an explicit strategyConfig with a numeric restMs -- there is no default.');
  }

  const expirationTime = Math.floor((Date.now() + strategyConfig.restMs) / 1000);
  const placement = await placeOrderSafely({ ...order, expirationTime, base });

  let orderId;
  if (placement.outcome === 'placed') {
    orderId = placement.response.order_id;
  } else if (placement.outcome === 'resolved') {
    orderId = placement.order.order_id;
  } else {
    // 'rejected' or 'unresolved' -- neither has an order to monitor. See the doc comment above
    // for why these get distinct, honest stage names instead of a shared "failed" label.
    return { stage: placement.outcome === 'rejected' ? 'rejected' : 'unresolved_needs_manual_check', placement };
  }

  await new Promise((resolve) => setTimeout(resolve, strategyConfig.restMs));

  const finalState = await getOrder({ orderId, base });

  const filled = finalState.status === 'executed' || Number(finalState.fill_count_fp) > 0;
  if (filled) {
    return { stage: 'maker_filled', placement, order: finalState };
  }

  // Still resting/unfilled at restMs -- Kalshi's own GTT auto-cancel should have (or will
  // shortly) resolve the resting order on its side; this function doesn't need to cancel it
  // manually. Re-peg is checked first and, if requested, throws immediately (see above) rather
  // than silently falling through to escalateToTaker -- a caller supplying rePegRule should
  // know right away that path isn't real yet, not have it silently skipped.
  if (strategyConfig.rePegRule) {
    rePegNotImplemented();
  }

  if (strategyConfig.escalateToTaker) {
    const escalation = await strategyConfig.escalateToTaker({ placement, order: finalState });
    return { stage: 'escalated', placement, order: finalState, escalation };
  }

  return { stage: 'expired_no_escalation', placement, order: finalState };
}

module.exports = { executeWithStrategy, LIVE_EXECUTION_STRATEGY_CONFIG };
