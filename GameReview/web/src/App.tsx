import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AiTestResult,
  AnalysisConfig,
  DatasetSummary,
  GameMeta,
  GamePresentation,
  JobLogEntry,
  JobSnapshot,
  JobState,
  Report,
  ReportSource,
  TopReview,
} from './types';
import { api, subscribeJob, toApiError, type CreateJobRequest } from './lib/api';
import { loadConfig, saveConfig, clearStoredApiKey } from './lib/storage';
import {
  INVALID_LINK_MESSAGE,
  buildClientFilters,
  buildScrapeFilters,
  extractAppId,
  validateConfig,
  validateDataDir,
} from './lib/validation';
import { buildPreviewRequest, getMatchingTotal, getReuseInfo, previewConfigSlice } from './lib/preview';
import { downloadReportMarkdown } from './lib/exportMarkdown';
import { formatNumber } from './lib/format';
import { gameTitleInfo } from './lib/gameTitle';
import { MAX_TIMELINE_LOG_CACHE } from './hooks/useJobTimeline';
import { AppLayout } from './components/AppLayout';
import { Header } from './components/Header';
import { ConfigPanel } from './components/ConfigPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { ProgressPanel } from './components/ProgressPanel';
import { ReportView } from './components/ReportView';
import { LocalDataPanel } from './components/LocalDataPanel';
import { EmptyState, ErrorBanner } from './components/ui';
import type { AppPhase, PreviewState } from './types';

const EXAMPLE_URL = 'https://store.steampowered.com/app/570/Dota_2/';

function normalizeJobStatus(status: string | undefined): JobState['status'] {
  const value = String(status ?? '').toLowerCase();
  if (['completed', 'done', 'success', '完成', '已完成'].includes(value)) return 'completed';
  if (['failed', 'error', '失败'].includes(value)) return 'failed';
  if (['cancelled', 'canceled', '取消', '已取消'].includes(value)) return 'cancelled';
  if (['running', '运行', '运行中'].includes(value)) return 'running';
  return 'queued';
}

function normalizeLogLevel(level: string | undefined): JobLogEntry['level'] {
  const value = String(level ?? 'info').toLowerCase();
  if (value === 'warn' || value === 'warning') return 'warn';
  if (value === 'error') return 'error';
  if (value === 'debug') return 'debug';
  return 'info';
}

function normalizeLogs(logs: Array<JobLogEntry | string> | undefined): JobLogEntry[] {
  if (!Array.isArray(logs)) return [];
  const result: JobLogEntry[] = [];
  for (const entry of logs) {
    if (typeof entry === 'string') {
      if (entry) result.push({ level: 'info', message: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const message = String(entry.message ?? '');
    if (!message) continue;
    result.push({
      level: normalizeLogLevel(entry.level),
      message,
      at: typeof entry.at === 'string' ? entry.at : undefined,
      id: typeof entry.id === 'string' && entry.id ? entry.id : undefined,
      observedAt: typeof entry.observedAt === 'string' ? entry.observedAt : undefined,
    });
  }
  return result;
}

/**
 * 合并日志：有服务端 id 时按 id 去重；没有 id 时保留重复文本
 * （重试可能产生相同日志）。缓存最多 500 条并返回本次丢弃数量。
 */
function mergeLogs(
  existing: JobLogEntry[],
  incoming: JobLogEntry[],
): { logs: JobLogEntry[]; dropped: number } {
  const result = [...existing];
  const seenIds = new Set(
    existing.map((entry) => entry.id).filter((id): id is string => Boolean(id)),
  );
  for (const entry of incoming) {
    if (!entry.message) continue;
    if (entry.id) {
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
    }
    result.push(entry);
  }
  const dropped = Math.max(0, result.length - MAX_TIMELINE_LOG_CACHE);
  return {
    logs: dropped > 0 ? result.slice(result.length - MAX_TIMELINE_LOG_CACHE) : result,
    dropped,
  };
}

function previewSignature(appid: number | null, config: AnalysisConfig): string {
  return JSON.stringify({
    appid,
    filters: config.scrape,
    client: config.client,
    trend: config.trendMonths,
    dataDir: config.dataDir,
    maxReviews: config.maxReviews,
    includeTranslations: config.includeTranslations,
    // 预览成本与精确报告复用依赖这些 AI 选项（F2）。
    baseUrl: config.baseUrl,
    model: config.model,
    thinking: config.thinking,
  });
}

function sanitizedScrape(config: AnalysisConfig) {
  const filters = buildScrapeFilters(config);
  const dateRange =
    filters.dateRange && filters.dateRange.start !== undefined && filters.dateRange.end !== undefined
      ? { start: filters.dateRange.start, end: filters.dateRange.end }
      : null;
  return {
    ...filters,
    languages: filters.languages.length > 0 ? filters.languages : ['all'],
    dateRange,
    minPlaytimeHours:
      typeof filters.minPlaytimeHours === 'number' ? filters.minPlaytimeHours : undefined,
    maxPlaytimeHours:
      typeof filters.maxPlaytimeHours === 'number' ? filters.maxPlaytimeHours : undefined,
  };
}

export default function App() {
  const [config, setConfig] = useState<AnalysisConfig>(() => loadConfig());
  const [appid, setAppid] = useState<number | null>(null);
  const [game, setGame] = useState<GameMeta | null>(null);
  const [resolvingGame, setResolvingGame] = useState(false);
  const [gameError, setGameError] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState(false);
  const [aiTest, setAiTest] = useState<AiTestResult | null>(null);
  const [aiTestError, setAiTestError] = useState<string | null>(null);
  const [phase, setPhase] = useState<AppPhase>('idle');
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [job, setJob] = useState<JobState>({ progress: 0, logs: [] });
  const [jobId, setJobId] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  /** 只有从本地数据面板打开的历史报告才有 analysisHash，可用于重建 Top N。 */
  const [reportSource, setReportSource] = useState<ReportSource | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [forceFetch, setForceFetch] = useState(false);
  const [forceAnalyze, setForceAnalyze] = useState(false);
  const [backendStatus, setBackendStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  /** SSE 连接状态：断线时实时可视化显示恢复徽标，轮询快照后重建流。 */
  const [streamState, setStreamState] = useState<'connected' | 'disconnected'>('connected');
  /** 当前任务是否发生过断线；恢复后提示过程可能未被完整记录，新 jobId 清除。 */
  const [wasDisconnected, setWasDisconnected] = useState(false);
  const [version, setVersion] = useState('0.2.1');
  const [applyingDataDir, setApplyingDataDir] = useState(false);
  const [dataDirApplyError, setDataDirApplyError] = useState<string | null>(null);
  const [dataDirMessage, setDataDirMessage] = useState<string | null>(null);
  const [datasetsRefreshKey, setDatasetsRefreshKey] = useState(0);
  const [configCollapsed, setConfigCollapsed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const lastGameUrlRef = useRef(config.gameUrl);
  const lastPreviewKeyRef = useRef('');
  const startedAppidRef = useRef<number | null>(null);
  /** 预览与报告的来源数据目录：标题更新只能影响同一目录中的展示缓存。 */
  const previewDataDirRef = useRef('');
  const reportDataDirRef = useRef('');
  const toastTimerRef = useRef<number | null>(null);

  const validation = useMemo(() => validateConfig(config, appid), [config, appid]);
  const reuseInfo = useMemo(() => getReuseInfo(preview.result), [preview.result]);
  const matching = useMemo(() => getMatchingTotal(preview.result), [preview.result]);
  const canStart =
    validation.valid && preview.status === 'success' && Number.isFinite(matching) && matching > 0;

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  /* 新 jobId 清除上一任务遗留的“曾断线”提示。 */
  useEffect(() => {
    setWasDisconnected(false);
  }, [jobId]);

  /* 持久化配置（含 thinking 开关） */
  useEffect(() => {
    saveConfig(config);
  }, [config]);

  /* 游戏输入变化后清空已解析状态 */
  useEffect(() => {
    if (config.gameUrl !== lastGameUrlRef.current) {
      lastGameUrlRef.current = config.gameUrl;
      setAppid(null);
      setGame(null);
      setGameError(null);
    }
  }, [config.gameUrl]);

  /* 配置变化使已完成的预览失效 */
  const signature = previewSignature(appid, config);
  useEffect(() => {
    if (
      (preview.status === 'success' || preview.status === 'no_match' || preview.status === 'error') &&
      signature !== lastPreviewKeyRef.current
    ) {
      setPreview({ status: 'idle' });
      if (phase === 'previewing') setPhase('configuring');
    }
  }, [signature, preview.status, phase]);

  const checkHealth = useCallback(async () => {
    setBackendStatus('checking');
    try {
      const result = await api.health();
      setBackendStatus(result.ok ? 'online' : 'offline');
      if (result.version) setVersion(result.version);
    } catch {
      setBackendStatus('offline');
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  const updateConfig = useCallback(
    (updater: (previous: AnalysisConfig) => AnalysisConfig) => {
      setConfig((previous) => updater(previous));
    },
    [],
  );

  const patchConfig = useCallback(
    (patch: Partial<AnalysisConfig>) => {
      setConfig((previous) => ({ ...previous, ...patch }));
    },
    [],
  );

  const resolveInput = useCallback(
    async (input: string): Promise<{ appid: number; game: GameMeta } | null> => {
      const parsed = extractAppId(input);
      if (!parsed) {
        setGameError(INVALID_LINK_MESSAGE);
        return null;
      }
      setResolvingGame(true);
      setGameError(null);
      try {
        const result = await api.resolveGame(input);
        const resolvedAppid = Number(result.appid) || parsed;
        const resolvedGame: GameMeta =
          result.game && typeof result.game === 'object'
            ? { ...result.game, appid: resolvedAppid }
            : { appid: resolvedAppid, name: `AppID ${resolvedAppid}` };
        setAppid(resolvedAppid);
        setGame(resolvedGame);
        lastGameUrlRef.current = input;
        setBackendStatus('online');
        return { appid: resolvedAppid, game: resolvedGame };
      } catch (error) {
        const apiError = toApiError(error);
        if (apiError.code === 'INVALID_URL') {
          setGameError(INVALID_LINK_MESSAGE);
        } else if (apiError.code === 'APP_NOT_FOUND') {
          setGameError('Steam 未找到该游戏，请检查链接或 AppID');
        } else {
          setGameError(`${apiError.code}: ${apiError.message}`);
          if (apiError.code === 'NETWORK_ERROR') setBackendStatus('offline');
        }
        return null;
      } finally {
        setResolvingGame(false);
      }
    },
    [],
  );

  const handleResolveGame = useCallback(() => {
    void resolveInput(config.gameUrl);
  }, [config.gameUrl, resolveInput]);

  const handleTestKey = useCallback(async () => {
    if (!config.apiKey.trim()) {
      setAiTestError('请先填写 DeepSeek API Key');
      return;
    }
    setTestingKey(true);
    setAiTestError(null);
    setAiTest(null);
    try {
      const result = await api.testAi(config.apiKey, {
        baseUrl: config.baseUrl.trim() || undefined,
        model: config.model.trim() || undefined,
      });
      setAiTest(result);
      setBackendStatus('online');
    } catch (error) {
      const apiError = toApiError(error);
      setAiTestError(`${apiError.code}: ${apiError.message}`);
      if (apiError.code === 'NETWORK_ERROR') setBackendStatus('offline');
    } finally {
      setTestingKey(false);
    }
  }, [config.apiKey, config.baseUrl, config.model]);

  const handleClearKey = useCallback(() => {
    patchConfig({ apiKey: '' });
    clearStoredApiKey();
    setAiTest(null);
    setAiTestError(null);
    showToast('已清除本机保存的 API Key');
  }, [patchConfig, showToast]);

  const handlePreview = useCallback(async () => {
    if (preview.status === 'loading' || resolvingGame) return;
    setShowErrors(true);
    setGameError(null);

    let effectiveAppid = appid;
    if (!effectiveAppid) {
      const parsed = extractAppId(config.gameUrl);
      if (!parsed) {
        setGameError(INVALID_LINK_MESSAGE);
        if (!report) setPhase('configuring');
        return;
      }
      const resolved = await resolveInput(config.gameUrl);
      if (!resolved) {
        if (!report) setPhase('configuring');
        return;
      }
      effectiveAppid = resolved.appid;
    }

    const check = validateConfig(config, effectiveAppid);
    if (!check.valid) {
      if (report) {
        showToast('请先修正左侧配置中的错误');
      } else {
        setPhase('configuring');
      }
      return;
    }

    lastPreviewKeyRef.current = previewSignature(effectiveAppid, config);
    setPreview({ status: 'loading' });
    setPhase('previewing');
    try {
      const result = await api.preview(
        buildPreviewRequest({
          appid: effectiveAppid,
          filters: sanitizedScrape(config),
          clientFilters: buildClientFilters(config),
          config: previewConfigSlice(config),
        }),
      );
      const resultMatching = getMatchingTotal(result);
      previewDataDirRef.current = config.dataDir.trim();
      setPreview({
        status: resultMatching > 0 ? 'success' : 'no_match',
        result,
        requestedAt: Date.now(),
      });
      setBackendStatus('online');
      setDatasetsRefreshKey((value) => value + 1);
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.code === 'NO_REVIEWS') {
        // 后端对 0 匹配返回 422；这是“无匹配”而不是预览失败（F3）。
        setPreview({
          status: 'no_match',
          error: {
            code: apiError.code,
            message: apiError.message,
            detail: apiError.detail,
          },
          requestedAt: Date.now(),
        });
      } else {
        setPreview({
          status: 'error',
          error: {
            code: apiError.code,
            message: apiError.message,
            detail: apiError.detail,
          },
        });
      }
      if (apiError.code === 'NETWORK_ERROR') setBackendStatus('offline');
    }
  }, [appid, config, preview.status, report, resolveInput, resolvingGame, showToast]);

  const startAnalysis = useCallback(
    async (overrides?: {
      forceFetch?: boolean;
      forceAnalyze?: boolean;
      appidOverride?: number;
      allowWithoutPreview?: boolean;
    }) => {
      setShowErrors(true);
      const effectiveAppid = overrides?.appidOverride ?? appid;
      const check = validateConfig(config, effectiveAppid);
      if (!check.valid) {
        showToast('请先完成必填配置并修正错误');
        if (!report) setPhase('configuring');
        return;
      }
      if (!config.apiKey.trim()) {
        showToast('请先填写 DeepSeek API Key');
        return;
      }

      const previewReady =
        preview.status === 'success' && getMatchingTotal(preview.result) > 0;
      if (!previewReady && !overrides?.allowWithoutPreview) {
        showToast(
          preview.status === 'no_match'
            ? '无匹配评论，请放宽筛选条件'
            : '请先预览匹配数',
        );
        if (!report) setPhase('configuring');
        return;
      }

      const effectiveForceFetch =
        forceFetch || !config.reuseDataset || Boolean(overrides?.forceFetch);
      const effectiveForceAnalyze =
        forceAnalyze || !config.reuseReport || Boolean(overrides?.forceAnalyze);

      const body: CreateJobRequest = {
        appid: effectiveAppid as number,        filters: sanitizedScrape(config),
        clientFilters: buildClientFilters(config),
        trend: { months: config.trendMonths },
        ai: {
          baseUrl: config.baseUrl.trim() || undefined,
          model: config.model.trim() || 'deepseek-flash',
          thinking: config.thinking,
        },
        options: {
          maxReviews: config.maxReviews,
          includeTranslations: config.includeTranslations,
          // 任务报告最多返回 50 条高赞评论，默认展示 10 条、展开至 50 条。
          // Top N 不进入 analysisHash，也不影响 AI token 成本。
          topReviews: Math.min(
            50,
            Math.max(1, Number.isFinite(config.topReviews) ? config.topReviews : 50),
          ),
        },
        data: {
          dataDir: config.dataDir.trim() || undefined,
          reuseDataset: config.reuseDataset,
          reuseReport: config.reuseReport,
          forceFetch: effectiveForceFetch,
          forceAnalyze: effectiveForceAnalyze,
        },
      };

      startedAppidRef.current = effectiveAppid;
      setStreamState('connected');
      setWasDisconnected(false);
      setJob({ status: 'queued', stage: 'queued', progress: 0, logs: [] });
      setPhase('analyzing');

      try {
        const created = await api.createJob(config.apiKey, body);
        reportDataDirRef.current = config.dataDir.trim();
        setReport(null);
        setReportSource(null);
        setJobId(created.jobId);
        setStreamState('connected');
        setWasDisconnected(false);
        setJob({
          jobId: created.jobId,
          status: 'queued',
          stage: 'queued',
          progress: 0,
          logs: [],
        });
        setBackendStatus('online');
        setForceFetch(false);
        setForceAnalyze(false);
      } catch (error) {
        const apiError = toApiError(error);
        setJob({
          status: 'failed',
          stage: 'queued',
          progress: 0,
          logs: [],
          error: {
            code: apiError.code,
            message: apiError.message,
            detail: apiError.detail,
          },
        });
        setPhase('error');
        if (apiError.code === 'NETWORK_ERROR') setBackendStatus('offline');
      }
    },
    [appid, config, forceAnalyze, forceFetch, preview.result, preview.status, report, showToast],
  );

  const handleStart = useCallback(() => {
    void startAnalysis();
  }, [startAnalysis]);

  /* 首次快照 + SSE 订阅；断线后先读快照，再重建实时流（正常连接期间不轮询）。 */
  useEffect(() => {
    if (!jobId) return undefined;
    const activeJobId = jobId;
    let disposed = false;
    let finished = false;
    let recovering = false;
    let timer: number | undefined;
    let closeSse: (() => void) | undefined;
    /** SSE 事件版本号：用于丢弃校准期间已被更新事件覆盖的旧快照。 */
    let eventRevision = 0;

    const stopRecovery = () => {
      recovering = false;
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      stopRecovery();
      closeSse?.();
      closeSse = undefined;
      setStreamState('connected');
    };

    const loadReport = async (id: string) => {
      try {
        const result = await api.getJobReport(id);
        if (disposed) return;
        setReport(result);
        setReportSource(null);
        setPhase('completed');
        setDatasetsRefreshKey((value) => value + 1);
      } catch (error) {
        if (disposed) return;
        const apiError = toApiError(error);
        setJob((previous) => ({
          ...previous,
          status: 'failed',
          error: { code: apiError.code, message: apiError.message, detail: apiError.detail },
        }));
        setPhase('error');
      }
    };

    const applySnapshot = (snapshot: JobSnapshot) => {
      if (disposed || finished) return;
      const status = normalizeJobStatus(snapshot.status);
      const snapshotLogs = Array.isArray(snapshot.logs) ? normalizeLogs(snapshot.logs) : null;
      const snapshotOmitted = snapshotLogs
        ? Math.max(0, snapshotLogs.length - MAX_TIMELINE_LOG_CACHE)
        : 0;
      setJob((previous) => ({
        ...previous,
        jobId: snapshot.jobId ?? previous.jobId,
        status,
        stage: snapshot.stage ?? previous.stage,
        progress:
          typeof snapshot.progress === 'number' && Number.isFinite(snapshot.progress)
            ? snapshot.progress
            : previous.progress,
        counts: snapshot.counts ?? previous.counts,
        logs: snapshotLogs
          ? snapshotLogs.slice(-MAX_TIMELINE_LOG_CACHE)
          : previous.logs,
        // 快照只带保留窗口内的日志；已累计丢弃的条数不能被快照清零，
        // 取两者较大值，避免恢复后「已省略较早 N 条」偏小。
        logOmitted: snapshotLogs
          ? Math.max(snapshotOmitted, previous.logOmitted ?? 0)
          : previous.logOmitted,
        message: snapshot.message ?? previous.message,
        error:
          snapshot.error ??
          (status === 'failed' ? previous.error : undefined),
        cancelled: status === 'cancelled' ? true : previous.cancelled,
        cancelRequested: status === 'cancelled' ? false : previous.cancelRequested,
      }));

      if (status === 'completed') {
        finish();
        if (snapshot.report) {
          setReport(snapshot.report);
          setReportSource(null);
          setPhase('completed');
          setDatasetsRefreshKey((value) => value + 1);
        } else {
          void loadReport(snapshot.jobId);
        }
      } else if (status === 'failed') {
        finish();
        setPhase('error');
      } else if (status === 'cancelled') {
        finish();
      }
    };

    /**
     * 读取一次快照。recovering=true 时在成功校准后重建 SSE（先快照、再实时流）。
     * 若请求期间已收到更新的 SSE 事件，非终态快照会被丢弃。
     */
    const pollSnapshot = async (recoveringFromDisconnect: boolean) => {
      const revisionAtRequest = eventRevision;
      try {
        const snapshot = await api.getJob(activeJobId);
        if (disposed || finished) return;
        const status = normalizeJobStatus(snapshot.status);
        const incomingTerminal =
          status === 'completed' || status === 'failed' || status === 'cancelled';
        const stale = revisionAtRequest !== eventRevision && !incomingTerminal;
        if (!stale) {
          applySnapshot(snapshot);
          setBackendStatus('online');
        }
        if (recoveringFromDisconnect && recovering && !finished) {
          stopRecovery();
          connect();
        }
      } catch (error) {
        if (disposed || finished) return;
        const apiError = toApiError(error);
        if (apiError.code === 'NETWORK_ERROR') {
          setBackendStatus('offline');
          setJob((previous) => ({ ...previous, message: '与后端连接中断，正在重试…' }));
        } else if (apiError.code === 'JOB_NOT_FOUND') {
          setJob((previous) => ({
            ...previous,
            status: 'failed',
            error: { code: apiError.code, message: apiError.message },
          }));
          setPhase('error');
          finish();
        } else {
          // 500/INTERNAL 等：保留已有进度。只有断线恢复轮询才会继续重试；
          // bootstrap 首次快照失败不会重试，文案不得写「正在重试」。
          setJob((previous) => ({
            ...previous,
            message: recoveringFromDisconnect
              ? '读取任务状态失败，正在重试…'
              : '读取任务状态失败，等待实时连接同步',
          }));
        }
      }
    };

    const startRecovery = () => {
      if (disposed || finished || recovering) return;
      recovering = true;
      setWasDisconnected(true);
      setStreamState('disconnected');
      void pollSnapshot(true);
      timer = window.setInterval(() => {
        void pollSnapshot(true);
      }, 2000);
    };

    function connect() {
      if (disposed || finished) return;
      closeSse?.();
      closeSse = subscribeJob(activeJobId, {
        onOpen: () => {
          if (disposed) return;
          setStreamState('connected');
        },
        onStatus: (payload) => {
          if (disposed || finished) return;
          eventRevision += 1;
          setStreamState('connected');
          setJob((previous) => ({
            ...previous,
            status: previous.status === 'queued' ? 'running' : previous.status,
            stage: payload.stage ?? previous.stage,
            progress:
              typeof payload.progress === 'number' && Number.isFinite(payload.progress)
                ? payload.progress
                : previous.progress,
            // counts 按字段合并，阶段变化不清空已知计数；新 jobId 时由初始状态重置。
            counts: { ...previous.counts, ...payload.counts },
            message: payload.message ?? previous.message,
          }));
        },
        onLog: (payload) => {
          if (disposed || finished) return;
          eventRevision += 1;
          setStreamState('connected');
          const entry: JobLogEntry = {
            level: normalizeLogLevel(payload.level),
            message: payload.message ?? '',
            // 优先使用服务端时间/标识；缺失时不补写成服务端时间。
            at: payload.timestamp,
            id: payload.id,
            observedAt: new Date().toISOString(),
          };
          setJob((previous) => {
            const merged = mergeLogs(previous.logs, [entry]);
            return {
              ...previous,
              logs: merged.logs,
              logOmitted: (previous.logOmitted ?? 0) + merged.dropped,
            };
          });
        },
        onDone: (payload) => {
          if (disposed || finished) return;
          eventRevision += 1;
          // 先落终态，时间线的 done 节点与「已完成」徽标才能在报告接管前出现；
          // payload 不含 report、走 loadReport 的路径也能先显示 100%。
          setJob((previous) => ({ ...previous, status: 'completed', progress: 100 }));
          if (payload.report) {
            setReport(payload.report);
            setReportSource(null);
            setPhase('completed');
            setDatasetsRefreshKey((value) => value + 1);
          } else {
            void loadReport(activeJobId);
          }
          finish();
        },
        onError: (payload) => {
          if (disposed || finished) return;
          eventRevision += 1;
          setJob((previous) => ({
            ...previous,
            status: 'failed',
            error: {
              code: payload.code ?? 'ERROR',
              message: payload.message ?? '任务失败',
              detail: payload.detail,
            },
          }));
          setPhase('error');
          finish();
        },
        onCancelled: () => {
          if (disposed || finished) return;
          eventRevision += 1;
          setJob((previous) => ({
            ...previous,
            status: 'cancelled',
            cancelled: true,
            cancelRequested: false,
          }));
          finish();
        },
        onDisconnected: () => {
          if (disposed || finished) return;
          // 主动关闭当前流，先以 GET /api/jobs/:id 快照校准，再重建 SSE。
          closeSse?.();
          closeSse = undefined;
          startRecovery();
        },
      });
    }

    const bootstrap = async () => {
      await pollSnapshot(false);
      if (!disposed && !finished) connect();
    };
    void bootstrap();

    return () => {
      disposed = true;
      stopRecovery();
      closeSse?.();
    };
  }, [jobId]);

  const handleCancel = useCallback(async () => {
    if (!jobId) return;
    setJob((previous) => ({ ...previous, cancelRequested: true }));
    try {
      await api.cancelJob(jobId);
      setJob((previous) => ({
        ...previous,
        status: 'cancelled',
        cancelled: true,
        cancelRequested: false,
      }));
      showToast('任务已取消');
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.code === 'JOB_NOT_FOUND' || apiError.code === 'CANCELLED') {
        setJob((previous) => ({
          ...previous,
          status: 'cancelled',
          cancelled: true,
          cancelRequested: false,
        }));
        return;
      }
      setJob((previous) => ({
        ...previous,
        cancelRequested: false,
        error: { code: apiError.code, message: apiError.message, detail: apiError.detail },
      }));
      setPhase('error');
    }
  }, [jobId, showToast]);

  const focusConfig = useCallback(() => {
    const element = document.getElementById('game-input');
    element?.focus();
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const handleRetryJob = useCallback(() => {
    void startAnalysis({
      allowWithoutPreview: true,
      appidOverride: startedAppidRef.current ?? undefined,
    });
  }, [startAnalysis]);

  const handleReanalyze = useCallback(() => {
    if (!report) return;
    const reportAppid = Number((report.game as { appid?: number } | undefined)?.appid);
    void startAnalysis({
      forceAnalyze: true,
      appidOverride: Number.isFinite(reportAppid) && reportAppid > 0 ? reportAppid : undefined,
      allowWithoutPreview: true,
    });
  }, [report, startAnalysis]);

  const handleOpenReport = useCallback((savedReport: Report, source: ReportSource) => {
    setReport(savedReport);
    setReportSource(source);
    reportDataDirRef.current = (source.dataDir ?? '').trim();
    setPhase('completed');
    const savedAppid = Number((savedReport.game as { appid?: number } | undefined)?.appid);
    if (Number.isFinite(savedAppid) && savedAppid > 0) {
      setAppid(savedAppid);
    }
    if (savedReport.game && typeof savedReport.game === 'object') {
      setGame(savedReport.game);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  /**
   * TopReviewsTable 展开历史报告时已按 analysisHash 从数据集重建完整列表；
   * 这里同步更新 App 的 report，使导出 Markdown 与样本分布图也使用完整列表。
   */
  const handleReviewsLoaded = useCallback((reviews: TopReview[]) => {
    setReport((previous) => (previous ? { ...previous, topReviews: reviews } : previous));
  }, []);

  const handleClearCache = useCallback(async () => {
    try {
      await api.clearCache();
      showToast('已清除 Steam 短期缓存，可重新尝试');
    } catch (error) {
      showToast(`清除短期缓存失败：${toApiError(error).message}`);
    }
  }, [showToast]);

  /**
   * 标题保存成功（或 409 冲突刷新）后，按 AppID 同步：
   * 顶部当前游戏、预览中的 GamePresentation、已打开报告的头部。
   * titleRevision 只由后端递增；这里不再接受更旧的响应覆盖较新标题。
   */
  const handleTitleUpdated = useCallback((updated: GamePresentation) => {
    const updatedRevision = gameTitleInfo(updated, updated.appid).titleRevision;
    const canApply = (current: Partial<GameMeta> | null | undefined) =>
      !current ||
      updatedRevision >=
        gameTitleInfo(current as GameMeta, Number(current.appid)).titleRevision;
    // 预览结果与已打开报告各自绑定创建时的数据目录；标题按目录隔离，
    // 当前目录中的改名不得改写另一个目录的展示缓存。
    const normalizeDir = (value: string | undefined) =>
      (value ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    const sameDataDir = (value: string | undefined) =>
      normalizeDir(value) === normalizeDir(config.dataDir);

    setGame((previous) => {
      if (!previous) return previous;
      const previousAppid = Number(previous.appid);
      if (Number.isFinite(previousAppid) && previousAppid !== updated.appid) return previous;
      if (!canApply(previous)) return previous;
      return { ...previous, ...updated };
    });
    setPreview((previous) => {
      if (!previous.result || !sameDataDir(previewDataDirRef.current)) return previous;
      const previewAppid = Number(previous.result.appid ?? previous.result.game?.appid);
      if (previewAppid !== updated.appid) return previous;
      const currentGame =
        previous.result.game && typeof previous.result.game === 'object'
          ? previous.result.game
          : {};
      if (!canApply(currentGame)) return previous;
      return {
        ...previous,
        result: { ...previous.result, game: { ...currentGame, ...updated } },
      };
    });
    setReport((previous) => {
      if (!previous || !sameDataDir(reportDataDirRef.current)) return previous;
      if (Number(previous.game?.appid) !== updated.appid) return previous;
      if (!canApply(previous.game)) return previous;
      return { ...previous, game: { ...previous.game, ...updated } };
    });
  }, [config.dataDir]);

  const handleUseDataset = useCallback((dataset: DatasetSummary) => {
    const url = `https://store.steampowered.com/app/${dataset.appid}`;
    lastGameUrlRef.current = url;
    setConfig((previous) => ({ ...previous, gameUrl: url }));
    setAppid(dataset.appid);
    setGame(
      typeof dataset.game === 'string'
        ? { appid: dataset.appid, name: dataset.game }
        : { ...dataset.game, appid: dataset.appid },
    );
    setGameError(null);
    showToast(`已填入 ${gameTitleInfo(dataset.game, dataset.appid).displayTitle}，可预览或开始分析`);
  }, [showToast]);

  const handleApplyDataDir = useCallback(async () => {
    const dir = config.dataDir.trim();
    setDataDirApplyError(null);
    setDataDirMessage(null);
    const localError = validateDataDir(dir);
    if (localError) {
      setDataDirApplyError(localError);
      return;
    }
    if (!dir) {
      setDataDirMessage('使用默认数据目录（工程根 ./data）');
      setDatasetsRefreshKey((value) => value + 1);
      return;
    }
    setApplyingDataDir(true);
    try {
      const result = await api.validateDataDir(dir);
      setConfig((previous) => ({ ...previous, dataDir: result.dataDir }));
      setDataDirMessage(`已应用：${result.dataDir}`);
      setDatasetsRefreshKey((value) => value + 1);
      setBackendStatus('online');
    } catch (error) {
      const apiError = toApiError(error);
      setDataDirApplyError(`${apiError.code}: ${apiError.message}`);
      if (apiError.code === 'NETWORK_ERROR') setBackendStatus('offline');
    } finally {
      setApplyingDataDir(false);
    }
  }, [config.dataDir]);

  const handleExport = useCallback(async () => {
    if (!report) return;
    try {
      const filename = await downloadReportMarkdown(report, reportSource ?? undefined);
      showToast(`已导出 ${filename}`);
    } catch {
      showToast('导出失败，请重试');
    }
  }, [report, reportSource, showToast]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const handleRefetch = useCallback(() => {
    setForceFetch(true);
    setForceAnalyze(false);
    showToast('已设置重新抓取：开始分析时将忽略本地数据集');
  }, [showToast]);

  const handleForceReanalyze = useCallback(() => {
    setForceAnalyze(true);
    setForceFetch(false);
    showToast('已设置重新分析：开始分析时将忽略本地报告并消耗 token');
  }, [showToast]);

  const localDataPanel = (
    <LocalDataPanel
      dataDir={config.dataDir}
      refreshKey={datasetsRefreshKey}
      onUseDataset={handleUseDataset}
      onOpenReport={handleOpenReport}
      onChanged={() => setDatasetsRefreshKey((value) => value + 1)}
      onTitleUpdated={handleTitleUpdated}
    />
  );

  const configPanel = (
    <ConfigPanel
      config={config}
      onConfigChange={updateConfig}
      game={game}
      appid={appid}
      resolvingGame={resolvingGame}
      gameError={gameError}
      onResolveGame={handleResolveGame}
      testingKey={testingKey}
      aiTest={aiTest}
      aiTestError={aiTestError}
      onTestKey={handleTestKey}
      onClearKey={handleClearKey}
      validation={validation}
      showErrors={showErrors}
      preview={preview}
      reuseDataset={reuseInfo.dataset}
      reuseReport={reuseInfo.report}
      historicalReport={reuseInfo.historicalReport}
      forceFetch={forceFetch}
      forceAnalyze={forceAnalyze}
      onRefetch={handleRefetch}
      onReanalyze={handleForceReanalyze}
      onPreview={handlePreview}
      onStart={handleStart}
      onCancel={handleCancel}
      analyzing={phase === 'analyzing'}
      applyingDataDir={applyingDataDir}
      dataDirApplyError={dataDirApplyError}
      dataDirMessage={dataDirMessage}
      onApplyDataDir={handleApplyDataDir}
      localDataPanel={localDataPanel}
    />
  );

  const renderWorkspace = () => {
    if (phase === 'analyzing') {
      return (
        <ProgressPanel
          job={job}
          connection={streamState}
          recovered={wasDisconnected}
          onCancel={handleCancel}
          onRetry={handleRetryJob}
          onAdjustFilters={focusConfig}
          onClearCache={() => void handleClearCache()}
        />
      );
    }
    if (phase === 'completed' && report) {
      return (
        <ReportView
          report={report}
          onReanalyze={handleReanalyze}
          reportSource={reportSource ?? undefined}
          onReviewsLoaded={handleReviewsLoaded}
        />
      );
    }
    if (phase === 'error') {
      if (job.error || job.jobId) {
        return (
          <ProgressPanel
            job={job}
            connection={streamState}
            recovered={wasDisconnected}
            onCancel={handleCancel}
            onRetry={handleRetryJob}
            onAdjustFilters={focusConfig}
            onClearCache={() => void handleClearCache()}
          />
        );
      }
      return (
        <div className="preview-panel">
          <ErrorBanner
            title="发生错误"
            message="任务执行失败，请重试或调整配置"
            action={
              <button type="button" className="btn btn-sm" onClick={handleRetryJob}>
                重试
              </button>
            }
          />
        </div>
      );
    }
    if (phase === 'previewing' && preview.status !== 'idle') {
      return (
        <PreviewPanel
          preview={preview}
          game={game}
          appid={appid}
          maxReviews={config.maxReviews}
          trendMonths={config.trendMonths}
          canStart={canStart}
          startDisabledReason={
            preview.status === 'no_match'
              ? '无匹配评论，请放宽筛选条件'
              : !validation.valid
                ? '请先完成必填配置'
                : '请先预览匹配数'
          }
          onRetry={() => void handlePreview()}
          onStart={handleStart}
          onAdjustFilters={focusConfig}
        />
      );
    }

    if (appid && game) {
      return (
        <EmptyState
          mark="GR"
          title={validation.valid ? '配置已就绪，预览匹配数与成本' : `已选择：${game.name}`}
          actions={
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handlePreview()}
                disabled={preview.status === 'loading'}
              >
                预览匹配数
              </button>
              <button type="button" className="btn btn-ghost" onClick={focusConfig}>
                继续配置
              </button>
            </div>
          }
        >
          <p>
            预览只读取 Steam 官方聚合（不会抓取全量评论），展示游戏信息、总评论数、Steam 侧匹配数以及预估页数、耗时与 token 成本。
          </p>
          <div className="empty-steps">
            <span className="empty-step">
              <span className="n">1</span> 已解析 AppID {appid}
            </span>
            <span className="empty-step">
              <span className="n">2</span> {config.apiKey ? 'API Key 已填写' : '等待填写 API Key'}
            </span>
            <span className="empty-step">
              <span className="n">3</span> 抓取上限 {formatNumber(config.maxReviews)} 条
            </span>
            <span className="empty-step">
              <span className="n">4</span>{' '}
              {config.trendMonths === 36
                ? '趋势 全部（最多 36 个月）'
                : `趋势 ${config.trendMonths} 个月`}
            </span>
          </div>
          {!config.apiKey ? (
            <div className="notice warning" style={{ maxWidth: 520 }}>
              <span className="notice-icon" aria-hidden="true">
                !
              </span>
              <div>请先在左侧「AI 设置」填入 DeepSeek API Key，Key 仅保存在本机浏览器。</div>
            </div>
          ) : null}
        </EmptyState>
      );
    }

    return (
      <EmptyState
        mark="GR"
        title="开始一次 Steam 口碑分析"
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                patchConfig({ gameUrl: EXAMPLE_URL });
                window.setTimeout(() => document.getElementById('game-input')?.focus(), 0);
              }}
            >
              填入示例链接
            </button>
            <button type="button" className="btn btn-ghost" onClick={focusConfig}>
              去配置
            </button>
          </div>
        }
      >
        <p>
          粘贴 Steam 商店链接、社区链接或 AppID，填入 DeepSeek API Key，配置抓取范围后预览成本并开始分析。报告包含结论、口碑趋势、AI 归纳与证据引用。
        </p>
        <button
          type="button"
          className="example-link"
          onClick={() => {
            patchConfig({ gameUrl: EXAMPLE_URL });
            window.setTimeout(() => document.getElementById('game-input')?.focus(), 0);
          }}
        >
          {EXAMPLE_URL}
        </button>
        <div className="empty-steps">
          <span className="empty-step">
            <span className="n">1</span> 输入链接并解析
          </span>
          <span className="empty-step">
            <span className="n">2</span> 填入 API Key
          </span>
          <span className="empty-step">
            <span className="n">3</span> 配置抓取与趋势
          </span>
          <span className="empty-step">
            <span className="n">4</span> 预览并开始分析
          </span>
        </div>
        <p className="small dim">
          本地运行 · 无账号 · API Key 不落盘 · 自动保存数据集与报告以复用省 token
        </p>
      </EmptyState>
    );
  };

  const mobileActions = (
    <div className="mobile-action-bar no-print">
      {phase === 'analyzing' ? (
        job.cancelled || job.status === 'cancelled' ? (
          <button
            type="button"
            className="btn btn-block"
            onClick={() => setPhase(report ? 'completed' : 'configuring')}
          >
            已取消 · {report ? '查看报告' : '返回配置'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-danger btn-block"
            onClick={handleCancel}
            disabled={job.cancelRequested}
          >
            {job.cancelRequested ? '取消中…' : '取消分析'}
          </button>
        )
      ) : (
        <>
          <button
            type="button"
            className="btn"
            onClick={() => void handlePreview()}
            disabled={preview.status === 'loading'}
          >
            预览
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleStart}
            disabled={!canStart}
            title={
              canStart
                ? '开始分析'
                : preview.status === 'no_match'
                  ? '无匹配评论，请放宽筛选条件'
                  : '请先完成配置并预览匹配数'
            }
          >
            开始分析
          </button>
        </>
      )}
    </div>
  );

  const banners =
    backendStatus === 'offline' ? (
      <div className="global-banner warning" role="status">
        <span aria-hidden="true">!</span>
        <span>
          无法连接后端服务（默认 http://127.0.0.1:53821）。请先启动服务；桌面版生产模式默认同源。
        </span>
        <button type="button" className="btn btn-sm" onClick={() => void checkHealth()}>
          重试连接
        </button>
      </div>
    ) : null;

  return (
    <>
      <AppLayout
        header={
          <Header
            game={game}
            version={version}
            backendStatus={backendStatus}
            hasReport={phase === 'completed' && Boolean(report)}
            onExport={handleExport}
            onPrint={handlePrint}
            onReanalyze={handleReanalyze}
            configCollapsed={configCollapsed}
            onToggleConfig={() => setConfigCollapsed((value) => !value)}
          />
        }
        banners={banners}
        configPanel={configPanel}
        configCollapsed={configCollapsed}
        mobileActions={mobileActions}
      >
        {renderWorkspace()}
      </AppLayout>
      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
      <div aria-live="polite" className="sr-only">
        {phase === 'analyzing'
          ? `分析进度 ${Math.round(job.progress > 0 && job.progress < 1 ? job.progress * 100 : job.progress)}%，${
              job.message ?? job.stage ?? ''
            }`
          : phase === 'completed'
            ? '分析完成，报告已生成'
            : ''}
      </div>
    </>
  );
}
