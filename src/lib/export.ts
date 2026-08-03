// src/lib/export.ts
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/tauri";
import { exportStyles } from "@/lib/exportStyles";
import { extractRichBlocks, renderRichBlocks } from "@/lib/exportRich";
import { isMac } from "@/lib/platform";
import { HL_ALIASES } from "./highlight";

// 配置 marked：代码块使用 highlight.js 语法高亮
marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code: string, lang: string) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

// 高亮 =={色}…==：与编辑器 livePreview 同语法。inline 扩展在内置
// codespan 之后执行，`==` 在行内代码里不受影响；`\=` 由内置 escape
// tokenizer 先行消费，转义高亮自然失效。
// 自定义 inline tokenizer 默认不递归解析内容——用 this.lexer.inline 重新
// 词法化，高亮内可嵌套加粗/链接（内容不含 ==，非贪婪保证不会递归匹配自身）。
marked.use({
  extensions: [
    {
      name: "highlight",
      level: "inline",
      start(src: string) {
        return src.indexOf("==");
      },
      tokenizer: function (this: import("marked").TokenizerThis, src: string) {
        const m = /^==(\{([^}=]*)\})?([\s\S]*?)==/.exec(src);
        if (!m) return undefined;
        return {
          type: "highlight",
          raw: m[0],
          color: m[1] ? m[2] : null,
          text: m[3],
          tokens: this.lexer.inline(m[3]),
        } as import("marked").Tokens.Generic;
      },
      renderer: function (this: import("marked").RendererThis, token: import("marked").Tokens.Generic) {
        const t = token as import("marked").Tokens.Generic & {
          color: string | null;
          text: string;
          tokens: import("marked").Tokens.Generic[];
        };
        const color = t.color ? (HL_ALIASES[t.color] ?? null) : null;
        // 未知 token 保留字面（与编辑器降级一致）
        const prefix = t.color && !color ? `{${t.color}}` : "";
        return `<mark class="${color ? `hl-${color}` : "hl-default"}">${prefix}${this.parser.parseInline(t.tokens)}</mark>`;
      },
    },
  ],
});

export type ExportFormat = "html" | "pdf" | "png" | "docx" | "epub" | "latex";

const EXT_MAP: Record<ExportFormat, string> = {
  html: "html", pdf: "pdf", png: "png",
  docx: "docx", epub: "epub", latex: "tex",
};

const FILTER_MAP: Record<ExportFormat, { name: string; extensions: string[] }> = {
  html:  { name: "HTML",        extensions: ["html"] },
  pdf:   { name: "PDF",         extensions: ["pdf"] },
  png:   { name: "PNG 图片",    extensions: ["png"] },
  docx:  { name: "Word 文档",   extensions: ["docx"] },
  epub:  { name: "EPUB 电子书", extensions: ["epub"] },
  latex: { name: "LaTeX",       extensions: ["tex"] },
};

const PANDOC_FORMATS: ExportFormat[] = ["docx", "epub", "latex"];

export function isPandocFormat(format: ExportFormat): boolean {
  return PANDOC_FORMATS.includes(format);
}

/**
 * 将 Markdown 渲染为完整的自包含 HTML 文档。
 * 数学公式（KaTeX）与 Mermaid 图表先提取为占位符，marked 解析后替换为
 * 渲染好的 HTML/SVG；含公式时内联 KaTeX CSS + woff2 字体（data URI）。
 */
export async function renderHtml(markdown: string): Promise<string> {
  const { text, blocks } = extractRichBlocks(markdown);
  let body = marked.parse(text, { async: false }) as string;
  let katexStyle = "";

  if (blocks.length > 0) {
    const { html, hasMath } = await renderRichBlocks(blocks);
    for (const [token, richHtml] of html) {
      // 块级占位符独占一段，marked 会包一层 <p>，优先整段替换避免 div 嵌进 p
      body = body.replace(`<p>${token}</p>`, richHtml).replace(token, richHtml);
    }
    if (hasMath) {
      const { katexStyleTag } = await import("@/lib/exportKatexAssets");
      katexStyle = katexStyleTag();
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${exportStyles}</style>
${katexStyle}
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * 导出为 HTML 文件。
 */
async function exportHtml(markdown: string, title: string): Promise<string | null> {
  const destPath = await save({
    defaultPath: `${title}.html`,
    filters: [FILTER_MAP.html],
  });
  if (!destPath) return null;
  const html = await renderHtml(markdown);
  await api.exportFileText(destPath, html);
  return destPath;
}

/**
 * 导出为 PDF。
 * - macOS：WKWebView 不实现 window.print()，走原生离屏 webview 渲染（矢量 PDF，直接写文件）。
 * - Linux/Windows：通过浏览器打印对话框 → "另存为 PDF"。
 */
async function exportPdf(markdown: string, title: string): Promise<string | null> {
  if (isMac) {
    const destPath = await save({
      defaultPath: `${title}.pdf`,
      filters: [FILTER_MAP.pdf],
    });
    if (!destPath) return null;
    const html = await renderHtml(markdown);
    await api.exportPdfNative(destPath, html);
    return destPath;
  }

  const html = await renderHtml(markdown);

  return new Promise<string | null>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-9999px";
    iframe.style.top = "0";
    iframe.style.width = "800px";
    iframe.style.height = "600px";
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
      document.body.removeChild(iframe);
      return reject(new Error("无法创建打印文档"));
    }

    doc.open();
    doc.write(html);
    doc.close();

    const doPrint = async () => {
      // 等内联的 KaTeX 字体加载完再打印，否则公式缺字形
      try { await doc.fonts.ready; } catch { /* 字体 API 不可用时直接打印 */ }
      try {
        iframe.contentWindow?.print();
        // print() 在大多数浏览器中是同步的（对话框弹出时）
        resolve(null);
      } catch (e) {
        reject(e);
      }
      // 延迟清理，等打印对话框出现
      setTimeout(() => {
        if (iframe.parentNode) document.body.removeChild(iframe);
      }, 2000);
    };

    if (doc.readyState === "complete") {
      doPrint();
    } else {
      iframe.onload = doPrint;
    }
  });
}

/**
 * 导出为 PNG 图片。
 */
async function exportPng(markdown: string, title: string): Promise<string | null> {
  const destPath = await save({
    defaultPath: `${title}.png`,
    filters: [FILTER_MAP.png],
  });
  if (!destPath) return null;

  const html = await renderHtml(markdown);

  // 在隐藏 iframe 中渲染，确保 CSS 在独立文档上下文中完整生效
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.left = "-9999px";
  iframe.style.top = "0";
  iframe.style.width = "828px";
  iframe.style.height = "600px";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) {
    document.body.removeChild(iframe);
    throw new Error("无法创建渲染文档");
  }

  doc.open();
  doc.write(html);
  doc.close();

  try {
    await doc.fonts.ready;

    // 将 iframe 高度撑开到内容实际高度
    const contentHeight =
      doc.documentElement.scrollHeight || doc.body.scrollHeight;
    iframe.style.height = `${contentHeight}px`;

    // snapdom 把 DOM 序列化为 SVG foreignObject，由浏览器自身引擎栅格化，
    // CSS 变量、border-radius、现代颜色函数等全部原生支持，样式与编辑器一致。
    // 捕获 documentElement（含 body margin 居中区域）。
    const { snapdom } = await import("@zumer/snapdom");
    const blob = await snapdom.toBlob(doc.documentElement, {
      scale: 2,
      backgroundColor: "#ffffff",
      type: "png",
    });

    const buffer = await blob.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buffer));
    await api.exportFile(destPath, bytes);
    return destPath;
  } finally {
    document.body.removeChild(iframe);
  }
}

/**
 * 通过 Pandoc 导出。
 * 若 Pandoc 不可用，调用 onPandocUnavailable 引导安装，
 * 返回 true 表示用户完成安装（或跳过），继续导出流程。
 */
async function exportViaPandoc(
  sourceFile: string,
  format: ExportFormat,
  title: string,
  onPandocUnavailable: () => Promise<boolean>,
): Promise<string | null> {
  let available = await api.checkPandocAvailable();
  if (!available) {
    const installed = await onPandocUnavailable();
    if (!installed) return null;
    // 用户声称安装完成，再确认一次
    available = await api.checkPandocAvailable();
    if (!available) return null;
  }

  const ext = EXT_MAP[format];
  const destPath = await save({
    defaultPath: `${title}.${ext}`,
    filters: [FILTER_MAP[format]],
  });
  if (!destPath) return null;

  await api.pandocExport(sourceFile, destPath);
  return destPath;
}

/**
 * 统一导出入口。HTML/PDF/PNG 用 markdown 内容，
 * Pandoc 格式从 sourceFile 磁盘路径读取（自动保存已保证最新）。
 */
export async function exportNote(
  markdown: string,
  sourceFile: string,
  title: string,
  format: ExportFormat,
  onPandocUnavailable: () => Promise<boolean>,
): Promise<string | null> {
  switch (format) {
    case "html":
      return exportHtml(markdown, title);
    case "pdf":
      return exportPdf(markdown, title);
    case "png":
      return exportPng(markdown, title);
    case "docx":
    case "epub":
    case "latex":
      return exportViaPandoc(sourceFile, format, title, onPandocUnavailable);
  }
}
