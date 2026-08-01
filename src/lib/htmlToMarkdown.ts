// 富文本粘贴 → Markdown：读取剪贴板的 text/html，清洗后经 turndown 转成 markdown 源码。
//
// 触发判定（isRichHtml）：text/html 剥掉标签后的文本与 text/plain 一致，才说明剪贴板是
// "同一段内容的富文本呈现"（网页复制），此时才转换；不一致时（如复制的代码片段，
// text/plain 是源码）直接走默认纯文本粘贴，不转换。
//
// 图片策略（分类处理 <img> 的 src）：
//   - 远程 http(s) URL     → 保留 ![alt](url)
//   - data:image base64    → base64 解码 → save_asset 落到 .assets/ → 改写为相对引用
//   - file:// / 绝对路径   → import_files 复制到 .assets/ → 改写为相对引用
//   - 无 base 可解析的相对路径 → 无法落地，保留原样
//   - 其他 scheme（javascript: 等）→ 丢弃该图
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { api } from "./tauri";
import { relativePath } from "./utils";

export interface HtmlToMarkdownContext {
  notesDir: string;
  /** 当前笔记文件的绝对路径，用于计算 .assets 相对引用 */
  currentFilePath: string;
}

/** 需要整体移除的危险/无关标签（剪贴板 HTML 不可信） */
const REMOVE_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "noscript",
  "template",
  "form",
]);

/** data URI 的 mime 子类型 → 扩展名（白名单，未知落回 png） */
const MIME_EXT: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  jpg: "jpg",
  gif: "gif",
  webp: "webp",
  "svg+xml": "svg",
  bmp: "bmp",
  avif: "avif",
};

/** 块级标签：提取可见文本时在这些元素边界插入换行，避免块间文字粘连 */
const BLOCK_RE =
  /^(p|div|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|pre|blockquote|br)$/i;

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
/** 类 HTML 源码的特征：<tag ...> / </tag> 成对出现（用于排除复制的代码片段） */
const HTML_SOURCE_RE = /<\/?[a-z][a-z0-9]*[^>]*>/i;

/** 当前笔记文件所在目录（与 Editor.tsx 图片粘贴一致） */
function dirOf(filePath: string): string {
  return filePath.substring(0, filePath.lastIndexOf("/") + 1);
}

/** 提取元素可见文本，块级边界插入换行，便于与 text/plain 做归一化比较 */
export function extractVisibleText(el: Element): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      const inner = extractVisibleText(child);
      out += BLOCK_RE.test(child.tagName) ? `\n${inner}\n` : inner;
    }
  }
  return out;
}

/**
 * 判定剪贴板 HTML 是否值得转 markdown：
 *  1) 剥标签后的可见文本（归一化空白）与 text/plain 一致 → 富文本呈现同一内容
 *  2) text/plain 本身是 HTML 源码（复制的代码片段）→ 排除，走纯文本
 */
export function isRichHtml(html: string, plainText: string): boolean {
  if (!html || !plainText) return false;
  if (HTML_SOURCE_RE.test(plainText)) return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const stripped = extractVisibleText(doc.body);
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return norm(stripped) === norm(plainText);
}

/** 清洗不可信 HTML：移除危险标签、on* 事件属性与内联样式（保留 class 供代码语言识别） */
export function sanitizeHtml(root: Element): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (REMOVE_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style") {
        el.removeAttribute(attr.name);
      }
    }
  }
  // javascript:/vbscript: 链接降级为纯文本（去掉 href，保留可见文字）
  for (const a of Array.from(root.querySelectorAll("a"))) {
    const href = a.getAttribute("href") ?? "";
    if (/^\s*(javascript|vbscript):/i.test(href)) {
      a.removeAttribute("href");
    }
  }
}

export type ImageSrcClass =
  | { kind: "keep" }
  | { kind: "drop" }
  | { kind: "dataUri"; mime: string; base64: string }
  | { kind: "localFile"; path: string };

/** 按 src 形态分类 <img>，决定保留 / 下载 / 丢弃 */
export function classifyImageSrc(src: string): ImageSrcClass {
  const trimmed = src.trim();
  if (!trimmed) return { kind: "drop" };

  // Windows 盘符绝对路径（C:\... / C:/...）必须先于 scheme 判断，
  // 否则 "C:" 会被 SCHEME_RE 当成 scheme → 误判为 drop
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return { kind: "localFile", path: trimmed };
  }
  // unix 绝对路径
  if (trimmed.startsWith("/")) {
    return { kind: "localFile", path: trimmed };
  }

  const data = trimmed.match(/^data:(image\/[a-z0-9+.-]+)(;base64)?,(.*)$/i);
  if (data) {
    // 仅支持 base64 编码的位图；非 base64 / 非 image 的 data URI 无法可靠落地
    if (!data[2]) return { kind: "drop" };
    return { kind: "dataUri", mime: data[1].toLowerCase(), base64: data[3] };
  }

  const schemeMatch = trimmed.match(SCHEME_RE);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "http" || scheme === "https") return { kind: "keep" };
    if (scheme === "file") {
      try {
        // file:///Users/x.png → 剥掉 "file://" 保留根斜杠 → /Users/x.png；
        // file:///C:/x.png → /C:/x.png → 再剥盘符前的斜杠 → C:/x.png
        let p = trimmed.replace(/^file:\/\//, "");
        if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
        return { kind: "localFile", path: decodeURIComponent(p) };
      } catch {
        return { kind: "drop" };
      }
    }
    return { kind: "drop" }; // javascript:/blob:/cid:/mailto: 等
  }

  // 相对路径（./ ../ 裸文件名）无 base 可解析，保留原样
  return { kind: "keep" };
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomFileName(ext: string): string {
  return `paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
}

/**
 * 将不可信 HTML 转成 markdown：清洗 → 图片落地 → turndown(gfm)。
 * 所有 <img> 处理（含异步保存）完成后才整体转换，保证一次 dispatch 插入完整内容。
 */
export async function htmlToMarkdown(
  html: string,
  ctx: HtmlToMarkdownContext,
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  sanitizeHtml(body);

  const noteDir = dirOf(ctx.currentFilePath);
  for (const img of Array.from(body.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    const action = classifyImageSrc(src);
    if (action.kind === "drop") {
      img.remove();
      continue;
    }
    if (action.kind === "keep") continue;

    try {
      let savedPath = "";
      if (action.kind === "dataUri") {
        const bytes = base64ToBytes(action.base64);
        const sub = action.mime.replace("image/", "");
        const ext = MIME_EXT[sub] ?? "png";
        const saved = await api.saveAsset(
          ctx.notesDir,
          randomFileName(ext),
          Array.from(bytes),
        );
        savedPath = saved.path;
      } else {
        const res = await api.importFiles(ctx.notesDir, [action.path], true);
        savedPath = res.imported[0]?.path ?? "";
      }
      if (savedPath) {
        img.setAttribute("src", relativePath(noteDir, savedPath));
      } else {
        img.remove(); // 落地失败不留下坏引用
      }
    } catch (e) {
      console.warn("粘贴富文本图片保存失败", e);
      img.remove();
    }
  }

  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  turndown.use(gfm);
  // turndown 7.x listItem 硬编码 `-   `（3 空格）对齐，与 Jot 自身 `- ` 单空格风格不一致，
  // 覆写为单空格（有序列表用 `1. `）
  turndown.addRule("listItem", {
    filter: "li",
    replacement(content, node, options) {
      const parent = node.parentNode as Element | null;
      let prefix = options.bulletListMarker + " ";
      if (parent && parent.tagName.toLowerCase() === "ol") {
        const startAttr = parent.getAttribute("start");
        const start = startAttr ? Number(startAttr) : 1;
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start + index}. `;
      }
      content = content.replace(/^\n+/, "");
      content = content.replace(/\n+$/, "\n");
      content = content.replace(/\n/gm, "\n" + " ".repeat(prefix.length));
      return prefix + content + (node.nextSibling ? "\n" : "");
    },
  });
  return turndown.turndown(body).trim();
}
