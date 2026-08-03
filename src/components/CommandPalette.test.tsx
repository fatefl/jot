// @vitest-environment jsdom
// CommandPalette 组件测试
//
// 覆盖：
// - 组件渲染：搜索输入、遮罩层
// - 最近文件列表
// - 文件名搜索过滤（中英文、大小写、前缀优先排序）
// - 键盘导航（Enter / Escape）
// - 鼠标交互（点击结果项）
// - 结果上限 10 条
// - 内容搜索防抖接口（input 触发）

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { CommandPalette, contentScore, highlight } from "./CommandPalette";
import { api } from "@/lib/tauri";
import type { SearchMatch, TreeNode } from "@/lib/tauri";

// Mock api.searchContent
vi.mock("@/lib/tauri", () => ({
  api: {
    searchContent: vi.fn().mockResolvedValue([]),
  },
}));

// jsdom 不支持 scrollIntoView，全局 mock
beforeEach(() => {
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  }
  // 重设默认实现：防止任何时序下 mock 被清成无实现（调用返回 undefined），
  // 导致组件 300ms 防抖定时器回调触发未处理异常
  vi.mocked(api.searchContent).mockResolvedValue([]);
});

function makeNode(
  path: string,
  name: string,
  isDir: boolean,
  children: TreeNode[] = [],
): TreeNode {
  return { path, name, isDir, children };
}

function sampleTree(): TreeNode[] {
  return [
    makeNode("/notes", "notes", true, [
      makeNode("/notes/readme.md", "readme.md", false),
      makeNode("/notes/设计文档.md", "设计文档.md", false),
      makeNode("/notes/projects", "projects", true, [
        makeNode("/notes/projects/todo.md", "todo.md", false),
        makeNode("/notes/projects/api-design.md", "api-design.md", false),
      ]),
      makeNode("/notes/journal", "journal", true, []),
    ]),
  ];
}

function renderPalette(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  return render(
    <CommandPalette
      open={true}
      notes={sampleTree()}
      notesDir="/notes"
      recentPaths={[]}
      onOpenFile={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

function inputEl(container: HTMLElement) {
  return container.querySelector("input") as HTMLInputElement | null;
}

function overlayEl(container: HTMLElement) {
  return container.querySelector(".z-\\[110\\]") as HTMLElement | null;
}

/** 获取结果列表中所有按钮 */
function resultBtns(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll(".overflow-y-auto button"),
  ) as HTMLButtonElement[];
}

/** 查找结果按钮中文本包含 needle 的 */
function findResultBtn(container: HTMLElement, needle: string): HTMLButtonElement | null {
  return resultBtns(container).find((b) => b.textContent?.includes(needle)) ?? null;
}

function emptyMsgEl(container: HTMLElement) {
  return container.querySelector(".overflow-y-auto .text-center") as HTMLElement | null;
}

describe("CommandPalette — 渲染", () => {
  it("open=true 时渲染面板", () => {
    const { container } = renderPalette();
    expect(overlayEl(container)).not.toBeNull();
  });

  it("open=false 时不渲染", () => {
    const { container } = renderPalette({ open: false });
    expect(overlayEl(container)).toBeNull();
  });

  it("搜索输入框存在", () => {
    const { container } = renderPalette();
    const inp = inputEl(container);
    expect(inp).not.toBeNull();
    expect(inp!.placeholder).toContain("搜索");
  });

  it("点击遮罩层关闭", () => {
    const onClose = vi.fn();
    const { container } = renderPalette({ onClose });
    fireEvent.click(overlayEl(container)!);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CommandPalette — 最近文件", () => {
  it("无查询时显示最近文件", () => {
    const { container } = renderPalette({
      recentPaths: ["/notes/readme.md", "/notes/设计文档.md"],
    });
    const btns = resultBtns(container);
    expect(btns.length).toBeGreaterThanOrEqual(2);
  });

  it("不在树中的最近文件不显示", () => {
    const { container } = renderPalette({
      recentPaths: ["/notes/nonexistent.md"],
    });
    const btns = resultBtns(container);
    expect(btns.length).toBe(0);
  });
});

describe("CommandPalette — 文件名搜索", () => {
  it("输入查询过滤文件名", () => {
    const { container } = renderPalette();
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "readme" } });
    expect(findResultBtn(container, "readme.md")).not.toBeNull();
  });

  it("无匹配时显示提示", () => {
    const { container } = renderPalette();
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "zzzznotexist" } });
    const msg = emptyMsgEl(container);
    expect(msg).not.toBeNull();
    expect(msg!.textContent).toContain("无匹配");
  });

  it("不区分大小写", () => {
    const { container } = renderPalette();
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "README" } });
    expect(findResultBtn(container, "readme.md")).not.toBeNull();
  });

  it("中文搜索", () => {
    const { container } = renderPalette();
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "设计" } });
    expect(findResultBtn(container, "设计文档.md")).not.toBeNull();
  });
});

describe("CommandPalette — 排序 & 上限", () => {
  it("前缀匹配优先于包含匹配", () => {
    // "api-design.md" 包含 "design" (score=140)
    // "design.md" 前缀匹配 "design" (score=180) → 排前面
    const notes: TreeNode[] = [
      makeNode("/x", "x", true, [
        makeNode("/x/api-design.md", "api-design.md", false),
        makeNode("/x/design.md", "design.md", false),
      ]),
    ];
    const { container } = render(
      <CommandPalette
        open={true}
        notes={notes}
        notesDir="/x"
        recentPaths={[]}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "design" } });

    const btns = resultBtns(container);
    const idxPrefix = btns.findIndex((b) => b.textContent?.includes("design.md") && !b.textContent?.includes("api-design"));
    const idxInclude = btns.findIndex((b) => b.textContent?.includes("api-design.md"));
    // 前缀匹配 (180) 应排在包含匹配 (140) 前面
    expect(idxPrefix).toBeLessThan(idxInclude);
  });

  it("上限 10 条", () => {
    const many: TreeNode[] = [];
    for (let i = 1; i <= 20; i++) {
      many.push(makeNode(`/n/t${String(i).padStart(2, "0")}.md`, `t${String(i).padStart(2, "0")}.md`, false));
    }
    const notes: TreeNode[] = [makeNode("/n", "n", true, many)];
    const { container } = render(
      <CommandPalette
        open={true}
        notes={notes}
        notesDir="/n"
        recentPaths={[]}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "t" } });
    expect(resultBtns(container).length).toBeLessThanOrEqual(10);
  });
});

describe("CommandPalette — 键盘导航", () => {
  it("Enter 打开选中文件并关闭", () => {
    const onOpenFile = vi.fn();
    const onClose = vi.fn();
    const { container } = renderPalette({
      recentPaths: ["/notes/readme.md"],
      onOpenFile,
      onClose,
    });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith("/notes/readme.md", undefined);
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape 关闭", () => {
    const onClose = vi.fn();
    const { container } = renderPalette({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("无结果时 Enter 不触发", () => {
    const onOpenFile = vi.fn();
    renderPalette({ onOpenFile }); // empty recentPaths → 0 results
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("ArrowDown/ArrowUp 不抛错", () => {
    const { container } = renderPalette({
      recentPaths: ["/notes/readme.md"],
    });
    expect(() => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
      fireEvent.keyDown(window, { key: "ArrowUp" });
    }).not.toThrow();
  });
});

describe("CommandPalette — 鼠标交互", () => {
  it("点击结果项打开文件并关闭", () => {
    const onOpenFile = vi.fn();
    const onClose = vi.fn();
    const { container } = renderPalette({
      recentPaths: ["/notes/readme.md"],
      onOpenFile,
      onClose,
    });
    const btn = findResultBtn(container, "readme.md")!;
    fireEvent.click(btn);
    expect(onOpenFile).toHaveBeenCalledWith("/notes/readme.md", undefined);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CommandPalette — 内容搜索", () => {
  it("单字符输入触发内容搜索（中文刚需）", () => {
    vi.useFakeTimers();
    const { container } = renderPalette();
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "记" } });
    act(() => { vi.advanceTimersByTime(200); });
    expect(api.searchContent).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("文件名匹配优先于内容匹配，内容按 matchCount 排序", async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchContent).mockResolvedValue([
      { name: "alpha", path: "/notes/alpha.md", line: 3, context: "git 使用记录", matchCount: 5 },
      { name: "beta", path: "/notes/beta.md", line: 1, context: "git 说明", matchCount: 1 },
    ]);
    const notes: TreeNode[] = [
      makeNode("/notes", "notes", true, [
        makeNode("/notes/git.md", "git.md", false),
        makeNode("/notes/alpha.md", "alpha.md", false),
        makeNode("/notes/beta.md", "beta.md", false),
      ]),
    ];
    const { container } = render(
      <CommandPalette
        open={true}
        notes={notes}
        notesDir="/notes"
        recentPaths={[]}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "git" } });
    act(() => { vi.advanceTimersByTime(200); });
    await act(async () => { await Promise.resolve(); }); // flush mock promise

    const btns = resultBtns(container);
    expect(btns[0].textContent).toContain("git.md"); // 文件名命中 180 第一
    const texts = btns.map((b) => b.textContent ?? "");
    const idxAlpha = texts.findIndex((t) => t.includes("alpha.md"));
    const idxBeta = texts.findIndex((t) => t.includes("beta.md"));
    expect(idxAlpha).toBeGreaterThanOrEqual(0);
    expect(idxBeta).toBeGreaterThanOrEqual(0);
    expect(idxAlpha).toBeLessThan(idxBeta); // matchCount 5 → 50 分 > 1 → 10 分
    vi.useRealTimers();
  });

  it("内容结果上下文关键词高亮", async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchContent).mockResolvedValue([
      { name: "alpha", path: "/notes/alpha.md", line: 1, context: "git 使用记录 git", matchCount: 1 },
    ]);
    const notes: TreeNode[] = [
      makeNode("/notes", "notes", true, [
        makeNode("/notes/alpha.md", "alpha.md", false),
      ]),
    ];
    const { container } = render(
      <CommandPalette
        open={true}
        notes={notes}
        notesDir="/notes"
        recentPaths={[]}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "git" } });
    act(() => { vi.advanceTimersByTime(200); });
    await act(async () => { await Promise.resolve(); });

    const marks = container.querySelectorAll("mark");
    expect(marks.length).toBe(2);
    expect(marks[0].textContent).toBe("git");
    vi.useRealTimers();
  });

  it("过期内容搜索响应被丢弃", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (v: SearchMatch[]) => void;
    vi.mocked(api.searchContent)
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockResolvedValueOnce([
        { name: "fresh", path: "/notes/fresh.md", line: 1, context: "新查询结果", matchCount: 1 },
      ]);
    const notes: TreeNode[] = [
      makeNode("/notes", "notes", true, [
        makeNode("/notes/fresh.md", "fresh.md", false),
      ]),
    ];
    const { container } = render(
      <CommandPalette
        open={true}
        notes={notes}
        notesDir="/notes"
        recentPaths={[]}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "git" } });
    act(() => { vi.advanceTimersByTime(200); }); // 第 1 次调用，promise 挂起
    fireEvent.change(inp, { target: { value: "gita" } });
    act(() => { vi.advanceTimersByTime(200); }); // 第 2 次调用
    await act(async () => { await Promise.resolve(); }); // 第 2 次结果渲染

    // 第 1 次响应现在才到 → id 过期 → 丢弃
    resolveFirst([
      { name: "stale", path: "/notes/stale.md", line: 1, context: "旧查询结果", matchCount: 1 },
    ]);
    await act(async () => { await Promise.resolve(); });

    const btns = resultBtns(container);
    expect(btns.some((b) => b.textContent?.includes("stale"))).toBe(false);
    expect(btns.some((b) => b.textContent?.includes("fresh"))).toBe(true);
    vi.useRealTimers();
  });
});

describe("CommandPalette — 纯函数", () => {
  it("contentScore 钳位边界", () => {
    // matchCount=1, line=200 → 10 - 20 = -10 → 钳到 0
    expect(contentScore(1, 200)).toBe(0);
    // matchCount=10, line=1 → 100 - 0 = 100 → 钳到 90
    expect(contentScore(10, 1)).toBe(90);
    // 正常区间
    expect(contentScore(5, 3)).toBe(50); // 10*5 - 0 = 50
  });

  it("highlight 无匹配返回原文", () => {
    const nodes = highlight("没有匹配的行", "xyz");
    expect(nodes.length).toBe(1);
    expect(nodes[0]).toBe("没有匹配的行");
  });

  it("highlight 大小写不敏感且多次命中", () => {
    // "AaA" 中 3 个字符全部命中 q="a"（大小写不敏感）
    const nodes = highlight("AaA", "a");
    const marks = nodes.filter((n) => typeof n !== "string");
    expect(marks.length).toBe(3);
  });
});
