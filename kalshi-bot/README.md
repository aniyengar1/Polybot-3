# kalshi-bot

Paper-trading system for Kalshi's 15-minute gold/silver/WTI "up or down" markets
(`KXGOLD15M`, `KXSILVER15M`, `KXWTI15M`). A new, independent integration -- own auth, own market
discovery, own DB, own execution/settlement code. No shared code or runtime state with
`sports-bot/` or `polybot-v2` beyond mirrored architectural conventions (better-sqlite3 +
WAL, scan/decide/execute/settle shape).

## Strategy, and where it came from

**Gold/silver**, checked at a fixed checkpoint 8 minutes before each 15-minute window
closes: **Gold 0.7-0.8, Gold 0.5-0.6, Silver 0.8-0.9** (band = the market's own YES price at
the checkpoint). This is grounded in real backtesting done in a separate project
(`/Users/anirudhiyengar/soccer-research/`, session `d4ebdfba-...`), specifically
`KALSHI_GOLD_SILVER_THREE_BUCKET_BACKTEST.md`: $200 -> $291.12 (+45.56%) over a 33-day,
519-trade, 66.3%-win-rate run.

**Confidence is uneven across the 3 buckets on purpose**, because the evidence backing them
is uneven -- see `buckets.js`'s header for the full provenance chain. Silver 0.8-0.9 was
originally believed to have independent corroboration across 3 separate backtests tonight; the
two Gold buckets cleared only one test, and that test's own writeup states they were partly
selected using data from the same window this run's P&L is measured on. This is reflected
directly in code, not just in this doc: Silver 0.8-0.9 was given a larger `kellyFraction`
(0.15 vs 0.08) and a lighter shrinkage `k` (20 vs 40) in `buckets.js`'s `BUCKET_CONFIG`.
**RETIRED 2026-09-07**: Silver 0.8-0.9's "strongest claim" turned out to be a YES/NO-mixing
calibration bug, not a real edge -- see `buckets.js`'s 2026-09-07 header block for the full
writeup. It's still listed in `BUCKET_CONFIG` (status:`retired`) so it keeps resolving on the
dashboard, but no longer trades.

**WTI** (added 2026-09-04), grounded in `/Users/anirudhiyengar/soccer-research/
KALSHI_WTI_NATGAS_COPPER_BIDIRECTIONAL_TEST.md`. Unlike gold/silver, WTI's confirmed rules
fire at **three different checkpoints within the same 15-minute window** (3/6/8 minutes
before close) -- see "Multi-checkpoint scheduling" below for what that required. Three
buckets:
- **0.3-0.4 @ 3min-before-close, buy-NO** (longshot-overpriced): search halves -13.2pp/-8.0pp,
  thirds -10.8/-15.0/-5.9pp, holdout n=34 -2.0pp, confirmed.
- **0.3-0.4 @ 8min-before-close, buy-NO**: search halves -2.3pp/-9.9pp, thirds
  -5.3/-7.3/-5.8pp, holdout n=71 -3.1pp, confirmed -- independently confirms the rule above,
  making this pair the cleanest result of the WTI test (both cross-checkpoint-agreeing
  members independently passed holdout, no internal contradiction).
- **0.6-0.7 @ 6min-before-close, buy-YES** (favorite-underpriced): search halves
  +11.3pp/+11.8pp, thirds +8.0/+17.3/+9.4pp, holdout n=66 +5.8pp, confirmed per the
  pre-committed rule -- **but** its cross-checkpoint partner (7min, same bucket) agreed in
  search and then reversed sign on holdout (-6.2pp). Weaker evidence than any other bucket in
  this bot, including the two probationary Gold buckets. **Traded log-only**: see "Log-only
  buckets" below -- every qualifying signal is recorded (checkpoint price, would-be size,
  eventual outcome), but no paper bankroll is ever actually staked on it.

Natural Gas (`KXNATGAS15M`) and Copper (`KXCOPPER15M`) were confirmed as real products in the
same test but are **not** added here: only ~8 days of history each at test time, explicitly
flagged as insufficient data to populate even one (bucket, checkpoint) cell at n>=60 -- a
"come back later" call, not a tested-and-failed null. Revisit once they have history
comparable to WTI's current ~5 weeks.

**Crypto probationary rules** (added 2026-09-06), grounded in `/Users/anirudhiyengar/
soccer-research/KALSHI_CRYPTO_ALTCOIN_BUCKET_TEST.md`, `KALSHI_BTC_ETH_BUCKET_TEST.md`, and
`KALSHI_DOGE_BTC_COMBINED_BACKTEST.md` -- see `buckets.js`'s header for full per-rule
provenance. 7 rules across `KXDOGE15M`/`KXBTC15M`: DOGE 0.8-0.9 buy-YES (cp6/8/11, confirmed at
all 3 independent checkpoints + holdout), BTC 0.2-0.3 buy-NO (cp6/8, confirmed at both) and BTC
0.8-0.9 buy-YES (cp9/11, confirmed at both). **These are explicitly NOT independence-confirmed
yet** -- the combined backtest's own verdict states plainly it "does not clear any of the three
candidates for kalshi-bot's live `BUCKET_CONFIG`... Stage 1 (checking each rule against real,
never-touched data) remains the actual test." Adding them here, tagged `status: 'probationary'`
and monitored separately (see "Probationary buckets" below), **is** that Stage 1 test -- their
own live paper trades from this point forward are the never-touched data the backtest couldn't
provide. `kellyFraction: 0.08` (this project's existing weak-evidence tier) and
`shrinkageK: 30` (validated in `backtestDogeBtcCombined.js`, `w = n/(n+30)`) for all 7 -- the
1% per-trade risk cap that backtest validated is unchanged from the existing global
`KELLY_CAP_PCT`, no code change needed there.

## Multi-checkpoint scheduling

Gold/silver only ever needed one checkpoint per window (8min-before-close), so the original
scheduler just slept to one instant per window. WTI's three rules need three different
checkpoints (3/6/8min-before-close) within the *same* window, so `orchestrator.js` now derives
the full set of distinct checkpoint-minutes values straight from `buckets.js`'s
`BUCKET_CONFIG` and sleeps to each one in turn, evaluating only the series that have a bucket
configured at that particular checkpoint. This is general, not WTI-specific: Natural Gas and
Copper will use the same mechanism once they have enough history for their own buckets --
adding them means a new `BUCKET_CONFIG` entry, not new scheduler code. Verified this is a
strict generalization (gold/silver's schedule, trades, and DB rows are unchanged by it) before
merging. Confirmed again when the crypto rules were added (2026-09-06): `allCheckpointMinutes()`
picked up the new 9min/11min values and `seriesForCheckpointMinutes()` routed KXDOGE15M/KXBTC15M
to the right checkpoints automatically, with zero scheduler code touched -- just new
`BUCKET_CONFIG` entries, exactly as designed.

Bucket keys now carry the checkpoint explicitly (`{series}|{band}|cp{minutes}`, e.g.
`KXWTI15M|0.3-0.4|cp3`) so the same series/band pair at two different checkpoints doesn't
collide. Pre-existing gold/silver rows are migrated to this format automatically on startup
(`db.js`'s `migrateLegacyBucketKeys`) -- one-time, idempotent, no manual step needed.

## Log-only buckets

A bucket configured with `logOnly: true` in `buckets.js` (currently just WTI's 0.6-0.7/cp6
rule, per its holdout-sign-flip caveat above) is still scanned and sized exactly like any
other bucket -- side, would-be contracts, would-be stake are all computed and recorded, and
the eventual outcome is settled the same way -- but the `trades.log_only` column is set to 1,
which means: **`getBankrollUsd()` never counts it** (real paper bankroll is untouched), and
`node cli.js positions`/`performance` report it in a clearly separate section, not mixed in
with staked trades. This is a genuine structural distinction, not a `kellyFraction: 0`
approximation that would still look like a real trade in the CLI output.

## Probationary buckets

A bucket configured with `status: 'probationary'` in `buckets.js` (currently the 7 DOGE/BTC
crypto rules above) is sized and staked with real paper bankroll exactly like a validated
bucket -- this is a different, less restrictive flag than `logOnly` (which never stakes real
money at all). What's different: every such trade is tagged `bucket_status = 'probationary'`
in the DB (`trades.bucket_status`, default `'validated'` for everything else), which lets
`node cli.js probation`/the dashboard filter and review these separately from gold/silver/WTI
without touching them. `decayWatch.js`'s `checkProbationReviews` watches each probationary
bucket's live settled trade count and, the first time it reaches n=30 (`MIN_CALIBRATION_N`),
fires a one-time, persistent `probation_review_alerts` row (never auto-cleared, surfaced first
in `node cli.js status` and on the dashboard) -- the explicit trigger to go compare that rule's
real live record against its original search/holdout edge, per the provenance in `buckets.js`'s
header. Because `BUCKET_CONFIG` is a flat, independently-keyed object, pulling one decaying
probationary rule later is just deleting its one entry -- no structural change needed, same as
how MLB spread was previously pulled from sports-bot's `buckets.js`.

## Known caveat: within-band direction isn't hard-enforced

Side selection (buy-YES vs buy-NO) is derived live from each checkpoint's shrunk calibrated
hit rate vs. the market price -- the same mechanism gold/silver already used, reused as-is for
WTI rather than hardcoding a fixed direction per bucket, per the "follow the existing
architecture exactly" instruction this was built under. In practice this means the "buy-NO"/
"buy-YES" labels above are what the config's backtested hit rate makes *most* likely across
the band, not a hard guarantee for every price in it: e.g. WTI 0.3-0.4/cp8's shrunk edge
actually flips to buy-YES for checkpoint prices below ~0.324 (roughly the bottom quarter of
that band), a real, checked artifact of shrinking a per-band-average hit rate toward a
within-band price. The same effect exists in gold's existing buckets too (a much narrower
sliver near the very top of the 0.7-0.8 band), so this isn't a new risk introduced by WTI --
just newly quantified while adding it. **Also checked directly for the new crypto buckets**:
several of the 0.8-0.9 buy-YES rules (DOGE cp6/cp8/cp11, BTC cp9/cp11) flip to buy-NO or skip
entirely for checkpoint prices in roughly the top 1-5% of the band (e.g. ~0.895-0.9), same
mechanism, same magnitude as gold's existing sliver -- not a new failure mode introduced by
this batch. BTC 0.2-0.3 (buy-NO, cp6/cp8) stayed consistently buy-NO across its whole band in
testing, no flip found. Flagging plainly rather than silently patching, since "fixing" it would
mean hardcoding a direction override this bot's architecture doesn't otherwise have anywhere.

## Sizing

Fractional Kelly, tighter than `sports-bot/liveSizing.js`'s 22.5%-of-Kelly / 2%-cap:
per-bucket Kelly fractions of 0.08-0.15 (vs sports-bot's uniform 0.225), and a **hard 1% of
bankroll cap per trade** (vs 2%). Justification: this trades ~15.7x/day across 3 buckets
versus sports-bot's ~1x/day, so the same per-trade cap compounds intraday risk much faster
here -- a bad run of same-direction miscalibrated bets has far more chances to fire in one
day.

Before any bucket's empirical hit rate feeds the Kelly formula, it's **shrunk toward the
market's own price**: `pShrunk = (hits + k*price) / (n + k)` (`calibration.js`). This is a
direct, explicit guard against sizing up on a fading edge -- not a hypothetical concern:
Silver 0.0-0.1 and Silver 0.1-0.2, two adjacent buckets in this exact product, looked real on
a coarser check tonight and then collapsed to near-zero edge in the most recent third of the
same test window (`KALSHI_GOLD_SILVER_15MIN_TEST.md`). `k` itself is per-bucket (originally 20
for Silver 0.8-0.9, 40 for the two Gold buckets), so the weaker-evidence buckets get pulled
harder toward the market's read -- though Silver 0.8-0.9's own `k=20` is moot in practice as of
2026-09-07: that bucket is retired (see above), its `kellyFraction`/`k` left unchanged in
`buckets.js` only because retirement makes them dead values, not because they're still trusted.

Calibration itself is walk-forward, not a static backtested number frozen at launch: it
starts from the backtested baseline (`buckets.js`'s `backtestBaseline`, satisfying the "use
the empirical historical hit-rate rule already established in backtesting" requirement) and
folds in this bot's own settled paper outcomes once per UTC day (`calibration.js`), exactly
mirroring the walk-forward discipline validated in
`KALSHI_GOLD_SILVER_15MIN_WALKFORWARD_BACKTEST.md` -- that backtest showed daily
recalibration naturally decays a dying bucket's trade frequency and losses toward zero with
no separate decay-detection logic, purely because the calibrated edge itself shrinks.

## Decay watch

`decayWatch.js` is a **monitor**, not a second sizing control -- the walk-forward
recalibration above already self-corrects a fading bucket's *sizing*. This module makes that
visible: after every settlement pass, it compares each bucket's trailing 30 settled trades
against its backtested baseline win rate/P&L and, if the rolling win rate is >20pp below
baseline or rolling P&L has gone negative against a baseline that was positive (with a
minimum of 10 rolling trades to avoid noise), it logs a loud `!!! DECAY ALERT !!!` line and
writes a permanent row to the `decay_alerts` table -- never auto-cleared, surfaced at the top
of `node cli.js status` whenever any exist. It does not halt trading on its own; a flagged
bucket is a strong signal for a human to look at `node cli.js decay` and `performance`, not
an automatic kill switch the task didn't ask for.

## Fees

Real, verified Kalshi taker fee: `round_up(0.07 * contracts * price * (1-price))`, rounded
UP once on the whole order (not per-contract) -- confirmed via
`KALSHI_15MIN_FEE_SURVIVAL.md` and re-confirmed for gold/silver specifically in
`KALSHI_GOLD_SILVER_15MIN_TEST.md`. Floors at $0.01 near price extremes fall out of the
ceil-to-cent naturally, no special-casing needed. Single entry only (hold-to-settlement, no
round-trip), matching what was actually backtested. See `liveSizing.js`'s header for the one
deliberate deviation from the backtest scripts' own fee approximation (aggregate rounding vs
per-contract-then-multiply -- the real schedule, not a change to the backtested numbers).

## Spread capture (instrumentation only, no findings yet)

Added 2026-09-06: every trade row now also records `yes_bid_at_checkpoint` /
`yes_ask_at_checkpoint` -- the real top-of-book YES-side bid/ask (`kalshiClient.js`'s
`getOrderbook`, confirmed live against the real `/markets/{ticker}/orderbook` endpoint) at the
same moment `market_price` (a candlestick close) is captured. **Purely additive -- feeds
nothing in sizing, side selection, or any other decision path.** The point: every backtest and
every paper trade in this bot has always assumed the checkpoint's candlestick price *is* the
fill price, with no bid/ask crossing modeled (see "Paper-only, structurally" below). Once
enough trades accumulate per bucket, this makes it possible to actually check that assumption
against what a real taker order crossing the real spread would have cost, instead of taking it
on faith. Applies to every series and every bucket going forward (gold/silver/WTI and all 7
crypto rules, validated and probationary alike) -- not scoped to the probationary rules alone.
Nullable and best-effort: a failed orderbook fetch (network error, empty book on one side)
leaves both fields `NULL` rather than blocking or altering the trade itself. No findings yet by
design -- the comparison only becomes meaningful once real volume accumulates.

## Paper-only, structurally

**There is no function anywhere in this codebase that submits a real order.**
`execution.js`'s `openPosition` is a pure simulation -- no network call, no credentials. An
auth module (`kalshiClient.js`, RSA-PSS per Kalshi's real `KALSHI-ACCESS-KEY/SIGNATURE/
TIMESTAMP` scheme) exists for completeness and future authenticated-read headroom, but is
never invoked by anything that places an order, because nothing that places an order exists.
Going live later means writing new code, not flipping an env var -- a stronger guarantee than
an env-gated `currentMode()` given the explicit "no real capital" requirement.

## Go-live checkpoint

`node cli.js checkpoint` reports progress toward **500 paper trades** (~32 days at the
backtested ~15.7/day pace) before this is even eligible for a go-live discussion. That number
isn't arbitrary: it matches the sample size of the backtest itself (519 trades over 33 days),
so reaching it gives a genuinely fresh, non-overlapping confirmation window of comparable
statistical weight to what was backtested -- directly addressing the "not a blind
out-of-sample test" caveat that hangs over tonight's own 3-bucket result. It's a **volume
gate, not a performance gate**: reaching 500 means there's enough history to have the
conversation, not that the numbers will support it. Check `performance` and `decay` at that
point, not just the count.

## Running it

```
node orchestrator.js            # runs forever, one evaluation per 15-min window per series
node orchestrator.js --once     # single cycle, for manual runs/smoke tests
node cli.js status              # bankroll, open exposure, decay + probation-review alerts (shown first if any)
node cli.js positions           # open paper positions
node cli.js performance         # settled trades, overall and per-bucket vs backtested baseline
node cli.js decay               # full decay-alert history
node cli.js probation           # probationary-bucket status and review-ready alerts
node cli.js checkpoint          # progress toward the 500-trade go-live gate
```

`KALSHIBOT_PAPER_BANKROLL_USD` (default 200, matching the backtest's own start) sets the
paper starting bankroll. `KALSHIBOT_API_KEY_ID` / `KALSHIBOT_PRIVATE_KEY_PEM` are read only
by the unused auth path in `kalshiClient.js` -- not required to run this bot at all, since
every endpoint actually used (market discovery, candlesticks, settlement) is public.

Scheduling is checkpoint-precise, not a fixed poll loop: it computes every distinct
checkpoint instant needed for the current window (one per distinct checkpoint-minutes value
across all configured buckets -- see "Multi-checkpoint scheduling" above) and sleeps to each
in turn, rather than polling on an interval that could drift against or double-fire within a
15-minute-lived market.

## Deployment

Runs on its own dedicated GCP VM, `kalshi-bot-vm` (`us-central1-c`, e2-micro) -- same pattern
as `sports-bot-vm` and `polybot-vm` (each bot gets its own VM, no shared process/DB). Deployed
as a native **systemd service** (`kalshi-bot.service`), matching how both of those VMs actually
run their bots -- not PM2 (PM2 isn't used anywhere in this project; both existing VMs run
plain systemd units, so that's what this one uses too, for genuine consistency).

- Code lives at `/opt/kalshi-bot` (owned by `anirudhiyengar`), `node_modules` installed
  directly on the VM via `npm install` (not copied from a local build).
- `KALSHIBOT_PAPER_BANKROLL_USD=200` is set explicitly in `/etc/kalshi-bot/env` (root-only
  readable, `chmod 600`, mirroring `sports-bot-vm`'s `/etc/sports-bot/env` convention) even
  though that's already the default, so it's visible on the VM rather than relying on an
  implicit default.
- **No Kalshi API credentials are provisioned anywhere on this VM.** Every endpoint this bot
  actually uses (market discovery, candlesticks, settlement) is public and unauthenticated,
  confirmed directly against `kalshiClient.js` before deployment -- `KALSHIBOT_API_KEY_ID`/
  `KALSHIBOT_PRIVATE_KEY_PEM` only feed the unused auth path there and were never set.
- No new firewall rule was needed for outbound HTTPS to `api.elections.kalshi.com`: GCP's
  default network has no egress-restricting rule, so outbound is already open (confirmed via
  `gcloud compute firewall-rules list` before deploying -- only the default ingress rules
  exist).
- `sudo systemctl status kalshi-bot` / `sudo journalctl -u kalshi-bot -f` for live status/logs
  (same commands used for the other two bots' VMs).
