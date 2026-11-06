import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeCard } from './ThemeCard';
import type { Theme } from '../types';

describe('ThemeCard sentiment labels', () => {
  it('labels mixed sentiment in Chinese', () => {
    const theme: Theme = {
      id: 't1',
      name: '争议主题',
      mentions: 1,
      summary: '玩家评价褒贬不一',
      evidenceIds: [],
      quotes: [],
      sentiment: 'mixed',
    };
    render(<ThemeCard theme={theme} />);
    expect(screen.getByText('褒贬不一')).toBeTruthy();
  });
});
