import { Switch } from './ui';

interface ThinkingToggleProps {
  enabled: boolean;
  onChange: (next: boolean) => void;
}

export function ThinkingToggle({ enabled, onChange }: ThinkingToggleProps) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <div className="switch-row">
        <div className="switch-copy">
          <span className="switch-label" id="thinking-label">
            深度思考（thinking）
          </span>
          <span className="switch-desc">
            默认关闭。开启后本次任务全部 AI 调用启用思考模式。
          </span>
        </div>
        <Switch checked={enabled} onChange={onChange} label="深度思考（thinking）" />
      </div>
      {enabled ? (
        <div className="notice warning" role="status">
          <span className="notice-icon" aria-hidden="true">
            !
          </span>
          <div>深度思考会显著增加耗时与费用（更长输出与 reasoning tokens，可能更深入）。</div>
        </div>
      ) : null}
    </div>
  );
}
