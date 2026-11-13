import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  LIVEVIZ_STORAGE_KEY,
  readLiveVizExpanded,
  useLiveVizPref,
  writeLiveVizExpanded,
  type LiveVizStorage,
} from './useLiveVizPref';

function throwingStorage(): LiveVizStorage {
  return {
    getItem() {
      throw new Error('storage denied');
    },
    setItem() {
      throw new Error('storage denied');
    },
  };
}

describe('useLiveVizPref 存储读写', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('无键值或非法值时默认展开', () => {
    expect(readLiveVizExpanded()).toBe(true);
    window.localStorage.setItem(LIVEVIZ_STORAGE_KEY, 'abc');
    expect(readLiveVizExpanded()).toBe(true);
    window.localStorage.setItem(LIVEVIZ_STORAGE_KEY, '');
    expect(readLiveVizExpanded()).toBe(true);
  });

  it("写入 '0' / '1' 后读取一致", () => {
    expect(writeLiveVizExpanded(false)).toBe(true);
    expect(window.localStorage.getItem(LIVEVIZ_STORAGE_KEY)).toBe('0');
    expect(readLiveVizExpanded()).toBe(false);

    expect(writeLiveVizExpanded(true)).toBe(true);
    expect(window.localStorage.getItem(LIVEVIZ_STORAGE_KEY)).toBe('1');
    expect(readLiveVizExpanded()).toBe(true);
  });

  it('storage 抛错时读取回退展开、写入返回 false 且不抛错', () => {
    const storage = throwingStorage();
    expect(readLiveVizExpanded(storage)).toBe(true);
    expect(writeLiveVizExpanded(false, storage)).toBe(false);
  });

  it('storage 不可用（null）时回退展开', () => {
    expect(readLiveVizExpanded(null)).toBe(true);
    expect(writeLiveVizExpanded(false, null)).toBe(false);
  });
});

describe('useLiveVizPref hook', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('默认展开，切换后写入 localStorage', () => {
    const { result } = renderHook(() => useLiveVizPref());
    expect(result.current.expanded).toBe(true);

    act(() => result.current.toggle());
    expect(result.current.expanded).toBe(false);
    expect(window.localStorage.getItem(LIVEVIZ_STORAGE_KEY)).toBe('0');

    act(() => result.current.toggle());
    expect(result.current.expanded).toBe(true);
    expect(window.localStorage.getItem(LIVEVIZ_STORAGE_KEY)).toBe('1');
  });

  it('重新挂载时按记忆值初始化', () => {
    window.localStorage.setItem(LIVEVIZ_STORAGE_KEY, '0');
    const { result } = renderHook(() => useLiveVizPref());
    expect(result.current.expanded).toBe(false);
  });
});
