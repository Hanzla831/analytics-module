/**
 * Public surface of the analytics module.
 *
 * The aggregator, bucketing and CSV export have no HTTP dependency; only
 * app.ts imports Express, so reports can be produced by a scheduled job or a
 * CLI with none of the web layer.
 */
export * from './types.js';
export { AnalyticsError, InvalidRangeError, UnknownMetricError, InvalidDimensionError, bucketStart, nextBucket, bucketLabel, buildBuckets, previousRange, assertValidRange } from './buckets.js';
export { Aggregator, MetricRegistry, aggregate } from './aggregator.js';
export { InMemoryEventStore, ReportCache, type EventStore, type EventQuery } from './store.js';
export { reportToCsv, escapeCsvCell, toCsvRow, contentDisposition } from './csv.js';
export { createApp, DEFAULT_METRICS, type AppDependencies, type BuiltApp } from './app.js';
