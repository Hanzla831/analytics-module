import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { InMemoryEventStore } from '../src/store.js';
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

function build(events: EventRecord[] = [], options: { authorized?: boolean } = {}) {
  return createApp({
    store: new InMemoryEventStore(events),
    clock: () => NOW,
    ...(options.authorized === false ? { isAuthorized: () => false } : {}),
  });
}

const RANGE = 'from=2026-01-10T00:00:00Z&to=2026-01-13T00:00:00Z';

describe('report endpoint', () => {
  it('returns a bucketed series', async () => {
    const { app } = build([
      event('appointment.booked', utc(2026, 1, 10, 9)),
      event('appointment.booked', utc(2026, 1, 12, 9)),
    ]);

    const response = await request(app)
      .get(`/analytics/report?metric=appointment.booked&${RANGE}&granularity=day`)
      .expect(200);

    expect(response.body.total).toBe(2);
    expect(response.body.buckets).toHaveLength(3);
    expect(response.body.timezone).toBe('UTC');
  });

  it('honours the requested timezone', async () => {
    const { app } = build([event('appointment.booked', new Date(Date.UTC(2026, 0, 10, 20)))]);

    const response = await request(app)
      .get(
        `/analytics/report?metric=appointment.booked&${RANGE}&granularity=day&timezone=Asia/Karachi`,
      )
      .expect(200);

    // 20:00 UTC is already the 11th in Karachi.
    expect(response.body.buckets[1]!.value).toBe(1);
  });

  it('requires a metric and a range', async () => {
    const { app } = build();
    await request(app).get('/analytics/report').expect(400);
    await request(app).get('/analytics/report?metric=appointment.booked').expect(400);
  });

  it('rejects an unsupported granularity', async () => {
    const { app } = build();
    await request(app)
      .get(`/analytics/report?metric=appointment.booked&${RANGE}&granularity=fortnight`)
      .expect(400);
  });

  it('404s an unknown metric', async () => {
    const { app } = build();
    const response = await request(app)
      .get(`/analytics/report?metric=made.up&${RANGE}`)
      .expect(404);
    expect(response.body.error.code).toBe('unknown_metric');
  });

  it('rejects a dimension outside the allowlist', async () => {
    const { app } = build();
    const response = await request(app)
      .get(`/analytics/report?metric=appointment.booked&${RANGE}&groupBy=patientEmail`)
      .expect(400);
    expect(response.body.error.code).toBe('invalid_dimension');
  });

  it('rejects an inverted range', async () => {
    const { app } = build();
    await request(app)
      .get('/analytics/report?metric=appointment.booked&from=2026-01-13T00:00:00Z&to=2026-01-10T00:00:00Z')
      .expect(400);
  });

  it('refuses a range that would produce too many buckets', async () => {
    const { app } = build();
    await request(app)
      .get(
        '/analytics/report?metric=appointment.booked&from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z&granularity=hour',
      )
      .expect(400);
  });
});

describe('caching', () => {
  it('serves a settled report from cache on the second request', async () => {
    const { app } = build([event('appointment.booked', utc(2026, 1, 10))]);
    const url = `/analytics/report?metric=appointment.booked&${RANGE}&granularity=day`;

    expect((await request(app).get(url).expect(200)).headers['x-cache']).toBe('miss');
    expect((await request(app).get(url).expect(200)).headers['x-cache']).toBe('hit');
  });

  it('never caches a report whose last bucket is still accruing', async () => {
    const { app } = build();
    // Range extends past "now", so the final bucket is live.
    const url =
      '/analytics/report?metric=appointment.booked&from=2026-01-10T00:00:00Z&to=2026-01-25T00:00:00Z&granularity=day';

    await request(app).get(url).expect(200);
    expect((await request(app).get(url).expect(200)).headers['x-cache']).toBe('miss');
  });
});

describe('CSV export', () => {
  it('returns a downloadable CSV', async () => {
    const { app } = build([event('appointment.booked', utc(2026, 1, 10))]);

    const response = await request(app)
      .get(`/analytics/report.csv?metric=appointment.booked&${RANGE}&granularity=day`)
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.text.split('\r\n')[0]).toBe('bucket,start,end,value,samples');
  });
});

describe('metadata and access', () => {
  it('lists metrics with their dimensions', async () => {
    const { app } = build();
    const response = await request(app).get('/analytics/metrics').expect(200);

    expect(response.body.metrics.length).toBeGreaterThan(0);
    expect(response.body.metrics[0]).toHaveProperty('dimensions');
  });

  it('gates every report route', async () => {
    const { app } = build([], { authorized: false });
    await request(app).get('/analytics/metrics').expect(403);
    await request(app).get(`/analytics/report?metric=appointment.booked&${RANGE}`).expect(403);
  });

  it('serves health and 404s unknown endpoints', async () => {
    const { app } = build([event('appointment.booked', utc(2026, 1, 10))]);
    const health = await request(app).get('/health').expect(200);
    expect(health.body.events).toBe(1);

    await request(app).get('/nope').expect(404);
  });
});
