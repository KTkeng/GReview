import type { GameMeta } from '../types';
import { gameHeaderImage } from '../lib/preview';
import { IconDownload, IconPrinter, IconRefresh } from './Icon';

interface HeaderProps {
  game: GameMeta | null;
  version: string;
  backendStatus: 'checking' | 'online' | 'offline';
  hasReport: boolean;
  onExport: () => void;
  onPrint: () => void;
  onReanalyze: () => void;
  configCollapsed?: boolean;
  onToggleConfig?: () => void;
}

export function Header({
  game,
  version,
  backendStatus,
  hasReport,
  onExport,
  onPrint,
  onReanalyze,
  configCollapsed = false,
  onToggleConfig,
}: HeaderProps) {
  const image = gameHeaderImage(game);
  const statusLabel =
    backendStatus === 'online' ? '后端在线' : backendStatus === 'offline' ? '后端离线' : '检查后端…';

  return (
    <header className="app-header">
      <span className="brand">
        <span className="brand-mark" aria-hidden="true">
          G
        </span>
        GReview
      </span>
      {onToggleConfig ? (
        <button
          type="button"
          className="btn btn-sm btn-ghost config-toggle"
          onClick={onToggleConfig}
          aria-expanded={!configCollapsed}
          aria-controls="config-sidebar"
          title={configCollapsed ? '展开配置栏' : '收起配置栏'}
        >
          <span aria-hidden="true">{configCollapsed ? '»' : '«'}</span>
          <span className="action-label">{configCollapsed ? '显示配置' : '隐藏配置'}</span>
        </button>
      ) : null}
      <span className="header-divider" aria-hidden="true" />
      <div className="header-game" aria-live="polite">
        {image ? <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
        <span className="header-game-name" title={game?.name ?? '尚未选择游戏'}>
          {game?.name ?? '尚未选择游戏'}
        </span>
      </div>
      <div className="header-actions">
        <span
          className="header-version"
          title={statusLabel}
          aria-label={statusLabel}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <span
            className={`status-dot ${backendStatus === 'online' ? 'ok' : backendStatus === 'offline' ? 'bad' : ''}`}
            aria-hidden="true"
          />
          v{version}
        </span>
        {hasReport ? (
          <>
            <button type="button" className="btn btn-sm no-print" onClick={onExport}>
              <IconDownload size={14} />
              <span className="action-label">导出 Markdown</span>
            </button>
            <button type="button" className="btn btn-sm no-print" onClick={onPrint}>
              <IconPrinter size={14} />
              <span className="action-label">打印</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost no-print"
              onClick={onReanalyze}
              title="使用相同配置重新调用 AI 分析"
            >
              <IconRefresh size={14} />
              <span className="action-label">重新分析</span>
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}
