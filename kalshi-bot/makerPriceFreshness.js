// Fresh-orderbook repricing for the original maker leg (added 2026-09-11, following the first
// real live order attempt getting rejected with HTTP 400). Investigation that night found the
// root cause: liveExecution.js's placeLivePosition submitted decision.entryCost -- priced off
// the checkpoint's CANDLESTICK -- directly to Kalshi as a postOnly maker price, with nothing
// checking it against the real, separately-fetched live orderbook first. A real historical
// analysis (420 real paper trades with usable orderbook capture) found this isn't a tail risk:
// 43.1% would have crossed the real book and been rejected the same way, with a median safety
// margin of just 1 cent. Deliberately isolated in its own file, same one-concern-per-file
// convention as liveCapitalAtRisk.js/pilotStakeCap.js/drawdownBreaker.js.
'use strict';

// Matches kalshiClient.js's own round4 helper (getOrderbook's 1-x bestNoBid->bestYesAsk
// conversion) -- same class of floating-point artifact (a price derived via add/subtract, e.g.
// 0.38 + 0.02 potentially landing as 0.39999999999999997), same fix. 4 decimals, not 2/cents:
// this project's own real market data (price_ranges captured earlier this session) shows some
// Kalshi price bands use sub-cent ticks (0.0001) at the extremes, so cent-rounding could put a
// price off-grid there; 4-decimal rounding matches what placeLimitOrder actually serializes
// (price.toFixed(4)) and is the existing precedent for this exact problem elsewhere in this
// codebase. The 0.02 safety buffer is 400x this rounding's max error (0.00005), so rounding can
// never undo the crossing-safety the clamp below provides.
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * Given the already-decided side and entryCost (from evaluateOpportunity, priced off the
 * checkpoint's candlestick), and a FRESH orderbook read taken immediately before order
 * submission, returns the actual price to use for the real Kalshi order.
 *
 * Clamps toward safety (never crosses the fresh book) but never reprices WORSE than the
 * original decision -- the same min/max formula handles both the "no adjustment needed" case
 * (returns the original unchanged) and the "would have crossed" case (clamps to just inside the
 * fresh touch) with no special-casing. Provably never worse economically than the stale
 * candlestick price: a bid that would have crossed was offering to pay MORE than the fresh ask
 * requires; an ask that would have crossed was offering to sell for LESS than the fresh bid
 * offers. Clamping toward the fresh touch in either case pays less / receives more, not less
 * favorably -- confirmed against the real 2026-09-11 rejection (side 'no', entryCost 0.63,
 * fresh bestYesBid 0.38: clamped entryCost becomes 0.60, cheaper, not just safer).
 *
 * Returns nulls if the relevant side of the fresh book is empty (thin book -- caller must treat
 * this as "can't safely determine, skip," not "assume safe").
 *
 * @param {'yes'|'no'} side
 * @param {number} originalEntryCost - decision.entryCost, priced off the checkpoint candlestick
 * @param {{bestYesBid: number|null, bestYesAsk: number|null}} book - a FRESH getOrderbook() read, taken immediately before this call
 * @param {number} bufferUsd - safety margin beyond the fresh touch (LIVE_EXECUTION_STRATEGY_CONFIG.makerPriceSafetyBufferUsd)
 * @returns {{freshMarketPrice: number|null, freshEntryCost: number|null}}
 *   freshMarketPrice matches decision.marketPrice's own convention (the raw yes-side reference
 *   price -- what feeUsd and evaluateOpportunity's own opp.price both expect). freshEntryCost
 *   matches decision.entryCost's own convention (side-adjusted cost of the side being bought --
 *   what edgeClearsFeeAtPrice's costOfSide param expects, and what placeLimitOrder's own `price`
 *   param expects). Both null together, or both a valid number together -- never mixed.
 */
function computeFreshMakerPrice(side, originalEntryCost, book, bufferUsd) {
  if (side === 'yes') {
    // BID at entryCost. Crosses if entryCost >= bestYesAsk. Clamp DOWN toward safety only.
    if (book.bestYesAsk === null) return { freshMarketPrice: null, freshEntryCost: null };
    const freshMarketPrice = round4(Math.min(originalEntryCost, book.bestYesAsk - bufferUsd));
    return { freshMarketPrice, freshEntryCost: freshMarketPrice };
  }
  // ASK at (1 - entryCost). Crosses if that <= bestYesBid. Clamp UP toward safety only.
  if (book.bestYesBid === null) return { freshMarketPrice: null, freshEntryCost: null };
  const originalApiPrice = 1 - originalEntryCost;
  const freshMarketPrice = round4(Math.max(originalApiPrice, book.bestYesBid + bufferUsd));
  return { freshMarketPrice, freshEntryCost: round4(1 - freshMarketPrice) };
}

module.exports = { computeFreshMakerPrice };
