import type { EventRecord, TimeRange } from './types.js';

export interface EventQuery {
  name: string;
  range: TimeRange;
  filters?: Record<string, string>;
}

/**
 * Event storage boundary.
 *
 * The in-memory implementation filters in JavaScript, which is fine for tests
 * and small datasets. In production this is where the work belongs in the
 * database — a `GROUP BY date_trunc(...)` returns tens of rows instead of
 * shipping millions of events into the process to be counted.
 */
export interface EventStore {
  record(event: EventRecord): Promise<void>;
  recordMany(events: readonly EventRecord[]): Promise<void>;
  query(query: EventQuery): Promise<EventRecord[]>;
  count(): Promise<number>;
}

export class InMemoryEventStore implements EventStore {
  private readonly events: EventRecord[] = [];

  constructor(seed: readonly EventRecord[] = []) {
    this.events.push(...seed.map((event) => ({ ...event })));
  }

  async record(event: EventRecord): Promise<void> {
    this.events.push({ ...event });
  }

  async recordMany(events: readonly EventRecord[]): Promise<void> {
    for (const event of events) await this.record(event);
  }

  async query({ name, range, filters }: EventQuery): Promise<EventRecord[]> {
    return this.events
      .filter((event) => event.name === name)
      // `to` is exclusive so adjacent ranges neither overlap nor leave a gap —
      // the difference between a month total and that total plus one day.
      .filter(
        (event) =>
          event.occurredAt.getTime() >= range.from.getTime() &&
          event.occurredAt.getTime() < range.to.getTime(),
      )
      .filter((event) =>
        Object.entries(filters ?? {}).every(
          ([key, value]) => event.dimensions?.[key] === value,
        ),
      )
      .map((event) => ({ ...event }))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async count(): Promise<number> {
    return this.events.length;
  }
}

/**
 * Report cache.
 *
 * Dashboards re-request the same report on every page load and every refresh,
 * and historical buckets never change. The key includes every parameter that
 * affects the result — a cache keyed on the metric alone would serve one
 * timezone answer to another timezone.
 */
export interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class ReportCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs = 60_000) {}

  key(parts: Record<string, unknown>): string {
    return JSON.stringify(
      Object.fromEntries(Object.entries(parts).sort(([a], [b]) => (a < b ? -1 : 1))),
    );
  }

  get<T>(key: string, now = Date.now()): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown, now = Date.now()): void {
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
