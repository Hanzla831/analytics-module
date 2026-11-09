import {
  InvalidDimensionError,
  UnknownMetricError,
  assertValidRange,
  bucketLabel,
  buildBuckets,
  previousRange,
} from './buckets.js';
import type { EventStore } from './store.js';
import {
  DEFAULT_TIMEZONE,
  systemClock,
  type AggregationType,
  type Bucket,
  type Clock,
  type EventRecord,
  type MetricDefinition,
  type ReportQuery,
  type ReportResult,
} from './types.js';

/** Applies one aggregation to the events in a bucket. */
export function aggregate(type: AggregationType, events: readonly EventRecord[]): number {
  if (type === 'count') return events.length;

  if (type === 'uniqueCount') {
    // Falls back to the event id so a missing subject counts as distinct
    // rather than collapsing every anonymous event into one.
    return new Set(events.map((event) => event.subjectId ?? event.id)).size;
  }

  const values = events
    .map((event) => event.value)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  if (values.length === 0) {
    // Zero, not NaN. A chart renders zero; NaN renders as a broken axis.
    return 0;
  }

  switch (type) {
    case 'sum':
      return values.reduce((total, value) => total + value, 0);
    case 'avg':
      return values.reduce((total, value) => total + value, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    default:
      return 0;
  }
}

export class MetricRegistry {
  private readonly metrics = new Map<string, MetricDefinition>();

  constructor(definitions: readonly MetricDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: MetricDefinition): this {
    this.metrics.set(definition.name, definition);
    return this;
  }

  get(name: string): MetricDefinition {
    const metric = this.metrics.get(name);
    if (!metric) throw new UnknownMetricError(name);
    return metric;
  }

  list(): MetricDefinition[] {
    return [...this.metrics.values()];
  }
}

export class Aggregator {
  private readonly clock: Clock;

  constructor(
    private readonly store: EventStore,
    private readonly registry: MetricRegistry,
    options: { clock?: Clock } = {},
  ) {
    this.clock = options.clock ?? systemClock;
  }

  async run(query: ReportQuery): Promise<ReportResult> {
    const metric = this.registry.get(query.metric);
    assertValidRange(query.range);

    const timezone = query.timezone ?? DEFAULT_TIMEZONE;
    const allowed = metric.allowedDimensions ?? [];

    // Dimensions are validated against an allowlist rather than passed
    // through: an arbitrary groupBy on a high-cardinality field is both a
    // performance hazard and a way to read data the caller should not see.
    for (const dimension of Object.keys(query.filters ?? {})) {
      if (!allowed.includes(dimension)) throw new InvalidDimensionError(dimension, allowed);
    }
    if (query.groupBy && !allowed.includes(query.groupBy)) {
      throw new InvalidDimensionError(query.groupBy, allowed);
    }

    const events = await this.store.query({
      name: metric.eventName ?? metric.name,
      range: query.range,
      ...(query.filters ? { filters: query.filters } : {}),
    });

    const buckets = this.fill(events, query, timezone, metric.aggregation);
    const total = aggregate(metric.aggregation, events);

    const result: ReportResult = {
      metric: metric.name,
      label: metric.label,
      unit: metric.unit ?? null,
      granularity: query.granularity,
      timezone,
      range: query.range,
      buckets,
      total,
      // A dashboard that shows today alongside complete days looks like a
      // crash in traffic unless the partial bucket is flagged.
      partialLastBucket: query.range.to.getTime() > this.clock().getTime(),
    };

    if (query.groupBy) {
      result.groups = this.group(events, query, timezone, metric.aggregation, query.groupBy);
    }

    if (query.compareToPrevious) {
      const previous = previousRange(query.range);
      const previousEvents = await this.store.query({
        name: metric.eventName ?? metric.name,
        range: previous,
        ...(query.filters ? { filters: query.filters } : {}),
      });
      const previousTotal = aggregate(metric.aggregation, previousEvents);

      result.comparison = {
        total,
        previousTotal,
        // Undefined rather than "+100%" when the baseline is zero — a ratio
        // against nothing is not a rise, and rendering it as one misleads.
        changeRatio: previousTotal === 0 ? null : (total - previousTotal) / previousTotal,
      };
    }

    return result;
  }

  /**
   * Places events into buckets, emitting empty buckets too.
   *
   * Gaps matter: a line chart that simply skips a quiet Tuesday draws a
   * straight line across it and hides the outage.
   */
  private fill(
    events: readonly EventRecord[],
    query: ReportQuery,
    timezone: string,
    aggregation: AggregationType,
  ): Bucket[] {
    const boundaries = buildBuckets(query.range, query.granularity, timezone);

    return boundaries.map(({ start, end }) => {
      const inBucket = events.filter(
        (event) =>
          event.occurredAt.getTime() >= start.getTime() &&
          event.occurredAt.getTime() < end.getTime(),
      );
      return {
        start,
        end,
        label: bucketLabel(start, query.granularity, timezone),
        value: aggregate(aggregation, inBucket),
        sampleCount: inBucket.length,
      };
    });
  }

  private group(
    events: readonly EventRecord[],
    query: ReportQuery,
    timezone: string,
    aggregation: AggregationType,
    dimension: string,
  ): Array<{ key: string; total: number; buckets: Bucket[] }> {
    const byKey = new Map<string, EventRecord[]>();
    for (const event of events) {
      const key = event.dimensions?.[dimension] ?? '(none)';
      const list = byKey.get(key);
      if (list) list.push(event);
      else byKey.set(key, [event]);
    }

    return [...byKey.entries()]
      .map(([key, groupEvents]) => ({
        key,
        total: aggregate(aggregation, groupEvents),
        buckets: this.fill(groupEvents, query, timezone, aggregation),
      }))
      .sort((a, b) => b.total - a.total);
  }
}
