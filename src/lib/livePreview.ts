// CM6 即时渲染（Live Preview 路线）：
// markdown 文本是唯一事实源，本扩展只做"视觉装饰"——把标记符号
// （**、#、``` 等）隐藏或替换成渲染效果：
// 光标进入节点也【不】还原源码（用户要求可视区域永远不显示代码），
// 需要改源码时切到源码模式。不存在 AST → markdown 的序列化往返，
// 文件内容零失真。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  Range,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

interface LivePreviewOptions {
  /** 当前笔记所在目录，用于把相对路径图片解析为可加载的 asset URL。
   *  缺省时读取 setLivePreviewAssetBase 设置的全局值——编辑器保持单视图
   *  按 tab 切换 EditorState，extensions 必须跨文件稳定，不能按文件传入 */
  assetBase?: string;
}

// 当前活动笔记的 assetBase（缺省回退值）：由 EditorPanel 挂载与 tab 切换时更新
let currentAssetBase: string | undefined;

/** 主 ViewPlugin 实例注册表：供 __snapshotDecorations 读取行内装饰（测试用） */
interface MainDecoPlugin {
  decorations: DecorationSet;
}
const mainDecoViews = new WeakMap<EditorView, MainDecoPlugin>();


/** 设置全局 assetBase（相对路径图片解析基准目录） */
export function setLivePreviewAssetBase(base: string | undefined): void {
  currentAssetBase = base;
}

// ── 性能探针（一次性调试用）：__lpPerf(name, ms) 存在时逐阶段上报耗时。
// 基准测试 perf-large-doc.test.ts 会注入此钩子，生产环境不存在，零开销。 ──
function lpPerf(name: string, ms: number): void {
  const fn = (globalThis as Record<string, unknown>).__lpPerf;
  if (typeof fn === "function") {
    (fn as (n: string, m: number) => void)(name, ms);
  }
}

/** 规范化路径中的 `.` 和 `..`，不依赖 Node API（webview 兼容）。 */
function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const parts = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return (abs ? "/" : "") + out.join("/");
}

function resolveAsset(src: string, base?: string): string {
  if (/^(https?:|data:|blob:|asset:)/.test(src)) return src;
  if (!base) return src;
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    /* 非转义路径，原样使用 */
  }
  const normalized = normalizePath(`${base}/${decoded}`);
  try {
    return convertFileSrc(normalized);
  } catch {
    return src; // 浏览器开发环境无 Tauri，原样返回
  }
}

/** 解析图片 URL 中的百分比缩放后缀。
 *  "images/photo.png =50%" → { cleanUrl: "images/photo.png", scale: 50 }
 *  "images/photo.png"      → { cleanUrl: "images/photo.png", scale: null } */
export function parseImageUrl(raw: string): { cleanUrl: string; scale: number | null } {
  const m = raw.match(/^(.+?)\s*=\s*(\d+)%\s*$/);
  if (m) {
    const pct = parseInt(m[2], 10);
    return { cleanUrl: m[1].trim(), scale: Math.max(1, Math.min(999, pct)) };
  }
  return { cleanUrl: raw, scale: null };
}

/** 解析出图片的绝对文件路径（供系统查看器打开）。不可解析时返回空串。 */
function resolveFilePath(src: string, base?: string): string {
  if (!base) return "";
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch { /* 原样 */ }
  if (/^(https?:|data:|blob:|asset:)/.test(decoded)) return "";
  try {
    return normalizePath(`${base}/${decoded}`);
  } catch {
    return "";
  }
}

// 无序列表标记（-、*、+）渲染为圆点
class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  // 不忽略事件：点击圆点时 CM 正常在附近放置光标。
  // WidgetType 默认 ignoreEvent=true——CM 会跳过这次点击，
  // 光标停在原处不动，用户以为"点击位置≠光标位置"
  ignoreEvent() {
    return false;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "lp-bullet";
    s.textContent = "•";
    return s;
  }
}

// 任务列表 [ ]/[x] 渲染为可点击勾选框，点击直接改写源码字符
class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    pos: number, // 标记内部空格/x 字符的位置（positionRefreshPlugin 会刷新）
    readonly state?: EditorState, // 来源 state：刷新时区分新鲜/过期坐标
  ) {
    super();
    this.pos = pos;
  }
  pos: number;
  eq(other: CheckboxWidget) {
    // 只比较勾选状态；pos 由 positionRefreshPlugin 在 docChanged 后刷新
    // （toggle 闭包运行时读取 this.pos，实例坐标新鲜即不会改错字符）。
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "lp-checkbox";
    const toggle = (e: Event) => {
      e.preventDefault();
      view.dispatch({
        changes: {
          from: this.pos,
          to: this.pos + 1,
          insert: this.checked ? " " : "x",
        },
      });
    };
    // mousedown 处理鼠标；keydown 处理键盘 Space/Enter。
    // 仅 mousedown 时，键盘 Space 会触发浏览器默认切换 DOM 的 checked，
    // 但源码不改 → 假勾选，保存/同步后状态丢失。
    box.addEventListener("mousedown", toggle);
    box.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") toggle(e);
    });
    // 位置刷新映射（勾选改写的源码字符位置依赖实例坐标）
    checkboxWidgetMap.set(box, this);
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class HardBreakWidget extends WidgetType {
  eq() { return true; }
  // 同 BulletWidget：让点击落光标（默认 true 会让 CM 跳过点击）
  ignoreEvent() { return false; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "lp-hardbreak";
    span.textContent = "↵";
    return span;
  }
}

class EntityWidget extends WidgetType {
  constructor(readonly decoded: string) { super(); }
  eq(other: EntityWidget) { return other.decoded === this.decoded; }
  // 同 BulletWidget：让点击落光标
  ignoreEvent() { return false; }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.decoded;
    return span;
  }
}

function decodeHTMLEntities(text: string): string {
  const txt = document.createElement("textarea");
  txt.innerHTML = text;
  return txt.value;
}

/** HTML 占位徽标点击回调（由 Editor 注入）：切到源码模式并定位到该处 */
let _onHtmlBadgeClick: ((from: number, line: number) => void) | null = null;
export function setHtmlBadgeClickHandler(
  fn: ((from: number, line: number) => void) | null,
) {
  _onHtmlBadgeClick = fn;
}

/** 从 HTML 源码提取标签名（保留闭合斜杠 `</div>` → `/div`）；无标签（注释等）回退默认文案 */
function htmlTagLabel(source: string, fallback: string): string {
  const m = source.match(/<(\/)?([a-z][a-z0-9-]*)/i);
  return m ? (m[1] ?? "") + m[2] : fallback;
}

// 所见即所得下 HTML 块/标签/注释的源码隐藏，原位渲染为紧凑徽标：
// hover 用原生 tooltip 显示源码，点击切源码模式定位（改 HTML 必须进源码模式）。
// 不实现 ignoreEvent（默认 true）——CM 跳过点击，事件交给徽标自身处理。
class HtmlBadgeWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly source: string,
    readonly block: boolean,
    readonly label: string,
  ) {
    super();
  }
  eq(other: HtmlBadgeWidget) {
    return (
      other.from === this.from &&
      other.source === this.source &&
      other.block === this.block &&
      other.label === this.label
    );
  }
  toDOM(view: EditorView) {
    const badge = document.createElement("span");
    badge.className = "lp-html-badge" + (this.block ? " lp-html-badge-block" : "");
    badge.textContent = this.label;
    // 原生 tooltip 显示源码预览；过长截断（完整内容点击后切源码模式可见）
    badge.title =
      this.source.length > 400
        ? `${this.source.slice(0, 400)} …`
        : this.source;
    const jump = () => {
      const line = view.state.doc.lineAt(this.from).number;
      _onHtmlBadgeClick?.(this.from, line);
    };
    badge.addEventListener("click", jump);
    // 键盘可达：tabIndex=0，空格/回车同样触发
    badge.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        jump();
      }
    });
    badge.tabIndex = 0;
    return badge;
  }
}

const codeCopyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
const codeCopiedIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

// FencedCode 代码内容 = 开围栏行之后 → 闭围栏行之前。
// 不硬编码 ``` 长度，兼容 ~~~ 与任意数量反引号/波浪线围栏。
// 不在此 trim：复制需保留原始空白；mermaid 在调用处自行 trim。
function fencedCodeContent(state: EditorState, from: number, to: number): string {
  const openFenceEnd = state.doc.lineAt(from).to;
  // 未闭合围栏恰位于 EOF 时 openFenceEnd + 1 会超过 to（from > to），防御性 clamp
  const endPos = Math.min(to, state.doc.length);
  const raw = state.doc.sliceString(Math.min(openFenceEnd + 1, endPos), endPos);
  const lines = raw.split("\n");
  if (lines.length > 0 && /^[`~]{3,}\s*$/.test(lines[lines.length - 1])) {
    lines.pop(); // 去掉闭围栏行
  }
  return lines.join("\n");
}

// 点击复制时从 DOM 反查当前文档位置，再走语法树定位 FencedCode——
// 不在构造时捕获代码文本：装饰经 eq 复用后旧 widget 会拿到过期内容。
function fencedCodeAtDOM(view: EditorView, dom: Element): string | null {
  let pos: number;
  try {
    pos = view.posAtDOM(dom);
  } catch {
    return null; // dom 已脱离文档（装饰刚被替换）
  }
  const tree = syntaxTree(view.state);
  // typeof 取节点类型，避免直接依赖 @lezer/common（项目未列为直接依赖）
  let node: (typeof tree.topNode) | null = tree.resolveInner(pos, 1);
  while (node && node.name !== "FencedCode") node = node.parent;
  return node ? fencedCodeContent(view.state, node.from, node.to) : null;
}

// 代码块头部：语言徽章 + 一键复制按钮（浮动到行右）。
// 无语言时只有按钮，不渲染空的 lp-code-lang 徽章。
class CodeHeaderWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(other: CodeHeaderWidget) {
    return other.lang === this.lang;
  }
  // 按钮上的事件交还浏览器（CM 不抢，点击不移动光标）；
  // 其余区域同 BulletWidget：让点击落光标。
  ignoreEvent(e: Event) {
    return e.target instanceof Element && e.target.closest(".lp-code-copy") !== null;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "lp-code-header";
    if (this.lang) {
      const lang = document.createElement("span");
      lang.className = "lp-code-lang";
      lang.textContent = this.lang;
      wrap.append(lang);
    }
    const btn = document.createElement("button");
    btn.className = "lp-code-copy";
    btn.type = "button";
    btn.title = "复制代码";
    btn.innerHTML = codeCopyIcon;
    // 防止按钮抢占编辑器焦点
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = fencedCodeAtDOM(view, wrap);
      if (code === null) return;
      navigator.clipboard.writeText(code).then(() => {
        btn.classList.add("lp-copied");
        btn.innerHTML = codeCopiedIcon;
        setTimeout(() => {
          btn.classList.remove("lp-copied");
          btn.innerHTML = codeCopyIcon;
        }, 1200);
      }).catch(() => {});
    });
    wrap.append(btn);
    return wrap;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  // 同 BulletWidget：点击分割线时 CM 在其前后放置光标
  ignoreEvent() {
    return false;
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = "lp-hr";
    return d;
  }
}

// ── YAML frontmatter 完全隐藏 ──
// 文档开头的 ---…--- 元数据块在所见即所得模式下完全不可见、不占空间。
// 元数据编辑请使用右侧 FrontmatterPanel 或切换到源码模式。

/** 匹配文档开头 YAML frontmatter 块的结束位置。
 *  未匹配到 frontmatter 时返回 null。 */
function matchFrontmatterEnd(state: EditorState): number | null {
  const text = state.doc.sliceString(0, Math.min(3000, state.doc.length));
  const m = text.match(/^---\n[\s\S]*?\n---/);
  if (!m || m.index !== 0) return null;
  // 必须有实质内容（不仅是 ---）
  const yaml = text.slice(4, m[0].length - 4);
  if (!yaml.trim()) return null;
  return m[0].length;
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    /** 原始文件路径（用于点击打开/复制），不可加载时为空 */
    readonly filePath: string,
    /** 源码区间（用于删除图片操作），positionRefreshPlugin 会刷新 */
    from: number = 0,
    to: number = 0,
    /** 显示缩放百分比（null = 原始大小），50 表示缩小到 50% */
    readonly scale: number | null = null,
    /** 创建时 from..to 区间的源码快照，删除操作前比对用 */
    readonly raw: string = "",
    /** 来源 state：刷新时区分新鲜/过期坐标 */
    readonly state?: EditorState,
  ) {
    super();
    this.from = from;
    this.to = to;
  }
  from: number;
  to: number;
  eq(other: ImageWidget) {
    // 内容比较（src/alt/raw 均坐标无关）；from/to 由 positionRefreshPlugin 刷新。
    return other.src === this.src && other.alt === this.alt
      && other.scale === this.scale && other.raw === this.raw;
  }
  ignoreEvent(event: Event): boolean {
    return false;
  }

  toDOM(view: EditorView) {
    const svgIcon = (d: string) =>
      `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const ICONS = {
      copy: svgIcon(`<rect x="4" y="4" width="8" height="9" rx="1.2"/><path d="M6 4V3a1 1 0 011-1h6a1 1 0 011 1v7a1 1 0 01-1 1h-1"/>`),
      save: svgIcon(`<path d="M12 14H3.5a1 1 0 01-1-1V3.5a1 1 0 011-1h5.5l3.5 3.5v7a1 1 0 01-1 1z"/><line x1="9" y1="14" x2="9" y2="10"/><line x1="3.5" y1="3" x2="7" y2="6"/><line x1="7" y1="3" x2="7" y2="8"/>`),
      trash: svgIcon(`<path d="M3.5 4.5h9M6 4.5V3.5a1 1 0 011-1h2a1 1 0 011 1v1M6 7.5v4.5a1 1 0 001 1h2a1 1 0 001-1V7.5"/>`),
      resize: svgIcon(`<polyline points="14 11 14 14 11 14"/><line x1="8" y1="14" x2="4" y2="14"/><line x1="14" y1="8" x2="14" y2="4"/><polyline points="3.5 14 14 3.5"/>`),
    };

    const wrapper = document.createElement("span");
    wrapper.className = "lp-image-wrap";

    // ── 工具栏 ──
    const toolbar = document.createElement("span");
    toolbar.className = "lp-image-toolbar";

    // 复制
    const copyBtn = document.createElement("button");
    copyBtn.className = "lp-tb-btn";
    copyBtn.innerHTML = ICONS.copy;
    copyBtn.title = "复制图片";
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!this.filePath) return;
      try {
        // 通过 asset URL 获取图片 blob，写入剪贴板
        const resp = await fetch(this.src);
        const blob = await resp.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      } catch {
        // fallback: 复制文件路径
        navigator.clipboard.writeText(this.filePath).catch(() => {});
      }
    });

    // 另存为（在文件管理器中定位）
    const saveBtn = document.createElement("button");
    saveBtn.className = "lp-tb-btn";
    saveBtn.innerHTML = ICONS.save;
    saveBtn.title = "在文件夹中显示";
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!this.filePath) return;
      import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("reveal_in_folder", { path: this.filePath }).catch(() => {}),
      );
    });

    // 删除
    const delBtn = document.createElement("button");
    delBtn.className = "lp-tb-btn lp-tb-del";
    delBtn.innerHTML = ICONS.trash;
    delBtn.title = "删除图片";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.from >= this.to) return;
      // 与创建时的源码快照比对：不一致说明区间已被外部编辑，错位删除会误伤内容
      if (view.state.sliceDoc(this.from, this.to) !== this.raw) return;
      view.dispatch({ changes: { from: this.from, to: this.to, insert: "" } });
    });

    toolbar.append(copyBtn, saveBtn, delBtn);

    // ── 图片 ──
    const img = document.createElement("img");
    img.className = "lp-image";
    img.alt = this.alt;
    img.src = this.src;
    img.draggable = false;
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    img.setAttribute("aria-label", this.alt || "图片");
    if (this.scale !== null) {
      img.style.width = `${this.scale}%`;
    }

    const open = () => {
      if (!this.filePath) return;
      invoke("plugin:opener|open_url", { url: this.filePath }).catch(() => {});
    };
    img.addEventListener("click", () => open());
    img.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        open();
      }
    });
    img.onerror = () => {
      img.classList.add("lp-image-broken");
      img.alt = `[图片: ${this.alt || this.src}]`;
      img.removeAttribute("src");
    };

    wrapper.append(toolbar, img);

    // 存储图片信息到 data 属性，供右键菜单读取
    wrapper.setAttribute("data-img-path", this.filePath);
    wrapper.setAttribute("data-img-from", String(this.from));
    wrapper.setAttribute("data-img-to", String(this.to));
    if (this.scale !== null) {
      wrapper.setAttribute("data-img-scale", String(this.scale));
    }
    // 位置刷新映射（删除操作的 from/to 校验依赖实例坐标）
    imageWidgetMap.set(wrapper, this);

    return wrapper;
  }
}

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "lp-h1",
  ATXHeading2: "lp-h2",
  ATXHeading3: "lp-h3",
  ATXHeading4: "lp-h4",
  ATXHeading5: "lp-h5",
  ATXHeading6: "lp-h6",
  SetextHeading1: "lp-h1",
  SetextHeading2: "lp-h2",
};

// --- 表格即时渲染 ---

// ---------- Mermaid 图表（按需加载）----------

let mermaidModule: typeof import("mermaid").default | null = null;
let mermaidDark = false;

/** mermaid 渲染超时（ms）：懒加载图表 chunk 挂起或渲染器卡死时，
 *  不永久停在"渲染中"，超时后显示错误态并可在下次 DOM 重建时重试。 */
const MERMAID_RENDER_TIMEOUT = 15_000;

// 不做模块级预加载：mermaid 体积大（主包膨胀的大头之一），
// 延迟到第一个 mermaid 块真正渲染时再 import，加快启动与首开。
function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (mermaidModule) return Promise.resolve(mermaidModule);
  return import("mermaid").then((m) => {
    mermaidModule = m.default;
    mermaidModule!.initialize({
      startOnLoad: false,
      theme: mermaidDark ? "dark" : "default",
      securityLevel: "strict",
      flowchart: { htmlLabels: false },
    });
    return mermaidModule!;
  });
}

/** 解析完整 mermaid 围栏块文本，返回图表代码；围栏规则与 findMermaid
 *  一致（``` 或 ~~~，任意 ≥3 长度）。供编辑入口（editMermaid）使用。 */
export function parseMermaidFence(raw: string): string | null {
  const m = raw.match(/^(`{3,}|~{3,})mermaid[ \t]*\n?([\s\S]*?)\n?\1$/);
  return m ? m[2] : null;
}

/** 提交编辑时生成安全的包裹围栏：长度避开内容中最长的反引号串，
 *  防止内容里的 ``` 提前闭合代码块。 */
export function mermaidFenceWrap(text: string): { wrap: string; close: string } {
  const ticks = Math.max(
    3,
    ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1),
  );
  const fence = "`".repeat(ticks);
  return { wrap: `${fence}mermaid\n`, close: `\n${fence}` };
}

class MermaidWidget extends WidgetType {
  private rendered = false;
  /** 渲染成功的 SVG 缓存：DOM 重建（滚动/编辑重建 tile）时同步复用，
   *  避免重新渲染且结果被 !this.rendered 守卫丢弃导致"渲染中"永久残留。 */
  private renderedSvg: string | null = null;

  constructor(
    readonly code: string,
    readonly dark: boolean,
    /** 源码区间（data 属性供右键菜单/选区高亮），positionRefreshPlugin 会刷新 */
    from: number = 0,
    to: number = 0,
    readonly rawSource?: string,
    /** 来源 state：刷新时区分新鲜/过期坐标 */
    readonly state?: EditorState,
  ) {
    super();
    this.from = from;
    this.to = to;
  }
  from: number;
  to: number;

  eq(other: MermaidWidget) {
    // dark 参与比较：主题切换后 dark 变化 → eq false → widget 重建 → 按新主题渲染。
    // from/to 不参与比较（旧实例是旧坐标）：位置刷新统一走 positionRefreshPlugin，
    // 避免编辑点后的图表每次击键销毁重建、异步重渲染。
    return other.code === this.code && other.dark === this.dark;
  }

  // from/to 仅作编辑锚点（data 属性供右键菜单/选区高亮读取），与渲染内容无关。
  // 文档编辑使图表位置偏移时（eq false，但 code/dark 未变）复用已渲染的 DOM，
  // 仅刷新位置属性——否则图表上方每次击键都会触发整张图销毁重建、异步重渲染。
  updateDOM(dom: HTMLElement, _view: EditorView, from: this): boolean {
    if (from.code !== this.code || from.dark !== this.dark) return false;
    dom.setAttribute("data-mermaid-from", String(this.from));
    dom.setAttribute("data-mermaid-to", String(this.to));
    if (this.rawSource != null) {
      dom.setAttribute("data-mermaid-raw", this.rawSource);
    } else {
      dom.removeAttribute("data-mermaid-raw");
    }
    return true;
  }

  toDOM(view: EditorView) {
    const container = document.createElement("div");
    container.className = "lp-mermaid";

    // 存储图表信息到 data 属性，供右键菜单读取
    container.setAttribute("data-mermaid-code", this.code);
    container.setAttribute("data-mermaid-from", String(this.from));
    container.setAttribute("data-mermaid-to", String(this.to));
    if (this.rawSource != null) {
      container.setAttribute("data-mermaid-raw", this.rawSource);
    }
    // 位置刷新映射（选区高亮/右键菜单读取 data-mermaid-from/to）
    mermaidWidgetMap.set(container, this);

    // 双击进入编辑模式
    let lastMd = 0;
    container.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const now = Date.now();
      if (now - lastMd < 350) {
        e.preventDefault();
        e.stopPropagation();
        _onMathDblClick?.(container);
      }
      lastMd = now;
    });
    container.title = "右键更多操作 | 双击编辑图表";

    // 不直接在 container 上设置 overflow-x（CSS 规范强制 overflow-y 变为 auto
    // → scroll container → 干扰 CM6 ResizeObserver 高度追踪）。
    // 上下间距用 padding 而非 margin：CM6 测量 block widget 只计 border-box，
    // margin 不参与测量 → 累积偏移。
    container.style.cssText =
      "padding:20px 16px;border-radius:8px;background:var(--sidebar-bg);min-height:40px;display:flex;align-items:center;justify-content:center;cursor:pointer";

    // 内部容器负责水平溢出滚动，与 CM6 布局隔离。
    // overflow-y 用 hidden 而非 visible：CSS 规范要求 overflow-x 非 visible
    // 时 overflow-y:visible 强制计算为 auto，将 inner 变成 scroll container，
    // 干扰 CM6 的 ResizeObserver 高度追踪（同 MathWidget）。
    const inner = document.createElement("div");
    inner.className = "lp-mermaid-inner";
    inner.style.cssText =
      "width:100%;overflow-x:auto;overflow-y:hidden;display:flex;align-items:center;justify-content:center";

    // 已渲染过的 widget 被 CM6 重建 DOM（滚动移出视口/编辑导致 tile 重建，
    // RangeSet.map 保留同一实例）时同步复用缓存 SVG。否则二次 toDOM 会重建
    // 占位符并发起重渲染，其结果被 !this.rendered 守卫丢弃 → 永久停在"渲染中"。
    if (this.rendered && this.renderedSvg) {
      MermaidWidget.applySvg(inner, this.renderedSvg);
      container.appendChild(inner);
      return container;
    }

    const placeholder = document.createElement("span");
    placeholder.textContent = "图表渲染中…";
    placeholder.style.cssText =
      "color:var(--text-secondary);font-size:12px";
    inner.appendChild(placeholder);
    container.appendChild(inner);

    const dark = document.documentElement.classList.contains("dark");
    if (dark !== mermaidDark) {
      mermaidDark = dark;
      mermaidModule = null; // 主题变化时重建
    }

    const id = "mermaid-" + Math.random().toString(36).slice(2, 8);
    // 渲染超时兜底：懒加载图表 chunk 挂起或渲染器卡死时不永久停在"渲染中"；
    // 超时后若渲染最终完成仍会覆盖为实际图表（迟到的结果优于没有结果）。
    const timeout = window.setTimeout(() => {
      if (!inner.isConnected) return;
      inner.textContent = "图表渲染超时";
      inner.style.color = "var(--text-secondary)";
      inner.style.fontSize = "11px";
      view.requestMeasure();
    }, MERMAID_RENDER_TIMEOUT);

    loadMermaid()
      .then((m) => {
        const t = performance.now();
        // 用 mermaidAPI.render（原始函数）而非 mermaid.render（导出的是带串行
        // executionQueue 的包装）：队列一旦因某张图卡住，后续所有 render 调用
        // push 后 executeQueue() 直接 return → 全部图表永久停在"渲染中"。
        // 各图表使用唯一随机 id，并发渲染的临时 DOM（#d{id}）互不冲突。
        return m.mermaidAPI.render(id, this.code).then(({ svg }) => {
          lpPerf("mermaid:render", performance.now() - t);
          if (inner.isConnected && !this.rendered) {
            this.renderedSvg = svg;
            this.rendered = true;
            MermaidWidget.applySvg(inner, svg);
            // 异步渲染完成后通知 CM6 重新测量布局，
            // 确保高度映射表与 DOM 实际高度一致，消除点击位置偏移
            view.requestMeasure();
          }
        });
      })
      .catch(() => {
        if (inner.isConnected) {
          inner.textContent = "图表语法错误";
          inner.style.color = "var(--text-secondary)";
          inner.style.fontSize = "11px";
          view.requestMeasure();
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
      });

    return container;
  }

  /** 将 mermaid 渲染结果（SVG 字符串）应用到内部容器，并附透明覆盖层接收鼠标事件 */
  private static applySvg(inner: HTMLElement, svg: string) {
    inner.innerHTML = svg;
    const svgEl = inner.querySelector("svg");
    if (svgEl) {
      svgEl.style.maxWidth = "100%";
      svgEl.style.height = "auto";
    }
    // WebKit 中 SVG 不触发 contextmenu，加透明 HTML 覆盖层接收全部鼠标事件
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%";
    inner.style.position = "relative";
    inner.appendChild(overlay);
  }

  // 不接管鼠标事件：避免 CM6 在 inclusive:false 区间边界外推光标
  ignoreEvent() {
    return true;
  }
}

// ---------- Table 数据 ----------

interface TableData {
  header: string[];
  aligns: ("left" | "center" | "right" | null)[];
  rows: string[][];
}

/** 按 | 切分行，支持 \| 转义 */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  // 去掉首尾的管道符（不入格）
  const body = line.trim().replace(/^\||\|$/g, "");
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      const next = body[i + 1];
      if (next === "|") {
        cur += "|";
        i++;
      } else if (next === "\\") {
        // \\ 是转义反斜杠（字面 \），不能让第二个 \ 再与后面的 | 组成 \|
        cur += "\\";
        i++;
      } else {
        cur += ch;
      }
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** 单元格文本转义后写回 markdown（| 必须转义，换行用 <br>） */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br>");
}

/** 表格数据 → markdown 源码（单元格编辑后写回用） */
export function buildTableMarkdown(data: TableData): string {
  const delim = data.aligns.map((a) =>
    a === "left" ? ":---" : a === "right" ? "---:" : a === "center" ? ":---:" : "---",
  );
  const row = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [row(data.header), `| ${delim.join(" | ")} |`, ...data.rows.map(row)].join(
    "\n",
  );
}

/** 结构化比较两张表格是否内容相同（忽略空白格式差异）。
 *  避免 buildTableMarkdown 统一间距后字符串比较失败导致不必要的 dispatch。 */
function tableContentSame(a: string, b: string): boolean {
  const pa = parseTable(a);
  const pb = parseTable(b);
  if (!pa || !pb) return a === b; // 解析失败退回到字符串比较
  if (pa.header.length !== pb.header.length) return false;
  if (pa.rows.length !== pb.rows.length) return false;
  if (!pa.header.every((h, i) => h === pb.header[i])) return false;
  if (!pa.aligns.every((al, i) => al === pb.aligns[i])) return false;
  return pa.rows.every((r, ri) =>
    r.length === pb.rows[ri].length && r.every((c, ci) => c === pb.rows[ri][ci]),
  );
}

export function parseTable(raw: string): TableData | null {
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]);
  const delimCells = splitRow(lines[1]);
  // 分隔行不合法就不是表格（注意 `---` 无对齐也是合法分隔符）
  if (delimCells.length === 0 || !delimCells.every((c) => /^:?-+:?$/.test(c))) {
    return null;
  }
  const aligns = delimCells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : left ? "left" : right ? "right" : null;
  });
  return { header, aligns, rows: lines.slice(2).map(splitRow) };
}

/** HTML 属性值转义：renderInline 只转义了 &<>，URL/文本里的引号
 *  原样拼进 title/data-link-url 属性可闭合引号注入（[a](x" onmouseover="evil)），
 *  属性插值前必须再转义引号。 */
function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 链接标记属性：data-link-angle 标记源码中 URL 是否被 `<>` 包裹。
 *  包裹内 `#`/`?` 是字面量（文件名可含，encodeURI 不编码它们），点击打开时
 *  不得按锚点剥离——与 linkActions.linkTargetPath 的约定一致。 */
function linkMarkAttrs(url: string, angle: boolean): Record<string, string> {
  return {
    "data-link-url": url,
    title: url,
    ...(angle ? { "data-link-angle": "1" } : {}),
  };
}

/** 单元格内的行内格式：先转义 HTML，再做最小子集渲染 */
function renderInline(text: string): string {
  // 先转义 HTML 特殊字符防止 XSS。切勿对转义结果再做实体解码——
  // decodeHTMLEntities 会把 &lt;/&gt; 还原成 </>，转义被抵消，innerHTML 即可注入。
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // 单元格里的 <br>（Crepe 时代遗留）渲染为真实换行。
  // 此时 < 已转义为 &lt;，匹配转义后的 &lt;br&gt; 还原为 <br>
  s = s.replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  s = s.replace(/`([^`]+)`/g, '<code class="lp-inline-code">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    // URL 捕获组允许引号，必须转义后再拼进属性，否则可闭合引号注入
    (_m, label: string, raw: string) => {
      // 转义先行：`<>` 包裹的 URL 已变成 &lt;url&gt;，剥壳还原并标记 angle，
      // 与主文档语法树路径的 data-link-angle 保持一致
      const angle = raw.startsWith("&lt;") && raw.endsWith("&gt;");
      const url = angle ? raw.slice(4, -4).replace(/&amp;/g, "&") : raw;
      const safe = escapeAttr(url);
      const angleAttr = angle ? ` data-link-angle="1"` : "";
      return `<span class="lp-link" title="${safe}" data-link-url="${safe}"${angleAttr}>${label}</span>`;
    },
  );
  return s;
}

// 表格 Widget → DOM 映射表，供外部（光标路径）反向查找表格实例。
// 与 mathWidgetMap 模式一致：WYSIWYG 模式下光标无法进入 inclusive:false
// block widget 区间，光标路径需要通过 DOM 找到对应的 TableWidget。
export const tableWidgetMap = new WeakMap<HTMLElement, TableWidget>();

// 表格始终渲染为 HTML 表格，单元格可直接编辑（点击 → input → 回车/失焦提交），
// 提交时整表重新序列化写回源码区间。
// ignoreEvent → true：让浏览器原生处理表格上的事件（选中文字、input 编辑等），CM6 不接管
class TableWidget extends WidgetType {
  constructor(
    readonly raw: string,
    /** 源码区间（编辑锚点），positionRefreshPlugin 会刷新 */
    from: number,
    to: number,
    /** 替换范围是否包含一个前导空行（已被吞入）。回写时需补回。 */
    readonly hasLeadingBlank: boolean = false,
    /** 来源 state：刷新时区分新鲜/过期坐标 */
    readonly state?: EditorState,
  ) {
    super();
    this.from = from;
    this.to = to;
  }
  from: number;
  to: number;

  /** 最后点击的单元格的列/行索引（点击单元格编辑时记录），
   *  工具栏操作优先使用此值而非 CM6 光标位置。
   *  公开 getter 供光标路径（editorKeymap）在 WYSIWYG 模式下回退使用。 */
  private _activeCol = 0;
  private _activeRow = 1;

  get activeCol(): number { return this._activeCol; }
  get activeRow(): number { return this._activeRow; }

  /** 下拉菜单关闭监听器引用（在 destroy 时清理，避免 document 级内存泄漏） */
  private _docCleanup: (() => void) | null = null;

  /** 本 widget 最近一次 toDOM 创建的根元素（多表格文档中作用域查询用，
   *  全局 querySelector 会命中别的表格） */
  private _dom: HTMLElement | null = null;

  destroy(_dom: HTMLElement) {
    this._docCleanup?.();
    this._docCleanup = null;
    if (this._dom === _dom) this._dom = null;
    tableWidgetMap.delete(_dom);
  }

  eq(other: TableWidget) {
    // 只比较内容（raw 是源码文本，坐标无关）：from/to 不参与比较，
    // 平移后的表格由 positionRefreshPlugin 刷新实例坐标（toDOM 闭包
    // 运行时读取 this.from/to + sliceDoc 校验，坐标新鲜即安全）。
    return other.raw === this.raw && other.hasLeadingBlank === this.hasLeadingBlank;
  }
  ignoreEvent() {
    return true;
  }

  /** 对表格源码执行结构操作并提交到 CM6 document。
   *  操作函数返回 null 表示拒绝（例如删除最后一行），返回空字符串表示删除整表。
   *  运行时重新读取文档中的源码（而非用 toDOM 时的 this.raw），
   *  避免单元格编辑 blur→commit 提前修改了表格源码导致静默跳过。 */
  private doTableOp(view: EditorView, fn: (raw: string) => string | null) {
    // 先提交当前可能正在编辑的单元格，避免 cell edit 和结构操作竞态。
    // 作用域限定本表格的 DOM：全局查找会命中别的表格里正在编辑的单元格
    const activeTextarea =
      this._dom?.querySelector<HTMLTextAreaElement>("textarea.lp-cell-input") ?? null;
    if (activeTextarea) activeTextarea.blur();

    // 运行时重新读文档源码：cell edit 的 blur→commit 可能已修改了表格内容
    let raw = view.state.sliceDoc(this.from, this.to);
    const stripped = this.hasLeadingBlank && raw.startsWith("\n") ? raw.slice(1) : raw;
    const next = fn(stripped);
    if (next === null || next === stripped) return;
    // 二次校验：如果重新读取的源码与刚才又不同了（如外部并发编辑），放弃
    if (view.state.sliceDoc(this.from, this.to) !== raw) return;
    const insert = this.hasLeadingBlank ? "\n" + next : next;

    // 在操作前先记录当前编辑位置，dispatch 整表重建后恢复
    const savedRow = this._activeRow;
    const savedCol = this._activeCol;

    view.dispatch({ changes: { from: this.from, to: this.to, insert } });

    // 删除整表不恢复光标
    if (!next) return;

    // 如果操作前有单元格正在编辑，在新 widget 中找到对应格重新打开编辑态。
    // 不再主动设 CM6 光标位置：inclusive:false 会把光标挡在 widget 边界外，
    // 主动设反而导致可见的闪烁竖线出现在表格前后。
    requestAnimationFrame(() => {
      if (!activeTextarea) return; // 没有在编辑单元格 → 无需恢复
      // 多表格文档中不能全局取第一个表格：dispatch 后旧 DOM 已销毁，
      // 按 tableWidgetMap 找到被操作表格的新 widget（from 不变），在其 DOM 内恢复焦点
      let table: HTMLTableElement | null = null;
      for (const w of view.dom.querySelectorAll<HTMLElement>(".lp-table-wrapper")) {
        if (tableWidgetMap.get(w)?.from === this.from) {
          table = w.querySelector("table.lp-table");
          break;
        }
      }
      if (table) {
        const rows = table.querySelectorAll("tr");
        const tr = rows[savedRow];
        if (tr) {
          const cell = tr.children[savedCol] as HTMLElement | undefined;
          cell?.click();
        }
      }
    });
  }

  /** 确定当前操作行索引。
   *  inclusive:false 下 CM6 光标无法进入表格源码区间，直接用 _activeRow。 */
  private rowIdxAt(): number {
    return this._activeRow;
  }

  /** 确定当前操作列索引。
   *  inclusive:false 装饰下 CM6 光标无法进入表格源码区间，
   *  列目标直接由用户点击单元格时的 _activeCol 确定，不再依赖数管道符。 */
  private colIdxAt(): number {
    return this._activeCol;
  }

  toDOM(view: EditorView) {
    const data = parseTable(this.raw);
    const wrapper = document.createElement("div");
    wrapper.className = "lp-table-wrapper";
    this._dom = wrapper;
    if (!data) {
      wrapper.textContent = this.raw;
      return wrapper;
    }

    // ── 表格工具栏（悬停显示） ──

    const svgIcon = (d: string) =>
      `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

    const ICONS = {
      plus: svgIcon(`<line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/>`),
      minus: svgIcon(`<line x1="3" y1="8" x2="13" y2="8"/>`),
      trash: svgIcon(`<path d="M3.5 4.5h9M6 4.5V3.5a1 1 0 011-1h2a1 1 0 011 1v1M6 7.5v4.5a1 1 0 001 1h2a1 1 0 001-1V7.5"/>`),
      alignLeft: svgIcon(`<line x1="2.5" y1="4" x2="11" y2="4"/><line x1="2.5" y1="8" x2="14" y2="8"/><line x1="2.5" y1="12" x2="9" y2="12"/>`),
      alignCenter: svgIcon(`<line x1="4" y1="4" x2="12" y2="4"/><line x1="2.5" y1="8" x2="14" y2="8"/><line x1="5" y1="12" x2="11" y2="12"/>`),
      alignRight: svgIcon(`<line x1="5" y1="4" x2="14" y2="4"/><line x1="2.5" y1="8" x2="14" y2="8"/><line x1="7" y1="12" x2="14" y2="12"/>`),
      more: svgIcon(`<circle cx="4" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1.2" fill="currentColor" stroke="none"/>`),
    };

    const toolbar = document.createElement("div");
    toolbar.className = "lp-table-toolbar";

    // ── 左侧：对齐按钮 ──
    const alignLeft = document.createElement("button");
    alignLeft.className = "lp-tb-btn";
    alignLeft.innerHTML = ICONS.alignLeft;
    alignLeft.title = "左对齐";
    alignLeft.setAttribute("data-op", "align-left");

    const alignCenter = document.createElement("button");
    alignCenter.className = "lp-tb-btn";
    alignCenter.innerHTML = ICONS.alignCenter;
    alignCenter.title = "居中对齐";
    alignCenter.setAttribute("data-op", "align-center");

    const alignRight = document.createElement("button");
    alignRight.className = "lp-tb-btn";
    alignRight.innerHTML = ICONS.alignRight;
    alignRight.title = "右对齐";
    alignRight.setAttribute("data-op", "align-right");

    const leftGroup = document.createElement("span");
    leftGroup.className = "lp-tb-left";
    leftGroup.append(alignLeft, alignCenter, alignRight);

    // ── 右侧：分隔 + 更多 + 删除 ──
    const sep = document.createElement("span");
    sep.className = "lp-tb-sep";

    // "更多" 按钮 + 下拉菜单
    const moreBtn = document.createElement("button");
    moreBtn.className = "lp-tb-btn";
    moreBtn.innerHTML = ICONS.more;
    moreBtn.title = "更多操作";

    const makeMenuItem = (
      op: string, icon: string, label: string, danger = false,
    ) => {
      const btn = document.createElement("button");
      btn.setAttribute("data-op", op);
      btn.innerHTML = icon + " " + label;
      if (danger) btn.className = "lp-tb-menu-danger";
      // 行列索引由打开菜单时动态设置
      if (op.startsWith("row-")) btn.setAttribute("data-row", "1");
      if (op.startsWith("col-")) btn.setAttribute("data-col", "0");
      return btn;
    };

    const menuSep = () => {
      const d = document.createElement("div");
      d.className = "lp-tb-menu-sep";
      return d;
    };

    const moreMenu = document.createElement("div");
    moreMenu.className = "lp-tb-menu";
    moreMenu.append(
      makeMenuItem("row-above", ICONS.plus, "上方插入行"),
      makeMenuItem("row-below", ICONS.plus, "下方插入行"),
      makeMenuItem("row-del", ICONS.minus, "删除当前行", true),
      menuSep(),
      makeMenuItem("col-left", ICONS.plus, "左侧插入列"),
      makeMenuItem("col-right", ICONS.plus, "右侧插入列"),
      makeMenuItem("col-del", ICONS.minus, "删除当前列", true),
    );

    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // 更新菜单中的行列索引
      const r = this.rowIdxAt();
      const c = this.colIdxAt();
      moreMenu.querySelectorAll<HTMLButtonElement>("[data-row]").forEach((b) => b.setAttribute("data-row", String(r)));
      moreMenu.querySelectorAll<HTMLButtonElement>("[data-col]").forEach((b) => b.setAttribute("data-col", String(c)));
      moreMenu.classList.toggle("lp-tb-menu-open");
    });

    // 点击菜单外部关闭。监听器存为实例属性，在 destroy 时清理避免内存泄漏。
    const closeMenu = (ev: MouseEvent) => {
      if (!moreMenu.contains(ev.target as Node) && ev.target !== moreBtn) {
        moreMenu.classList.remove("lp-tb-menu-open");
      }
    };
    document.addEventListener("click", closeMenu);
    this._docCleanup = () => document.removeEventListener("click", closeMenu);

    const moreWrap = document.createElement("span");
    moreWrap.className = "lp-tb-more-wrap";
    moreWrap.append(moreBtn, moreMenu);

    const delBtn = document.createElement("button");
    delBtn.className = "lp-tb-btn lp-tb-del";
    delBtn.innerHTML = ICONS.trash;
    delBtn.title = "删除表格";
    delBtn.setAttribute("data-op", "del-table");

    const rightGroup = document.createElement("span");
    rightGroup.className = "lp-tb-right";
    rightGroup.append(sep, moreWrap, delBtn);

    toolbar.append(leftGroup, rightGroup);
    wrapper.appendChild(toolbar);

    // ── 工具栏事件委托：mousedown 而非 click ──
    // 用 mousedown + preventDefault 截获事件，在 textarea blur 之前执行，
    // 避免 cell edit 的 blur→commit→dispatch 和结构操作的 dispatch 竞态
    // 导致 sliceDoc !== raw 静默跳过。更多按钮走自身 click handler，不拦截。
    toolbar.addEventListener("mousedown", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-op]");
      if (!btn) return;
      if (btn === moreBtn) return; // 更多按钮走 click handler
      e.preventDefault(); // 阻止 textarea 失焦
      e.stopPropagation();
      const op = btn.getAttribute("data-op")!;
      const colIdx = parseInt(btn.getAttribute("data-col") ?? String(this.colIdxAt()), 10);
      const rowIdx = parseInt(btn.getAttribute("data-row") ?? String(this.rowIdxAt()), 10);
      import("./tableOperations").then((ops) => {
        switch (op) {
          case "row-above": this.doTableOp(view, (r) => ops.addRow(r, rowIdx, "above")); break;
          case "row-below": this.doTableOp(view, (r) => ops.addRow(r, rowIdx, "below")); break;
          case "row-del": this.doTableOp(view, (r) => ops.deleteRow(r, rowIdx)); break;
          case "col-left": this.doTableOp(view, (r) => ops.addColumn(r, colIdx, "left")); break;
          case "col-right": this.doTableOp(view, (r) => ops.addColumn(r, colIdx, "right")); break;
          case "col-del": this.doTableOp(view, (r) => ops.deleteColumn(r, colIdx)); break;
          case "align-left": this.doTableOp(view, (r) => ops.setAlign(r, colIdx, "left")); break;
          case "align-center": this.doTableOp(view, (r) => ops.setAlign(r, colIdx, "center")); break;
          case "align-right": this.doTableOp(view, (r) => ops.setAlign(r, colIdx, "right")); break;
          case "del-table": this.doTableOp(view, () => ""); break;
        }
      });
      // 关闭更多菜单
      moreMenu.classList.remove("lp-tb-menu-open");
    });

    // ── 编辑状态 ──
    const grid: string[][] = [data.header, ...data.rows];
    const commit = () => {
      const next = buildTableMarkdown({
        header: grid[0],
        aligns: data.aligns,
        rows: grid.slice(1),
      });
      // 结构化比较而非字符串比较：buildTableMarkdown 会统一间距格式
      // （如在管道符两侧加空格），字符串比较永远不等 → 每次切格 dispatch
      // → 整表重建 → 闪烁选区背景。这里用 parseTable 比较内容是否真的变了。
      if (tableContentSame(next, this.raw)) return;
      if (view.state.sliceDoc(this.from, this.to) !== this.raw) return;
      const insert = this.hasLeadingBlank ? "\n" + next : next;
      view.dispatch({ changes: { from: this.from, to: this.to, insert } });
    };

    // ── 表格 ──
    const table = document.createElement("table");
    table.className = "lp-table";
    const makeRow = (cells: string[], tag: "th" | "td", rowIdx: number) => {
      const tr = document.createElement("tr");
      cells.forEach((cell, i) => {
        const el = document.createElement(tag);
        el.innerHTML = renderInline(cell) || "​";
        const align = data.aligns[i];
        if (align) el.style.textAlign = align;
        // 未编辑态时 mousedown 阻止浏览器文本选中，消除切格时的选区闪烁。
        // 已编辑态（textarea 存在）时不拦截，允许用户在输入框内选中文字。
        el.addEventListener("mousedown", (e) => {
          if (!el.querySelector("textarea")) e.preventDefault();
        });
        el.addEventListener("click", () => {
          if (el.querySelector("textarea")) return;
          this._activeRow = rowIdx;
          this._activeCol = i;
          // 同步对齐按钮的列目标，确保用户点击单元格后工具栏对齐操作作用于正确的列
          alignLeft.setAttribute("data-col", String(i));
          alignCenter.setAttribute("data-col", String(i));
          alignRight.setAttribute("data-col", String(i));

          const originalCell = grid[rowIdx][i];
          // 直接用原始 markdown 进入编辑模式（而非 stripInlineMarkup 剥离
          // 格式后的纯文本），避免用户任何编辑都丢失行内格式（**粗体**/链接等）。
          // 退出编辑时若未改动则原始 markdown 完整保留。
          const editValue = decodeHTMLEntities(originalCell);

          // ghost 用纯文本，和 textarea 同源，撑住单元格高度
          const ghost = document.createElement("span");
          ghost.className = "lp-cell-ghost";
          ghost.textContent = editValue || "​";

          const textarea = document.createElement("textarea");
          textarea.className = "lp-cell-input";
          textarea.value = editValue;

          el.innerHTML = "";
          el.appendChild(ghost);
          el.appendChild(textarea);

          // 同步 text-align：textarea 不完全可靠继承
          textarea.style.textAlign = el.style.textAlign || getComputedStyle(el).textAlign;
          // padding 和单元格一致，inset:0 填满单元格
          textarea.style.padding = "6px 12px";
          // 不设 top/left/right/height：CSS inset:0 让 textarea 填满整个单元格
          const syncSize = () => {
            ghost.textContent = textarea.value || "​";
          };
          textarea.addEventListener("input", syncSize);

          // 垂直居中：同一行中若其他单元格内容更多，行高被撑大后，
          // td 的 vertical-align:middle 会将 ghost 垂直居中，但
          // position:absolute 的 textarea 不受此影响——手动调整
          // top/bottom 使 textarea 的文字位置与展示态一致。
          const alignVertical = () => {
            const cellH = el.clientHeight;       // 单元格内容区高度
            const ghostH = ghost.offsetHeight;    // ghost 实际渲染高度
            if (ghostH < cellH) {
              const offset = Math.floor((cellH - ghostH) / 2);
              textarea.style.top = `${offset}px`;
              textarea.style.bottom = `${offset}px`;
            } else {
              textarea.style.top = "";
              textarea.style.bottom = "";
            }
          };
          requestAnimationFrame(() => {
            alignVertical();
            // 每次输入后重新测量，因为多行文本会让 ghost 增高，
            // 无需居中时 top/bottom 自动清空
            textarea.addEventListener("input", () => {
              requestAnimationFrame(alignVertical);
            });
          });

          textarea.focus();
          textarea.setSelectionRange(textarea.value.length, textarea.value.length);
          const snapshot = textarea.value;
          const done = (ok: boolean) => {
            if (ok && textarea.value !== snapshot) {
              grid[rowIdx][i] = textarea.value;
            }
            commit();
            if (textarea.isConnected) {
              el.innerHTML = renderInline(grid[rowIdx][i]);
            }
          };
          textarea.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              textarea.blur();
            } else if (e.key === "Escape") {
              textarea.value = snapshot;
              textarea.blur();
            }
          });
          textarea.addEventListener("blur", () => done(true));
        });
        tr.appendChild(el);
      });
      return tr;
    };
    const thead = document.createElement("thead");
    thead.appendChild(makeRow(data.header, "th", 0));
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    data.rows.forEach((row, r) => tbody.appendChild(makeRow(row, "td", r + 1)));
    table.appendChild(tbody);
    wrapper.appendChild(table);

    // ── Tab 导航 ──
    wrapper.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const active = document.activeElement;
      if (!active || active.tagName !== "TEXTAREA") return;
      if (!active.classList.contains("lp-cell-input")) return;
      const td = active.closest("th, td") as HTMLTableCellElement | null;
      if (!td) return;
      const tr = td.parentElement!;
      const cells = Array.from(tr.children) as HTMLTableCellElement[];
      let cellIdx = cells.indexOf(td);
      if (cellIdx < 0) return;

      e.preventDefault();
      e.stopPropagation();
      (active as HTMLTextAreaElement).blur();

      if (e.shiftKey) {
        if (cellIdx > 0) {
          (cells[cellIdx - 1] as HTMLElement).click();
        } else {
          const prevTr = tr.previousElementSibling;
          if (prevTr && prevTr.children.length > 0) {
            const lastCell = prevTr.children[prevTr.children.length - 1] as HTMLElement;
            lastCell.click();
          }
        }
      } else {
        if (cellIdx < cells.length - 1) {
          (cells[cellIdx + 1] as HTMLElement).click();
        } else {
          const nextTr = tr.nextElementSibling;
          if (nextTr && nextTr.children.length > 0) {
            (nextTr.children[0] as HTMLElement).click();
          } else {
            // 末尾单元格为空时不自动新增行，避免误触 Tab 产生无意义空行
            if (!(active as HTMLTextAreaElement).value.trim()) return;
            const colCount = data.header.length;
            import("./tableOperations").then((ops) => {
              this.doTableOp(view, (r) => ops.addRow(r, grid.length - 1, "below"));
            });
          }
        }
      }
    });

    tableWidgetMap.set(wrapper, this);
    return wrapper;
  }
}


export function livePreview(options: LivePreviewOptions = {}): Extension {
  // 运行时才读取：extensions 跨文件复用，assetBase 随活动文件变化
  const getAssetBase = () => options.assetBase ?? currentAssetBase;

  // 核心装饰迭代逻辑：遍历指定区间内的语法树节点，生成装饰数组。
  // 仅由 build() 调用：每次文档变更或语法树收敛时全量重建（笔记文档体积
  // 小，全文解析 <10ms），没有增量重建路径。
  // 空行压缩的行区间：把装饰 ranges 扩展为「涉及的行 ± 相邻行」集合。
  // 增量重建时只在这些行上判定空行压缩（连续空行组/段落分隔的判定
  // 依赖相邻行，±1 行即可覆盖——区外行的旧判定不受影响仍正确）。
  function emptyLineSpans(
    state: EditorState,
    ranges: readonly { from: number; to: number }[],
  ): Array<{ start: number; end: number }> {
    const spans: Array<{ start: number; end: number }> = [];
    for (const r of ranges) {
      if (r.to <= r.from) continue;
      const startLine = Math.max(1, state.doc.lineAt(r.from).number - 1);
      const endLine = Math.min(state.doc.lines, state.doc.lineAt(Math.min(r.to, state.doc.length)).number + 1);
      const prev = spans[spans.length - 1];
      if (prev && startLine <= prev.end + 1) {
        prev.end = Math.max(prev.end, endLine);
      } else {
        spans.push({ start: startLine, end: endLine });
      }
    }
    return spans;
  }

  function buildRanges(
    state: EditorState,
    tree: ReturnType<typeof syntaxTree>,
    ranges: readonly { from: number; to: number }[],
  ): Range<Decoration>[] {
    const decos: Range<Decoration>[] = [];
    const addLine = (pos: number, deco: Decoration) => {
      decos.push(deco.range(pos));
    };
    const add = (from: number, to: number, deco: Decoration) => {
      if (from < to) decos.push(deco.range(from, to));
    };
    const hide = (from: number, to: number) =>
      add(from, to, Decoration.replace({}));
    const hideInline = (from: number, to: number) =>
      add(from, to, Decoration.mark({ class: "lp-inline-hidden" }));
    const mark = (from: number, to: number, cls: string) =>
      add(from, to, Decoration.mark({ class: cls }));

    // 引用块嵌套深度映射：行号 → 最大 > 层数。
    // 先收集各行的嵌套深度，循环结束后统一应用行装饰——同一行可能
    // 同时属于多层 Blockquote（外层和内层），只有取 max 才能正确渲染。
    const quoteDepths = new Map<number, number>();

    for (const { from, to } of ranges) {
      if (!tree) break;
      tree.iterate({
        from,
        to,
        enter(node) {
          const name = node.name;

          // --- 标题：行样式 + 隐藏 # 标记 ---
          const hClass = HEADING_CLASS[name];
          if (hClass) {
            const line = state.doc.lineAt(node.from);
            addLine(line.from, Decoration.line({ class: hClass }));
            return;
          }
          if (name === "HeaderMark") {
            const end =
              state.doc.sliceString(node.to, node.to + 1) === " "
                ? node.to + 1
                : node.to;
            hide(node.from, end);
            return;
          }

          // --- 转义字符：隐藏反斜杠 ---
          if (name === "Escape") {
            hideInline(node.from, node.from + 1);
            return;
          }

          // --- HTML 实体：解码显示 ---
          if (name === "Entity") {
            const text = state.doc.sliceString(node.from, node.to);
            add(
              node.from,
              node.to,
              Decoration.replace({
                widget: new EntityWidget(decodeHTMLEntities(text)),
              }),
            );
            return;
          }

          // --- 硬换行 ---
          if (name === "HardBreak") {
            const text = state.doc.sliceString(node.from, node.to);
            const markerEnd = text.endsWith("\n") ? node.to - 1 : node.to;
            add(
              node.from,
              markerEnd,
              Decoration.replace({ widget: new HardBreakWidget() }),
            );
            return;
          }

          // --- 行内样式 ---
          if (name === "StrongEmphasis") mark(node.from, node.to, "lp-strong");
          if (name === "Emphasis") mark(node.from, node.to, "lp-em");
          if (name === "Strikethrough") mark(node.from, node.to, "lp-strike");
          if (name === "EmphasisMark" || name === "StrikethroughMark") {
            hideInline(node.from, node.to);
            return;
          }

          // --- 上标/下标 ---
          if (name === "Superscript") {
            mark(node.from, node.to, "lp-sup");
            return;
          }
          if (name === "Subscript") {
            mark(node.from, node.to, "lp-sub");
            return;
          }
          if (name === "SuperscriptMark" || name === "SubscriptMark") {
            hideInline(node.from, node.to);
            return;
          }

          // --- 行内代码 ---
          if (name === "InlineCode") {
            mark(node.from, node.to, "lp-inline-code");
            return;
          }
          if (name === "CodeMark") {
            const pn = node.node.parent?.name;
            if (pn === "InlineCode" || pn === "FencedCode") {
              hideInline(node.from, node.to);
            }
            return;
          }

          // --- 链接 title：始终隐藏 ---
          if (name === "LinkTitle") {
            const p = node.node.parent;
            if (p && (p.name === "Link" || p.name === "Image")) {
              hide(node.from, node.to);
            }
            return;
          }

          // --- 链接：只显示文字，URL 隐藏 ---
          if (name === "URL") {
            const p = node.node.parent;
            if (p && (p.name === "Link" || p.name === "Image")) {
              hide(node.from, node.to);
            }
            if (p && p.name === "Autolink") {
              // data-link-url 供点击打开/悬浮卡片读取目标地址
              const url = state.doc.sliceString(node.from, node.to);
              add(
                node.from,
                node.to,
                Decoration.mark({
                  class: "lp-link",
                  attributes: linkMarkAttrs(url, true), // Autolink 恒为 `<url>`
                }),
              );
            }
            return;
          }
          if (name === "LinkMark") {
            const p = node.node.parent;
            if (p && (p.name === "Link" || p.name === "Image" || p.name === "Autolink")) {
              hideInline(node.from, node.to);
            }
            return;
          }
          if (name === "Link") {
            // 用 LinkMark 子节点确定显示文字范围，避免 lastIndexOf("]") 对
            // 引用式链接 [text][ref] 命中第二个 ]，导致标记覆盖 "text][ref"。
            const linkMarks = node.node.getChildren("LinkMark");
            if (linkMarks.length >= 2) {
              const urlNode = node.node.getChild("URL");
              if (urlNode) {
                // data-link-url 供点击打开/悬浮卡片读取目标地址
                const url = state.doc.sliceString(urlNode.from, urlNode.to);
                add(
                  linkMarks[0].to,
                  linkMarks[1].from,
                  Decoration.mark({
                    class: "lp-link",
                    attributes: linkMarkAttrs(
                      url,
                      urlNode.from > 0 &&
                        state.doc.sliceString(urlNode.from - 1, urlNode.from) ===
                          "<",
                    ),
                  }),
                );
              } else {
                // 引用式链接没有 URL 子节点，保持普通标记。
                // [text][ref] 的 ref 部分也要隐藏：4 个 LinkMark 虽被逐个隐藏，
                // 但 ref 文字本身无装饰，不处理会渲染成 "textref"。
                // linkMarks[1].to（第一个 ] 之后）→ 节点尾正好覆盖 ][ref]。
                mark(linkMarks[0].to, linkMarks[1].from, "lp-link");
                hide(linkMarks[1].to, node.to);
              }
            }
            return;
          }

          // --- 图片 ---
          if (name === "Image") {
            const urlNode = node.node.getChild("URL");
            const marks = node.node.getChildren("LinkMark");
            if (urlNode && marks.length >= 2) {
              const alt = state.doc.sliceString(marks[0].to, marks[1].from);
              const rawSrc = state.doc.sliceString(urlNode.from, urlNode.to);
              const { cleanUrl, scale } = parseImageUrl(rawSrc);
              const src = resolveAsset(cleanUrl, getAssetBase());
              const filePath = resolveFilePath(cleanUrl, getAssetBase());
              add(
                node.from,
                node.to,
                Decoration.replace({
                  widget: new ImageWidget(
                    src, alt, filePath, node.from, node.to, scale,
                    state.doc.sliceString(node.from, node.to), state,
                  ),
                  inclusive: false,
                }),
              );
            }
            return false;
          }

          // --- 引用块：收集嵌套深度而非直接装饰（同一行可同时属于多层 Blockquote）---
          if (name === "Blockquote") {
            // 计算当前块的嵌套层级：向上遍历父节点，统计 Blockquote 祖先数
            let depth = 1;
            let p = node.node.parent;
            while (p) {
              if (p.name === "Blockquote") depth++;
              p = p.parent;
            }
            const start = state.doc.lineAt(node.from);
            const end = state.doc.lineAt(Math.min(node.to, state.doc.length));
            for (let n = start.number; n <= end.number; n++) {
              quoteDepths.set(n, Math.max(quoteDepths.get(n) ?? 0, depth));
            }
            return;
          }
          if (name === "QuoteMark") {
            const end =
              state.doc.sliceString(node.to, node.to + 1) === " "
                ? node.to + 1
                : node.to;
            hide(node.from, end);
            return;
          }

          // --- HTML 块 ---
          if (name === "HTMLBlock") {
            const start = state.doc.lineAt(node.from);
            const end = state.doc.lineAt(Math.min(node.to, state.doc.length));
            const source = state.doc.sliceString(
              node.from,
              Math.min(node.to, state.doc.length),
            );
            // ViewPlugin 不能提供 block 装饰（CM6 抛 RangeError 白屏），
            // 块级 HTML 用「首行整行替换为徽标 + 其余行零宽隐藏」模拟塌缩
            add(
              start.from,
              start.to,
              Decoration.replace({
                widget: new HtmlBadgeWidget(
                  node.from,
                  source,
                  true,
                  htmlTagLabel(source, "HTML"),
                ),
              }),
            );
            for (let n = start.number + 1; n <= end.number; n++) {
              const line = state.doc.line(n);
              if (line.length) hide(line.from, line.to);
            }
            return false;
          }

          // --- 内联 HTML/注释：原位替换为徽标 ---
          if (
            name === "HTMLTag" ||
            name === "Comment" ||
            name === "ProcessingInstruction"
          ) {
            const source = state.doc.sliceString(
              node.from,
              Math.min(node.to, state.doc.length),
            );
            const label =
              name === "Comment"
                ? "注释"
                : name === "ProcessingInstruction"
                  ? "处理指令"
                  : htmlTagLabel(source, "HTML");
            const start = state.doc.lineAt(node.from);
            const end = state.doc.lineAt(Math.min(node.to, state.doc.length));
            if (start.number === end.number) {
              add(
                node.from,
                node.to,
                Decoration.replace({
                  widget: new HtmlBadgeWidget(node.from, source, false, label),
                }),
              );
            } else {
              // 跨行标签/注释：逐行隐藏，行首放一个徽标
              for (let n = start.number; n <= end.number; n++) {
                const line = state.doc.line(n);
                const f = Math.max(node.from, line.from);
                const t = Math.min(node.to, line.to);
                if (f < t) hide(f, t);
              }
              decos.push(
                Decoration.widget({
                  widget: new HtmlBadgeWidget(node.from, source, false, label),
                  side: 1,
                }).range(start.from),
              );
            }
            return;
          }

          // --- 链接引用定义 ---
          if (name === "LinkReference") {
            const start = state.doc.lineAt(node.from);
            const end = state.doc.lineAt(Math.min(node.to, state.doc.length));
            for (let n = start.number; n <= end.number; n++) {
              const line = state.doc.line(n);
              if (line.length) hide(line.from, line.to);
            }
            return false;
          }

          // --- 块级注释/处理指令：首行整行替换为徽标，其余行零宽隐藏 ---
          if (name === "CommentBlock" || name === "ProcessingInstructionBlock") {
            const start = state.doc.lineAt(node.from);
            const end = state.doc.lineAt(Math.min(node.to, state.doc.length));
            const source = state.doc.sliceString(
              node.from,
              Math.min(node.to, state.doc.length),
            );
            add(
              start.from,
              start.to,
              Decoration.replace({
                widget: new HtmlBadgeWidget(
                  node.from,
                  source,
                  true,
                  name === "CommentBlock" ? "注释" : "处理指令",
                ),
              }),
            );
            for (let n = start.number + 1; n <= end.number; n++) {
              const line = state.doc.line(n);
              if (line.length) hide(line.from, line.to);
            }
            return;
          }

          // --- 分割线：由 hrField（StateField）用 block widget 替换 ---
          if (name === "HorizontalRule") return false;

          // --- 代码块语言标签 ---
          if (name === "CodeInfo") {
            const pn = node.node.parent?.name;
            if (pn === "FencedCode") {
              const lang = state.doc.sliceString(node.from, node.to);
              // mermaid 块由独立的 mermaidField（StateField）处理——
              // ViewPlugin 不能提供 block 装饰（CM6 抛 RangeError 白屏）
              if (lang === "mermaid") return;
              add(
                node.from,
                node.to,
                Decoration.replace({ widget: new CodeHeaderWidget(lang) }),
              );
            } else {
              mark(node.from, node.to, "lp-code-info");
            }
            return;
          }

          // --- 代码块 ---
          if (name === "FencedCode" || name === "CodeBlock") {
            // mermaid 块由 mermaidField 替换整个块，这里跳过避免双重装饰
            if (name === "FencedCode") {
              const codeInfo = node.node.getChild("CodeInfo");
              const lang = codeInfo ? state.doc.sliceString(codeInfo.from, codeInfo.to) : "";
              if (lang === "mermaid") return false;
              // 无语言围栏没有 CodeInfo（不会走上面的头部替换），
              // 在开围栏标记后插一个仅含复制按钮的头部 widget
              if (!codeInfo) {
                const openMark = node.node.getChild("CodeMark");
                if (openMark) {
                  decos.push(
                    Decoration.widget({
                      widget: new CodeHeaderWidget(""),
                      side: 1,
                    }).range(openMark.to),
                  );
                }
              }
            }
            const start = state.doc.lineAt(node.from);
            const end = state.doc.lineAt(Math.min(node.to, state.doc.length));
            for (let n = start.number; n <= end.number; n++) {
              const line = state.doc.line(n);
              let cls = "lp-code-line";
              if (name === "FencedCode") {
                if (n === start.number) cls += " lp-code-fence lp-code-line-top";
                else if (n === end.number) cls += " lp-code-fence lp-code-line-bot";
              }
              addLine(line.from, Decoration.line({ class: cls }));
            }
            return;
          }

          // --- 表格：由 tableField 处理 ---
          if (name === "Table") return false;

          // --- 列表标记 ---
          if (name === "ListMark") {
            const text = state.doc.sliceString(node.from, node.to);
            if (/^[-+*]$/.test(text)) {
              add(
                node.from,
                node.to,
                Decoration.replace({ widget: new BulletWidget() }),
              );
            } else if (/^\d+[.)]\s?$/.test(text)) {
              mark(node.from, node.to, "lp-ordered-mark");
            }
            return;
          }
          if (name === "TaskMarker") {
            const inner = state.doc.sliceString(node.from + 1, node.from + 2);
            add(
              node.from,
              node.to,
              Decoration.replace({
                widget: new CheckboxWidget(
                  inner.toLowerCase() === "x",
                  node.from + 1,
                  state,
                ),
              }),
            );
            return;
          }
        },
      });
    }

    // 统一应用引用块行装饰：取每行最大嵌套深度。
    // 内层竖线用 linear-gradient 在背景上画，padding 和渐变动态计算，
    // 不依赖 CSS 硬编码深度上限，支持任意层级嵌套。
    for (const [lineNum, depth] of quoteDepths) {
      const line = state.doc.line(lineNum);
      const paddingLeft = 4 + 12 * depth;
      const attrs: Record<string, string> = {
        style: `padding-left:${paddingLeft}px;`,
      };
      if (depth > 1) {
        const stops: string[] = [];
        for (let i = 0; i < depth - 1; i++) {
          const start = 11 + 12 * i;
          const end = 14 + 12 * i;
          stops.push(
            `transparent ${start}px, var(--border) ${start}px, var(--border) ${end}px, transparent ${end}px`,
          );
        }
        attrs.style += [
          `background-image:linear-gradient(to right,${stops.join(",")})`,
          "background-size:100% 100%",
          "background-repeat:no-repeat",
        ].join(";");
      }
      addLine(line.from, Decoration.line({ class: "lp-quote", attributes: attrs }));
    }

    // ── 空行压缩计时（性能探针） ──
    const t0 = performance.now();
    // 统一空行压缩：每组连续空行的第一行高度压缩到接近 0。
    // 必须放在 ViewPlugin（而非独立 StateField）中，否则与 tableField 等
    // block widget 不在同一 DecorationSet，CM6 合并时会被 block 布局吞掉。
    //
    // 例外：两个普通段落（Paragraph）之间的空行保留正常高度——它是
    // 段落分隔符，不应消失。标题/表格/代码/列表/引用等块级节点与段落
    // 之间的空行是 markdown 语法要求的分隔符，压缩掉不影响阅读。
    const isParagraphBlock = (
      node: ReturnType<typeof tree.resolveInner> | null,
    ): boolean => {
      let n = node;
      while (n) {
        if (n.name === "Paragraph") return true;
        if (n.name === "Document") return false;
        n = n.parent;
      }
      return false;
    };
    // 判断解析节点是否属于"块级 widget 内容"（mermaid 围栏 / 水平线 / 表格）。
    // 这类节点被 block widget 替换成整块盒子，若两个相邻 widget 之间的空行被
    // 压缩为 0 高，同底色盒子会直接贴成一块（见 lp-mermaid 相邻粘连问题），
    // 因此需在 blankLineField 里对 widget↔widget 的空行保留自然高度作为白隙。
    // 普通代码块是逐行灰底装饰（非 block widget），不在本次范围内。
    const isBlockWidgetLine = (
      node: ReturnType<typeof tree.resolveInner> | null,
    ): boolean => {
      let n = node;
      while (n) {
        if (n.name === "HorizontalRule" || n.name === "Table") return true;
        if (n.name === "FencedCode" || n.name === "CodeBlock") {
          const ci = n.getChild("CodeInfo");
          return !!ci && state.doc.sliceString(ci.from, ci.to) === "mermaid";
        }
        if (n.name === "Document") return false;
        n = n.parent;
      }
      return false;
    };
    // 只遍历 ranges 涉及的行（±1 相邻行）而非全文——增量重建下每键只付
    // 变化区成本；全文重建时 ranges 覆盖全文，行为不变。
    const spans = emptyLineSpans(state, ranges);
    for (const span of spans) {
      for (let i = span.start; i <= span.end; i++) {
      const line = state.doc.line(i);
      if (line.length !== 0) continue;
      // 只压缩每组连续空行的第一行
      const prevLine = i > 1 ? state.doc.line(i - 1) : null;
      if (prevLine && prevLine.length === 0) continue;
      // 跳过代码块 / HTML 块 / 注释块内的空行
      let skip = false;
      let inner: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(line.from, 1);
      while (inner) {
        if (inner.name === "FencedCode" || inner.name === "CodeBlock" ||
            inner.name === "HTMLBlock" || inner.name === "CommentBlock") {
          skip = true;
          break;
        }
        inner = inner.parent;
      }
      if (skip) continue;
      // 空行前后都是普通段落时，保留空行（段落间需要视觉分隔）
      const beforePara = line.from > 0 && isParagraphBlock(tree.resolveInner(line.from - 1, -1));
      const afterPara = line.from + 1 < state.doc.length && isParagraphBlock(tree.resolveInner(line.from + 1, 1));
      // 空行前后都是块级 widget 时也保留——相邻 widget 若贴在一起会因同底色
      // 粘连成一块（两个相邻 mermaid 图渲染成单个灰面板），需要空行白隙分隔。
      const beforeWidget = line.from > 0 && isBlockWidgetLine(tree.resolveInner(line.from - 1, -1));
      const afterWidget = line.from + 1 < state.doc.length && isBlockWidgetLine(tree.resolveInner(line.from + 1, 1));
      // $$ 块级公式在语法树中只是普通段落文本（mathField 用正则识别为
      // block widget），按行首 $$ 特判，避免公式上下的空行被当作段落
      // 分隔符保留全高，导致公式前后间距异常大。
      const MATH_FENCE = /^\s*\$\$/;
      const prevIsMath =
        line.number > 1 && MATH_FENCE.test(state.doc.line(line.number - 1).text);
      const nextIsMath =
        line.number < state.doc.lines && MATH_FENCE.test(state.doc.line(line.number + 1).text);
      if (
        (beforePara && afterPara && !prevIsMath && !nextIsMath) || // 段落分隔
        (beforeWidget && afterWidget) // 相邻块级 widget 白隙
      ) continue;
      addLine(line.from, Decoration.line({
        class: "lp-block-spacer",
        attributes: { style: "line-height:0;font-size:0;min-height:0;padding-top:0;padding-bottom:0" },
      }));
      }
    }
    lpPerf("buildRanges:empty-lines", performance.now() - t0);

    return decos;
  }

  /** 首帧强制解析预算：与「初始 ~3000 字符 ≈ 视口首屏」设计一致。jsdom 无布局或
   *  慢机下 parseWorker 首帧可能未推进到该区间，直接读 syntaxTree 得到的树不完整，
   *  首帧装饰缺失（行内节点显示为源码，livePreview-incremental.test.ts 曾 flake）。
   *  用有界预算的 ensureSyntaxTree 保证扫描区间已同步解析：小文档即全文（确定性
   *  完整），大文档只解析视口前缀、不阻塞冷开，其余仍由 parseWorker / longDocParse
   *  Plugin 后台分片补齐。 */
  const INITIAL_PARSE_CHARS = 3000;
  const INITIAL_PARSE_BUDGET_MS = 100;
  function build(view: EditorView): DecorationSet {
    // 只扫已解析区间（初始 ~3000 字符 ≈ 视口首屏）：冷开不烧全量解析预算。
    // 小文档（<3000 字符）树即全文 → 装饰完整，滚动条稳定；大文档全文补齐
    // 由 parseWorker / longDocParsePlugin 后台分片推进，树推进事务经
    // mergeRanges 增量补齐新区间（见 update()），不再阻塞主线程。
    const t0 = performance.now();
    // 先确保首屏区间已同步解析，再读树扫描（见上方常量注释）
    const docLen = view.state.doc.length;
    if (docLen > 0) {
      ensureSyntaxTree(
        view.state,
        Math.min(docLen, INITIAL_PARSE_CHARS),
        INITIAL_PARSE_BUDGET_MS,
      );
    }
    const tree = syntaxTree(view.state);
    if (!tree) return Decoration.none;
    const t1 = performance.now();
    const decos = buildRanges(view.state, tree, [{ from: 0, to: tree.topNode.to }]);
    const t2 = performance.now();
    const set = RangeSet.of(decos, true);
    lpPerf("build:parse", t1 - t0);
    lpPerf("build:ranges", t2 - t1);
    lpPerf("build:rangeset", performance.now() - t2);
    return set;
  }

  // 增量重建：把变化区（编辑区域 + 语法树推进区域，扩展到整行）内的旧装饰
  // 剔除、换上 buildRanges 的新装饰；区外的旧装饰保持【同一实例】保留——
  // CM6 装饰比较对相同实例短路，findChangedDeco/tile 遍历在未变化区域是
  // O(1) 命中，每次击键成本从 O(全文装饰) 降到 O(变化区)。
  function mergeRanges(
    state: EditorState,
    mapped: DecorationSet,
    ranges: readonly { from: number; to: number }[],
    tree: ReturnType<typeof syntaxTree>,
    /** 追踪新装饰外延的最大位置（供主插件 decoratedTop 跳过冗余重解析） */
    onMaxTo?: (to: number) => void,
  ): DecorationSet {
    // 扩展到整行（行装饰锚定 line.from，编辑行必须整行重建，否则旧行装饰残留）
    const expanded = ranges
      .map((r) => ({
        from: state.doc.lineAt(Math.min(r.from, state.doc.length)).from,
        to: state.doc.lineAt(Math.min(r.to, state.doc.length)).to,
      }))
      .filter((r) => r.to > r.from)
      .sort((a, b) => a.from - b.from);
    // 合并重叠区间
    const merged: typeof expanded = [];
    for (const r of expanded) {
      const last = merged[merged.length - 1];
      if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
      else merged.push({ ...r });
    }

    // 先算新装饰——可能外延延伸出 merged（如跨解析 frontier 的围栏：open
    // 在 merged 之前、内容延伸到 merged 内），因此点装饰冲突判断要对全部
    // 新装饰生效，而非仅 merged 内。
    const newItems = buildRanges(state, tree, merged);
    if (merged.length === 0) return mapped;
    // 剔除与「新点装饰」冲突的旧装饰：CodeHeaderWidget（replace/widget，
    // point=true）跨 frontier 会被重发，半开重叠 spansOverlap 判不出点-点
    // 重合 → 同位置双 widget。规则：新点装饰与原旧点装饰同锚点（n.from === f）
    // → 旧项作废（新行装饰同 from 覆盖旧行装饰、新 widget 替换旧 widget；
    // 主插件 replace 不"吞掉"旧内容，无 containment 情形）。mark（point=false）
    // 加性可重叠，不参与冲突判断；新 widget 在行中部时（from 不同）不误杀。
    // 预构建 from Set，filter 内 O(1) 查询（避免大解析区时 O(窗内点装饰 × 新点装饰)）。
    const newPointFroms = new Set<number>();
    for (const n of newItems) {
      if (n.value.point) newPointFroms.add(n.from);
    }

    // RangeSet.update 增量装配：窗外 chunk 整块复用（O(Δ)），替代
    // collect-all + 全局 sort + RangeSetBuilder 全量重建（O(总装饰)）。
    // filter 窗口覆盖 merged 全部外延（含新点装饰向后/向前的跨区块外延），
    // 窗内旧装饰被 filter 剔除、窗外原样复用。
    let filterFrom = merged[0].from;
    let filterTo = merged[merged.length - 1].to;
    for (const n of newItems) {
      if (n.value.point) filterFrom = Math.min(filterFrom, n.from);
      filterTo = Math.max(filterTo, n.to);
    }
    onMaxTo?.(filterTo);
    return mapped.update({
      add: newItems,
      sort: true,
      filterFrom,
      filterTo,
      // true=保留：不在变化区内、且旧点装饰不与新点装饰同锚点。
      // 变化区判定：mark（point=false）按区间半开重叠；点装饰（行/替换，
      // point=true）按锚点 f 落在 merged 覆盖的行内（闭区间）——退化点 [f,f]
      // 经 map 可能停在重建区边界（如行首插入后旧行装饰停回 [0,0]），
      // 半开重叠 `r.from < t` 对 [f,f] 恒假 → 残留旧行装饰与新装饰共存。
      // 点装饰锚点落进重建行 → 剔除（该行由 buildRanges 重建，若仍在则重发）。
      filter: (f, t, v) =>
        (v.point
          ? !merged.some((r) => r.from <= f && f <= r.to)
          : !merged.some((r) => r.from < t && f < r.to)) &&
        (!v.point || !newPointFroms.has(f)),
    });
  }

  return [
    hrField,
    frontmatterField,
    tableField,
    mermaidField,
    mermaidSelectionPlugin,
    mathField,
    positionRefreshPlugin,
    longDocParsePlugin,
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        /** 装饰已构建到的最远位置（当前文档坐标）。用于跳过"重解析已装饰内容"
         *  的冗余重建：已完全解析的文档中编辑时，树被截断后重解析整个尾部，
         *  但尾部装饰已存在（map 后位置平移即可），无需重建。 */
        decoratedTop = 0;
        constructor(view: EditorView) {
          this.decorations = build(view);
          mainDecoViews.set(view, this);
          this.decoratedTop = syntaxTree(view.state).topNode.to;
        }
        update(u: ViewUpdate) {
          const prevTree = syntaxTree(u.startState);
          const tree = syntaxTree(u.state);
          // 仅文档变更或语法树收敛时重建；滚动无需重建
          if (!u.docChanged && prevTree === tree) return;
          if (u.docChanged) this.decoratedTop = u.changes.mapPos(this.decoratedTop);
          const maxTo = (to: number) => {
            this.decoratedTop = Math.max(this.decoratedTop, to);
          };

          if (u.docChanged && this.decorations.size > 0) {
            // 增量：map 旧集 + 只重建变化区（编辑区域 + 增量解析推进区域）。
            // 长文档每次击键不再 O(全文装饰)——实测 235KB 文档从 ~238ms
            // 降到 ~20ms（增量重建）+ ~18ms（CM6 核心 tile/deco diff，随
            // 行内 mark 总量线性——mark 数量是剩余主瓶颈）。
            const t0 = performance.now();
            const mapped = this.decorations.map(u.changes);
            const ranges: { from: number; to: number }[] = [];
            u.changes.iterChangedRanges((_fA, _tA, fB, tB) => {
              ranges.push({ from: fB, to: tB });
            });
            // 增量解析推进区域：只处理超出已装饰范围的新内容——
            // 长文档加载后树前沿不断推进补齐装饰；已完全解析后编辑产生的
            // 重解析（[prevTop, treeTop] 在 decoratedTop 内）是冗余，跳过。
            if (tree !== prevTree && tree.topNode.to > this.decoratedTop) {
              ranges.push({
                from: Math.max(prevTree.topNode.to, this.decoratedTop),
                to: tree.topNode.to,
              });
            }
            this.decorations = mergeRanges(u.state, mapped, ranges, tree, maxTo);
            lpPerf("build:incremental", performance.now() - t0);
          } else if (
            tree !== prevTree &&
            tree.topNode.to > this.decoratedTop &&
            this.decorations.size > 0
          ) {
            // 树推进（无 doc 变化）：只重建超出已装饰范围的新解析区间（O(Δ)），
            // 不再全量。无 doc 变化时 changes 为空，map 即恒等，旧集本身可作映射后集。
            const t0 = performance.now();
            this.decorations = mergeRanges(
              u.state,
              this.decorations,
              [
                {
                  from: Math.max(prevTree.topNode.to, this.decoratedTop),
                  to: tree.topNode.to,
                },
              ],
              tree,
              maxTo,
            );
            lpPerf("build:treeprog", performance.now() - t0);
          } else {
            // 初始构建（decorations 为空）或树被替换未增长：全量重建
            this.decorations = build(u.view);
            this.decoratedTop = tree.topNode.to;
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}

// ---------------------------------------------------------------------------
// 分割线：块级替换必须走 StateField（CM6 禁止 ViewPlugin 提供 block widget）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// block widget 替换范围的统一规则（hrField / tableField / mermaidField /
// mathField 共用）。CM6 对 block 替换有两条隐性约束，违反就会在 widget
// 前后渲染出多余空行：
//   1. 下边界必须吞掉末行的换行符（扩展到下一行行首），否则残留的 \n 会在
//      widget 下方渲染出一个未被 blankLineField 压缩的全高"幻影空行"；
//   2. 两个 widget 的替换范围不能重叠——相邻空行只能归一方吞并，否则 CM6
//      合并装饰时会在两个 widget 之间渲染出一个全高空行。
// 统一约定：前导空行（一个）归本 widget 吞并；尾随空行一律不吞——下方是
// widget 时由它作为前导空行吞并，是文本时由 blankLineField 压缩为 0 高度。
// 每个 widget 只向上看，任何相邻组合都不重叠，无需跨字段协调。
// ---------------------------------------------------------------------------
function blockWidgetRange(
  state: EditorState,
  nodeFrom: number,
  nodeTo: number,
): { from: number; to: number } {
  const doc = state.doc;
  const startLine = doc.lineAt(nodeFrom);
  let from = startLine.from;
  if (startLine.number > 1 && doc.line(startLine.number - 1).length === 0) {
    from = doc.line(startLine.number - 1).from; // 吞掉一个前导空行
  }
  // 节点范围可能包含末尾换行：先对齐到行尾
  let endPos = Math.min(nodeTo, doc.length);
  if (endPos > nodeFrom && doc.sliceString(endPos - 1, endPos) === "\n") {
    endPos--;
  }
  const endLine = doc.lineAt(endPos);
  // 仅当节点覆盖满末行内容时才吞掉 \n（扩展到下一行行首）；行尾后还有
  // 残留文本时（如行内闭合的 $$ 后接文字）保持原范围，避免吞掉文本。
  // 注意 CM6 的 Line.to 本就不含换行符（= from + length），所以这里直接
  // 与 endLine.to 比较即可。吞 \n 生效后，widget 与后续 block widget 之间
  // 仍可能残留的幻影空行由 index.css 的 :has(> br) 规则压缩。
  let to = endPos;
  if (endPos === endLine.to) {
    const next = endLine.number + 1;
    to = next <= doc.lines ? doc.line(next).from : doc.length;
  }
  return { from, to };
}

/** 获取文档 frontmatter 块占据的源码范围。若文档未以 YAML frontmatter 开头则返回 null。
 *  hrField 查询此值以跳过 frontmatter 的 --- 行（避免渲染为分割线）。 */
function getFrontmatterRange(state: EditorState): { from: number; to: number } | null {
  const end = matchFrontmatterEnd(state);
  if (end === null) return null;
  const { from, to } = blockWidgetRange(state, 0, end);
  return { from, to };
}

// ── 块级 StateField 的增量重建（hr / mermaid / table 共用）─────────────
// docChanged 时只重扫变化区（扩展整行 + 相交旧装饰区间），区外沿用 map 后
// 的旧装饰——避免每键 ensureSyntaxTree(全文) + 全树遍历（大文档打字卡的主因，
// 实测极端文档 hr 45ms + table 30ms + mermaid 26ms/键）。与变化区相交的新块
// 按整块接收（块体可延伸出变化区）；被新块覆盖/吞掉的旧装饰一律剔除。
// 语法树推进（非编辑）事务仍走全量——初始渐进解析的新块可能出现在任意位置。
// ────────────────────────────────────────────────────────────────────────

interface DecoSpan {
  from: number;
  to: number;
}

/** 构造 RangeSet.update 的 add 元素：Range.create 标记 @internal 未入公共类型
 * （构造函数私有），但运行时存在——从 between 收集的 (from,to,value) 还原完整
 * Range，供 mapped.update({ add }) 使用。 */
function makeRange(from: number, to: number, value: Decoration): Range<Decoration> {
  const ctor = Range as unknown as {
    create(f: number, t: number, v: Decoration): Range<Decoration>;
  };
  return ctor.create(from, to, value);
}

function mergeSpans(spans: readonly DecoSpan[]): DecoSpan[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: DecoSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

type SyntaxTreeType = ReturnType<typeof syntaxTree>;
/** 树迭代节点类型（typeof 推导，避免直接依赖 @lezer/common——项目未列为直接依赖） */
type IterNode = Parameters<NonNullable<Parameters<SyntaxTreeType["iterate"]>[0]["enter"]>>[0];

function incrementalBlockFieldUpdate(
  value: DecorationSet,
  tr: Transaction,
  scan: (state: EditorState, ranges?: readonly DecoSpan[]) => DecorationSet,
): DecorationSet {
  const prevTree = syntaxTree(tr.startState);
  const tree = syntaxTree(tr.state);

  if (!tr.docChanged) {
    // 语法树推进事务（parseWorker / longDocParsePlugin 分片取树）：
    // 只补新解析出的区间，不再全量重扫（大文档 O(全文) 爆点 → O(Δ)）。
    // 树被替换但未增长（编辑后重解析重排）→ 全量兜底。
    if (prevTree === tree) return value;
    if (tree.topNode.to <= prevTree.topNode.to) return scan(tr.state);
  }

  const state = tr.state;

  // 1. 变化区（新文档坐标）扩展到整行
  const changed: DecoSpan[] = [];
  tr.changes.iterChangedRanges((_fA, _tA, fB, tB) => {
    const fromPos = Math.min(fB, state.doc.length);
    const toPos = Math.min(Math.max(tB, fB), state.doc.length);
    changed.push({
      from: state.doc.lineAt(fromPos).from,
      to: state.doc.lineAt(toPos).to,
    });
  });

  // 1b. 树推进区（同事务顺带拾取击键时的 20ms 解析推进）：
  //     新解析出的区间 [prevTree.topNode.to, tree.topNode.to] 扩展整行
  if (tree !== prevTree && tree.topNode.to > prevTree.topNode.to) {
    const f = Math.min(prevTree.topNode.to, state.doc.length);
    const t = Math.min(tree.topNode.to, state.doc.length);
    if (t > f) {
      changed.push({
        from: state.doc.lineAt(f).from,
        to: state.doc.lineAt(t).to,
      });
    }
  }

  // 2. 旧装饰 map 到新坐标
  const mapped = value.map(tr.changes);

  // 3. 固定点扩展：并入与变化区相交的旧块区间（块边界可能因编辑伸缩 /
  //    吞前导空行），合并至不动点。用 between(区域) 查询相交旧块，替代
  //    collect-all 全文（O(总装饰) → O(触及块数)）。
  let expanded = mergeSpans(changed);
  for (;;) {
    const bounds = {
      from: expanded[0]?.from ?? 0,
      to: expanded[expanded.length - 1]?.to ?? 0,
    };
    let grown = false;
    mapped.between(bounds.from, bounds.to, (f, t) => {
      // 旧块外延超出当前窗口 → 并入继续扩展；完全在窗内则已覆盖
      if (f < bounds.from || t > bounds.to) {
        expanded.push({ from: f, to: t });
        grown = true;
      }
    });
    if (!grown) break;
    expanded = mergeSpans(expanded);
  }

  // 4. 重扫变化区（scan 输出可能吞前导空行，块外延超出 expanded）
  const newSet = scan(state, expanded);
  const newItems: Range<Decoration>[] = [];
  newSet.between(0, state.doc.length, (f, t, v) => {
    newItems.push(makeRange(f, t, v));
  });

  // 5/6. RangeSet.update 增量装配：filter 剔除与 expanded 相交或被新块覆盖的
  //    旧块（块替换区间不得重叠），窗外 chunk 整块复用 → O(Δ)。
  let filterFrom = expanded[0]?.from ?? 0;
  let filterTo = expanded[expanded.length - 1]?.to ?? 0;
  for (const n of newItems) {
    filterFrom = Math.min(filterFrom, n.from);
    filterTo = Math.max(filterTo, n.to);
  }
  return mapped.update({
    add: newItems,
    sort: true,
    filterFrom,
    filterTo,
    // true=保留：不在变化区内、且不被新块覆盖（半开重叠，块区间 from<to；
    // 相邻块共享端点不算冲突）
    filter: (f, t) =>
      !expanded.some((r) => r.from < t && f < r.to) &&
      !newItems.some((nd) => nd.from < t && f < nd.to),
  });
}

/** 按区间限制扫描的公共骨架：ranges 缺省=全文（create/树推进全量扫）；
 *  各 find 函数只提供 enter 回调。区间内节点可能跨区间被重复访问，用 seen 去重。 */
function scanBlockNodes(
  state: EditorState,
  ranges: readonly DecoSpan[] | undefined,
  enter: (node: IterNode) => boolean | void,
): SyntaxTreeType | null {
  // 不强制解析：只扫已解析区间（初始 ~3000 字符 ≈ 视口首屏）。冷开不再
  // 每字段烧 500ms ensureSyntaxTree 预算（大文档累计数秒冻结）。全文补齐由
  // parseWorker 与 longDocParsePlugin 后台分片推进，增量路径（见
  // incrementalBlockFieldUpdate）在树推进事务里补齐新区间。
  const tree = syntaxTree(state);
  if (!tree) return null;
  if (ranges) {
    for (const r of ranges) tree.iterate({ from: r.from, to: r.to, enter });
  } else {
    tree.iterate({ enter });
  }
  return tree;
}

function findHorizontalRules(state: EditorState, ranges?: readonly DecoSpan[]): DecorationSet {
  const t0 = performance.now();
  const decos: Range<Decoration>[] = [];
  const fmRange = getFrontmatterRange(state);
  const seen = new Set<number>();
  const tree = scanBlockNodes(state, ranges, (node) => {
    if (node.name !== "HorizontalRule") return;
    if (seen.has(node.from)) return;
    seen.add(node.from);
    // 跳过 frontmatter 的 --- 行（由 frontmatterField 统一处理）
    if (fmRange && node.from >= fmRange.from && node.to <= fmRange.to) return;
    const { from, to } = blockWidgetRange(state, node.from, node.to);
    decos.push(
      Decoration.replace({
        widget: new HrWidget(),
        block: true,
        inclusive: false,
      }).range(from, to),
    );
  });
  if (!tree) return Decoration.none;
  const set = RangeSet.of(decos, true);
  lpPerf("field:hr", performance.now() - t0);
  return set;
}

const hrField = StateField.define<DecorationSet>({
  create(state) {
    return findHorizontalRules(state);
  },
  update(value, tr) {
    return incrementalBlockFieldUpdate(value, tr, findHorizontalRules);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// YAML Frontmatter：在所见即所得模式下完全隐藏文档开头的 ---…--- 块，
// 零空间占用。原始源码不变，切换到源码模式仍可编辑。
// 编辑操作通过右侧 FrontmatterPanel 面板进行。
// ---------------------------------------------------------------------------

/** 零高度占位 widget：替换 frontmatter 块，不渲染任何可见内容 */
class FrontmatterSpacer extends WidgetType {
  eq() { return true; }
  ignoreEvent() { return false; }
  toDOM() {
    return document.createElement("div");
  }
  get estimatedHeight() { return 0; }
}

function findFrontmatterDecorations(state: EditorState): DecorationSet {
  const t0 = performance.now();
  const end = matchFrontmatterEnd(state);
  if (end === null) return Decoration.none;
  const { from, to } = blockWidgetRange(state, 0, end);
  const deco = Decoration.replace({
    widget: new FrontmatterSpacer(),
    block: true,
    inclusive: false,
  }).range(from, to);
  const set = RangeSet.of([deco], true);
  lpPerf("field:frontmatter", performance.now() - t0);
  return set;
}

const frontmatterField = StateField.define<DecorationSet>({
  create(state) {
    return findFrontmatterDecorations(state);
  },
  update(_value, tr) {
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return findFrontmatterDecorations(tr.state);
    }
    return _value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// Mermaid 图表：同样必须走 StateField（block 装饰不能由 ViewPlugin 提供，
// 否则 CM6 抛 RangeError "Block decorations may not be specified via plugins"，
// 含 mermaid 块的所见即所得文档直接白屏）。原实现错误地在 buildRanges
// （ViewPlugin）里用 block:true，已迁移到此 StateField。
// ---------------------------------------------------------------------------

function findMermaid(state: EditorState, ranges?: readonly DecoSpan[]): DecorationSet {
  const t0 = performance.now();
  const decos: Range<Decoration>[] = [];
  const seen = new Set<number>();
  const tree = scanBlockNodes(state, ranges, (node) => {
    if (node.name !== "FencedCode") return;
    if (seen.has(node.from)) return false;
    seen.add(node.from);
    const codeInfo = node.node.getChild("CodeInfo");
    if (!codeInfo) return;
    const lang = state.doc.sliceString(codeInfo.from, codeInfo.to);
    if (lang !== "mermaid") return;
    const parent = node.node;
    // 提取逻辑与复制按钮共用 fencedCodeContent；mermaid 需 trim 后判空
    const code = fencedCodeContent(state, parent.from, parent.to).trim();
    if (code) {
      const dark = document.documentElement.classList.contains("dark");
      const rawSource = state.sliceDoc(parent.from, parent.to);
      // widget 记录的 from/to 仍是源码节点范围（编辑锚点），
      // 仅装饰范围按统一规则扩展（吞前导空行与行尾换行）。
      const { from, to } = blockWidgetRange(state, parent.from, parent.to);
      decos.push(
        Decoration.replace({
          widget: new MermaidWidget(code, dark, parent.from, parent.to, rawSource, state),
          block: true,
          inclusive: false,
        }).range(from, to),
      );
    }
    return false;
  });
  if (!tree) return Decoration.none;
  const set = RangeSet.of(decos, true);
  lpPerf("field:mermaid", performance.now() - t0);
  return set;
}

// 主题切换触发 mermaid 重渲染：dark class 变化不走 CM 事务，mermaidField
// 不会自动重算，需由外部（Editor.tsx 的 MutationObserver）dispatch 此 effect。
export const mermaidThemeEffect = StateEffect.define<null>();

const mermaidField = StateField.define<DecorationSet>({
  create(state) {
    return findMermaid(state);
  },
  update(value, tr) {
    // 主题切换必须全量（所有图表按新主题重建 widget）
    if (tr.effects.some((e) => e.is(mermaidThemeEffect))) return findMermaid(tr.state);
    return incrementalBlockFieldUpdate(value, tr, findMermaid);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Mermaid 选中高亮：CM6 的 selection layer 不会绘制到被 block replace 的
// widget 区域上，拖选经过图表时图表本体无"被选中"反馈（实际选区已覆盖底层
// 源码）。这里比较选区与 widget 记录的源码范围（data-mermaid-from/to），
// 有重叠即加 class，由 CSS 画高亮。
const mermaidSelectionPlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.sync(view);
    }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged) this.sync(u.view);
    }
    sync(view: EditorView) {
      // requestMeasure：read/write 在 DOM 补丁之后执行，
      // docChanged 时才能读到刷新后的 data-mermaid-from/to。
      view.requestMeasure({
        read() {
          const ranges = view.state.selection.ranges;
          return Array.from(
            view.dom.querySelectorAll<HTMLElement>(".lp-mermaid"),
          ).map((el) => {
            const from = Number(el.dataset.mermaidFrom);
            const to = Number(el.dataset.mermaidTo);
            const hit =
              !Number.isNaN(from) &&
              !Number.isNaN(to) &&
              ranges.some((r) => r.from < to && r.to > from);
            return { el, hit };
          });
        },
        write(hits) {
          for (const { el, hit } of hits) {
            el.classList.toggle("lp-mermaid-selected", hit);
          }
        },
      });
    }
  },
);

// ---------------------------------------------------------------------------
// 表格：块级替换必须走 StateField——CM6 禁止 ViewPlugin 提供 block widget
// （"Block decorations may not be specified via plugins"，违规直接白屏）。
// StateField 属于 state 侧装饰源，不受此限。
// ---------------------------------------------------------------------------

function findTables(state: EditorState, ranges?: readonly DecoSpan[]): DecorationSet {
  const t0 = performance.now();
  const decos: Range<Decoration>[] = [];
  // 使用 ensureSyntaxTree 强制等待完整解析（与 ViewPlugin build 一致）。
  // syntaxTree 是增量非阻塞树，文档较长时末尾区域可能尚未解析，
  // Table 节点缺失 → 表格永远不渲染（tableField.update 的语法树
  // 变化检测只能补救文档编辑后的重新解析，无法补救初始未解析）。
  const seen = new Set<number>();
  const tree = scanBlockNodes(state, ranges, (node) => {
    if (node.name !== "Table") return;
    if (seen.has(node.from)) return false;
    seen.add(node.from);
    const startLine = state.doc.lineAt(node.from);
    // 装饰范围按统一规则计算（吞一个前导空行 + 行尾换行，见 blockWidgetRange）。
    const { from: replaceFrom, to: replaceTo } = blockWidgetRange(state, node.from, node.to);
    const hasLeadingBlank = replaceFrom < startLine.from;
    // raw 与 TableWidget 的编辑锚点仍用节点自身范围（对齐到行尾、不含 \n）。
    let endPos = Math.min(node.to, state.doc.length);
    if (endPos > node.from && state.doc.sliceString(endPos - 1, endPos) === "\n") {
      endPos--;
    }
    const endLine = state.doc.lineAt(endPos);
    const raw = state.doc.sliceString(replaceFrom, endLine.to);
    decos.push(
      Decoration.replace({
        widget: new TableWidget(raw, replaceFrom, endLine.to, hasLeadingBlank, state),
        block: true,
        inclusive: false,
      }).range(replaceFrom, replaceTo),
    );
    return false;
  });
  if (!tree) return Decoration.none;
  const set = RangeSet.of(decos, true);
  lpPerf("field:table", performance.now() - t0);
  return set;
}

const tableField = StateField.define<DecorationSet>({
  create(state) {
    return findTables(state);
  },
  update(value, tr) {
    // 语法树增量解析完成后也会触发 update（docChanged=false），
    // 此时若 syntaxTree 变了（新 Table 节点被解析出来），需要重建装饰。
    // 否则初始化时未解析到的表格会永远停留在源码态。
    // （docChanged 时走增量：只重扫变化区，见 incrementalBlockFieldUpdate）
    return incrementalBlockFieldUpdate(value, tr, findTables);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// KaTeX 数学公式：行内 $...$ 和块级 $$...$$ 均由 StateField 统一处理。
// 使用正则扫描全文，跳过代码块/HTML/注释内部，异步加载 KaTeX 渲染。
// ---------------------------------------------------------------------------

let katexModule: typeof import("katex").default | null = null;

// 预加载 KaTeX 模块：异步加载但不阻塞页面。一旦加载完成，所有后续
// MathWidget.toDOM() 都走同步渲染路径（不再有 then 回调），CM6 在
// widget 插入时就能测到正确高度，从根本上消除异步渲染带来的点击偏移。
import("katex").then((m) => {
  katexModule = m.default;
});

function loadKatex(): Promise<typeof import("katex").default> {
  if (katexModule) return Promise.resolve(katexModule);
  return import("katex").then((m) => {
    katexModule = m.default;
    return katexModule!;
  });
}

// WeakMap：DOM → Widget 实例，供右键菜单反向查找与位置刷新
const mathWidgetMap = new WeakMap<HTMLElement, MathWidget>();
const imageWidgetMap = new WeakMap<HTMLElement, ImageWidget>();
const checkboxWidgetMap = new WeakMap<HTMLInputElement, CheckboxWidget>();
const mermaidWidgetMap = new WeakMap<HTMLElement, MermaidWidget>();

// ── Widget 位置刷新 ──
// eq 只比较内容（from/to 是旧/新坐标系，进 eq 会让编辑点后的所有 widget 每次
// 击键 eq-false → 全量销毁重建 + KaTeX/Mermaid 重渲染）。但 DOM 被复用时，
// 旧实例的 from/to 会过期——右键菜单、编辑校验、勾选改字、表格操作都依赖
// 这些坐标。因此每次 docChanged 后用 tr.changes.mapPos 统一刷新可见 widget
// 的实例字段与 data-* 属性（O(可见 widget)，约 1ms 内）。
// 新鲜度判定：widget 记录构造时的来源 state；本次事务重建的 widget 坐标已新
// （state 与当前相同 → 跳过，避免双重偏移），跨事务复用的旧实例坐标过期
// （state 不同 → mapPos 校正）。
function refreshWidgetPositions(view: EditorView, changes: { mapPos(pos: number, assoc?: number): number }): void {
  const fresh = (s: { state?: EditorState } | undefined | null): boolean =>
    s != null && s.state === view.state;
  for (const el of view.dom.querySelectorAll<HTMLElement>(".lp-math-inline, .lp-math-block")) {
    const w = mathWidgetMap.get(el);
    if (!w || fresh(w)) continue;
    w.from = changes.mapPos(w.from, 1);
    w.to = changes.mapPos(w.to, 1);
    el.setAttribute("data-math-from", String(w.from));
    el.setAttribute("data-math-to", String(w.to));
  }
  for (const el of view.dom.querySelectorAll<HTMLElement>(".lp-table-wrapper")) {
    const w = tableWidgetMap.get(el);
    if (!w || fresh(w)) continue;
    w.from = changes.mapPos(w.from, 1);
    w.to = changes.mapPos(w.to, 1);
  }
  for (const el of view.dom.querySelectorAll<HTMLElement>(".lp-mermaid")) {
    const w = mermaidWidgetMap.get(el);
    if (!w || fresh(w)) continue;
    w.from = changes.mapPos(w.from, 1);
    w.to = changes.mapPos(w.to, 1);
    el.setAttribute("data-mermaid-from", String(w.from));
    el.setAttribute("data-mermaid-to", String(w.to));
  }
  for (const el of view.dom.querySelectorAll<HTMLElement>(".lp-image-wrap")) {
    const w = imageWidgetMap.get(el);
    if (!w || fresh(w)) continue;
    w.from = changes.mapPos(w.from, 1);
    w.to = changes.mapPos(w.to, 1);
    el.setAttribute("data-img-from", String(w.from));
    el.setAttribute("data-img-to", String(w.to));
  }
  for (const el of view.dom.querySelectorAll<HTMLInputElement>("input.lp-checkbox")) {
    const w = checkboxWidgetMap.get(el);
    if (!w || fresh(w)) continue;
    w.pos = changes.mapPos(w.pos, 1);
  }
}

// docChanged 后刷新可见 widget 位置（见 refreshWidgetPositions）
const positionRefreshPlugin = ViewPlugin.fromClass(
  class {
    update(u: ViewUpdate) {
      if (u.docChanged) refreshWidgetPositions(u.view, u.changes);
    }
  },
);

// 加载后渐进全量解析：StateField 的 create() 在 parseState 初始化之前运行，
// 其中的 ensureSyntaxTree 是空操作；view 建好后视口又只解析首屏——打开 4800 行
// 长文档时超过首屏 ~3KB 的内容没有即时渲染装饰，直到用户敲第一个键才开始渐进
// 解析。这里在初始化完成后分片推进全文解析（每片 50ms 预算、片间让出主线程，
// 避免一次性 2000ms 同步解析卡死 UI），树完整后 dispatch 空事务触发各 field 重建。
// 短文档树已完整：ensureSyntaxTree 立即返回、空事务无副作用。
const LONG_DOC_PARSE_SLICE_MS = 50;
const longDocParsePlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      const step = () => {
        if (!view.dom.isConnected) return; // view 已销毁
        // 每片重新读取 view.state：解析进度挂在文档的语法树字段上，
        // 片间用户输入产生的增量重解析与本循环共享进度，互不冲突
        if (ensureSyntaxTree(view.state, view.state.doc.length, LONG_DOC_PARSE_SLICE_MS)) {
          if (view.dom.isConnected) view.dispatch({});
          return;
        }
        setTimeout(step, 0);
      };
      setTimeout(step, 0);
    }
    update() {}
  },
);

/** 双击公式时的回调（由 Editor 组件注入，绕开 CM6 的 DOM 事件拦截） */
let _onMathDblClick: ((el: HTMLElement) => void) | null = null;
export function setMathDblClickHandler(fn: ((el: HTMLElement) => void) | null) {
  _onMathDblClick = fn;
}

/** Mermaid 右键菜单回调（通过 mousedown button=2 触发，绕开 CM6 拦截） */
let _onMermaidContextMenu: ((e: MouseEvent) => void) | null = null;
export function setMermaidContextMenuHandler(fn: ((e: MouseEvent) => void) | null) {
  _onMermaidContextMenu = fn;
}

export function getMathWidgetFromEl(el: HTMLElement): MathWidget | null {
  let cur: HTMLElement | null = el;
  while (cur) {
    const w = mathWidgetMap.get(cur);
    if (w) return w;
    cur = cur.parentElement;
  }
  return null;
}

class MathWidget extends WidgetType {
  constructor(
    readonly formula: string,
    readonly display: boolean,
    /** 源码区间（编辑锚点），positionRefreshPlugin 会刷新 */
    from: number = 0,
    to: number = 0,
    /** 文档中 from..to 之间的原始源码（含定界符和换行），供编辑时比对 */
    readonly rawSource?: string,
    /** 来源 state：刷新时区分新鲜/过期坐标 */
    readonly state?: EditorState,
  ) {
    super();
    this.from = from;
    this.to = to;
  }
  from: number;
  to: number;

  eq(other: MathWidget) {
    // 只比较内容，不比较 from/to：旧实例是旧文档坐标、新实例是新文档坐标，
    // 混比必然不相等 → 编辑点后的所有公式每次击键 eq-false → 全部销毁重建、
    // KaTeX 全量重渲染（长文档输入卡顿的主因，实测单键 40+ 次渲染）。
    // 位置刷新由 positionRefreshPlugin 在 docChanged 后统一 mapPos。
    return other.formula === this.formula && other.display === this.display
      && other.rawSource === this.rawSource;
  }

  // from/to/rawSource 仅作编辑锚点（data 属性供右键菜单/编辑校验读取），与渲染内容无关。
  // 文档编辑使公式位置偏移时（eq false，但 formula/display 未变）复用已渲染的 DOM，
  // 仅刷新位置属性——否则公式上方每次击键都会销毁重建下方所有公式（KaTeX 全量重渲染）。
  // 注意：不能把 from/to 移出 eq——eq 命中时 CM6 不再调用 updateDOM，位置属性会过期
  //（Editor.tsx 的 editMathFormula 依赖 data-math-raw 校验）。
  updateDOM(dom: HTMLElement, _view: EditorView, from: this): boolean {
    if (from.formula !== this.formula || from.display !== this.display) return false;
    dom.setAttribute("data-math-from", String(this.from));
    dom.setAttribute("data-math-to", String(this.to));
    dom.setAttribute("data-math-formula", this.formula);
    dom.setAttribute("data-math-display", this.display ? "1" : "0");
    if (this.rawSource != null) {
      dom.setAttribute("data-math-raw", this.rawSource);
    } else {
      dom.removeAttribute("data-math-raw");
    }
    // 反向查找表同步指向新实例（旧实例的 from/to 已过期）
    mathWidgetMap.set(dom, this);
    return true;
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("span");
    wrapper.className = this.display ? "lp-math-block" : "lp-math-inline";
    if (this.display) {
      // padding 替代 margin：CM6 测量 block widget 高度时只计 border-box
      //（content+padding+border），不包含 margin。每个块级公式的 margin
      // 会累积偏移（同表格 .lp-table-wrapper 的修复）。
      wrapper.style.cssText =
        "display:block;padding:0.6em 0;text-align:center";
    }

    // 存储公式信息到 data 属性，供右键菜单读取
    wrapper.setAttribute("data-math-from", String(this.from));
    wrapper.setAttribute("data-math-to", String(this.to));
    wrapper.setAttribute("data-math-formula", this.formula);
    wrapper.setAttribute("data-math-display", this.display ? "1" : "0");
    if (this.rawSource != null) {
      wrapper.setAttribute("data-math-raw", this.rawSource);
    }
    mathWidgetMap.set(wrapper, this);

    // 双击公式进入编辑模式（mousedown 手动检测，直接回调，避免 DOM 事件被 CM6 拦截）
    let lastMd = 0;
    wrapper.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return; // 只响应左键（右键双击也会进编辑态，同 MermaidWidget 过滤）
      const now = Date.now();
      if (now - lastMd < 350) {
        e.preventDefault();
        e.stopPropagation();
        _onMathDblClick?.(wrapper);
      }
      lastMd = now;
    });
    wrapper.style.cursor = "pointer";
    wrapper.title = "双击编辑公式";

    // 内部容器负责水平溢出滚动，与 CM6 布局隔离。
    // 注意 overflow-y 必须用 hidden（不能用 visible）——CSS 规范规定：
    // 当 overflow-x 非 visible 时，overflow-y:visible 会被强制计算为 auto，
    // 将 inner 变成 scroll container，干扰 CM6 的 ResizeObserver 高度追踪。
    const inner = document.createElement("span");
    inner.className = "lp-math-inner";
    if (this.display) {
      inner.style.cssText = "display:block;overflow-x:auto;overflow-y:hidden";
    }
    wrapper.appendChild(inner);

    // 同步渲染：KaTeX 模块已预加载 → 直接 render，CM6 在 widget 插入时
    // 就能测到正确的 DOM 高度，从根本上消除异步渲染带来的点击位置偏移。
    if (katexModule) {
      const t = performance.now();
      try {
        katexModule.render(this.formula, inner, {
          displayMode: this.display,
          throwOnError: false,
          output: "html",
          trust: false,
          strict: false,
        });
      } catch {
        inner.textContent = this.formula;
        inner.style.color = "var(--text-secondary)";
        inner.style.fontStyle = "italic";
      }
      lpPerf("katex:render", performance.now() - t);
    } else {
      // 冷启动：KaTeX 尚未加载完毕。先用纯文本占位给 CM6 一个合理的高度估计，
      // 加载完成后异步替换为渲染结果。
      inner.textContent = this.formula;
      loadKatex()
        .then((katex) => {
          if (inner.isConnected) {
            try {
              katex.render(this.formula, inner, {
                displayMode: this.display,
                throwOnError: false,
                output: "html",
                trust: false,
                strict: false,
              });
              view.requestMeasure();
            } catch {
              inner.style.color = "var(--text-secondary)";
              inner.style.fontStyle = "italic";
              view.requestMeasure();
            }
          }
        })
        .catch(() => {
          if (inner.isConnected) {
            inner.style.color = "var(--text-secondary)";
            inner.style.fontStyle = "italic";
            view.requestMeasure();
          }
        });
    }

    return wrapper;
  }

  // 不接管鼠标事件：避免 CM6 在 inclusive:false 区间边界外推光标
  ignoreEvent() {
    return true;
  }
}

/** 判断位置是否在代码块/HTML/注释等不应用数学渲染的区域内 */
function isInsideRawRegion(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1);
  const SKIP = new Set([
    "FencedCode", "CodeBlock", "InlineCode",
    "HTMLBlock", "HTMLTag", "Comment", "CommentBlock",
    "LinkReference", "ProcessingInstruction",
  ]);
  while (node) {
    if (SKIP.has(node.name)) return true;
    node = node.parent;
  }
  return false;
}

function findMath(state: EditorState, onlyRanges?: readonly { from: number; to: number }[]): DecorationSet {
  const t0 = performance.now();
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  // 有变化区间时只扫这些区间（±3 行保证捕获跨行块级公式）；全文扫描走原路径
  const ranges = onlyRanges
    ? onlyRanges.map((r) => {
        const fromLine = state.doc.lineAt(Math.min(r.from, state.doc.length));
        const toLine = state.doc.lineAt(Math.min(r.to, state.doc.length));
        return {
          from: state.doc.line(Math.max(1, fromLine.number - 3)).from,
          to: state.doc.line(Math.min(state.doc.lines, toLine.number + 3)).to,
        };
      })
    : [{ from: 0, to: doc.length }];
  // 合并重叠区间
  const merged: { from: number; to: number }[] = [];
  for (const r of ranges) {
    if (r.to <= r.from) continue;
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  const t1 = performance.now();

  // 只在变化区间内扫描（不会有跨区间的 $$ 块公式，因为合并后区间足够大）
  for (const range of merged) {
    const text = doc.sliceString(range.from, range.to);
    if (!text.includes("$")) continue;

    // 块级公式
    const blockRanges: { from: number; to: number }[] = [];
    const blockRe = /(?:^|\n)(\$\$)\n?([\s\S]*?)\n?\1/gm;
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(text)) !== null) {
      const absFrom = range.from + match.index + (match[0].startsWith("\n") ? 1 : 0);
      const absTo = absFrom + match[0].length - (match[0].startsWith("\n") ? 1 : 0);
      const formula = (match[2] || "").trim();
      if (!formula) continue;
      if (isInsideRawRegion(state, absFrom + 2)) continue;
      const rawSource = state.sliceDoc(absFrom, absTo);

      if (absTo !== doc.lineAt(absTo).to) {
        decos.push(
          Decoration.replace({
            widget: new MathWidget(formula, false, absFrom, absTo, rawSource, state),
            inclusive: false,
          }).range(absFrom, absTo),
        );
      } else {
        const br = blockWidgetRange(state, absFrom, absTo);
        decos.push(
          Decoration.replace({
            widget: new MathWidget(formula, true, absFrom, absTo, rawSource, state),
            block: true,
            inclusive: false,
          }).range(br.from, br.to),
        );
      }
      blockRanges.push({ from: absFrom, to: absTo });
    }

    // 行内公式
    const inlineRe = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g;
    while ((match = inlineRe.exec(text)) !== null) {
      const absFrom = range.from + match.index;
      const absTo = absFrom + match[0].length;
      if (blockRanges.some((r) => absFrom >= r.from && absTo <= r.to)) continue;
      if (isInsideRawRegion(state, absFrom + 1)) continue;
      decos.push(
        Decoration.replace({
          widget: new MathWidget(match[1], false, absFrom, absTo, state.sliceDoc(absFrom, absTo), state),
          inclusive: false,
        }).range(absFrom, absTo),
      );
    }
  }

  const set = RangeSet.of(decos, true);
  lpPerf("field:math", performance.now() - t0);
  lpPerf("math:toString", t1 - t0);
  lpPerf("math:regex", performance.now() - t1);
  return set;
}

const mathField = StateField.define<DecorationSet>({
  create(state) {
    // 冷开只扫已解析区间（~3000 字符），不再全文 doc.sliceString + 双正则
    return findMath(state, [{ from: 0, to: syntaxTree(state).topNode.to }]);
  },
  update(value, tr) {
    const prevTree = syntaxTree(tr.startState);
    const tree = syntaxTree(tr.state);
    if (!tr.docChanged && prevTree === tree) return value;

    // 树推进（无编辑）：保留全量重扫——$$ 块公式的 opener 可能落在扫描窗外，
    // 纯增量正则扫描有固有盲区（blockRe 以 range.from 为切片起点）。
    // 后台、正确、O(N)/推进（现状即如此，非本次引入）。
    if (!tr.docChanged) return findMath(tr.state);

    const state = tr.state;
    const ranges: { from: number; to: number }[] = [];
    tr.changes.iterChangedRanges((_fA, _tA, fB, tB) => {
      const fromPos = Math.min(fB, state.doc.length);
      const toPos = Math.min(Math.max(tB, fB), state.doc.length);
      ranges.push({ from: fromPos, to: toPos });
    });
    // 树推进区顺带拾取（同事务的 20ms 解析推进）
    if (tree !== prevTree && tree.topNode.to > prevTree.topNode.to) {
      ranges.push({ from: prevTree.topNode.to, to: tree.topNode.to });
    }
    if (ranges.length === 0) return value;

    // 变化区含 $（公式编辑）：全量重扫保证 $$ 块完整性（罕见路径）
    for (const r of ranges) {
      if (state.doc.sliceString(r.from, r.to).includes("$")) return findMath(state);
    }

    // 常规编辑（无 $）：map 旧集 + 变化区 ±3 行重扫 + RangeSet.update 合并。
    // 修复旧实现 mapped.size === value.size 在退格时恒假 → 每次退格全量 findMath
    //（5.5MB 文档 ~20-40ms/键）。
    const mapped = value.map(tr.changes);
    const newSet = findMath(state, ranges);
    const newItems: Range<Decoration>[] = [];
    newSet.between(0, state.doc.length, (f, t, v) => {
      newItems.push(makeRange(f, t, v));
    });
    let filterFrom = ranges[0].from;
    let filterTo = ranges[ranges.length - 1].to;
    for (const n of newItems) {
      filterFrom = Math.min(filterFrom, n.from);
      filterTo = Math.max(filterTo, n.to);
    }
    return mapped.update({
      add: newItems,
      sort: true,
      filterFrom,
      filterTo,
      // true=保留：
      // 1. 不被任何新公式覆盖——新公式取代旧公式时旧 widget 让位
      //    （公式 replace 区间 from<to，半开重叠；相邻公式共享端点不算冲突）；
      // 2. 不与本次变化区相交——源码被直接编辑的旧 widget 必须丢弃，交给
      //    findMath 重扫重建。否则公式编辑把 $$..$$ 换成纯文本后，残留 widget
      //    仍覆盖新文本：编辑区文本不可见，coordsAtPos 也定位到旧 widget 位置
      //    （工具栏/预览错位的根因）。相邻击键不触碰 widget 区间则不重建，
      //    KaTeX 渲染开销不回归。
      filter: (f, t) =>
        !newItems.some((n) => n.from < t && f < n.to) &&
        !ranges.some((r) => r.from < t && f < r.to),
    });
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// 测试钩子：__snapshotDecorations(view) —— 把全部装饰源（5 个块级 StateField +
// 主 ViewPlugin）收集为规范元组。用于验证「视口化 create + 树推进增量补齐」的
// 最终装饰与「强制全量构建」逐集合相等（见 livePreview-treeprog.test.ts）。
// 仅测试使用（__ 前缀约定，同 __lpPerf / __resetTabSnapshotCache）。
// ---------------------------------------------------------------------------

function describeDecoration(v: Decoration): string {
  const spec = v.spec as Record<string, unknown>;
  if (spec.widget) {
    const w = spec.widget as unknown as Record<string, unknown>;
    const fields = ["formula", "code", "lang", "display", "rawSource"]
      .filter((k) => typeof w[k] !== "undefined")
      .map((k) => `${k}=${JSON.stringify(String(w[k]).slice(0, 80))}`)
      .join(",");
    return `widget:${String(w.constructor?.name ?? "")}${fields ? `{${fields}}` : ""}`;
  }
  const cls = typeof spec.class === "string" ? spec.class : "";
  return cls ? `class:${cls}` : "other";
}

function collectSet(label: string, docLen: number, set: DecorationSet): string {
  const items: string[] = [];
  set.between(0, docLen, (f, t, v) => {
    items.push(`${f}-${t}:${describeDecoration(v)}`);
  });
  return `${label}[${items.length}](${items.join(",")})`;
}

/** 测试专用：收集全部装饰源为规范字符串快照 */
export function __snapshotDecorations(view: EditorView): string {
  const docLen = view.state.doc.length;
  const parts = [
    collectSet("hr", docLen, view.state.field(hrField)),
    collectSet("frontmatter", docLen, view.state.field(frontmatterField)),
    collectSet("table", docLen, view.state.field(tableField)),
    collectSet("mermaid", docLen, view.state.field(mermaidField)),
    collectSet("math", docLen, view.state.field(mathField)),
  ];
  const main = mainDecoViews.get(view);
  if (main) parts.push(collectSet("main", docLen, main.decorations));
  return parts.join("|");
}

