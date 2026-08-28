// Forensic audit of individual NBA moneyline trades from the Nov-Apr zero-loss streak.
// For each trade: (1) find the real trading-activity gap that plausibly corresponds to live
// game time (a long quiet period followed by a decisive price-crash burst is the signature of
// "no one traded during the game, then everyone traded once the result was known"), (2) compare
// Gamma's recorded endDate to that inferred real resolution point, (3) check whether the h3
// checkpoint's target timestamp (recordedEnd - 3h) falls before the inferred tip-off (safe) or
// during/after the live-game gap (leakage risk), (4) confirm side-matching between yesResolvedTo
// and which team's price actually converged to ~1.
const fs = require('fs');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fetchJson(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'flb-research/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
}

const GAMES = [
  'nba-mem-bos-2025-11-12',
  'nba-ind-cle-2025-11-21',
  'nba-was-phi-2025-12-02',
  'nba-por-okc-2025-12-31',
  'nba-mil-bos-2026-02-01',
  'nba-sac-lal-2026-03-01',
  'nba-mil-hou-2026-04-01',
  'nba-mil-phi-2026-04-12',
];

async function auditGame(slug) {
  const ev = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  const gammaEvent = ev[0];
  const market = gammaEvent.markets.find((m) => m.slug === slug);
  const conditionId = market.conditionId;
  const clobTokenIds = JSON.parse(market.clobTokenIds);
  const outcomes = JSON.parse(market.outcomes);
  const outcomePrices = JSON.parse(market.outcomePrices);
  const recordedEnd = new Date(market.endDate);
  const yesTeam = outcomes[0], noTeam = outcomes[1];
  const yesWon = outcomePrices[0] === '1';

  let trades = await fetchJson(`https://data-api.polymarket.com/trades?market=${conditionId}&limit=5000`);
  if (!Array.isArray(trades)) trades = [];
  trades.sort((a, b) => a.timestamp - b.timestamp);

  // Find the biggest gap among the last 30 trades before things "settle" -- proxy for live game
  // time. Then find the settle point: first trade after which yesTeam's price stays >0.95 or
  // <0.05 for the rest of the market's life (robust proxy for "outcome known").
  let settleIdx = -1;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    const isYes = t.outcome === yesTeam;
    const yesPrice = isYes ? t.price : 1 - t.price;
    if (yesPrice > 0.05 && yesPrice < 0.95) { settleIdx = i + 1; break; }
  }
  const settleTs = settleIdx >= 0 && settleIdx < trades.length ? trades[settleIdx].timestamp : null;

  // Biggest gap in the 2 hours before settleTs (proxy for live-game quiet period -> start of gap = inferred tip-off)
  let gapStart = null, gapEnd = null, gapSize = 0;
  if (settleTs) {
    const preSettle = trades.filter((t) => t.timestamp < settleTs && t.timestamp > settleTs - 5 * 3600);
    for (let i = 1; i < preSettle.length; i++) {
      const gap = preSettle[i].timestamp - preSettle[i - 1].timestamp;
      if (gap > gapSize) { gapSize = gap; gapStart = preSettle[i - 1].timestamp; gapEnd = preSettle[i].timestamp; }
    }
  }

  const targetTs = Math.floor(recordedEnd.getTime() / 1000) - 3 * 3600;

  // Real checkpoint fill: nearest trade to targetTs within +/-3h (same logic as the live pipeline)
  let best = null, bestDiff = Infinity;
  for (const t of trades) {
    const diff = Math.abs(t.timestamp - targetTs);
    if (diff <= 3 * 3600 && diff < bestDiff) { bestDiff = diff; best = t; }
  }
  const checkpointFillYesPrice = best ? (best.outcome === yesTeam ? best.price : 1 - best.price) : null;

  console.log(`\n=== ${slug} ===`);
  console.log(`Market: ${yesTeam} (YES) vs ${noTeam} (NO). Resolved: ${yesWon ? yesTeam : noTeam} won. yesResolvedTo=${yesWon ? 1 : 0}`);
  console.log(`Recorded endDate (Gamma): ${recordedEnd.toISOString()}`);
  console.log(`Inferred real settle point (price crosses to >95%/<5% and stays): ${settleTs ? new Date(settleTs * 1000).toISOString() : 'NOT FOUND'}`);
  console.log(`Biggest pre-settle trading gap (proxy for live game window): ${gapStart ? new Date(gapStart * 1000).toISOString() : 'n/a'} -> ${gapEnd ? new Date(gapEnd * 1000).toISOString() : 'n/a'} (${(gapSize / 60).toFixed(0)} min quiet)`);
  console.log(`Checkpoint target (recordedEnd - 3h): ${new Date(targetTs * 1000).toISOString()}`);
  const targetVsGap = gapStart ? (targetTs < gapStart ? 'BEFORE inferred tip-off (pre-game, safe)' : targetTs <= gapEnd ? '*** DURING the inferred live-game gap -- LEAKAGE RISK ***' : '*** AFTER the inferred live-game gap -- LEAKAGE RISK ***') : 'no gap detected to compare against';
  console.log(`Checkpoint target vs inferred tip-off: ${targetVsGap}`);
  console.log(`Checkpoint's actual matched real trade: ${best ? new Date(best.timestamp * 1000).toISOString() + `  (${best.outcome} ${best.side} @ ${best.price}, i.e. YES(${yesTeam})=${checkpointFillYesPrice.toFixed(3)})` : 'NO MATCH within +/-3h'}`);
  const recordedHistPrice = null; // not refetched here, just comparing real-trade fill
  console.log(`Recorded dataset checkpoint price (from usSportsLiquidityFiltered_v2.json) should be close to the real fill above if timing is honest.`);

  return { slug, yesTeam, noTeam, yesWon, recordedEnd, settleTs, gapStart, gapEnd, targetTs, checkpointFillYesPrice, bestFillTs: best ? best.timestamp : null };
}

async function main() {
  const results = [];
  for (const slug of GAMES) {
    try {
      const r = await auditGame(slug);
      results.push(r);
    } catch (err) {
      console.log(`\n=== ${slug} === ERROR: ${err.message}`);
    }
    await sleep(200);
  }
  fs.writeFileSync('forensicNBAAudit_results.json', JSON.stringify(results, null, 1));
  console.log('\n\nSaved forensicNBAAudit_results.json');
}

main().catch((err) => { console.error(err); process.exit(1); });
