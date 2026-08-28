// Live verification against known-correct answers from the earlier backtest thread (real
// resolved games whose win/loss the whole project has already independently confirmed).
// Looks up each event fresh and finds the actual market slug by sportsMarketTypeV2 rather
// than assuming it matches the event slug or the old backtest-normalized usSlug -- see
// settlementChecker.js header for why that assumption doesn't always hold.
const { checkOnePosition } = require('./settlementChecker');

async function findMarketSlug(eventSlug, sportsMarketType) {
  const res = await fetch(`https://gateway.polymarket.us/v1/events/slug/${eventSlug}`);
  if (!res.ok) return null;
  const data = await res.json();
  const m = (data.event.markets || []).find((mm) => mm.sportsMarketTypeV2 === sportsMarketType);
  return m ? m.slug : null;
}

const testCases = [
  // Known resolved: Celtics (NO side) won -- confirmed in the forensic audit.
  { eventSlug: 'aec-nba-mem-bos-2025-11-12', type: 'SPORTS_MARKET_TYPE_MONEYLINE', side: 'NO', expected: 'won' },
  // Known resolved MLB moneylines, side=NO, both won per the April backtest's real-outcomes data.
  { eventSlug: 'mlb-wsh-phi-2026-03-31', type: 'SPORTS_MARKET_TYPE_MONEYLINE', side: 'NO', expected: 'won' },
  { eventSlug: 'mlb-cle-lad-2026-03-31', type: 'SPORTS_MARKET_TYPE_MONEYLINE', side: 'NO', expected: 'won' },
  // Currently open, real future MLB moneyline game -- must come back pending.
  { eventSlug: 'mlb-hou-nym-2026-08-29', type: 'SPORTS_MARKET_TYPE_MONEYLINE', side: 'YES', expected: 'pending' },
  // Same resolved NBA game but pretend we'd held the OTHER side -- must flip to lost.
  { eventSlug: 'aec-nba-mem-bos-2025-11-12', type: 'SPORTS_MARKET_TYPE_MONEYLINE', side: 'YES', expected: 'lost' },
  // Known resolved NHL spread, side=NO, won per the April backtest.
  { eventSlug: 'nhl-ana-sj-2026-04-01', type: 'SPORTS_MARKET_TYPE_SPREAD', side: 'NO', expected: 'won' },
];

async function main() {
  let pass = 0;
  for (const tc of testCases) {
    const marketSlug = await findMarketSlug(tc.eventSlug, tc.type);
    if (!marketSlug) {
      console.log(`FAIL  ${tc.eventSlug} -- could not find a ${tc.type} market in this event`);
      continue;
    }
    const result = await checkOnePosition({ eventSlug: tc.eventSlug, marketSlug, side: tc.side });
    const ok = result.status === tc.expected;
    pass += ok ? 1 : 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${tc.eventSlug} (${marketSlug}) side=${tc.side} -> got ${result.status}, expected ${tc.expected}${result.outcomePrices ? '  outcomePrices=' + JSON.stringify(result.outcomePrices) : ''}${result.reason ? '  reason=' + result.reason : ''}`);
  }
  console.log(`\n${pass}/${testCases.length} passed`);
}
main().catch((err) => { console.error(err); process.exit(1); });
