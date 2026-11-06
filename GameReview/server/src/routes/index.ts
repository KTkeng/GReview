import { Router } from 'express';
import type { ServerConfig } from '../lib/config';
import { AppError } from '../lib/errors';
import { errorPayload } from '../lib/errors';
import type { SteamService } from '../steam/service';
import type { JobManager } from '../jobs/manager';
import type { AIProvider } from '../ai/deepseek';
import { gameRoutes } from './game';
import { aiRoutes } from './ai';
import { jobRoutes } from './jobs';
import { dataRoutes } from './data';

export interface ApiDeps {
  config: ServerConfig;
  steam: SteamService;
  manager: JobManager;
  aiFactory: (opts: { apiKey: string; baseUrl?: string; model: string }) => AIProvider;
}

export function createApiRouter(deps: ApiDeps): Router {
  const router = Router();
  router.use(gameRoutes({ config: deps.config, steam: deps.steam }));
  router.use(aiRoutes({ config: deps.config, aiFactory: deps.aiFactory }));
  router.use(jobRoutes({ config: deps.config, manager: deps.manager }));
  router.use(dataRoutes({ config: deps.config, steam: deps.steam }));

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: deps.config.version });
  });

  router.use((_req, res) => {
    res.status(404).json(errorPayload(new AppError('NOT_FOUND', '接口不存在')));
  });
  return router;
}
