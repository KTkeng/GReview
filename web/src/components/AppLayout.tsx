import type { ReactNode } from 'react';

interface AppLayoutProps {
  header: ReactNode;
  banners?: ReactNode;
  configPanel: ReactNode;
  children: ReactNode;
  mobileActions?: ReactNode;
  configCollapsed?: boolean;
}

export function AppLayout({
  header,
  banners,
  configPanel,
  children,
  mobileActions,
  configCollapsed = false,
}: AppLayoutProps) {
  return (
    <div className={`app-shell${configCollapsed ? ' config-collapsed' : ''}`}>
      {header}
      {banners}
      <div className="app-body">
        <aside className="config-panel" id="config-sidebar" aria-label="分析配置">
          {configPanel}
        </aside>
        <main className="workspace" id="main-workspace">
          <div className="workspace-inner">{children}</div>
        </main>
      </div>
      {mobileActions}
    </div>
  );
}
