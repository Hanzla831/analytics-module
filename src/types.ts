/**
 * Analytics domain model.
 *
 * The central discipline here is that a reporting API must never silently
 * approximate. Every number it returns carries the bucket, the timezone and
 * the range it was computed over, because a dashboard figure with no stated
 * boundaries is one someone will eventually act on and be wrong about.
 */

export type Granularity = 'hour' | 'day' | 'week' | 'month';

export type AggregationType = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'uniqueCount';

/** One raw fact. Analytics reads these; it never writes them. */
export interface EventRecord {
  id: string;
  /** Metric this event contributes to, e.g. `appointment.booked`. */
  name: string;
  occurredAt: Date;
  /** Numeric contribution for sum/avg/min/max. Ignored by `count`. */
  value?: number;
  /** Used by `uniqueCount` — typically a user or session id. */
  subjectId?: string;
  /** Low-cardinality labels available for filtering and grouping. */
  dimensions?: Record<string, string>;
}

export interface MetricDefinition {
  name: string;
  label: string;
  aggregation: AggregationType;
  /** Events feeding this metric. Defaults to events named the same. */
  eventName?: string;
  /** Dimensions a caller may group or filter by; anything else is rejected. */
  allowedDimensions?: readonly string[];
  unit?: string;
}

export interface TimeRange {
  from: Date;
  /** Exclusive, so adjacent ranges neither overlap nor leave a gap. */
  to: Date;
}

export interface ReportQuery {
  metric: string;
  range: TimeRange;
  granularity: Granularity;
  /** IANA zone. Day boundaries are meaningless without one. */
  timezone?: string;
  filters?: Record<string, string>;
  groupBy?: string;
  /** Also compute the preceding range of equal length, for deltas. */
  compareToPrevious?: boolean;
}

export interface Bucket {
  /** Inclusive start of the bucket, in UTC. */
  start: Date;
  /** Exclusive end. */
  end: Date;
  label: string;
  value: number;
  /** Events contributing, which is not the same as `value` for sum or avg. */
  sampleCount: number;
}

export interface SeriesComparison {
  total: number;
  previousTotal: number;
  /** Null when the previous total is zero — a ratio against nothing is not a
   *  100% rise, it is undefined, and rendering it as a number misleads. */
  changeRatio: number | null;
}

export interface ReportResult {
  metric: string;
  label: string;
  unit: string | null;
  granularity: Granularity;
  timezone: string;
  range: TimeRange;
  buckets: Bucket[];
  total: number;
  /** Present only when `groupBy` was requested. */
  groups?: Array<{ key: string; total: number; buckets: Bucket[] }>;
  comparison?: SeriesComparison;
  /** True when the final bucket is still accruing data. */
  partialLastBucket: boolean;
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export const DEFAULT_TIMEZONE = 'UTC';
/** Caps a request to a sane number of buckets; see `assertBucketBudget`. */
export const MAX_BUCKETS = 1_000;
