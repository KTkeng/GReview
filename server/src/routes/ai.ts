import { Router } from 'express';
import type { AIProvider } from '../ai/deepseek';
import { validateBaseUrl } from '../ai/deepseek';
import type { ServerConfig } from '../lib/config';
import { asyncHandler, apiKeyFrom } from './helpers';
import { aiTestSchema } from './schemas';

export type AIFactoryRoute = (opts: { apiKey: string; baseUrl?: string; model: string }) => AIProvider;

export interface AiRouteDeps {
  config: ServerConfig;
  aiFactory: AIFactoryRoute;
}

export function aiRoutes(deps: AiRouteDeps): Router {
  const router = Router();

  router.post(
    '/ai/test',
    asyncHandler(async (req, res) => {
      const apiKey = apiKeyFrom(req);
      const body = aiTestSchema.parse(req.body ?? {});
      if (body.baseUrl) validateBaseUrl(body.baseUrl);
      const provider = deps.aiFactory({ apiKey, baseUrl: body.baseUrl, model: body.model ?? 'deepseek-flash' });
      const result = await provider.testConnection(body.model);
      res.json(result);
    }),
  );

  return router;
}
