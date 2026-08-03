// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { scanHighlights } from "./highlight";
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
