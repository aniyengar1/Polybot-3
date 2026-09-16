# Kalshi order-placement API — research writeup (2026-09-08)

**Pure research, no code changes.** This is groundwork for a future real-order-execution build,
once kalshi-bot is closer to a go-live decision. Nothing in the running bot, `buckets.js`,
`liveSizing.js`, `orchestrator.js`, or `kalshiClient.js` was touched. `kalshiClient.js` today
only wires up read endpoints (`getOpenMarkets`, `getMarket`, `getCandlesticks`, `getOrderbook`),
all public/unauthenticated; there is no order-creation code anywhere in this project.

**Sources**: Kalshi's official OpenAPI spec, fetched and grepped directly (`curl
https://docs.kalshi.com/openapi.yaml`, spec title "Kalshi Trade API Manual Endpoints" v3.29.0,
328KB) — not summarized secondhand. Cross-checked against the rendered docs pages at
docs.kalshi.com for the human-readable framing. Everything below cites which of the two it came
from; anything not directly confirmed in either is flagged explicitly, not presented as fact.

**One methodological note worth recording**: `WebFetch`-style summarization of a docs page
initially returned a plausible-looking but WRONG schema for the create-order request (fields
`action`, `event_ticker`/`market_ticker`, `order_type`, `yes_price`/`no_price` — which don't
exist on the actual current create-request schema). Raw-curling the OpenAPI YAML and grepping it
directly resolved the discrepancy. Turned out that summary wasn't pure hallucination — those
exact field names genuinely exist elsewhere in the spec, just on the **deprecated** `Order`
response object, not the current create-request. Recording this because it's a real trap: an
AI-summarized fetch of Kalshi's docs can silently blend current and deprecated field names, and
the only way to know which is which was to read the raw spec.

---

## 1. The actual order-creation endpoint

**Confirmed current path**: `POST /portfolio/events/orders`
(`operationId: CreateOrderV2`, schema `CreateOrderV2Request`).

Full URL using this project's existing base (`kalshiClient.js`'s `API_BASE`):
`https://api.elections.kalshi.com/trade-api/v2/portfolio/events/orders`. The spec lists this
exact host as a valid production server ("Production shared API server, also supported"),
alongside `https://external-api.kalshi.com/trade-api/v2` as the primary listed production host.
Both work; this project already standardized on the `api.elections.kalshi.com` one for reads.

**There used to be a `POST /portfolio/orders` (legacy, singular, no version suffix).** As of this
spec snapshot that path only supports `GET` (list orders) and `GET .../{order_id}` (single order
status) — the ability to *create* via that path is already gone from the current spec. The docs
page for it 404s. `POST /portfolio/events/orders` (V2) is the only way to create an order today.
Its own description: *"The legacy `/portfolio/orders` endpoint will be deprecated no earlier
than May 6, 2026 — clients should migrate to this path."* That date has already passed as of
this research (2026-09-08); worth assuming the legacy path could disappear at any time, not
relying on it even if it still technically responds somewhere.

**Request fields** (`CreateOrderV2Request`, required marked):

| Field | Required | Type | Notes |
|---|---|---|---|
| `ticker` | ✅ | string | Market identifier |
| `side` | ✅ | enum `bid`\|`ask` | **Not** yes/no — see below |
| `count` | ✅ | fixed-point string, ≤2 decimals | e.g. `"10.00"` |
| `price` | ✅ | fixed-point dollar string, 2-4 decimals | e.g. `"0.5600"` |
| `time_in_force` | ✅ | enum `fill_or_kill`\|`good_till_canceled`\|`immediate_or_cancel` | |
| `self_trade_prevention_type` | ✅ | enum `taker_at_cross`\|`maker` | |
| `client_order_id` | optional | string | idempotency key, see §7 |
| `expiration_time` | optional | int64 Unix seconds | see §4 |
| `post_only` | optional | boolean | |
| `cancel_order_on_pause` | optional | boolean | |
| `reduce_only` | optional | boolean | caps count by current position |
| `subaccount` | optional | integer | 0 = primary |
| `order_group_id` | optional | string | |
| `exchange_index` | optional | integer | shard; omit for auto-routing |

**No `action` (buy/sell) or `order_type` (limit/market) field exists on the create request.**
Those names *do* exist, but only on the `Order` response object, explicitly marked
`deprecated: true`, with this note: *"Deprecated. Use `outcome_side` (or `book_side`) instead...
This field will not be removed before May 14, 2026"* — another date already in the past as of
this research. Don't build new code against `action`/`side`(yes/no)/`is_yes`; they're on their
way out.

**How YES vs. NO actually gets selected**, confirmed from the `BookSide` schema description
verbatim: *"For event markets, this refers to the YES leg only: `bid` means buy YES, `ask` means
sell YES. (Selling YES is economically equivalent to buying NO at `1 - price`, but this endpoint
quotes everything from the YES side.)"* So: to buy YES at price P, submit `side=bid, price=P`.
To buy NO at price Q, submit `side=ask, price=1-Q`. This is exactly the same complementary-price
algebra `kalshiClient.js`'s `getOrderbook()` already uses for reads (`bestYesAsk = 1 -
bestNoBid`) — the mental model this project already has for the read side carries over directly
to the write side, no new concept needed.

**"Limit vs. market" has no literal request field.** The order is always submitted with an
explicit `price` (required, no way to omit it for a "market order" in the traditional sense). A
marketable/aggressive fill is achieved by combining an aggressive `price` with
`time_in_force: immediate_or_cancel` or `fill_or_kill`, not by a separate order-type selector.
The resulting `Order` object *does* carry a `type: [limit, market]` field after the fact — the
spec doesn't spell out exactly how that classification gets derived from the request, so I'm
not certain whether it's inferred from price aggressiveness, from `time_in_force`, or something
else. Flagging this as genuinely unclear rather than guessing.

## 2. Is the existing RSA-PSS signing sufficient for order endpoints?

**Yes, the mechanism is identical — but the implementation is untested.** Every endpoint I
checked (reads and the order-creation/cancel endpoints alike) references the exact same three
security schemes: `kalshiAccessKey` (header `KALSHI-ACCESS-KEY`), `kalshiAccessSignature`
(header `KALSHI-ACCESS-SIGNATURE`, "RSA-PSS signature of the request"), `kalshiAccessTimestamp`
(header `KALSHI-ACCESS-TIMESTAMP`, milliseconds). There is no separate/different auth scheme for
write endpoints in the spec. `kalshiClient.js`'s existing `signRequest(method, path)` — building
`${timestampMs}${method}${path}` and RSA-PSS-signing it — is structurally the right shape.

**Two real caveats, not "it just works":**
- **The signing code has never actually been exercised against Kalshi's servers.** Every
  `fetchJson` call this project has ever made used `authPath: null` (public reads only,
  confirmed live 2026-09-04 per `kalshiClient.js`'s own header). The RSA-PSS path is
  implemented but zero-tested. Before ever attempting a real order, I'd want to first prove the
  signature against a cheap authenticated GET (e.g. `GET /portfolio/balance`) — if that 401s,
  the signing logic needs debugging before an order attempt is even meaningful to try.
- **This project has no API key at all yet.** Per the README, `KALSHIBOT_API_KEY_ID` /
  `KALSHIBOT_PRIVATE_KEY_PEM` were "never set" — there's nothing to sign with. Confirmed from
  the spec's `ApiKeyScope` enum (`read`, `write`, plus narrower child scopes like `write::trade`,
  `write::transfer`, `read::portfolio_balance`) that **API keys are scope-gated**, default to
  full `read`+`write` if unspecified at generation time, but can be minted read-only. A
  read-only key (if one were generated for monitoring purposes) would 401 on order creation —
  worth making sure whichever key eventually gets generated explicitly includes `write` (or the
  narrower `write::trade`) before assuming auth "should just work."

## 3. Rate limits for order placement/cancellation vs. reads

**Confirmed real and separate from read limits — two independent token buckets per account
(`read` and `write`), not shared.** From the spec's `BucketLimit` schema: each bucket refills at
a fixed `refill_rate` tokens/second up to `bucket_capacity`; a request is allowed if the bucket
holds enough tokens for its cost, otherwise HTTP 429. Per-endpoint costs found in the spec:

| Operation | Cost |
|---|---|
| Default (anything not listed below, incl. `GetMarketOrderbook`) | 10 tokens |
| `POST /portfolio/events/orders` (create, single) | 10 tokens (no override found — uses default) |
| `POST /portfolio/events/orders/batched` (batch create) | 10 tokens **per order in the batch** |
| `DELETE /portfolio/events/orders/{id}` (cancel, single) | 2 tokens |
| `DELETE .../batched` (batch cancel) | 2 tokens **per order** |
| `GET /portfolio/orders/{id}` (order status) | 2 tokens |
| `CancelAllOrders` | 2 tokens flat |

Concrete per-tier numbers, from the rendered rate-limits page (not independently re-verified
against raw spec text, but internally consistent with the `BucketLimit` mechanism description I
did verify directly):

| Tier | Read (refill/cap) | Write (refill/cap) |
|---|---|---|
| Basic | 200/s, 200 | 100/s, 100 |
| Advanced | 300/s, 300 | 300/s, 600 |
| Expert | 600/s, 600 | 600/s, 1,200 |
| Premier | 1,000/s, 1,000 | 1,000/s, 2,000 |
| Paragon | 2,000/s, 2,000 | 2,000/s, 4,000 |
| Prime | 4,000/s, 4,000 | 4,000/s, 8,000 |
| Prestige | 10,000/s, 10,000 | 8,000/s, 16,000 |

Tiers above Basic are earned automatically from trailing-30-day trading volume; Basic→Advanced
can be requested manually via an "Upgrade Account API Usage Level" endpoint.

**For this project's actual scale, this is not a binding constraint even at the lowest tier.**
At Basic (100 write-tokens/s), that's ~10 order-creates/sec sustained, or ~50 cancels/sec —
this bot's entire live history has been well under one trade per minute. The orderbook-polling
this bot already does (including the shadow-execution feature's 2s-interval polling) draws from
the separate **read** bucket and would never compete with order-placement's **write** budget —
confirmed explicitly: *"Read: GET endpoints and anything not routed to Write. Write: Order
placement, amends, cancels, order groups, the RFQ quote flow, and block trade proposal
accepts."* Heavy read polling and real order placement genuinely don't share a budget.

## 4. Order lifecycle: cancel, status, partial fills, and a GTT-equivalent

- **Cancel a resting order**: `DELETE /portfolio/events/orders/{order_id}` (2 tokens). Query
  params: `subaccount` (optional), `market_ticker` + `exchange_index=-1` for auto-routing to the
  right shard. Returns `{order_id, client_order_id, reduced_by}`. There's also `CancelAllOrders`
  (`DELETE /portfolio/events/orders`, flat 2 tokens) and a batch cancel
  (`DELETE .../orders/batched`, 2 tokens/order).
- **Check status**: `GET /portfolio/orders/{order_id}` (2 tokens). Returns the full `Order`
  object: `status` (enum `resting`\|`canceled`\|`executed`), `fill_count_fp` / `remaining_count_fp`
  (cumulative, updated on each partial match), `last_update_time` ("modify, cancel, fill").
- **Partial fills**: the `Order` object only gives you the *aggregate* fill count at any moment.
  For the actual sequence of individual partial-fill events, use `GET /portfolio/fills`
  (filterable by `order_id`) — each match is its own fill record there.
- **A genuine GTT-equivalent exists, and it's a real simplification for the maker-then-taker
  design.** Confirmed directly from the `time_in_force` field description: *"Use
  `good_till_canceled` with `expiration_time` for an order that should rest until a specific
  expiration time; without `expiration_time`, `good_till_canceled` is a true good-till-canceled
  order."* (Note: the spec explicitly says *"`GTT` is an internal execution type and is not a
  valid API value for `time_in_force`"* — you don't pass the string `"GTT"`, you get GTT
  *behavior* by pairing `good_till_canceled` + `expiration_time`.) This means: submit one order
  with `time_in_force=good_till_canceled`, `price=`(join-the-bid price),
  `expiration_time=now+60`, and the **exchange itself** cancels the resting order at 60 seconds
  if unfilled — no manual polling-and-cancel loop needed on this project's side, unlike the
  current shadow-execution simulation's own 2-second poll loop (which only exists because that's
  a simulation with no real resting order to let the exchange manage). You'd still need to poll
  or use the WebSocket feed to *learn* whether it filled or expired, but the cancellation timing
  itself becomes the exchange's problem, not this project's. `time_in_force` also can't combine
  `expiration_time` with `immediate_or_cancel` (explicitly disallowed per the same field
  description) — that combination doesn't make sense anyway since IOC already resolves
  immediately.
- **Not independently verified here, flagged as a pointer only**: the spec notes *"combine API
  responses to PUT/POST/DELETE requests with WebSocket data to obtain the most accurate view of
  the exchange state"* — implying a WebSocket order/fill-update channel exists (documented in a
  separate `asyncapi.yaml`, which I did not fetch for this research). Worth a follow-up look if
  a real implementation wants push-based fill notification instead of polling `GetOrder`.

## 5. Sandbox / demo mode

**Yes, a genuine API-level demo environment exists**, confirmed from the official demo-env docs
page:
- REST base: `https://external-api.demo.kalshi.co/trade-api/v2` (also `demo-api.kalshi.co`,
  per the OpenAPI spec's server list)
- WebSocket: `wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2`
- **Credentials are separate from production** — a demo API key/PEM pair, not the same one used
  for reads today (which don't even exist yet per §2).
- Funded with mock money (test-card mechanics for adding mock funds, no funds preloaded).
- **Explicit, important caveat, quoted directly**: *"the price and behavior of markets in the
  demo environment may not be reflective of those in real markets."* This means demo mode is
  good for proving the order-placement/cancel/status *mechanics* work end-to-end (right
  request shape, signature verifies, response parses correctly) — it is **not** good for
  learning anything about real fill rates, real spread behavior, or whether a passive limit
  order would actually get crossed in real market conditions. That question can only be
  answered in production (which is exactly what the shadow-execution simulation is already
  doing, safely, without this API at all).

## 6. Mechanical constraints: minimum size, tick size

- **Minimum order size**: not stated as a fixed "minimum count" anywhere in the spec I found.
  What *is* explicit: **fractional contracts are supported** — `FixedPointCount`'s description
  states *"the minimum granularity is 0.01 contracts."* This is a genuinely notable finding for
  this project specifically: every sizing calculation in `liveSizing.js` today assumes integer
  contracts (`Math.floor(riskDollars / ...)`, decrementing by whole contracts to fit the fee
  formula). If a real-execution build wants to use the API's actual size granularity, that
  integer assumption would need revisiting — not urgent now, but worth flagging since it's easy
  to miss.
- **Tick size / price increment: not a single universal number, confirmed per-market.** The
  `Market` object carries a `price_ranges` array of `{start, end, step}` objects — "Price step/
  tick size for this range in dollars." A market can have multiple price ranges each with their
  own tick size (a very common prediction-market pattern: finer ticks near the extremes,
  coarser near 50¢). There's no fixed "$0.01 everywhere" answer — this needs to be read from
  each specific market's own metadata (`GET /markets/{ticker}`) at decision time, not hardcoded.

## 7. Idempotency and failure handling

**Partially confirmed, partially inferred — flagging the line clearly.** What's directly in the
spec: `client_order_id` is an optional string field on the create request, echoed back on the
`201` response, and `409 Conflict` is a listed possible response for `CreateOrderV2`. The spec's
generic `ConflictError` description ("resource already exists or cannot be modified") is vague
and does **not** explicitly state "a duplicate `client_order_id` gets rejected with 409" in so
many words — that's the standard idempotency-key pattern and is almost certainly what's
happening (it's also how the field behaves in third-party guides and community SDKs I checked),
but I could not find an explicit sentence in Kalshi's own spec confirming the exact dedup window
or guarantee. **Treat "resubmitting with the same `client_order_id` after a timeout is safe" as
a reasonable, standard-pattern inference, not confirmed official documentation** — worth a
direct support/docs confirmation before relying on it for real capital.

**On network timeouts specifically**: the spec itself has no prose section on retry safety. The
one general principle I'm confident stating: `POST`/`DELETE` are not naturally idempotent
without a client-supplied key, so a bare retry-without-`client_order_id` on a timed-out order
creation risks a duplicate order if the original actually succeeded server-side before the
response was lost. `GET`s (status checks) are safe to retry freely — they're just reads. The
safe pattern (and it's what `client_order_id` exists for): always generate one per intended
order before sending, and on ambiguous failure (timeout, 5xx), re-poll `GET /portfolio/orders`
filtered by that `client_order_id` (or `GET /portfolio/orders/{order_id}` if the ID was
returned) to discover the true state before ever considering a second submission — never
blind-retry a create with a fresh ID after an ambiguous failure.

## Summary of genuinely open/unverified items

- Exact derivation rule for the `Order.type` (`limit`/`market`) classification on the response.
- Exact `client_order_id` dedup guarantee/window (inferred standard pattern, not spec-confirmed).
- WebSocket order/fill-update channel exists per a passing mention, not independently fetched
  from the separate `asyncapi.yaml` spec.
- Whether Kalshi's real maker-fee formula (confirmed to exist as a *distinct* concept —
  `Order.maker_fees_dollars`/`taker_fees_dollars` are separate fields, and `FeeType` includes a
  `quadratic_with_maker_fees` enum value) uses a specific published formula — this directly
  bears on the shadow-execution feature's known simplification (it currently taxes simulated
  maker fills at the same rate as taker fills, flagged in `db.js`'s schema comment as likely
  understating real maker P&L). Confirming the *existence* of a maker-specific fee schedule here
  is new information relative to that earlier flag; the exact rate still isn't nailed down.
