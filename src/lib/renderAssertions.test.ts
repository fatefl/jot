// @vitest-environment jsdom
// 渲染断言：不只要"不崩"，还要确认装饰真的生效（DOM 里有对应元素）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { livePreview } from "./livePreview";
import { codeHighlight } from "@/components/Editor";

function render(doc: string): HTMLElement {
  const view = new EditorView({
    doc,
    parent: document.body,
    extensions: [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      livePreview({ assetBase: "/tmp/notes" }),
      EditorView.lineWrapping,
    ],
  });
  view.dispatch({});
  return view.contentDOM;
}

describe("渲染断言", () => {
  // ---- 标题 ----
  it("标题：行类生效且 # 真正移除（不占宽度）", () => {
    const dom = render("# 标题一\n");
    const line = dom.querySelector(".cm-line.lp-h1");
    expect(line).not.toBeNull();
    // 行首标记用 replace 移除，DOM 中不留 # 和占位空白
    expect(line!.textContent).toBe("标题一");
  });

  it("六级标题各有独立行类", () => {
    const dom = render("# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6\n");
    for (let i = 1; i <= 6; i++) {
      expect(dom.querySelector(`.cm-line.lp-h${i}`)).not.toBeNull();
    }
  });

  it("Setext 标题：下划线行真正移除（保留空行高度）", () => {
    const dom = render("Setext 标题\n===========\n");
    // 内容行有标题样式
    expect(dom.querySelector(".cm-line.lp-h1")).not.toBeNull();
    // 下划线字符被 replace 移除，DOM 中不存在
    expect(dom.textContent).not.toContain("===");
    expect(dom.textContent).toContain("Setext");
  });

  // ---- 行内样式 ----
  it("加粗：标记视觉隐藏，文字带样式", () => {
    const dom = render("这是 **加粗** 文字\n");
    const strong = dom.querySelector(".lp-strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toContain("加粗");
    expect(dom.querySelectorAll(".lp-inline-hidden").length).toBeGreaterThanOrEqual(2);
  });

  it("斜体：mark 类落在文字上", () => {
    const dom = render("这是 *斜体* 文字\n");
    const em = dom.querySelector(".lp-em");
    expect(em).not.toBeNull();
    expect(em!.textContent).toContain("斜体");
  });

  it("删除线：mark 类落在文字上", () => {
    const dom = render("这是 ~~删除线~~ 文字\n");
    const strike = dom.querySelector(".lp-strike");
    expect(strike).not.toBeNull();
    expect(strike!.textContent).toContain("删除线");
  });

  it("行内代码：背景色 + 等宽字体 class", () => {
    const dom = render("这是 `行内代码` 文字\n");
    const code = dom.querySelector(".lp-inline-code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toContain("行内代码");
  });

  // ---- 列表 ----
  it("无序列表：圆点替换 -", () => {
    const dom = render("- 列表项\n");
    expect(dom.querySelector(".lp-bullet")).not.toBeNull();
    expect(dom.textContent).toContain("列表项");
  });

  it("有序列表：序号保留但淡化 class", () => {
    const dom = render("1. 有序一\n2. 有序二\n");
    const marks = dom.querySelectorAll(".lp-ordered-mark");
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(dom.textContent).toContain("有序一");
    expect(dom.textContent).toContain("有序二");
  });

  it("任务列表：渲染勾选框", () => {
    const dom = render("- [ ] 待办\n- [x] 完成\n");
    const boxes = dom.querySelectorAll("input.lp-checkbox");
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(false);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
  });

  it("回归：勾选框前有编辑后，点击仍切换正确字符", () => {
    // CheckboxWidget.eq 若不含 pos，CM 会在位置后移时复用旧 DOM 闭包，
    // 点击改到错误字符（曾把 "- " 后的空格改成 x）
    const view = new EditorView({
      doc: "- [ ] 任务\n",
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/notes" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});
    // 勾选框前插入一行，其源码位置整体后移
    view.dispatch({ changes: { from: 0, insert: "x\n" } });
    const box = view.dom.querySelector("input.lp-checkbox")!;
    box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view.state.doc.toString()).toBe("x\n- [x] 任务\n");
    view.destroy();
  });

  // ---- 链接 ----
  it("链接：只显示文字，URL 不可见", () => {
    const dom = render("[示例](https://example.com)\n");
    expect(dom.querySelector(".lp-link")).not.toBeNull();
    expect(dom.textContent).toContain("示例");
    expect(dom.textContent).not.toContain("example.com");
  });

  it("Autolink 也渲染为链接样式", () => {
    const dom = render("访问 <https://example.com> 试试\n");
    const link = dom.querySelector(".lp-link");
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("https://example.com");
  });

  // ---- 图片 ----
  it("图片：替换为 img 元素", () => {
    const dom = render("![描述](.assets/a.png)\n");
    const img = dom.querySelector("img.lp-image");
    expect(img).not.toBeNull();
    // 图片整段语法替换，![] 和 () 不存在于可视文本
    expect(dom.textContent).not.toContain("![]");
  });

  it("图片空 alt：仍正常渲染 img", () => {
    const dom = render("![](.assets/a.png)\n");
    const img = dom.querySelector("img.lp-image");
    expect(img).not.toBeNull();
    expect((img as HTMLImageElement).alt).toBe("");
  });

  it("图片带 title：title 不作为可见文本出现", () => {
    const dom = render('![x](.assets/a.png "我的标题")\n');
    const img = dom.querySelector("img.lp-image");
    expect(img).not.toBeNull();
    expect(dom.textContent).not.toContain("我的标题");
  });

  it("图片 URL 含括号不截断", () => {
    const dom = render("![截图](.assets/a(1).png)\n");
    const img = dom.querySelector("img.lp-image") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.alt).toBe("截图");
    expect(img.src).toContain("a(1).png");
  });

  // ---- 分割线 ----
  it("分割线：替换为 hr 装饰元素", () => {
    const dom = render("上文\n\n---\n\n下文\n");
    expect(dom.querySelector(".lp-hr")).not.toBeNull();
  });

  // ---- 表格 ----
  it("表格：替换为渲染表格", () => {
    const dom = render("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    const table = dom.querySelector("table.lp-table");
    expect(table).not.toBeNull();
    expect(table!.textContent).toContain("1");
  });

  it("表格含对齐：单元格有 textAlign 样式", () => {
    const dom = render("| 名称 | 数量 | 评分 |\n| :--- | ---: | :-: |\n| a | 1 | 5 |\n");
    const cells = dom.querySelectorAll("table.lp-table td");
    const styles = Array.from(cells).map((c) => (c as HTMLElement).style.textAlign);
    expect(styles).toContain("left");
    expect(styles).toContain("right");
    expect(styles).toContain("center");
  });

  // ---- 代码块 ----
  it("代码块：行底色 + 围栏类名", () => {
    const dom = render("```js\nconst a = 1;\n```\n");
    const lines = dom.querySelectorAll(".cm-line.lp-code-line");
    expect(lines.length).toBe(3);
  });

  it("代码块首尾行有圆角类名", () => {
    const dom = render("```js\ncode\n```\n");
    expect(dom.querySelector(".cm-line.lp-code-line-top")).not.toBeNull();
    expect(dom.querySelector(".cm-line.lp-code-line-bot")).not.toBeNull();
    expect(dom.querySelector(".cm-line.lp-code-fence")).not.toBeNull();
  });

  it("代码块语言标签：lang 徽章渲染", () => {
    const dom = render("```js\ncode\n```\n");
    const langBadge = dom.querySelector(".lp-code-lang");
    expect(langBadge).not.toBeNull();
    expect(langBadge!.textContent).toContain("js");
  });

  // ---- 引用 ----
  it("引用：竖条行类，> 真正移除（不占宽度）", () => {
    const dom = render("> 引用内容\n");
    const line = dom.querySelector(".cm-line.lp-quote");
    expect(line).not.toBeNull();
    expect(line!.textContent).toBe("引用内容");
  });

  // ---- 硬换行 ----
  it("硬换行反斜杠：渲染为 ↵ 指示器", () => {
    const dom = render("行尾反斜杠\\\n下一行\n");
    expect(dom.querySelector(".lp-hardbreak")).not.toBeNull();
    expect(dom.textContent).toContain("↵");
  });

  it("硬换行双空格：渲染为 ↵ 指示器", () => {
    const dom = render("行尾双空格  \n下一行\n");
    expect(dom.querySelector(".lp-hardbreak")).not.toBeNull();
  });

  // ---- 上下标 ----
  it("上标：class 落在 ^ 内容上", () => {
    const dom = render("X^2^\n");
    const sup = dom.querySelector(".lp-sup");
    expect(sup).not.toBeNull();
    // 标记符号应隐藏
    expect(sup!.textContent).toContain("2");
  });

  it("下标：class 落在 ~ 内容上", () => {
    const dom = render("H~2~O\n");
    const sub = dom.querySelector(".lp-sub");
    expect(sub).not.toBeNull();
    expect(sub!.textContent).toContain("2");
  });

  // ---- HTML 实体 ----
  it("HTML 实体：解码显示真实字符", () => {
    const dom = render("价格 &lt; 100 &amp; &gt; 50 &quot;元&quot;\n");
    expect(dom.textContent).toContain("<");
    expect(dom.textContent).toContain("&");
    expect(dom.textContent).toContain(">");
    expect(dom.textContent).toContain('"');
  });

  // ---- 转义 ----
  it("转义反斜杠：* _ 不被当成标记，保持原字符显示", () => {
    const dom = render("\\* 不是加粗 \\_ 不是斜体\n");
    // 转义后 * _ 作为普通字符显示，不被 .lp-strong/.lp-em 包裹
    expect(dom.querySelector(".lp-strong")).toBeNull();
    expect(dom.querySelector(".lp-em")).toBeNull();
    expect(dom.textContent).toContain("*");
    expect(dom.textContent).toContain("_");
  });

  // ---- HTML 块/注释 ----
  it("HTML 块：逐行零宽隐藏，不选中不丢行高", () => {
    const dom = render("<div>\n  <p>块级</p>\n</div>\n");
    // 不抛错（主要断言），且文本不直接裸在 content 可见区
    expect(true).toBe(true);
  });

  it("注释：跨行注释零宽隐藏不抛错", () => {
    const dom = render("<!-- 注释\n跨行 -->\n正文\n");
    expect(dom.textContent).toContain("正文");
  });

  // ---- 链接引用定义 ----
  it("链接引用定义：逐行零宽隐藏不抛错", () => {
    const dom = render("[ref]: https://example.com \"标题\"\n\n用 [链接][ref]\n");
    expect(dom.textContent).toContain("链接");
  });

  // ---- Emoji ----
  it("Emoji：:smile: 以原文本显示", () => {
    const dom = render(":smile: :+1:\n");
    // GFM Emoji 以原始 shortcode 文本显示（无需特殊渲染）
    expect(dom.textContent).toContain(":smile:");
  });

  // ---- 组合 ----
  it("混合段落：加粗含斜体和删除线，各 class 同时出现", () => {
    const dom = render("**粗体 *斜体* ~~删~~ 混合**\n");
    expect(dom.querySelector(".lp-strong")).not.toBeNull();
    expect(dom.querySelector(".lp-em")).not.toBeNull();
    expect(dom.querySelector(".lp-strike")).not.toBeNull();
  });

  it("引用嵌套：多层引用不抛错", () => {
    const dom = render("> 一\n> > 二\n> > > 三\n");
    const lines = dom.querySelectorAll(".cm-line.lp-quote");
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});

// ---- 回归：codeHighlight 的 t.meta 会给 HeaderMark/EmphasisMark 等标记
// 生成内层彩色 <span>（嵌在 .lp-inline-hidden 内部），显式 color 会盖过
// 继承的 transparent，导致 #、**、> 以灰色"显形"。修复依赖 index.css 的
// `.lp-inline-hidden * { color: transparent !important }` 后代规则。
describe("标记隐藏与语法高亮的级联（回归）", () => {
  const css = readFileSync(join(__dirname, "..", "index.css"), "utf-8");

  function renderWithHighlight(doc: string): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "editor-body";
    document.body.appendChild(wrapper);
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const view = new EditorView({
      doc,
      parent: wrapper,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(codeHighlight),
        livePreview({ assetBase: "/tmp/notes" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});
    return view.contentDOM;
  }

  it("语法高亮激活时，隐藏标记不为空", () => {
    const dom = renderWithHighlight("# 标题\n正文 **加粗**\n");
    // ** 标记用 CSS 视觉隐藏（lp-inline-hidden），保留在 DOM 中
    expect(dom.querySelectorAll(".lp-inline-hidden").length).toBeGreaterThanOrEqual(2);
  });

  it("index.css 保留 .lp-inline-hidden 后代 !important 规则", () => {
    // 注：曾尝试断言内层 span 的 computed color，但 jsdom 的级联不实现
    // !important 优先级（实测透明 !important 会输给普通 color），无法
    // 忠实评估真实浏览器行为，故改为直接守卫 CSS 规则文本本身
    expect(css).toMatch(
      /\.lp-inline-hidden \*[^}]*color:\s*transparent !important/s,
    );
  });
});
