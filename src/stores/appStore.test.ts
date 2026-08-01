// src/stores/appStore.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { useAppStore, BACKOFF_MS, SYNC_INTERVAL_MS } from "./appStore";

// Mock 外部 store（fileStore, tabStore, uiStore）
vi.mock("./fileStore", () => ({
  useFileStore: {
    getState: () => ({
      refreshTree: vi.fn().mockResolvedValue(undefined),
      loadTags: vi.fn(),
    }),
    setState: vi.fn(),
  },
}));
vi.mock("./tabStore", () => ({
  useTabStore: {
    getState: () => ({
      reloadOpenFile: vi.fn().mockResolvedValue(undefined),
      tabs: [],
      activeTabIdx: 0,
      openFile: vi.fn(),
      openFileByPath: vi.fn(),
    }),
    setState: vi.fn(),
  },
}));
vi.mock("./uiStore", () => ({
  useUiStore: {
    getState: () => ({ authSnoozed: false }),
    setState: vi.fn(),
  },
}));

const initial = {
  defaultDir: null,
  notesDir: null,
  config: null,
  showOnboarding: false,
  initializing: true,
  pandocAvailable: true,
  syncState: "local" as const,
  syncError: null,
  git: null,
  gitAvailable: true,
  pending: 0,
  lastSyncAt: null,
  conflictBanner: null,
  syncing: false,
  failCount: 0,
  lastSyncAttempt: 0,
};

beforeEach(() => {
  act(() => {
    useAppStore.setState({ ...initial });
  });
});

describe("appStore — _computeBackoff", () => {
  it("0 次失败应返回标准同步间隔", () => {
    expect(useAppStore.getState()._computeBackoff(0)).toBe(SYNC_INTERVAL_MS);
  });

  it("1 次失败应返回 1 分钟退避", () => {
    expect(useAppStore.getState()._computeBackoff(1)).toBe(BACKOFF_MS[0]);
  });

  it("2 次失败应返回 5 分钟退避", () => {
    expect(useAppStore.getState()._computeBackoff(2)).toBe(BACKOFF_MS[1]);
  });

  it("3 次失败应返回 15 分钟退避", () => {
    expect(useAppStore.getState()._computeBackoff(3)).toBe(BACKOFF_MS[2]);
  });

  it("超过退避数组长度应返回最大退避", () => {
    expect(useAppStore.getState()._computeBackoff(10)).toBe(BACKOFF_MS[2]);
  });
});

describe("appStore — syncNow", () => {
  it("无 notesDir 应返回错误", async () => {
    let result: any;
    await act(async () => {
      result = await useAppStore.getState().syncNow();
    });
    expect(result!.ok).toBe(false);
    expect(result!.message).toContain("数据目录");
  });

  it("无 remoteUrl 应返回错误", async () => {
    act(() => {
      useAppStore.setState({
        notesDir: "notes",
        config: { dataDir: "notes", remoteUrl: "", authType: "", username: "", token: "", reuseTab: false },
      });
    });
    let result: any;
    await act(async () => {
      result = await useAppStore.getState().syncNow();
    });
    expect(result!.ok).toBe(false);
    expect(result!.message).toContain("远程仓库");
  });

  it("并发保护：syncing 时第二次调用应返回", async () => {
    act(() => {
      useAppStore.setState({
        notesDir: "notes",
        config: { dataDir: "notes", remoteUrl: "https://git.example.com/repo", authType: "token", username: "", token: "x", reuseTab: false },
        syncing: true,
      });
    });
    let result: any;
    await act(async () => {
      result = await useAppStore.getState().syncNow();
    });
    expect(result!.ok).toBe(false);
    expect(result!.message).toContain("进行中");
  });
});
