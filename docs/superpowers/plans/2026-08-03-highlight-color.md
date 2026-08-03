# 正文多色高亮（=={色}…==）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在编辑器所见即所得模式中支持 `==文字==`（默认黄）与 `=={红}文字==` 等 7 命名色高亮：选中文字弹出调色工具条上色/清除，导出 HTML 同步渲染。

**Architecture:** 颜色编码进 markdown（`=={色}…==`），livePreview 的 `buildRanges` 树遍历中新增正则扫描装饰（跳过代码/URL/转义/行内公式保护区间）；写回经纯函数 `planLineWrap`/`planHighlightEdit` 生成事务计划；工具条用 CM6 `showTooltip` facet + StateField；导出用 marked 自定义 inline 扩展。设计文档：`docs/superpowers/specs/2026-08-03-highlight-color-design.md`。

**Tech Stack:** TypeScript、CodeMirror 6（`@codemirror/view` / `@codemirror/state` / `@codemirror/language`）、marked v18、vitest（jsdom）。

## Global Constraints

- **Markdown 源码是唯一事实源**：颜色必须编码为 `==` / `=={色}…==` 语法；装饰器是只读视觉覆盖层，不存在序列化往返
- 色名 id（别名表解析目标）：`red` / `orange` / `green` / `cyan` / `blue` / `purple` / `pink`；默认黄 = 无 token
- **写入只用中文 token**（`=={红}…==`）；读取兼容英文别名（`{red}`、`{r}` 等，对应 Hilo/Style Obmd 插件格式）
- 未知 token（`=={xyz}…==`）→ 默认黄渲染 + token 字面保留；空括号同
- 非贪婪闭合（内层 `==` 先闭合）；`\==` 转义不高亮；代码块/行内代码/链接 URL/行内公式内不高亮
- 跨行选区写回按行拆分逐段包裹；高亮内容允许跨行显示（扫描 `[\s\S]`）
- 类名用英文：编辑器 `.lp-hl` / `.lp-hl-red`，导出 `mark.hl-default` / `mark.hl-red`，色板 `.hl-swatch-red`
- 界面文案中文；路径别名 `@/` → `src/`
- 测试命令 `pnpm test -- --run <pattern>`；类型检查 `pnpm build`；新测试文件首行需 `// @vitest-environment jsdom`
- 导出 HTML/PNG 为亮色单主题（PNG 白底），exportStyles 只加亮色值
- 不新增依赖（@codemirror/* 与 marked 均为现有直接依赖）

---

### Task 1: highlight.ts 核心——色表、别名表、扫描函数

**Files:**
- Create: `src/lib/highlight.ts`
- Test: `src/lib/highlight.test.ts`

**Interfaces:**
- Produces:
  - `export const HL_COLORS: ReadonlyArray<{ id: string; label: string }>` — 7 个命名色（id: red/orange/green/cyan/blue/purple/pink）
  - `export const HL_ALIASES: Record<string, string>` — token 内文本 → 规范色 id（中文 + 英文别名）
  - `export interface HighlightMatch { start: number; end: number; tokenText: string | null; color: string | null }`
  - `export type HighlightAction = { kind: "apply"; color: string | null } | { kind: "clear" }`
  - `export function scanHighlights(text: string): HighlightMatch[]`
- Consumes: 无

- [ ] **Step 1: 写失败测试**

创建 `src/lib/highlight.test.ts`：

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { scanHighlights } from "./highlight";

describe("scanHighlights", () => {
  it("默认色 ==文字==", () => {
    expect(scanHighlights("a ==重点== b")).toEqual([
      { start: 2, end: 9, tokenText: null, color: null },
    ]);
  });

  it("中文命名色 =={红}…==", () => {
    expect(scanHighlights("=={红}重要==")).toEqual([
      { start: 0, end: 11, tokenText: "{红}", color: "red" },
    ]);
  });

  it("英文别名 {red} 与缩写 {r}", () => {
    expect(scanHighlights("=={red}重要==")[0].color).toBe("red");
    expect(scanHighlights("=={r}重要==")[0].color).toBe("red");
    expect(scanHighlights("=={p}重要==")[0].color).toBe("purple");
  });

  it("未知 token 保留字面、按默认色处理", () => {
    expect(scanHighlights("=={xyz}内容==")).toEqual([
      { start: 0, end: 13, tokenText: "{xyz}", color: null },
    ]);
  });

  it("空括号按字面", () => {
    expect(scanHighlights("=={}内容==")[0]).toMatchObject({
      tokenText: "{}",
      color: null,
    });
  });

  it("非贪婪：内层先闭合", () => {
    const ms = scanHighlights("==a ==b== c==");
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ start: 0, end: 7 });
    expect(ms[1]).toMatchObject({ start: 7, end: 13 });
  });

  it("内容允许跨行（段落内）", () => {
    expect(scanHighlights("==第一行\n第二行==")).toHaveLength(1);
  });

  it("无闭合 == 不匹配", () => {
    expect(scanHighlights("==未闭合")).toHaveLength(0);
    expect(scanHighlights("未开启==")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- --run src/lib/highlight.test.ts`
Expected: FAIL — 模块 `./highlight` 不存在（或 `scanHighlights` 未定义）

- [ ] **Step 3: 实现**

创建 `src/lib/highlight.ts`：

```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- --run src/lib/highlight.test.ts`
Expected: PASS（8 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/lib/highlight.ts src/lib/highlight.test.ts
git commit -m "feat(highlight): 色表/别名表/=={色}…== 扫描函数"
```

---

### Task 2: livePreview 装饰集成

**Files:**
- Modify: `src/lib/livePreview.ts`（buildRanges 内）
- Test: `src/lib/highlight.test.ts`（追加装饰用例）

**Interfaces:**
- Consumes: `scanHighlights`、`HighlightMatch`（来自 Task 1）
- Produces: 无新导出——行为变化：`=={色}…==` 在所见即所得模式渲染为 `.lp-hl` / `.lp-hl-{色}` 背景，`==` 与 `{色}` 语法隐藏

- [ ] **Step 1: 写失败测试**

在 `src/lib/highlight.test.ts` 追加：

```ts
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { livePreview } from "./livePreview";

function buildView(doc: string): EditorView {
  const view = new EditorView({
    doc,
    parent: document.body,
    extensions: [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      livePreview({ assetBase: "/tmp/notes" }),
      EditorView.lineWrapping,
    ],
  });
  view.dispatch({}); // 触发一次完整重建（与 livePreview.test.ts 冒烟测试一致）
  return view;
}

describe("livePreview 高亮装饰", () => {
  it("默认色 ==文字==：隐藏 ==，内容上 .lp-hl", () => {
    const view = buildView("a ==重点== b");
    const el = view.dom.querySelector(".lp-hl");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("重点");
    expect(view.dom.textContent).not.toContain("==");
    view.destroy();
  });

  it("命名色 =={红}…==：隐藏 == 与 {红}，内容上 .lp-hl-red", () => {
    const view = buildView("=={红}重要==");
    const el = view.dom.querySelector(".lp-hl-red");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("重要");
    view.destroy();
  });

  it("未知 token 字面保留、按默认黄渲染", () => {
    const view = buildView("=={xyz}内容==");
    const el = view.dom.querySelector(".lp-hl");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("{xyz}内容");
    view.destroy();
  });

  it("标题内高亮", () => {
    const view = buildView("# =={蓝}标题==");
    expect(view.dom.querySelector(".lp-hl-blue")).not.toBeNull();
    view.destroy();
  });

  it("行内代码内 == 不处理", () => {
    const view = buildView("`==x==`");
    expect(view.dom.querySelector(".lp-hl")).toBeNull();
    expect(view.dom.textContent).toContain("==x==");
    view.destroy();
  });

  it("转义 \\== 不处理", () => {
    const view = buildView("\\==x==");
    expect(view.dom.querySelector(".lp-hl")).toBeNull();
    view.destroy();
  });

  it("链接 URL 内 == 不处理", () => {
    const view = buildView("[text](http://a==b==c)");
    expect(view.dom.querySelector(".lp-hl")).toBeNull();
    view.destroy();
  });

  it("行内公式内 == 不处理，且不影响公式后的真实高亮", () => {
    const view = buildView("$x==y$ 后 =={红}重要==");
    const els = view.dom.querySelectorAll(".lp-hl");
    expect(els).toHaveLength(1);
    expect(els[0].className).toContain("lp-hl-red");
    expect(els[0].textContent).toBe("重要");
    view.destroy();
  });

  it("非贪婪嵌套：内层先闭合，各得其所", () => {
    const view = buildView("==a ==b== c==");
    const els = view.dom.querySelectorAll(".lp-hl");
    expect(els).toHaveLength(2);
    expect(els[0].textContent).toBe("a ");
    expect(els[1].textContent).toBe(" c");
    view.destroy();
  });

  it("代码块内 == 不处理", () => {
    const view = buildView("```\n==x==\n```");
    expect(view.dom.querySelector(".lp-hl")).toBeNull();
    view.destroy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- --run src/lib/highlight.test.ts`
Expected: FAIL — `==重点==` 仍以字面显示，`.lp-hl` 不存在

- [ ] **Step 3: 实现**

在 `src/lib/livePreview.ts`：

1. 顶部 import 区加入（`import { scanHighlights } from "./highlight";`，放在现有 import 之后）。
2. 模块级（`HEADING_CLASS` 定义附近）加入保护节点集合与节点结构类型：

```ts
/** 高亮扫描需要避开的行内节点：代码、转义、链接 URL、行内 HTML */
const HL_PROTECTED_INLINE = new Set([
  "InlineCode",
  "Escape",
  "URL",
  "HTMLTag",
  "Comment",
  "ProcessingInstruction",
]);

/** addHighlightDecorations 的最小节点结构类型 */
type HighlightNodeRef = {
  from: number;
  to: number;
  node: {
    iterate(visitor: { enter(n: { name: string; from: number; to: number }): unknown }): void;
  };
};
```

3. 在 `livePreview()` 函数内、`buildRanges` 定义**之前**（`emptyLineSpans` 之后）加入装饰辅助函数：

```ts
// --- 高亮 =={色名}…==：扫描段落/标题文本并装饰 ---
// 保护区间：行内代码、转义、链接 URL、行内 HTML、行内公式 $…$
// （与 findMath 的行内正则一致；公式内容可含 ==，如 $x == y$）。
// 掩码策略：把保护区间替换为等长 'x'（偏移不变，split("") 按 UTF-16
// 码元，与正则偏移一致）再扫描——若只做"逐段跳过"，假匹配会吞掉
// 保护区间后真实高亮的 opener（如 "$x==y$ 后 =={红}重要==" 中
// "==y$ 后 ==" 会被误匹配）。掩码后假匹配根本不会产生。
// == 与 {色} 用零宽 replace 隐藏；未知 token 字面保留按默认黄渲染。
function addHighlightDecorations(
  state: EditorState,
  node: HighlightNodeRef,
  hide: (from: number, to: number) => void,
  mark: (from: number, to: number, cls: string) => void,
): void {
  let text = state.doc.sliceString(node.from, node.to);
  if (!text.includes("==")) return;
  const protectedRanges: Array<[number, number]> = [];
  node.node.iterate({
    enter(n) {
      if (HL_PROTECTED_INLINE.has(n.name)) {
        protectedRanges.push([n.from - node.from, n.to - node.from]);
      }
    },
  });
  const inlineMathRe = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g;
  let mm: RegExpExecArray | null;
  while ((mm = inlineMathRe.exec(text)) !== null) {
    protectedRanges.push([mm.index, mm.index + mm[0].length]);
  }
  if (protectedRanges.length > 0) {
    const masked = text.split("");
    for (const [f, t] of protectedRanges) {
      for (let i = f; i < t; i++) masked[i] = "x";
    }
    text = masked.join("");
  }
  for (const m of scanHighlights(text)) {
    const start = node.from + m.start;
    const end = node.from + m.end;
    if (protectedRanges.some(([f, t]) => f < m.end && t > m.start)) continue;
    hide(start, start + 2);
    hide(end - 2, end);
    if (m.tokenText && m.color) {
      // 已知色：{红} 是语法，隐藏；内容按色渲染
      hide(start + 2, start + 2 + m.tokenText.length);
      mark(start + 2 + m.tokenText.length, end - 2, `lp-hl-${m.color}`);
    } else {
      // 默认色：token（若有，未知 token）字面保留在内容里
      mark(start + 2, end - 2, "lp-hl");
    }
  }
}
```

4. 在 `buildRanges` 的 enter 回调中，把「标题行样式」块替换为：

```ts
// --- 标题：行样式 + 隐藏 # 标记 ---
const hClass = HEADING_CLASS[name];
if (name === "Paragraph" || hClass) {
  // 高亮 =={色}…== 扫描（Paragraph/Heading 均可；不 return false，
  // 子节点如 StrongEmphasis/链接仍需常规装饰）
  addHighlightDecorations(state, node, hide, mark);
  if (hClass) {
    const line = state.doc.lineAt(node.from);
    addLine(line.from, Decoration.line({ class: hClass }));
  }
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
```

（注意：`HeaderMark` 分支原样保留，只是标题分支合入了高亮扫描。`name === "Paragraph"` 分支也直接 `return`——子节点遍历不受影响，因为 `return` 不等于 `return false`。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- --run src/lib/highlight.test.ts`
Expected: PASS（扫描 + 装饰共 18 个用例）

再跑一遍既有冒烟测试确认无回归：

Run: `pnpm test -- --run src/lib/livePreview.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/livePreview.ts src/lib/highlight.test.ts
git commit -m "feat(highlight): livePreview 渲染 =={色}…== 高亮装饰"
```

---

### Task 3: CSS 设计 token 与高亮类

**Files:**
- Modify: `src/index.css`

**Interfaces:**
- Produces: CSS 变量 `--hl-{color}-bg/fg`（亮暗双套）、类 `.editor-body .lp-hl` / `.lp-hl-{色}`、工具条 `.hl-toolbar` / `.hl-swatch` / `.hl-swatch-{色}` / `.hl-swatch-clear`
- Consumes: Task 2 产生的类名（`.lp-hl`、`.lp-hl-red` 等）

- [ ] **Step 1: 实现**

1. 在 `:root` 块末尾（`--glass-border: rgba(0, 0, 0, 0.06);` 之后）加入亮色 token：

```css
  /* 高亮 token（=={色}…==） */
  --hl-yellow-bg: #fdf0b8; --hl-yellow-fg: #6b5a00;
  --hl-red-bg: #fbcaca;    --hl-red-fg: #8c1d1d;
  --hl-orange-bg: #fcdcb8; --hl-orange-fg: #7a3f08;
  --hl-green-bg: #c9ecc9;  --hl-green-fg: #1c5c1c;
  --hl-cyan-bg: #bfe9f2;   --hl-cyan-fg: #0a4d5e;
  --hl-blue-bg: #c9d9fb;   --hl-blue-fg: #1c3d8c;
  --hl-purple-bg: #e0ccf9; --hl-purple-fg: #4f1f8c;
  --hl-pink-bg: #fbcbdf;   --hl-pink-fg: #8c1d56;
```

2. 在 `.dark` 块末尾（`--glass-bg: rgba(17, 22, 30, 0.78);` 之后）加入暗色 token：

```css
  /* 高亮 token（暗色） */
  --hl-yellow-bg: #3f3a10; --hl-yellow-fg: #f2e08a;
  --hl-red-bg: #3f1414;    --hl-red-fg: #f5a3a3;
  --hl-orange-bg: #3c2410; --hl-orange-fg: #f0bc84;
  --hl-green-bg: #14331a;  --hl-green-fg: #9cd9a8;
  --hl-cyan-bg: #0e2b33;   --hl-cyan-fg: #8fd5e8;
  --hl-blue-bg: #141e38;   --hl-blue-fg: #a3bdf0;
  --hl-purple-bg: #231438; --hl-purple-fg: #cfaef2;
  --hl-pink-bg: #381424;   --hl-pink-fg: #f0a8cc;
```

3. 在 `.editor-body .lp-strike` 规则（约 230 行）附近加入高亮渲染类：

```css
/* 高亮 =={色}…==：马克笔背景。亮暗主题随 token 自动切换 */
.editor-body .lp-hl {
  background: var(--hl-yellow-bg);
  color: var(--hl-yellow-fg);
  border-radius: 2px;
  padding: 0 2px;
}
.editor-body .lp-hl-red    { background: var(--hl-red-bg);    color: var(--hl-red-fg); }
.editor-body .lp-hl-orange { background: var(--hl-orange-bg); color: var(--hl-orange-fg); }
.editor-body .lp-hl-green  { background: var(--hl-green-bg);  color: var(--hl-green-fg); }
.editor-body .lp-hl-cyan   { background: var(--hl-cyan-bg);   color: var(--hl-cyan-fg); }
.editor-body .lp-hl-blue   { background: var(--hl-blue-bg);   color: var(--hl-blue-fg); }
.editor-body .lp-hl-purple { background: var(--hl-purple-bg); color: var(--hl-purple-fg); }
.editor-body .lp-hl-pink   { background: var(--hl-pink-bg);   color: var(--hl-pink-fg); }
```

4. 在文件末尾（或其它浮动 UI 样式附近）加入工具条样式：

```css
/* ---- 高亮调色工具条（选中文字后浮动） ---- */
.hl-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}
.hl-toolbar button.hl-swatch {
  position: relative;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--border);
  cursor: pointer;
}
.hl-swatch-yellow { background: var(--hl-yellow-bg); }
.hl-swatch-red    { background: var(--hl-red-bg); }
.hl-swatch-orange { background: var(--hl-orange-bg); }
.hl-swatch-green  { background: var(--hl-green-bg); }
.hl-swatch-cyan   { background: var(--hl-cyan-bg); }
.hl-swatch-blue   { background: var(--hl-blue-bg); }
.hl-swatch-purple { background: var(--hl-purple-bg); }
.hl-swatch-pink   { background: var(--hl-pink-bg); }
.hl-swatch-clear {
  background: transparent;
  border-color: var(--text-secondary);
}
.hl-swatch-clear::after {
  content: "";
  position: absolute;
  left: 2px;
  right: 2px;
  top: 50%;
  height: 2px;
  background: var(--text-secondary);
  transform: rotate(-45deg);
}
```

- [ ] **Step 2: 验证类型与类名一致**

Run: `pnpm test -- --run src/lib/highlight.test.ts`
Expected: PASS（Task 2 的装饰用例断言了这些类名）

Run: `pnpm build`
Expected: 类型检查与构建通过（CSS 无类型问题，构建验证文件完整性）

- [ ] **Step 3: 提交**

```bash
git add src/index.css
git commit -m "feat(highlight): 高亮色板设计 token 与工具条样式（亮暗双主题）"
```

---

### Task 4: 写回逻辑——包裹/改色/清除

**Files:**
- Modify: `src/lib/highlight.ts`（追加 planLineWrap / planHighlightEdit / applyHighlight）
- Test: `src/lib/highlight.test.ts`（追加用例）

**Interfaces:**
- Consumes: `scanHighlights`、`HL_ALIASES`（Task 1）；`syntaxTree`（@codemirror/language）
- Produces:
  - `export function planLineWrap(text: string, selFrom: number, selTo: number, color: string | null): { changes: { from: number; to: number; insert: string }[]; anchor: number; head: number } | null`
  - `export function planHighlightEdit(text: string, selFrom: number, selTo: number, action: HighlightAction): 同上 | null`
  - `export function applyHighlight(view: EditorView, action: HighlightAction): boolean`

- [ ] **Step 1: 写失败测试**

在 `src/lib/highlight.test.ts` 追加：

```ts
import { applyHighlight, planHighlightEdit, planLineWrap } from "./highlight";

describe("planLineWrap（按行包裹）", () => {
  it("单行默认色", () => {
    expect(planLineWrap("abc def", 1, 5, null)).toEqual({
      changes: [{ from: 1, to: 5, insert: "==bc d==" }],
      anchor: 3,
      head: 7,
    });
  });

  it("命名色前缀", () => {
    const p = planLineWrap("abc", 0, 3, "red");
    expect(p!.changes).toEqual([{ from: 0, to: 3, insert: "=={红}abc==" }]);
  });

  it("跨行按段拆分，selection 覆盖全部内容", () => {
    const p = planLineWrap("ab\ncd\nef", 1, 7, null);
    expect(p!.changes).toEqual([
      { from: 1, to: 2, insert: "==b==" },
      { from: 3, to: 5, insert: "==cd==" },
      { from: 6, to: 7, insert: "==e==" },
    ]);
    expect(p!.anchor).toBe(3);
    expect(p!.head).toBe(9); // 3 + (7 - 1)
  });

  it("空选区返回 null", () => {
    expect(planLineWrap("abc", 1, 1, null)).toBeNull();
  });

  it("选区止于行尾换行符前", () => {
    const p = planLineWrap("ab\ncd", 0, 3, null);
    expect(p!.changes).toEqual([{ from: 0, to: 2, insert: "==ab==" }]);
  });
});

describe("planHighlightEdit（修改/清除已有高亮）", () => {
  it("选区在默认高亮内：清除剥掉 ==", () => {
    const p = planHighlightEdit("a ==b== c", 4, 5, { kind: "clear" });
    expect(p!.changes).toEqual([
      { from: 2, to: 4, insert: "" },
      { from: 5, to: 7, insert: "" },
    ]);
    expect(p!.anchor).toBe(2);
    expect(p!.head).toBe(3);
  });

  it("选区在命名高亮内：点同色=剥除（含 token）", () => {
    const p = planHighlightEdit("a =={红}b== c", 7, 8, { kind: "apply", color: "red" });
    expect(p!.changes).toEqual([
      { from: 2, to: 7, insert: "" },
      { from: 8, to: 10, insert: "" },
    ]);
    expect(p!.anchor).toBe(2);
    expect(p!.head).toBe(3);
  });

  it("改色：替换 token", () => {
    const p = planHighlightEdit("a =={红}b== c", 7, 8, { kind: "apply", color: "blue" });
    expect(p!.changes).toEqual([{ from: 4, to: 7, insert: "{蓝}" }]);
    expect(p!.anchor).toBe(7);
    expect(p!.head).toBe(8);
  });

  it("默认高亮改命名色：插入 token", () => {
    const p = planHighlightEdit("a ==b== c", 4, 5, { kind: "apply", color: "red" });
    expect(p!.changes).toEqual([{ from: 4, to: 4, insert: "{红}" }]);
    expect(p!.anchor).toBe(7);
    expect(p!.head).toBe(8);
  });

  it("命名高亮改默认黄：删除 token", () => {
    const p = planHighlightEdit("a =={红}b== c", 7, 8, { kind: "apply", color: null });
    expect(p!.changes).toEqual([{ from: 4, to: 7, insert: "" }]);
    expect(p!.anchor).toBe(4);
    expect(p!.head).toBe(5);
  });

  it("未知 token 高亮：点默认黄=剥除（含未知 token）", () => {
    const p = planHighlightEdit("a =={xyz}b== c", 9, 10, { kind: "apply", color: null });
    expect(p!.changes).toEqual([
      { from: 2, to: 9, insert: "" },
      { from: 10, to: 12, insert: "" },
    ]);
    expect(p!.anchor).toBe(2);
    expect(p!.head).toBe(3);
  });

  it("选区不在高亮内返回 null", () => {
    expect(planHighlightEdit("a ==b== c", 8, 9, { kind: "clear" })).toBeNull();
  });
});

describe("applyHighlight（EditorView 集成）", () => {
  // 需要 markdown 扩展：改色/剥除路径依赖语法树定位 Paragraph 节点，
  // 裸 EditorView（无语言扩展）会退化到包裹路径导致断言错误
  function buildView(doc: string): EditorView {
    return new EditorView({
      doc,
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
      ],
    });
  }

  it("包裹命名色并保持选区在内容上", () => {
    const view = buildView("abc def");
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    applyHighlight(view, { kind: "apply", color: "red" });
    expect(view.state.doc.toString()).toBe("=={红}abc== def");
    expect(view.state.selection.main.anchor).toBe(5);
    expect(view.state.selection.main.head).toBe(8);
    view.destroy();
  });

  it("清除剥除", () => {
    const view = buildView("=={红}abc== def");
    view.dispatch({ selection: { anchor: 5, head: 8 } });
    applyHighlight(view, { kind: "clear" });
    expect(view.state.doc.toString()).toBe("abc def");
    view.destroy();
  });

  it("跨行选区按行包裹", () => {
    const view = buildView("ab\ncd");
    view.dispatch({ selection: { anchor: 1, head: 4 } });
    applyHighlight(view, { kind: "apply", color: null });
    expect(view.state.doc.toString()).toBe("a==b==\n==cd==");
    view.destroy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- --run src/lib/highlight.test.ts`
Expected: FAIL — `planLineWrap is not a function` 等

- [ ] **Step 3: 实现**

在 `src/lib/highlight.ts` 追加：

```ts
/** 按行拆分选区并生成包裹事务计划（text 为完整文档，偏移为绝对位置）。
 *  高亮不跨行：跨行选区逐段包裹。color 为 null 表示默认黄（无 token）。 */
export function planLineWrap(
  text: string,
  selFrom: number,
  selTo: number,
  color: string | null,
): { changes: { from: number; to: number; insert: string }[]; anchor: number; head: number } | null {
  if (selFrom >= selTo) return null;
  const prefix = color ? `=={${color}}` : "==";
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
      const newToken = `{${action.color}}`;
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
  let node = syntaxTree(state).resolveInner(from, -1);
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
  // 包裹路径：整篇文档按行拆分
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
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- --run src/lib/highlight.test.ts`
Expected: PASS（全部用例）

再确认既有 keymap 相关测试无回归：

Run: `pnpm test -- --run src/lib/editorKeymap.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/highlight.ts src/lib/highlight.test.ts
git commit -m "feat(highlight): 选区写回——按行包裹/改色/剥除高亮"
```

---

### Task 5: 选中调色工具条

**Files:**
- Modify: `src/lib/highlight.ts`（追加 highlightTooltipField / highlightTooltip / createHighlightBar）
- Test: `src/lib/highlight.test.ts`（追加用例）

**Interfaces:**
- Consumes: `HL_COLORS`、`applyHighlight`、`HighlightAction`（Task 1/4）
- Produces:
  - `export const highlightTooltipField: StateField<Tooltip | null>`
  - `export function highlightTooltip(): Extension`

- [ ] **Step 1: 写失败测试**

在 `src/lib/highlight.test.ts` 追加：

```ts
import { highlightTooltip, highlightTooltipField } from "./highlight";

describe("highlightTooltip 调色工具条", () => {
  // 与 applyHighlight 测试同理：剥除/改色路径需要 markdown 语法树
  function buildView(doc: string): EditorView {
    return new EditorView({
      doc,
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        highlightTooltip(),
      ],
    });
  }

  it("空选区不显示", () => {
    const view = buildView("abc");
    expect(view.state.field(highlightTooltipField)).toBeNull();
    view.destroy();
  });

  it("非空选区显示，位置在选区头", () => {
    const view = buildView("abc def");
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    const tip = view.state.field(highlightTooltipField);
    expect(tip).not.toBeNull();
    expect(tip!.pos).toBe(3);
    view.destroy();
  });

  it("选区变空关闭", () => {
    const view = buildView("abc");
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.state.field(highlightTooltipField)).toBeNull();
    view.destroy();
  });

  it("点击色块写回并关闭工具条", () => {
    const view = buildView("abc def");
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    const tip = view.state.field(highlightTooltipField)!;
    const bar = tip.create(view);
    expect(bar.className).toBe("hl-toolbar");
    expect(bar.querySelectorAll("button")).toHaveLength(9); // 默认 + 7 色 + 清除
    bar.querySelector<HTMLButtonElement>(".hl-swatch-red")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("=={红}abc== def");
    expect(view.state.field(highlightTooltipField)).toBeNull();
    view.destroy();
  });

  it("点击清除按钮剥除高亮", () => {
    const view = buildView("=={红}abc== def");
    view.dispatch({ selection: { anchor: 5, head: 8 } });
    const tip = view.state.field(highlightTooltipField)!;
    tip.create(view)
      .querySelector<HTMLButtonElement>(".hl-swatch-clear")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("abc def");
    view.destroy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- --run src/lib/highlight.test.ts`
Expected: FAIL — `highlightTooltip is not a function`

- [ ] **Step 3: 实现**

在 `src/lib/highlight.ts` 末尾追加：

```ts
/** 关闭调色工具条（点击色块后手动关闭） */
const dismissHighlightTooltip = StateEffect.define<void>();

/** 调色工具条可见性：非空选区显示，选区变空/滚动后自动关闭 */
export const highlightTooltipField = StateField.define<Tooltip | null>({
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
  provide: (f) => showTooltip.from(f),
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
    ...HL_COLORS.map((c) => ({
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
  return bar;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- --run src/lib/highlight.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/lib/highlight.ts src/lib/highlight.test.ts
git commit -m "feat(highlight): 选中文字浮出调色工具条（默认+7色+清除）"
```

---

### Task 6: Editor.tsx 接入工具条

**Files:**
- Modify: `src/components/Editor.tsx`

**Interfaces:**
- Consumes: `highlightTooltip`（Task 5）
- Produces: 编辑器获得工具条扩展（源码模式与所见即所得模式均生效——写回只是文本操作）

- [ ] **Step 1: 实现**

1. 在 `src/components/Editor.tsx` 的 import 区（`@/lib/editorViewCache` import 之后）加入：

```ts
import { highlightTooltip } from "@/lib/highlight";
```

2. 在 `extensions` useMemo 数组（约 1036 行）中，`editorKeymap,` 之后加入：

```ts
        highlightTooltip(),
```

（`useMemo` 依赖数组不变——`highlightTooltip()` 在 useMemo 内部求值，模块级函数引用稳定，不会触发 react-codemirror reconfigure。）

- [ ] **Step 2: 验证**

Run: `pnpm build`
Expected: 类型检查与构建通过

Run: `pnpm test`
Expected: 全部测试通过（无回归）

- [ ] **Step 3: 提交**

```bash
git add src/components/Editor.tsx
git commit -m "feat(highlight): 编辑器接入高亮调色工具条扩展"
```

---

### Task 7: 导出——marked 扩展与导出样式

**Files:**
- Modify: `src/lib/export.ts`（注册 marked 扩展）
- Modify: `src/lib/exportStyles.ts`（追加 mark 样式）
- Test: `src/lib/export-highlight.test.ts`（新建）

**Interfaces:**
- Consumes: `HL_ALIASES`（Task 1）
- Produces: `renderHtml` 输出 `<mark class="hl-{色}">…</mark>`；导出样式含 `mark.hl-*`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/export-highlight.test.ts`：

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHtml } from "./export";

describe("export — 高亮 =={色}…==", () => {
  it("默认色", async () => {
    const html = await renderHtml("==重点==");
    expect(html).toContain('<mark class="hl-default">重点</mark>');
  });

  it("中文命名色", async () => {
    const html = await renderHtml("=={红}重点==");
    expect(html).toContain('<mark class="hl-red">重点</mark>');
  });

  it("英文别名", async () => {
    const html = await renderHtml("=={red}重点==");
    expect(html).toContain('<mark class="hl-red">重点</mark>');
  });

  it("未知 token 保留字面", async () => {
    const html = await renderHtml("=={xyz}内容==");
    expect(html).toContain('<mark class="hl-default">{xyz}内容</mark>');
  });

  it("行内代码内 == 不受影响", async () => {
    const html = await renderHtml("`==x==`");
    expect(html).toContain("<code>==x==</code>");
    expect(html).not.toContain("<mark");
  });

  it("高亮内可嵌套加粗", async () => {
    const html = await renderHtml("=={蓝}**粗**==");
    expect(html).toContain('<mark class="hl-blue"><strong>粗</strong></mark>');
  });

  it("导出样式包含高亮色", async () => {
    const html = await renderHtml("=={蓝}x==");
    expect(html).toContain("mark.hl-blue");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- --run src/lib/export-highlight.test.ts`
Expected: FAIL — `==重点==` 以字面 `==重点==` 输出，无 `<mark>`

- [ ] **Step 3: 实现**

1. `src/lib/export.ts` 中，`import { isMac } from "@/lib/platform";` 之后加入：

```ts
import { HL_ALIASES } from "./highlight";
```

在 `marked.use(markedHighlight(...))` 调用之后追加：

```ts
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
      tokenizer: function (this: import("marked").Tokenizer, src: string) {
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
      renderer: function (this: import("marked").Renderer, token: import("marked").Tokens.Generic) {
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
```

2. `src/lib/exportStyles.ts` 中，在 `p { margin: 0; }` 规则之后加入：

```css
/* ---- 高亮（=={色}…==）---- */
mark.hl-default,
mark.hl-yellow { background-color: #fdf0b8; color: #6b5a00; border-radius: 2px; padding: 0 2px; }
mark.hl-red    { background-color: #fbcaca; color: #8c1d1d; border-radius: 2px; padding: 0 2px; }
mark.hl-orange { background-color: #fcdcb8; color: #7a3f08; border-radius: 2px; padding: 0 2px; }
mark.hl-green  { background-color: #c9ecc9; color: #1c5c1c; border-radius: 2px; padding: 0 2px; }
mark.hl-cyan   { background-color: #bfe9f2; color: #0a4d5e; border-radius: 2px; padding: 0 2px; }
mark.hl-blue   { background-color: #c9d9fb; color: #1c3d8c; border-radius: 2px; padding: 0 2px; }
mark.hl-purple { background-color: #e0ccf9; color: #4f1f8c; border-radius: 2px; padding: 0 2px; }
mark.hl-pink   { background-color: #fbcbdf; color: #8c1d56; border-radius: 2px; padding: 0 2px; }
```

（注：exportStyles.ts 是模板字符串，插入内容不能包含反引号；上面代码无反引号。）

（TS 后备：若 `this.lexer` / `this.parser` 报类型错误（marked 类型未完整暴露实例属性），用 `(this as unknown as { lexer: { inline(s: string): import("marked").Tokens.Generic[] }; parser: { parseInline(t: import("marked").Tokens.Generic[]): string } })` 显式解构后再调用，行为不变。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- --run src/lib/export-highlight.test.ts`
Expected: PASS（7 个用例）

再跑既有导出测试：

Run: `pnpm test -- --run src/lib/export.test.ts`
Expected: PASS（marked 扩展不影响既有渲染）

- [ ] **Step 5: 提交**

```bash
git add src/lib/export.ts src/lib/exportStyles.ts src/lib/export-highlight.test.ts
git commit -m "feat(highlight): HTML 导出渲染 =={色}…== 高亮（marked 扩展 + 导出样式）"
```

---

### Task 8: 全量验证与手动检查

**Files:** 无（验证任务）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全部通过（含既有 livePreview/export/keymap/editor 套件）

- [ ] **Step 2: 类型检查与构建**

Run: `pnpm build`
Expected: `tsc` 与 `vite build` 均通过

- [ ] **Step 3: 手动验证清单**（`pnpm tauri dev` 运行应用）

- [ ] 选中一段文字 → 选区上方浮出调色工具条（9 个圆钮：默认黄 + 7 色 + 清除斜杠圆）
- [ ] 点红 → 文字变 `=={红}…==`，所见即所得渲染红底、`==` 与 `{红}` 隐藏
- [ ] 选中红色高亮内容再点红 → 剥除恢复纯文本
- [ ] 点默认黄 → 变 `==…==` 黄底
- [ ] 跨行选择两行文字 → 每行独立包裹
- [ ] 工具条点色后自动关闭，焦点回到编辑器
- [ ] Cmd+Z 撤销 → 高亮还原为原文；重做恢复
- [ ] 暗色主题下高亮背景/文字可读（颜色加深变浅）
- [ ] 源码模式：`=={红}…==` 原样显示可手改
- [ ] 代码块 / 行内代码 / 链接 URL / `$x==y$` 内的 `==` 不高亮
- [ ] `\==` 转义输出字面 `==`
- [ ] 导出 HTML：高亮以 `<mark class="hl-red">` 渲染并带背景色
- [ ] 编辑器内 `==` 两侧点击无光标偏移（block widget 铁律不涉及——本功能全是 mark 装饰）

- [ ] **Step 4: 收尾提交**

若验证中发现遗留问题，修复后单独提交；无问题则本任务无提交。

---

## Self-Review 记录

**Spec 覆盖对照**（spec 节 → Task）：
- §2 语法规范 → Task 1（别名表/未知 token/非贪婪）、Task 2（转义/保护区间）、Task 4（写回语义）
- §3 解析机制 → Task 2
- §4 渲染与主题 → Task 3
- §5 工具条交互与写回 → Task 4、5、6
- §6 导出兼容 → Task 7
- §7 边界情况表 → Task 1/2/4 测试用例逐项覆盖
- §8 测试 → 各 Task TDD 步骤 + Task 8 全量
- §10 范围外 → 未纳入任何 Task（YAGNI）

**类型一致性**：`HighlightMatch`（start/end/tokenText/color）、`HighlightAction`、`planLineWrap`/`planHighlightEdit` 返回结构（changes/anchor/head）、`scanHighlights`、`HL_ALIASES`、`highlightTooltip`/`highlightTooltipField` 在各 Task 间签名一致；类名 `.lp-hl-{color}`（Task 2 生成）与 CSS（Task 3）一致；`mark.hl-{color}`（Task 7）与导出样式一致。
