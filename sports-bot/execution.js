// Sports execution module. Independent implementation of the same validated mechanics as
// polybot-v2/src/execution/pmClient.ts + executor.ts's openPosition -- not a cross-repo
// import. Two reasons: (1) polybot-v2 is TypeScript with its own build step, sports-bot is
// plain CommonJS with no TS toolchain -- importing compiled/source TS files across two
// unlinked local npm projects adds real fragility for no benefit; (2) the standing rule is
// "don't touch the weather bot's execution/ directory," and literal cross-repo importing
// would make this project's correctness silently dependent on files this project isn't
// supposed to modify. Same pattern already used for depthCheck.js (mirrors gatewayClient.ts)
// and settlementChecker.js (independently built, cross-checked against live data) -- the
// LOGIC is reused faithfully, the code is not shared.
//
// Own env vars (SPORTSBOT_*, not POLYMARKET_API_KEY/POLYBOT_CONFIRM_LIVE) -- zero shared
// runtime state with the weather bot, literally down to configuration. Can point at the
// same real Polymarket US account by setting the same secret values under these new names;
// nothing here reads polybot-v2's .env or config.
'use strict';

const { PolymarketUS } = require('polymarket-us');

const GATEWAY_BASE = process.env.SPORTSBOT_POLYMARKET_GATEWAY_URL || 'https://gateway.polymarket.us';
const API_BASE = process.env.SPORTSBOT_POLYMARKET_API_URL || 'https://api.polymarket.us';

let _client = null;

function hasCredentials() {
  return Boolean(process.env.SPORTSBOT_POLYMARKET_API_KEY && process.env.SPORTSBOT_POLYMARKET_API_SECRET);
}

function getPmClient() {
  if (_client) return _client;
  const keyId = process.env.SPORTSBOT_POLYMARKET_API_KEY;
  const raw = process.env.SPORTSBOT_POLYMARKET_API_SECRET;
  if (!keyId || !raw) {
    throw new Error('SPORTSBOT_POLYMARKET_API_KEY / SPORTSBOT_POLYMARKET_API_SECRET missing -- required for any authenticated call.');
  }
  const secretKey = raw.length > 44 ? raw : Buffer.from(raw, 'hex').toString('base64');
  _client = new PolymarketUS({ keyId, secretKey, gatewayBaseUrl: GATEWAY_BASE, apiBaseUrl: API_BASE });
  return _client;
}

/** 'paper' unless SPORTSBOT_CONFIRM_LIVE=yes AND credentials are present -- same gate shape as polybot-v2's currentMode(). */
function currentMode() {
  const confirmLive = (process.env.SPORTSBOT_CONFIRM_LIVE || 'no').trim().toLowerCase() === 'yes';
  return confirmLive && hasCredentials() ? 'live' : 'paper';
}

function roundPrice(p) {
  return Math.round(Math.max(0.01, Math.min(0.99, p)) * 100) / 100;
}
function roundQty(q) {
  return Math.round(q * 100) / 100;
}

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
 * Opens a position for a 'trade' decision from evaluateOpportunity(). Always a resting
 * maker-only LIMIT buy -- never a market/taker order, same discipline as the weather bot
 * (join the best bid to stay a maker; if there's no bid, come in a tick below the ask
 * rather than crossing it). In live mode this sets participateDontInitiate:true so the
 * exchange itself enforces maker-only execution.
 *
 * The real BBO fetch and price-rounding logic run in BOTH modes, not just live -- this
 * matters (added 2026-08-27): paper mode previously just assumed decision.price as the
 * fill, which could be stale by the time openPosition is actually called; pricing paper
 * fills off the real current BBO, the same join-bid/tick-below-ask rule live orders use, is
 * strictly more realistic and costs nothing extra (BBO is a public, unauthenticated read --
 * no credentials needed). ONLY the final authenticated order.create() submission is gated
 * by mode -- that's the one step that actually risks capital or requires credentials.
 *
 * decision: the {action:'trade', ...} object from evaluateOpportunity(), PLUS the exact
 * marketSlug/eventSlug the scanner captured at decision time (not reconstructed here), PLUS
 * side (see below).
 *
 * FIXED 2026-08-27: this used to hardcode intent:'ORDER_INTENT_BUY_LONG' unconditionally --
 * a real bug for any side='NO' bucket (NBA moneyline, MLB moneyline, 2 of the 3 buckets live
 * at the time this was found), which would have placed a wrong-side real order the instant
 * live mode was ever enabled (never caught in practice because the bot has only run in paper
 * mode, which doesn't call client.orders.create() at all). Polymarket US's CreateOrderParams
 * (confirmed directly against node_modules/polymarket-us/dist/index.d.ts) has no separate
 * outcome/token field -- each marketSlug is one binary market where ORDER_INTENT_BUY_LONG
 * buys YES and ORDER_INTENT_BUY_SHORT buys NO on that SAME slug. So the intent itself is the
 * only place "which side" gets expressed, and it must be derived from decision.side, not
 * assumed.
 */
async function openPosition(decision) {
  const mode = currentMode();

  if (decision.side !== 'YES' && decision.side !== 'NO') {
    return { ok: false, mode, reason: `unknown side ${JSON.stringify(decision.side)}, refusing to guess order intent` };
  }
  const intent = decision.side === 'YES' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT';

  let bestBid = null, bestAsk = null;
  let bboFetched = false;
  try {
    const data = await fetchJson(`${GATEWAY_BASE}/v1/markets/${encodeURIComponent(decision.marketSlug)}/bbo`);
    const md = data && data.marketData;
    if (md) {
      bestBid = md.bestBid && md.bestBid.value ? parseFloat(md.bestBid.value) : null;
      bestAsk = md.bestAsk && md.bestAsk.value ? parseFloat(md.bestAsk.value) : null;
      bboFetched = true;
    }
  } catch (err) {
    if (mode === 'live') {
      return { ok: false, mode, reason: `BBO fetch failed before live order placement: ${err}` };
    }
    // Paper mode: a live-data enhancement failing to fetch shouldn't fail the paper trade --
    // fall back to decision.price (the scanner's own real-fill-derived, already side-correct
    // price) instead.
  }

  // bestBid/bestAsk from /bbo are always YES-denominated. Confirmed live 2026-08-27 (two
  // separate real markets): marketData.shortQuote === 1 - bestBid and .longQuote === bestAsk
  // exactly -- i.e. shortQuote is the AGGRESSIVE/crossing price to go short (buy NO), the
  // complement of the YES bid. By the same join-bid-stay-passive discipline already used for
  // long, the PASSIVE/maker short price is the complement of the YES ASK (1 - bestAsk),
  // mirroring how the passive long price sits on the opposite side from the aggressive long
  // price (bestAsk). Not verified against a real short order.preview() call (would need live
  // credentials, deliberately not deployed for paper-mode-only operation) -- derived from a
  // confirmed real-data relationship, not guessed, but flagging the gap plainly.
  let entryPrice;
  if (decision.side === 'YES') {
    entryPrice = bestBid !== null ? bestBid : bestAsk !== null ? bestAsk - 0.01 : decision.price;
  } else {
    entryPrice = bestAsk !== null ? 1 - bestAsk : bestBid !== null ? (1 - bestBid) - 0.01 : decision.price;
  }
  entryPrice = roundPrice(entryPrice);
  const quantity = roundQty(decision.stake / entryPrice);
  const orderPayload = {
    marketSlug: decision.marketSlug,
    intent,
    type: 'ORDER_TYPE_LIMIT',
    price: { value: entryPrice.toFixed(2), currency: 'USD' },
    quantity,
    tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
    participateDontInitiate: true,
  };

  let orderId;
  if (mode === 'live') {
    try {
      const client = getPmClient();
      const res = await client.orders.create(orderPayload);
      orderId = res.id;
    } catch (err) {
      return { ok: false, mode, reason: `live order placement failed: ${err}` };
    }
  } else {
    // Paper mode: never submits orderPayload to the authenticated API -- assumes the
    // resting maker order fills at the computed entryPrice. Same optimistic simplification
    // as the weather bot: paper win rate is an upper bound on live fill quality, not a
    // fill-rate guarantee.
    orderId = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  return { ok: true, mode, orderId, entryPrice, quantity, bbo: { bestBid, bestAsk, fetched: bboFetched }, orderPayload };
}

// No separate close-position function: sports markets pay out automatically on resolution
// (settlementChecker.js detects this), unlike the weather bot's take-profit/stop-loss exits
// which need an explicit sell order. None of the validated buckets define an early-exit
// rule, so there's nothing analogous to build here yet.
async function getAccountBalance() {
  const client = getPmClient();
  const res = await client.account.balances();
  const usd = (res.balances || []).find((b) => b.currency === 'USD') || (res.balances || [])[0];
  return usd ? usd.buyingPower ?? usd.currentBalance : null;
}

module.exports = { getPmClient, hasCredentials, currentMode, openPosition, getAccountBalance };
