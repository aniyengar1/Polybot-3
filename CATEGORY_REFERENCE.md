# Polymarket US category reference (as of 2026-08-26)

Source: full crawl of `gateway.polymarket.us/v1/events` (73,540 total events, all categories, paginated to completion). This supersedes the earlier partial census (which stopped at 2,499 and only saw "sports" — the catalog has grown ~29x since, and 5 more categories have been added).

| category | total events | resolved (closed, endDate in past) | still open | resolved date range | sub-types | Gamma `/prices-history` reachable? | Backtestable? | Caveats |
|---|---|---|---|---|---|---|---|---|
| **sports** | 72,011 | 69,543 | 2,379 | 2025-10-30 → 2026-08-25 | moneyline/spread/total across NFL, NBA, CBB, NHL, MLB, CFB, tennis (ATP/WTA/ITF), esports (CS2/LoL/Valorant/Dota2), table tennis, UFC, MLS, NPB, WNBA, and more (150+ league prefixes) | **Yes** — confirmed, prefix-strip mapping, 88% match rate | **Yes** | By far the largest resolved sample. CBB-specific mispricing already found here is NOT fillable at the 3-day-out mark (near-zero real trade volume that far out — see liquidity check). Multi-state regulatory exposure applies to trading real money on this category. Large `itfme`/`setkameua`/etc tennis buckets are low-profile ITF-tour matches — expect thin liquidity same as CBB, verify before assuming any sub-league is tradable. |
| **climate (weather)** | 579 | 571 | 8 | 2026-04-23 → 2026-08-25 | daily high-temp bucket markets (e.g. `temp-miahigh-2026-04-23`), multiple price buckets per city-day, same 5 cities the weather bot already trades (MIA/SFO/NYC/MDW/LAX) | **No** — confirmed not mirrored on Gamma (slug lookup returns zero matches); this product doesn't exist on global Polymarket at all | **Outcome-based: yes. Price/edge-based: unconfirmed** — no historical price-time-series endpoint found on the US gateway itself (the weather bot only reads live BBO, not history) | **Correction to prior assumption**: resolved history goes back to 2026-04-23, not ~2026-08-13 as previously assumed — over 4x more history than thought. 571 resolved outcomes is a real, non-thin sample for outcome/calibration-style backtests, but any "was this contract mispriced" strategy needs a historical price source that doesn't currently have a confirmed access path. |
| **politics** | 758 | 50 | 704 | 2026-06-02 → 2026-08-25 | US House/Senate/Governor races and specials (`ushr`, `usse`, `usgub`, `ussep`, etc.), mostly 2026 midterm-related | Not reachable via simple prefix-strip (0/3 sampled matched) — would need title-search fallback, unconfirmed | **No, not yet** | Resolved sample is thin (n=50) and concentrated in low-profile special elections, not the marquee midterm races (those are almost all still open, resolving Nov 2026). Revisit after the Nov 2026 midterms — that's when the real sample size and stakes both increase. |
| **culture** | 125 | 75 | 50 | 2026-03-15 → 2026-08-25 | Oscars, Emmys, Billboard, Netflix, Spotify, ESPYs, Grammys-adjacent awards markets | Not reachable via simple prefix-strip (0/3 sampled matched) | **No** | n=75 resolved is borderline-thin and highly heterogeneous (different award shows, not a uniform market type) — would fragment into single-digit sub-buckets if broken out properly. Not worth research time yet. |
| **macro** | 32 | 16 | 16 | 2026-04-29 → 2026-08-12 | Fed/rates/economic-data markets | Not checked (n too small to matter) | **No** | Too thin (n=16) to say anything statistically meaningful. |
| **technology** | 12 | 3 | 9 | — | — | Not checked | **No** | Negligible sample, brand new category. |
| **finance** | 11 | 1 | 10 | — | — | Not checked | **No** | Negligible sample, brand new category. |
| **crypto** | 6 | 0 | 6 | n/a | — | n/a | **No — dead** | Confirmed again: zero resolved events, ever. Do not spend research time here. |
| **geopolitics** | 3 | 0 | 3 | n/a | — | n/a | **No — dead** | Zero resolved events. |
| **science** | 3 | 0 | 3 | n/a | — | n/a | **No — dead** | Zero resolved events. |

## How to use this

Before spending research time on a new strategy idea, check this table for the category:
- If **resolved sample = 0 or single digits** (crypto, geopolitics, science, technology, finance): don't bother, nothing to backtest.
- If **thin (roughly <100)** (politics, culture, macro): note it, but don't expect a statistically defensible result — revisit politics specifically after Nov 2026 midterms resolve.
- If **large and Gamma-reachable** (sports): full backtest methodology (train/test split, checkpoints, band/type breakdown) applies, as already done — but always run the liquidity/fillability check (real trade volume near the entry timestamp) before trusting a price-based signal, since large resolved-sample size does not imply the price points used were tradable.
- **Weather/climate** is a special case: good resolved-outcome sample (571, back to April 2026, not Aug), but no confirmed historical price-data source outside the weather bot's own live BBO reads — a price-mispricing strategy here needs that gap closed first.

Re-run `censusUS_full.js` / `parallelCrawl.js` (in this directory) periodically — the catalog is still actively growing and gaining categories (6 categories now vs. 1 in the last census).
