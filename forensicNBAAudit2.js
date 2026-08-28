// Corrected forensic audit: plots the actual price-history trajectory (same source the real
// pipeline uses) around each game's recorded endDate, so the checkpoint's position relative to
// the price's stable-vs-volatile regions can be read directly instead of inferred from a
// trading-gap heuristic (which turned out to be unreliable -- trading continues through live
// games on this platform, it doesn't go quiet).
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
  const yesToken = JSON.parse(market.clobTokenIds)[0];
  const outcomes = JSON.parse(market.outcomes);
  const outcomePrices = JSON.parse(market.outcomePrices);
  const yesTeam = outcomes[0], noTeam = outcomes[1];
  const yesWon = outcomePrices[0] === '1';
  const recordedEnd = new Date(market.endDate);
  const recordedEndTs = Math.floor(recordedEnd.getTime() / 1000);
  const targetTs = recordedEndTs - 3 * 3600;

  const startTs = recordedEndTs - 30 * 3600; // 30h before recorded end
  const endTs = recordedEndTs + 8 * 3600; // 8h after, to see where it truly settles
  const hist = await fetchJson(`https://clob.polymarket.com/prices-history?market=${yesToken}&startTs=${startTs}&endTs=${endTs}&fidelity=15`);
  const points = (hist && hist.history) || [];

  console.log(`\n=== ${slug} ===`);
  console.log(`${yesTeam} (YES) vs ${noTeam} (NO). Winner: ${yesWon ? yesTeam : noTeam}. Recorded endDate: ${recordedEnd.toISOString()} (day of week: ${recordedEnd.toUTCString().slice(0, 3)})`);
  console.log(`Checkpoint target (recordedEnd - 3h): ${new Date(targetTs * 1000).toISOString()}`);
  console.log(`Price trajectory (YES=${yesTeam} price), sampled ~hourly, T-30h to T+8h relative to recorded endDate:`);

  // Find where price permanently settles to <0.03 or >0.97
  let settleTs = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i].p > 0.97 || points[i].p < 0.03) {
      const restSettled = points.slice(i).every((p) => p.p > 0.9 || p.p < 0.1);
      if (restSettled) { settleTs = points[i].t; break; }
    }
  }

  let lastBucketPrinted = null;
  let checkpointRow = null;
  for (const p of points) {
    const hoursSinceStart = ((p.t - startTs) / 3600);
    const bucket = Math.floor(hoursSinceStart); // hourly bucket
    if (bucket !== lastBucketPrinted) {
      const relToEnd = ((p.t - recordedEndTs) / 3600).toFixed(1);
      const isCheckpointHour = Math.abs(p.t - targetTs) < 1800;
      const marker = isCheckpointHour ? '  <== CHECKPOINT WINDOW' : '';
      console.log(`  ${new Date(p.t * 1000).toISOString()} (T${relToEnd >= 0 ? '+' : ''}${relToEnd}h)  ${yesTeam}=${p.p.toFixed(3)}${marker}`);
      lastBucketPrinted = bucket;
    }
    if (Math.abs(p.t - targetTs) < 900 && !checkpointRow) checkpointRow = p;
  }
  console.log(`Inferred settle time (price locks >0.97/<0.03 and stays): ${settleTs ? new Date(settleTs * 1000).toISOString() + ` (T${(((settleTs - recordedEndTs) / 3600)).toFixed(1)}h rel. to recorded end)` : 'not found in window'}`);
  console.log(`Checkpoint's real price-history value: ${checkpointRow ? checkpointRow.p.toFixed(3) : 'no point found near target'}`);

  return { slug, yesTeam, noTeam, yesWon, recordedEnd: recordedEnd.toISOString(), targetTs, settleTs, checkpointPrice: checkpointRow ? checkpointRow.p : null };
}

async function main() {
  const results = [];
  for (const slug of GAMES) {
    try { results.push(await auditGame(slug)); } catch (err) { console.log(`${slug} ERROR: ${err.message}`); }
    await sleep(200);
  }
  fs.writeFileSync('forensicNBAAudit2_results.json', JSON.stringify(results, null, 1));
  console.log('\nSaved forensicNBAAudit2_results.json');
}
main().catch((err) => { console.error(err); process.exit(1); });
