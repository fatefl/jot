// @vitest-environment jsdom
// TodoPanel 测试
//
// 覆盖：
// - parseTodoLine 解析 - [ ] / - [x] / - [X]
// - flipTodoLine 按行号 / 文本回退翻转
// - 面板用 "- [" 子串查询所有 checkbox 行（回归：曾误用正则转义串导致搜不到）
// - 非活动文件：点击 checkbox 走读盘翻转 + 串行写盘
// - 活动文件：点击 checkbox 只改内存 doc，不直接写盘

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor, cleanup } from "@testing-library/react";
import { TodoPanel, flipTodoLine, parseTodoLine } from "./TodoPanel";
import { api } from "@/lib/tauri";
import { useEditorStore, enqueueWriteFile } from "@/stores/editorStore";

vi.mock("@/lib/tauri", () => ({
  api: { searchContent: vi.fn(), readFile: vi.fn() },
}));

vi.mock("@/stores/editorStore", () => ({
  useEditorStore: {
    getState: vi.fn(() => ({ selectedPath: null, doc: "" })),
    setState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
  enqueueWriteFile: vi.fn(),
}));

const searchContent = vi.mocked(api.searchContent);
const readFile = vi.mocked(api.readFile);
const writeFile = vi.mocked(enqueueWriteFile);
const editorGetState = vi.mocked(useEditorStore.getState);
const editorSetState = vi.mocked(useEditorStore.setState);

/** 测试用：把部分状态断言为完整 EditorState（store 未挂载 React 场景） */
const fakeEditorState = (s: Partial<ReturnType<typeof useEditorStore.getState>>) =>
  s as ReturnType<typeof useEditorStore.getState>;

const match = (
  name: string,
  path: string,
  line: number,
  context: string,
  matchCount = 1,
) => ({
  name,
  path,
  line,
  context,
  matchCount,
});

beforeEach(() => {
  vi.clearAllMocks();
  editorGetState.mockImplementation(() => fakeEditorState({ selectedPath: null, doc: "" }));
});

// vitest 未开 globals，RTL 不会自动清理 DOM，需显式在测试间卸载
afterEach(cleanup);

describe("parseTodoLine", () => {
  it("解析 - [ ] / - [x] / - [X]", () => {
    expect(parseTodoLine("- [ ] 写周报")).toEqual({ checked: false, text: "写周报" });
    expect(parseTodoLine("- [x] 写周报")).toEqual({ checked: true, text: "写周报" });
    expect(parseTodoLine("- [X] 写周报")).toEqual({ checked: true, text: "写周报" });
    expect(parseTodoLine("  - [ ] 缩进项")).toEqual({ checked: false, text: "缩进项" });
  });

  it("忽略非待办行", () => {
    expect(parseTodoLine("- [Example](url)")).toBeNull();
    expect(parseTodoLine("普通文本")).toBeNull();
    expect(parseTodoLine("- [x]")).toBeNull();
  });
});

describe("flipTodoLine", () => {
  it("按行号翻转未完成→完成", () => {
    const doc = "# 标题\n\n- [ ] 写周报\n- [x] 已完成\n";
    expect(flipTodoLine(doc, 3, "写周报")).toBe(
      "# 标题\n\n- [x] 写周报\n- [x] 已完成\n",
    );
  });

  it("完成→未完成", () => {
    expect(flipTodoLine("- [x] 已完成\n", 1, "已完成")).toBe("- [ ] 已完成\n");
  });

  it("行号漂移时按文本回退搜索", () => {
    const doc = "- [ ] 任务A\n- [ ] 任务B\n";
    expect(flipTodoLine(doc, 3, "任务B")).toBe("- [ ] 任务A\n- [x] 任务B\n");
  });

  it("找不到时返回 null", () => {
    expect(flipTodoLine("nothing here", 1, "任务")).toBeNull();
  });
});

describe("TodoPanel", () => {
  it('用 "- [" 子串查询所有 checkbox 行并默认隐藏已完成', async () => {
    searchContent.mockResolvedValue([
      match("a", "/n/a.md", 2, "- [ ] 待办A"),
      match("a", "/n/a.md", 4, "- [x] 待办B"),
      match("b", "/n/b.md", 1, "- [ ] 待办C"),
    ]);
    render(
      <TodoPanel notesDir="/n" currentFilePath={null} onJump={vi.fn()} onClose={vi.fn()} />,
    );

    expect(searchContent).toHaveBeenCalledWith("/n", "- [");
    await waitFor(() => expect(screen.getByText("待办A")).toBeTruthy());
    expect(screen.getByText("待办C")).toBeTruthy();
    expect(screen.queryByText("待办B")).toBeNull();
  });

  it("非活动文件：点击 checkbox 读盘翻转并写盘", async () => {
    searchContent.mockResolvedValue([match("a", "/n/a.md", 2, "- [ ] 待办A")]);
    readFile.mockResolvedValue("- [ ] 待办A\n");
    render(
      <TodoPanel notesDir="/n" currentFilePath={null} onJump={vi.fn()} onClose={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByText("待办A")).toBeTruthy());
    fireEvent.click(screen.getByTitle("标记为完成"));

    await waitFor(() => expect(readFile).toHaveBeenCalledWith("/n/a.md"));
    expect(writeFile).toHaveBeenCalledWith("/n/a.md", "- [x] 待办A\n");
  });

  it("活动文件：点击 checkbox 只改内存 doc，不直接写盘", async () => {
    editorGetState.mockImplementation(() =>
      fakeEditorState({ selectedPath: "/n/a.md", doc: "- [ ] 待办A\n" }),
    );
    searchContent.mockResolvedValue([match("a", "/n/a.md", 1, "- [ ] 待办A")]);
    render(
      <TodoPanel notesDir="/n" currentFilePath={null} onJump={vi.fn()} onClose={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByText("待办A")).toBeTruthy());
    fireEvent.click(screen.getByTitle("标记为完成"));

    await waitFor(() => {
      expect(editorSetState).toHaveBeenCalledWith({
        doc: "- [x] 待办A\n",
        dirty: true,
      });
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
