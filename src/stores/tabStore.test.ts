// src/stores/tabStore.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { useTabStore, type TabInfo } from "./tabStore";
import { api } from "@/lib/tauri";

// Mock all dependencies
vi.mock("@/lib/tauri", () => ({
  api: {
    readFile: vi.fn().mockImplementation((p: string) => Promise.resolve(`# Content of ${p}`)),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listTree: vi.fn().mockResolvedValue({ children: [] }),
    importFiles: vi.fn().mockResolvedValue({ imported: [{ name: "imported.md", path: "notes/imported.md" }], skippedDirs: 0 }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
  },
  isExternalPath: vi.fn().mockReturnValue(false),
}));

vi.mock("./editorStore", () => ({
  useEditorStore: {
    getState: () => ({
      doc: "", selectedPath: null, docEpoch: 0, dirty: false,
      lastSavedDoc: "", mode: "wysiwyg", cursorLine: null,
    }),
    setState: vi.fn(),
  },
}));

vi.mock("./appStore", () => ({
  useAppStore: {
    getState: () => ({
      notesDir: "notes",
      config: { reuseTab: false, remoteUrl: "", authType: "", username: "", token: "", dataDir: "notes" },
    }),
    setState: vi.fn(),
  },
}));

vi.mock("./fileStore", () => ({
  useFileStore: {
    getState: () => ({
      expandTo: vi.fn(),
      loadBacklinks: vi.fn(),
      refreshTree: vi.fn().mockResolvedValue(undefined),
    }),
    setState: vi.fn(),
  },
}));

// Snapshot initial state including functions
const initial = useTabStore.getState();

beforeEach(() => {
  act(() => {
    useTabStore.setState({ ...initial }, true);
  });
  vi.clearAllMocks();
});

describe("tabStore — openFile", () => {
  it("T001: 打开新文件应新增标签，activeIdx 指向末尾", async () => {
    const node = { name: "a.md", path: "notes/a.md", isDir: false, children: [] };
    await act(async () => { await useTabStore.getState().openFile(node); });

    const { tabs, activeTabIdx } = useTabStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].path).toBe("notes/a.md");
    expect(activeTabIdx).toBe(0);
  });

  it("T002: 并发去重 — 打开同一文件两次应只有一个标签", async () => {
    const node = { name: "a.md", path: "notes/a.md", isDir: false, children: [] };

    await act(async () => { await useTabStore.getState().openFile(node); });
    await act(async () => { await useTabStore.getState().openFile(node); });

    expect(useTabStore.getState().tabs).toHaveLength(1);
  });

  it("T003: 打开两个不同文件应有 2 个标签，activeIdx 指向第二个", async () => {
    const a = { name: "a.md", path: "notes/a.md", isDir: false, children: [] };
    const b = { name: "b.md", path: "notes/b.md", isDir: false, children: [] };

    await act(async () => { await useTabStore.getState().openFile(a); });
    await act(async () => { await useTabStore.getState().openFile(b); });

    const { tabs, activeTabIdx } = useTabStore.getState();
    expect(tabs).toHaveLength(2);
    expect(activeTabIdx).toBe(1);
    expect(tabs[1].path).toBe("notes/b.md");
  });

  it("T004: 打开已存在的标签应切换到该标签", async () => {
    const a = { name: "a.md", path: "notes/a.md", isDir: false, children: [] };
    const b = { name: "b.md", path: "notes/b.md", isDir: false, children: [] };

    await act(async () => { await useTabStore.getState().openFile(a); });
    await act(async () => { await useTabStore.getState().openFile(b); });
    await act(async () => { await useTabStore.getState().openFile(a); });

    const { tabs, activeTabIdx } = useTabStore.getState();
    expect(tabs).toHaveLength(2);
    expect(activeTabIdx).toBe(0);
  });
});

describe("tabStore — 标签操作", () => {
  it("closeOthers: 应只保留指定标签", () => {
    act(() => {
      useTabStore.setState({
        tabs: [
          { path: "notes/a.md", name: "a.md", dirty: false, external: false },
          { path: "notes/b.md", name: "b.md", dirty: false, external: false },
          { path: "notes/c.md", name: "c.md", dirty: false, external: false },
        ],
        activeTabIdx: 1,
      });
      useTabStore.getState().closeOthers(1);
    });

    const { tabs, activeTabIdx } = useTabStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].path).toBe("notes/b.md");
    expect(activeTabIdx).toBe(0);
  });

  it("closeRight: 应关闭右侧所有标签", () => {
    act(() => {
      useTabStore.setState({
        tabs: [
          { path: "notes/a.md", name: "a.md", dirty: false, external: false },
          { path: "notes/b.md", name: "b.md", dirty: false, external: false },
          { path: "notes/c.md", name: "c.md", dirty: false, external: false },
        ],
        activeTabIdx: 0,
      });
      useTabStore.getState().closeRight(0);
    });

    const { tabs } = useTabStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].path).toBe("notes/a.md");
  });

  it("switchTab: 应切换 activeIdx", async () => {
    act(() => {
      useTabStore.setState({
        tabs: [
          { path: "notes/a.md", name: "a.md", dirty: false, external: false },
          { path: "notes/b.md", name: "b.md", dirty: false, external: false },
        ],
        activeTabIdx: 0,
      });
    });
    await act(async () => {
      await useTabStore.getState().switchTab(1);
    });

    expect(useTabStore.getState().activeTabIdx).toBe(1);
  });

  it("reopenTab: 应从 closedTabs 恢复", async () => {
    act(() => {
      useTabStore.setState({
        tabs: [],
        activeTabIdx: 0,
        closedTabs: ["notes/old.md"],
      });
    });

    await act(async () => {
      useTabStore.getState().reopenTab();
    });

    const { tabs, closedTabs } = useTabStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].path).toBe("notes/old.md");
    expect(closedTabs).toHaveLength(0);
  });

  it("reopenTab: 无已关闭标签时应跳过", () => {
    act(() => {
      useTabStore.setState({
        tabs: [],
        activeTabIdx: 0,
        closedTabs: [],
      });
      useTabStore.getState().reopenTab();
    });

    expect(useTabStore.getState().tabs).toHaveLength(0);
  });

  it("activeTab: 应返回当前活动标签", () => {
    act(() => {
      useTabStore.setState({
        tabs: [
          { path: "notes/a.md", name: "a.md", dirty: false, external: false },
          { path: "notes/b.md", name: "b.md", dirty: false, external: false },
        ],
        activeTabIdx: 0,
      });
    });

    expect(useTabStore.getState().activeTab()?.path).toBe("notes/a.md");
  });
});

describe("tabStore — 修复回归", () => {
  it("openFile 成功应返回 true", async () => {
    const node = { name: "a.md", path: "notes/a.md", isDir: false, children: [] };
    let ok: boolean | undefined;
    await act(async () => {
      ok = await useTabStore.getState().openFile(node);
    });
    expect(ok).toBe(true);
    expect(useTabStore.getState().tabs).toHaveLength(1);
  });

  it("openFile 读取失败应返回 false 且不新增标签", async () => {
    vi.mocked(api.readFile).mockRejectedValueOnce(new Error("gone"));
    const node = { name: "gone.md", path: "notes/gone.md", isDir: false, children: [] };
    let ok: boolean | undefined;
    await act(async () => {
      ok = await useTabStore.getState().openFile(node);
    });
    expect(ok).toBe(false);
    expect(useTabStore.getState().tabs).toHaveLength(0);
  });

  it("closeTab: 空标签时不应抛异常", async () => {
    act(() => {
      useTabStore.setState({ tabs: [], activeTabIdx: 0 });
    });
    await act(async () => {
      await useTabStore.getState().closeTab(0);
    });
    expect(useTabStore.getState().tabs).toHaveLength(0);
  });
});
