import { Router } from 'express';
import type { ServerConfig } from '../lib/config';
import { AppError } from '../lib/errors';
import type { SteamService } from '../steam/service';
import { ensureDataDir, resolveDataDir, assertAppIdSegment, assertHashSegment } from '../storage/paths';
import { clearDataDir, deleteDataset, getDatasetDetail, listDatasets } from '../storage/dataset';
import { readServedReport } from '../storage/report';
import type { DatasetListItem } from '../types';
import { asyncHandler, parseTopN } from './helpers';
import { cacheClearSchema, dataClearSchema, dataValidateSchema } from './schemas';

export interface DataRouteDeps {
  config: ServerConfig;
  steam: SteamService;
}

function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function dataRoutes(deps: DataRouteDeps): Router {
  const router = Router();
  const dataDirOptions = { projectRoot: deps.config.projectRoot, defaultDataDir: deps.config.dataDir };

  router.get('/datasets', asyncHandler(async (req, res) => {
    const dataDir = resolveDataDir(queryString(req.query.dataDir), dataDirOptions);
    const datasets: DatasetListItem[] = await listDatasets(dataDir);
    res.json({ dataDir, datasets });
  }));

  router.get('/datasets/:appid/:reviewsHash', asyncHandler(async (req, res) => {
    const appid = assertAppIdSegment(req.params.appid);
    const reviewsHash = assertHashSegment(req.params.reviewsHash);
    const dataDir = resolveDataDir(queryString(req.query.dataDir), dataDirOptions);
    const detail = await getDatasetDetail(dataDir, appid, reviewsHash);
    if (!detail) throw new AppError('NOT_FOUND', '数据集不存在');
    res.json(detail);
  }));

  router.delete('/datasets/:appid/:reviewsHash', asyncHandler(async (req, res) => {
    const appid = assertAppIdSegment(req.params.appid);
    const reviewsHash = assertHashSegment(req.params.reviewsHash);
    const dataDir = resolveDataDir(queryString(req.query.dataDir), dataDirOptions);
    await deleteDataset(dataDir, appid, reviewsHash, dataDirOptions);
    res.json({ deleted: true });
  }));

  router.get('/reports/:appid/:analysisHash', asyncHandler(async (req, res) => {
    const appid = assertAppIdSegment(req.params.appid);
    const analysisHash = assertHashSegment(req.params.analysisHash);
    const dataDir = resolveDataDir(queryString(req.query.dataDir), dataDirOptions);
    const topN = parseTopN(req.query.topReviews, 10);
    const report = await readServedReport(dataDir, appid, analysisHash, topN);
    if (!report) throw new AppError('NOT_FOUND', '报告不存在');
    res.json(report);
  }));

  router.post('/data/validate', asyncHandler(async (req, res) => {
    const body = dataValidateSchema.parse(req.body ?? {});
    const dataDir = await ensureDataDir(body.dataDir, dataDirOptions);
    res.json({ dataDir, writable: true });
  }));

  router.post('/data/clear', asyncHandler(async (req, res) => {
    const body = dataClearSchema.parse(req.body ?? {});
    const dataDir = await ensureDataDir(body.dataDir, dataDirOptions);
    await clearDataDir(dataDir, dataDirOptions);
    res.json({ cleared: true });
  }));

  router.post('/cache/clear', asyncHandler(async (req, res) => {
    const body = cacheClearSchema.parse(req.body ?? {});
    await deps.steam.clearCache(body.appid);
    res.json({ cleared: true });
  }));

  return router;
}
