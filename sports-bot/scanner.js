// Sports market scanner. Ties together buckets.js + depthCheck.js + liveSizing.js into an
// end-to-end pipeline: discover open markets, price them, check horizon eligibility, check
// live depth, and produce trade/skip decisions -- no execution, this phase only produces
// correctly-shaped decisions.
//
// Two-API design (see report for why "pull from Gamma" alone doesn't work):
//   - Market DISCOVERY and IDENTITY come from gateway.polymarket.us -- the only source with
//     the authoritative event.slug/market.slug that depthCheck.js and any real order
//     placement need (verified in the settlement-checker phase: Gamma's own slug for the
//     same real-world game is differently formatted, e.g. no aec-/asc-/tsc- prefix, so it
//     cannot be substituted for the gateway's own identifiers).
//   - Live PRICE of our side comes from Gamma + data-api.polymarket.com/trades, reusing
//     bestFill() verbatim from the validated backtest scripts (same function, same
//     +/-3h search window, same BUY-side preference) -- this is "the per-side pricing logic
//     already validated," not a re-derivation, just called with targetTs=now instead of a
//     historical checkpoint offset.
'use strict';

const { BUCKETS, bandFor, makeBucketKey } = require('./buckets');
const { fetchLiveDepthUsd } = require('./depthCheck');
const { evaluateOpportunity } = require('./liveSizing');

const GATEWAY_BASE = 'https://gateway.polymarket.us';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const DATA_API_BASE = 'https://data-api.polymarket.com';
// Same window bestFill has always used throughout this project -- an opportunity is
// "in horizon" if now is within +/-3h of the bucket's defined checkpoint moment
// (gameStart - horizonHours), exactly mirroring how the backtest defined a liquid,
// fillable checkpoint.
const FILL_SEARCH_WINDOW_SEC = 3 * 3600;

const SPORTS_MARKET_TYPE_ENUM = {
  moneyline: 'SPORTS_MARKET_TYPE_MONEYLINE',
  spread: 'SPORTS_MARKET_TYPE_SPREAD',
  total: 'SPORTS_MARKET_TYPE_TOTAL',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'sports-bot/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
}

// Reused verbatim from finalWalkForwardApril2026.js -- this is THE validated per-side
// pricing logic. tokenId must already be the token of the side being priced (the caller
// picks yesToken vs noToken); this function does not flip anything.
function bestFill(trades, tokenId, targetTs) {
  let bestSameDir = null, bestSameDirDiff = Infinity;
  let bestAny = null, bestAnyDiff = Infinity;
  for (const tr of trades) {
    if (tr.asset !== tokenId) continue;
    const diff = Math.abs(tr.timestamp - targetTs);
    if (diff > FILL_SEARCH_WINDOW_SEC) continue;
    if (diff < bestAnyDiff) { bestAnyDiff = diff; bestAny = tr; }
    if (tr.side === 'BUY' && diff < bestSameDirDiff) { bestSameDirDiff = diff; bestSameDir = tr; }
  }
  const pick = bestSameDir || bestAny;
  return pick ? { price: pick.price, timestamp: pick.timestamp } : null;
}

function horizonEligible(gameStartTs, horizonHours, nowTs) {
  const targetTs = gameStartTs - horizonHours * 3600;
  return Math.abs(nowTs - targetTs) <= FILL_SEARCH_WINDOW_SEC;
}

/**
 * Discovers open, real single-game markets for one sport via the gateway. Filters by
 * sportsMarketTypeV2 explicitly rather than trusting gameStartTime blindly -- live-verified
 * 2026-08-26 that season-long futures/prop markets (e.g. "doubles leader") carry a
 * gameStartTime field too, sometimes MONTHS in the past, which is meaningless for that
 * market type and would otherwise slip through a naive date filter.
 */
async function findGatewayMarkets(sport) {
  const res = await fetchJson(`${GATEWAY_BASE}/v1/search?query=${sport}&limit=100`);
  const events = (res && res.events) || [];
  const results = [];
  for (const e of events) {
    if (e.closed || !e.active) continue;
    for (const m of e.markets || []) {
      const marketType = Object.keys(SPORTS_MARKET_TYPE_ENUM).find((k) => SPORTS_MARKET_TYPE_ENUM[k] === m.sportsMarketTypeV2);
      if (!marketType) continue; // not moneyline/spread/total -- futures, props, etc.
      if (!m.gameStartTime) continue;
      if (m.status !== 'MARKET_STATUS_OPEN') continue;
      results.push({ sport, eventSlug: e.slug, marketSlug: m.slug, marketType, gameStartTime: m.gameStartTime });
    }
  }
  return results;
}

/**
 * Resolves the Gamma-mirrored market for pricing, given the gateway's OWN market (not just
 * its event slug and coarse type) -- needed since 'spread' events aren't a single market on
 * either platform.
 *
 * FIXED (2026-08-27): the old version matched spread by `.includes('-spread-')` (first
 * match, no disambiguation), the exact same bug pickSubmarkets had -- confirmed live that an
 * event can carry up to 6+ structurally different spread contracts. Gateway's own spread
 * slugs are `asc-{eventSlug}-[f5-]{pos|neg}-{Npt5}`, always relative to the AWAY team
 * (pos=away covers +V/underdog, neg=away covers -V/favorite -- confirmed via real gateway
 * market metadata: marketSides[].team.ordering + the plain-English question text). Gamma's
 * own mirrored slugs are `{eventSlug}-[f5-]spread-{away|home}-{Npt5}`, where (also confirmed
 * via real question text, e.g. "Spread: Baltimore Orioles (-1.5)") outcomes[0]/yesToken is
 * ALWAYS the FAVORITE named in the slug covering the minus line, for both the -away- and
 * -home- variant. So: gateway neg-V (away is favorite) maps to Gamma spread-away-V, gateway
 * pos-V (home is favorite, since away is the underdog on that line) maps to Gamma
 * spread-home-V -- in BOTH cases Gamma's yesToken already means "the favorite on this line
 * covers", matching this bucket's canonical side definition (see buckets.js), so no
 * additional flip happens here. (There IS a real flip needed elsewhere -- which side of the
 * GATEWAY market itself to buy -- handled by evaluateGatewayMarket's gatewaySide, not here;
 * this function only resolves PRICING.)
 */
async function getGammaPricing(gm) {
  const strippedSlug = gm.eventSlug.replace(/^aec-|^asc-|^tsc-|^atc-/, '');
  const ev = await fetchJson(`${GAMMA_BASE}/events?slug=${strippedSlug}`);
  if (!ev || !ev.length) return null;
  const gammaEvent = ev[0];

  let matcher;
  if (gm.marketType === 'moneyline') {
    matcher = (m) => m.slug === strippedSlug;
  } else if (gm.marketType === 'spread') {
    const gwMatch = gm.marketSlug.match(/-(f5-)?(pos|neg)-(\d+pt\d+)$/);
    if (!gwMatch) return null;
    const isF5 = Boolean(gwMatch[1]);
    const gammaSide = gwMatch[2] === 'neg' ? 'away' : 'home';
    const points = gwMatch[3];
    const expectedSlug = `${strippedSlug}-${isF5 ? 'f5-' : ''}spread-${gammaSide}-${points}`;
    matcher = (m) => m.slug === expectedSlug;
  } else {
    matcher = (m) => m.slug.includes(`-${gm.marketType}-`);
  }

  const m = (gammaEvent.markets || []).find(matcher);
  if (!m) return null;
  let clobTokenIds;
  try {
    clobTokenIds = JSON.parse(m.clobTokenIds || '[]');
  } catch {
    return null;
  }
  if (clobTokenIds.length !== 2) return null;
  return { conditionId: m.conditionId, yesToken: clobTokenIds[0], noToken: clobTokenIds[1] };
}

/**
 * Evaluates one gateway-discovered market: horizon check, Gamma pricing lookup, band
 * matching, live depth, and the final evaluateOpportunity() call. Returns a decision
 * (trade/skip) or a scan-level skip (not eligible / no data) with a reason either way --
 * nothing is silently dropped.
 */
async function evaluateGatewayMarket(gm, holdoutTable, cashUsd, nowTs) {
  // Gateway only reports the COARSE type ('spread') via sportsMarketTypeV2 -- the specific
  // point value/f5-status live only in the slug. Bucket definitions for spread use the
  // GRANULAR type (e.g. 'spread_1.5', matching the historical dataset's submarketType label
  // exactly -- see fetchMLBFixed.js's pickSubmarkets), so the bucket lookup itself has to
  // parse the slug first for spread markets, not just match on gm.marketType directly.
  let effectiveMarketType = gm.marketType;
  let gwMatch = null;
  if (gm.marketType === 'spread') {
    gwMatch = gm.marketSlug.match(/-(f5-)?(pos|neg)-(\d+pt\d+)$/);
    if (!gwMatch) {
      return { ...gm, decision: { action: 'skip', reason: `spread market slug didn't match expected pos/neg structure: ${gm.marketSlug}` } };
    }
    const isF5 = Boolean(gwMatch[1]);
    const points = parseFloat(gwMatch[3].replace('pt', '.'));
    effectiveMarketType = `spread${isF5 ? '_f5' : ''}_${points}`;
  }

  const bucket = BUCKETS.find((b) => b.sport === gm.sport && b.marketType === effectiveMarketType);
  if (!bucket) {
    return { ...gm, decision: { action: 'skip', reason: `no validated bucket for ${gm.sport}/${effectiveMarketType}` } };
  }

  const gameStartTs = Math.floor(new Date(gm.gameStartTime).getTime() / 1000);
  if (!horizonEligible(gameStartTs, bucket.horizonHours, nowTs)) {
    const hoursToGame = (gameStartTs - nowTs) / 3600;
    return { ...gm, decision: { action: 'skip', reason: `not within ${bucket.horizon} horizon window (game in ${hoursToGame.toFixed(1)}h)` } };
  }

  // gatewaySide: which side (YES=long/NO=short) of THIS SPECIFIC gateway marketSlug realizes
  // the bucket's canonical proposition (bucket.side). For moneyline there's exactly one
  // gateway market per event, so this always equals bucket.side unchanged. For spread,
  // gateway offers two variant slugs per line (pos-V/neg-V, always relative to the away
  // team) -- neg-V's own long side already IS "the favorite covers" (matches bucket.side
  // directly), but pos-V's long side is "the underdog covers", the logical complement, so
  // realizing "favorite covers" on a pos-V market means going SHORT on that slug. This is
  // NOT the same thing as bucket.side (which stays fixed at the bucket's canonical
  // proposition for holdout-table lookup) -- gatewaySide is what execution.js actually needs
  // to pick BUY_LONG vs BUY_SHORT on gm.marketSlug.
  let gatewaySide = bucket.side;
  if (gwMatch) {
    const isPos = gwMatch[2] === 'pos';
    gatewaySide = isPos ? (bucket.side === 'YES' ? 'NO' : 'YES') : bucket.side;
  }

  let gamma;
  try {
    gamma = await getGammaPricing(gm);
  } catch (err) {
    return { ...gm, decision: { action: 'skip', reason: `Gamma pricing lookup failed: ${err}` } };
  }
  if (!gamma) {
    return { ...gm, decision: { action: 'skip', reason: 'no Gamma-mirrored market found for pricing' } };
  }

  let trades;
  try {
    trades = await fetchJson(`${DATA_API_BASE}/trades?market=${gamma.conditionId}&limit=200`);
    if (!Array.isArray(trades)) trades = [];
  } catch {
    trades = [];
  }

  // Band is assigned from a real fill on the YES side specifically (matches the bucket
  // definitions, which are all expressed as a YES-price band).
  const yesFill = bestFill(trades, gamma.yesToken, nowTs);
  if (!yesFill) {
    return { ...gm, decision: { action: 'skip', reason: 'no recent real trade to price this market (illiquid this far out)' } };
  }
  const band = bandFor(yesFill.price);
  if (band !== bucket.band) {
    return { ...gm, decision: { action: 'skip', reason: `price band ${band} does not match bucket's required band ${bucket.band} (YES fill ${yesFill.price})` } };
  }

  // Our side's execution price: a SEPARATE real fill on our own token, not derived by
  // flipping the YES fill -- this is the exact discipline that fixed the original bug.
  const ourToken = bucket.side === 'YES' ? gamma.yesToken : gamma.noToken;
  const ourFill = bucket.side === 'YES' ? yesFill : bestFill(trades, ourToken, nowTs);
  if (!ourFill) {
    return { ...gm, decision: { action: 'skip', reason: 'no recent real trade on our own side to price execution' } };
  }

  const availableDepthUsd = await fetchLiveDepthUsd(gm.marketSlug);

  const opp = {
    sport: gm.sport,
    // bucket.marketType (granular, e.g. 'spread_1.5'), NOT gm.marketType (coarse 'spread')
    // -- must match the historical dataset's submarketType label exactly, since
    // evaluateOpportunity's holdout-table lookup is keyed on makeBucketKey(sport,marketType,
    // horizon,band) and the holdout table itself was built from the granular label.
    marketType: bucket.marketType,
    horizon: bucket.horizon,
    band: bucket.band,
    side: bucket.side,
    gatewaySide,
    price: ourFill.price,
    resolutionDate: new Date(gm.gameStartTime), // no longer consumed by evaluateOpportunity (the NHL-total seasonal check that used it was removed along with that bucket); kept on the opportunity object as general context, harmless if unused
    availableDepthUsd,
    marketSlug: gm.marketSlug,
    eventSlug: gm.eventSlug,
  };

  const decision = evaluateOpportunity(opp, cashUsd, holdoutTable);
  return { ...gm, bucketKey: makeBucketKey(gm.sport, bucket.marketType, bucket.horizon, bucket.band), opp, decision };
}

/**
 * Full scan: all sports with a validated bucket, all open markets of the relevant types.
 * `nowOverride` exists only for diagnostic/test use (simulating "what if it were within the
 * horizon window right now") -- production calls always use the real current time.
 */
async function scanOnce(holdoutTable, cashUsd, { nowOverride } = {}) {
  const now = nowOverride || new Date();
  const nowTs = Math.floor(now.getTime() / 1000);
  const sportsNeeded = [...new Set(BUCKETS.map((b) => b.sport))];

  const results = [];
  for (const sport of sportsNeeded) {
    let markets;
    try {
      markets = await findGatewayMarkets(sport);
    } catch (err) {
      results.push({ sport, decision: { action: 'skip', reason: `scan failed: ${err}` } });
      continue;
    }
    for (const gm of markets) {
      const result = await evaluateGatewayMarket(gm, holdoutTable, cashUsd, nowTs);
      results.push(result);
      await sleep(50);
    }
  }
  return results;
}

module.exports = { scanOnce, findGatewayMarkets, getGammaPricing, evaluateGatewayMarket, bestFill, horizonEligible, FILL_SEARCH_WINDOW_SEC };
