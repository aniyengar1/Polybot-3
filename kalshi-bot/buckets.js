// Single source of truth for the 3 validated Kalshi gold/silver buckets -- same
// separation-of-concerns reason as sports-bot/buckets.js (shared by calibration.js and
// liveSizing.js so definitions can't silently diverge), independently reimplemented, not
// imported (this is a fully separate integration -- see README.md).
//
// Provenance (all three numbers below traced directly to real backtest artifacts, not
// re-derived here): /Users/anirudhiyengar/soccer-research/KALSHI_GOLD_SILVER_THREE_BUCKET_BACKTEST.md
// and its memory record project-kalshi-gold-silver-three-bucket-backtest. Fixed 3-bucket,
// 8-minute-checkpoint, 5-week ($200->$291.12, +45.56%) backtest, per-bucket breakdown:
//   Gold 0.7-0.8:   156 trades, 79.5% win rate, +$42.88
//   Gold 0.5-0.6:   185 trades, 58.4% win rate, +$27.31
//   Silver 0.8-0.9: 178 trades, 62.9% win rate, +$20.93
//
// Confidence is deliberately UNEVEN across the three, per real evidentiary differences, not
// a uniform "3 buckets, treat equally" split:
//   - Silver 0.8-0.9: the strongest claim. Independently corroborated across 3 separate
//     backtests tonight (project-kalshi-gold-silver-15min-test's original 5-min-checkpoint
//     static test, project-kalshi-gold-silver-bucket-checkpoint-selection's 8-min
//     selection/validation-split test, and this 3-bucket confirmation run) -- the strongest
//     cross-validated signal produced this session.
//     [RETRACTED 2026-09-07 -- this "strongest claim" turned out to be a YES/NO-mixing
//     artifact, not a real edge. See the dated block near the end of this header and this
//     bucket's own entry below (now status:'retired'). Left here unedited as the accurate
//     historical record of what the original backtest concluded, not because it's still true.]
//   - Gold 0.7-0.8 and Gold 0.5-0.6: weaker claim. Only cleared ONE test
//     (project-kalshi-gold-silver-bucket-checkpoint-selection), and that test's own writeup
//     states plainly these two were "partly selected because they performed well in the
//     validation period of the immediately preceding test, which covers this same 5-week
//     span" -- i.e. this 3-bucket run's reported P&L partially reuses the data that picked
//     these buckets in the first place. Real, not fabricated, but not independently
//     out-of-sample the way Silver 0.8-0.9 was believed to be (see retraction above).
//
// Two adjacent buckets in this SAME product (Silver 0.0-0.1, Silver 0.1-0.2) looked real on
// a coarser halves-check tonight but then collapsed to near-zero edge in the most recent
// third of the same test window (project-kalshi-gold-silver-15min-test) -- a live example of
// an early-product-launch inefficiency closing WHILE it was being tested. That's the direct
// justification for (a) shrinking every bucket's calibrated hit rate toward the market's own
// price rather than trusting the raw point estimate (see calibration.js), and (b) the
// decay-watch monitor (see decayWatch.js) that watches for this exact pattern recurring in
// the 3 buckets actually traded here.
//
// WTI (added 2026-09-04), provenance: /Users/anirudhiyengar/soccer-research/
// KALSHI_WTI_NATGAS_COPPER_BIDIRECTIONAL_TEST.md. First bucket set in this bot with more than
// one checkpoint per series -- see orchestrator.js's header for the scheduler generalization
// this required. Natural Gas and Copper were confirmed real products in the same test but
// deliberately excluded here: only ~8 days of history each, explicitly flagged in the
// findings doc as insufficient data to populate even one (bucket, checkpoint) cell at n>=60,
// not a tested-and-failed null. Revisit once they have comparable history to WTI's ~5 weeks.
//
// Three rules survived this test's bar (genuine search/holdout split, thirds-robustness, AND
// cross-checkpoint agreement required for "confirmed"):
//   - 0.3-0.4 @ cp3min, buy-NO (longshot-overpriced): search halves -13.2pp/-8.0pp, thirds
//     -10.8/-15.0/-5.9pp, holdout n=34 -2.0pp, confirmed.
//   - 0.3-0.4 @ cp8min, buy-NO (longshot-overpriced): search halves -2.3pp/-9.9pp, thirds
//     -5.3/-7.3/-5.8pp, holdout n=71 -3.1pp, confirmed. Independently confirms the cp3min
//     rule above -- both cross-checkpoint-agreeing members independently passed holdout, no
//     internal contradiction. This is the cleanest result of the WTI test.
//   - 0.6-0.7 @ cp6min, buy-YES (favorite-underpriced): search halves +11.3pp/+11.8pp, thirds
//     +8.0/+17.3/+9.4pp, holdout n=66 +5.8pp, confirmed per the pre-committed rule -- BUT its
//     cross-checkpoint partner (cp7min, same bucket) agreed in search (+4.8/+7.7pp) and then
//     REVERSED SIGN on holdout (-6.2pp). Weaker evidence than any other bucket in this bot,
//     including the two probationary Gold buckets (a literal holdout sign flip on the
//     confirming partner is a stronger red flag than an implausible-but-consistent win rate).
//     Traded LOG-ONLY from launch through 2026-09-06 (see decayWatch.js / db.js's
//     trades.log_only, orchestrator.js): every qualifying signal was recorded with a genuine
//     would-be size and later outcome, but NO paper bankroll was actually staked on it -- not
//     a kellyFraction:0 trick, a real structural distinction (log_only=1 rows are excluded
//     from getBankrollUsd() and shown separately by `node cli.js performance`). Promoted to
//     PROBATIONARY on 2026-09-07 (see its entry below for the reasoning, distinct from the
//     crypto rules' rationale) once its first 5 log-only signals gave enough of a track record
//     to justify real (if still capped and monitored) paper stakes; those 5 were retroactively
//     staked at that point too, sized against the bankroll as it actually stood at each
//     signal's own timestamp, not lump-summed onto the current total.
//
// backtestBaseline numbers below are each rule's own realized cell from the $200 walk-forward
// backtest (backtestWTIThreeRule.js, 1% risk cap, price-shrunk hit-rate calibration -- a real
// methodological upgrade over the gold/silver backtest, which never actually implemented the
// shrinkage it had only suggested as a future fix), NOT the raw search/holdout numbers above --
// same convention as gold/silver's backtestBaseline. hits = round(n * P(YES)); for the two
// buy-NO buckets P(YES) = 1 - the bet's own win rate reported in the backtest (0.734, 0.676),
// since the walk-forward win rate is of the trade actually taken (NO), not of YES resolving.
//
// Confirmed live 2026-09-04: KXWTI15M is real (2,439 settled events, Jul 31-Sep 4 2026 span),
// same quadratic fee formula, same public/unauthenticated endpoints as gold/silver.
//
// PROBATIONARY crypto rules (added 2026-09-06): 7 buckets across KXDOGE15M/KXBTC15M, tagged
// status:'probationary' below (see db.js's trades.bucket_status column) -- distinct from
// everything above, which is `status` omitted / implicitly 'validated'. These 7 are added
// specifically so their OWN LIVE PAPER TRADES going forward become the never-before-touched
// data these rules still need. Provenance:
//   - /Users/anirudhiyengar/soccer-research/KALSHI_CRYPTO_ALTCOIN_BUCKET_TEST.md: DOGE 0.8-0.9
//     (buy-YES) confirmed at 3 independent checkpoints (6/8/11min), all 3 also confirmed on
//     holdout -- search edges +3.1 to +6.8pp across the three, holdout edges +4.3 to +5.1pp.
//   - /Users/anirudhiyengar/soccer-research/KALSHI_BTC_ETH_BUCKET_TEST.md: BTC 0.2-0.3 (buy-NO)
//     confirmed at cp6min (search halves -7.47/-3.04pp, thirds -6.49/-4.00/-5.25pp, holdout
//     n=89 -5.65pp) and independently at cp8min (search halves -6.83/-3.60pp, thirds
//     -4.39/-7.72/-3.52pp, holdout n=137 -7.11pp). BTC 0.8-0.9 (buy-YES) confirmed at cp9min
//     (search halves +1.11/+5.57pp, holdout n=121 +5.13pp) and independently at cp11min
//     (search halves +6.31/+8.84pp, holdout n=83 +2.35pp).
//   - /Users/anirudhiyengar/soccer-research/KALSHI_DOGE_BTC_COMBINED_BACKTEST.md: combined
//     $200 walk-forward sim of all 7 rules together (backtestDogeBtcCombined.js), 1% risk cap,
//     Bayesian shrinkage toward market price (w = n/(n+30), i.e. shrinkageK: 30 in this file's
//     terms -- a NEW tier, distinct from the 20/40 used above). +82.46% over 44 days, 85.73%
//     overall win rate, 8.29% max drawdown, all 7 rules individually net positive. **That
//     document's own explicit verdict: "does not clear any of the three candidates for
//     kalshi-bot's live BUCKET_CONFIG... Stage 1 (checking each rule against real,
//     never-touched data) remains the actual test."** Adding these here, tagged probationary
//     and monitored separately (see decayWatch.js's probation-review alerting), IS that Stage
//     1 test -- run forward from here, not retroactively against the same reused data.
//   - kellyFraction 0.08 for all 7 (this project's existing "weak evidence" tier, same as
//     Gold's two probationary buckets) -- deliberately conservative pending independence
//     confirmation, on top of the existing global 1% KELLY_CAP_PCT hard cap (already the "1%
//     risk cap" the backtest validated; no change needed there).
//   - backtestBaseline numbers are each rule's own cell from the combined backtest's per-rule
//     breakdown (trades/win-rate/pnl), same convention as gold/silver/WTI -- NOT the raw
//     search/holdout pp numbers cited above. hits = round(n * P(YES)); for the 2 buy-NO BTC
//     0.2-0.3 buckets, P(YES) = 1 - the bet's own win rate (0.811, 0.809).
//   - Once any one of these 7 reaches n>=30 SETTLED live paper trades, decayWatch.js's
//     checkProbationReviews() fires a one-time, persistent `probation_review_alerts` row
//     (mirrors decay_alerts: never auto-cleared, surfaced first in `node cli.js status` and on
//     the dashboard) -- the explicit trigger to come back and evaluate that rule's live record
//     against its original search/holdout edge, not let it run silently.
//
// KXSILVER15M|0.8-0.9|cp8 RETIRED 2026-09-07 -- calibration bug, not organic decay. Its
// backtestBaseline (n=178, hits=112, winRate=0.629) came from backtestGoldSilverThreeBucket.js,
// which picks sides dynamically per trade; for this specific bucket that run blended 123 buy-YES
// trades (won 104, 84.6%) with 55 buy-NO trades (won 8, 14.5%) into one reported "62.9% win
// rate" -- not a coherent P(YES) for this band, a mix of two structurally different bets.
// calibration.js's getShrunkHitRate() treats backtestBaseline.hits/n as P(YES) and shrinks the
// live empirical rate toward it, so the live bot has been sizing off ~63% instead of this
// band's true rate -- which made buying NO look attractively underpriced (NO priced off a fake
// ~37% P(NO)) when the real win rate for that NO bet is only ~13-15%.
//
// Corrected P(YES), recomputed directly from the raw checkpoint records (not re-derived from
// the flawed $ backtest): /Users/anirudhiyengar/soccer-research/kalshiGoldSilverMultiCheckpoint.json,
// every record for Silver at checkpoint 8, band 0.8-0.9, n=262 -- 86.6% YES, essentially equal
// to the market's own implied price at that band. That's the actual finding here: this isn't
// "paused pending more data," the corrected number shows no evidence this bucket ever had a
// real edge at all. This is almost certainly the root cause of the decay alerts already firing
// on this bucket (16.7% live win rate at n=12) -- a bug in what the bot thought the edge was,
// not the edge fading.
//
// Old (retracted) backtestBaseline preserved for reference, do not restore without a fresh,
// independent walk-forward re-derivation (this file's existing bar for any bucket):
//   { n: 178, hits: 112, winRate: 0.629, pnlPerTrade: 20.93 / 178 }
//
// Mechanism: status:'retired' on the entry below (new third value alongside
// 'validated'/'probationary'), gated in orchestrator.js's evaluateSeriesCheckpoint right where
// logOnly is already checked -- the entry stays in BUCKET_CONFIG (not deleted) so it keeps
// resolving to a real label in the dashboard's per-bucket drill-down and Recent Trades, it just
// never produces a new trade again. Every trade already recorded for this bucket used the live
// calibration that actually existed at the time and is left completely untouched -- this is a
// go-forward stop, not a retroactive recalculation (contrast WTI 0.6-0.7/cp6's log-only
// promotion above, which did retroactively restake; this bug fix does not, on purpose).
//
// VALIDATED-DIRECTION CONSTRAINT added 2026-09-08. Every bucket in this file was search+holdout
// confirmed for exactly ONE direction (e.g. DOGE 0.8-0.9 favorite-underpriced/buy-YES, WTI
// 0.3-0.4 longshot-overpriced/buy-NO -- see each rule's own provenance above) -- but
// liveSizing.js's evaluateOpportunity picks side dynamically every trade (whichever of
// edgeYes/edgeNo is larger and clears the fee), with nothing stopping it from firing the
// UNTESTED opposite direction whenever live calibration happens to cross price the other way.
// A live diagnostic found exactly that: 7 of 154 real trades (4.5%) fired against their
// bucket's validated direction -- WTI 0.3-0.4/cp8 (2, flipped to buy-YES), DOGE 0.8-0.9/cp6 (1,
// flipped to buy-NO), and BTC 0.8-0.9/cp9 (4, all flipped to buy-NO at the same recurring $0.89
// price point). All 7 lost. Confirmed via each trade's own frozen calibration_p_shrunk vs.
// market_price that this is NOT a bug -- the symmetric edge formula worked exactly as coded in
// every case -- it's a missing constraint: nothing encoded that a bucket's live calibration
// crossing price the "wrong" way should be evidence to STAND ASIDE, not a green light to bet
// the untested direction, given the validation only ever covers one side.
//
// Fix: every currently-active bucket below gets a `validatedSide: 'yes'|'no'` field (the ONE
// direction actually search+holdout confirmed, NOT whichever side live calibration currently
// favors -- see liveSizing.js's evaluateOpportunity, which now skips (records as 'observed',
// not a trade) any computed side that contradicts it). Silver 0.8-0.9/cp8 has no
// validatedSide -- it's retired and never reaches that check. This does NOT touch the 7
// trades already recorded above -- each fired under the logic that existed at the time and its
// stake/outcome/P&L is left exactly as-is, same "go-forward stop, not a retroactive
// recalculation" principle as the retirement above.
'use strict';

const KELLY_CAP_PCT = 0.01; // hard per-trade cap, 1% of current bankroll -- see README for why
// this is tighter than sports-bot's 2%: this strategy trades ~15.7x/day across 3 buckets
// (vs sports-bot's ~1x/day), so the same per-trade cap compounds intraday risk much faster.

const BUCKET_CONFIG = {
  'KXGOLD15M|0.7-0.8|cp8': {
    label: 'Gold 0.7-0.8',
    series: 'KXGOLD15M',
    band: '0.7-0.8',
    checkpointMinutes: 8,
    // Smaller allocation: single-test corroboration, partial selection-data reuse (see header).
    kellyFraction: 0.08,
    // Stronger shrink toward market price: weaker evidentiary base means the raw empirical
    // hit rate deserves less trust relative to the market's own read.
    shrinkageK: 40,
    backtestBaseline: { n: 156, hits: 124, winRate: 0.795, pnlPerTrade: 42.88 / 156 }, // 124 = round(156*0.795)
    validatedSide: 'yes', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
  'KXGOLD15M|0.5-0.6|cp8': {
    label: 'Gold 0.5-0.6',
    series: 'KXGOLD15M',
    band: '0.5-0.6',
    checkpointMinutes: 8,
    // kellyFraction/shrinkageK left as originally set (unused now that status:'retired' stops
    // this bucket from ever sizing a new trade) -- same "not touching what retirement doesn't
    // need" convention as Silver 0.8-0.9's retirement below.
    kellyFraction: 0.08,
    shrinkageK: 40,
    backtestBaseline: { n: 185, hits: 108, winRate: 0.584, pnlPerTrade: 27.31 / 185 }, // 108 = round(185*0.584)
    validatedSide: 'yes', // search+holdout confirmed direction only -- see 2026-09-08 header block
    // RETIRED 2026-09-10 -- organic decay, confirmed via decayWatch.js's own decay_alerts
    // (5 alerts fired 2026-09-07 through 2026-09-10, id 44-53, this exact bucket_key): rolling
    // win rate over the most recent 17 trades is 52.9% vs the 58.4% backtested baseline, with
    // rolling P&L -$0.13 over that window despite a positive $0.148/trade backtested
    // expectation -- the sustained-underperformance pattern decayWatch.js exists to catch, not
    // a single bad streak (5 separate alerts across 3 days, each on a growing trade count).
    // Full settled record at retirement time: 18 trades, 55.6% win rate, +$0.77 total -- still
    // net positive lifetime, which is exactly why this is a decay call (recent performance
    // trending away from baseline) rather than a Silver-0.8-0.9-style "never had edge" call;
    // contrast Silver's retirement below, a calibration BUG (never a real edge, confirmed from
    // raw checkpoint records), not decay. Unlike Silver's retroactive correction, this is a
    // pure go-forward stop -- every trade already recorded for this bucket used the live
    // calibration that actually existed at the time and is left completely untouched.
    status: 'retired',
    retiredReason: 'bucket retired from live trading -- persistent decay on cp8, underperforming baseline (decay_alerts id 44-53, 2026-09-10)',
  },
  'KXSILVER15M|0.8-0.9|cp8': {
    label: 'Silver 0.8-0.9',
    series: 'KXSILVER15M',
    band: '0.8-0.9',
    checkpointMinutes: 8,
    // kellyFraction/shrinkageK left as originally set (unused now that status:'retired' stops
    // this bucket from ever sizing a new trade) -- not touching what retirement doesn't need.
    kellyFraction: 0.15,
    shrinkageK: 20,
    // RETIRED 2026-09-07 -- calibration bug, not organic decay: the old backtestBaseline
    // (n=178, hits=112, winRate=0.629) blended 123 buy-YES (84.6% win) and 55 buy-NO (14.5%
    // win) trades from backtestGoldSilverThreeBucket.js's dynamic side selection into one
    // number that was never a coherent P(YES) for this band. Corrected below from the raw
    // checkpoint records (kalshiGoldSilverMultiCheckpoint.json, Silver/cp8/0.8-0.9, n=262):
    // true P(YES) is 86.6%, essentially equal to the market's own price -- no real edge, not
    // "needs more data." See the dated header block above for the full writeup and the
    // preserved old number. Do not restore without a fresh, independent re-derivation.
    backtestBaseline: { n: 262, hits: 227, winRate: 0.866, pnlPerTrade: 0 }, // 227 = round(262*0.866); pnlPerTrade: 0, no legitimate walk-forward $ figure exists for the corrected number (the old one was itself built on the same flawed mixed-side backtest) and "no edge" implies ~$0 expected value
    status: 'retired',
    // Verbatim relocation of the reason string that used to be hardcoded in orchestrator.js's
    // retired-bucket check -- moved here 2026-09-10 when Gold 0.5-0.6's retirement above needed
    // its OWN distinct reason and a single hardcoded string could no longer serve both. No
    // semantic change to Silver's own retirement -- same text, same meaning, just relocated to
    // live alongside the bucket it actually describes instead of in the orchestrator.
    retiredReason: 'bucket retired from live trading (calibration bug found 2026-09-07)',
  },
  'KXWTI15M|0.3-0.4|cp3': {
    label: 'WTI 0.3-0.4 (cp3, longshot-overpriced, buy-NO)',
    series: 'KXWTI15M',
    band: '0.3-0.4',
    checkpointMinutes: 3,
    // Same allocation tier Silver 0.8-0.9 was originally given (large kellyFraction, light
    // shrink) -- but this rule's own case doesn't rest on Silver 0.8-0.9's now-retracted
    // "strongest prior finding" claim (see that bucket's 2026-09-07 retirement above): WTI's
    // buy-NO buckets were independently audited against their own trade-level backtest output
    // (backtestWTIThreeRule.js, single-fixed-side rule, confirmed clean) and this rule (with
    // its cp8 partner) is the cleanest result of that separate WTI test (see header).
    kellyFraction: 0.15,
    shrinkageK: 20,
    backtestBaseline: { n: 79, hits: 21, winRate: 0.734, pnlPerTrade: 12.35 / 79 }, // 21 = round(79*(1-0.734)); winRate is the NO-side bet's own win rate, not P(YES)
    validatedSide: 'no', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
  'KXWTI15M|0.3-0.4|cp8': {
    label: 'WTI 0.3-0.4 (cp8, longshot-overpriced, buy-NO)',
    series: 'KXWTI15M',
    band: '0.3-0.4',
    checkpointMinutes: 8,
    kellyFraction: 0.15,
    shrinkageK: 20,
    backtestBaseline: { n: 148, hits: 48, winRate: 0.676, pnlPerTrade: 5.98 / 148 }, // 48 = round(148*(1-0.676))
    validatedSide: 'no', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
  'KXWTI15M|0.6-0.7|cp6': {
    label: 'WTI 0.6-0.7 (cp6, favorite-underpriced, buy-YES)',
    series: 'KXWTI15M',
    band: '0.6-0.7',
    checkpointMinutes: 6,
    // PROBATIONARY as of 2026-09-07 (promoted from log-only) -- weakest tier in
    // this bot, but for a DIFFERENT reason than the 7 crypto probationary rules below. This
    // bucket already has real search+holdout evidence (see header); its problem is that its
    // cross-checkpoint confirming partner (cp7min, same bucket) REVERSED SIGN on holdout --
    // an internal contradiction in evidence this bot already has, not an absence of evidence.
    // The crypto rules are probationary because they haven't been tested on fresh, never-touched
    // data yet; this one has been tested and the test found a contradiction. Kept as a distinct
    // rationale rather than folded into the crypto rules' "unconfirmed on fresh data" framing.
    // kellyFraction/shrinkageK unchanged from the log-only era: sizing was already set
    // conservatively for weak evidence, and that reasoning still holds now that it's staked.
    kellyFraction: 0.08,
    shrinkageK: 40,
    backtestBaseline: { n: 160, hits: 116, winRate: 0.725, pnlPerTrade: 31.46 / 160 }, // 116 = round(160*0.725)
    status: 'probationary',
    validatedSide: 'yes', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
  'KXDOGE15M|0.8-0.9|cp6': {
    label: 'DOGE 0.8-0.9 (cp6, favorite-underpriced, buy-YES)',
    series: 'KXDOGE15M',
    band: '0.8-0.9',
    checkpointMinutes: 6,
    kellyFraction: 0.08,
    shrinkageK: 30,
    backtestBaseline: { n: 203, hits: 175, winRate: 0.862, pnlPerTrade: 6.90 / 203 }, // 175 = round(203*0.862)
    status: 'probationary',
    validatedSide: 'yes', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
  'KXDOGE15M|0.8-0.9|cp8': {
    label: 'DOGE 0.8-0.9 (cp8, favorite-underpriced, buy-YES)',
    series: 'KXDOGE15M',
    band: '0.8-0.9',
    checkpointMinutes: 8,
    kellyFraction: 0.08,
    shrinkageK: 30,
    backtestBaseline: { n: 257, hits: 226, winRate: 0.879, pnlPerTrade: 22.89 / 257 }, // 226 = round(257*0.879)
    status: 'probationary',
    validatedSide: 'yes', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
  'KXDOGE15M|0.8-0.9|cp11': {
    label: 'DOGE 0.8-0.9 (cp11, favorite-underpriced, buy-YES)',
    series: 'KXDOGE15M',
    band: '0.8-0.9',
    checkpointMinutes: 11,
    kellyFraction: 0.08,
    shrinkageK: 30,
    backtestBaseline: { n: 247, hits: 220, winRate: 0.891, pnlPerTrade: 25.66 / 247 }, // 220 = round(247*0.891)
    status: 'probationary',
    validatedSide: 'yes', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
  'KXBTC15M|0.2-0.3|cp6': {
    label: 'BTC 0.2-0.3 (cp6, longshot-overpriced, buy-NO)',
    series: 'KXBTC15M',
    band: '0.2-0.3',
    checkpointMinutes: 6,
    kellyFraction: 0.08,
    shrinkageK: 30,
    backtestBaseline: { n: 244, hits: 46, winRate: 0.811, pnlPerTrade: 31.09 / 244 }, // 46 = round(244*(1-0.811)); winRate is the NO-side bet's own win rate, not P(YES)
    status: 'probationary',
    validatedSide: 'no', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
  'KXBTC15M|0.2-0.3|cp8': {
    label: 'BTC 0.2-0.3 (cp8, longshot-overpriced, buy-NO)',
    series: 'KXBTC15M',
    band: '0.2-0.3',
    checkpointMinutes: 8,
    kellyFraction: 0.08,
    shrinkageK: 30,
    backtestBaseline: { n: 304, hits: 58, winRate: 0.809, pnlPerTrade: 32.12 / 304 }, // 58 = round(304*(1-0.809))
    // RETIRED 2026-09-10 -- persistent underperformance across the FULL live sample, a
    // different failure mode than Gold 0.5-0.6's retirement above (recent decay -- 5 escalating
    // decay_alerts over 3 days on a subset of trades) or Silver 0.8-0.9's (a calibration bug,
    // never a real edge at all). Live record at retirement: 43 settled trades, 74.4% win rate
    // (32/43) vs. 80.9% backtested baseline, lifetime P&L -$0.10 -- never net profitable at any
    // point in the sample, not a recent slide from a formerly-profitable run. Confirmed via the
    // trade-by-trade chronology (not just the aggregate): losses land on every single day from
    // 2026-09-06 through 2026-09-10 (1-4/day), not clustered in a recent window -- and only ONE
    // decay_alerts row ever fired (2026-09-09, rolling P&L -$0.76/30 trades), vs. Gold 0.5-0.6's
    // five escalating alerts, consistent with underperformance that was present from early on
    // rather than accelerating recently. Pure go-forward stop, same as both retirements above --
    // every trade already recorded for this bucket used the live calibration that existed at
    // the time and is left completely untouched.
    status: 'retired',
    retiredReason: 'bucket retired from live trading -- persistent underperformance vs. backtest baseline across full 43-trade sample, never net profitable (2026-09-10)',
    validatedSide: 'no', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
  'KXBTC15M|0.8-0.9|cp9': {
    label: 'BTC 0.8-0.9 (cp9, favorite-underpriced, buy-YES)',
    series: 'KXBTC15M',
    band: '0.8-0.9',
    checkpointMinutes: 9,
    kellyFraction: 0.08,
    shrinkageK: 30,
    backtestBaseline: { n: 261, hits: 225, winRate: 0.862, pnlPerTrade: 18.29 / 261 }, // 225 = round(261*0.862)
    status: 'probationary',
    validatedSide: 'yes', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
  'KXBTC15M|0.8-0.9|cp11': {
    label: 'BTC 0.8-0.9 (cp11, favorite-underpriced, buy-YES)',
    series: 'KXBTC15M',
    band: '0.8-0.9',
    checkpointMinutes: 11,
    kellyFraction: 0.08,
    shrinkageK: 30,
    backtestBaseline: { n: 264, hits: 236, winRate: 0.894, pnlPerTrade: 27.96 / 264 }, // 236 = round(264*0.894)
    status: 'probationary',
    validatedSide: 'yes', // search+holdout confirmed direction only -- see 2026-09-08 header block
  },
};

const SERIES_LIST = ['KXGOLD15M', 'KXSILVER15M', 'KXWTI15M', 'KXDOGE15M', 'KXBTC15M'];
const MIN_CALIBRATION_N = 30; // matches this project's standard n>=30 floor, and the backtest's own MIN_CALIBRATION_N

function bucketOf(price) {
  const idx = Math.min(9, Math.max(0, Math.floor(price * 10)));
  return `${(idx / 10).toFixed(1)}-${((idx + 1) / 10).toFixed(1)}`;
}

function makeBucketKey(series, band, checkpointMinutes) {
  return `${series}|${band}|cp${checkpointMinutes}`;
}

// Distinct checkpoint-minutes-before-close values actually configured across every bucket --
// gold/silver only ever used {8}; WTI adds {3, 6, 8}. Derived from BUCKET_CONFIG, not
// hardcoded, so a future series/bucket at a new checkpoint (Natural Gas/Copper, once they have
// enough history) doesn't need any scheduler code touched, just a new BUCKET_CONFIG entry --
// see orchestrator.js's header for why this generalization was needed.
function allCheckpointMinutes() {
  return [...new Set(Object.values(BUCKET_CONFIG).map((c) => c.checkpointMinutes))].sort((a, b) => a - b);
}

// Which series need evaluating at a given checkpoint-minutes-before-close value.
function seriesForCheckpointMinutes(checkpointMinutes) {
  return [...new Set(
    Object.values(BUCKET_CONFIG)
      .filter((c) => c.checkpointMinutes === checkpointMinutes)
      .map((c) => c.series)
  )];
}

function isAllowedBucket(bucketKey) {
  return Object.prototype.hasOwnProperty.call(BUCKET_CONFIG, bucketKey);
}

module.exports = {
  BUCKET_CONFIG,
  SERIES_LIST,
  MIN_CALIBRATION_N,
  KELLY_CAP_PCT,
  bucketOf,
  makeBucketKey,
  isAllowedBucket,
  allCheckpointMinutes,
  seriesForCheckpointMinutes,
};
