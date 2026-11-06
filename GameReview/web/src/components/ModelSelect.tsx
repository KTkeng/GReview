import type { AiTestResult } from '../types';
import { MODEL_FALLBACKS } from '../lib/defaults';
import { FieldError } from './ui';

interface ModelSelectProps {
  model: string;
  onModelChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  baseUrlError: string | null;
  testResult: AiTestResult | null;
}

export function ModelSelect({
  model,
  onModelChange,
  baseUrl,
  onBaseUrlChange,
  baseUrlError,
  testResult,
}: ModelSelectProps) {
  const models = Array.from(
    new Set([...(testResult?.models ?? []), ...MODEL_FALLBACKS]),
  );

  return (
    <div className="field">
      <label htmlFor="model-input">模型</label>
      <input
        id="model-input"
        className="input"
        value={model}
        onChange={(event) => onModelChange(event.target.value)}
        placeholder="deepseek-flash"
        list="model-suggestions"
        spellCheck={false}
        autoComplete="off"
      />
      <datalist id="model-suggestions">
        {models.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
      <p className="field-hint">
        默认 deepseek-flash；测试连接后可点击返回的模型名快速切换，也支持手动输入。
      </p>
      <details>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 11,
            color: 'var(--text-muted)',
            listStyle: 'none',
            padding: '2px 0',
          }}
        >
          高级：AI Base URL
        </summary>
        <div style={{ marginTop: 6 }}>
          <input
            id="base-url-input"
            className="input"
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder="https://api.deepseek.com"
            aria-label="AI Base URL"
            aria-invalid={Boolean(baseUrlError)}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="field-hint">用于兼容其他 OpenAI 协议服务，仅支持 http/https。</p>
          {baseUrlError ? <FieldError>{baseUrlError}</FieldError> : null}
        </div>
      </details>
    </div>
  );
}
