// Single source of truth for the 5 validated buckets -- shared by holdoutTable.js and
// liveSizing.js so bucket definitions (band boundaries, horizon, which side each bucket
// trades) can't silently diverge between the table-computation code and the sizing code.
// This is exactly the kind of duplication that let backtestApril2026.js:165's price re-flip
// bug hide for five iterations -- keeping the definitions in one place removes one whole
// class of "the two pieces quietly disagreed" bug.
'use strict';

// DROPPED 2026-08-26 (not downgraded -- removed): NHL spread and NHL total both failed
// re-validation (n>=30 both halves, same sign, >5pp magnitude) once the liquidity gate was
// fixed to require a side-specific fill instead of aggregate-across-both-sides notional
// (fetchLiquidityFiltered.js's notionalNear had no tr.asset filter -- see that file's
// header). Their old numbers (NHL spread: train -14.4pp/n=49, test -7.6pp/n=39; NHL total:
// train +15.5pp/n=35, test +10.2pp/n=35) were partly built on checkpoints that were
// aggregate-liquid but not side-specific-fillable -- an audit sample found this affected
// 40% of NHL spread's and 20% of NHL total's checkpoints. Once excluded, neither bucket
// clears the bar on the corrected dataset. Do not re-add without a fresh, independent
// validation pass -- this isn't a data hygiene footnote, it changed the actual conclusion.
//
// MLB spread's ORIGINAL "clears the bar" finding (train +5.1pp/n=121, test +8.8pp/n=37) was
// retracted 2026-08-27: it turned out to be built on a conflated mix of up to 6 structurally
// different contracts per game (different point values, home/away, full-game vs
// first-5-innings), all collapsed into one 'spread' type by a loose slug substring match
// (pickSubmarkets/getGammaPricing both had this bug -- same root cause and same fix pattern
// as the earlier aggregate-liquidity bug, just one layer up: this one conflated CONTRACT
// IDENTITY, not just liquidity attribution). Confirmed live: a single MLB event can carry up
// to 13 distinct submarkets under the old loose match.
//
// FIXED and RE-VALIDATED 2026-08-27: pickSubmarkets/getGammaPricing now parse the exact slug
// structure (point value + home/away + full-game-vs-f5), so each contract is distinctly
// identifiable. Isolated ONE canonical bet type for validation -- the standard full-game
// +/-1.5 run line, pooling home+away (two separate, non-complementary contracts per game,
// deliberately pooled the same way moneyline already pools home-favorite/away-favorite
// games; NOT the same as the old bug, which pooled STRUCTURALLY DIFFERENT contract types).
// Re-derived from a full historical re-fetch (2070 MLB events): train +6.5pp/n=340, test
// +5.9pp/n=272 -- a real, independently-confirmed signal, more robustly sampled than the
// original (n=340/272 vs n=121/37). Passed all 3 re-validation steps: side-specific
// liquidity audit (0/40, 0.0% contamination), July 2026 walk-forward (19 real trades, 31.6%
// win rate vs ~27.5% holdout-implied, positive P&L), live scanner integration (correctly
// routes 1.5-line markets to this bucket and skips 2.5-line/f5 markets with "no validated
// bucket" -- verified live against real open markets, no misrouting).
//
// side=YES here means "the favorite (on this specific 1.5 line) covers" -- Gamma's own
// convention confirmed via real question text (e.g. "Spread: Baltimore Orioles (-1.5)"),
// consistent for both the away-favorite and home-favorite variant of the line. This is a
// genuinely different kind of signal than the moneyline buckets (betting spread coverage,
// not game outcome), and unlike moneyline, the live scanner has to resolve which of gateway's
// two per-line variant slugs (pos-V/neg-V, always relative to the away team) realizes this
// proposition -- see scanner.js's evaluateGatewayMarket (gatewaySide) for that mechanism.
const BUCKETS = [
  { sport: 'nba', marketType: 'moneyline', horizon: 'h3', horizonHours: 3, band: '<=0.30', side: 'NO' },
  { sport: 'nhl', marketType: 'moneyline', horizon: 'h24', horizonHours: 24, band: '>=0.40', side: 'YES' },
  { sport: 'mlb', marketType: 'moneyline', horizon: 'h24', horizonHours: 24, band: '0.30-0.40', side: 'NO' },
  { sport: 'mlb', marketType: 'spread_1.5', horizon: 'h3', horizonHours: 3, band: '<=0.30', side: 'YES' },
];

function bandFor(price) {
  if (price <= 0.3) return '<=0.30';
  if (price < 0.4) return '0.30-0.40';
  return '>=0.40';
}

function makeBucketKey(sport, marketType, horizon, band) {
  return `${sport}|${marketType}|${horizon}|${band}`;
}

function findBucket(sport, marketType, band) {
  return BUCKETS.find((b) => b.sport === sport && b.marketType === marketType && b.band === band);
}

// The NHL-total seasonal exclusion window (previously defined here) is removed along with
// the NHL total bucket itself -- it dropped out of BUCKETS above, so there's nothing left
// for that exclusion to apply to. Not deleting this history: the underlying finding (real
// fill prices diverging from checkpoint prices near NHL's regular-season end) may still be
// relevant if NHL total is ever re-validated from scratch on corrected data.

module.exports = { BUCKETS, bandFor, makeBucketKey, findBucket };
