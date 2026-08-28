// Sports-native settlement checker. Isolated, new module -- does not touch anything in
// polybot-v2/src/execution/ (that directory's checkSettlements() is weather-specific: it
// polls NWS CLI publication data and compares observed temp against bracket bounds).
//
// Sports markets need no external oracle. Polymarket US's own gateway marks the market
// itself resolved (status: 'MARKET_STATUS_RESOLVED', closed: true) with outcomePrices set
// to the terminal ["1","0"] / ["0","1"] once the game ends -- we just poll that.
//
// Verified live against gateway.polymarket.us 2026-08-26 (not assumed from docs):
//   - There is no direct market-by-slug endpoint (both /v1/markets/{slug} and
//     /v1/markets/slug/{slug} 404). Markets are only reachable via their parent event:
//     GET /v1/events/slug/{eventSlug}, then find the market within event.markets[].
//   - market.status is an explicit enum: 'MARKET_STATUS_OPEN' pre-resolution,
//     'MARKET_STATUS_RESOLVED' post-resolution. This is the authoritative resolution
//     signal -- NOT the presence of outcomePrices, which exists and is populated even on
//     open markets (e.g. a live, unresolved MLB moneyline showed outcomePrices
//     ["0.5100","0.5150"] -- current trading prices, not a result). Only compare
//     outcomePrices once status confirms resolved.
//   - Resolved outcomePrices are clean terminal values ("0" / "1"), not decimal-formatted
//     like live prices -- but this checker parses them as floats rather than doing strict
//     string equality, to not silently break if Polymarket ever formats a resolved value
//     as "1.00" instead of "1".
//   - outcomePrices comes back as a JSON-ENCODED STRING (e.g. the literal characters
//     '["0","1"]'), not a native JSON array -- same convention as Gamma's API. Caught this
//     by testing against a real resolved game and getting a parse mismatch; classification
//     parses it defensively (JSON.parse if string, pass through if somehow already an array).
//   - The market-level slug carries its own type prefix (aec-/asc-/tsc- for
//     moneyline/spread/total) that is NOT always mirrored at the event level, and this
//     convention isn't even consistent across examples: one resolved NBA event had the
//     identical "aec-" prefix on both event.slug and market.slug, while a resolved MLB
//     event had an unprefixed event.slug ("mlb-wsh-phi-2026-03-31") but prefixed market
//     slugs ("aec-mlb-wsh-phi-2026-03-31" for moneyline, "asc-...-pos-1pt5" for spread,
//     "tsc-...-9pt5" for total). Practical implication: whatever code opens a live position
//     must persist the EXACT market.slug and event.slug returned by the API at trade time --
//     this checker (and anything else looking a market up later) cannot safely reconstruct
//     either slug from a template.
//   - Real timing gap observed: for one audited NBA game, price action had already crashed
//     to near-certainty (99.9%+) by ~01:31 UTC, but the event's own `finishedTimestamp`
//     (Polymarket's official record of when the game finished) was 02:45:28 UTC -- about an
//     hour later. Formal resolution (status flips to RESOLVED, our position actually pays
//     out) lags observable price action by up to an hour or more. This checker only acts on
//     the formal status flip, not on price extremity, which is the correct behavior (a
//     position's payout is determined by formal resolution, not by inferring a probable
//     winner from price).
//   - Void/cancelled handling is NOT live-verified (no real cancelled game was found in the
//     sample checked) -- it's derived from Polymarket's own market description text, which
//     explicitly documents the behavior: "If the game is canceled entirely, with no
//     make-up game, this market will resolve 50-50." So: resolved + neither side's price
//     hits 1 => void, not a silent loss. Flagged as inferred-from-docs, not observed, in
//     case a real cancellation ever looks different than this.
'use strict';

const GATEWAY_BASE = 'https://gateway.polymarket.us';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'sports-bot/1.0' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
}

/**
 * Fetches one market's current state via its parent event. There is no direct
 * market-by-slug endpoint on gateway.polymarket.us (verified 2026-08-26), so this always
 * goes through the event. Returns null if the event or the specific market within it
 * can't be found (treated as "not resolvable this cycle", not an error -- see
 * checkOnePosition).
 */
async function fetchMarketState(eventSlug, marketSlug) {
  const data = await fetchJson(`${GATEWAY_BASE}/v1/events/slug/${encodeURIComponent(eventSlug)}`);
  if (!data || !data.event) return null;
  const market = (data.event.markets || []).find((m) => m.slug === marketSlug);
  return market || null;
}

/**
 * Pure classification function -- no I/O, easy to unit test independently of the network
 * call above. Reuses the exact side-matching logic verified correct in the forensic audit
 * (8 NBA moneyline trades, timing + side-matching + price-sanity checked individually):
 *   won = side === 'YES' ? yesResolvedTo === 1 : yesResolvedTo === 0
 * where yesResolvedTo === 1 means outcomePrices[0] (the YES/first-listed side) settled to
 * a clean win. Parses as float rather than strict string equality for robustness against
 * formatting variance, but is otherwise the identical rule.
 *
 * @param {object} market - a market object as returned by fetchMarketState
 * @param {'YES'|'NO'} ourSide - which side our position is on
 * @returns {{status: 'pending'} | {status: 'won'|'lost'|'void', outcomePrices: string[]} | {status: 'unresolvable', reason: string}}
 */
function classifyMarketOutcome(market, ourSide) {
  if (!market) {
    return { status: 'pending' }; // market not found this cycle -- retry next poll, not an error
  }
  if (market.status !== 'MARKET_STATUS_RESOLVED' || !market.closed) {
    return { status: 'pending' };
  }

  // outcomePrices comes back from the gateway as a JSON-ENCODED STRING (e.g. '["0","1"]'),
  // not a native array -- verified live 2026-08-26, same convention as Gamma's API. Parse
  // defensively; a native array is also accepted in case that ever changes.
  let outcomePrices = market.outcomePrices;
  if (typeof outcomePrices === 'string') {
    try {
      outcomePrices = JSON.parse(outcomePrices);
    } catch {
      return { status: 'unresolvable', reason: `market marked resolved but outcomePrices did not parse as JSON: ${market.outcomePrices}` };
    }
  }
  if (!Array.isArray(outcomePrices) || outcomePrices.length !== 2) {
    return { status: 'unresolvable', reason: `market marked resolved but outcomePrices is not a 2-element array: ${JSON.stringify(outcomePrices)}` };
  }

  const yesPrice = parseFloat(outcomePrices[0]);
  const noPrice = parseFloat(outcomePrices[1]);
  if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) {
    return { status: 'unresolvable', reason: `resolved outcomePrices did not parse as numbers: ${JSON.stringify(outcomePrices)}` };
  }

  const yesResolvedTo1 = yesPrice === 1;
  const noResolvedTo1 = noPrice === 1;

  if (!yesResolvedTo1 && !noResolvedTo1) {
    // Resolved, but neither side hit a clean win -- void/cancelled (50-50), per Polymarket's
    // own documented market-description behavior. Not live-verified against a real
    // cancelled game -- see module header.
    return { status: 'void', outcomePrices };
  }

  const won = ourSide === 'YES' ? yesResolvedTo1 : !yesResolvedTo1;
  return { status: won ? 'won' : 'lost', outcomePrices };
}

/**
 * Checks one open position. `position` needs at minimum: eventSlug, marketSlug, side
 * ('YES'|'NO'). Network errors are caught and treated as pending/retry-next-cycle -- a
 * transient gateway failure should never be mistaken for "not resolved yet" turning into
 * a lost position, and should never crash the poll loop for other open positions.
 */
async function checkOnePosition(position) {
  let market;
  try {
    market = await fetchMarketState(position.eventSlug, position.marketSlug);
  } catch (err) {
    return { position, status: 'pending', error: String(err) };
  }
  const classification = classifyMarketOutcome(market, position.side);
  return { position, ...classification };
}

/**
 * Checks every open position, one poll per market. Sports resolution needs no shared
 * per-city grouping or external batch lookup (unlike the weather bot's checkSettlements,
 * which batches by city+date to minimize NWS CLI calls) -- each sports market resolves
 * independently, so this is a flat map, not a grouped batch.
 *
 * Returns results partitioned by outcome so the caller can act appropriately: credit P&L
 * for won/lost, leave pending positions untouched (retry next cycle), and surface void
 * positions for manual review rather than silently crediting a win or loss.
 */
async function checkSportsSettlements(openPositions, { concurrency = 10, throttleMs = 50 } = {}) {
  const results = [];
  for (let i = 0; i < openPositions.length; i += concurrency) {
    const batch = openPositions.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(checkOnePosition));
    results.push(...batchResults);
    if (i + concurrency < openPositions.length) await sleep(throttleMs);
  }

  return {
    won: results.filter((r) => r.status === 'won'),
    lost: results.filter((r) => r.status === 'lost'),
    void: results.filter((r) => r.status === 'void'),
    pending: results.filter((r) => r.status === 'pending'),
    unresolvable: results.filter((r) => r.status === 'unresolvable'),
  };
}

module.exports = {
  fetchMarketState,
  classifyMarketOutcome,
  checkOnePosition,
  checkSportsSettlements,
};
