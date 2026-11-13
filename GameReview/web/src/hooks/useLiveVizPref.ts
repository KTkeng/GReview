/**
 * 实时可视化展开/收起偏好。
 *
 * - 默认展开（用户第一次看到的是分析中状态，实时可视化是核心反馈）；
 * - 用户手动切换后写入 localStorage（键 greview.liveviz.expanded，值 '1'/'0'）；
 * - localStorage 不可用或值非法时回退默认展开，绝不抛错；
 * - 存储不可用时切换仍作用于当前会话（React 内存状态）。
 */

import { useCallback, useState } from 'react';

export const LIVEVIZ_STORAGE_KEY = 'greview.liveviz.expanded';

export interface LiveVizStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): LiveVizStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    // 隐私模式 / 安全策略下访问 localStorage 本身可能抛错。
    return null;
  }
}

/** 读取偏好；仅接受 '1' / '0'，缺失或非法值回退为展开。 */
export function readLiveVizExpanded(
  storage: LiveVizStorage | null = defaultStorage(),
): boolean {
  if (!storage) return true;
  try {
    const raw = storage.getItem(LIVEVIZ_STORAGE_KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
    return true;
  } catch {
    return true;
  }
}

/** 写入偏好；返回是否成功持久化（失败时由调用方保持会话内状态）。 */
export function writeLiveVizExpanded(
  expanded: boolean,
  storage: LiveVizStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LIVEVIZ_STORAGE_KEY, expanded ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

export interface LiveVizPref {
  expanded: boolean;
  setExpanded: (next: boolean) => void;
  toggle: () => void;
  /** 最近一次写入是否成功；存储不可用时为 false（仅作诊断，不阻塞交互）。 */
  persisted: boolean;
}

export function useLiveVizPref(): LiveVizPref {
  const [expanded, setExpandedState] = useState<boolean>(() => readLiveVizExpanded());
  const [persisted, setPersisted] = useState(true);

  const setExpanded = useCallback((next: boolean) => {
    setExpandedState(next);
    setPersisted(writeLiveVizExpanded(next));
  }, []);

  const toggle = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded, setExpanded]);

  return { expanded, setExpanded, toggle, persisted };
}
