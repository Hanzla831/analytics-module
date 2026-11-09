import { MAX_BUCKETS, type Granularity, type TimeRange } from './types.js';

export class AnalyticsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AnalyticsError';
    this.status = status;
    this.code = code;
  }
}

export class InvalidRangeError extends AnalyticsError {
  constructor(message: string) {
    super(400, 'invalid_range', message);
  }
}

export class UnknownMetricError extends AnalyticsError {
  constructor(metric: string) {
    super(404, 'unknown_metric', `Unknown metric "${metric}"`);
  }
}

export class InvalidDimensionError extends AnalyticsError {
  constructor(dimension: string, allowed: readonly string[]) {
    super(
      400,
      'invalid_dimension',
      `Dimension "${dimension}" is not available; allowed: ${allowed.join(', ') || 'none'}`,
    );
  }
}

/**
 * Wall-clock parts of an instant in a given IANA zone.
 *
 * `Intl` is used rather than a date library because it is the only thing in
 * the runtime that actually knows the tz database, including DST. Bucketing a
 * "day" without a timezone silently reports UTC days to a user in Karachi,
 * whose Monday started five hours earlier.
 */
function zonedParts(instant: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short',
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    weekday: Math.max(0, weekdays.indexOf(String(parts.weekday))),
  };
}

/** Offset of a zone from UTC at a given instant, in minutes. */
function zoneOffsetMinutes(instant: Date, timezone: string): number {
  const parts = zonedParts(instant, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour);
  // Compare against the same instant truncated to the hour in UTC.
  const truncated = Math.floor(instant.getTime() / 3600_000) * 3600_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/**
 * Start of the bucket containing `instant`, expressed as a UTC instant.
 *
 * Computed by finding the zone's wall-clock parts, zeroing the smaller units,
 * then converting back through the offset — which is what keeps a "day" aligned
 * to local midnight rather than to 00:00 UTC.
 */
export function bucketStart(instant: Date, granularity: Granularity, timezone: string): Date {
  const parts = zonedParts(instant, timezone);
  let year = parts.year;
  let month = parts.month;
  let day = parts.day;
  let hour = parts.hour;

  if (granularity === 'hour') {
    // Keep the hour as-is.
  } else if (granularity === 'day') {
    hour = 0;
  } else if (granularity === 'week') {
    hour = 0;
    // ISO weeks start on Monday; Sunday is treated as the seventh day.
    const offsetToMonday = (parts.weekday + 6) % 7;
    const shifted = new Date(Date.UTC(year, month - 1, day) - offsetToMonday * 86_400_000);
    year = shifted.getUTCFullYear();
    month = shifted.getUTCMonth() + 1;
    day = shifted.getUTCDate();
  } else {
    hour = 0;
    day = 1;
  }

  const naive = Date.UTC(year, month - 1, day, hour);
  const offset = zoneOffsetMinutes(instant, timezone);
  return new Date(naive - offset * 60_000);
}

/**
 * The bucket immediately after the one containing `instant`.
 *
 * The input is normalised to its own bucket start first. Without that, an
 * off-boundary instant skips a period: 31 January plus the 32-day month probe
 * lands in March, silently dropping February from the series.
 */
export function nextBucket(instant: Date, granularity: Granularity, timezone: string): Date {
  const start = bucketStart(instant, granularity, timezone);
  if (granularity === 'hour') return new Date(start.getTime() + 3600_000);

  // Stepping by a fixed 24h would drift by an hour across a DST change, so the
  // next boundary is recomputed from a probe safely inside the following
  // period — far enough in to clear the shortest month or a 23-hour day.
  const probeHours = granularity === 'day' ? 36 : granularity === 'week' ? 7 * 24 + 12 : 32 * 24;
  return bucketStart(new Date(start.getTime() + probeHours * 3600_000), granularity, timezone);
}

export function bucketLabel(start: Date, granularity: Granularity, timezone: string): string {
  const parts = zonedParts(start, timezone);
  const pad = (value: number): string => String(value).padStart(2, '0');

  switch (granularity) {
    case 'hour':
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:00`;
    case 'month':
      return `${parts.year}-${pad(parts.month)}`;
    default:
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  }
}

/**
 * Every bucket boundary covering the range.
 *
 * Bucket count is capped: an hourly report over five years is 43,800 buckets,
 * which is a denial-of-service vector dressed up as a date picker.
 */
export function buildBuckets(
  range: TimeRange,
  granularity: Granularity,
  timezone: string,
): Array<{ start: Date; end: Date }> {
  assertValidRange(range);

  const buckets: Array<{ start: Date; end: Date }> = [];
  let start = bucketStart(range.from, granularity, timezone);

  while (start.getTime() < range.to.getTime()) {
    const end = nextBucket(start, granularity, timezone);
    buckets.push({ start, end });

    if (buckets.length > MAX_BUCKETS) {
      throw new InvalidRangeError(
        `Range produces more than ${MAX_BUCKETS} buckets; widen the granularity`,
      );
    }
    start = end;
  }
  return buckets;
}

export function assertValidRange(range: TimeRange): void {
  if (Number.isNaN(range.from.getTime()) || Number.isNaN(range.to.getTime())) {
    throw new InvalidRangeError('Range contains an invalid date');
  }
  if (range.from.getTime() >= range.to.getTime()) {
    throw new InvalidRangeError('Range start must be before its end');
  }
}

/** The equal-length range immediately preceding this one. */
export function previousRange(range: TimeRange): TimeRange {
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: new Date(range.from.getTime()) };
}
