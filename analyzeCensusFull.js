const fs = require('fs');

const events = JSON.parse(fs.readFileSync('us_events_census_full.json', 'utf8'));
console.log(`Total events in full census: ${events.length}\n`);

function sportOf(slug) {
  return slug.replace(/^aec-|^atc-/, '').split('-')[0];
}

const byCat = new Map();
for (const e of events) {
  const cat = e.category || '(none)';
  if (!byCat.has(cat)) byCat.set(cat, { total: 0, closed: 0, open: 0, dates: [], prefixes: new Map() });
  const s = byCat.get(cat);
  s.total++;
  if (e.closed) s.closed++;
  else s.open++;
  const d = e.endDate || e.startDate;
  if (d) s.dates.push(d);
  const prefix = sportOf(e.slug);
  s.prefixes.set(prefix, (s.prefixes.get(prefix) || 0) + 1);
}

console.log('=== By category ===');
console.log('category | total | closed(resolved) | open | resolved date range');
const sorted = [...byCat.entries()].sort((a, b) => b[1].total - a[1].total);
for (const [cat, s] of sorted) {
  s.dates.sort();
  const range = s.dates.length ? `${s.dates[0]} -> ${s.dates[s.dates.length - 1]}` : 'n/a';
  console.log(`${cat} | ${s.total} | ${s.closed} | ${s.open} | ${range}`);
}

console.log('\n=== Sub-prefix breakdown per category (top prefixes) ===');
for (const [cat, s] of sorted) {
  const prefixEntries = [...s.prefixes.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n-- ${cat} (${s.total} total) --`);
  for (const [prefix, count] of prefixEntries.slice(0, 30)) {
    console.log(`  ${prefix}: ${count}`);
  }
  if (prefixEntries.length > 30) console.log(`  ...and ${prefixEntries.length - 30} more prefixes`);
}

fs.writeFileSync(
  'censusFullSummary.json',
  JSON.stringify(
    sorted.map(([cat, s]) => ({
      category: cat,
      total: s.total,
      closed: s.closed,
      open: s.open,
      dateRange: s.dates.length ? [s.dates[0], s.dates[s.dates.length - 1]] : null,
      prefixes: Object.fromEntries(s.prefixes),
    })),
    null,
    1
  )
);
console.log('\nSaved censusFullSummary.json');
