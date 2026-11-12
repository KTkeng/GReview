import { Router, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { ServerConfig } from '../lib/config';
import { AppError, isAppError } from '../lib/errors';
import type { SteamService } from '../steam/service';
import {
  ensureDataDir,
  resolveDataDir,
  assertAppIdSegment,
  assertHashSegment,
  assertSafeExistingDataDir,
} from '../storage/paths';
import {
  clearDataDir,
  deleteDataset,
  getDatasetDetail,
  listDatasets,
  readGameMeta,
} from '../storage/dataset';
import { normalizeCustomTitle, updateGameTitle } from '../storage/game-title';
import { buildGamePresentation, presentReportForApp } from '../storage/presentation';
import { readServedReport } from '../storage/report';
import { reportToMarkdown } from '../storage/markdown';
import type { DatasetSummary } from '../types';
import { asyncHandler, parseTopN, zodPublicDetail } from './helpers';
import { cacheClearSchema, dataClearSchema, dataValidateSchema, titleUpdateSchema } from './schemas';

export interface DataRouteDeps {
  config: ServerConfig;
  steam: SteamService;
}

/**
 * Optional query parameter: repeated parameters (`?dataDir=a&dataDir=b`) and
 * nested objects are rejected instead of silently picking one value.
 */
function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw new AppError('INVALID_PARAMS', `${field} 必须是单个字符串`, '参数无效', {
    field,
    publicDetail: `${field} 必须是单个字符串`,
  });
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

/** PATCH /title only accepts an actual application/json body (contract: 415). */
function requireJsonContentType(req: Request): void {
  const header = req.headers['content-type'];
  const mediaType = typeof header === 'string' ? header.split(';')[0].trim().toLowerCase() : '';
  if (mediaType !== 'application/json') {
    throw new AppError('INVALID_PARAMS', '请求体必须使用 application/json', '参数无效', {
      status: 415,
      field: 'Content-Type',
      publicDetail: '请求体必须使用 application/json',
    });
  }
}

function titleBodyError(err: ZodError): AppError {
  const detail = err.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
  const first = err.issues[0];
  const field = first && first.path.length > 0 ? String(first.path[0]) : 'body';
  return new AppError('INVALID_PARAMS', detail, '参数无效', {
    field,
    publicDetail: zodPublicDetail(err),
  });
}

export function dataRoutes(deps: DataRouteDeps): Router {
  const router = Router();
  const dataDirOptions = { projectRoot: deps.config.projectRoot, defaultDataDir: deps.config.dataDir };

  router.get('/datasets', asyncHandler(async (req, res) => {
    const dataDir = resolveDataDir(queryString(req.query.dataDir, 'dataDir'), dataDirOptions);
    const datasets: DatasetSummary[] = await listDatasets(dataDir);
    noStore(res);
    res.json({ dataDir, datasets });
  }));

  router.get('/datasets/:appid/:reviewsHash', asyncHandler(async (req, res) => {
    const appid = assertAppIdSegment(req.params.appid);
    const reviewsHash = assertHashSegment(req.params.reviewsHash);
    const dataDir = resolveDataDir(queryString(req.query.dataDir, 'dataDir'), dataDirOptions);
    const detail = await getDatasetDetail(dataDir, appid, reviewsHash);
    if (!detail) throw new AppError('GAME_NOT_FOUND', '数据集不存在');
    noStore(res);
    res.json(detail);
  }));

  router.patch('/datasets/:appid/title', asyncHandler(async (req, res) => {
    requireJsonContentType(req);
    const appid = assertAppIdSegment(req.params.appid);
    const dataDirInput = queryString(req.query.dataDir, 'dataDir');
    let body: ReturnType<typeof titleUpdateSchema.parse>;
    try {
      body = titleUpdateSchema.parse(req.body ?? null);
    } catch (err) {
      if (err instanceof ZodError) throw titleBodyError(err);
      throw err;
    }
    // Textual rules (NFC/trim/1–120 code points/control characters) live in
    // storage so request and on-disk validation can never diverge.
    const customTitle = normalizeCustomTitle(body.customTitle);
    const dataDir = resolveDataDir(dataDirInput, dataDirOptions);
    // A missing root is a game-not-found (404) per the title contract; link
    // aliases/protected paths still fail with the security error below.
    try {
      await assertSafeExistingDataDir(dataDir, dataDirOptions);
    } catch (err) {
      if (isAppError(err) && err.code === 'DATA_DIR_INVALID') {
        throw new AppError('GAME_NOT_FOUND', '数据目录不存在');
      }
      throw err;
    }

    const outcome = await updateGameTitle(dataDir, appid, customTitle, body.expectedRevision, dataDirOptions);
    if (outcome.status === 'corrupt') {
      const detail = outcome.state.status === 'corrupt' ? outcome.state.reason : '标题文件不可修改';
      throw new AppError('TITLE_CORRUPTED', detail, '标题文件损坏', { publicDetail: detail });
    }
    if (outcome.status === 'conflict') {
      const currentGame = buildGamePresentation(await readGameMeta(dataDir, appid), appid, outcome.state);
      throw new AppError('TITLE_CONFLICT', undefined, undefined, { currentGame });
    }
    const game = buildGamePresentation(await readGameMeta(dataDir, appid), appid, outcome.state);
    noStore(res);
    res.json({ game, changed: outcome.changed });
  }));

  router.delete('/datasets/:appid/:reviewsHash', asyncHandler(async (req, res) => {
    const appid = assertAppIdSegment(req.params.appid);
    const reviewsHash = assertHashSegment(req.params.reviewsHash);
    const dataDir = resolveDataDir(queryString(req.query.dataDir, 'dataDir'), dataDirOptions);
    await deleteDataset(dataDir, appid, reviewsHash, dataDirOptions);
    noStore(res);
    res.json({ deleted: true });
  }));

  router.get('/reports/:appid/:analysisHash', asyncHandler(async (req, res) => {
    const appid = assertAppIdSegment(req.params.appid);
    const analysisHash = assertHashSegment(req.params.analysisHash);
    const dataDir = resolveDataDir(queryString(req.query.dataDir, 'dataDir'), dataDirOptions);
    const formatRaw = queryString(req.query.format, 'format');
    const format = formatRaw ?? 'json';
    if (format !== 'json' && format !== 'markdown') {
      throw new AppError('INVALID_PARAMS', 'format 只允许 json 或 markdown', '参数无效', {
        field: 'format',
        publicDetail: 'format 只允许 json 或 markdown',
      });
    }
    const topN = parseTopN(req.query.topReviews, 10);
    const report = await readServedReport(dataDir, appid, analysisHash, topN);
    if (!report) throw new AppError('REPORT_NOT_FOUND', '报告不存在');
    // Title changes are presentation-only: the persisted report and historical
    // markdown snapshot are never rewritten.
    const presented = await presentReportForApp(dataDir, appid, report);
    noStore(res);
    if (format === 'markdown') {
      const markdown = reportToMarkdown(presented);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      // The download filename is derived only from validated path parameters;
      // the custom title never reaches a response header.
      res.setHeader('Content-Disposition', `attachment; filename="greview-${appid}-${analysisHash}.md"`);
      res.send(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
      return;
    }
    res.json(presented);
  }));

  router.post('/data/validate', asyncHandler(async (req, res) => {
    const body = dataValidateSchema.parse(req.body ?? {});
    const dataDir = await ensureDataDir(body.dataDir, dataDirOptions);
    noStore(res);
    res.json({ dataDir, writable: true });
  }));

  router.post('/data/clear', asyncHandler(async (req, res) => {
    const body = dataClearSchema.parse(req.body ?? {});
    const dataDir = await ensureDataDir(body.dataDir, dataDirOptions);
    await clearDataDir(dataDir, dataDirOptions);
    noStore(res);
    res.json({ cleared: true });
  }));

  router.post('/cache/clear', asyncHandler(async (req, res) => {
    const body = cacheClearSchema.parse(req.body ?? {});
    await deps.steam.clearCache(body.appid);
    res.json({ cleared: true });
  }));

  return router;
}
