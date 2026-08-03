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
