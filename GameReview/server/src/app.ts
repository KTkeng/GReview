import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ServerConfig } from './lib/config';
import { createLogger, type Logger } from './lib/logger';
import { errorPayload } from './lib/errors';
import { originMiddleware } from './lib/origin';
import { createSteamService, type SteamService } from './steam/service';
import { DeepSeekProvider, type AIProvider } from './ai/deepseek';
import { JobManager, type AIFactory } from './jobs/manager';
import { createApiRouter } from './routes';
import { normalizeError } from './routes/helpers';

export interface AppDeps {
  config: ServerConfig;
  steam?: SteamService;
  aiFactory?: AIFactory;
  manager?: JobManager;
  logger?: Logger;
}

/** Build the Express app without listening; used by index.ts and integration tests. */
export function createApp(deps: AppDeps): express.Express {
  const { config } = deps;
  const logger = deps.logger ?? createLogger(config.logLevel);
  const steam = deps.steam ?? createSteamService(config);
  const aiFactory: AIFactory =
    deps.aiFactory ??
    ((opts): AIProvider =>
      new DeepSeekProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, timeoutMs: config.aiTimeoutMs }));
  const manager =
    deps.manager ??
    new JobManager({ config, steam, aiFactory, logger });

  const app = express();
  app.disable('x-powered-by');
  // Host/Origin checks come first so hostile requests are rejected before a
  // request body is parsed or buffered.
  app.use(originMiddleware(config.port));
  // The title endpoint has a strict 4 KiB body limit; this path-scoped parser
  // runs first and marks the body as parsed, so the global parser below skips
  // it. Express routing is case-insensitive and accepts a trailing slash, so
  // this matcher must use the same rules — otherwise `PATCH .../TITLE` would
  // fall through to the 2 MB parser and bypass the contract limit.
  const titleJsonParser = express.json({ limit: '4kb' });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestPath = req.path.toLowerCase();
    if (req.method === 'PATCH' && /^\/api\/datasets\/[^/]+\/title\/?$/.test(requestPath)) {
      titleJsonParser(req, res, next);
      return;
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createApiRouter({ config, steam, manager, aiFactory }));

  // Production static hosting of the built frontend; same origin, SPA fallback.
  const indexHtml = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(config.webDist, { index: false }));
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(indexHtml);
    });
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const appErr = normalizeError(err);
    if (appErr.status >= 500) {
      logger.error('request failed', {
        method: req.method,
        path: req.path,
        code: appErr.code,
        detail: appErr.detail ?? appErr.displayMessage,
      });
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(appErr.status).json(errorPayload(appErr));
  });

  return app;
}
