import { Router, type Request, type Response, type NextFunction } from 'express';
import type { ServerConfig } from '../lib/config';
import { AppError, toAppError } from '../lib/errors';
import type { JobManager } from '../jobs/manager';
import type { JobEvent } from '../jobs/store';
import { ensureDataDir } from '../storage/paths';
import { withClientFilterDefaults, withFilterDefaults } from '../steam/filters';
import type { CreateJobRequest } from '../types';
import { validateBaseUrl } from '../ai/deepseek';
import { asyncHandler, apiKeyFrom, validateDateRange } from './helpers';
import { createJobSchema } from './schemas';

export interface JobRouteDeps {
  config: ServerConfig;
  manager: JobManager;
}

export function jobRoutes(deps: JobRouteDeps): Router {
  const router = Router();
  const dataDirOptions = { projectRoot: deps.config.projectRoot, defaultDataDir: deps.config.dataDir };

  router.post(
    '/jobs',
    asyncHandler(async (req, res) => {
      const apiKey = apiKeyFrom(req);
      const body = createJobSchema.parse(req.body ?? {});
      if (body.ai.baseUrl) validateBaseUrl(body.ai.baseUrl);
      const filters = withFilterDefaults(body.filters);
      const clientFilters = withClientFilterDefaults(body.clientFilters);
      validateDateRange(filters.dateRange?.start, filters.dateRange?.end);
      const dataDir = await ensureDataDir(body.data.dataDir, dataDirOptions);
      const request: CreateJobRequest = {
        appid: body.appid,
        filters,
        clientFilters,
        trend: { months: body.trend.months },
        ai: {
          ...(body.ai.baseUrl ? { baseUrl: body.ai.baseUrl } : {}),
          model: body.ai.model,
          ...(body.ai.temperature !== undefined ? { temperature: body.ai.temperature } : {}),
          thinking: body.ai.thinking,
        },
        options: {
          maxReviews: body.options.maxReviews,
          includeTranslations: body.options.includeTranslations,
          topReviews: body.options.topReviews,
        },
        data: {
          dataDir,
          reuseDataset: body.data.reuseDataset,
          reuseReport: body.data.reuseReport,
          forceFetch: body.data.forceFetch,
          forceAnalyze: body.data.forceAnalyze,
          forceTrend: body.data.forceTrend,
        },
      };
      const { jobId } = await deps.manager.createJob(request, apiKey, dataDir);
      res.status(202).json({ jobId });
    }),
  );

  router.get('/jobs/:id', asyncHandler(async (req, res) => {
    try {
      const snapshot = await deps.manager.getSnapshot(req.params.id);
      res.json(snapshot);
    } catch (err) {
      const appErr = toAppError(err);
      // Missing/expired jobs keep their dedicated 404. Any other failure is a
      // snapshot-recovery failure: the client keeps the progress it already
      // shows and surfaces this stable message; details stay in server logs.
      if (appErr.status < 500) throw appErr;
      throw new AppError('INTERNAL', appErr.detail ?? appErr.message, '读取任务状态失败');
    }
  }));

  router.get('/jobs/:id/stream', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deps.manager.getSnapshot(req.params.id);
    } catch (err) {
      next(err);
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const keepalive = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n');
    }, 15000);
    keepalive.unref?.();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe?.();
      if (!res.writableEnded) res.end();
    };

    const send = (event: JobEvent) => {
      if (closed) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
        setTimeout(cleanup, 10).unref?.();
      }
    };

    try {
      unsubscribe = deps.manager.subscribe(req.params.id, send);
    } catch (err) {
      cleanup();
      next(err);
      return;
    }
    req.on('close', cleanup);
  }));

  router.post('/jobs/:id/cancel', (req, res) => {
    deps.manager.cancel(req.params.id);
    res.json({ status: 'cancelled' });
  });

  router.get('/jobs/:id/report', asyncHandler(async (req, res) => {
    // Re-reads the job's fixed data directory so a title saved after the job
    // completed is reflected here without mutating the stored report.
    const report = await deps.manager.getServedReport(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json(report);
  }));

  return router;
}
