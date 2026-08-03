// src/lib/highlight.ts
// 高亮 =={色名}…== 的共享逻辑：色表、别名表、扫描、写回计划、调色工具条。
// markdown 源码是唯一事实源——颜色编码在 == 语法里，本模块只做解析与写回，
// 装饰渲染在 livePreview（.lp-hl-*），导出在 export.ts（mark.hl-*）。
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

/** 7 个命名色（默认黄 = 无 token） */
export const HL_COLORS = [
  { id: "red", label: "红" },
  { id: "orange", label: "橙" },
  { id: "green", label: "绿" },
  { id: "cyan", label: "青" },
  { id: "blue", label: "蓝" },
  { id: "purple", label: "紫" },
  { id: "pink", label: "粉" },
] as const;

/** token 内文本 → 规范色 id。写入只用中文，读取兼容 Hilo/Style Obmd 英文别名 */
export const HL_ALIASES: Record<string, string> = {
  红: "red", red: "red", r: "red",
  橙: "orange", orange: "orange", o: "orange",
  绿: "green", green: "green", g: "green",
  青: "cyan", cyan: "cyan",
  蓝: "blue", blue: "blue", b: "blue",
  紫: "purple", purple: "purple", p: "purple",
  粉: "pink", pink: "pink",
};

export interface HighlightMatch {
  /** 匹配起点（指向开头第一个 =），相对扫描文本 */
  start: number;
  /** 匹配终点（最后一个 = 之后），相对扫描文本 */
  end: number;
  /** "{红}" 原文；无 token 为 null */
  tokenText: string | null;
  /** 规范色 id；无 token 或未知 token 为 null（渲染默认黄） */
  color: string | null;
}

/** 高亮写回动作：apply.color 为 null 表示默认黄；clear 表示清除高亮 */
export type HighlightAction =
  | { kind: "apply"; color: string | null }
  | { kind: "clear" };

const HL_RE = /==(\{([^}=]*)\})?([\s\S]*?)==/g;

/** 扫描文本中的 =={色}…== 高亮片段（非贪婪闭合，内容可跨行） */
export function scanHighlights(text: string): HighlightMatch[] {
  const out: HighlightMatch[] = [];
  HL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HL_RE.exec(text)) !== null) {
    const token = m[1] ?? null;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      tokenText: token,
      color: token ? (HL_ALIASES[m[2]] ?? null) : null,
    });
  }
  return out;
}

/** 色 id → 写入 token 的中文标签（写入只用中文；未知 id 原样保留）。 */
function hlLabel(id: string): string {
  return HL_COLORS.find((c) => c.id === id)?.label ?? id;
}

/** 按行拆分选区并生成包裹事务计划（text 为完整文档，偏移为绝对位置）。
 *  高亮不跨行：跨行选区逐段包裹。color 为 null 表示默认黄（无 token）。 */
export function planLineWrap(
  text: string,
  selFrom: number,
  selTo: number,
  color: string | null,
): { changes: { from: number; to: number; insert: string }[]; anchor: number; head: number } | null {
  if (selFrom >= selTo) return null;
  const prefix = color ? `=={${hlLabel(color)}}` : "==";
  // 行起点数组（"\n" 之后为下一行起点；行内容终点 = 下一行起点 - 1）
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const findLine = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const fromLine = findLine(selFrom);
  const toLine = findLine(Math.max(selFrom, selTo - 1));
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = fromLine; n <= toLine; n++) {
    const ls = lineStarts[n];
    const le = n + 1 < lineStarts.length ? lineStarts[n + 1] - 1 : text.length;
    const f = Math.max(selFrom, ls);
    const t = Math.min(selTo, le);
    if (f >= t) continue;
    changes.push({ from: f, to: t, insert: prefix + text.slice(f, t) + "==" });
  }
  if (!changes.length) return null;
  // 内容总长不变：anchor 前移一个前缀，head 覆盖全部内容
  return {
    changes,
    anchor: selFrom + prefix.length,
    head: selFrom + prefix.length + (selTo - selFrom),
  };
}

/** 修改/清除选区所在高亮（text 为包含高亮的段落文本，偏移相对段落）。
 *  语义：选区完整落在某个高亮内容内时——
 *  - clear 或 点击当前色 → 剥除 == 与 {色}，保留内容
 *  - 点击其他色 → 替换/插入/删除 token（null = 默认黄 = 删除 token）
 *  否则返回 null（交给 planLineWrap 走包裹路径）。 */
export function planHighlightEdit(
  text: string,
  selFrom: number,
  selTo: number,
  action: HighlightAction,
): { changes: { from: number; to: number; insert: string }[]; anchor: number; head: number } | null {
  for (const m of scanHighlights(text)) {
    const tokenLen = m.tokenText?.length ?? 0;
    const cStart = m.start + 2 + tokenLen;
    const cEnd = m.end - 2;
    if (cStart > selFrom || selTo > cEnd) continue;
    const effective = m.color ?? "yellow"; // 未知 token 视为默认黄
    const target = action.kind === "apply" ? (action.color ?? "yellow") : null;
    const tokenStart = m.start + 2;
    if (action.kind === "clear" || target === effective) {
      // 剥除：== {色} ==，内容保留
      const contentLen = cEnd - cStart;
      return {
        changes: [
          { from: m.start, to: tokenStart + tokenLen, insert: "" },
          { from: m.end - 2, to: m.end, insert: "" },
        ],
        anchor: m.start,
        head: m.start + contentLen,
      };
    }
    // 改色
    if (action.color) {
      const newToken = `{${hlLabel(action.color)}}`;
      if (m.tokenText) {
        return {
          changes: [{ from: tokenStart, to: tokenStart + tokenLen, insert: newToken }],
          anchor: selFrom + (newToken.length - tokenLen),
          head: selTo + (newToken.length - tokenLen),
        };
      }
      return {
        changes: [{ from: tokenStart, to: tokenStart, insert: newToken }],
        anchor: selFrom + newToken.length,
        head: selTo + newToken.length,
      };
    }
    // 改为默认黄：删 token
    return {
      changes: [{ from: tokenStart, to: tokenStart + tokenLen, insert: "" }],
      anchor: selFrom - tokenLen,
      head: selTo - tokenLen,
    };
  }
  return null;
}

/** 语法树节点最小结构类型——避免直接依赖 @lezer/common（项目未列为直接依赖） */
type SynNode = {
  name: string;
  from: number;
  to: number;
  parent: SynNode | null;
};

/** 是否标题节点名（ATXHeading1-6 / SetextHeading1-2） */
function isHeadingName(name: string): boolean {
  return name.startsWith("ATXHeading") || name.startsWith("SetextHeading");
}

/** 应用高亮动作：选区完整在高亮内 → 改色/剥除；否则按行包裹。 */
export function applyHighlight(view: EditorView, action: HighlightAction): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  if (from >= to) return false;
  const doc = state.doc;
  // 定位选区起点所在段落/标题（语法树路径，与 toggleMark 一致）
  let node: SynNode | null = syntaxTree(state).resolveInner(from, -1);
  while (node && node.name !== "Paragraph" && !isHeadingName(node.name)) {
    node = node.parent;
  }
  if (node) {
    const text = doc.sliceString(node.from, node.to);
    const plan = planHighlightEdit(text, from - node.from, to - node.from, action);
    if (plan) {
      view.dispatch({
        changes: plan.changes.map((c) => ({
          from: node.from + c.from,
          to: node.from + c.to,
          insert: c.insert,
        })),
        selection: { anchor: node.from + plan.anchor, head: node.from + plan.head },
      });
      view.focus();
      return true;
    }
  }
  // 包裹路径：整篇文档按行拆分（严格按选区边界切分，不延伸到行尾）
  const plan = planLineWrap(
    doc.toString(),
    from,
    to,
    action.kind === "apply" ? action.color : null,
  );
  if (!plan) return false;
  view.dispatch({ changes: plan.changes, selection: { anchor: plan.anchor, head: plan.head } });
  view.focus();
  return true;
}

/** 关闭调色工具条（点击色块后手动关闭） */
const dismissHighlightTooltip = StateEffect.define<void>();

/** 工具条值类型：create 直接返回工具条 DOM 元素（供测试/插件访问）。
 *  @codemirror/view 6.43 起 Tooltip.create 要求返回 TooltipView（含 dom 字段），
 *  与模块内 create 返回裸元素的约定不同——因此单独声明本类型，
 *  并在 provide 处做一次窄化转换，测试与 showTooltip 两侧都能编译。 */
type HighlightTooltip = {
  pos: number;
  above: boolean;
  create: (view: EditorView) => HTMLElement;
};

/** 调色工具条可见性：非空选区显示，选区变空/滚动后自动关闭 */
export const highlightTooltipField = StateField.define<HighlightTooltip | null>({
  create() {
    return null;
  },
  update(value, tr) {
    if (tr.effects.some((e) => e.is(dismissHighlightTooltip))) return null;
    if (!tr.selection) return value;
    const sel = tr.state.selection.main;
    if (sel.empty) return null;
    return { pos: sel.head, above: true, create: createHighlightBar };
  },
  provide: (f) => showTooltip.from(f as unknown as StateField<Tooltip | null>),
});

/** 高亮调色工具条扩展（选中文字后浮出） */
export function highlightTooltip(): Extension {
  return highlightTooltipField;
}

/** 工具条 DOM：默认黄 + 7 命名色 + 清除 */
function createHighlightBar(view: EditorView): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "hl-toolbar";
  const swatches: { label: string; cls: string; action: HighlightAction }[] = [
    { label: "默认", cls: "yellow", action: { kind: "apply", color: null } },
    ...HL_COLORS.map((c): { label: string; cls: string; action: HighlightAction } => ({
      label: c.label,
      cls: c.id,
      action: { kind: "apply", color: c.id },
    })),
    { label: "清除", cls: "clear", action: { kind: "clear" } },
  ];
  for (const s of swatches) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `hl-swatch hl-swatch-${s.cls}`;
    btn.title = s.label;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault(); // 阻止编辑器失焦导致选区丢失
      applyHighlight(view, s.action);
      view.dispatch({ effects: dismissHighlightTooltip.of() });
    });
    bar.appendChild(btn);
  }
  // dom 自引用：使工具条元素同时满足 TooltipView 契约（tooltips 插件读取 .dom），
  // 应用侧启用 tooltips() 插件时不会因 tooltipView.dom 为空而崩溃
  return Object.assign(bar, { dom: bar });
}
