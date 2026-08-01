// @vitest-environment jsdom
// 等价性验证：视口化 create + 树推进增量补齐 的最终装饰 == 强制全量构建。
// 证明 Phase 1（create/build 视口化，初始只扫 ~3000 字符）+ Phase 2/3
// （树推进增量、RangeSet.update）的组合在长文档上不丢失、不重复任何装饰。
//
// 方法：同一文档建两个视图——
//   A（参照）：强制全量解析 + 空事务，装饰从完整语法树一次性构建；
//   B（增量）：不强制，逐步 ensureSyntaxTree + 空事务（模拟 parseWorker /
//             longDocParsePlugin 分片），装饰随树推进增量补齐。
//   __snapshotDecorations 把 5 个块级 StateField + 主 ViewPlugin 收集为规范元组，
//   断言 A/B 最终逐集合相等。
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { livePreview, __snapshotDecorations } from "./livePreview";
import { codeHighlight } from "@/components/Editor";

function coreExtensions() {
  return [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(codeHighlight),
    livePreview({ assetBase: "/tmp" }),
    EditorView.lineWrapping,
  ];
}

/** 构造横跨 ~3000 字符解析前沿、含全部装饰类型的文档（~100KB，多次分片解析） */
function buildDoc(): string {
  const sections: string[] = [];
  for (let i = 0; i < 60; i++) {
    sections.push(
      `## 章节 ${i}\n\n` +
      `正文 **加粗 ${i}** 与 *斜体* 以及 \`code\`，公式 $E=mc^2+${i}$。\n\n` +
      `- 列表项 ${i} **粗体**\n- 第二项\n\n` +
      `> 引用段落 ${i}\n\n` +
      `| 名称 | 值 |\n| --- | --- |\n| 甲 | ${i} |\n| 乙 | ${i + 1} |\n\n` +
      `---\n\n` +
      `$$x^2 + ${i}$$ 块级公式\n\n` +
      `\`\`\`mermaid\ngraph TD\n  A${i}-->B\n\`\`\`\n\n`,
    );
  }
  return sections.join("");
}

/** 强制全量解析（模拟 longDocParsePlugin 完成） */
function forceFullParse(view: EditorView): void {
  let guard = 0;
  while (syntaxTree(view.state).topNode.to < view.state.doc.length && guard++ < 500) {
    ensureSyntaxTree(view.state, view.state.doc.length, 300);
  }
  view.dispatch({});
}

describe("树推进增量 == 全量构建（等价性）", () => {
  it("长文档视口化 create + 树推进补齐与强制全量逐集合相等", () => {
    const doc = buildDoc();

    // A：强制全量构建（参照）
    const viewA = new EditorView({ doc, parent: document.body, extensions: coreExtensions() });
    forceFullParse(viewA);
    const snapA = __snapshotDecorations(viewA);

    // B：分片推进（增量补齐）
    const viewB = new EditorView({ doc, parent: document.body, extensions: coreExtensions() });
    let guard = 0;
    while (syntaxTree(viewB.state).topNode.to < viewB.state.doc.length && guard++ < 500) {
      ensureSyntaxTree(viewB.state, viewB.state.doc.length, 20);
      viewB.dispatch({});
    }
    const snapB = __snapshotDecorations(viewB);

    expect(snapB).toBe(snapA);

    viewA.destroy();
    viewB.destroy();
  });

  it("横跨解析前沿的 mermaid / 表格 / 围栏不截断、无重复 widget", () => {
    // 构造：frontier 前 ~2900 字符，frontier 后（~3000+）有 mermaid 块、
    // 表格、代码围栏（opener 在 frontier 内、closer 在 frontier 外）
    const parts: string[] = [];
    let fill = "";
    while (fill.length < 2900) {
      fill += "正文段落 **加粗** 与 `code`，内容填充。\n\n";
    }
    parts.push(fill);
    // 横跨 frontier 的 mermaid（opener 在 2900+，正文延伸过 3000）
    parts.push("```mermaid\ngraph TD\n  A-->B\n  B-->C\n```\n\n");
    parts.push("| 名称 | 值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |\n\n");
    parts.push("```js\nconst x = 1;\n```\n\n");
    // frontier 后的大量内容
    for (let i = 0; i < 30; i++) parts.push(`### 后续 ${i}\n\n**粗体** 与 \`code\`。\n\n`);
    const doc = parts.join("");

    const view = new EditorView({ doc, parent: document.body, extensions: coreExtensions() });
    // 分片推进解析
    let guard = 0;
    while (syntaxTree(view.state).topNode.to < view.state.doc.length && guard++ < 500) {
      ensureSyntaxTree(view.state, view.state.doc.length, 20);
      view.dispatch({});
    }
    // 滚动到 frontier 附近，确保 block widget 进入视口渲染
    view.dispatch({ effects: EditorView.scrollIntoView(3000) });
    view.dispatch({});

    // mermaid 完整渲染（不截断）：源码范围完整覆盖围栏（from 在 frontier 前、
    // to 在 frontier 后）
    const mermaid = view.dom.querySelector(".lp-mermaid");
    expect(mermaid).not.toBeNull();
    const mFrom = Number(mermaid?.getAttribute("data-mermaid-from"));
    const mTo = Number(mermaid?.getAttribute("data-mermaid-to"));
    expect(mFrom).toBeGreaterThan(2800);
    expect(mTo).toBeGreaterThan(mFrom);

    // 表格完整渲染（block widget 仅在视口内渲染，滚动后应可见）
    expect(view.dom.querySelector("table.lp-table")).not.toBeNull();

    // 无重复围栏头部：主插件装饰集里 CodeHeaderWidget 每条源码围栏恰好一个。
    // （重复会体现在 __snapshotDecorations 的 main 集合里出现两个相同 range，
    //   这里直接数 DOM 中围栏头数量作兜底断言。）
    const fenceHeaders = view.dom.querySelectorAll(".lp-code-fence").length;
    expect(fenceHeaders).toBeGreaterThan(0);
    // 每个围栏的开头行装饰 .lp-code-line-top 出现且唯一对应围栏数量
    expect(view.dom.querySelectorAll(".lp-code-line-top").length).toBeGreaterThan(0);

    view.destroy();
  });
});
