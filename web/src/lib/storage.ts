import { DEFAULT_CONFIG } from './defaults';
import type { AnalysisConfig } from '../types';

const CONFIG_KEY = 'greview.config.v1';
const API_KEY_KEY = 'greview.apiKey';

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readJson<T>(key: string): T | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadConfig(): AnalysisConfig {
  const persisted = readJson<Partial<AnalysisConfig>>(CONFIG_KEY);
  const storedKey = hasWindow() ? window.localStorage.getItem(API_KEY_KEY) : null;

  if (!persisted || typeof persisted !== 'object') {
    return { ...DEFAULT_CONFIG, apiKey: storedKey ?? '' };
  }

  const scrape = { ...DEFAULT_CONFIG.scrape, ...(persisted.scrape ?? {}) };
  const client = { ...DEFAULT_CONFIG.client, ...(persisted.client ?? {}) };

  return {
    ...DEFAULT_CONFIG,
    ...persisted,
    // 防御 localStorage 中被手工改坏的值
    thinking: persisted.thinking === true,
    maxReviews:
      typeof persisted.maxReviews === 'number' && Number.isFinite(persisted.maxReviews)
        ? persisted.maxReviews
        : DEFAULT_CONFIG.maxReviews,
    trendMonths:
      typeof persisted.trendMonths === 'number' ? persisted.trendMonths : DEFAULT_CONFIG.trendMonths,
    topReviews:
      typeof persisted.topReviews === 'number' ? persisted.topReviews : DEFAULT_CONFIG.topReviews,
    includeTranslations: persisted.includeTranslations !== false,
    reuseDataset: persisted.reuseDataset !== false,
    reuseReport: persisted.reuseReport !== false,
    dataDir: typeof persisted.dataDir === 'string' ? persisted.dataDir : '',
    baseUrl: typeof persisted.baseUrl === 'string' ? persisted.baseUrl : DEFAULT_CONFIG.baseUrl,
    model: typeof persisted.model === 'string' && persisted.model ? persisted.model : DEFAULT_CONFIG.model,
    gameUrl: typeof persisted.gameUrl === 'string' ? persisted.gameUrl : '',
    apiKey: storedKey ?? (typeof persisted.apiKey === 'string' ? persisted.apiKey : ''),
    scrape: {
      ...scrape,
      languages: Array.isArray(scrape.languages) && scrape.languages.length > 0
        ? scrape.languages
        : DEFAULT_CONFIG.scrape.languages,
      dateRange: scrape.dateRange ?? null,
    },
    client: {
      ...client,
      includeKeywords: Array.isArray(client.includeKeywords) ? client.includeKeywords : [],
      excludeKeywords: Array.isArray(client.excludeKeywords) ? client.excludeKeywords : [],
    },
  };
}

export function saveConfig(config: AnalysisConfig): void {
  if (!hasWindow()) return;
  try {
    const { apiKey, ...rest } = config;
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(rest));
    if (apiKey) {
      window.localStorage.setItem(API_KEY_KEY, apiKey);
    } else {
      window.localStorage.removeItem(API_KEY_KEY);
    }
  } catch {
    // localStorage 不可用（隐私模式/配额不足）时静默降级
  }
}

export function clearStoredApiKey(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(API_KEY_KEY);
    const persisted = readJson<Partial<AnalysisConfig>>(CONFIG_KEY);
    if (persisted) {
      delete persisted.apiKey;
      window.localStorage.setItem(CONFIG_KEY, JSON.stringify(persisted));
    }
  } catch {
    // ignore
  }
}
