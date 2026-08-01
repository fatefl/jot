// src/stores/fileStore.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { api, type BacklinkInfo } from "@/lib/tauri";
import { useFileStore } from "./fileStore";
import { useAppStore } from "./appStore";

vi.mock("@/lib/tauri", () => ({
  api: {
    listTree: vi.fn().mockResolvedValue({
      children: [
        { name: "a.md", path: "notes/a.md", isDir: false, children: [] },
        { name: "b.md", path: "notes/b.md", isDir: false, children: [] },
        { name: "sub", path: "notes/sub", isDir: true, children: [
          { name: "c.md", path: "notes/sub/c.md", isDir: false, children: [] },
        ]},
      ],
    }),
    readFile: vi.fn().mockImplementation((p: string) => Promise.resolve(`# ${p}`)),
    writeFile: vi.fn().mockResolvedValue(undefined),
    deletePath: vi.fn().mockResolvedValue(undefined),
    createDir: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue("notes/new-note.md"),
    renamePath: vi.fn().mockResolvedValue(undefined),
    getBacklinks: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
  },
}));

// 这里的测试依赖 appStore.notesDir。简化处理：直接 set notesDir 模拟
// 实际集成测试见 integration.test.ts

const initial = useFileStore.getState();

beforeEach(() => {
  act(() => {
    useFileStore.setState({ ...initial }, true);
  });
  vi.clearAllMocks();
});

describe("fileStore — 树操作", () => {
  it("refreshTree 应从 api.listTree 加载", async () => {
    await act(async () => {
      await useFileStore.getState().refreshTree("notes");
    });
    expect(useFileStore.getState().rootChildren.length).toBeGreaterThan(0);
  });

  it("toggleCollapse 应切换折叠状态", () => {
    act(() => useFileStore.getState().toggleCollapse("notes/sub"));
    expect(useFileStore.getState().collapsed["notes/sub"]).toBe(true);
    act(() => useFileStore.getState().toggleCollapse("notes/sub"));
    expect(useFileStore.getState().collapsed["notes/sub"]).toBe(false);
  });

  it("expandTo 应展开路径上的所有祖先", () => {
    act(() => {
      useFileStore.setState({
        collapsed: { "notes": true, "notes/sub": true },
      });
      useFileStore.getState().expandTo("notes/sub/c.md");
    });
    const c = useFileStore.getState().collapsed;
    expect(c["notes"]).toBeUndefined();
    expect(c["notes/sub"]).toBeUndefined();
  });

  it("setAllCollapsed(true) 应折叠所有目录", () => {
    act(() => {
      useFileStore.setState({
        rootChildren: [
          { name: "sub", path: "notes/sub", isDir: true, children: [] },
          { name: "a.md", path: "notes/a.md", isDir: false, children: [] },
        ],
      });
      useFileStore.getState().setAllCollapsed(true);
    });
    expect(useFileStore.getState().collapsed["notes/sub"]).toBe(true);
  });

  it("cancelRename 应清除重命名路径", () => {
    act(() => useFileStore.setState({ renamingPath: "notes/a.md" }));
    act(() => useFileStore.getState().cancelRename());
    expect(useFileStore.getState().renamingPath).toBeNull();
  });
});

describe("fileStore — loadBacklinks 竞态防护", () => {
  it("过期请求的返回值不得覆盖后发请求的结果", async () => {
    // loadBacklinks 依赖 appStore.notesDir（getCollapsedKeyDir），先设置
    useAppStore.setState({ notesDir: "notes" });
    let resolveA!: (v: BacklinkInfo[]) => void;
    let resolveB!: (v: BacklinkInfo[]) => void;
    vi.mocked(api.getBacklinks)
      .mockImplementationOnce(() => new Promise((r) => { resolveA = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveB = r; }));

    const pA = useFileStore.getState().loadBacklinks("notes/a.md");
    const pB = useFileStore.getState().loadBacklinks("notes/b.md");

    // B 后发先回 → 正常写入
    resolveB([{ name: "b-src", path: "notes/b.md", line: 1, context: "" }]);
    await act(async () => { await pB; });
    expect(useFileStore.getState().backlinks[0]?.name).toBe("b-src");

    // A 先发后回，但已过期 → 不得覆盖 B 的结果
    resolveA([{ name: "a-src", path: "notes/a.md", line: 1, context: "" }]);
    await act(async () => { await pA; });
    expect(useFileStore.getState().backlinks[0]?.name).toBe("b-src");

    useAppStore.setState({ notesDir: null });
  });
});
