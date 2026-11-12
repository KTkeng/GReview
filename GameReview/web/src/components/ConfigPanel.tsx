import type { ReactNode } from 'react';
import type {
  AiTestResult,
  AnalysisConfig,
  ClientFilters,
  GameMeta,
  PreviewState,
  ReusableDataset,
  ReusableReport,
  ScrapeFilters,
} from '../types';
import type { ConfigValidation } from '../lib/validation';
import { GameInput } from './GameInput';
import { APIKeyInput } from './APIKeyInput';
import { ModelSelect } from './ModelSelect';
import { ThinkingToggle } from './ThinkingToggle';
import { ScrapeConfigForm } from './ScrapeConfigForm';
import { TrendConfigForm } from './TrendConfigForm';
import { DataDirConfig } from './DataDirConfig';
import { ReusePrompt } from './ReusePrompt';
import { ActionButtons } from './ActionButtons';

export interface ConfigPanelProps {
  config: AnalysisConfig;
  onConfigChange: (updater: (previous: AnalysisConfig) => AnalysisConfig) => void;
  game: GameMeta | null;
  appid: number | null;
  resolvingGame: boolean;
  gameError: string | null;
  onResolveGame: () => void;
  testingKey: boolean;
  aiTest: AiTestResult | null;
  aiTestError: string | null;
  onTestKey: () => void;
  onClearKey: () => void;
  validation: ConfigValidation;
  showErrors: boolean;
  preview: PreviewState;
  reuseDataset: ReusableDataset | null;
  reuseReport: ReusableReport | null;
  historicalReport: ReusableReport | null;
  forceFetch: boolean;
  forceAnalyze: boolean;
  onRefetch: () => void;
  onReanalyze: () => void;
  onPreview: () => void;
  onStart: () => void;
  onCancel: () => void;
  analyzing: boolean;
  applyingDataDir: boolean;
  dataDirApplyError: string | null;
  dataDirMessage: string | null;
  onApplyDataDir: () => void;
  localDataPanel: ReactNode;
}

export function ConfigPanel({
  config,
  onConfigChange,
  game,
  appid,
  resolvingGame,
  gameError,
  onResolveGame,
  testingKey,
  aiTest,
  aiTestError,
  onTestKey,
  onClearKey,
  validation,
  showErrors,
  preview,
  reuseDataset,
  reuseReport,
  historicalReport,
  forceFetch,
  forceAnalyze,
  onRefetch,
  onReanalyze,
  onPreview,
  onStart,
  onCancel,
  analyzing,
  applyingDataDir,
  dataDirApplyError,
  dataDirMessage,
  onApplyDataDir,
  localDataPanel,
}: ConfigPanelProps) {
  const { errors } = validation;
  const updateConfig = (patch: Partial<AnalysisConfig>) =>
    onConfigChange((previous) => ({ ...previous, ...patch }));
  const updateScrape = (patch: Partial<ScrapeFilters>) =>
    onConfigChange((previous) => ({ ...previous, scrape: { ...previous.scrape, ...patch } }));
  const updateClient = (patch: Partial<ClientFilters>) =>
    onConfigChange((previous) => ({ ...previous, client: { ...previous.client, ...patch } }));

  const matching = preview.result
    ? preview.result.steamMatchingTotal ??
      preview.result.summary?.matchingTotal ??
      preview.result.summary?.total ??
      0
    : 0;
  const canStart =
    validation.valid && preview.status === 'success' && Number.isFinite(matching) && matching > 0;

  let startDisabledReason: string | null = null;
  if (!validation.valid) {
    startDisabledReason = '请先完成必填配置并修正提示的错误';
  } else if (preview.status === 'no_match') {
    startDisabledReason = '无匹配评论，请放宽筛选条件';
  } else if (preview.status === 'error') {
    startDisabledReason = '预览失败，请检查错误后重试';
  } else if (preview.status !== 'success') {
    startDisabledReason = '请先点击「预览匹配数」';
  } else if (matching <= 0) {
    startDisabledReason = '无匹配评论，请放宽筛选条件';
  }

  return (
    <div className="config-panel-inner">
      <div className="config-intro">
        <h1>配置</h1>
        <p>左侧完成配置，右侧查看预览、进度与报告。</p>
      </div>

      <section className="panel-section" aria-labelledby="section-game">
        <div className="section-heading">
          <span className="step-index" aria-hidden="true">
            1
          </span>
          <h2 id="section-game">游戏</h2>
        </div>
        <GameInput
          value={config.gameUrl}
          onChange={(value) => updateConfig({ gameUrl: value })}
          onResolve={onResolveGame}
          resolving={resolvingGame}
          game={game}
          appid={appid}
          error={gameError ?? (showErrors ? errors.game ?? null : null)}
        />
      </section>

      <section className="panel-section" aria-labelledby="section-ai">
        <div className="section-heading">
          <span className="step-index" aria-hidden="true">
            2
          </span>
          <h2 id="section-ai">AI 设置</h2>
          <span className="optional">Key 仅存本机</span>
        </div>
        <APIKeyInput
          value={config.apiKey}
          onChange={(value) => updateConfig({ apiKey: value })}
          onTest={onTestKey}
          onClear={onClearKey}
          testing={testingKey}
          testResult={aiTest}
          testError={aiTestError}
          onSelectModel={(model) => updateConfig({ model })}
          error={showErrors ? errors.apiKey ?? null : null}
        />
        <ModelSelect
          model={config.model}
          onModelChange={(value) => updateConfig({ model: value })}
          baseUrl={config.baseUrl}
          onBaseUrlChange={(value) => updateConfig({ baseUrl: value })}
          baseUrlError={showErrors ? errors.baseUrl ?? null : null}
          testResult={aiTest}
        />
        <ThinkingToggle
          enabled={config.thinking}
          onChange={(next) => updateConfig({ thinking: next })}
        />
      </section>

      <section className="panel-section" aria-labelledby="section-scrape">
        <div className="section-heading">
          <span className="step-index" aria-hidden="true">
            3
          </span>
          <h2 id="section-scrape">抓取配置</h2>
        </div>
        <ScrapeConfigForm
          scrape={config.scrape}
          client={config.client}
          maxReviews={config.maxReviews}
          onScrapeChange={updateScrape}
          onClientChange={updateClient}
          onMaxReviewsChange={(value) => updateConfig({ maxReviews: value })}
          errors={errors}
          showErrors={showErrors}
        />
      </section>

      <section className="panel-section" aria-labelledby="section-trend">
        <div className="section-heading">
          <span className="step-index" aria-hidden="true">
            4
          </span>
          <h2 id="section-trend">趋势配置</h2>
        </div>
        <TrendConfigForm
          months={config.trendMonths}
          onChange={(months) => updateConfig({ trendMonths: months })}
        />
        <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
          <label className="checkbox-row" htmlFor="include-translations">
            <input
              id="include-translations"
              type="checkbox"
              checked={config.includeTranslations}
              onChange={(event) => updateConfig({ includeTranslations: event.target.checked })}
            />
            <span>
              <strong>为外文引用生成中文翻译</strong>
              <br />
              翻译由 AI 生成并标注「AI 翻译」，会增加输出 token。
            </span>
          </label>
        </div>
      </section>

      <section className="panel-section" aria-labelledby="section-local-data">
        <div className="section-heading">
          <span className="step-index" aria-hidden="true">
            5
          </span>
          <h2 id="section-local-data">本地数据</h2>
          <span className="optional">省 token</span>
        </div>
        <DataDirConfig
          value={config.dataDir}
          onChange={(value) => updateConfig({ dataDir: value })}
          applying={applyingDataDir}
          applyError={dataDirApplyError}
          applyMessage={dataDirMessage}
          onApply={onApplyDataDir}
          onUseDefault={() => updateConfig({ dataDir: '' })}
        />
        <hr className="divider-h" />
        <ReusePrompt
          reuseDataset={config.reuseDataset}
          reuseReport={config.reuseReport}
          dataset={reuseDataset}
          report={reuseReport}
          historicalReport={historicalReport}
          forceFetch={forceFetch}
          forceAnalyze={forceAnalyze}
          game={preview.result?.game ?? game}
          appid={preview.result?.appid ?? appid}
          onToggleDataset={(next) => updateConfig({ reuseDataset: next })}
          onToggleReport={(next) => updateConfig({ reuseReport: next })}
          onRefetch={onRefetch}
          onReanalyze={onReanalyze}
        />
        <hr className="divider-h" />
        {localDataPanel}
      </section>

      <ActionButtons
        onPreview={onPreview}
        onStart={onStart}
        onCancel={onCancel}
        previewLoading={preview.status === 'loading'}
        analyzing={analyzing}
        canStart={canStart}
        startDisabledReason={startDisabledReason}
        startLabel={preview.status === 'success' && preview.result ? '开始分析' : '开始分析'}
        previewLabel={preview.status === 'success' ? '重新预览' : '预览匹配数'}
      />
    </div>
  );
}
