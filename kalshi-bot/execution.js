// Paper execution only. There is deliberately no function anywhere in this file (or
// anywhere else in kalshi-bot) that submits a real order to Kalshi -- "No real capital,
// paper mode only" is enforced structurally here, not by an env-var flag a future change
// could flip. If this is ever extended to real trading, that needs a new, explicit,
// separately-reviewed function -- not a mode switch on openPosition below.
//
// A resting maker order in a market this thin-lived (15 minutes total) isn't guaranteed to
// fill before the checkpoint decision is stale, and the fee model this bot uses (see
// liveSizing.js) is the TAKER schedule -- so the paper fill model assumes a taker fill at
// the checkpoint's own observed price, which is exactly what the backtest this strategy is
// grounded in assumed too (see backtestGoldSilverThreeBucket.js: entryCost = price paid at
// the checkpoint, no separate bid/ask crossing model). Keeping paper and backtest fill
// assumptions identical avoids a silent train/serve mismatch.
'use strict';

const MODE = 'paper';

function currentMode() {
  return MODE;
}

/**
 * Simulates opening a position from a 'trade' decision (liveSizing.js's evaluateOpportunity
 * output). No network call, no credentials -- the checkpoint price used for sizing IS the
 * fill price, by design (see header).
 */
function openPosition(decision) {
  return {
    ok: true,
    mode: MODE,
    orderId: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

module.exports = { currentMode, openPosition };
