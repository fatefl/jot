// 编辑器键盘交互
// - Enter 在列表/引用中自动续行（markdownKeymap）
// - Backspace 智能删除标记（markdownKeymap）
// - Cmd+B/I/E/K 加粗/斜体/行内代码/链接（选区包裹，再按解除）
// - 链接点击打开/悬浮卡片见 Editor.tsx 与 lib/linkActions.ts
import { Prec } from "@codemirror/state";
import { markdownKeymap } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorView, keymap } from "@codemirror/view";

/** 语法树节点最小结构类型——避免直接依赖 @lezer/common（项目未列为直接依赖） */
type SynNode = {
  name: string;
  from: number;
  to: number;
  parent: SynNode | null;
  getChildren(name: string): SynNode[];
};

/** 用标记包裹选区；已包裹则解除。只处理主选区。 */
export function toggleMark(view: EditorView, mark: string): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);
  const before = state.sliceDoc(Math.max(0, from - mark.length), from);
  const after = state.sliceDoc(to, to + mark.length);

  if (before === mark && after === mark) {
    // 选区被标记包裹：解除（**text| 光标在末尾也覆盖）
    view.dispatch({
      changes: [
        { from: to, to: to + mark.length, insert: "" },
        { from: from - mark.length, to: from, insert: "" },
      ],
      selection: { anchor: from - mark.length, head: to - mark.length },
    });
  } else if (
    selected.length > mark.length * 2 &&
    selected.startsWith(mark) &&
    selected.endsWith(mark)
  ) {
    // 选区本身含标记（连标记一起选中了）：剥掉
    view.dispatch({
      changes: { from, to, insert: selected.slice(mark.length, -mark.length) },
      selection: { anchor: from, head: to - mark.length * 2 },
    });
  } else if (from === to) {
    // 空选区：若光标已在对应语法节点内（如在 **bold** 中间按 Cmd+B），
    // 解除该节点标记；否则插入空标记对，光标停中间等用户输入。
    // 此前不查语法树，会在加粗文字中间插入孤立的 **** 破坏渲染。
    const NODE_FOR_MARK: Record<string, string> = {
      "**": "StrongEmphasis",
      "*": "Emphasis",
      "~~": "Strikethrough",
      "`": "InlineCode",
    };
    const nodeName = NODE_FOR_MARK[mark];
    let node = nodeName ? syntaxTree(state).resolveInner(from, -1) : null;
    while (node && node.name !== nodeName) node = node.parent;
    if (node && node.name === nodeName) {
      view.dispatch({
        changes: [
          { from: node.to - mark.length, to: node.to, insert: "" },
          { from: node.from, to: node.from + mark.length, insert: "" },
        ],
        selection: { anchor: from - mark.length },
      });
    } else {
      view.dispatch({
        changes: { from, to, insert: mark + mark },
        selection: { anchor: from + mark.length },
      });
    }
  } else {
    view.dispatch({
      changes: { from, to, insert: mark + selected + mark },
      selection: { anchor: from + mark.length, head: to + mark.length },
    });
  }
  view.focus();
  return true;
}

export function toggleLink(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);

  // 先查语法树：光标/选区在 Link 节点内 → 清除链接保留文字。
  // 此前不查语法树，在已有链接文字内按 Cmd+K 会插出 [文[]()本] 破坏链接。
  let linkNode = syntaxTree(state).resolveInner(from, -1) as SynNode | null;
  while (linkNode && linkNode.name !== "Link") linkNode = linkNode.parent;
  if (linkNode && linkNode.name === "Link") {
    const linkMarks = linkNode.getChildren("LinkMark");
    if (linkMarks.length >= 2) {
      const text = state.sliceDoc(linkMarks[0].to, linkMarks[1].from);
      view.dispatch({
        changes: { from: linkNode.from, to: linkNode.to, insert: text },
        selection: { anchor: linkNode.from, head: linkNode.from + text.length },
      });
      view.focus();
      return true;
    }
  }

  if (/^https?:\/\/\S+$/.test(selected)) {
    // 选中的是 URL：变成 [url](url)，标签留待用户改
    view.dispatch({
      changes: { from, to, insert: `[${selected}](${selected})` },
      selection: { anchor: from + 1, head: from + 1 + selected.length },
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: `[${selected}]()` },
      selection: { anchor: from + selected.length + 3 }, // 光标进括号填 URL
    });
  }
  view.focus();
  return true;
}

// ---------- 块级格式切换 ----------

/** 切换选中行标题级别：已设为同一级别则取消，否则替换为指定级别。 */
export function toggleHeading(view: EditorView, level: number): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const doc = state.doc;
  const fromLine = doc.lineAt(from);
  const toLine = doc.lineAt(to);
  const prefix = "#".repeat(level) + " ";

  let allSame = true;
  for (let i = fromLine.number; i <= toLine.number; i++) {
    if (!doc.line(i).text.startsWith(prefix)) {
      allSame = false;
      break;
    }
  }

  // Setext 标题（标题\n=== 或 标题\n---）：直接加 ATX 前缀会留下无意义的
  // 下划线行（--- 还会变成分割线），转换时把下划线行一起删掉。
  // 依赖语法树判定，解析器不可用（预算耗尽）时退化为不处理。
  const underlineLines = new Set<number>();
  if (!allSame) {
    const tree = ensureSyntaxTree(state, doc.length, 50) ?? syntaxTree(state);
    for (let i = fromLine.number; i <= toLine.number; i++) {
      const line = doc.line(i);
      if (!line.length) continue;
      let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(
        line.from + Math.min(1, line.length),
        0,
      );
      while (node) {
        if (node.name.startsWith("SetextHeading")) {
          underlineLines.add(doc.lineAt(Math.min(node.to, doc.length)).number);
          break;
        }
        node = node.parent;
      }
    }
  }

  const changes: { from: number; to: number; insert: string }[] = [];
  for (let i = fromLine.number; i <= toLine.number; i++) {
    const line = doc.line(i);
    if (allSame) {
      changes.push({
        from: line.from,
        to: line.from + prefix.length,
        insert: "",
      });
    } else {
      if (underlineLines.has(i)) continue; // 下划线行：随上一行整体删除
      const m = text_match_prefix(line.text);
      if (m) {
        changes.push({
          from: line.from,
          to: line.from + m.length,
          insert: prefix,
        });
      } else {
        changes.push({ from: line.from, to: line.from, insert: prefix });
      }
      // 本行是 Setext 内容行：删除紧随的下划线行（含换行）
      if (i + 1 <= doc.lines && underlineLines.has(i + 1)) {
        const u = doc.line(i + 1);
        if (u.to < doc.length) {
          changes.push({ from: u.from, to: u.to + 1, insert: "" });
        } else {
          // 下划线是文档末行且无尾换行：连同前面的换行一起删
          changes.push({ from: line.to, to: u.to, insert: "" });
        }
      }
    }
  }

  view.dispatch({ changes });
  view.focus();
  return true;
}

function text_match_prefix(text: string): string | null {
  const m = /^#{1,6} /.exec(text);
  return m ? m[0] : null;
}

/** 切换选中行块引用：已全部引用则取消，否则添加 `> ` 前缀。 */
export function toggleBlockquote(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const doc = state.doc;
  const fromLine = doc.lineAt(from);
  const toLine = doc.lineAt(to);

  // 用 /^>\s?/ 判定与剥离：兼容 `>text`（无空格）、`>>nested`（嵌套）等情况，
  // 此前硬编码 "> " 会对这些行误判为"未引用"再加一层 `> ` 前缀导致双重引用
  let allQuoted = true;
  for (let i = fromLine.number; i <= toLine.number; i++) {
    if (!/^>\s?/.test(doc.line(i).text)) {
      allQuoted = false;
      break;
    }
  }

  const changes: { from: number; to: number; insert: string }[] = [];
  for (let i = fromLine.number; i <= toLine.number; i++) {
    const line = doc.line(i);
    if (allQuoted) {
      const m = /^>\s?/.exec(line.text);
      const prefixLen = m ? m[0].length : 0;
      changes.push({ from: line.from, to: line.from + prefixLen, insert: "" });
    } else {
      changes.push({ from: line.from, to: line.from, insert: "> " });
    }
  }

  view.dispatch({ changes });
  view.focus();
  return true;
}

/** 切换选中行无序列表：已全部为 `- ` 则取消，否则替换为 `- `。 */
export function toggleBulletList(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const doc = state.doc;
  const fromLine = doc.lineAt(from);
  const toLine = doc.lineAt(to);

  let allMatch = true;
  for (let i = fromLine.number; i <= toLine.number; i++) {
    if (!/^(\s*)[-*] /.test(doc.line(i).text)) {
      allMatch = false;
      break;
    }
  }

  const changes: { from: number; to: number; insert: string }[] = [];
  for (let i = fromLine.number; i <= toLine.number; i++) {
    const line = doc.line(i);
    const m = line.text.match(/^(\s*)(?:[-*] |\d+\. )/);
    if (allMatch && m) {
      changes.push({
        from: line.from,
        to: line.from + m[0].length,
        insert: m[1],
      });
    } else if (m) {
      changes.push({
        from: line.from,
        to: line.from + m[0].length,
        insert: m[1] + "- ",
      });
    } else {
      changes.push({ from: line.from, to: line.from, insert: "- " });
    }
  }

  view.dispatch({ changes });
  view.focus();
  return true;
}

/** 切换选中行有序列表：已全部为 `1. ` 则取消，否则替换为 `1. `。 */
export function toggleOrderedList(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const doc = state.doc;
  const fromLine = doc.lineAt(from);
  const toLine = doc.lineAt(to);

  let allMatch = true;
  for (let i = fromLine.number; i <= toLine.number; i++) {
    if (!/^\d+\. /.test(doc.line(i).text)) {
      allMatch = false;
      break;
    }
  }

  const changes: { from: number; to: number; insert: string }[] = [];
  for (let i = fromLine.number; i <= toLine.number; i++) {
    const line = doc.line(i);
    const m = line.text.match(/^(\s*)(?:[-*] |\d+\. )/);
    if (allMatch && m) {
      changes.push({
        from: line.from,
        to: line.from + m[0].length,
        insert: m[1],
      });
    } else if (m) {
      changes.push({
        from: line.from,
        to: line.from + m[0].length,
        insert: m[1] + "1. ",
      });
    } else {
      changes.push({ from: line.from, to: line.from, insert: "1. " });
    }
  }

  view.dispatch({ changes });
  view.focus();
  return true;
}

/** 切换选中行任务列表：已全部为 `- [ ] ` 则取消，否则替换为 `- [ ] `。 */
export function toggleTaskList(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const doc = state.doc;
  const fromLine = doc.lineAt(from);
  const toLine = doc.lineAt(to);

  let allMatch = true;
  for (let i = fromLine.number; i <= toLine.number; i++) {
    if (!/^- \[[ x]\] /i.test(doc.line(i).text)) {
      allMatch = false;
      break;
    }
  }

  const changes: { from: number; to: number; insert: string }[] = [];
  for (let i = fromLine.number; i <= toLine.number; i++) {
    const line = doc.line(i);
    const m = line.text.match(/^(\s*)(?:- \[[ x]\] |[-*] |\d+\. )/i);
    if (allMatch && m) {
      changes.push({
        from: line.from,
        to: line.from + m[0].length,
        insert: m[1],
      });
    } else if (m) {
      changes.push({
        from: line.from,
        to: line.from + m[0].length,
        insert: m[1] + "- [ ] ",
      });
    } else {
      changes.push({ from: line.from, to: line.from, insert: "- [ ] " });
    }
  }

  view.dispatch({ changes });
  view.focus();
  return true;
}

/** 选中文本包装为围栏代码块；无选区则插入空代码块并将光标置入。 */
export function toggleCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;

  if (from === to) {
    view.dispatch({
      changes: { from, to: from, insert: "```\n\n```" },
      selection: { anchor: from + 4 },
    });
  } else {
    const selected = state.sliceDoc(from, to);
    if (selected.startsWith("```") && selected.endsWith("```")) {
      const inner = selected.slice(3, -3).trim();
      view.dispatch({
        changes: { from, to, insert: inner },
        selection: { anchor: from, head: from + inner.length },
      });
    } else {
      view.dispatch({
        changes: { from, to, insert: "```\n" + selected + "\n```" },
        // 选区落在代码内容上（不含围栏）：anchor/head 都跳过开围栏 ```\n（4 字符）
        selection: { anchor: from + 4, head: from + 4 + selected.length },
      });
    }
  }

  view.focus();
  return true;
}

// ---------- 表格操作 ----------

import {
  addRow,
  deleteRow,
  addColumn,
  deleteColumn,
  cycleAlign,
  setAlign,
  deleteTable as delTable,
} from "./tableOperations";
import { tableWidgetMap } from "./livePreview";

/** TableWidget 类型别名（tableWidgetMap 值类型）。 */
type TableWidgetRef = NonNullable<ReturnType<typeof tableWidgetMap.get>>;

/** findTableAt 返回值，WYSIWYG 模式 (inclusive:false) 下可能附带 widget 引用，
 *  用于回退到 widget 的 activeRow / activeCol 进行行列定位。 */
export interface TableAtInfo {
  from: number;
  to: number;
  raw: string;
  /** WYSIWYG 模式下通过 DOM 查找到的 widget 实例（光标在 inclusive:false 区间外）。 */
  widget?: TableWidgetRef;
}

/** 查找光标所在表格节点，返回边界及源码。
 *  两条路径：
 *  1. 语法树路径（源码模式）：resolveInner 定位 Table 节点
 *  2. DOM 回退（WYSIWYG 模式）：inclusive:false block widget 挡住光标，
 *     cursorPos 可能在区间外 → 通过 DOM 中的 .lp-table-wrapper 反向查找。
 *
 *  同时处理前导空行（与 findTables 的 hasLeadingBlank 保持一致）。 */
export function findTableAt(
  view: EditorView,
  pos: number,
): TableAtInfo | null {
  // ── 路径 1：语法树（源码模式 + 光标在表格区间附近） ──
  const tree = syntaxTree(view.state);
  // 先尝试 bias=-1（光标在节点内部/末尾），再试 bias=1（光标在表格紧接着的下一行起点）
  let node = tree.resolveInner(pos, -1) as SynNode | null;
  while (node && node.name !== "Table") node = node.parent;
  if (!node || node.name !== "Table") {
    node = tree.resolveInner(pos, 1) as SynNode | null;
    while (node && node.name !== "Table") node = node.parent;
  }
  if (node?.name === "Table") {
    const doc = view.state.doc;
    const startLine = doc.lineAt(node.from);
    // Bug 2 修复：包含前导空行（与 findTables 的 hasLeadingBlank 一致）
    const hasLeadingBlank = startLine.number > 1 && doc.line(startLine.number - 1).length === 0;
    const from = hasLeadingBlank ? doc.line(startLine.number - 1).from : startLine.from;
    let endPos = Math.min(node.to, doc.length);
    if (endPos > node.from && doc.sliceString(endPos - 1, endPos) === "\n") {
      endPos--;
    }
    const endLine = doc.lineAt(endPos);
    return {
      from,
      to: endLine.to,
      raw: doc.sliceString(from, endLine.to),
    };
  }

  // ── 路径 2：DOM 回退（WYSIWYG 模式 inclusive:false block widget） ──
  // 光标被挡在表格区间外，语法树 resolveInner 可能找不到 Table 节点。
  // 遍历编辑器中所有已渲染的表格 widget，通过位置范围匹配。
  const wrappers = view.dom.querySelectorAll(".lp-table-wrapper");
  for (const wrapper of wrappers) {
    if (!(wrapper instanceof HTMLElement)) continue;
    const tw = tableWidgetMap.get(wrapper);
    if (!tw) continue;
    // inclusive:false 下光标在区间边界上（pos ∈ [tw.from, tw.to] 或紧邻）
    if (pos >= tw.from && pos <= tw.to) {
      return {
        from: tw.from,
        to: tw.to,
        raw: view.state.sliceDoc(tw.from, tw.to),
        widget: tw,
      };
    }
  }

  return null;
}

/** 根据语法树找到包含给定位置的 Table 节点，返回原始源码区间 */
export function findTableRange(
  view: EditorView,
  pos: number,
): { from: number; to: number } | null {
  const info = findTableAt(view, pos);
  if (!info) return null;
  return { from: info.from, to: info.to };
}

/** 光标在表格内时，返回该表格选区范围（供导航等使用） */
export function tableRangeAtCursor(view: EditorView): { from: number; to: number } | null {
  const { state } = view;
  return findTableRange(view, state.selection.main.head);
}

/**
 * 表格通用操作包装：找到光标所在表格 → 用 fn 变换源码 → dispatch 修改。
 * 返回是否成功执行。
 */
function tableOp(
  view: EditorView,
  fn: (raw: string) => string | null,
): boolean {
  const t = findTableAt(view, view.state.selection.main.head);
  if (!t) return false;
  const next = fn(t.raw);
  if (next === null) return false;
  if (next === t.raw) return true;
  // 校验源码区间未被改动（与 TableWidget commit 逻辑一致）
  if (view.state.sliceDoc(t.from, t.to) !== t.raw) return false;
  view.dispatch({ changes: { from: t.from, to: t.to, insert: next } });
  view.focus();
  return true;
}

/**
 * 确定操作行的索引。源码模式下根据光标所在行计算；
 * WYSIWYG 模式下（widget 存在）回退到 widget 的 activeRow。
 */
function rowIdxForOp(view: EditorView, t: TableAtInfo): number {
  if (t.widget) return t.widget.activeRow;
  // 源码模式：根据光标所在行确定 rowIdx
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const lines = t.raw.split("\n");
  let rowIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineStart = t.from + lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
    if (line.from >= lineStart) rowIdx = i;
  }
  return rowIdx;
}

/**
 * 确定操作列的索引。源码模式下根据光标前的管道符数计算；
 * WYSIWYG 模式下（widget 存在）回退到 widget 的 activeCol。
 */
function colIdxForOp(view: EditorView, t: TableAtInfo): number {
  if (t.widget) return t.widget.activeCol;
  return columnAtPos(view, t);
}

/** 在当前行上方插入空行 */
export function insertRowAbove(view: EditorView): boolean {
  const t = findTableAt(view, view.state.selection.main.head);
  if (!t) return false;
  const rowIdx = rowIdxForOp(view, t);
  return tableOp(view, (raw) => addRow(raw, rowIdx, "above"));
}

/** 在当前行下方插入空行 */
export function insertRowBelow(view: EditorView): boolean {
  const t = findTableAt(view, view.state.selection.main.head);
  if (!t) return false;
  const rowIdx = rowIdxForOp(view, t);
  return tableOp(view, (raw) => addRow(raw, rowIdx, "below"));
}

/** 删除光标所在行 */
export function delRow(view: EditorView): boolean {
  const t = findTableAt(view, view.state.selection.main.head);
  if (!t) return false;
  const rowIdx = rowIdxForOp(view, t);
  return tableOp(view, (raw) => deleteRow(raw, rowIdx));
}

/** 在当前列左侧插入空列 */
export function insertColumnLeft(view: EditorView): boolean {
  const t = findTableAt(view, view.state.selection.main.head);
  if (!t) return false;
  const col = colIdxForOp(view, t);
  return tableOp(view, (raw) => addColumn(raw, col, "left"));
}

/** 在当前列右侧插入空列 */
export function insertColumnRight(view: EditorView): boolean {
  const t = findTableAt(view, view.state.selection.main.head);
  if (!t) return false;
  const col = colIdxForOp(view, t);
  return tableOp(view, (raw) => addColumn(raw, col, "right"));
}

/** 删除当前列 */
export function delColumn(view: EditorView): boolean {
  const t = findTableAt(view, view.state.selection.main.head);
  if (!t) return false;
  const col = colIdxForOp(view, t);
  return tableOp(view, (raw) => deleteColumn(raw, col));
}

/** 循环切换当前列对齐 */
export function cycleColumnAlign(view: EditorView): boolean {
  const t = findTableAt(view, view.state.selection.main.head);
  if (!t) return false;
  const col = colIdxForOp(view, t);
  return tableOp(view, (raw) => cycleAlign(raw, col));
}

/** 删除整张表格 */
export function deleteWholeTable(view: EditorView): boolean {
  return tableOp(view, () => "");
}

/** 设置当前列对齐（供右键菜单等使用，与 cycleColumnAlign 的循环切换不同） */
export function setColumnAlign(view: EditorView, align: "left" | "center" | "right"): boolean {
  const t = findTableAt(view, view.state.selection.main.head);
  if (!t) return false;
  const col = colIdxForOp(view, t);
  return tableOp(view, (raw) => setAlign(raw, col, align));
}

/** 光标在表格内时，估算所在列索引（数光标前的管道符，减首 | 偏移）。
 *  表格行结构（比如有合并行不存在的行）的影响在源码层面可忽略——
 *  我们只在管道分隔符之间计算列索引 */
function columnAtPos(
  view: EditorView,
  t: TableAtInfo,
): number {
  const pos = view.state.selection.main.head;
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  const lineText = line.text;
  // 通过管道符位置确定列：每遇到一个 |，光标就进入了下一列。
  // 但首个 | 是行首装饰符，不计为列分隔——col 是光标前的管道符数，
  // col-1 才是 0-based 列索引（光标在首 | 之前时 col=0，clamp 到 0）。
  const relPos = pos - line.from;
  let col = 0;
  let pipeIdx = -1;
  while (true) {
    const next = lineText.indexOf("|", pipeIdx + 1);
    if (next === -1 || next >= relPos) break;
    col++;
    pipeIdx = next;
  }
  const cellIdx = col > 0 ? col - 1 : 0;
  // 确保不超过表头列数
  const hdrCells = lineText.split("|").filter((c, i, a) => i > 0 && i < a.length - 1 || (i === 0 && lineText.startsWith("|")));
  return Math.min(cellIdx, hdrCells.length > 0 ? hdrCells.length - 1 : 0);
}

// Prec.high：要盖过 basicSetup 里 defaultKeymap 的 Enter/Backspace，
// 让 markdown 续行/删标记先生效
export const editorKeymap = Prec.high(
  keymap.of([
    ...markdownKeymap,
    { key: "Mod-b", run: (v) => toggleMark(v, "**") },
    { key: "Mod-i", run: (v) => toggleMark(v, "*") },
    { key: "Mod-e", run: (v) => toggleMark(v, "`") },
    { key: "Mod-k", run: toggleLink },
    // 表格操作
    { key: "Mod-Shift-ArrowDown", run: insertRowBelow },
    { key: "Mod-Shift-ArrowUp", run: insertRowAbove },
    { key: "Mod-Shift-ArrowRight", run: insertColumnRight },
    { key: "Mod-Shift-ArrowLeft", run: insertColumnLeft },
  ]),
);

/** 光标处链接节点的目标 URL：直接取语法树的 URL 子节点，
 * 不手写正则——正则 `[^)\s]+` 会截断含括号的 URL（如维基百科链接） */
export function linkUrlAt(view: EditorView, pos: number): string | null {
  let url: string | null = null;
  syntaxTree(view.state).iterate({
    from: pos,
    to: pos,
    enter(node) {
      if (
        (node.name === "Link" || node.name === "Autolink") &&
        node.from <= pos &&
        node.to >= pos
      ) {
        const urlNode = node.node.getChild("URL");
        url = urlNode
          ? view.state.sliceDoc(urlNode.from, urlNode.to)
          : null;
        return false;
      }
    },
  });
  return url;
}
