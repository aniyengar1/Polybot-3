// Check 1: is the 3-days-out price point backed by real trading activity, or is it a stale/thin quote?
// For a sample of the actual CBB moneyline trades used in the P&L sim, pull real trade history
// (data-api.polymarket.com/trades, confirmed public, gives size/price/timestamp) and look at
// activity in a window around the h72 checkpoint timestamp.
const fs = require('fs');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'flb-research/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const { train, test } = JSON.parse(fs.readFileSync('splitRecords.json', 'utf8'));
  const all = [...train, ...test];
  const cbbTrades = all.filter(
    (r) => r.submarketType === 'moneyline' && r.checkpoints.h72 && r.checkpoints.h72.price > 0.3 && r.checkpoints.h72.price < 0.4 && r.usSlug.includes('cbb')
  );
  console.log(`Total CBB trades in the 0.30-0.40/h72 bucket (train+test): ${cbbTrades.length}`);

  // Random-ish sample spread across the full period, not just the front
  const SAMPLE_N = 25;
  const step = Math.max(1, Math.floor(cbbTrades.length / SAMPLE_N));
  const sample = [];
  for (let i = 0; i < cbbTrades.length && sample.length < SAMPLE_N; i += step) sample.push(cbbTrades[i]);
  console.log(`Sampling ${sample.length} of them for order-flow inspection.\n`);

  const results = [];
  for (const t of sample) {
    let gammaEvents;
    try {
      gammaEvents = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${t.gammaSlug}`);
    } catch (err) {
      results.push({ slug: t.gammaSlug, error: 'gamma lookup failed' });
      continue;
    }
    const market = gammaEvents[0]?.markets?.find((m) => m.slug === t.gammaSlug);
    if (!market) {
      results.push({ slug: t.gammaSlug, error: 'no market match' });
      continue;
    }
    let trades;
    try {
      trades = await fetchJson(`https://data-api.polymarket.com/trades?market=${market.conditionId}&limit=1000`);
    } catch (err) {
      results.push({ slug: t.gammaSlug, error: 'trades lookup failed' });
      continue;
    }
    const endTs = Math.floor(new Date(t.endDate).getTime() / 1000);
    const targetTs = endTs - 72 * 3600;
    const WINDOW_SEC = 3 * 3600; // +/- 3h around the checkpoint
    const nearby = trades.filter((tr) => Math.abs(tr.timestamp - targetTs) <= WINDOW_SEC);
    const notionalNearby = nearby.reduce((s, tr) => s + tr.size * tr.price, 0);
    const sharesNearby = nearby.reduce((s, tr) => s + tr.size, 0);
    const totalLifetimeTrades = trades.length;
    const totalLifetimeVolume = market.volumeNum || market.volume || 0;

    results.push({
      slug: t.gammaSlug,
      checkpointPrice: t.checkpoints.h72.price,
      tradesNear3d: nearby.length,
      sharesNear3d: Math.round(sharesNearby),
      notionalNear3dUsd: Math.round(notionalNearby),
      totalLifetimeTrades,
      totalLifetimeVolumeUsd: Math.round(totalLifetimeVolume),
    });
    await sleep(120);
  }

  console.log('slug | checkpoint_price | trades_within_3h_of_checkpoint | shares_traded | $ notional near checkpoint | total lifetime trades | total lifetime $volume');
  for (const r of results) {
    if (r.error) {
      console.log(`${r.slug} | ERROR: ${r.error}`);
      continue;
    }
    console.log(`${r.slug} | ${r.checkpointPrice} | ${r.tradesNear3d} | ${r.sharesNear3d} | $${r.notionalNear3dUsd} | ${r.totalLifetimeTrades} | $${r.totalLifetimeVolumeUsd}`);
  }

  const valid = results.filter((r) => !r.error);
  const zeroActivity = valid.filter((r) => r.tradesNear3d === 0).length;
  const under50Notional = valid.filter((r) => r.notionalNear3dUsd < 50).length;
  console.log(`\n${zeroActivity}/${valid.length} sampled markets had ZERO trades within +/-3h of the 3-day-out checkpoint.`);
  console.log(`${under50Notional}/${valid.length} had less than $50 total notional traded in that window (i.e., a single $50 buy order would have been the majority of activity, or unfillable at that price).`);
  const avgLifetimeTrades = valid.reduce((s, r) => s + r.totalLifetimeTrades, 0) / valid.length;
  const avgLifetimeVolume = valid.reduce((s, r) => s + r.totalLifetimeVolumeUsd, 0) / valid.length;
  console.log(`Avg total lifetime trades per market: ${avgLifetimeTrades.toFixed(0)}, avg total lifetime $volume: $${avgLifetimeVolume.toFixed(0)}`);

  fs.writeFileSync('check1_results.json', JSON.stringify(results, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
