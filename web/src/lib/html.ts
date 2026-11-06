/**
 * HTML 转义工具（F5）。
 *
 * ECharts 的 HTML tooltip formatter 返回的是原始 HTML 字符串，不经过 React
 * 的自动转义。主题名来自 AI（可能被评论中的提示注入污染）、period 来自后端
 * 数据，直接拼接会形成同源 XSS 面；攻击者可借此读取 localStorage 中的
 * DeepSeek Key 或调用本地写接口。所有进入 tooltip HTML 的动态文本都必须先
 * 经过 escapeHtml。
 */

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
}
