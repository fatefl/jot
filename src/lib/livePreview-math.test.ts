// @vitest-environment jsdom
/**
 * KaTeX 数学公式渲染测试
 * 验证行内 $...$ 和块级 $$...$$ 在所见即所得模式下不抛错，
 * 且与语法树中的其他节点不产生冲突。
 */
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { livePreview } from "./livePreview";

/** 构建所见即所得 EditorView，触发一次完整装饰重算 */
function buildView(doc: string) {
  const div = document.createElement("div");
  div.classList.add("editor-body");
  document.body.appendChild(div);
  // 暗色类名使得 KaTeX 按暗色主题初始化
  document.documentElement.classList.add("dark");

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

const MATH_DOC = [
  "# 数学公式测试",
  "",
  "## 行内公式",
  "",
  "著名的质能方程 $E=mc^2$ 由爱因斯坦提出。",
  "勾股定理：$a^2 + b^2 = c^2$。",
  "集合论 $\\forall x \\in X, \\exists y \\in Y$ 均有。",
  "",
  "## 块级公式",
  "",
  "正态分布密度函数：",
  "$$",
  "f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}",
  "$$",
  "",
  "高斯积分：",
  "$$",
  "\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}",
  "$$",
  "",
  "## 混合内容",
  "",
  "- 价格 \\$100 不是公式",
  "- 矩阵 $\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$ 是公式",
  "",
  "## 代码块保护",
  "",
  "```python",
  "s = \"$100 dollar\"  # 这不会被渲染",
  "x = f\"{a + b}\"",
  "```",
  "",
  "## Mermaid 保护",
  "",
  "```mermaid",
  'graph LR',
  '  A["$100 收入"] --> B',
  "```",
  "",
  "最后一行普通文本。",
].join("\n");

describe("KaTeX 数学渲染", () => {
  it("全要素数学文档不抛错", () => {
    const view = buildView(MATH_DOC);
    expect(view.state.doc.length).toBeGreaterThan(0);
    cleanup(view);
  });

  it("两次 dispatch 不抛错（首次渲染后再次重算）", () => {
    const view = buildView(MATH_DOC);
    view.dispatch({ selection: { anchor: 5 } });
    view.dispatch({ selection: { anchor: 50 } });
    expect(view.state.doc.length).toBeGreaterThan(0);
    cleanup(view);
  });

  it("文档编辑后不抛错", () => {
    const view = buildView(MATH_DOC);
    // 在文档中插入新公式
    view.dispatch({
      changes: { from: 0, insert: "$x+y=z$\n\n" },
    });
    expect(view.state.doc.toString()).toContain("$x+y=z$");
    cleanup(view);
  });

  it("行内公式开头正常", () => {
    const view = buildView("$x=1$ 开头就是公式\n");
    expect(view.state.doc.toString()).toContain("$x=1$");
    cleanup(view);
  });

  it("连续多组行内公式不抛错", () => {
    const view = buildView("$a$ $b$ $c$ $d$\n");
    expect(view.state.doc.toString()).toContain("$a$ $b$ $c$ $d$");
    cleanup(view);
  });

  it("空公式 $$  $$ 不抛错", () => {
    const view = buildView("文字 $$ $$ 结尾\n");
    expect(view.state.doc.toString()).toBe("文字 $$ $$ 结尾\n");
    cleanup(view);
  });

  it("不含 $ 的文档不抛错", () => {
    const view = buildView("# 普通文档\n\n没有任何数学公式。\n");
    expect(view.state.doc.toString()).not.toContain("$");
    cleanup(view);
  });

  it("dark 模式下不抛错", () => {
    document.documentElement.classList.add("dark");
    const view = buildView("## dark mode math\n\n$$ x^2 $$\n");
    expect(view.state.doc.toString()).toContain("$$");
    document.documentElement.classList.remove("dark");
    cleanup(view);
  });

  it("公式编辑（$$..$$ → 纯文本）后残留 widget 被移除，源码可见", () => {
    // 回归：mathField 增量更新曾把旧的 MathWidget 装饰映射到新文本区间并保留，
    // 导致公式编辑后纯文本仍被 widget 遮挡（编辑框不可见、coordsAtPos 定位到
    // 旧 widget 位置）。此断言验证替换后 .lp-math-block 从 DOM 移除。
    const view = buildView("# 标题\n\n$$x^2 + y^2 = z^2$$\n\n正文。\n");
    view.dispatch({});

    const widget = view.dom.querySelector(".lp-math-block") as HTMLElement;
    expect(widget).not.toBeNull();
    const from = parseInt(widget.getAttribute("data-math-from") ?? "0", 10);
    const to = parseInt(widget.getAttribute("data-math-to") ?? "0", 10);
    const formula = widget.getAttribute("data-math-formula") ?? "";
    expect(formula).toBe("x^2 + y^2 = z^2");

    // 模拟 editMathFormula 的替换：$$..$$ → 纯文本
    view.dispatch({
      changes: { from, to, insert: formula },
      selection: { anchor: from },
    });

    // 旧 widget 必须被移除，纯文本正常渲染
    expect(view.dom.querySelector(".lp-math-block")).toBeNull();
    expect(view.state.doc.toString()).toContain("x^2 + y^2 = z^2");
    cleanup(view);
  });

  it("行内公式编辑后残留 widget 同样被移除", () => {
    const view = buildView("质能方程 $E=mc^2$ 很重要。\n");
    view.dispatch({});

    const widget = view.dom.querySelector(".lp-math-inline") as HTMLElement;
    expect(widget).not.toBeNull();
    const from = parseInt(widget.getAttribute("data-math-from") ?? "0", 10);
    const to = parseInt(widget.getAttribute("data-math-to") ?? "0", 10);
    const formula = widget.getAttribute("data-math-formula") ?? "";

    view.dispatch({
      changes: { from, to, insert: formula },
      selection: { anchor: from },
    });

    expect(view.dom.querySelector(".lp-math-inline")).toBeNull();
    expect(view.state.doc.toString()).toContain("质能方程 E=mc^2 很重要");
    cleanup(view);
  });

  it("行内公式旁边打字不触发 widget 重建（增量优化不回退）", () => {
    // 在行内公式源码区间之外编辑（$ 前后相邻处）不得删除 widget，
    // 否则每次击键 KaTeX 重渲染，破坏 be2caa8 的增量重建优化。
    const view = buildView("质能方程 $E=mc^2$ 很重要。\n");
    view.dispatch({});

    const widget = view.dom.querySelector(".lp-math-inline") as HTMLElement;
    expect(widget).not.toBeNull();
    const from = parseInt(widget.getAttribute("data-math-from") ?? "0", 10);
    const to = parseInt(widget.getAttribute("data-math-to") ?? "0", 10);

    // 公式后相邻处插入字符：变化区间 [to, to+3] 与 widget 区间 [from, to] 端点相接
    view.dispatch({ changes: { from: to, to, insert: "（式）" } });
    expect(view.dom.querySelector(".lp-math-inline")).not.toBeNull();

    // 公式前相邻处插入字符：变化区间端点相接不重叠
    view.dispatch({ changes: { from, to: from, insert: "著名的" } });
    expect(view.dom.querySelector(".lp-math-inline")).not.toBeNull();
    expect(view.state.doc.toString()).toContain("$E=mc^2$");
    cleanup(view);
  });
});
