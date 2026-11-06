import { useEffect, useState } from 'react';
import type { ClientFilters, ScrapeFilters } from '../types';
import type { ConfigErrors } from '../lib/validation';
import {
  dateRangeForPreset,
  fromUnixSeconds,
  parseKeywordList,
  presetForDateRange,
  toUnixSeconds,
  type DateRangePreset,
} from '../lib/validation';
import { LANGUAGE_OPTIONS, MAX_REVIEWS_OPTIONS } from '../lib/defaults';
import { FieldError } from './ui';

interface ScrapeConfigFormProps {
  scrape: ScrapeFilters;
  client: ClientFilters;
  maxReviews: number;
  onScrapeChange: (patch: Partial<ScrapeFilters>) => void;
  onClientChange: (patch: Partial<ClientFilters>) => void;
  onMaxReviewsChange: (value: number) => void;
  errors: ConfigErrors;
  showErrors: boolean;
}

const DATE_PRESETS: Array<{ value: DateRangePreset; label: string }> = [
  { value: 'all', label: '全部' },
  { value: '30d', label: '最近 30 天' },
  { value: '90d', label: '最近 90 天' },
  { value: '365d', label: '最近 365 天' },
  { value: 'custom', label: '自定义' },
];

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function ScrapeConfigForm({
  scrape,
  client,
  maxReviews,
  onScrapeChange,
  onClientChange,
  onMaxReviewsChange,
  errors,
  showErrors,
}: ScrapeConfigFormProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [datePreset, setDatePreset] = useState<DateRangePreset>(() =>
    presetForDateRange(scrape.dateRange),
  );
  const [includeText, setIncludeText] = useState(() => client.includeKeywords.join(' '));
  const [excludeText, setExcludeText] = useState(() => client.excludeKeywords.join(' '));

  useEffect(() => {
    if (errors.playtime) setAdvancedOpen(true);
  }, [errors.playtime]);

  const handlePresetChange = (preset: DateRangePreset) => {
    setDatePreset(preset);
    if (preset === 'custom') {
      const base = scrape.dateRange ?? {
        start: Math.floor(Date.now() / 1000) - 30 * 86400,
        end: Math.floor(Date.now() / 1000),
      };
      onScrapeChange({ dateRange: base });
      return;
    }
    onScrapeChange({ dateRange: dateRangeForPreset(preset, {}) });
  };

  const updateDate = (field: 'start' | 'end', value: string) => {
    const current = scrape.dateRange ?? {};
    const next = { ...current, [field]: toUnixSeconds(value) };
    if (next.start === undefined && next.end === undefined) {
      onScrapeChange({ dateRange: null });
      return;
    }
    onScrapeChange({ dateRange: next });
  };

  const toggleLanguage = (code: string) => {
    if (code === 'all') {
      onScrapeChange({ languages: ['all'] });
      return;
    }
    const current = scrape.languages.filter((item) => item !== 'all');
    const next = current.includes(code)
      ? current.filter((item) => item !== code)
      : [...current, code];
    onScrapeChange({ languages: next.length > 0 ? next : ['all'] });
  };

  const languageAllSelected = scrape.languages.includes('all');

  return (
    <div>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="review-type">评论类型</label>
          <select
            id="review-type"
            className="select"
            value={scrape.reviewType}
            onChange={(event) =>
              onScrapeChange({ reviewType: event.target.value as ScrapeFilters['reviewType'] })
            }
          >
            <option value="all">全部</option>
            <option value="positive">好评</option>
            <option value="negative">差评</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort-mode">排序</label>
          <select
            id="sort-mode"
            className="select"
            value={scrape.sort}
            onChange={(event) =>
              onScrapeChange({ sort: event.target.value as ScrapeFilters['sort'] })
            }
          >
            <option value="helpful">高赞优先</option>
            <option value="recent">最新</option>
            <option value="updated">最近更新</option>
          </select>
        </div>
      </div>

      <div className="field">
        <span className="field-label" id="language-label">
          语言（可多选）
        </span>
        <div className="chip-group" role="group" aria-labelledby="language-label">
          <button
            type="button"
            className="chip"
            aria-pressed={languageAllSelected}
            onClick={() => toggleLanguage('all')}
          >
            全部
          </button>
          {LANGUAGE_OPTIONS.map((option) => (
            <button
              key={option.code}
              type="button"
              className="chip"
              aria-pressed={!languageAllSelected && scrape.languages.includes(option.code)}
              onClick={() => toggleLanguage(option.code)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="field-hint">默认简中 + 英文；选择「全部」时使用 Steam 全语言。</p>
      </div>

      <div className="field-grid">
        <div className="field">
          <label htmlFor="purchase-type">购买来源</label>
          <select
            id="purchase-type"
            className="select"
            value={scrape.purchaseType}
            onChange={(event) =>
              onScrapeChange({ purchaseType: event.target.value as ScrapeFilters['purchaseType'] })
            }
          >
            <option value="all">全部</option>
            <option value="steam">Steam 购买</option>
            <option value="non_steam">非 Steam</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="trend-date-preset">样本时间范围</label>
          <select
            id="trend-date-preset"
            className="select"
            value={datePreset}
            onChange={(event) => handlePresetChange(event.target.value as DateRangePreset)}
          >
            {DATE_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {datePreset === 'custom' ? (
        <div className="field-grid">
          <div className="field">
            <label htmlFor="date-start">开始日期</label>
            <input
              id="date-start"
              className="input"
              type="date"
              value={fromUnixSeconds(scrape.dateRange?.start)}
              onChange={(event) => updateDate('start', event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="date-end">结束日期</label>
            <input
              id="date-end"
              className="input"
              type="date"
              value={fromUnixSeconds(scrape.dateRange?.end)}
              onChange={(event) => updateDate('end', event.target.value)}
            />
          </div>
        </div>
      ) : null}
      {showErrors && errors.dateRange ? <FieldError>{errors.dateRange}</FieldError> : null}

      <div className="field">
        <label htmlFor="max-reviews">抓取数量上限</label>
        <div className="input-row">
          <input
            id="max-reviews"
            className="input"
            type="number"
            min={1}
            max={1000}
            step={1}
            value={Number.isFinite(maxReviews) ? maxReviews : ''}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              onMaxReviewsChange(Number.isFinite(parsed) ? parsed : 0);
            }}
            aria-invalid={Boolean(showErrors && errors.maxReviews)}
          />
        </div>
        <div className="chip-group" style={{ marginTop: 6 }}>
          {MAX_REVIEWS_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className="chip"
              aria-pressed={maxReviews === option}
              onClick={() => onMaxReviewsChange(option)}
            >
              {option}
            </button>
          ))}
        </div>
        {showErrors && errors.maxReviews ? <FieldError>{errors.maxReviews}</FieldError> : null}
        <p className="field-hint">最多 1000 条；实际抓取还受匹配数与安全上限限制。</p>
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label className="checkbox-row" htmlFor="exclude-offtopic">
          <input
            id="exclude-offtopic"
            type="checkbox"
            checked={scrape.excludeOffTopic}
            onChange={(event) => onScrapeChange({ excludeOffTopic: event.target.checked })}
          />
          <span>
            <strong>排除离题/差评轰炸</strong>
            <br />
            Steam filter_offtopic_activity，默认开启。
          </span>
        </label>
      </div>

      <button
        type="button"
        className="advanced-toggle"
        aria-expanded={advancedOpen}
        aria-controls="advanced-filters"
        onClick={() => setAdvancedOpen((prev) => !prev)}
      >
        <span>高级筛选（客户端二次筛选）</span>
        <span className="chevron" aria-hidden="true">
          ›
        </span>
      </button>

      <div id="advanced-filters" className="advanced-content" hidden={!advancedOpen}>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="min-votes">最低赞数</label>
            <input
              id="min-votes"
              className="input"
              type="number"
              min={0}
              step={1}
              value={client.minVotes ?? 0}
              onChange={(event) =>
                onClientChange({ minVotes: parseOptionalNumber(event.target.value) ?? 0 })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="min-length">最短字数</label>
            <input
              id="min-length"
              className="input"
              type="number"
              min={0}
              step={1}
              value={client.minLength ?? 0}
              onChange={(event) =>
                onClientChange({ minLength: parseOptionalNumber(event.target.value) ?? 0 })
              }
            />
          </div>
        </div>

        <div className="field-grid">
          <div className="field">
            <label htmlFor="min-playtime">最低游玩时长（小时）</label>
            <input
              id="min-playtime"
              className="input"
              type="number"
              min={0}
              step={0.5}
              value={scrape.minPlaytimeHours ?? ''}
              placeholder="不限"
              onChange={(event) =>
                onScrapeChange({ minPlaytimeHours: parseOptionalNumber(event.target.value) })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="max-playtime">最高游玩时长（小时）</label>
            <input
              id="max-playtime"
              className="input"
              type="number"
              min={0}
              step={0.5}
              value={scrape.maxPlaytimeHours ?? ''}
              placeholder="不限"
              onChange={(event) =>
                onScrapeChange({ maxPlaytimeHours: parseOptionalNumber(event.target.value) })
              }
            />
          </div>
        </div>
        {showErrors && errors.playtime ? <FieldError>{errors.playtime}</FieldError> : null}

        <div className="field">
          <label htmlFor="include-keywords">关键词包含（空格分隔，需全部包含）</label>
          <textarea
            id="include-keywords"
            className="textarea textarea-keywords"
            value={includeText}
            placeholder="如：战斗 手感"
            onChange={(event) => {
              setIncludeText(event.target.value);
              onClientChange({ includeKeywords: parseKeywordList(event.target.value) });
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="exclude-keywords">关键词排除（空格分隔，任一包含即排除）</label>
          <textarea
            id="exclude-keywords"
            className="textarea textarea-keywords"
            value={excludeText}
            placeholder="如：闪退 退款"
            onChange={(event) => {
              setExcludeText(event.target.value);
              onClientChange({ excludeKeywords: parseKeywordList(event.target.value) });
            }}
          />
        </div>

        <div className="field" style={{ gap: 8 }}>
          <label className="checkbox-row" htmlFor="exclude-early-access">
            <input
              id="exclude-early-access"
              type="checkbox"
              checked={client.excludeEarlyAccess}
              onChange={(event) => onClientChange({ excludeEarlyAccess: event.target.checked })}
            />
            <span>排除抢先体验期间的评论</span>
          </label>
          <label className="checkbox-row" htmlFor="exclude-free">
            <input
              id="exclude-free"
              type="checkbox"
              checked={client.excludeFree}
              onChange={(event) => onClientChange({ excludeFree: event.target.checked })}
            />
            <span>排除免费获得游戏的评论</span>
          </label>
          <label className="checkbox-row" htmlFor="use-quality">
            <input
              id="use-quality"
              type="checkbox"
              checked={scrape.useReviewQuality}
              onChange={(event) => onScrapeChange({ useReviewQuality: event.target.checked })}
            />
            <span>使用 Steam 质量排序（关闭后按加权赞数排序）</span>
          </label>
        </div>

        <div className="notice" style={{ marginTop: 10 }}>
          <span className="notice-icon" aria-hidden="true">
            i
          </span>
          <div>
            最低赞数、关键词、最短字数、排除抢先体验/免费获得属于客户端二次筛选，预览匹配数不含这些条件；预览为 Steam 侧聚合结果。
          </div>
        </div>
      </div>
    </div>
  );
}
