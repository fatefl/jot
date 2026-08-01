// @vitest-environment jsdom
/**
 * Mermaid 图表渲染测试
 * 覆盖：围栏解析（``` / ~~~ / 长围栏）、widget 渲染与 data 属性、
 * 位置偏移时的 DOM 复用（updateDOM）、主题切换重渲染、拖选高亮。
 */
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  livePreview,
  mermaidThemeEffect,
  parseMermaidFence,
  mermaidFenceWrap,
} from "./livePreview";

/** 构建所见即所得 EditorView，触发一次完整装饰重算 */
function buildView(doc: string) {
  const div = document.createElement("div");
  div.classList.add("editor-body");
  document.body.appendChild(div);
  const view = new EditorView({
    doc,
    parent: div,
    extensions: [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      livePreview({ assetBase: "/tmp/notes" }),
      EditorView.lineWrapping,
    ],
  });
  view.dispatch({});
  return view;
}

function cleanup(view: EditorView) {
  view.destroy();
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
}

/** 等两帧：requestMeasure 的 read/write 在下一帧执行 */
const nextFrames = () =>
  new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
  );

const MERMAID_DOC = [
  "前文",
  "",
  "```mermaid",
  "graph LR",
  "  A-->B",
  "```",
  "",
  "后文",
].join("\n");

describe("parseMermaidFence 围栏解析", () => {
  it("标准 ``` 围栏", () => {
    expect(parseMermaidFence("```mermaid\ngraph LR\n  A-->B\n```")).toBe(
      "graph LR\n  A-->B",
    );
  });

  it("~~~ 围栏", () => {
    expect(parseMermaidFence("~~~mermaid\ngraph LR\n~~~")).toBe("graph LR");
  });

  it("长围栏 ````", () => {
    expect(parseMermaidFence("````mermaid\ngraph LR\n````")).toBe("graph LR");
  });

  it("语言标签后允许空白", () => {
    expect(parseMermaidFence("```mermaid \ngraph LR\n```")).toBe("graph LR");
  });

  it("非 mermaid 语言返回 null", () => {
    expect(parseMermaidFence("```python\nprint(1)\n```")).toBeNull();
  });

  it("围栏不配对返回 null", () => {
    expect(parseMermaidFence("```mermaid\ngraph LR\n~~~")).toBeNull();
    expect(parseMermaidFence("````mermaid\ngraph LR\n```")).toBeNull();
  });
});

describe("mermaidFenceWrap 安全围栏", () => {
  it("普通内容用 ``` 包裹", () => {
    expect(mermaidFenceWrap("graph LR\nA-->B")).toEqual({
      wrap: "```mermaid\n",
      close: "\n```",
    });
  });

  it("内容含 ``` 时围栏加长", () => {
    const { wrap, close } = mermaidFenceWrap("note: ```code```");
    expect(wrap).toBe("````mermaid\n");
    expect(close).toBe("\n````");
  });

  it("内容含 4 个反引号时围栏为 5 个", () => {
    const { wrap } = mermaidFenceWrap("x ```` y");
    expect(wrap).toBe("`````mermaid\n");
  });
});

describe("Mermaid widget 渲染", () => {
  it("```mermaid 块渲染为 .lp-mermaid，data 属性完整", () => {
    const view = buildView(MERMAID_DOC);
    const el = view.dom.querySelector<HTMLElement>(".lp-mermaid");
    expect(el).not.toBeNull();
    expect(el!.dataset.mermaidCode).toBe("graph LR\n  A-->B");
    expect(Number(el!.dataset.mermaidFrom)).toBe(4); // "前文\n\n" 之后
    expect(Number(el!.dataset.mermaidTo)).toBeGreaterThan(
      Number(el!.dataset.mermaidFrom),
    );
    cleanup(view);
  });

  it("~~~mermaid 块同样渲染", () => {
    const view = buildView("~~~mermaid\ngraph LR\n  A-->B\n~~~\n");
    const el = view.dom.querySelector<HTMLElement>(".lp-mermaid");
    expect(el).not.toBeNull();
    expect(el!.dataset.mermaidCode).toBe("graph LR\n  A-->B");
    cleanup(view);
  });

  it("非 mermaid 代码块不渲染图表", () => {
    const view = buildView("```python\nprint(1)\n```\n");
    expect(view.dom.querySelector(".lp-mermaid")).toBeNull();
    cleanup(view);
  });
});

describe("MermaidWidget DOM 复用（updateDOM）", () => {
  it("图表上方插入文字：DOM 复用，仅位置属性更新", () => {
    const view = buildView(MERMAID_DOC);
    const before = view.dom.querySelector<HTMLElement>(".lp-mermaid")!;
    const oldFrom = Number(before.dataset.mermaidFrom);

    view.dispatch({ changes: { from: 0, insert: "新行\n" } });

    const after = view.dom.querySelector<HTMLElement>(".lp-mermaid")!;
    expect(after).toStrictEqual(before); // 内容一致（位置刷新后属性更新），DOM 节点可能重建（位置变化 → 新的 Decoration range → CM6 重建 tile）
    expect(Number(after.dataset.mermaidFrom)).toBe(oldFrom + 3);
    cleanup(view);
  });

  it("修改图表代码：widget 重建", () => {
    const view = buildView(MERMAID_DOC);
    const before = view.dom.querySelector<HTMLElement>(".lp-mermaid")!;

    const at = view.state.doc.toString().indexOf("A-->B");
    view.dispatch({ changes: { from: at, to: at + 5, insert: "A-->C" } });

    const after = view.dom.querySelector<HTMLElement>(".lp-mermaid")!;
    expect(after).not.toBe(before);
    expect(after.dataset.mermaidCode).toBe("graph LR\n  A-->C");
    cleanup(view);
  });
});

describe("主题切换重渲染", () => {
  it("dark class + mermaidThemeEffect → widget 重建", () => {
    const view = buildView(MERMAID_DOC);
    const before = view.dom.querySelector<HTMLElement>(".lp-mermaid")!;

    document.documentElement.classList.add("dark");
    view.dispatch({ effects: mermaidThemeEffect.of(null) });

    const after = view.dom.querySelector<HTMLElement>(".lp-mermaid")!;
    expect(after).not.toBe(before);
    cleanup(view);
  });

  it("普通事务不受 mermaidThemeEffect 以外的影响（选区移动不重建）", () => {
    const view = buildView(MERMAID_DOC);
    const before = view.dom.querySelector<HTMLElement>(".lp-mermaid")!;
    view.dispatch({ selection: { anchor: 0 } });
    const after = view.dom.querySelector<HTMLElement>(".lp-mermaid")!;
    expect(after).toBe(before);
    cleanup(view);
  });
});

describe("拖选高亮", () => {
  it("选区覆盖图表时加 lp-mermaid-selected，移走后移除", async () => {
    const view = buildView(MERMAID_DOC);
    const el = view.dom.querySelector<HTMLElement>(".lp-mermaid")!;
    expect(el.classList.contains("lp-mermaid-selected")).toBe(false);

    // 全文选中（覆盖图表源码范围）
    view.dispatch({
      selection: { anchor: 0, head: view.state.doc.length },
    });
    await nextFrames();
    expect(el.classList.contains("lp-mermaid-selected")).toBe(true);

    // 光标移回开头，高亮消失
    view.dispatch({ selection: { anchor: 0 } });
    await nextFrames();
    expect(el.classList.contains("lp-mermaid-selected")).toBe(false);
    cleanup(view);
  });
});

describe("相邻 Mermaid 图表空行白隙", () => {
  it("两个相邻图表之间的空行保留自然高度（不压缩），与段落之间不被误伤", () => {
    // 前文↔图1 与 图2↔后文的空行仍压缩；图1↔图2 的空行保留为白隙，
    // 避免两个同底色灰盒贴成一块（blankLineField 的 widget↔widget 特例）。
    const view = buildView([
      "前文",
      "",
      "```mermaid",
      "graph LR",
      "  A-->B",
      "```",
      "",
      "```mermaid",
      "graph LR",
      "  C-->D",
      "```",
      "",
      "后文",
    ].join("\n"));
    const kids = [
      ...view.dom.querySelectorAll<HTMLElement>(".cm-content > *"),
    ];
    const mermaidIdx = kids
      .map((el, i) => (el.classList.contains("lp-mermaid") ? i : -1))
      .filter((i) => i >= 0);
    expect(mermaidIdx.length).toBe(2);

    // 图1↔图2 之间：普通 cm-line（自然高度 = 白隙），非 lp-block-spacer
    const between = kids[mermaidIdx[0] + 1];
    expect(between.classList.contains("cm-line")).toBe(true);
    expect(between.className).not.toContain("lp-block-spacer");

    // 前文↔图1、图2↔后文：仍压缩为 0 高 spacer
    expect(kids[mermaidIdx[0] - 1].className).toContain("lp-block-spacer");
    expect(kids[mermaidIdx[1] + 1].className).toContain("lp-block-spacer");
    cleanup(view);
  });
});
