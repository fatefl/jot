import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/stores/editorStore";
import { useToast } from "@/components/ui/toast";
import { LinkCard } from "@/components/LinkCard";
import { linkInfoAt, openLinkTarget, setLinkToastHandler, type LinkInfo } from "@/lib/linkActions";
import CodeMirror, {
  EditorView,
  keymap,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { history, historyKeymap, redo, undo } from "@codemirror/commands";
import { openSearchPanel, search } from "@codemirror/search";
import { createChineseSearchPanel } from "@/lib/searchPanel";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { StateField, StateEffect, EditorState, type Range } from "@codemirror/state";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import { livePreview, mermaidThemeEffect, parseMermaidFence, mermaidFenceWrap, setHtmlBadgeClickHandler, setLivePreviewAssetBase } from "@/lib/livePreview";
import { bindEditorView, unbindEditorView, setActiveEditFinalizer } from "@/lib/editorViewCache";
import {
  editorKeymap,
  toggleMark,
  toggleLink,
  toggleHeading,
  toggleBlockquote,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
  toggleCodeBlock,
  insertRowAbove,
  insertRowBelow,
  delRow,
  insertColumnLeft,
  insertColumnRight,
  delColumn,
  cycleColumnAlign,
  setColumnAlign,
  deleteWholeTable,
  findTableRange,
} from "@/lib/editorKeymap";
import { noteCompletionSource, type NoteItem } from "@/lib/noteCompletion";
import { focusTypewriter } from "@/lib/focusTypewriter";
import { relativePath } from "@/lib/utils";
import { isRichHtml, htmlToMarkdown } from "@/lib/htmlToMarkdown";

// ── 公式编辑状态追踪 StateField ──
// 在文档中将 $formula$ 替换为纯文本 formula 供用户直接编辑，
// 进入编辑模式前记录原 widget 渲染高度，供预览区撑开 min-height 防止内容骤缩跳动
let _preservedWidgetHeight = 0;

// 本字段追踪编辑范围和包裹符号，用于提交/取消时恢复。

interface FormulaEditState {
  from: number;
  to: number;
  wrap: string;        // "$" 或 "$$" 或 "```mermaid\n"
  close: string;       // "$" 或 "$$" 或 "\n```"
  originalSource: string;
}

const setFormulaEdit = StateEffect.define<FormulaEditState>();
const clearFormulaEdit = StateEffect.define();

/**
 * 收尾公式/图表编辑会话：把剥离了定界符的裸文本重新包裹回定界符。
 * 在保存 / 快照 / 视图换挡前由 finalizeActiveEdit 调用，防止裸代码被写盘。
 * 编辑期间撤销回原始源码时按取消处理（避免双重定界，同 commit 的约定）。
 * 返回 true 表示本次会话被收尾（dispatch 已执行）。
 */
function finalizeFormulaEditSession(view: EditorView): boolean {
  const st = view.state.field(formulaEditField, false);
  if (!st) return false;
  const text = view.state.sliceDoc(st.from, st.to);
  if (text === st.originalSource) {
    view.dispatch({
      effects: clearFormulaEdit.of(null),
      changes: { from: st.from, to: st.to, insert: st.originalSource },
      selection: { anchor: st.from + st.originalSource.length },
    });
  } else {
    view.dispatch({
      effects: clearFormulaEdit.of(null),
      changes: {
        from: st.from,
        to: st.to,
        insert: `${st.wrap}${text}${st.close}`,
      },
      selection: { anchor: st.from + st.wrap.length + text.length },
    });
  }
  return true;
}

const formulaEditField = StateField.define<FormulaEditState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFormulaEdit)) return e.value;
      if (e.is(clearFormulaEdit)) return null;
    }
    if (value && tr.docChanged) {
      return {
        ...value,
        from: tr.changes.mapPos(value.from, -1),
        to: tr.changes.mapPos(value.to, 1),
      };
    }
    return value;
  },
});

// ── 公式编辑时的 LaTeX 语法高亮装饰 ──
// 当 formulaEditField 活跃时，对编辑区文本做正则匹配着色。

const latexHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decos, tr) {
    const edit = tr.state.field(formulaEditField, false);
    if (!edit) return Decoration.none;
    // 仅在文档变化或编辑状态变化时重建
    if (!tr.docChanged && tr.startState.field(formulaEditField, false) === edit) {
      return decos;
    }
    const isMermaid = edit.wrap.startsWith("```");
    return isMermaid
      ? buildMermaidHighlights(tr.state, edit.from, edit.to)
      : buildLatexHighlights(tr.state, edit.from, edit.to, edit.wrap === "$$");
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── 公式编辑时的内联预览 Widget ──

class FormulaPreviewWidget extends WidgetType {
  constructor(
    readonly formula: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: FormulaPreviewWidget) {
    return other.formula === this.formula && other.display === this.display;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "lp-math-edit-preview";
    // 块级公式用原 widget 高度撑开 min-height，防止 widget 销毁后内容骤缩跳动
    const preserveH = this.display ? _preservedWidgetHeight : 0;
    if (preserveH > 0) _preservedWidgetHeight = 0;
    wrap.style.cssText = this.display
      ? `display:block;padding:0.4em 0;text-align:center${preserveH > 0 ? `;min-height:${preserveH}px` : ""}`
      // 间距用 padding 不用 margin：CM6 测量 widget 只计 border-box，
      // margin 不计入会导致点击偏移（见 CLAUDE.md block widget 规范）
      : "display:inline-block;padding-left:6px;vertical-align:middle";

    if (!this.formula) return wrap;

    // 块级公式：溢出滚动通过内部 span 隔离，避免 wrapper 成为 scroll
    // container 干扰 CM6 的 ResizeObserver 高度追踪（overflow-x:auto 会
    // 强制 overflow-y 变为 auto，与 livePreview 中 MathWidget 同理）。
    const renderTarget = this.display
      ? (() => { const s = document.createElement("span"); s.style.cssText = "display:inline-block;max-width:100%;overflow-x:auto;overflow-y:hidden"; wrap.appendChild(s); return s; })()
      : wrap;

    import("katex").then(({ default: katex }) => {
      if (!wrap.isConnected) return;
      try {
        katex.render(this.formula, renderTarget, {
          displayMode: this.display,
          throwOnError: false,
          output: "html",
          trust: false,
          strict: false,
        });
        view.requestMeasure();
      } catch { /* 公式为空或非法，留空 */ }
    });

    return wrap;
  }

  ignoreEvent() { return true; }
}

// ── Mermaid 编辑时的实时预览 Widget ──
// 在编辑区末尾实时渲染 Mermaid SVG，类似公式编辑的 KaTeX 预览。

let mermaidPreviewSeq = 0;

class MermaidPreviewWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }

  eq(other: MermaidPreviewWidget) {
    return other.code === this.code;
  }

  toDOM(view: EditorView) {
    const container = document.createElement("div");
    container.className = "lp-mermaid-edit-preview";
    // 上下间距用 padding 不用 margin：CM6 测量 block widget 只计
    // border-box，margin 不计入会导致点击偏移（见 CLAUDE.md 规范铁律 1）。
    // 因此根元素只做透明间距盒，卡片视觉样式放到内层 card 上。
    container.style.cssText = "display:block;padding:8px 0;";
    const card = document.createElement("div");
    // 不直接在卡片上设 overflow-x:auto —— CSS 规范强制 overflow-y
    // 变为 auto → scroll container → 干扰 CM6 ResizeObserver 高度追踪。
    // 溢出滚动通过内部元素隔离。
    // 用原 widget 高度撑开 min-height，防止 widget 销毁后内容骤缩跳动
    const preserveH = _preservedWidgetHeight;
    if (preserveH > 0) _preservedWidgetHeight = 0;
    card.style.cssText =
      "padding:12px 16px;border-radius:8px;" +
      `background:var(--sidebar-bg);min-height:${preserveH > 0 ? preserveH : 40}px;`;
    container.appendChild(card);

    if (!this.code.trim()) {
      card.textContent = "输入图表代码…";
      card.style.color = "var(--text-secondary)";
      card.style.fontSize = "12px";
      return container;
    }

    const inner = document.createElement("div");
    card.appendChild(inner);
    inner.style.cssText =
      "width:100%;overflow-x:auto;overflow-y:hidden;" +
      "display:flex;align-items:center;justify-content:center;min-height:40px";

    const seq = ++mermaidPreviewSeq;
    inner.textContent = "渲染中…";
    inner.style.color = "var(--text-secondary)";
    inner.style.fontSize = "12px";

    const dark = document.documentElement.classList.contains("dark");

    import("mermaid").then(({ default: m }) => {
      if (seq !== mermaidPreviewSeq || !container.isConnected) return;
      try {
        m.initialize({
          startOnLoad: false,
          theme: dark ? "dark" : "default",
          securityLevel: "strict",
          flowchart: { htmlLabels: false },
        });
        const id = "mermaid-prev-" + Math.random().toString(36).slice(2, 8);
        m.render(id, this.code).then(({ svg }) => {
          if (seq !== mermaidPreviewSeq || !container.isConnected) return;
          inner.innerHTML = svg;
          inner.style.color = "";
          inner.style.fontSize = "";
          const svgEl = inner.querySelector("svg");
          if (svgEl) {
            svgEl.style.maxWidth = "100%";
            svgEl.style.height = "auto";
          }
          view.requestMeasure();
        }).catch(() => {
          if (seq !== mermaidPreviewSeq || !container.isConnected) return;
          inner.textContent = "图表语法错误";
          inner.style.color = "var(--text-secondary)";
          inner.style.fontSize = "11px";
          view.requestMeasure();
        });
      } catch {
        if (seq !== mermaidPreviewSeq || !container.isConnected) return;
        inner.textContent = "图表语法错误";
        inner.style.color = "var(--text-secondary)";
        inner.style.fontSize = "11px";
        view.requestMeasure();
      }
    });

    return container;
  }

  ignoreEvent() { return true; }
}

function buildMermaidHighlights(
  state: EditorState,
  from: number,
  to: number,
): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const text = state.sliceDoc(from, to);
  const add = (s: number, e: number, cls: string) => {
    if (s < e) deco.push(Decoration.mark({ class: cls }).range(from + s, from + e));
  };

  // ── 编辑区背景：给整个编辑区域加底色卡片，与预览 widget 视觉统一 ──
  const doc = state.doc;
  const firstLn = doc.lineAt(from).number;
  const lastLn = doc.lineAt(to).number;
  for (let ln = firstLn; ln <= lastLn; ln++) {
    const classes = ["lp-edit-line"];
    if (ln === firstLn) classes.push("lp-edit-line-first");
    if (ln === lastLn) classes.push("lp-edit-line-last");
    deco.push(Decoration.line({ class: classes.join(" ") }).range(doc.line(ln).from));
  }

  // Mermaid 关键字
  const KEYWORDS = /\b(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|subgraph|end|classDef|class|click|style|linkStyle|direction|participant|actor|note|activate|deactivate|loop|alt|else|opt|par|and|rect|section|title|dateFormat|axisFormat|excludes|includes|theme|init)\b/g;
  // 方向
  const DIRS = /\b(TD|TB|BT|LR|RL|DU|UD)\b/g;
  // 注释
  const COMMENTS = /%%.*$/gm;

  let match: RegExpExecArray | null;

  // 注释
  const commentRe = /%%.*$/gm;
  while ((match = commentRe.exec(text)) !== null) {
    add(match.index, match.index + match[0].length, "lp-latex-cmt");
  }

  // 关键字
  while ((match = KEYWORDS.exec(text)) !== null) {
    add(match.index, match.index + match[0].length, "lp-latex-kw");
  }

  // 方向
  while ((match = DIRS.exec(text)) !== null) {
    add(match.index, match.index + match[0].length, "lp-latex-kw");
  }

  // 箭头
  const arrowRe = /-+>|==>|-\.[\->]+|==+|-{2,}/g;
  while ((match = arrowRe.exec(text)) !== null) {
    add(match.index, match.index + match[0].length, "lp-latex-op");
  }

  // 字符串
  const strRe = /"([^"]*)"/g;
  while ((match = strRe.exec(text)) !== null) {
    add(match.index, match.index + match[0].length, "lp-latex-num");
  }

  // 在编辑区末尾插入 Mermaid 实时预览 widget（与公式编辑的 KaTeX 预览一致）
  const code = text.trim();
  deco.push(
    Decoration.widget({
      widget: new MermaidPreviewWidget(code),
      side: 1,
    }).range(to),
  );

  return Decoration.set(deco, true);
}

function buildLatexHighlights(
  state: EditorState,
  from: number,
  to: number,
  display: boolean,
): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const text = state.sliceDoc(from, to);
  const add = (s: number, e: number, cls: string) => {
    if (s < e) deco.push(Decoration.mark({ class: cls }).range(from + s, from + e));
  };

  // ── 编辑区背景：给整个编辑区域加底色卡片 ──
  const doc = state.doc;
  const firstLn = doc.lineAt(from).number;
  const lastLn = doc.lineAt(to).number;
  for (let ln = firstLn; ln <= lastLn; ln++) {
    const classes = ["lp-edit-line"];
    if (ln === firstLn) classes.push("lp-edit-line-first");
    if (ln === lastLn) classes.push("lp-edit-line-last");
    deco.push(Decoration.line({ class: classes.join(" ") }).range(doc.line(ln).from));
  }

  // 逐字符扫描 LaTeX 标记
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // 注释 % → 行尾
    if (ch === "%") {
      const end = text.indexOf("\n", i);
      add(i, end === -1 ? text.length : end, "lp-latex-cmt");
      i = end === -1 ? text.length : end;
      continue;
    }
    // 命令 \ 后跟字母
    if (ch === "\\") {
      let j = i + 1;
      if (j < text.length && /[a-zA-Z]/.test(text[j])) {
        while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
        add(i, j, "lp-latex-kw");
        i = j;
        continue;
      }
      // 单个非字母符号命令（如 \$ \_ \{ 等）
      if (j < text.length && !/\s/.test(text[j])) {
        add(i, j + 1, "lp-latex-kw");
        i = j + 1;
        continue;
      }
    }
    // 花括号
    if (ch === "{" || ch === "}") {
      add(i, i + 1, "lp-latex-br");
      i++;
      continue;
    }
    // 上标/下标
    if (ch === "_" || ch === "^") {
      add(i, i + 1, "lp-latex-op");
      i++;
      continue;
    }
    // 数字
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      add(i, j, "lp-latex-num");
      i = j;
      continue;
    }
    i++;
  }

  // 在公式文本末尾插入 KaTeX 预览 widget
  const formulaText = text.trim();
  deco.push(
    Decoration.widget({
      widget: new FormulaPreviewWidget(formulaText, display),
      side: 1,
    }).range(to),
  );

  return Decoration.set(deco, true);
}

export type EditorMode = "wysiwyg" | "source";

/** 暴露给 App 的编辑器操作句柄（光标处插入内容、格式化命令） */
export interface EditorPanelHandle {
  insertImage: (src: string) => void;
  /** 光标处插入 Markdown 文本（不重建编辑器，保留光标与撤销历史） */
  insertMarkdown: (text: string) => void;
  /** 在视口坐标 (x, y) 处插入图片引用（外部拖入用）；坐标无法映射时插到文档末尾 */
  insertImagesAtPoint: (x: number, y: number, srcs: string[]) => void;
  /** 选区加粗/斜体/删除线/行内代码（再调一次解除） */
  toggleMark: (mark: "**" | "*" | "~~" | "`") => void;
  /** 选区包装为链接 */
  toggleLink: () => void;
  /** 插入 3×3 Markdown 表格 */
  insertTable: () => void;
  /** 块级格式切换 */
  toggleHeading: (level: 1 | 2 | 3) => void;
  toggleBlockquote: () => void;
  toggleBulletList: () => void;
  toggleOrderedList: () => void;
  toggleTaskList: () => void;
  toggleCodeBlock: () => void;
  /** 表格结构操作 */
  insertRowAbove: () => void;
  insertRowBelow: () => void;
  deleteRow: () => void;
  insertColumnLeft: () => void;
  insertColumnRight: () => void;
  deleteColumn: () => void;
  cycleColumnAlign: () => void;
  /** 设置当前列对齐（非循环切换，直接指定 left/center/right） */
  setColumnAlign: (align: "left" | "center" | "right") => void;
  deleteTable: () => void;
  /** 检查光标是否在表格内（供右键菜单条件显示） */
  isCursorInTable: () => boolean;
  /** 图片操作（供右键菜单调用） */
  deleteImage: (from: number, to: number) => void;
  copyImage: (filePath: string) => void;
  revealImage: (filePath: string) => void;
  /** 缩放图片：scale 为百分比（null = 原始大小） */
  resizeImage: (from: number, to: number, scale: number | null) => void;
  /** 数学公式操作 */
  editMathFormula: (el: HTMLElement) => void;
  saveMathAsPng: (el: HTMLElement) => void;
  deleteMathFormula: (from: number, to: number) => void;
  wrapAsMath: (display: boolean) => void;
  /** 插入空公式（行内 $…$ / 块级 $$…$$），光标落入公式体 */
  insertMath: (display: boolean) => void;
  /** Mermaid 图表操作 */
  editMermaid: (from: number, to: number, el?: HTMLElement) => void;
  /** 插入 Mermaid 代码块模板，光标落入代码体内 */
  insertMermaid: () => void;
  deleteMermaid: (from: number, to: number) => void;
  saveMermaidAsPng: (el: HTMLElement) => void;
  /** 滚动到指定行（1-based），用于搜索结果跳转 */
  scrollToLine: (line: number) => void;
  /** 撤销 / 重做（供全局菜单调用） */
  undo: () => void;
  redo: () => void;
  /** 打开 CodeMirror 搜索面板（供全局菜单调用） */
  focusSearch: () => void;
}

// 点击 scroller 空白区域（水平留白、底部 padding）或 content 内没有
// 文字节点的区域时，posAtCoords 返回 null → 光标移到文档末尾。
const clickEmptySpace = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement;
    // 只在 scroller 范围内处理（排除滚动条等外部元素）
    if (!target.closest(".cm-scroller")) return false;

    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== null) return false;

    // null 位置 = 无文字节点可映射。判断是否在文档末尾空白区：
    // content 外的水平/底部留白、或 content 底部 padding 区。
    const lastLine = view.state.doc.lineAt(view.state.doc.length);
    const endCoords = view.coordsAtPos(lastLine.to);
    const isBelowContent =
      !target.closest(".cm-content") || // scroller 水平/底部留白
      (endCoords && event.clientY >= endCoords.top); // content 底部 padding 区

    if (isBelowContent) {
      event.preventDefault();
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        scrollIntoView: true,
      });
      view.focus();
      return true;
    }
    return false;
  },
});

// 剪贴板图片粘贴：检测剪贴板中的图片数据，保存到 .assets/ 并插入 ![]() 引用
const handleImagePaste = EditorView.domEventHandlers({
  paste(event, view) {
    const items = event.clipboardData?.items;
    if (!items) return false;
    // 收集所有图片项（支持一次粘贴多张）；文本项交给浏览器默认处理
    const images: Blob[] = [];
    let hasImage = false;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        hasImage = true;
        const blob = item.getAsFile();
        if (blob) images.push(blob);
      }
    }
    if (!hasImage) {
      // 粘贴 URL 智能转换：选区非空且剪贴板文本是纯 URL 时，
      // 把选中文字替换为 [文字](url)，光标移到末尾
      const { from, to } = view.state.selection.main;
      const text = event.clipboardData?.getData("text/plain").trim() ?? "";
      if (from !== to && /^https?:\/\/\S+$/.test(text)) {
        const selected = view.state.sliceDoc(from, to);
        // 选中文字含方括号、或选区本身已是链接时，自动包装会生成
        // 嵌套/破损语法，跳过走默认粘贴
        let alreadyLink = false;
        syntaxTree(view.state).iterate({
          from,
          to,
          enter(node) {
            if (node.name === "Link" || node.name === "Autolink") {
              alreadyLink = true;
              return false;
            }
          },
        });
        if (/[[\]]/.test(selected) || alreadyLink) return false;
        event.preventDefault();
        // URL 尾部多余的 ")" 会破坏 markdown 链接定界符，剥离非平衡右括号
        let url = text;
        while (url.endsWith(")")) {
          const open = (url.match(/\(/g) || []).length;
          const close = (url.match(/\)/g) || []).length;
          if (close <= open) break;
          url = url.slice(0, -1);
        }
        const insert = `[${selected}](${url})`;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
        return true;
      }
      // 富文本粘贴：剪贴板同时携带 text/html 且与纯文本同内容（网页复制的富文本）时
      // 转成 markdown 插入；代码片段等 text/plain 与 HTML 文本不一致的场景走默认纯文本
      const plain = event.clipboardData?.getData("text/plain") ?? "";
      const html = event.clipboardData?.getData("text/html") ?? "";
      if (html && isRichHtml(html, plain)) {
        const ctxEl = view.dom.closest("[data-paste-notes-dir]");
        const notesDir = ctxEl?.getAttribute("data-paste-notes-dir") ?? "";
        const filePath = ctxEl?.getAttribute("data-paste-file-path") ?? "";
        if (notesDir && filePath) {
          event.preventDefault();
          htmlToMarkdown(html, { notesDir, currentFilePath: filePath })
            .then((md) => {
              view.dispatch({
                changes: { from, to, insert: md },
                selection: { anchor: from + md.length },
              });
              view.focus();
            })
            .catch((e) => {
              // 转换失败退回纯文本粘贴，避免整个粘贴静默丢失
              console.warn("富文本转 markdown 失败，退回纯文本", e);
              view.dispatch({
                changes: { from, to, insert: plain },
                selection: { anchor: from + plain.length },
              });
              view.focus();
            });
          return true;
        }
      }
      return false;
    }
    event.preventDefault();
    // data-* 在外层 .editor-body，view.dom 是内层 .cm-editor，getAttribute 不沿祖先链，
    // 必须用 closest 找到携带属性的祖先，否则 notesDir/filePath 永远读不到 → 粘贴失效
    const ctxEl = view.dom.closest("[data-paste-notes-dir]");
    const notesDir = ctxEl?.getAttribute("data-paste-notes-dir") ?? "";
    const filePath = ctxEl?.getAttribute("data-paste-file-path") ?? "";
    if (!notesDir || !filePath) return true; // 无上下文，吞掉事件避免默认粘贴出乱码
    // 用 paste 瞬间的选区起点作为插入位，避免异步回调期间光标漂移把图片插到错误位置/文件
    let insertAt = view.state.selection.main.from;
    const ALLOWED_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
    const saveOne = (blob: Blob): Promise<void> =>
      new Promise((resolve) => {
        const rawExt = blob.type.split("/")[1] || "png";
        const ext = ALLOWED_EXT.includes(rawExt) ? rawExt : "png";
        // 防同毫秒碰撞 + 扩展名白名单（image/svg+xml 之类的怪异值落回 png）
        const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
        const reader = new FileReader();
        reader.onload = () => {
          const bytes = new Uint8Array(reader.result as ArrayBuffer);
          import("@tauri-apps/api/core")
            .then(({ invoke }) =>
              invoke<{ path: string }>("save_asset", {
                notesDir,
                fileName: name,
                data: Array.from(bytes),
              }),
            )
            .then((saved) => {
              const rel = relativePath(
                filePath.substring(0, filePath.lastIndexOf("/") + 1),
                saved.path,
              );
              const insert = `![](${rel})`;
              view.dispatch({
                changes: { from: insertAt, to: insertAt, insert },
                selection: { anchor: insertAt + insert.length },
              });
              insertAt += insert.length; // 多张图顺序衔接
              view.focus();
              resolve();
            })
            .catch((e) => {
              console.warn("粘贴图片保存失败", e);
              resolve();
            });
        };
        reader.onerror = () => {
          console.warn("粘贴图片读取失败");
          resolve();
        };
        reader.readAsArrayBuffer(blob);
      });
    // 顺序处理：避免多图并发 dispatch 导致 insertAt 错位
    images.reduce((chain, blob) => chain.then(() => saveOne(blob)), Promise.resolve());
    return true;
  },
});

// 模块级稳定引用的 history 扩展。
// @uiw/react-codemirror 在 extensions 等 props 引用变化时会做全量
// StateEffect.reconfigure：CM 对配置中新出现的 StateField 实例一律
// create() 重建（实测验证），而 basicSetup() 每次调用都会生成新的
// history 字段——意味着每次 reconfigure 撤销栈都会被清空。
// 因此关掉 basicSetup 自带的 history/historyKeymap，换成这个单例：
// reconfigure 时字段实例不变，撤销历史得以保留（跨模式切换也不丢）。
const stableHistory = [history(), keymap.of([...historyKeymap])];

// 全文渲染：EditorView 构造顺序为 ViewState → plugins → DocView。
// ViewState 构造时 pixelViewport={top:0,bottom:0} → getViewport 只
// 覆盖前几行 → DocView 为非 viewport 行生成 BlockGap（占位 div）。
// 本插件在 DocView 创建前撑开 pixelViewport + 重算 viewport，让
// 所有行都进入 viewportLines，BlockGap 不会被创建。同时设 printing=
// true 让后续 measure() 也维持 fullPixelRange。
// 阈值取舍：该 hack 通过篡改 CM 私有字段永久关闭虚拟化，超大文档
// 会全量建 DOM 卡死编辑器。超过 FULL_RENDER_MAX_LINES 行时回退
// 虚拟滚动，接受 docs/scrollbar-jump-issue.md 记录的滚动条跳动问题。
// 阈值 1000：全文渲染的每键成本与文档规模线性（装饰合并/diff/tile 流
// + 全量 DOM/布局/语法高亮），长文档打字会卡到 200ms+/键——虚拟滚动
// 下每键只付视口成本。1000 行内的常规笔记仍享受零跳动全文渲染。
const FULL_RENDER_MAX_LINES = 1000;
const fullRenderViewport = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      if (view.state.doc.lines > FULL_RENDER_MAX_LINES) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vs = (view as any).viewState;
      vs.pixelViewport.bottom = 1e9;
      vs.printing = true;
      vs.viewport = vs.getViewport(0, null);
      vs.updateForViewport();
      vs.updateViewportLines();
    }

    update(_update: ViewUpdate) {
      if (_update.view.state.doc.lines > FULL_RENDER_MAX_LINES) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_update.view as any).viewState.printing = true;
    }
  },
);

// 编辑器表面全部走 index.css 的设计 token（CSS 变量随 .dark 自动切换），
// 不使用 CodeMirror 内置 light/dark 调色板。
const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--editor-bg)",
    color: "var(--text)",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
  },
  // 选区走浏览器原生 ::selection（在 index.css 中启用），
  // CM 自绘层已关闭（index.css 中 display:none）。
  // 原生选区天然只覆盖文字区域，不会延伸到行尾空白。
  ".cm-selectionMatch": {
    backgroundColor: "var(--accent-soft)",
  },
  // 活动行不高亮
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg)",
    color: "var(--text-secondary)",
    border: "none",
  },
  // 补全弹窗走设计 token（随 .dark 切换）
  ".cm-tooltip": {
    backgroundColor: "var(--editor-bg)",
    color: "var(--text)",
    border: "1px solid var(--border)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    borderRadius: "12px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--accent)",
  },
  ".cm-completionDetail": {
    color: "var(--text-secondary)",
    fontStyle: "normal",
  },
});

// 代码块内容语法高亮。色板走 --code-* token，随 .dark 切换（见 index.css）。
// 注意 t.meta 会命中 markdown 的 HeaderMark/EmphasisMark 等标记节点，
// 生成的内层 <span> 颜色靠 .lp-inline-hidden 的 !important 规则压制（见 index.css）。
// 导出供测试复用（renderAssertions.test.ts 的级联回归测试）。
export const codeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier], color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--code-string)" },
  { tag: t.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-number)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: "var(--code-fn)",
  },
  { tag: [t.typeName, t.className, t.tagName], color: "var(--code-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--code-property)" },
  { tag: t.meta, color: "var(--code-comment)" },
]);

// 源码模式的 Markdown 语法高亮。即时渲染模式不用它（装饰器自己负责样式）。
// 对齐 GitHub 主题风格：标题用紫色、链接/代码用蓝色、URL/引用/注释收至次要色，
// 标记符号（# * > 等）不单独着色——继承上下文颜色，避免"满屏灰点"的扁平感。
const sourceHighlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--code-fn)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.monospace], color: "var(--accent)" },
  { tag: t.url, color: "var(--code-comment)" },
  { tag: t.quote, color: "var(--code-comment)" },
  { tag: t.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.contentSeparator], color: "var(--code-comment)" },
]);

interface EditorPanelProps {
  content: string;
  mode: EditorMode;
  /** 当前笔记所在目录：即时渲染模式下解析相对路径图片；同时作为链接补全的相对路径基准 */
  assetBase?: string;
  /** 工作区全部笔记，用于 `[[` 链接补全 */
  notes: NoteItem[];
  /** 工作区根目录，用于剪贴板图片粘贴时保存到 .assets/ */
  notesDir?: string;
  /** 当前文件路径，用于剪贴板图片粘贴时计算相对路径 */
  currentFilePath?: string;
  /** 跨文件跳转的滚动目标行（1-based）。作为 prop 而非 imperative ref：编辑器
   *  按 key 重建（切文件）后仍能消费——imperative ref 会随重建重置而丢失 */
  jumpTarget?: number | null;
  onChange: (markdown: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** 选区变化时回调当前光标所在行号（1-based），用于大纲导航高亮 */
  onCursorLine?: (line: number) => void;
  /** 用户输入 :: 时触发，用于打开表情选择器 */
  onEmojiTrigger?: () => void;
  /** 只读模式：禁止编辑内容 */
  readOnly?: boolean;
}

// 所见即所得 = CodeMirror + 即时渲染装饰（标记始终隐藏，点击不还原源码；
// 改源码请切源码模式）；源码 = 纯 CodeMirror 语法高亮。
export const EditorPanel = forwardRef<EditorPanelHandle, EditorPanelProps>(
  function EditorPanel(
    { content, mode, assetBase, notes, notesDir, currentFilePath, jumpTarget, onChange, onContextMenu, onCursorLine, onEmojiTrigger, readOnly },
    ref,
  ) {
    // ---- 启动性能测量 ----
    const mountTimeRef = useRef(performance.now());
    useEffect(() => {
      const startupMark = (window as any).__startupMark as ((l: string) => void) | undefined;
      startupMark?.(`EditorPanel 挂载完成 (path=${currentFilePath})`);
    }, [currentFilePath]);

    const isPreview = mode === "wysiwyg";
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const editorApiRef = useRef<Partial<EditorPanelHandle>>({});
    const onContextMenuRef = useRef(onContextMenu);
    onContextMenuRef.current = onContextMenu;
    const toast = useToast();

    // 链接悬浮卡片状态：普通点击 .lp-link 时记录链接范围与屏幕坐标
    interface LinkCardState extends LinkInfo {
      x: number;
      y: number;
    }
    const [linkCard, setLinkCard] = useState<LinkCardState | null>(null);

    // 切换文件（currentFilePath 变化 → 视图 setState 换状态）时强制关闭卡片：
    // 卡片里存的是旧文档的绝对偏移，残留时点「编辑/移除」会在
    // 新文件相同偏移处误改内容并被自动保存
    useEffect(() => {
      setLinkCard(null);
    }, [currentFilePath]);

    // 编辑器滚动后卡片停留在原视口位置会脱离目标链接，滚动即关闭
    // （window 捕获阶段才能收到 .cm-scroller 这类内层滚动事件）
    useEffect(() => {
      const close = () => setLinkCard(null);
      window.addEventListener("scroll", close, true);
      return () => window.removeEventListener("scroll", close, true);
    }, []);

    // linkActions 是非 React 模块，toast 只能在组件内取，挂载时注入
    useEffect(() => {
      setLinkToastHandler(toast);
      return () => setLinkToastHandler(null);
    }, [toast]);

    // 进行中的公式/Mermaid 编辑会话的清理函数（由 editMathFormula /
    // editMermaid 注册 dispose）。切文件（currentFilePath 变化 → 视图
    // setState 换成另一个文件的状态）或组件卸载时，原内容对应的 commit/cancel
    // 不再有机会执行，必须强制走清理路径，
    // 否则 setInterval 与 document keydown 监听泄漏，且 formulaEditing
    // 标志不复位导致自动保存永久停摆
    const formulaSessionDisposeRef = useRef<(() => void) | null>(null);
    // 进行中的公式/Mermaid 编辑会话的收尾函数（提交：重新包裹回定界符）。
    // 由 saveCurrent / swapEditorState 经 setActiveEditFinalizer 调用——
    // 在保存、快照、换挡前把裸代码恢复为带定界符的正式文档，防止标记丢失。
    const formulaSessionFinalizeRef = useRef<(() => void) | null>(null);
    useEffect(() => {
      setActiveEditFinalizer(() => formulaSessionFinalizeRef.current?.());
      return () => setActiveEditFinalizer(null);
    }, []);
    useEffect(() => {
      return () => formulaSessionDisposeRef.current?.();
    }, [currentFilePath]);

    // 链接点击：Cmd/Ctrl+点击打开目标；普通点击弹出编辑卡片
    // （不 preventDefault，让光标正常落位）
    const linkMouseHandler = useMemo(
      () =>
        EditorView.domEventHandlers({
          mousedown(event, view) {
            // 只响应左键：右键留给上下文菜单，中键不处理，
            // 否则右键会同时弹卡片+菜单，Cmd+右键还会误打开链接
            if (event.button !== 0) return false;
            const el = (event.target as HTMLElement).closest?.(
              ".lp-link",
            ) as HTMLElement | null;
            if (!el) return false;
            if (event.metaKey || event.ctrlKey) {
              const url = el.getAttribute("data-link-url");
              if (!url) return false; // 引用式链接无 URL，不处理
              // preventDefault 后 CM 会跳过本次 mousedown 的内部处理（不误加多光标）
              event.preventDefault();
              void openLinkTarget(url, {
                angleWrapped: el.getAttribute("data-link-angle") === "1",
              });
              return true;
            }
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            const info = linkInfoAt(view, pos);
            if (!info) {
              // 引用式链接 / 表格单元格内的链接：语法树解析不到，不出卡片
              setLinkCard(null);
              return false;
            }
            const rect = el.getBoundingClientRect();
            setLinkCard({ x: rect.left, y: rect.bottom + 6, ...info });
            return false;
          },
        }),
      [],
    );

    // 双击公式/图表 → 编辑模式
    useEffect(() => {
      import("@/lib/livePreview").then(({ setMathDblClickHandler }) => {
        setMathDblClickHandler((el) => {
          if (el.hasAttribute("data-math-formula")) {
            editorApiRef.current.editMathFormula?.(el as HTMLElement);
          } else if (el.hasAttribute("data-mermaid-code")) {
            const from = parseInt(el.getAttribute("data-mermaid-from") ?? "0", 10);
            const to = parseInt(el.getAttribute("data-mermaid-to") ?? "0", 10);
            editorApiRef.current.editMermaid?.(from, to, el as HTMLElement);
          }
        });
      });
      return () => {
        import("@/lib/livePreview").then(({ setMathDblClickHandler }) => {
          setMathDblClickHandler(null);
        });
      };
    }, [isPreview, currentFilePath]);

    // HTML 占位徽标点击 → 切源码模式定位（所见即所得下 HTML 源码隐藏，
    // 改它必须进源码模式；与公式/图表双击编辑同一注入模式）
    useEffect(() => {
      setHtmlBadgeClickHandler((from, line) => {
        const { mode } = useEditorStore.getState();
        if (mode === "wysiwyg") {
          // 同一次跳转目标先清空再设置：连续点击同一徽标时 jumpTarget
          // 值不变不会触发跳转 effect，必须重置后生效
          useEditorStore.setState({ mode: "source", jumpTarget: null });
          requestAnimationFrame(() => {
            useEditorStore.setState({ jumpTarget: line });
          });
        } else {
          cmRef.current?.view?.dispatch({
            selection: { anchor: from },
            scrollIntoView: true,
          });
        }
      });
      return () => setHtmlBadgeClickHandler(null);
    }, []);

    // Mermaid 右键菜单：在 document 捕获阶段拦截 contextmenu，
    // 先于 CM6 和浏览器默认菜单，检查是否点击在 mermaid 图表上。
    useEffect(() => {
      const onCtx = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        const container = target?.closest?.(".lp-mermaid") as HTMLElement | null;
        if (!container) return;
        // 阻止浏览器默认右键菜单
        e.preventDefault();
        e.stopPropagation();
        // 构造合成事件走正常的 onContextMenu 流程
        onContextMenuRef.current?.({
          preventDefault: () => {},
          stopPropagation: () => {},
          clientX: e.clientX,
          clientY: e.clientY,
          target: container,
        } as unknown as React.MouseEvent);
      };
      document.addEventListener("contextmenu", onCtx, true);
      return () => document.removeEventListener("contextmenu", onCtx, true);
    }, [isPreview, currentFilePath]);

    // 主题切换 → mermaid 图表按新主题重渲染。dark class 变化不经过 CM 事务，
    // mermaidField 不会自动重算（图表会停留在旧主题直到下次编辑），
    // 这里观察 documentElement 的 class 变化并 dispatch effect 强制刷新。
    useEffect(() => {
      const obs = new MutationObserver(() => {
        const view = cmRef.current?.view;
        if (view && view.dom.isConnected) {
          view.dispatch({ effects: mermaidThemeEffect.of(null) });
        }
      });
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      return () => obs.disconnect();
    }, [isPreview, currentFilePath]);

    // 补全源挂在 markdown 语言数据上：basicSetup 自带的 autocompletion
    // 会直接读取，无需重复注册扩展。notes 通过 ref 实时读取，
    // 避免每次 git 轮询触发 extensions reconfigure。
    const notesRef = useRef(notes);
    notesRef.current = notes;

    const completionExt = useMemo(
      () =>
        markdownLanguage.data.of({
          autocomplete: noteCompletionSource(notesRef, assetBase ?? ""),
        }),
      [assetBase],
    );

    // 扩展数组必须 memo：react-codemirror 以引用比较决定是否 reconfigure，
    // 每次渲染新数组会让它每敲一个字就全量 reconfigure 一次
    // （配合 basicSetup 每次新建 history 字段，撤销栈会被反复清空）。
    const extensions = useMemo(
      () => [
        fullRenderViewport,
        // base 必须是 markdownLanguage（GFM + 上下标 + Emoji），
        // 默认的 commonmarkLanguage 没有表格/删除线/任务列表语法，
        // livePreview 的相关装饰会全部失效
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        completionExt,
        editorKeymap,
        linkMouseHandler,
        clickEmptySpace,
        handleImagePaste,
        syntaxHighlighting(codeHighlight),
        stableHistory,
        // 中文搜索面板（Ctrl+F / Enter=下一个 / Shift+Enter=上一个 / Escape=关闭）
        search({ top: false, createPanel: createChineseSearchPanel }),
        // 启用浏览器原生拼写检查（英文拼写纠错，CJK 不受影响）
        EditorView.contentAttributes.of({ spellcheck: "true" }),
        // 选区变化时回调光标行号（用于大纲导航高亮）
        EditorView.updateListener.of((update) => {
          if (update.selectionSet && onCursorLine) {
            const line = update.state.doc.lineAt(
              update.state.selection.main.head,
            );
            onCursorLine(line.number);
          }
          // 文档变化时关掉链接卡片（卡片里记录的源码范围已失效）
          if (update.docChanged) setLinkCard(null);
          // :: 双冒号触发表情选择器
          if (update.docChanged && onEmojiTrigger) {
            const sel = update.state.selection.main;
            const before = update.state.doc.sliceString(
              Math.max(0, sel.head - 2),
              sel.head,
            );
            if (before === "::") {
              // 删除刚输入的 ::
              update.view.dispatch({
                changes: { from: sel.head - 2, to: sel.head },
              });
              onEmojiTrigger();
            }
          }
        }),
        ...(isPreview
          // assetBase 经 setLivePreviewAssetBase 全局注入而非参数传入：
          // extensions 引用必须跨文件稳定，否则 tab 切换触发整链 reconfigure
          ? [livePreview()]
          : [syntaxHighlighting(sourceHighlight)]),
        formulaEditField,
        latexHighlightField,
        focusTypewriter,
        EditorView.lineWrapping,
      ],
      [isPreview, completionExt, onCursorLine, onEmojiTrigger, linkMouseHandler],
    );

    // 活动文件的图片解析基准目录：挂载与切换文件时同步到 livePreview 全局单元
    useEffect(() => {
      setLivePreviewAssetBase(assetBase);
    }, [assetBase]);

    // 单视图绑定：tab 切换由 tabStore 经 swapEditorState 对当前视图 setState
    // （EditorState 缓存命中时零重建），不再通过 React key 销毁重建。
    // createState 经 ref 读取最新 extensions，模式切换后新建状态不会用到旧链。
    const extensionsRef = useRef(extensions);
    extensionsRef.current = extensions;
    const handleCreateEditor = useMemo(
      () => (view: EditorView) => {
        bindEditorView(view, currentFilePath ?? null, (doc: string) =>
          EditorState.create({ doc, extensions: extensionsRef.current }),
        );
      },
      // 仅在挂载时绑定一次；path 变化由 swapEditorState 内部维护
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );
    useEffect(() => {
      return () => unbindEditorView(cmRef.current?.view);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(
      ref,
      () => {
        const api: EditorPanelHandle = {
        insertMarkdown(text: string) {
          const view = cmRef.current?.view;
          if (!view) return;
          const { from, to } = view.state.selection.main;
          view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + text.length },
          });
          view.focus();
        },
        insertImage(src: string) {
          this.insertMarkdown(`![](${src})`);
        },
        insertImagesAtPoint(x: number, y: number, srcs: string[]) {
          const view = cmRef.current?.view;
          if (!view || srcs.length === 0) return;
          // posAtCoords 对空白区域返回 null → 落到文档末尾
          let insertAt = view.posAtCoords({ x, y }) ?? view.state.doc.length;
          // 顺序插入，insertAt 累加衔接（与粘贴多图同一策略）
          for (const src of srcs) {
            const insert = `![](${src})`;
            view.dispatch({
              changes: { from: insertAt, to: insertAt, insert },
              selection: { anchor: insertAt + insert.length },
            });
            insertAt += insert.length;
          }
          view.focus();
        },
        toggleMark(mark) {
          const view = cmRef.current?.view;
          if (view) toggleMark(view, mark);
        },
        toggleLink() {
          const view = cmRef.current?.view;
          if (view) toggleLink(view);
        },
        insertTable() {
          const view = cmRef.current?.view;
          if (!view) return;
          const { from } = view.state.selection.main;
          const t = "\n| 列 1 | 列 2 | 列 3 |\n|------|------|------|\n|      |      |      |\n";
          view.dispatch({
            changes: { from, to: from, insert: t },
            // 光标放表格后：所见即所得下表格立即被 block widget 替换，
            // 光标落在替换区间内会被 CM 钳出去，"选中列 1"并不生效
            selection: { anchor: from + t.length },
          });
          view.focus();
        },
        toggleHeading(level) {
          const view = cmRef.current?.view;
          if (view) toggleHeading(view, level);
        },
        toggleBlockquote() {
          const view = cmRef.current?.view;
          if (view) toggleBlockquote(view);
        },
        toggleBulletList() {
          const view = cmRef.current?.view;
          if (view) toggleBulletList(view);
        },
        toggleOrderedList() {
          const view = cmRef.current?.view;
          if (view) toggleOrderedList(view);
        },
        toggleTaskList() {
          const view = cmRef.current?.view;
          if (view) toggleTaskList(view);
        },
        toggleCodeBlock() {
          const view = cmRef.current?.view;
          if (view) toggleCodeBlock(view);
        },
        insertRowAbove() {
          const view = cmRef.current?.view;
          if (view) insertRowAbove(view);
        },
        insertRowBelow() {
          const view = cmRef.current?.view;
          if (view) insertRowBelow(view);
        },
        deleteRow() {
          const view = cmRef.current?.view;
          if (view) delRow(view);
        },
        insertColumnLeft() {
          const view = cmRef.current?.view;
          if (view) insertColumnLeft(view);
        },
        insertColumnRight() {
          const view = cmRef.current?.view;
          if (view) insertColumnRight(view);
        },
        deleteColumn() {
          const view = cmRef.current?.view;
          if (view) delColumn(view);
        },
        cycleColumnAlign() {
          const view = cmRef.current?.view;
          if (view) cycleColumnAlign(view);
        },
        setColumnAlign(align) {
          const view = cmRef.current?.view;
          if (view) setColumnAlign(view, align);
        },
        deleteTable() {
          const view = cmRef.current?.view;
          if (view) deleteWholeTable(view);
        },
        isCursorInTable() {
          const view = cmRef.current?.view;
          if (!view) return false;
          return findTableRange(view, view.state.selection.main.head) !== null;
        },
        deleteImage(from: number, to: number) {
          const view = cmRef.current?.view;
          if (!view || from >= to) return;
          view.dispatch({ changes: { from, to, insert: "" } });
        },
        copyImage(filePath: string) {
          if (!filePath) return;
          fetch(convertFileSrc(filePath))
            .then((r) => r.blob())
            .then((blob) => navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]))
            .catch(() => navigator.clipboard.writeText(filePath).catch(() => {}));
        },
        revealImage(filePath: string) {
          if (!filePath) return;
          invoke("reveal_in_folder", { path: filePath }).catch(() => {});
        },
        resizeImage(from: number, to: number, scale: number | null) {
          const view = cmRef.current?.view;
          if (!view || from >= to) return;
          const text = view.state.sliceDoc(from, to);
          // 解析图片语法：![alt](url ...)
          const m = text.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
          if (!m) return;
          const [, alt, inner] = m;
          // 剥离现有的 =N% 后缀
          let clean = inner.replace(/\s*=\s*\d+%/, "").trim();
          if (scale !== null) {
            // 在可选 title 之前插入 =N%
            const titleMatch = clean.match(/(".*")?\s*$/);
            const beforeTitle = clean.slice(0, clean.length - (titleMatch?.[0]?.length ?? 0));
            clean = (beforeTitle.trimEnd() + `=${scale}%` + (titleMatch?.[1] ? ` ${titleMatch[1]}` : "")).trim();
          }
          const newText = `![${alt}](${clean})`;
          view.dispatch({ changes: { from, to, insert: newText } });
        },
        deleteMathFormula(from: number, to: number) {
          const view = cmRef.current?.view;
          if (!view || from >= to) return;
          view.dispatch({ changes: { from, to, insert: "" } });
        },
        wrapAsMath(display: boolean) {
          const view = cmRef.current?.view;
          if (!view) return;
          const { from, to } = view.state.selection.main;
          if (from === to) return;
          const text = view.state.sliceDoc(from, to);
          const wrap = display ? "$$" : "$";
          view.dispatch({
            changes: { from, to, insert: `${wrap}${text}${wrap}` },
            selection: { anchor: from + wrap.length + text.length },
          });
        },
        insertMath(display: boolean) {
          const view = cmRef.current?.view;
          if (!view) return;
          const { from } = view.state.selection.main;
          const t = display ? "\n$$\n\n$$\n" : "$$";
          // 光标放公式体中间：行内落在两个 $ 之间，块级落在空行上
          const cursor = display ? from + 4 : from + 1;
          view.dispatch({
            changes: { from, to: from, insert: t },
            selection: { anchor: cursor },
          });
          view.focus();
        },
        insertMermaid() {
          const view = cmRef.current?.view;
          if (!view) return;
          const { from } = view.state.selection.main;
          const head = "\n```mermaid\ngraph TD\n    ";
          const t = head + "A --> B\n```\n";
          view.dispatch({
            changes: { from, to: from, insert: t },
            selection: { anchor: from + head.length },
          });
          view.focus();
        },
        editMermaid(from: number, to: number, el?: HTMLElement) {
          const view = cmRef.current?.view;
          if (!view || from >= to) return;
          const raw = view.state.sliceDoc(from, to);
          // 围栏规则与 findMermaid 一致：``` 或 ~~~，任意 ≥3 长度
          const code = parseMermaidFence(raw);
          if (code == null) return;
          const FENCE = "```mermaid\n";
          const CLOSE = "\n```";

          // 记录原 widget 高度：dispatch 后 widget DOM 销毁，内容高度骤降会导致
          // 视口跳动。将高度传给预览 widget 撑开 min-height 保持页面稳定。
          if (el) _preservedWidgetHeight = el.getBoundingClientRect().height;

          // 剥掉围栏变成纯文本，用 StateField 追踪编辑位置。
          view.dispatch({
            effects: setFormulaEdit.of({
              from,
              to: from + code.length,
              wrap: FENCE,
              close: CLOSE,
              originalSource: raw,
            }),
            changes: { from, to, insert: code },
            selection: { anchor: from },
            scrollIntoView: true,
          });

          // 标记公式编辑中：阻止自动保存将裸代码（无 ``` 定界符）写入磁盘
          useEditorStore.getState().setFormulaEditing(true);

          // ── 工具栏（复用公式编辑的 UI）──
          const toolbar = document.createElement("div");
          toolbar.className = "lp-math-toolbar";
          toolbar.innerHTML =
            '<button class="lp-math-tb-done">✓ 完成</button>' +
            '<button class="lp-math-tb-cancel">✗ 取消</button>';
          view.dom.appendChild(toolbar);

          const dispose = () => {
            useEditorStore.getState().setFormulaEditing(false);
            document.removeEventListener("keydown", onEsc, true);
            view.dom.removeEventListener("blur", onBlur, true);
            toolbar.remove();
            clearInterval(interval);
            if (formulaSessionDisposeRef.current === dispose) {
              formulaSessionDisposeRef.current = null;
            }
            if (formulaSessionFinalizeRef.current === finalize) {
              formulaSessionFinalizeRef.current = null;
            }
          };
          // 注册到组件级 ref：切文件/卸载时强制清理（见 formulaSessionDisposeRef）
          formulaSessionDisposeRef.current = dispose;
          // 收尾会话（提交：恢复定界符）并同步 store，供保存/快照读取最终文档。
          // 由 saveCurrent / swapEditorState 在离开当前文件前调用（见 setActiveEditFinalizer）
          const finalize = () => {
            const v = cmRef.current?.view;
            if (!v) return;
            if (finalizeFormulaEditSession(v)) {
              useEditorStore.getState().setDoc(v.state.doc.toString());
            }
            dispose();
          };
          formulaSessionFinalizeRef.current = finalize;
          const commit = () => {
            const st = view.state.field(formulaEditField, false);
            if (!st) { dispose(); return; }
            const text = view.state.sliceDoc(st.from, st.to);
            // 编辑期间 Ctrl+Z 撤销了初始替换：区间已恢复为带围栏的原始
            // 源码，再包裹会双重定界——按取消处理
            if (text === st.originalSource) { cancel(); return; }
            const { wrap, close } = mermaidFenceWrap(text);
            view.dispatch({
              effects: clearFormulaEdit.of(null),
              changes: { from: st.from, to: st.to, insert: `${wrap}${text}${close}` },
              selection: { anchor: st.from + wrap.length + text.length },
            });
            dispose();
          };
          const cancel = () => {
            const st = view.state.field(formulaEditField, false);
            if (!st) { dispose(); return; }
            view.dispatch({
              effects: clearFormulaEdit.of(null),
              changes: { from: st.from, to: st.to, insert: st.originalSource },
              selection: { anchor: st.from + st.originalSource.length },
            });
            dispose();
          };

          toolbar.querySelector(".lp-math-tb-done")!.addEventListener("mousedown", (e) => {
            e.preventDefault(); e.stopPropagation(); commit();
          });
          toolbar.querySelector(".lp-math-tb-cancel")!.addEventListener("mousedown", (e) => {
            e.preventDefault(); e.stopPropagation(); cancel();
          });

          const updatePos = () => {
            const st = view.state.field(formulaEditField, false);
            if (!st) { toolbar.style.display = "none"; return; }
            const coords = view.coordsAtPos(st.from);
            if (!coords) { toolbar.style.display = "none"; return; }
            toolbar.style.display = "";
            const rect = view.dom.getBoundingClientRect();
            toolbar.style.left = `${coords.left - rect.left}px`;
            toolbar.style.top = `${coords.top - rect.top - 32}px`;
          };
          updatePos();

          const interval = setInterval(() => {
            if (!view.state.field(formulaEditField, false)) {
              dispose();
              return;
            }
            updatePos();
          }, 100);

          const onEsc = (e: KeyboardEvent) => {
            if (e.key === "Escape") { e.preventDefault(); cancel(); }
          };
          document.addEventListener("keydown", onEsc, true);

          // 编辑器失焦时自动取消编辑，防止裸代码留在文档中被自动保存
          const onBlur = () => {
            if (view.state.field(formulaEditField, false)) cancel();
          };
          view.dom.addEventListener("blur", onBlur, true);
        },
        deleteMermaid(from: number, to: number) {
          const view = cmRef.current?.view;
          if (!view || from >= to) return;
          view.dispatch({ changes: { from, to, insert: "" } });
        },
        async saveMermaidAsPng(el: HTMLElement) {
          try {
            // SVG 序列化 → canvas 导出。直接走 SVG 而非 DOM 截图：
            // 避免 iframe/foreignObject 里的文字整片丢失。
            const svgEl = el.querySelector("svg");
            if (!svgEl) return;
            const bbox = svgEl.getBoundingClientRect();
            const width = Math.ceil(svgEl.viewBox?.baseVal?.width || bbox.width);
            const height = Math.ceil(svgEl.viewBox?.baseVal?.height || bbox.height);
            if (!width || !height) return;
            const clone = svgEl.cloneNode(true) as SVGSVGElement;
            clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
            clone.setAttribute("width", String(width));
            clone.setAttribute("height", String(height));
            const svgText = new XMLSerializer().serializeToString(clone);
            const url = URL.createObjectURL(
              new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }),
            );
            try {
              const img = new Image();
              await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error("SVG 加载失败"));
                img.src = url;
              });
              const scale = 2;
              const canvas = document.createElement("canvas");
              canvas.width = width * scale;
              canvas.height = height * scale;
              const ctx = canvas.getContext("2d")!;
              const bg =
                getComputedStyle(document.documentElement)
                  .getPropertyValue("--sidebar-bg")
                  .trim() || "#ffffff";
              ctx.fillStyle = bg;
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
              });
              const { save } = await import("@tauri-apps/plugin-dialog");
              const filePath = await save({ filters: [{ name: "PNG 图片", extensions: ["png"] }], defaultPath: "chart.png" });
              if (!filePath) return;
              const arr = new Uint8Array(await blob.arrayBuffer());
              await invoke("export_file", { destPath: filePath, content: Array.from(arr) });
            } finally {
              URL.revokeObjectURL(url);
            }
          } catch (err) {
            console.error("saveMermaidAsPng error:", err);
          }
        },
        editMathFormula(el: HTMLElement) {
          const view = cmRef.current?.view;
          if (!view) return;
          const formula = el.getAttribute("data-math-formula") ?? "";
          const display = el.getAttribute("data-math-display") === "1";
          const from = parseInt(el.getAttribute("data-math-from") ?? "0", 10);
          const to = parseInt(el.getAttribute("data-math-to") ?? "0", 10);
          if (from >= to) return;

          const wrap = display ? "$$" : "$";
          // 使用 data-math-raw 精确比对（块级公式带 \n，不能简单用 ${wrap}${formula}${wrap}）
          const rawSrc = el.getAttribute("data-math-raw");
          const actualSource = view.state.sliceDoc(from, to);
          if (rawSrc && actualSource !== rawSrc) {
            console.warn("[math-edit] source mismatch, aborting");
            return;
          }

          // 记录原 widget 高度：dispatch 后 widget DOM 销毁，内容高度骤降会导致
          // 视口跳动。将高度传给预览 widget 撑开 min-height 保持页面稳定。
          if (display) _preservedWidgetHeight = el.getBoundingClientRect().height;

          // 将文档中的 $formula$ 替换为纯文本 formula。
          // MathField 不再匹配（无 $ 定界符），用户用原生 CM6 编辑。
          // formulaEditField（StateField）自动追踪编辑范围的位移。
          // 光标放在编辑区开头：渲染 widget 销毁后内容高度骤降会导致视口跳动，
          // 光标在开头 + scrollIntoView 能将编辑区稳定在用户双击前的可视位置。
          view.dispatch({
            effects: setFormulaEdit.of({
              from,
              to: from + formula.length,
              wrap,
              close: wrap,
              originalSource: actualSource,
            }),
            changes: { from, to, insert: formula },
            selection: { anchor: from },
            scrollIntoView: true,
          });

          // 标记公式编辑中：阻止自动保存将裸代码（无 $ 定界符）写入磁盘
          useEditorStore.getState().setFormulaEditing(true);

          // ── 浮动工具栏（仅 Done / Cancel 按钮，预览在文档中内联显示）──
          const toolbar = document.createElement("div");
          toolbar.className = "lp-math-toolbar";
          toolbar.innerHTML =
            '<button class="lp-math-tb-done">✓ 完成</button>' +
            '<button class="lp-math-tb-cancel">✗ 取消</button>';
          view.dom.appendChild(toolbar);

          const dispose = () => {
            useEditorStore.getState().setFormulaEditing(false);
            document.removeEventListener("keydown", onEscape, true);
            view.dom.removeEventListener("blur", onBlur, true);
            toolbar.remove();
            clearInterval(checkInterval);
            if (formulaSessionDisposeRef.current === dispose) {
              formulaSessionDisposeRef.current = null;
            }
            if (formulaSessionFinalizeRef.current === finalize) {
              formulaSessionFinalizeRef.current = null;
            }
          };
          // 注册到组件级 ref：切文件/卸载时强制清理（见 formulaSessionDisposeRef）
          formulaSessionDisposeRef.current = dispose;
          // 收尾会话（提交：恢复定界符）并同步 store，供保存/快照读取最终文档。
          // 由 saveCurrent / swapEditorState 在离开当前文件前调用（见 setActiveEditFinalizer）
          const finalize = () => {
            const v = cmRef.current?.view;
            if (!v) return;
            if (finalizeFormulaEditSession(v)) {
              useEditorStore.getState().setDoc(v.state.doc.toString());
            }
            dispose();
          };
          formulaSessionFinalizeRef.current = finalize;

          const commit = () => {
            const st = view.state.field(formulaEditField, false);
            if (!st) { dispose(); return; }
            const text = view.state.sliceDoc(st.from, st.to);
            // 编辑期间 Ctrl+Z 撤销了初始替换：区间已恢复为带 $ 定界符的
            // 原始源码，再包裹会变成 $$…$$ 双重定界——按取消处理
            if (text === st.originalSource) { cancel(); return; }
            view.dispatch({
              effects: clearFormulaEdit.of(null),
              changes: { from: st.from, to: st.to, insert: `${st.wrap}${text}${st.close}` },
              selection: { anchor: st.from + st.wrap.length + text.length },
            });
            dispose();
          };

          const cancel = () => {
            const st = view.state.field(formulaEditField, false);
            if (!st) { dispose(); return; }
            view.dispatch({
              effects: clearFormulaEdit.of(null),
              changes: { from: st.from, to: st.to, insert: st.originalSource },
              selection: { anchor: st.from + st.originalSource.length },
            });
            dispose();
          };

          const bindButton = (sel: string, fn: () => void) => {
            const btn = toolbar.querySelector(sel) as HTMLButtonElement | null;
            if (!btn) return;
            btn.addEventListener("mousedown", (e: MouseEvent) => {
              e.preventDefault(); e.stopPropagation(); fn();
            });
            btn.addEventListener("click", (e: MouseEvent) => {
              e.preventDefault(); e.stopPropagation(); fn();
            });
          };
          bindButton(".lp-math-tb-done", commit);
          bindButton(".lp-math-tb-cancel", cancel);

          const updatePos = () => {
            const st = view.state.field(formulaEditField, false);
            if (!st) { toolbar.style.display = "none"; return; }
            // 定位在编辑区起始位置上方
            const coords = view.coordsAtPos(st.from);
            if (!coords) { toolbar.style.display = "none"; return; }
            toolbar.style.display = "";
            const rect = view.dom.getBoundingClientRect();
            toolbar.style.left = `${coords.left - rect.left}px`;
            toolbar.style.top = `${coords.top - rect.top - 32}px`;
          };
          updatePos();

          // 定期更新工具栏位置
          const checkInterval = setInterval(() => {
            if (!view.state.field(formulaEditField, false)) {
              dispose();
              return;
            }
            updatePos();
          }, 100);

          // Escape 取消
          const onEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape" && view.state.field(formulaEditField, false)) {
              e.preventDefault();
              cancel();
            }
          };
          document.addEventListener("keydown", onEscape, true);

          // 编辑器失焦时自动取消编辑，防止裸代码留在文档中被自动保存
          const onBlur = () => {
            if (view.state.field(formulaEditField, false)) cancel();
          };
          view.dom.addEventListener("blur", onBlur, true);
        },
        async saveMathAsPng(el: HTMLElement) {
          const formula = el.getAttribute("data-math-formula") ?? "";
          const display = el.getAttribute("data-math-display") === "1";
          if (!formula) return;

          try {
            // 用 KaTeX 渲染到临时 DOM
            const { default: katex } = await import("katex");
            const tmp = document.createElement("div");
            tmp.style.cssText =
              "position:fixed;left:-9999px;top:0;background:#fff;padding:16px 20px;display:inline-block";
            katex.render(formula, tmp, {
              displayMode: display,
              throwOnError: true,
              output: "html",
              trust: false,
              strict: false,
            });
            document.body.appendChild(tmp);

            // snapdom 截图（浏览器引擎栅格化；KaTeX 字体在主文档样式表中，需内联）
            const { snapdom } = await import("@zumer/snapdom");
            const blob = await snapdom.toBlob(tmp, {
              backgroundColor: "#ffffff",
              scale: 2,
              type: "png",
              embedFonts: true,
            });
            document.body.removeChild(tmp);

            // 使用 Tauri 保存对话框
            const { save } = await import("@tauri-apps/plugin-dialog");
            const filePath = await save({
              filters: [{ name: "PNG 图片", extensions: ["png"] }],
              defaultPath: "formula.png",
            });
            if (!filePath) return;

            // 写入文件
            const arr = new Uint8Array(await blob.arrayBuffer());
            await invoke("export_file", { destPath: filePath, content: Array.from(arr) });
          } catch (err) {
            console.error("saveMathAsPng error:", err);
          }
        },
        scrollToLine(line) {
          const view = cmRef.current?.view;
          if (!view) return;
          const doc = view.state.doc;
          const target = doc.line(Math.min(line, doc.lines));
          view.dispatch({
            selection: { anchor: target.from },
            scrollIntoView: true,
          });
        },
        undo() {
          const view = cmRef.current?.view;
          if (view) undo(view);
        },
        redo() {
          const view = cmRef.current?.view;
          if (view) redo(view);
        },
        focusSearch() {
          const view = cmRef.current?.view;
          if (view) openSearchPanel(view);
        },
      };
      editorApiRef.current = api;
      return api;
    },
    [],
  );

    useEffect(() => {
      if (jumpTarget == null) return;
      const raf = requestAnimationFrame(() => {
        const view = cmRef.current?.view;
        if (!view) return;
        const doc = view.state.doc;
        const target = doc.line(Math.min(jumpTarget, doc.lines));
        view.dispatch({
          selection: { anchor: target.from },
          scrollIntoView: true,
        });
      });
      return () => cancelAnimationFrame(raf);
    }, [currentFilePath, jumpTarget]);

    return (
      <div
        className="editor-body flex-1 overflow-hidden bg-editor"
        onContextMenu={onContextMenu}
        data-paste-notes-dir={notesDir ?? ""}
        data-paste-file-path={currentFilePath ?? ""}
      >
        <CodeMirror
          ref={cmRef}
          value={content}
          onChange={readOnly ? () => {} : onChange}
          onCreateEditor={handleCreateEditor}
          placeholder="开始输入 Markdown…"
          className={isPreview ? "lp-mode" : undefined}
          extensions={extensions}
          theme={editorTheme}
          editable={!readOnly}
          height="100%"
          style={{ height: "100%" }}
          // history/historyKeymap 关掉：改由 stableHistory 单例提供，
          // 否则 reconfigure 时 basicSetup 新建的 history 字段会清空撤销栈
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            history: false,
            historyKeymap: false,
          }}
        />
        {linkCard &&
          createPortal(
            <LinkCard
              x={linkCard.x}
              y={linkCard.y}
              url={linkCard.url}
              onClose={() => setLinkCard(null)}
              onOpen={() => {
                void openLinkTarget(linkCard.url, {
                  angleWrapped: linkCard.angleWrapped,
                });
                setLinkCard(null);
              }}
              onCopy={() => {
                navigator.clipboard
                  .writeText(linkCard.url)
                  .then(() => toast("已复制链接"));
                setLinkCard(null);
              }}
              onEdit={(newUrl) => {
                const view = cmRef.current?.view;
                if (view) {
                  if (newUrl === "") {
                    // 清空 URL 等同移除链接：保留文字去掉链接语法
                    view.dispatch({
                      changes: {
                        from: linkCard.linkFrom,
                        to: linkCard.linkTo,
                        insert: linkCard.text,
                      },
                    });
                  } else {
                    view.dispatch({
                      changes: {
                        from: linkCard.urlFrom,
                        to: linkCard.urlTo,
                        insert: newUrl,
                      },
                    });
                  }
                  view.focus();
                }
                setLinkCard(null);
              }}
              onRemove={() => {
                const view = cmRef.current?.view;
                if (view) {
                  view.dispatch({
                    changes: {
                      from: linkCard.linkFrom,
                      to: linkCard.linkTo,
                      insert: linkCard.text,
                    },
                    selection: {
                      anchor: linkCard.linkFrom + linkCard.text.length,
                    },
                  });
                  view.focus();
                }
                setLinkCard(null);
              }}
            />,
            document.body,
          )}
      </div>
    );
  },
);
