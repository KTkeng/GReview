import { useState } from 'react';
import type { AiTestResult } from '../types';
import { IconEye, IconEyeOff } from './Icon';
import { FieldError } from './ui';

interface APIKeyInputProps {
  value: string;
  onChange: (value: string) => void;
  onTest: () => void;
  onClear: () => void;
  testing: boolean;
  testResult: AiTestResult | null;
  testError: string | null;
  onSelectModel?: (model: string) => void;
  error: string | null;
}

export function APIKeyInput({
  value,
  onChange,
  onTest,
  onClear,
  testing,
  testResult,
  testError,
  onSelectModel,
  error,
}: APIKeyInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="field">
      <label htmlFor="api-key">DeepSeek API Key</label>
      <div className="input-with-toggle">
        <input
          id="api-key"
          className="input"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="sk-…"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby="api-key-hint"
        />
        <button
          type="button"
          className="input-toggle"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={visible ? '隐藏 API Key' : '显示 API Key'}
          aria-pressed={visible}
          title={visible ? '隐藏 API Key' : '显示 API Key'}
        >
          {visible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
        </button>
      </div>
      <p id="api-key-hint" className="key-hint">
        仅保存在本机浏览器 localStorage，通过 X-DeepSeek-Key 请求头传输；后端不持久化，任务结束后立即清除。
      </p>
      <div className="key-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onTest}
          disabled={testing || !value.trim()}
        >
          {testing ? <span className="spinner" aria-hidden="true" /> : null}
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClear} disabled={!value}>
          清除 Key
        </button>
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
      {testError ? (
        <div className="test-result fail" role="alert">
          {testError}
        </div>
      ) : null}
      {testResult ? (
        <div className="test-result ok" aria-live="polite">
          <div className="inline-flex">
            <span aria-hidden="true">✓</span>
            连接成功 · 延迟 {testResult.latencyMs} ms
          </div>
          {testResult.models.length > 0 ? (
            <>
              <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>可用模型：</div>
              <div className="model-chips">
                {testResult.models.map((model) => (
                  <button
                    key={model}
                    type="button"
                    onClick={() => onSelectModel?.(model)}
                    title="使用该模型"
                  >
                    {model}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>未返回模型列表</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
