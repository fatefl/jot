// src/stores/tabStore.cache.test.ts
// @vitest-environment jsdom
// per-tab 内容缓存：切换免读盘、脏快照恢复、关闭失效、外部修改后台回退
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { useTabStore, __resetTabSnapshotCache } from "./tabStore";
import { api } from "@/lib/tauri";

// ---- 共享可变状态（vi.mock 工厂内可访问需走 vi.hoisted） ----
const h = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  mtimes: {} as Record<string, number>,
  editorState: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/tauri", () => ({
  api: {
    readFile: vi.fn((p: string) => {
      if (!(p in h.files)) return Promise.reject(new Error("not found"));
      return Promise.resolve(h.files[p]);
    }),
    writeFile: vi.fn((p: string, c: string) => {
      h.files[p] = c;
      return Promise.resolve();
    }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/utils", () => ({
  isExternalPath: vi.fn().mockReturnValue(false),
  normPath: (p: string) => p,
}));

vi.mock("./editorStore", () => ({
  useEditorStore: {
    getState: () => h.editorState,
    setState: (partial: unknown) => {
      const next =
        typeof partial === "function"
          ? (partial as (s: Record<string, unknown>) => unknown)(h.editorState)
          : partial;
      h.editorState = { ...h.editorState, ...(next as Record<string, unknown>) };
    },
  },
  fetchMtime: (p: string) => Promise.resolve(h.mtimes[p] ?? null),
}));

vi.mock("./appStore", () => ({
  useAppStore: {
    getState: () => ({
      notesDir: "notes",
      config: { reuseTab: false },
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

function resetEditorState() {
  h.editorState = {
    doc: "",
    selectedPath: null,
    docEpoch: 0,
    dirty: false,
    lastSavedDoc: "",
    loadedMtime: null,
    cursorLine: null,
    isFormulaEditing: false,
    // 与真实 saveCurrent 对齐：公式编辑中跳过（保持 dirty），否则落盘并清脏
    saveCurrent: async () => {
      if (h.editorState.isFormulaEditing) return;
      const p = h.editorState.selectedPath as string;
      h.files[p] = h.editorState.doc as string;
      h.editorState.lastSavedDoc = h.editorState.doc;
      h.editorState.dirty = false;
    },
  };
}

const node = (p: string) => ({ name: p.split("/").pop()!, path: p, isDir: false, children: [] });

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  h.files = { "notes/a.md": "# A", "notes/b.md": "# B" };
  h.mtimes = { "notes/a.md": 1000, "notes/b.md": 1000 };
  resetEditorState();
  __resetTabSnapshotCache();
  act(() => {
    useTabStore.setState({ tabs: [], activeTabIdx: 0, closedTabs: [], recentPaths: [] });
  });
  vi.clearAllMocks();
});

describe("tabStore 内容缓存", () => {
  it("切回已访问标签：命中内存快照，不再读盘", async () => {
    await act(async () => { await useTabStore.getState().openFile(node("notes/a.md")); });
    await act(async () => { await useTabStore.getState().openFile(node("notes/b.md")); });
    expect(h.editorState.doc).toBe("# B");

    vi.mocked(api.readFile).mockClear();
    await act(async () => { await useTabStore.getState().switchTab(0); });
    await flush();

    expect(useTabStore.getState().activeTabIdx).toBe(0);
    expect(h.editorState.doc).toBe("# A");
    // mtime 一致证明磁盘未变：全程无读盘
    expect(api.readFile).not.toHaveBeenCalled();
  });

  it("高亮立即置位：切换调用同步完成后 activeTabIdx 已更新", async () => {
    await act(async () => { await useTabStore.getState().openFile(node("notes/a.md")); });
    await act(async () => { await useTabStore.getState().openFile(node("notes/b.md")); });

    // 不 await 内部异步步骤，仅观察同步段效果
    const p = useTabStore.getState().switchTab(0);
    expect(useTabStore.getState().activeTabIdx).toBe(0);
    await act(async () => { await p; });
  });

  it("脏缓冲切走再切回：内容经快照保留", async () => {
    await act(async () => { await useTabStore.getState().openFile(node("notes/a.md")); });
    await act(async () => { await useTabStore.getState().openFile(node("notes/b.md")); });

    // 模拟用户在 b 中输入
    h.editorState.doc = "# B modified";
    h.editorState.dirty = true;

    await act(async () => { await useTabStore.getState().switchTab(0); });
    // 切走时保存：磁盘拿到修改后的内容
    expect(h.files["notes/b.md"]).toBe("# B modified");

    await act(async () => { await useTabStore.getState().switchTab(1); });
    expect(h.editorState.doc).toBe("# B modified");
    expect(h.editorState.dirty).toBe(false);
  });

  it("公式编辑中保存被守卫跳过：脏快照恢复后 dirty 保留", async () => {
    await act(async () => { await useTabStore.getState().openFile(node("notes/a.md")); });
    await act(async () => { await useTabStore.getState().openFile(node("notes/b.md")); });

    h.editorState.doc = "x^2";
    h.editorState.dirty = true;
    h.editorState.isFormulaEditing = true;

    await act(async () => { await useTabStore.getState().switchTab(0); });
    h.editorState.isFormulaEditing = false;
    await act(async () => { await useTabStore.getState().switchTab(1); });

    expect(h.editorState.doc).toBe("x^2");
    expect(h.editorState.dirty).toBe(true);
    expect(h.editorState.lastSavedDoc).toBe("# B");
  });

  it("关闭标签后快照失效：重新打开走读盘", async () => {
    await act(async () => { await useTabStore.getState().openFile(node("notes/a.md")); });
    await act(async () => { await useTabStore.getState().openFile(node("notes/b.md")); });
    // 关闭非活动标签 a（其快照被丢弃）
    await act(async () => { await useTabStore.getState().closeTab(0); });
    expect(useTabStore.getState().tabs).toHaveLength(1);

    vi.mocked(api.readFile).mockClear();
    await act(async () => { await useTabStore.getState().openFileByPath("notes/a.md"); });
    expect(api.readFile).toHaveBeenCalledWith("notes/a.md");
  });

  it("干净快照恢复后检测到外部修改：后台回退读盘更新内容", async () => {
    await act(async () => { await useTabStore.getState().openFile(node("notes/a.md")); });
    await act(async () => { await useTabStore.getState().openFile(node("notes/b.md")); });

    // 外部修改 a（mtime 与内容都变）
    h.files["notes/a.md"] = "# A external";
    h.mtimes["notes/a.md"] = 2000;

    await act(async () => { await useTabStore.getState().switchTab(0); });
    // 快照即时恢复（旧内容先上屏），后台校验发现 mtime 变化 → 读盘 → 内容更新
    // （mock 环境下两步在同一微任务轮完成，直接断言终态）
    await flush();
    expect(h.editorState.doc).toBe("# A external");
    expect(h.editorState.dirty).toBe(false);
  });

  it("快照恢复后文件已被外部删除：自动关闭过期标签", async () => {
    await act(async () => { await useTabStore.getState().openFile(node("notes/a.md")); });
    await act(async () => { await useTabStore.getState().openFile(node("notes/b.md")); });

    // 外部删除 a（mtime 变化触发读盘，读盘失败）
    delete h.files["notes/a.md"];
    h.mtimes["notes/a.md"] = 2000;

    await act(async () => { await useTabStore.getState().switchTab(0); });
    await flush();

    const { tabs, activeTabIdx } = useTabStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].path).toBe("notes/b.md");
    expect(activeTabIdx).toBe(0);
    expect(h.editorState.selectedPath).toBe("notes/b.md");
  });
});
