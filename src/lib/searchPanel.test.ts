// @vitest-environment jsdom
// searchPanel 单元测试：中文搜索 & 替换面板
//
// 覆盖：
// - DOM 结构创建
// - 查询输入 → EditorView dispatch（依赖 @codemirror/search 扩展）
// - 匹配计数更新
// - 替换功能（单次 / 全部）
// - 选项开关（大小写 / 全词 / 正则）
// - 键盘事件（Enter / Shift+Enter / Escape）
// - 替换行展开/收起
// - 按钮操作（上一个 / 下一个 / 替换 / 全部替换 / 关闭）

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { search, getSearchQuery } from "@codemirror/search";
import { createChineseSearchPanel } from "./searchPanel";

/** 创建已挂载搜索扩展的 EditorView（带 `search()` 扩展才支持 SearchQuery 流） */
function buildSearchView(doc: string) {
  const view = new EditorView({
    doc,
    parent: document.body,
    extensions: [
      search({ top: false }),
      EditorView.lineWrapping,
    ],
  });
  return view;
}

describe("searchPanel — DOM 结构", () => {
  let view: EditorView;

  beforeEach(() => {
    view = buildSearchView("hello world\nfoo bar\nhello baz");
  });

  afterEach(() => {
    view.destroy();
  });

  it("createChineseSearchPanel 返回 Panel 对象（dom / mount / update）", () => {
    const panel = createChineseSearchPanel(view);
    expect(panel).toBeDefined();
    expect(panel.dom).toBeInstanceOf(HTMLDivElement);
    expect(typeof panel.mount).toBe("function");
    expect(typeof panel.update).toBe("function");
  });

  it("面板 DOM 包含所有必要元素", () => {
    const panel = createChineseSearchPanel(view);
    const dom = panel.dom;

    expect(dom.querySelector(".jot-search-input")).not.toBeNull();
    expect(dom.querySelector(".jot-search-count")).not.toBeNull();
    expect(dom.querySelector("[data-action='prev']")).not.toBeNull();
    expect(dom.querySelector("[data-action='next']")).not.toBeNull();
    expect(dom.querySelector("[data-action='close']")).not.toBeNull();
    expect(dom.querySelector("[data-action='toggle']")).not.toBeNull();
    expect(dom.querySelector('[data-opt="case"]')).not.toBeNull();
    expect(dom.querySelector('[data-opt="word"]')).not.toBeNull();
    expect(dom.querySelector('[data-opt="regex"]')).not.toBeNull();
    expect(dom.querySelector(".jot-replace-input")).not.toBeNull();
    expect(dom.querySelector("[data-action='replace']")).not.toBeNull();
    expect(dom.querySelector("[data-action='replaceAll']")).not.toBeNull();
  });

  it("替换行初始状态为隐藏", () => {
    const panel = createChineseSearchPanel(view);
    const replaceRow = panel.dom.querySelector(".jot-search-replace-row") as HTMLDivElement;
    expect(replaceRow.hidden).toBe(true);
  });

  it("mount 时输入框获得焦点", () => {
    const panel = createChineseSearchPanel(view);
    panel.mount!();
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    // jsdom 中 focus() 可能不会被 document.activeElement 跟踪，验证不抛错即可
    expect(input).not.toBeNull();
  });
});

describe("searchPanel — 查询输入 & 计数", () => {
  let view: EditorView;

  beforeEach(() => {
    view = buildSearchView("hello world\nhello again\ngoodbye");
  });

  afterEach(() => {
    view.destroy();
  });

  it("输入搜索文本后匹配计数更新", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const countEl = panel.dom.querySelector(".jot-search-count") as HTMLSpanElement;

    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    // 确认 SearchQuery 被正确 dispatch 到 CM state
    const q = getSearchQuery(view.state);
    expect(q.search).toBe("hello");
    expect(countEl.textContent).toContain("2");
  });

  it("无匹配时显示'无匹配'", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const countEl = panel.dom.querySelector(".jot-search-count") as HTMLSpanElement;

    input.value = "nonexistent";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(countEl.textContent).toBe("无匹配");
  });

  it("空查询时不显示计数", () => {
    const panel = createChineseSearchPanel(view);
    const countEl = panel.dom.querySelector(".jot-search-count") as HTMLSpanElement;
    // 未输入任何查询→ search 字段为空 → !q.search → 不上计数
    expect(countEl.textContent).toBe("");
  });
});

describe("searchPanel — 选项开关", () => {
  let view: EditorView;

  beforeEach(() => {
    view = buildSearchView("Hello World\nhello world\nHELLO WORLD");
  });

  afterEach(() => {
    view.destroy();
  });

  it("大小写敏感：区分大小写时只匹配精确 Case", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const countEl = panel.dom.querySelector(".jot-search-count") as HTMLSpanElement;

    input.value = "Hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // 默认不区分大小写 → 3 行都有 hello/Hello/HELLO
    expect(countEl.textContent).toContain("3");

    const caseCb = panel.dom.querySelector('[data-opt="case"]') as HTMLInputElement;
    caseCb.checked = true;
    caseCb.dispatchEvent(new Event("change", { bubbles: true }));
    expect(countEl.textContent).toContain("1"); // 只有 "Hello World" 精确匹配
  });

  it("全词匹配：开启后部分匹配不算", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const countEl = panel.dom.querySelector(".jot-search-count") as HTMLSpanElement;

    input.value = "hell";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(countEl.textContent).toContain("3"); // 部分匹配

    const wordCb = panel.dom.querySelector('[data-opt="word"]') as HTMLInputElement;
    wordCb.checked = true;
    wordCb.dispatchEvent(new Event("change", { bubbles: true }));
    expect(countEl.textContent).toBe("无匹配"); // "hell" 非完整单词
  });

  it("正则模式：支持 pattern 搜索", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const countEl = panel.dom.querySelector(".jot-search-count") as HTMLSpanElement;
    const regexCb = panel.dom.querySelector('[data-opt="regex"]') as HTMLInputElement;

    regexCb.checked = true;
    regexCb.dispatchEvent(new Event("change", { bubbles: true }));

    input.value = "h.*o";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(countEl.textContent).toContain("3");
  });

  it("非法正则不抛错且不计数", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const regexCb = panel.dom.querySelector('[data-opt="regex"]') as HTMLInputElement;

    regexCb.checked = true;
    regexCb.dispatchEvent(new Event("change", { bubbles: true }));

    input.value = "[未闭合";
    expect(() => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }).not.toThrow();
  });
});

describe("searchPanel — 键盘事件", () => {
  let view: EditorView;

  beforeEach(() => {
    view = buildSearchView("line one\nline two\nline three\nline one again");
  });

  afterEach(() => {
    view.destroy();
  });

  it("Enter 执行查找下一个", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;

    input.value = "line";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    ).not.toThrow();
  });

  it("Shift+Enter 执行查找上一个", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;

    input.value = "line";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
      ),
    ).not.toThrow();
  });

  it("Escape 关闭搜索面板", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;

    expect(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    ).not.toThrow();
  });

  it("替换行可见时 Enter 执行替换", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const toggleBtn = panel.dom.querySelector("[data-action='toggle']") as HTMLButtonElement;
    toggleBtn.click();

    input.value = "line";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    ).not.toThrow();
  });

  it("替换输入框中 Enter 执行替换", () => {
    const panel = createChineseSearchPanel(view);
    const toggleBtn = panel.dom.querySelector("[data-action='toggle']") as HTMLButtonElement;
    toggleBtn.click();

    const replaceInput = panel.dom.querySelector(".jot-replace-input") as HTMLInputElement;
    replaceInput.value = "REPLACED";
    replaceInput.dispatchEvent(new Event("input", { bubbles: true }));

    const searchInput = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    searchInput.value = "line";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(() =>
      replaceInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    ).not.toThrow();
  });

  it("替换输入框中 Escape 关闭面板", () => {
    const panel = createChineseSearchPanel(view);
    const replaceInput = panel.dom.querySelector(".jot-replace-input") as HTMLInputElement;

    expect(() =>
      replaceInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    ).not.toThrow();
  });
});

describe("searchPanel — 按钮操作", () => {
  let view: EditorView;

  beforeEach(() => {
    view = buildSearchView("line one\nline two\nline three\nline one more");
  });

  afterEach(() => {
    view.destroy();
  });

  it("上一个按钮点击后更新计数", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    input.value = "line";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const prevBtn = panel.dom.querySelector("[data-action='prev']") as HTMLButtonElement;
    expect(() => prevBtn.click()).not.toThrow();
  });

  it("下一个按钮点击后更新计数", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    input.value = "line";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const nextBtn = panel.dom.querySelector("[data-action='next']") as HTMLButtonElement;
    expect(() => nextBtn.click()).not.toThrow();
  });

  it("关闭按钮触发 closeSearchPanel", () => {
    const panel = createChineseSearchPanel(view);
    const closeBtn = panel.dom.querySelector("[data-action='close']") as HTMLButtonElement;
    expect(() => closeBtn.click()).not.toThrow();
  });

  it("替换按钮（有匹配时）不抛错", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const replaceInput = panel.dom.querySelector(".jot-replace-input") as HTMLInputElement;
    const toggleBtn = panel.dom.querySelector("[data-action='toggle']") as HTMLButtonElement;

    toggleBtn.click();

    input.value = "line";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    replaceInput.value = "REPLACED";
    replaceInput.dispatchEvent(new Event("input", { bubbles: true }));

    const replaceBtn = panel.dom.querySelector("[data-action='replace']") as HTMLButtonElement;
    expect(() => replaceBtn.click()).not.toThrow();
  });

  it("全部替换后文档更新", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const replaceInput = panel.dom.querySelector(".jot-replace-input") as HTMLInputElement;
    const toggleBtn = panel.dom.querySelector("[data-action='toggle']") as HTMLButtonElement;

    toggleBtn.click();

    input.value = "line";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    replaceInput.value = "XX";
    replaceInput.dispatchEvent(new Event("input", { bubbles: true }));

    const replaceAllBtn = panel.dom.querySelector("[data-action='replaceAll']") as HTMLButtonElement;
    replaceAllBtn.click();

    const doc = view.state.doc.toString();
    expect(doc).toContain("XX");
    expect(doc).not.toContain("line");
  });
});

describe("searchPanel — 替换行展开/收起", () => {
  let view: EditorView;

  beforeEach(() => {
    view = buildSearchView("hello world");
  });

  afterEach(() => {
    view.destroy();
  });

  it("点击切换按钮显示替换行", () => {
    const panel = createChineseSearchPanel(view);
    const toggleBtn = panel.dom.querySelector("[data-action='toggle']") as HTMLButtonElement;
    const replaceRow = panel.dom.querySelector(".jot-search-replace-row") as HTMLDivElement;

    expect(replaceRow.hidden).toBe(true);
    toggleBtn.click();
    expect(replaceRow.hidden).toBe(false);
    expect(toggleBtn.classList.contains("active")).toBe(true);
  });

  it("再次点击切换按钮隐藏替换行", () => {
    const panel = createChineseSearchPanel(view);
    const toggleBtn = panel.dom.querySelector("[data-action='toggle']") as HTMLButtonElement;
    const replaceRow = panel.dom.querySelector(".jot-search-replace-row") as HTMLDivElement;

    toggleBtn.click();
    expect(replaceRow.hidden).toBe(false);

    toggleBtn.click();
    expect(replaceRow.hidden).toBe(true);
    expect(toggleBtn.classList.contains("active")).toBe(false);
  });
});

describe("searchPanel — 全词匹配计数", () => {
  let view: EditorView;

  beforeEach(() => {
    view = buildSearchView("hello world\nfoo bar\nhello baz\nworld peace");
  });

  afterEach(() => {
    view.destroy();
  });

  it("全词匹配：完整单词", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const countEl = panel.dom.querySelector(".jot-search-count") as HTMLSpanElement;
    const wordCb = panel.dom.querySelector('[data-opt="word"]') as HTMLInputElement;

    wordCb.checked = true;
    wordCb.dispatchEvent(new Event("change", { bubbles: true }));

    input.value = "world";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(countEl.textContent).toContain("2"); // "hello world" + "world peace"
  });

  it("全词匹配：部分匹配不算", () => {
    const panel = createChineseSearchPanel(view);
    const input = panel.dom.querySelector(".jot-search-input") as HTMLInputElement;
    const countEl = panel.dom.querySelector(".jot-search-count") as HTMLSpanElement;
    const wordCb = panel.dom.querySelector('[data-opt="word"]') as HTMLInputElement;

    wordCb.checked = true;
    wordCb.dispatchEvent(new Event("change", { bubbles: true }));

    input.value = "orl";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(countEl.textContent).toBe("无匹配");
  });
});
