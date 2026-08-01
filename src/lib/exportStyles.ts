/**
 * 导出用 CSS 样式表。
 * 对齐编辑器 WYSIWYG 效果（版心/字号/标题/链接/间距）。
 *   - 列表用 ::before 圆点替代 ::marker，与编辑器项目符号样式一致；
 *     任务列表项用 :has() 排除圆点（编辑器只显示勾选框）
 *   - 链接下划线参数与 lp-link 一致
 *   - 表格与编辑器一致用 separate + border-radius 圆角
 * PNG 导出由 snapdom 栅格化（浏览器引擎渲染），无需针对 rasterizer 的回退样式。
 */
export const exportStyles = /* css */ `
/* ---- 设计 token（与 editor 亮色主题一致） ---- */
:root {
  --editor-bg: #fafbfc;
  --sidebar-bg: #f0f2f5;
  --hover: #e8ecf1;
  --border: #dde1e6;
  --text: #1a1d23;
  --text-secondary: #88909b;
  --accent: #6366F1;
  --accent-soft: rgba(99, 102, 241, 0.08);
  --font-prose: "Noto Sans CJK SC", "Noto Sans", system-ui, -apple-system,
    "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --font-mono: "Noto Sans Mono", "JetBrains Mono", "DejaVu Sans Mono",
    ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  /* WebKit 打印默认丢弃背景色（代码块/行内代码/表头底色会消失），强制按屏幕颜色输出 */
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* 编辑器根字号 15px（index.css html），导出对齐之，body 用 1rem 继承 */
html { font-size: 15px; }

body {
  font-family: var(--font-prose);
  font-size: 1rem; /* 与编辑器 .cm-editor 1rem 一致（15px） */
  line-height: 1.75;
  color: var(--text);
  background: #fff;
  max-width: 1100px; /* 与编辑器版心一致 */
  margin: 0 auto;
  padding: 32px 48px; /* 与编辑器 .cm-content 一致（底部 120px 是光标留白，导出不需要） */
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

/* ---- 标题（与 lp-h* 一致：字重 600、letter-spacing、padding 间距） ---- */
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-prose);
  line-height: 1.35;
  color: var(--text);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
  padding-top: 0.6em;
  padding-bottom: 0.15em;
}
h1 { font-size: 2em; }
h2 { font-size: 1.6em; }
h3 { font-size: 1.3em; }
h4 { font-size: 1.15em; }
h5 { font-size: 1em; }
h6 { font-size: 0.9em; color: var(--text-secondary); }

/* ---- 内联强调 ---- */
strong { font-weight: 600; }
em { font-style: italic; }
del { text-decoration: line-through; }

/* ---- 链接（与 lp-link 一致：1px 下划线 + 偏移 + 浅色下划线色） ---- */
a {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  text-decoration-color: var(--accent-soft);
}

/* ---- 行内代码（与 lp-inline-code 一致） ---- */
:not(pre) > code {
  background: var(--hover);
  padding: 0.12em 0.4em;
  border-radius: 5px;
  font-family: var(--font-mono);
  font-size: 0.88em;
  color: var(--text);
}

/* ---- 代码块（与 lp-code-line 一致；pre-wrap 避免导出时长行溢出） ---- */
pre {
  background: var(--sidebar-bg);
  font-family: var(--font-mono);
  font-size: 0.9em;
  line-height: 1.55;
  padding: 0.5em 16px;
  border-radius: 10px;
  margin: 0.5em 0;
  white-space: pre-wrap;
  word-wrap: break-word;
}
pre code { background: none; padding: 0; font-size: inherit; color: inherit; }

/* ---- 引用块（与 lp-quote 一致） ---- */
blockquote {
  border-left: 3px solid var(--border);
  padding-left: 16px;
  color: var(--text-secondary);
  margin: 0.5em 0;
}
blockquote p { margin: 0; } /* 编辑器引用为连续行，无额外段距 */

/* ---- 分割线 ---- */
hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}

/* ---- 表格（与编辑器 lp-table 一致：separate + 圆角外框，单元格只留左/上内部分隔线） ---- */
table {
  border-collapse: separate;
  border-spacing: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  font-size: 0.92em;
  width: fit-content;
  max-width: 100%;
  margin: 0.5em 0;
}
th, td {
  border: none;
  border-left: 1px solid var(--border);
  border-top: 1px solid var(--border);
  padding: 6px 12px;
  text-align: left;
}
/* 首行/首列不画内部分隔线，外框已由 table 提供 */
tr:first-child > :is(th, td) { border-top: none; }
tr > :is(th, td):first-child { border-left: none; }
th {
  background: var(--sidebar-bg);
  font-weight: 600;
}

/* ---- Mermaid 图表 / 数学公式（exportRich.ts 渲染产物） ---- */
.export-mermaid { margin: 0.5em 0; text-align: center; }
.export-mermaid svg { max-width: 100%; height: auto; }
.export-math-block { margin: 0.5em 0; text-align: center; overflow-x: auto; }
.export-mermaid-error {
  color: var(--text-secondary);
  font-size: 12px;
  background: var(--sidebar-bg);
  border-radius: 10px;
  padding: 0.5em 16px;
  white-space: pre-wrap;
}

/* ---- 列表：::before 画圆点，与编辑器项目符号一致 ---- */
ul {
  list-style: none;
  padding-left: 1.8em;
  margin: 0.3em 0;
}
ul > li::before {
  content: "•";
  position: absolute;
  left: -1.2em;
  color: var(--text);
  font-weight: 700;
}
/* 任务列表项编辑器只显示勾选框、无圆点。
   marked 对任务项可能包 <p>（<li><p><input>…），故用后代选择器而非直接子选择器。
   :has 需 WebKit 15.4+/Chromium 105+。
   注意：模板字符串注释内不能写反引号，会提前终止字符串。 */
ul > li:has(input[type="checkbox"])::before {
  content: none;
}
li {
  position: relative;
}

ol {
  list-style-type: decimal;
  padding-left: 1.8em;
  margin: 0.3em 0;
}

/* ---- 任务列表 ---- */
input[type="checkbox"] {
  margin-right: 4px;
  vertical-align: -1px;
  pointer-events: none;
}

/* ---- 图片（与 lp-image 一致：圆角 10px；编辑器为行内块，导出块级布局） ---- */
img { max-width: 100%; height: auto; border-radius: 10px; margin: 0.4em 0; }

/* ---- 段落（编辑器段落间无额外间距，纯行高） ---- */
p { margin: 0; }

/* ---- 代码块语法高亮 ---- */
.hljs-keyword,
.hljs-selector-tag,
.hljs-selector-class,
.hljs-selector-id { color: #d14b4b; }

.hljs-string,
.hljs-regexp,
.hljs-addition { color: #1a6b8a; }

.hljs-comment,
.hljs-quote,
.hljs-deletion,
.hljs-meta { color: #88909b; font-style: italic; }

.hljs-number,
.hljs-literal { color: #0070d8; }

.hljs-title.function_,
.hljs-title.class_ { color: #8b6ce0; }

.hljs-type,
.hljs-built_in,
.hljs-title.class_,
.hljs-class .hljs-title { color: #c07830; }

.hljs-attr,
.hljs-attribute,
.hljs-property { color: #2a8a4a; }

.hljs-variable,
.hljs-params,
.hljs-template-variable { color: var(--text); }

.hljs-symbol,
.hljs-bullet,
.hljs-link { color: var(--accent); }

.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }

/* ---- 打印适配 ---- */
@media print {
  body { padding: 0; max-width: none; }
  pre { white-space: pre-wrap; word-break: break-all; }
  @page { margin: 18mm; size: A4; }
}
`;
