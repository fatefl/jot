// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { applyHighlight, planHighlightEdit, planLineWrap, scanHighlights } from "./highlight";
import { livePreview } from "./livePreview";

describe("scanHighlights", () => {
  it("默认色 ==文字==", () => {
    expect(scanHighlights("a ==重点== b")).toEqual([
      { start: 2, end: 8, tokenText: null, color: null },
    ]);
  });

  it("中文命名色 =={红}…==", () => {
    expect(scanHighlights("=={红}重要==")).toEqual([
      { start: 0, end: 9, tokenText: "{红}", color: "red" },
    ]);
  });

  it("英文别名 {red} 与缩写 {r}", () => {
    expect(scanHighlights("=={red}重要==")[0].color).toBe("red");
    expect(scanHighlights("=={r}重要==")[0].color).toBe("red");
    expect(scanHighlights("=={p}重要==")[0].color).toBe("purple");
  });

  it("未知 token 保留字面、按默认色处理", () => {
    expect(scanHighlights("=={xyz}内容==")).toEqual([
      { start: 0, end: 11, tokenText: "{xyz}", color: null },
    ]);
  });

  it("空括号按字面", () => {
    expect(scanHighlights("=={}内容==")[0]).toMatchObject({
      tokenText: "{}",
      color: null,
    });
  });

  it("非贪婪：内层先闭合", () => {
    const ms = scanHighlights("==a ==b== c==");
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ start: 0, end: 6 });
    expect(ms[1]).toMatchObject({ start: 7, end: 13 });
  });

  it("内容允许跨行（段落内）", () => {
    expect(scanHighlights("==第一行\n第二行==")).toHaveLength(1);
  });

  it("无闭合 == 不匹配", () => {
    expect(scanHighlights("==未闭合")).toHaveLength(0);
    expect(scanHighlights("未开启==")).toHaveLength(0);
  });
});

function buildView(doc: string): EditorView {
  const view = new EditorView({
    doc,
    parent: document.body,
    extensions: [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      livePreview({ assetBase: "/tmp/notes" }),
      EditorView.lineWrapping,
    ],
  });
  view.dispatch({}); // 触发一次完整重建（与 livePreview.test.ts 冒烟测试一致）
  return view;
}

describe("livePreview 高亮装饰", () => {
  it("默认色 ==文字==：隐藏 ==，内容上 .lp-hl", () => {
    const view = buildView("a ==重点== b");
    const el = view.dom.querySelector(".lp-hl");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("重点");
    expect(view.dom.textContent).not.toContain("==");
    view.destroy();
  });

  it("命名色 =={红}…==：隐藏 == 与 {红}，内容上 .lp-hl-red", () => {
    const view = buildView("=={红}重要==");
    const el = view.dom.querySelector(".lp-hl-red");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("重要");
    view.destroy();
  });

  it("未知 token 字面保留、按默认黄渲染", () => {
    const view = buildView("=={xyz}内容==");
    const el = view.dom.querySelector(".lp-hl");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("{xyz}内容");
    view.destroy();
  });

  it("标题内高亮", () => {
    const view = buildView("# =={蓝}标题==");
    expect(view.dom.querySelector(".lp-hl-blue")).not.toBeNull();
    view.destroy();
  });

  it("行内代码内 == 不处理", () => {
    const view = buildView("`==x==`");
    expect(view.dom.querySelector(".lp-hl")).toBeNull();
    expect(view.dom.textContent).toContain("==x==");
    view.destroy();
  });

  it("转义 \\== 不处理", () => {
    const view = buildView("\\==x==");
    expect(view.dom.querySelector(".lp-hl")).toBeNull();
    view.destroy();
  });

  it("链接 URL 内 == 不处理", () => {
    const view = buildView("[text](http://a==b==c)");
    expect(view.dom.querySelector(".lp-hl")).toBeNull();
    view.destroy();
  });

  it("行内公式内 == 不处理，且不影响公式后的真实高亮", () => {
    const view = buildView("$x==y$ 后 =={红}重要==");
    const els = view.dom.querySelectorAll(".lp-hl");
    expect(els).toHaveLength(1);
    expect(els[0].className).toContain("lp-hl-red");
    expect(els[0].textContent).toBe("重要");
    view.destroy();
  });

  it("非贪婪嵌套：内层先闭合，各得其所", () => {
    const view = buildView("==a ==b== c==");
    const els = view.dom.querySelectorAll(".lp-hl");
    expect(els).toHaveLength(2);
    expect(els[0].textContent).toBe("a ");
    expect(els[1].textContent).toBe(" c");
    view.destroy();
  });

  it("代码块内 == 不处理", () => {
    const view = buildView("```\n==x==\n```");
    expect(view.dom.querySelector(".lp-hl")).toBeNull();
    view.destroy();
  });
});

describe("planLineWrap（按行包裹）", () => {
  it("单行默认色", () => {
    expect(planLineWrap("abc def", 1, 5, null)).toEqual({
      changes: [{ from: 1, to: 5, insert: "==bc d==" }],
      anchor: 3,
      head: 7,
    });
  });

  it("命名色前缀", () => {
    const p = planLineWrap("abc", 0, 3, "red");
    expect(p!.changes).toEqual([{ from: 0, to: 3, insert: "=={红}abc==" }]);
  });

  it("跨行按段拆分，selection 覆盖全部内容", () => {
    const p = planLineWrap("ab\ncd\nef", 1, 7, null);
    expect(p!.changes).toEqual([
      { from: 1, to: 2, insert: "==b==" },
      { from: 3, to: 5, insert: "==cd==" },
      { from: 6, to: 7, insert: "==e==" },
    ]);
    expect(p!.anchor).toBe(3);
    expect(p!.head).toBe(9); // 3 + (7 - 1)
  });

  it("空选区返回 null", () => {
    expect(planLineWrap("abc", 1, 1, null)).toBeNull();
  });

  it("选区止于行尾换行符前", () => {
    const p = planLineWrap("ab\ncd", 0, 3, null);
    expect(p!.changes).toEqual([{ from: 0, to: 2, insert: "==ab==" }]);
  });
});

describe("planHighlightEdit（修改/清除已有高亮）", () => {
  it("选区在默认高亮内：清除剥掉 ==", () => {
    const p = planHighlightEdit("a ==b== c", 4, 5, { kind: "clear" });
    expect(p!.changes).toEqual([
      { from: 2, to: 4, insert: "" },
      { from: 5, to: 7, insert: "" },
    ]);
    expect(p!.anchor).toBe(2);
    expect(p!.head).toBe(3);
  });

  it("选区在命名高亮内：点同色=剥除（含 token）", () => {
    const p = planHighlightEdit("a =={红}b== c", 7, 8, { kind: "apply", color: "red" });
    expect(p!.changes).toEqual([
      { from: 2, to: 7, insert: "" },
      { from: 8, to: 10, insert: "" },
    ]);
    expect(p!.anchor).toBe(2);
    expect(p!.head).toBe(3);
  });

  it("改色：替换 token", () => {
    const p = planHighlightEdit("a =={红}b== c", 7, 8, { kind: "apply", color: "blue" });
    expect(p!.changes).toEqual([{ from: 4, to: 7, insert: "{蓝}" }]);
    expect(p!.anchor).toBe(7);
    expect(p!.head).toBe(8);
  });

  it("默认高亮改命名色：插入 token", () => {
    const p = planHighlightEdit("a ==b== c", 4, 5, { kind: "apply", color: "red" });
    expect(p!.changes).toEqual([{ from: 4, to: 4, insert: "{红}" }]);
    expect(p!.anchor).toBe(7);
    expect(p!.head).toBe(8);
  });

  it("命名高亮改默认黄：删除 token", () => {
    const p = planHighlightEdit("a =={红}b== c", 7, 8, { kind: "apply", color: null });
    expect(p!.changes).toEqual([{ from: 4, to: 7, insert: "" }]);
    expect(p!.anchor).toBe(4);
    expect(p!.head).toBe(5);
  });

  it("未知 token 高亮：点默认黄=剥除（含未知 token）", () => {
    const p = planHighlightEdit("a =={xyz}b== c", 9, 10, { kind: "apply", color: null });
    expect(p!.changes).toEqual([
      { from: 2, to: 9, insert: "" },
      { from: 10, to: 12, insert: "" },
    ]);
    expect(p!.anchor).toBe(2);
    expect(p!.head).toBe(3);
  });

  it("选区不在高亮内返回 null", () => {
    expect(planHighlightEdit("a ==b== c", 8, 9, { kind: "clear" })).toBeNull();
  });
});

describe("applyHighlight（EditorView 集成）", () => {
  // 需要 markdown 扩展：改色/剥除路径依赖语法树定位 Paragraph 节点，
  // 裸 EditorView（无语言扩展）会退化到包裹路径导致断言错误
  function buildView(doc: string): EditorView {
    return new EditorView({
      doc,
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
      ],
    });
  }

  it("包裹命名色并保持选区在内容上", () => {
    const view = buildView("abc def");
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    applyHighlight(view, { kind: "apply", color: "red" });
    expect(view.state.doc.toString()).toBe("=={红}abc== def");
    expect(view.state.selection.main.anchor).toBe(5);
    expect(view.state.selection.main.head).toBe(8);
    view.destroy();
  });

  it("清除剥除", () => {
    const view = buildView("=={红}abc== def");
    view.dispatch({ selection: { anchor: 5, head: 8 } });
    applyHighlight(view, { kind: "clear" });
    expect(view.state.doc.toString()).toBe("abc def");
    view.destroy();
  });

  it("跨行选区按行包裹", () => {
    const view = buildView("ab\ncd");
    view.dispatch({ selection: { anchor: 1, head: 4 } });
    applyHighlight(view, { kind: "apply", color: null });
    expect(view.state.doc.toString()).toBe("a==b==\n==cd==");
    view.destroy();
  });
});
