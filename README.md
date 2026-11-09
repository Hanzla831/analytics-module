# Analytics & Reporting Dashboard

Reporting API for Node.js / TypeScript: timezone-aware time bucketing,
count/sum/avg/min/max/unique aggregations, dimension filtering and grouping,
period-over-period comparison, report caching and safe CSV export.

The aggregator has no HTTP dependency — only `app.ts` imports Express — so the
same reports can be produced by a scheduled job or a CLI.

```
src/
  types.ts       Metrics, queries, buckets, results
  buckets.ts     Timezone-aware boundaries and range validation
  aggregator.ts  Metric registry and the aggregation pipeline
  store.ts       Event storage boundary + report cache
  csv.ts         RFC 4180 export with formula-injection defence
  app.ts         HTTP API
```

## Decisions worth explaining

**Day boundaries need a timezone.** Bucketing a "day" without one silently
reports UTC days to a user in Karachi, whose Monday started five hours earlier.
`Intl` is used rather than a date library because it is the only thing in the
runtime that actually knows the tz database.

**Stepping is recomputed, never added.** Advancing a day by a fixed 24 hours
drifts by an hour across a DST change and starts labelling days at 01:00. Each
boundary is derived from a probe safely inside the next period. The input is
normalised to its own bucket start first — otherwise 31 January plus a 32-day
month probe lands in March and February vanishes from the series.

**Empty buckets are emitted.** A chart that simply skips a quiet Tuesday draws
a straight line across it and hides the outage.

**The upper bound is exclusive.** Otherwise a month total and that total plus
one day differ, and adjacent ranges double-count their shared boundary.

**A partial final bucket is flagged.** Today shown next to complete days looks
like a crash in traffic unless the caller knows it is still accruing — and such
reports are never cached, since a minute of staleness makes a live dashboard
look stuck.

**Zero, not NaN, for an empty aggregation.** NaN renders as a broken axis.

**Growth from a zero baseline is `null`, not +100%.** A ratio against nothing
is undefined, and rendering it as a number misleads.

**Dimensions are an allowlist per metric.** An arbitrary `groupBy` on a
high-cardinality field is both a performance hazard and a way to read data the
caller was never meant to see.

**Bucket count is capped.** Hourly over five years is ~43,800 buckets — a
denial-of-service vector dressed up as a date picker.

**CSV export defends against formula injection.** A cell beginning `=`, `+`,
`-` or `@` is executed by Excel and Sheets on open; `=HYPERLINK(...)` or a DDE
payload turns an innocuous export into code execution on the analyst's machine.
Those values are prefixed with a quote, on top of normal RFC 4180 escaping.

**The cache key includes every parameter.** Keyed on the metric alone, it would
serve one timezone's answer to a caller in another.

## Running it

```bash
npm test        # 48 tests
npm run typecheck
```

## Going to production

Replace `InMemoryEventStore`. It filters in JavaScript, which is fine for tests
but wrong at scale — the aggregation belongs in the database, where a
`GROUP BY date_trunc(...)` returns tens of rows instead of shipping millions of
events into the process to be counted.
