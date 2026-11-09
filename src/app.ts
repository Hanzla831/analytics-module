import express, {
  Router,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { Aggregator, MetricRegistry } from './aggregator.js';
import { AnalyticsError } from './buckets.js';
import { contentDisposition, reportToCsv } from './csv.js';
import { InMemoryEventStore, ReportCache, type EventStore } from './store.js';
import {
  DEFAULT_TIMEZONE,
  systemClock,
  type Clock,
  type Granularity,
  type MetricDefinition,
  type ReportQuery,
} from './types.js';

const GRANULARITIES: readonly Granularity[] = ['hour', 'day', 'week', 'month'];

/** Metrics modelled on a clinic booking product. */
export const DEFAULT_METRICS: MetricDefinition[] = [
  {
    name: 'appointment.booked',
    label: 'Appointments booked',
    aggregation: 'count',
    allowedDimensions: ['clinic', 'channel', 'status'],
  },
  {
    name: 'invoice.total',
    label: 'Invoiced revenue',
    aggregation: 'sum',
    unit: 'PKR',
    allowedDimensions: ['clinic', 'plan'],
  },
  {
    name: 'appointment.waitMinutes',
    label: 'Average wait time',
    aggregation: 'avg',
    unit: 'minutes',
    allowedDimensions: ['clinic'],
  },
  {
    name: 'patient.active',
    label: 'Active patients',
    aggregation: 'uniqueCount',
    allowedDimensions: ['clinic'],
  },
];

export interface AppDependencies {
  store?: EventStore;
  metrics?: readonly MetricDefinition[];
  clock?: Clock;
  cacheTtlMs?: number;
  /** Returning false makes every report route 403. */
  isAuthorized?: (req: Request) => boolean;
}

export interface BuiltApp {
  app: Express;
  store: EventStore;
  aggregator: Aggregator;
  cache: ReportCache;
}

function parseQuery(req: Request): ReportQuery {
  const { metric, from, to, granularity, timezone, groupBy, compare, ...rest } = req.query as Record<
    string,
    string | undefined
  >;

  if (!metric) throw new AnalyticsError(400, 'invalid_request', 'A metric is required');
  if (!from || !to) throw new AnalyticsError(400, 'invalid_request', '"from" and "to" are required');

  const granularityValue = (granularity ?? 'day') as Granularity;
  if (!GRANULARITIES.includes(granularityValue)) {
    throw new AnalyticsError(400, 'invalid_request', `Unsupported granularity "${granularity}"`);
  }

  // Unknown query parameters become dimension filters, which is why the
  // aggregator validates them against the metric allowlist rather than
  // trusting whatever arrives.
  const filters = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => typeof value === 'string'),
  ) as Record<string, string>;

  return {
    metric,
    range: { from: new Date(from), to: new Date(to) },
    granularity: granularityValue,
    timezone: timezone ?? DEFAULT_TIMEZONE,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    ...(groupBy ? { groupBy } : {}),
    compareToPrevious: compare === 'true',
  };
}

export function createApp(deps: AppDependencies = {}): BuiltApp {
  const clock = deps.clock ?? systemClock;
  const store = deps.store ?? new InMemoryEventStore();
  const registry = new MetricRegistry(deps.metrics ?? DEFAULT_METRICS);
  const aggregator = new Aggregator(store, registry, { clock });
  const cache = new ReportCache(deps.cacheTtlMs ?? 60_000);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  const router = Router();
  router.use((req, res, next) => {
    if (deps.isAuthorized && !deps.isAuthorized(req)) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Not authorized' } });
      return;
    }
    next();
  });

  router.get('/metrics', (_req, res) => {
    res.json({
      metrics: registry.list().map((metric) => ({
        name: metric.name,
        label: metric.label,
        aggregation: metric.aggregation,
        unit: metric.unit ?? null,
        dimensions: metric.allowedDimensions ?? [],
      })),
    });
  });

  router.get('/report', (req, res, next) => {
    void (async () => {
      try {
        const query = parseQuery(req);
        const key = cache.key({ ...query, range: [query.range.from, query.range.to] });

        const cached = cache.get(key, clock().getTime());
        if (cached) {
          res.setHeader('x-cache', 'hit');
          res.json(cached);
          return;
        }

        const report = await aggregator.run(query);
        // Only fully-settled reports are cached: a partial final bucket is
        // still accruing, and serving it for a minute makes a live dashboard
        // look stuck.
        if (!report.partialLastBucket) cache.set(key, report, clock().getTime());

        res.setHeader('x-cache', 'miss');
        res.json(report);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get('/report.csv', (req, res, next) => {
    void (async () => {
      try {
        const query = parseQuery(req);
        const report = await aggregator.run(query);

        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader(
          'content-disposition',
          contentDisposition(report.metric, query.range.from, query.range.to),
        );
        res.send(reportToCsv(report));
      } catch (error) {
        next(error);
      }
    })();
  });

  app.use('/analytics', router);

  app.get('/health', async (_req, res) => {
    res.json({ status: 'ok', events: await store.count(), cached: cache.size });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof AnalyticsError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Endpoint not found' } });
  });

  return { app, store, aggregator, cache };
}
