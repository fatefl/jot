// 导出富渲染：数学公式（KaTeX）与 Mermaid 图表。
// marked 只懂 CommonMark/GFM，$公式$ 和 ```mermaid 会被当普通文本/代码块原样输出。
// 这里在 marked 解析前把它们提取为占位符，解析后再替换回渲染好的 HTML。
// 提取规则与编辑器 livePreview 的 findMath / mermaid 围栏规则保持一致。

export interface RichBlock {
  token: string;
  kind: "math-block" | "math-inline" | "mermaid";
  code: string;
}

// 占位符为纯字母数字，marked 会原样保留为文本
const TOKEN_PREFIX = "JOTEXP";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 提取 mermaid 围栏块与数学公式，返回替换为占位符的 markdown 及块列表。
 * 围栏代码块和行内代码里的 $ 不是公式，先用保护占位符摘出，公式提取完再还原。
 */
export function extractRichBlocks(markdown: string): {
  text: string;
  blocks: RichBlock[];
} {
  const blocks: RichBlock[] = [];
  let seq = 0;
  const push = (kind: RichBlock["kind"], code: string): string => {
    const token = `${TOKEN_PREFIX}${seq++}Z`;
    blocks.push({ token, kind, code });
    return token;
  };

  // ── 第一遍：按行扫描围栏代码块；```mermaid 提取为图表，其余围栏整体保护 ──
  const fences: string[] = [];
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*$/);
    if (open) {
      const marker = open[1];
      const lang = open[2].toLowerCase();
      const closeRe = new RegExp(`^${marker[0]}{${marker.length},}[ \\t]*$`);
      let j = i + 1;
      const codeLines: string[] = [];
      while (j < lines.length && !closeRe.test(lines[j])) {
        codeLines.push(lines[j]);
        j++;
      }
      // j === lines.length 时围栏未闭合，raw 收到文档末尾（与 CommonMark 一致）
      const raw = lines.slice(i, Math.min(j + 1, lines.length)).join("\n");
      if (lang === "mermaid") {
        out.push(push("mermaid", codeLines.join("\n")));
      } else {
        fences.push(raw);
        out.push(`${TOKEN_PREFIX}FENCE${fences.length - 1}Z`);
      }
      i = j + 1;
      continue;
    }
    out.push(lines[i]);
    i++;
  }

  // ── 第二遍：保护行内代码 → 提取公式 → 还原保护内容 ──
  let text = out.join("\n");
  const inlineCodes: string[] = [];
  text = text.replace(/`[^`\n]+`/g, (m) => {
    inlineCodes.push(m);
    return `${TOKEN_PREFIX}CODE${inlineCodes.length - 1}Z`;
  });
  // 块级公式 $$...$$（可跨行，规则同 livePreview.findMath）
  text = text.replace(
    /(?:^|\n)(\$\$)\n?([\s\S]*?)\n?\1/gm,
    (m, _d: string, formula: string) => {
      const f = formula.trim();
      if (!f) return m;
      const token = push("math-block", f);
      return m.startsWith("\n") ? `\n${token}` : token;
    },
  );
  // 行内公式 $...$（不跨行，不匹配 $$）
  text = text.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (_m, formula: string) =>
    push("math-inline", formula),
  );
  text = text.replace(
    new RegExp(`${TOKEN_PREFIX}FENCE(\\d+)Z`, "g"),
    (_m, n: string) => fences[Number(n)],
  );
  text = text.replace(
    new RegExp(`${TOKEN_PREFIX}CODE(\\d+)Z`, "g"),
    (_m, n: string) => inlineCodes[Number(n)],
  );

  return { text, blocks };
}

/**
 * 渲染提取出的块：公式 → KaTeX HTML，mermaid → SVG。
 * 导出固定白底，mermaid 用 default 主题；渲染完把全局 mermaid 主题
 * 恢复为编辑器当前明暗，避免污染编辑器后续渲染（共享同一模块实例）。
 * 返回 token → HTML 的映射及是否含公式（决定是否内联 KaTeX 字体 CSS）。
 */
export async function renderRichBlocks(
  blocks: RichBlock[],
): Promise<{ html: Map<string, string>; hasMath: boolean }> {
  const html = new Map<string, string>();
  const hasMath = blocks.some((b) => b.kind !== "mermaid");

  if (hasMath) {
    const { default: katex } = await import("katex");
    for (const b of blocks) {
      if (b.kind === "mermaid") continue;
      const rendered = katex.renderToString(b.code, {
        displayMode: b.kind === "math-block",
        throwOnError: false,
      });
      html.set(
        b.token,
        b.kind === "math-block"
          ? `<div class="export-math-block">${rendered}</div>`
          : rendered,
      );
    }
  }

  const mermaids = blocks.filter((b) => b.kind === "mermaid");
  if (mermaids.length > 0) {
    const { default: mermaid } = await import("mermaid");
    const dark = document.documentElement.classList.contains("dark");
    // 与编辑器一致：strict 消毒、纯 SVG 文本标签（保证导出 SVG 文字不丢）
    mermaid.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "strict",
      flowchart: { htmlLabels: false },
    });
    let n = 0;
    try {
      for (const b of mermaids) {
        try {
          const { svg } = await mermaid.render(`export-mermaid-${n++}`, b.code);
          html.set(b.token, `<div class="export-mermaid">${svg}</div>`);
        } catch {
          html.set(
            b.token,
            `<pre class="export-mermaid-error">图表语法错误\n${escapeHtml(b.code)}</pre>`,
          );
        }
      }
    } finally {
      mermaid.initialize({
        startOnLoad: false,
        theme: dark ? "dark" : "default",
        securityLevel: "strict",
        flowchart: { htmlLabels: false },
      });
    }
  }

  return { html, hasMath };
}
