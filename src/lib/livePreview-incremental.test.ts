// @vitest-environment jsdom
// 回归测试：即时渲染（livePreview）build 路径必须强制解析可见区域。
//
// 根因：build() 曾用 syntaxTree（增量非阻塞树），真实浏览器中可见区域
// 语法树未解析完成时，行内节点（StrongEmphasis / FencedCode / Image / Link…）
// 缺失 → 显示为源码，滚动到新视口、粘贴大段文本时尤其明显。修复改用
// ensureSyntaxTree(view.state, doc.length, 100) 强制同步解析整篇（与 findTables
// 一致；笔记文档小，Lezer 增量解析使每次编辑开销可忽略）。
//
// 环境限制：jsdom 无真实布局，CM 在 dispatch 后同步解析全文，syntaxTree 与
// ensureSyntaxTree 结果一致，因此无法直接复现真实浏览器的"解析滞后"。
// 本测试在"constructor 首帧（不 dispatch）"窗口验证差异——此时 parseWorker
// 首帧尚未推进，syntaxTree 可能不完整，而 ensureSyntaxTree 会强制解析。
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { livePreview } from "./livePreview";

function makeView(doc: string) {
  return new EditorView({
    doc,
    parent: document.body,
    extensions: [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      livePreview({ assetBase: "/tmp/test" }),
      EditorView.lineWrapping,
    ],
  });
}

describe("即时渲染：build 强制解析可见区域", () => {
  it("constructor 首帧（不等待 dispatch）可见区域装饰即渲染", () => {
    // 故意不 dispatch({})：constructor 首帧 build 时，parseWorker 首帧尚未推进，
    // syntaxTree 可能拿不到行内节点。ensureSyntaxTree 会强制同步解析。
    const view = makeView(
      "## 标题\n\n**加粗** *斜体* `code`\n\n- 列表项\n\n```js\nconst x = 1;\n```\n",
    );

    expect(view.dom.querySelector(".lp-h2")).not.toBeNull();
    expect(view.dom.querySelector(".lp-strong")).not.toBeNull();
    expect(view.dom.querySelector(".lp-em")).not.toBeNull();
    expect(view.dom.querySelector(".lp-inline-code")).not.toBeNull();
    expect(view.dom.querySelector(".lp-bullet")).not.toBeNull();
    expect(view.dom.querySelector(".lp-code-lang")).not.toBeNull();

    view.destroy();
  });

  it("粘贴含多种语法的文本后，可见区域内新装饰立即渲染", () => {
    const view = makeView("# 起点\n\n");
    view.dispatch({});

    const chunk = "## 新标题\n\n**新加粗** *新斜体* `new`\n\n- 新项\n";
    view.dispatch({ changes: { from: view.state.doc.length, insert: chunk } });

    expect(view.dom.querySelectorAll(".lp-h2").length).toBeGreaterThan(0);
    expect(view.dom.querySelectorAll(".lp-strong").length).toBeGreaterThan(0);
    expect(view.dom.querySelectorAll(".lp-bullet").length).toBeGreaterThan(0);

    view.destroy();
  });
});
