// @vitest-environment jsdom
// 一次性探针：语法树覆盖行为（查明"为什么加载后树只有 3KB"）
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";

const DOC = readFileSync(resolve(process.cwd(), "test/超长压力测试.md"), "utf-8");
const exts = () => [
  markdown({ base: markdownLanguage, codeLanguages: languages }),
  EditorView.lineWrapping,
];

describe("语法树覆盖探针", () => {
  it("state 创建后 → view 创建后 → ensureSyntaxTree 循环", () => {
    const state = EditorState.create({ doc: DOC, extensions: exts() });

    const t0 = performance.now();
    const tree0 = syntaxTree(state);
    console.log("[probe] 1. state 创建后 syntaxTree 覆盖:", tree0.topNode.to, "/", DOC.length, (performance.now() - t0).toFixed(1) + "ms");

    const t1 = performance.now();
    const tree1 = ensureSyntaxTree(state, DOC.length, 300);
    console.log("[probe] 2. ensureSyntaxTree(300ms) 覆盖:", tree1?.topNode.to ?? -1, "/", DOC.length, (performance.now() - t1).toFixed(1) + "ms");

    const view = new EditorView({ state, parent: document.body });
    const tree2 = syntaxTree(view.state);
    console.log("[probe] 3. view 创建后 syntaxTree 覆盖:", tree2.topNode.to, "/", DOC.length);

    let tree3: ReturnType<typeof ensureSyntaxTree> = tree2;
    const t3 = performance.now();
    let steps = 0;
    while (tree3 && tree3.topNode.to < DOC.length && steps < 300) {
      tree3 = ensureSyntaxTree(view.state, DOC.length, 100);
      steps++;
    }
    console.log(`[probe] 4. ensureSyntaxTree 循环: ${steps} 步 → 覆盖`, tree3?.topNode.to ?? -1, "/", DOC.length, (performance.now() - t3).toFixed(1) + "ms");

    view.destroy();
    expect(state.doc.length).toBeGreaterThan(0);
  });
});
