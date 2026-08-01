// src/stores/uiStore.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { useUiStore, UI_PREFS_KEY } from "./uiStore";

const initial = useUiStore.getState();

beforeEach(() => {
  act(() => {
    useUiStore.setState({ ...initial }, true);
  });
});

describe("uiStore — 面板开关", () => {
  it("toggleFocusMode 应切换专注模式", () => {
    expect(useUiStore.getState().focusMode).toBe(false);
    act(() => useUiStore.getState().toggleFocusMode());
    expect(useUiStore.getState().focusMode).toBe(true);
    act(() => useUiStore.getState().toggleFocusMode());
    expect(useUiStore.getState().focusMode).toBe(false);
  });

  it("toggleSidebar 应切换侧边栏", () => {
    expect(useUiStore.getState().sidebarVisible).toBe(true);
    act(() => useUiStore.getState().toggleSidebar());
    expect(useUiStore.getState().sidebarVisible).toBe(false);
  });

  it("closeMenu 应清空右键菜单", () => {
    act(() =>
      useUiStore.setState({
        menu: { x: 100, y: 200, entries: [] },
      })
    );
    expect(useUiStore.getState().menu).not.toBeNull();
    act(() => useUiStore.getState().closeMenu());
    expect(useUiStore.getState().menu).toBeNull();
  });

  it("showCloseDialog 应 resolve 'save'", async () => {
    const promise = act(() => useUiStore.getState().showCloseDialog());
    expect(useUiStore.getState().closeDialogOpen).toBe(true);

    // 模拟用户点击保存
    act(() => {
      useUiStore.getState().closeDialogResolve?.("save");
      useUiStore.setState({ closeDialogOpen: false, closeDialogResolve: null });
    });

    const result = await promise;
    expect(result).toBe("save");
  });

  it("showPandocDialog 应 resolve true", async () => {
    const promise = act(() => useUiStore.getState().showPandocDialog());
    expect(useUiStore.getState().pandocDialogOpen).toBe(true);

    act(() => {
      useUiStore.getState().pandocDialogResolve?.(true);
      useUiStore.setState({
        pandocDialogOpen: false,
        pandocDialogResolve: null,
      });
    });

    const result = await promise;
    expect(result).toBe(true);
  });

  it("showCloseDialog 已打开时应复用同一 Promise", async () => {
    let p1!: Promise<"save" | "discard" | "cancel">;
    let p2!: Promise<"save" | "discard" | "cancel">;
    act(() => {
      p1 = useUiStore.getState().showCloseDialog();
      p2 = useUiStore.getState().showCloseDialog();
    });
    // 第二次调用复用同一 Promise，旧 Promise 不会永久悬挂
    expect(p2).toBe(p1);

    act(() => {
      useUiStore.getState().closeDialogResolve?.("cancel");
      useUiStore.setState({ closeDialogOpen: false, closeDialogResolve: null });
    });

    await expect(p1).resolves.toBe("cancel");
    await expect(p2).resolves.toBe("cancel");
  });
});

describe("uiStore — 布局偏好持久化", () => {
  it("toggleSidebar 切换后写入 localStorage", () => {
    act(() => useUiStore.getState().toggleSidebar());
    const saved = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "{}");
    expect(saved.sidebarVisible).toBe(false);
  });

  it("面板开关切换后写入 localStorage（onClose 直接 setState 的路径同样覆盖）", () => {
    act(() => useUiStore.setState((s) => ({ outlineOpen: !s.outlineOpen })));
    let saved = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "{}");
    expect(saved.outlineOpen).toBe(true);

    // onClose 路径：直接 setState 关闭
    act(() => useUiStore.setState({ outlineOpen: false }));
    saved = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "{}");
    expect(saved.outlineOpen).toBe(false);
  });

  it("无关 setState（右键菜单）不触发写盘", () => {
    // 先清空，记录此刻是否有写盘
    localStorage.removeItem(UI_PREFS_KEY);
    act(() =>
      useUiStore.setState({
        menu: { x: 100, y: 200, entries: [] },
      })
    );
    expect(localStorage.getItem(UI_PREFS_KEY)).toBeNull();
  });

  it("启动时从 localStorage 恢复布局偏好", async () => {
    localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({
        sidebarVisible: false,
        outlineOpen: true,
        backlinksOpen: false,
        tagsOpen: true,
        frontmatterPanelOpen: false,
        todoPanelOpen: true,
      })
    );
    vi.resetModules();
    const { useUiStore: freshStore } = await import("./uiStore");
    expect(freshStore.getState().sidebarVisible).toBe(false);
    expect(freshStore.getState().outlineOpen).toBe(true);
    expect(freshStore.getState().tagsOpen).toBe(true);
    expect(freshStore.getState().todoPanelOpen).toBe(true);
    // 未被持久化的字段保持默认
    expect(freshStore.getState().focusMode).toBe(false);
    localStorage.removeItem(UI_PREFS_KEY);
  });

  it("损坏的持久化数据回退默认值", async () => {
    localStorage.setItem(UI_PREFS_KEY, "not-json{");
    vi.resetModules();
    const { useUiStore: freshStore } = await import("./uiStore");
    expect(freshStore.getState().sidebarVisible).toBe(true);
    expect(freshStore.getState().outlineOpen).toBe(false);
    localStorage.removeItem(UI_PREFS_KEY);
  });
});
