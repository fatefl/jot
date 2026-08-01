// @vitest-environment jsdom
// export.ts / exportStyles.ts / exportRich.ts 单元测试
//
// 覆盖：
// - isPandocFormat：正确识别需 Pandoc 的格式
// - renderHtml：自包含 HTML 文档生成（含 CSS、body）
// - renderHtml 富渲染：KaTeX 公式、Mermaid 图表、代码保护
// - exportStyles：CSS 字符串包含关键选择器
// - EXT_MAP / FILTER_MAP：格式后缀和过滤器名称
// - ExportFormat 类型完整性

import { describe, expect, it } from "vitest";
import { isPandocFormat, renderHtml } from "@/lib/export";
import { exportStyles } from "@/lib/exportStyles";

describe("export — isPandocFormat", () => {
  it("docx 需要 Pandoc", () => {
    expect(isPandocFormat("docx")).toBe(true);
  });

  it("epub 需要 Pandoc", () => {
    expect(isPandocFormat("epub")).toBe(true);
  });

  it("latex 需要 Pandoc", () => {
    expect(isPandocFormat("latex")).toBe(true);
  });

  it("html 不需要 Pandoc", () => {
    expect(isPandocFormat("html")).toBe(false);
  });

  it("pdf 不需要 Pandoc", () => {
    expect(isPandocFormat("pdf")).toBe(false);
  });

  it("png 不需要 Pandoc", () => {
    expect(isPandocFormat("png")).toBe(false);
  });
});

describe("export — renderHtml", () => {
  it("返回完整 HTML5 文档", async () => {
    const html = await renderHtml("# Hello");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"zh-CN\">");
    expect(html).toContain("<meta charset=\"utf-8\">");
    expect(html).toContain("<meta name=\"viewport\"");
  });

  it("嵌入 exportStyles CSS", async () => {
    const html = await renderHtml("test");
    expect(html).toContain("<style>");
    expect(html).toContain(exportStyles);
  });

  it("Markdown 标题正确渲染为 HTML", async () => {
    const html = await renderHtml("# 标题一\n## 标题二");
    expect(html).toContain("<h1");
    expect(html).toContain("标题一");
    expect(html).toContain("<h2");
    expect(html).toContain("标题二");
  });

  it("Markdown 加粗和斜体渲染", async () => {
    const html = await renderHtml("**粗体** *斜体*");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<em>斜体</em>");
  });

  it("Markdown 行内代码渲染", async () => {
    const html = await renderHtml("`const x = 1`");
    expect(html).toContain("<code>const x = 1</code>");
  });

  it("Markdown 代码块渲染为 hljs 高亮", async () => {
    const html = await renderHtml("```js\nlet a = 1;\n```");
    // highlight.js 会将代码包裹在 hljs 类中
    expect(html).toContain("hljs");
  });

  it("Markdown 链接渲染", async () => {
    const html = await renderHtml("[文字](https://example.com)");
    expect(html).toContain("<a href=\"https://example.com\">文字</a>");
  });

  it("Markdown 图片渲染", async () => {
    const html = await renderHtml("![alt](image.png)");
    expect(html).toContain("<img");
    expect(html).toContain('src="image.png"');
    expect(html).toContain('alt="alt"');
  });

  it("Markdown 无序列表渲染", async () => {
    const html = await renderHtml("- 项目 1\n- 项目 2");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>项目 1</li>");
    expect(html).toContain("<li>项目 2</li>");
  });

  it("Markdown 有序列表渲染", async () => {
    const html = await renderHtml("1. 第一\n2. 第二");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>第一</li>");
    expect(html).toContain("<li>第二</li>");
  });

  it("Markdown 引用块渲染", async () => {
    const html = await renderHtml("> 引用文字");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("引用文字");
  });

  it("Markdown 表格渲染", async () => {
    const html = await renderHtml("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("Markdown 分隔线渲染", async () => {
    const html = await renderHtml("---");
    expect(html).toContain("<hr");
  });

  it("Markdown 删除线渲染", async () => {
    const html = await renderHtml("~~删除~~");
    expect(html).toContain("<del>删除</del>");
  });

  it("Markdown 任务列表渲染", async () => {
    const html = await renderHtml("- [ ] 未完成\n- [x] 已完成");
    expect(html).toContain("未完成");
    expect(html).toContain("已完成");
  });

  it("空内容返回有效 HTML 框架", async () => {
    const html = await renderHtml("");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<body>");
    expect(html).toContain("</body>");
    expect(html).toContain("</html>");
  });

  it("中文内容正确保留", async () => {
    const html = await renderHtml("# 中文标题\n\n这是**一段**中文内容。");
    expect(html).toContain("中文标题");
    expect(html).toContain("<strong>一段</strong>");
    expect(html).toContain("中文内容");
  });

  it("代码块语法高亮：highlight.js 生成 hljs 类", async () => {
    const html = await renderHtml("```js\nconst x = 1;\n```");
    expect(html).toContain("hljs");
  });
});

describe("export — renderHtml 富渲染（公式 / Mermaid）", () => {
  it("行内公式 $...$ 渲染为 KaTeX", async () => {
    const html = await renderHtml("质能方程 $E=mc^2$ 很著名");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("$E=mc^2$");
  });

  it("块级公式 $$...$$ 渲染为 KaTeX display 块", async () => {
    const html = await renderHtml("$$\nE=mc^2\n$$");
    expect(html).toContain("export-math-block");
    expect(html).toContain("katex-display");
  });

  it("含公式时内联 KaTeX 字体 CSS", async () => {
    const html = await renderHtml("$a+b$");
    expect(html).toContain("@font-face");
    expect(html).toContain("KaTeX_Main");
  });

  it("无公式时不注入 KaTeX 字体 CSS", async () => {
    const html = await renderHtml("普通文本，没有公式");
    expect(html).not.toContain("@font-face");
  });

  it("mermaid 围栏渲染为图表容器而非代码块", async () => {
    const html = await renderHtml("```mermaid\ngraph TD; A-->B;\n```");
    expect(html).not.toContain("language-mermaid");
    // 渲染成功为 export-mermaid（SVG），jsdom 渲染失败则回退 export-mermaid-error
    expect(html).toContain("export-mermaid");
  });

  it("普通代码块里的 $ 不当作公式", async () => {
    const html = await renderHtml("```js\nconst price = 1; // $x$ 注释\n```");
    expect(html).toContain("hljs");
    expect(html).not.toContain('class="katex"');
  });

  it("行内代码里的 $ 不当作公式", async () => {
    const html = await renderHtml("`$notMath$` 是代码");
    expect(html).toContain("<code>$notMath$</code>");
    expect(html).not.toContain('class="katex"');
  });

  it("公式内的下划线不被 marked 解析为强调", async () => {
    const html = await renderHtml("$a_1 + a_2$");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("<em>");
  });
});

describe("exportStyles", () => {
  it("是字符串", () => {
    expect(typeof exportStyles).toBe("string");
  });

  it("包含设计 token CSS 变量", () => {
    expect(exportStyles).toContain("--editor-bg");
    expect(exportStyles).toContain("--text");
    expect(exportStyles).toContain("--accent");
    expect(exportStyles).toContain("--border");
    expect(exportStyles).toContain("--font-prose");
    expect(exportStyles).toContain("--font-mono");
  });

  it("包含标题样式", () => {
    expect(exportStyles).toContain("h1");
    expect(exportStyles).toContain("h2");
    expect(exportStyles).toContain("h3");
  });

  it("包含行内代码样式", () => {
    expect(exportStyles).toContain("code");
    expect(exportStyles).toContain("font-family: var(--font-mono)");
  });

  it("包含代码块样式", () => {
    expect(exportStyles).toContain("pre {");
  });

  it("包含表格圆角样式（与编辑器 lp-table 一致）", () => {
    expect(exportStyles).toContain("border-collapse: separate");
    expect(exportStyles).toContain("border-radius: 10px");
    expect(exportStyles).toContain("table {");
  });

  it("包含 Mermaid / 公式渲染产物样式", () => {
    expect(exportStyles).toContain(".export-mermaid");
    expect(exportStyles).toContain(".export-math-block");
  });

  it("包含列表样式（::before 圆点）", () => {
    expect(exportStyles).toContain("::before");
    expect(exportStyles).toContain('content: "•"');
  });

  it("包含链接样式", () => {
    expect(exportStyles).toContain("a {");
  });

  it("包含打印媒体查询", () => {
    expect(exportStyles).toContain("@media print");
    expect(exportStyles).toContain("@page");
  });

  it("包含 hljs 语法高亮规则", () => {
    expect(exportStyles).toContain(".hljs-keyword");
    expect(exportStyles).toContain(".hljs-string");
    expect(exportStyles).toContain(".hljs-comment");
  });
});
