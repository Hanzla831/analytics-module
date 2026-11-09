import { describe, expect, it } from 'vitest';
import { Aggregator, MetricRegistry, aggregate } from '../src/aggregator.js';
import { InMemoryEventStore, ReportCache } from '../src/store.js';
import { InvalidDimensionError, UnknownMetricError } from '../src/buckets.js';
import { escapeCsvCell, reportToCsv } from '../src/csv.js';
import { DEFAULT_METRICS } from '../src/app.js';
import type { EventRecord } from '../src/types.js';

const utc = (y: number, m: number, d: number, h = 0): Date => new Date(Date.UTC(y, m - 1, d, h));
const NOW = utc(2026, 1, 20);

let counter = 0;
const event = (name: string, occurredAt: Date, extra: Partial<EventRecord> = {}): EventRecord => ({
  id: `e${(counter += 1)}`,
  name,
  occurredAt,
  ...extra,
});

function build(events: EventRecord[]) {
  const store = new InMemoryEventStore(events);
  const registry = new MetricRegistry(DEFAULT_METRICS);
  return new Aggregator(store, registry, { clock: () => NOW });
}

describe('aggregation functions', () => {
  const events = [
    event('x', NOW, { value: 10, subjectId: 'u1' }),
    event('x', NOW, { value: 20, subjectId: 'u1' }),
    event('x', NOW, { value: 30, subjectId: 'u2' }),
  ];

  it('computes each aggregation', () => {
    expect(aggregate('count', events)).toBe(3);
    expect(aggregate('sum', events)).toBe(60);
    expect(aggregate('avg', events)).toBe(20);
    expect(aggregate('min', events)).toBe(10);
    expect(aggregate('max', events)).toBe(30);
    expect(aggregate('uniqueCount', events)).toBe(2);
  });

  it('returns zero rather than NaN for an empty bucket', () => {
    // NaN renders as a broken axis; zero renders as a flat line.
    expect(aggregate('avg', [])).toBe(0);
    expect(aggregate('sum', [])).toBe(0);
  });

  it('ignores non-numeric values', () => {
    const mixed = [event('x', NOW, { value: 10 }), event('x', NOW)];
    expect(aggregate('avg', mixed)).toBe(10);
  });

  it('counts anonymous events as distinct', () => {
    // Falling back to the event id avoids collapsing every anonymous event
    // into a single "user".
    expect(aggregate('uniqueCount', [event('x', NOW), event('x', NOW)])).toBe(2);
  });
});

describe('reports', () => {
  it('buckets events by day and totals them', async () => {
    const aggregator = build([
      event('appointment.booked', utc(2026, 1, 10, 9)),
      event('appointment.booked', utc(2026, 1, 10, 14)),
      event('appointment.booked', utc(2026, 1, 12, 11)),
    ]);

    const report = await aggregator.run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 13) },
      granularity: 'day',
    });

    expect(report.total).toBe(3);
    expect(report.buckets.map((b) => b.value)).toEqual([2, 0, 1]);
  });

  it('emits empty buckets instead of skipping quiet periods', async () => {
    const report = await build([event('appointment.booked', utc(2026, 1, 10, 9))]).run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 15) },
      granularity: 'day',
    });

    // A chart that skips a quiet day draws a straight line across it and
    // hides the outage.
    expect(report.buckets).toHaveLength(5);
    expect(report.buckets[1]!.value).toBe(0);
  });

  it('sums a revenue metric', async () => {
    const report = await build([
      event('invoice.total', utc(2026, 1, 10), { value: 2500 }),
      event('invoice.total', utc(2026, 1, 10), { value: 1500 }),
    ]).run({
      metric: 'invoice.total',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 11) },
      granularity: 'day',
    });

    expect(report.total).toBe(4000);
    expect(report.unit).toBe('PKR');
  });

  it('respects the exclusive upper bound', async () => {
    const report = await build([event('appointment.booked', utc(2026, 1, 11))]).run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 11) },
      granularity: 'day',
    });
    // Otherwise a month total and that total plus one day would differ.
    expect(report.total).toBe(0);
  });

  it('flags a still-accruing final bucket', async () => {
    const aggregator = build([]);
    const settled = await aggregator.run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 15) },
      granularity: 'day',
    });
    const live = await aggregator.run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 25) },
      granularity: 'day',
    });

    expect(settled.partialLastBucket).toBe(false);
    // Today alongside complete days looks like a crash unless it is flagged.
    expect(live.partialLastBucket).toBe(true);
  });

  it('rejects an unknown metric', async () => {
    await expect(
      build([]).run({
        metric: 'nope',
        range: { from: utc(2026, 1, 10), to: utc(2026, 1, 11) },
        granularity: 'day',
      }),
    ).rejects.toBeInstanceOf(UnknownMetricError);
  });
});

describe('filters and grouping', () => {
  const events = [
    event('appointment.booked', utc(2026, 1, 10), { dimensions: { clinic: 'north' } }),
    event('appointment.booked', utc(2026, 1, 10), { dimensions: { clinic: 'north' } }),
    event('appointment.booked', utc(2026, 1, 10), { dimensions: { clinic: 'south' } }),
  ];

  it('filters by dimension', async () => {
    const report = await build(events).run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 11) },
      granularity: 'day',
      filters: { clinic: 'north' },
    });
    expect(report.total).toBe(2);
  });

  it('groups and orders by size', async () => {
    const report = await build(events).run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 11) },
      granularity: 'day',
      groupBy: 'clinic',
    });

    expect(report.groups!.map((g) => [g.key, g.total])).toEqual([
      ['north', 2],
      ['south', 1],
    ]);
  });

  it('rejects a dimension outside the metric allowlist', async () => {
    // An arbitrary groupBy on a high-cardinality field is both a performance
    // hazard and a way to read data the caller should not see.
    await expect(
      build(events).run({
        metric: 'appointment.booked',
        range: { from: utc(2026, 1, 10), to: utc(2026, 1, 11) },
        granularity: 'day',
        groupBy: 'patientEmail',
      }),
    ).rejects.toBeInstanceOf(InvalidDimensionError);
  });

  it('buckets missing dimension values under a visible label', async () => {
    const report = await build([event('appointment.booked', utc(2026, 1, 10))]).run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 11) },
      granularity: 'day',
      groupBy: 'clinic',
    });
    expect(report.groups![0]!.key).toBe('(none)');
  });
});

describe('period comparison', () => {
  it('computes the change against the preceding range', async () => {
    const report = await build([
      event('appointment.booked', utc(2026, 1, 8)),
      event('appointment.booked', utc(2026, 1, 11)),
      event('appointment.booked', utc(2026, 1, 12)),
    ]).run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 13) },
      granularity: 'day',
      compareToPrevious: true,
    });

    expect(report.comparison).toMatchObject({ total: 2, previousTotal: 1, changeRatio: 1 });
  });

  it('returns null rather than a fake percentage from a zero baseline', async () => {
    const report = await build([event('appointment.booked', utc(2026, 1, 11))]).run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 13) },
      granularity: 'day',
      compareToPrevious: true,
    });
    // Growth from nothing is undefined, not "+100%".
    expect(report.comparison!.changeRatio).toBeNull();
  });
});

describe('cache', () => {
  it('returns a value within its TTL and expires it afterwards', () => {
    const cache = new ReportCache(1_000);
    cache.set('k', { total: 5 }, 0);

    expect(cache.get('k', 500)).toEqual({ total: 5 });
    expect(cache.get('k', 1_500)).toBeNull();
  });

  it('keys on every parameter that changes the answer', () => {
    const cache = new ReportCache();
    // A cache keyed on the metric alone would serve one timezone's answer to
    // a caller in another.
    expect(cache.key({ metric: 'a', timezone: 'UTC' })).not.toBe(
      cache.key({ metric: 'a', timezone: 'Asia/Karachi' }),
    );
    expect(cache.key({ a: 1, b: 2 })).toBe(cache.key({ b: 2, a: 1 }));
  });
});

describe('CSV export', () => {
  it('quotes values containing separators', () => {
    expect(escapeCsvCell('north, south')).toBe('"north, south"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('neutralises spreadsheet formula injection', () => {
    // Excel and Sheets execute these on open; =HYPERLINK or a DDE payload
    // turns an export into code execution on the analyst's machine.
    expect(escapeCsvCell('=HYPERLINK("http://evil","click")')).toMatch(/^"?'=/);
    expect(escapeCsvCell('+1234')).toBe("'+1234");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvCell('-2+3')).toBe("'-2+3");
  });

  it('renders a report with a header row', async () => {
    const report = await build([event('appointment.booked', utc(2026, 1, 10))]).run({
      metric: 'appointment.booked',
      range: { from: utc(2026, 1, 10), to: utc(2026, 1, 12) },
      granularity: 'day',
    });

    const lines = reportToCsv(report).split('\r\n');
    expect(lines[0]).toBe('bucket,start,end,value,samples');
    expect(lines).toHaveLength(3);
  });
});
