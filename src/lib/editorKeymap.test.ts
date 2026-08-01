// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  toggleMark,
  toggleLink,
  toggleHeading,
  linkUrlAt,
} from "./editorKeymap";

function view(doc: string, from: number, to = from) {
  const v = new EditorView({
    doc,
    parent: document.body,
    selection: { anchor: from, head: to },
  });
  return v;
}

/** 带 markdown 语言扩展的 view（toggleHeading 的 Setext 识别、
 *  linkUrlAt 都依赖语法树） */
function mdView(doc: string, from: number, to = from) {
  const v = new EditorView({
    doc,
    parent: document.body,
    selection: { anchor: from, head: to },
    extensions: [markdown({ base: markdownLanguage })],
  });
  v.dispatch({}); // 触发解析
  return v;
}

describe("toggleMark", () => {
  it("包裹选中文本", () => {
    const v = view("hello world", 0, 5);
    toggleMark(v, "**");
    expect(v.state.doc.toString()).toBe("**hello** world");
    v.destroy();
  });

  it("已包裹时解除", () => {
    const v = view("**hello** world", 2, 7);
    toggleMark(v, "**");
    expect(v.state.doc.toString()).toBe("hello world");
    v.destroy();
  });

  it("选区含标记时剥掉", () => {
    const v = view("**hello** world", 0, 9);
    toggleMark(v, "**");
    expect(v.state.doc.toString()).toBe("hello world");
    v.destroy();
  });

  it("无选区时插入标记对", () => {
    const v = view("abc", 3);
    toggleMark(v, "`");
    expect(v.state.doc.toString()).toBe("abc``");
    expect(v.state.selection.main.head).toBe(4);
    v.destroy();
  });
});

describe("toggleLink", () => {
  it("普通文本包装为链接，光标进括号", () => {
    const v = view("hello", 0, 5);
    toggleLink(v);
    expect(v.state.doc.toString()).toBe("[hello]()");
    expect(v.state.selection.main.head).toBe(8);
    v.destroy();
  });

  it("URL 文本包装为 [url](url)", () => {
    const v = view("https://a.com", 0, 13);
    toggleLink(v);
    expect(v.state.doc.toString()).toBe("[https://a.com](https://a.com)");
    v.destroy();
  });
});

describe("toggleHeading", () => {
  it("普通段落加前缀", () => {
    const v = view("正文\n", 0);
    toggleHeading(v, 2);
    expect(v.state.doc.toString()).toBe("## 正文\n");
    v.destroy();
  });

  it("Setext 一级标题转 ATX：下划线行一并删除", () => {
    const v = mdView("标题\n=====\n\n下一段\n", 0);
    toggleHeading(v, 1);
    expect(v.state.doc.toString()).toBe("# 标题\n\n下一段\n");
    v.destroy();
  });

  it("Setext 二级标题转 ATX：--- 不会残留为分割线", () => {
    const v = mdView("标题\n---\n", 0);
    toggleHeading(v, 3);
    expect(v.state.doc.toString()).toBe("### 标题\n");
    v.destroy();
  });

  it("Setext 下划线是文档末行且无尾换行", () => {
    const v = mdView("标题\n===", 0);
    toggleHeading(v, 2);
    expect(v.state.doc.toString()).toBe("## 标题");
    v.destroy();
  });

  it("已是同级 ATX 标题：取消前缀", () => {
    const v = view("# 标题\n", 0);
    toggleHeading(v, 1);
    expect(v.state.doc.toString()).toBe("标题\n");
    v.destroy();
  });
});

describe("linkUrlAt", () => {
  it("普通链接取 URL", () => {
    const doc = "[示例](https://example.com)\n";
    const v = mdView(doc, 2);
    expect(linkUrlAt(v, 2)).toBe("https://example.com");
    v.destroy();
  });

  it("URL 含括号不截断", () => {
    const doc = "[词条](https://zh.wikipedia.org/wiki/测试_(消歧义))\n";
    const v = mdView(doc, 2);
    expect(linkUrlAt(v, 2)).toBe("https://zh.wikipedia.org/wiki/测试_(消歧义)");
    v.destroy();
  });

  it("Autolink 取 URL", () => {
    const doc = "<https://example.com>\n";
    const v = mdView(doc, 3);
    expect(linkUrlAt(v, 3)).toBe("https://example.com");
    v.destroy();
  });

  it("非链接位置返回 null", () => {
    const v = mdView("普通文本\n", 2);
    expect(linkUrlAt(v, 2)).toBeNull();
    v.destroy();
  });
});
