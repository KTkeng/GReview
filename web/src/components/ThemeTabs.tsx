import { useRef, useState, type KeyboardEvent } from 'react';
import type { AiInsights, Theme } from '../types';
import { ThemeCard } from './ThemeCard';

interface ThemeTabsProps {
  ai: AiInsights;
  knownReviewIds?: Set<string>;
  onJumpToReview?: (reviewId: string) => void;
}

interface TabDefinition {
  key: string;
  label: string;
  themes: Theme[];
  emptyText: string;
}

export function ThemeTabs({ ai, knownReviewIds, onJumpToReview }: ThemeTabsProps) {
  const tabs: TabDefinition[] = [
    {
      key: 'appeal',
      label: '吸引点',
      themes: ai.appealPoints ?? [],
      emptyText: 'AI 未归纳出明确的吸引点，或相关主题未通过证据校验。',
    },
    {
      key: 'friction',
      label: '劝退点',
      themes: ai.frictionPoints ?? [],
      emptyText: 'AI 未归纳出明确的劝退点，或相关主题未通过证据校验。',
    },
    {
      key: 'expectation',
      label: '预期落差',
      themes: ai.expectationGaps ?? [],
      emptyText: '本次样本中没有明显的预期落差主题。',
    },
    {
      key: 'update',
      label: '更新影响',
      themes: ai.updateImpact ?? [],
      emptyText: '本次样本中没有明显与版本更新相关的主题。',
    },
  ];

  const [active, setActive] = useState(tabs[0].key);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (index + delta + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    setActive(nextTab.key);
    tabRefs.current[nextTab.key]?.focus();
  };

  return (
    <div>
      <div className="tabs" role="tablist" aria-label="AI 归纳分组">
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            ref={(element) => {
              tabRefs.current[tab.key] = element;
            }}
            type="button"
            role="tab"
            id={`theme-tab-${tab.key}`}
            className="tab"
            aria-selected={active === tab.key}
            aria-controls={`theme-panel-${tab.key}`}
            tabIndex={active === tab.key ? 0 : -1}
            onClick={() => setActive(tab.key)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {tab.label}
            <span className="count">{tab.themes.length}</span>
          </button>
        ))}
      </div>

      {/* 所有分组始终渲染：屏幕上仅显示当前 Tab，打印时展示全部分组 */}
      {tabs.map((tab) => (
        <div
          key={tab.key}
          role="tabpanel"
          id={`theme-panel-${tab.key}`}
          aria-labelledby={`theme-tab-${tab.key}`}
          className={`tab-panel${active === tab.key ? ' active' : ''}`}
        >
          <h3 className="print-only tab-print-title">{tab.label}</h3>
          {tab.themes.length > 0 ? (
            <div className="theme-list">
              {tab.themes.map((theme, index) => (
                <ThemeCard
                  key={`${theme.id ?? theme.name}-${index}`}
                  theme={theme}
                  knownReviewIds={knownReviewIds}
                  onJumpToReview={onJumpToReview}
                />
              ))}
            </div>
          ) : (
            <div className="empty-inline">{tab.emptyText}</div>
          )}
        </div>
      ))}
    </div>
  );
}
