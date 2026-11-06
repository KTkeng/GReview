import { validateDataDir } from '../lib/validation';
import { FieldError } from './ui';

interface DataDirConfigProps {
  value: string;
  onChange: (value: string) => void;
  applying: boolean;
  applyError: string | null;
  applyMessage: string | null;
  onApply: () => void;
  onUseDefault: () => void;
}

export function DataDirConfig({
  value,
  onChange,
  applying,
  applyError,
  applyMessage,
  onApply,
  onUseDefault,
}: DataDirConfigProps) {
  const localError = validateDataDir(value);
  const error = applyError ?? localError;

  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label htmlFor="data-dir-input">数据目录</label>
      <div className="input-row">
        <input
          id="data-dir-input"
          className="input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="默认 ./data（工程根目录）"
          aria-invalid={Boolean(error)}
          aria-describedby="data-dir-hint"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="btn"
          onClick={onApply}
          disabled={applying || Boolean(localError) || !value.trim()}
        >
          {applying ? <span className="spinner" aria-hidden="true" /> : null}
          {applying ? '校验中' : '校验并应用'}
        </button>
      </div>
      <p id="data-dir-hint" className="field-hint">
        留空使用默认目录（工程根下 ./data）。自定义目录必须是绝对路径，不能位于 node_modules、.git
        等源码目录。
      </p>
      {error ? <FieldError>{error}</FieldError> : null}
      {applyMessage ? <p className="field-hint" style={{ color: 'var(--positive-light)' }}>{applyMessage}</p> : null}
      {value ? (
        <button type="button" className="btn-link" style={{ alignSelf: 'flex-start' }} onClick={onUseDefault}>
          使用默认目录
        </button>
      ) : null}
    </div>
  );
}
