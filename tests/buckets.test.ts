import { describe, expect, it } from 'vitest';
import {
  InvalidRangeError,
  assertValidRange,
  bucketLabel,
  bucketStart,
  buildBuckets,
  nextBucket,
  previousRange,
} from '../src/buckets.js';

const utc = (y: number, m: number, d: number, h = 0): Date => new Date(Date.UTC(y, m - 1, d, h));

describe('bucket boundaries', () => {
  it('truncates to the hour', () => {
    const start = bucketStart(new Date(Date.UTC(2026, 0, 15, 14, 37)), 'hour', 'UTC');
    expect(start.toISOString()).toBe('2026-01-15T14:00:00.000Z');
  });

  it('truncates to local midnight, not UTC midnight', () => {
    // 2026-01-15T20:00Z is already 2026-01-16 01:00 in Karachi (UTC+5), so the
    // day bucket is the 16th there and the 15th in UTC.
    const instant = new Date(Date.UTC(2026, 0, 15, 20, 0));
    expect(bucketLabel(bucketStart(instant, 'day', 'UTC'), 'day', 'UTC')).toBe('2026-01-15');
    expect(bucketLabel(bucketStart(instant, 'day', 'Asia/Karachi'), 'day', 'Asia/Karachi')).toBe(
      '2026-01-16',
    );
  });

  it('starts weeks on Monday', () => {
    // 2026-01-15 is a Thursday.
    const start = bucketStart(utc(2026, 1, 15), 'week', 'UTC');
    expect(bucketLabel(start, 'day', 'UTC')).toBe('2026-01-12');
  });

  it('treats Sunday as the end of its week', () => {
    const sunday = utc(2026, 1, 18, 12);
    expect(bucketLabel(bucketStart(sunday, 'week', 'UTC'), 'day', 'UTC')).toBe('2026-01-12');
  });

  it('truncates to the first of the month', () => {
    expect(bucketLabel(bucketStart(utc(2026, 3, 22, 9), 'month', 'UTC'), 'month', 'UTC')).toBe(
      '2026-03',
    );
  });
});

describe('advancing buckets', () => {
  it('steps an hour', () => {
    const start = utc(2026, 1, 15, 10);
    expect(nextBucket(start, 'hour', 'UTC').toISOString()).toBe('2026-01-15T11:00:00.000Z');
  });

  it('steps a day', () => {
    expect(bucketLabel(nextBucket(utc(2026, 1, 15), 'day', 'UTC'), 'day', 'UTC')).toBe('2026-01-16');
  });

  it('steps a month across differing lengths', () => {
    expect(bucketLabel(nextBucket(utc(2026, 1, 31), 'month', 'UTC'), 'month', 'UTC')).toBe('2026-02');
    expect(bucketLabel(nextBucket(utc(2026, 2, 1), 'month', 'UTC'), 'month', 'UTC')).toBe('2026-03');
  });

  it('keeps days aligned to local midnight across a DST change', () => {
    // Berlin moves forward on 2026-03-29. A fixed 24h step would drift an hour
    // and start labelling days at 01:00.
    const berlin = 'Europe/Berlin';
    let start = bucketStart(new Date(Date.UTC(2026, 2, 27, 12)), 'day', berlin);

    for (let i = 0; i < 4; i += 1) {
      const label = bucketLabel(start, 'day', berlin);
      expect(label).toMatch(/^2026-03-\d{2}$/);
      start = nextBucket(start, 'day', berlin);
    }
  });
});

describe('building a series', () => {
  it('covers the range with contiguous buckets', () => {
    const buckets = buildBuckets({ from: utc(2026, 1, 1), to: utc(2026, 1, 8) }, 'day', 'UTC');
    expect(buckets).toHaveLength(7);

    for (let i = 1; i < buckets.length; i += 1) {
      // No gaps and no overlap: each bucket starts exactly where the last ended.
      expect(buckets[i]!.start.getTime()).toBe(buckets[i - 1]!.end.getTime());
    }
  });

  it('rejects an inverted or invalid range', () => {
    expect(() => assertValidRange({ from: utc(2026, 1, 8), to: utc(2026, 1, 1) })).toThrow(
      InvalidRangeError,
    );
    expect(() => assertValidRange({ from: new Date('nope'), to: utc(2026, 1, 1) })).toThrow(
      InvalidRangeError,
    );
  });

  it('refuses a range that would explode into too many buckets', () => {
    // Hourly over five years is ~43,800 buckets — a denial-of-service vector
    // dressed up as a date picker.
    expect(() =>
      buildBuckets({ from: utc(2020, 1, 1), to: utc(2026, 1, 1) }, 'hour', 'UTC'),
    ).toThrow(InvalidRangeError);
  });
});

describe('previousRange', () => {
  it('returns the equal-length range immediately before', () => {
    const range = { from: utc(2026, 1, 8), to: utc(2026, 1, 15) };
    const previous = previousRange(range);

    expect(previous.to.getTime()).toBe(range.from.getTime());
    expect(previous.to.getTime() - previous.from.getTime()).toBe(
      range.to.getTime() - range.from.getTime(),
    );
  });
});
