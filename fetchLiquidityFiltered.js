// Full re-run of the sports mispricing check, this time pulling liquidity data (real trade
// volume near each checkpoint) at fetch time, not as an afterthought. Lesson from the CBB
// episode: a price with no real trades around it isn't a real market belief, it's a stale
// quote, and needs to be discarded, not analyzed.
const fs = require('fs');

const TARGET_SPORTS = ['nfl', 'nba', 'nhl', 'cfb', 'mlb', 'cbb'];
const CHECKPOINTS_HOURS_BEFORE = [168, 72, 24, 3];
const CONCURRENCY = 20;
const LIQUIDITY_WINDOW_SEC = 3 * 3600; // +/- 3h, same standard that caught the CBB problem
const MIN_NOTIONAL_USD = 50; // must see at least a $50 bet's worth of real flow nearby to call it fillable

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, retries = 2) {
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

function sportOf(usSlug) {
  return usSlug.replace(/^aec-|^atc-/, '').split('-')[0];
}

// FIX (2026-08-27): '-spread-' used to be matched as ONE undifferentiated 'spread' type via
// a loose substring check, first-match-wins -- confirmed live that a single MLB event can
// list up to 6 structurally different spread contracts (away/home x 1.5/2.5 full-game, plus
// away/home x 1.5 first-5-innings), silently collapsing them into whichever Gamma happened
// to list first. Parses the exact slug suffix instead: `{eventSlug}-[f5-]spread-{away|home}-
// {Npt5}`. Gamma's own convention (confirmed against real question text -- e.g. "Spread:
// Baltimore Orioles (-1.5)" for a `-spread-away-1pt5` slug, "Spread: St. Louis Cardinals
// (-1.5)" for the paired `-spread-home-1pt5` slug on the same event): outcomes[0]/yesToken is
// ALWAYS the FAVORITE (the team named in the slug) covering the minus line, for BOTH the
// -away- and -home- variant of a given point value -- so pooling both under one canonical
// "the favorite on this line covers" proposition needs no additional YES/NO flip, it just
// needs the two contracts to not collide with each other or with the other point values/f5
// variant during dedup.
function parseSpreadSlug(slug, eventSlug) {
  const suffix = slug.slice(eventSlug.length);
  const m = suffix.match(/^-(f5-)?spread-(home|away)-(\d+pt\d+)$/);
  if (!m) return null;
  return { isF5: Boolean(m[1]), side: m[2], points: parseFloat(m[3].replace('pt', '.')) };
}

function pickSubmarkets(gammaMarkets, eventSlug) {
  const picks = {};
  for (const m of gammaMarkets) {
    let outcomePrices;
    try {
      outcomePrices = JSON.parse(m.outcomePrices || '[]');
    } catch {
      continue;
    }
    if (!(outcomePrices.length === 2 && ((outcomePrices[0] === '1' && outcomePrices[1] === '0') || (outcomePrices[0] === '0' && outcomePrices[1] === '1')))) continue;
    let clobTokenIds;
    try {
      clobTokenIds = JSON.parse(m.clobTokenIds || '[]');
    } catch {
      continue;
    }
    if (clobTokenIds.length !== 2) continue;

    // dedupeKey uniquely identifies this EXACT Gamma contract (never shared between
    // genuinely different markets, even ones pooled under the same output `type`). `type` is
    // the label written to the output record (submarketType) -- deliberately POOLED across
    // home/away for spread (see note above), but kept distinct per point value and
    // full-game-vs-f5, so those never mix.
    let dedupeKey = null;
    let type = null;
    if (m.slug === eventSlug) {
      dedupeKey = type = 'moneyline';
    } else if (m.slug.includes('-team-total-')) {
      continue;
    } else if (m.slug.includes('-spread-')) {
      const parsed = parseSpreadSlug(m.slug, eventSlug);
      if (!parsed) continue; // spread-shaped slug that doesn't match the known exact structure -- skip rather than guess at what it is
      dedupeKey = `spread_${parsed.isF5 ? 'f5' : 'full'}_${parsed.side}_${parsed.points}`;
      type = `spread${parsed.isF5 ? '_f5' : ''}_${parsed.points}`;
    } else if (m.slug.includes('-total-')) {
      // NOTE: 'total' (over/under) markets likely have the same multi-line ambiguity spread
      // did (different total values) -- unaddressed here, out of scope for this fix, which is
      // specifically about MLB spread. Flagging, not fixing.
      dedupeKey = type = 'total';
    }
    if (!type || picks[dedupeKey]) continue;

    picks[dedupeKey] = {
      slug: m.slug,
      type,
      conditionId: m.conditionId,
      yesToken: clobTokenIds[0],
      yesResolvedTo: outcomePrices[0] === '1' ? 1 : 0,
    };
  }
  return Object.values(picks);
}

function nearestPrice(history, targetTs) {
  if (!history || history.length === 0) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const pt of history) {
    const diff = Math.abs(pt.t - targetTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = pt;
    }
  }
  if (bestDiff > 6 * 3600) return null;
  return { price: best.p };
}

// FIX (2026-08-26): was aggregate across both sides of the market -- summed ANY trade
// within the window regardless of which token it was on. A market could show $1000s of
// real notional entirely from the OTHER side while the side this checkpoint's price
// actually came from (sm.yesToken, see nearestPrice's caller) had zero real trades --
// exactly the stale-quote failure mode this liquidity gate was built to catch, just
// slipping through partially instead of completely. Confirmed via live audit: sampled
// checkpoints ranged from 0% (NBA moneyline) to 40% (NHL spread) aggregate-liquid-but-not-
// side-specific-fillable. Now requires tokenId to match, same discipline as the live
// scanner's bestFill().
function notionalNear(trades, tokenId, targetTs) {
  let notional = 0;
  let count = 0;
  for (const tr of trades) {
    if (tr.asset !== tokenId) continue;
    if (Math.abs(tr.timestamp - targetTs) <= LIQUIDITY_WINDOW_SEC) {
      notional += tr.size * tr.price;
      count++;
    }
  }
  return { notional, count };
}

async function processEvent(usEvent) {
  const strippedSlug = usEvent.slug.replace(/^aec-|^atc-/, '');
  let gammaEvents;
  try {
    gammaEvents = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${strippedSlug}`);
  } catch (err) {
    return { usSlug: usEvent.slug, mapped: false, records: [] };
  }
  if (!Array.isArray(gammaEvents) || gammaEvents.length === 0) return { usSlug: usEvent.slug, mapped: false, records: [] };
  const gammaEvent = gammaEvents[0];
  const endDate = gammaEvent.endDate || usEvent.endDate;
  const endTs = Math.floor(new Date(endDate).getTime() / 1000);

  const submarkets = pickSubmarkets(gammaEvent.markets || [], strippedSlug);
  if (submarkets.length === 0) return { usSlug: usEvent.slug, mapped: true, records: [] };

  const records = [];
  for (const sm of submarkets) {
    const startTs = endTs - 9 * 86400;
    let history, trades;
    try {
      const [histData, tradesData] = await Promise.all([
        fetchJson(`https://clob.polymarket.com/prices-history?market=${sm.yesToken}&startTs=${startTs}&endTs=${endTs}&fidelity=30`),
        fetchJson(`https://data-api.polymarket.com/trades?market=${sm.conditionId}&limit=2000`),
      ]);
      history = histData?.history || [];
      trades = Array.isArray(tradesData) ? tradesData : [];
    } catch (err) {
      continue;
    }

    const checkpoints = {};
    for (const hoursBefore of CHECKPOINTS_HOURS_BEFORE) {
      const targetTs = endTs - hoursBefore * 3600;
      const priceInfo = nearestPrice(history, targetTs);
      // Scoped to sm.yesToken -- the exact same token the price above came from -- not to
      // whichever side a bucket later trades (that's decided downstream by aggregate bias
      // sign across the whole dataset and isn't known yet at fetch time).
      const liq = notionalNear(trades, sm.yesToken, targetTs);
      checkpoints[`h${hoursBefore}`] = priceInfo
        ? { price: priceInfo.price, nearbyNotionalUsd: liq.notional, nearbyTradeCount: liq.count, liquid: liq.notional >= MIN_NOTIONAL_USD }
        : null;
    }
    records.push({
      usSlug: usEvent.slug,
      gammaSlug: sm.slug,
      sport: sportOf(usEvent.slug),
      submarketType: sm.type,
      endDate: new Date(endTs * 1000).toISOString(),
      yesResolvedTo: sm.yesResolvedTo,
      checkpoints,
    });
  }
  return { usSlug: usEvent.slug, mapped: true, records };
}

async function main() {
  const allEvents = JSON.parse(fs.readFileSync('us_events_census_full.json', 'utf8'));
  const now = new Date();
  const targetEvents = allEvents.filter((e) => e.closed && e.endDate && new Date(e.endDate) <= now && TARGET_SPORTS.includes(sportOf(e.slug)));
  console.log(`Target events across ${TARGET_SPORTS.join(', ')}: ${targetEvents.length}`);

  const bySport = {};
  for (const e of targetEvents) bySport[sportOf(e.slug)] = (bySport[sportOf(e.slug)] || 0) + 1;
  console.log('By sport:', bySport);

  const allRecords = [];
  let mappedCount = 0;
  let done = 0;
  for (let i = 0; i < targetEvents.length; i += CONCURRENCY) {
    const batch = targetEvents.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(processEvent));
    for (const r of results) {
      if (r.mapped) mappedCount++;
      if (r.records) allRecords.push(...r.records);
    }
    done += batch.length;
    if (done % 200 === 0 || done === targetEvents.length) {
      console.log(`  ${done}/${targetEvents.length} events, ${mappedCount} mapped, ${allRecords.length} submarket records so far`);
      fs.writeFileSync('usSportsLiquidityFiltered.json', JSON.stringify(allRecords, null, 1));
    }
    await sleep(30);
  }

  console.log(`\nMapping rate: ${mappedCount}/${targetEvents.length}`);
  console.log(`Total submarket records: ${allRecords.length}`);
  fs.writeFileSync('usSportsLiquidityFiltered.json', JSON.stringify(allRecords, null, 1));
  console.log('Saved usSportsLiquidityFiltered.json');
}

module.exports = { processEvent, pickSubmarkets, parseSpreadSlug, sportOf, nearestPrice, notionalNear, CHECKPOINTS_HOURS_BEFORE };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
