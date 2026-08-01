// 笔记链接补全：输入 `[[` 触发，候选来自工作区全部 .md 笔记，
// 选中后替换为标准 Markdown 链接 [标题](相对路径)，与
// 「复制为 Markdown 链接」的输出格式一致。
import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { relativePath, stripMdExtension } from "./utils";

export interface NoteItem {
  /** 文件名（不含 .md） */
  title: string;
  /** 绝对路径 */
  path: string;
}

/** 从目录树收集全部 .md 笔记（App 传入 rootChildren 时使用） */
export interface NoteTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: NoteTreeNode[];
}

export function collectNotes(nodes: NoteTreeNode[]): NoteItem[] {
  const out: NoteItem[] = [];
  const walk = (list: NoteTreeNode[]) => {
    for (const n of list) {
      if (n.isDir) walk(n.children);
      else if (n.name.toLowerCase().endsWith(".md")) {
        out.push({ title: stripMdExtension(n.name), path: n.path });
      }
    }
  };
  walk(nodes);
  return out;
}

const MAX_OPTIONS = 50;

// 行尾 `[[query`（query 不含方括号），返回 query 起始下标与内容
const WIKI_RE = /\[\[([^\[\]]*)$/;

/**
 * 提取 `[[` 触发上下文。lineBefore 为光标前到行首的文本。
 * 返回 null 表示不触发。
 */
export function extractWikiTrigger(
  lineBefore: string,
): { queryFrom: number; query: string } | null {
  const m = WIKI_RE.exec(lineBefore);
  if (!m) return null;
  return { queryFrom: m.index + 2, query: m[1] };
}

/**
 * 过滤候选：大小写不敏感子串匹配（标题或路径），
 * 标题前缀匹配 > 标题包含 > 路径包含，截断到 MAX_OPTIONS。
 */
export function filterNotes(notes: NoteItem[], query: string): NoteItem[] {
  const q = query.trim().toLowerCase();
  const rank = (n: NoteItem): number => {
    if (!q) return 0;
    const title = n.title.toLowerCase();
    if (title === q) return 0; // 完全相等最优先（避免 "周报" 排到 "周报模板" 之后）
    if (title.startsWith(q)) return 1;
    if (title.includes(q)) return 2;
    if (n.path.toLowerCase().includes(q)) return 3;
    return -1;
  };
  return notes
    .map((n) => ({ n, r: rank(n) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .slice(0, MAX_OPTIONS)
    .map((x) => x.n);
}

/** 生成补全选中后的 Markdown 链接文本。
 *  URL 用尖括号包裹：CommonMark 的 `<...>` 语法允许路径含 () 等特殊字符，
 *  避免 encodeURI 不编码 () 导致 `[x](a(b).md)` 被解析时在第一个 ) 处截断。 */
export function wikiLinkText(note: NoteItem, noteDir: string): string {
  return `[${note.title}](<${encodeURI(relativePath(noteDir, note.path))}>)`;
}

// 这些语法节点内不触发补全（代码、HTML）
const SKIP_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "Comment",
  "CommentBlock",
]);

type SyntaxNodeT = ReturnType<typeof syntaxTree>["topNode"];

function inSkippedNode(state: EditorState, pos: number): boolean {
  let node: SyntaxNodeT | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (SKIP_NODES.has(node.name)) return true;
    node = node.parent;
  }
  return false;
}

/** 解析 notes 参数：支持直接传入数组或 ref（用于避免闭包过期）。 */
function resolveNotes(notes: NoteItem[] | { current: NoteItem[] }): NoteItem[] {
  return Array.isArray(notes) ? notes : notes.current;
}

/**
 * CodeMirror 补全源。noteDir 为当前笔记所在目录（相对路径基准）。
 * notes 可传 NoteItem[] 或 React ref { current: NoteItem[] }，
 * ref 模式避免补全扩展随 notes 轮询变化而触发 reconfigure。
 */
export function noteCompletionSource(
  notes: NoteItem[] | { current: NoteItem[] },
  noteDir: string,
): CompletionSource {
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const trigger = extractWikiTrigger(
      context.state.doc.sliceString(line.from, context.pos),
    );
    if (!trigger) return null;
    if (inSkippedNode(context.state, context.pos)) return null;
    const items = filterNotes(resolveNotes(notes), trigger.query);
    if (items.length === 0) return null;
    const options: Completion[] = items.map((note) => {
      const rel = encodeURI(relativePath(noteDir, note.path));
      const i = rel.lastIndexOf("/");
      return {
        label: note.title,
        detail: i > 0 ? rel.slice(0, i) : undefined,
        type: "text",
        apply: (view, _completion, from, to) => {
          // from 指向 query 起点，连同前面的 `[[` 一起替换
          const hasBrackets =
            from >= 2 && view.state.doc.sliceString(from - 2, from) === "[[";
          const start = hasBrackets ? from - 2 : from;
          // URL 用尖括号包裹，兼容含 () 等特殊字符的文件名（见 wikiLinkText）
          const text = `[${note.title}](<${rel}>)`;
          view.dispatch({
            changes: { from: start, to, insert: text },
            selection: { anchor: start + text.length },
            userEvent: "input.complete",
          });
        },
      };
    });
    return {
      from: line.from + trigger.queryFrom,
      options,
      // query 继续输入非方括号字符时由 CM 本地过滤，不重跑源
      validFor: /^[^\[\]]*$/,
    };
  };
}
