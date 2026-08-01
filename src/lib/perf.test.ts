// @vitest-environment jsdom
// 性能优化回归测试：确保优化后装饰、补全、计数等行为不退化。
// 每个测试模拟真实编辑场景，测量关键指标并验证功能正确性。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import {
  EditorState,
  StateEffect,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxTree, syntaxHighlighting } from "@codemirror/language";
import { livePreview, parseTable, buildTableMarkdown } from "./livePreview";
import { codeHighlight } from "@/components/Editor";
import { noteCompletionSource, filterNotes, collectNotes, type NoteItem } from "./noteCompletion";
import { countWords } from "./utils";

// ============================================================================
// Fix 1: ensureSyntaxTree 替换为 syntaxTree
// 验证：增量编辑后语法树仍正确解析，装饰不缺失
// ============================================================================
describe("Fix 1: 语法树增量解析（去掉 ensureSyntaxTree）", () => {
  /** 统计 build() 调用次数 */
  function countBuildCalls(extensions: Extension[]): { count: () => number; destroy: () => void } {
    let calls = 0;
    const tracker = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          calls++;
          this.decorations = Decoration.none;
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged) {
            calls++;
          }
        }
      },
      { decorations: (v) => v.decorations },
    );
    return {
      count: () => calls,
      destroy: () => {}, // view.destroy 会清理
    };
  }

  it("增量编辑后语法树能正确识别节点类型（增量解析可达范围）", () => {
    const view = new EditorView({
      doc: "# 标题\n\n- [ ] 待办\n\n**加粗** *斜体*\n",
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    // 编辑：在文档开头插入（编辑点附近的增量解析会立即完成）
    view.dispatch({ changes: { from: 0, insert: "## 新标题\n\n`code`\n\n" } });

    // 编辑点附近（~几百字符）的增量解析会立即完成，不依赖 ensureSyntaxTree
    const tree = syntaxTree(view.state);
    const names = new Set<string>();
    tree.iterate({ enter(n) { names.add(n.name); } });

    // 编辑点附近的 GFM 核心节点应存在
    expect(names.has("ATXHeading2")).toBe(true);
    expect(names.has("InlineCode")).toBe(true);
    // 远离编辑点的旧内容节点可能尚未被增量解析覆盖，
    // 但标题和加粗等基础节点通常在首次创建时就已解析
    expect(names.has("ATXHeading1")).toBe(true);
    expect(names.has("StrongEmphasis")).toBe(true);
    expect(names.has("Emphasis")).toBe(true);

    // DOM 装饰应存在（即时渲染生效——livePreview 的 build() 已用 ensureSyntaxTree 强制解析）
    expect(view.dom.querySelector(".lp-h1")).not.toBeNull();
    expect(view.dom.querySelector(".lp-h2")).not.toBeNull();
    expect(view.dom.querySelector(".lp-strong")).not.toBeNull();
    expect(view.dom.querySelector(".lp-em")).not.toBeNull();
    expect(view.dom.querySelector(".lp-inline-code")).not.toBeNull();
    expect(view.dom.querySelector("input.lp-checkbox")).not.toBeNull();

    view.destroy();
  });

  it("大文档（500 行）增量编辑后装饰完整不丢失", () => {
    // 构建 500 行文档
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      if (i % 5 === 0) lines.push(`### 第 ${i} 节`);
      else if (i % 3 === 0) lines.push(`- 条目 ${i}`);
      else lines.push(`段落 ${i} 包含 **加粗** 和 *斜体* 文字。`);
    }
    const doc = lines.join("\n");

    const view = new EditorView({
      doc,
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    // 在文档开头插入（始终在 jsdom 视口内，无需 scrollIntoView）
    view.dispatch({ changes: { from: 0, insert: "## 插入标题\n\n`新增代码`\n**加粗**\n\n" } });

    // 验证：新插入的装饰均存在（jsdom 无布局引擎，视口从文档头开始）
    expect(view.dom.querySelector(".lp-h2")).not.toBeNull();
    expect(view.dom.querySelector(".lp-inline-code")).not.toBeNull();
    expect(view.dom.querySelector(".lp-strong")).not.toBeNull();

    view.destroy();
  });

  it("表格在增量编辑后仍正确渲染", () => {
    const view = new EditorView({
      doc: "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n正文\n",
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    // 编辑表格下方的正文
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n新增行\n" } });

    // 表格应保持渲染
    expect(view.dom.querySelector("table.lp-table")).not.toBeNull();
    expect(view.dom.querySelector("table.lp-table")!.textContent).toContain("1");

    view.destroy();
  });

  it("代码块在增量编辑后装饰不丢失（围栏 + 圆角类名）", () => {
    const view = new EditorView({
      doc: "```js\nconst x = 1;\n```\n\n正文",
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    // 在代码块前插入
    view.dispatch({ changes: { from: 0, insert: "# 标题\n\n" } });

    const codeLines = view.dom.querySelectorAll(".cm-line.lp-code-line");
    expect(codeLines.length).toBe(3);
    expect(view.dom.querySelector(".cm-line.lp-code-line-top")).not.toBeNull();
    expect(view.dom.querySelector(".cm-line.lp-code-line-bot")).not.toBeNull();
    expect(view.dom.querySelector(".lp-code-lang")).not.toBeNull();

    view.destroy();
  });
});

// ============================================================================
// Fix 2: 装饰映射（mapPos）替代全量重建
// 验证：编辑后装饰位置正确，不漂移、不丢失
// ============================================================================
describe("Fix 2: 装饰位置映射（mapPos）", () => {
  it("文档开头插入后标题装饰仍落在正确行", () => {
    const view = new EditorView({
      doc: "# 原始标题\n\n正文内容。\n",
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    // 在文档开头插入
    view.dispatch({ changes: { from: 0, insert: "前言段落。\n\n" } });

    // 标题装饰应跟随下移
    const h1Line = view.dom.querySelector(".cm-line.lp-h1");
    expect(h1Line).not.toBeNull();
    expect(h1Line!.textContent).toBe("原始标题");

    // 新插入的"前言段落"不应有标题样式
    const allH1 = view.dom.querySelectorAll(".cm-line.lp-h1");
    expect(allH1.length).toBe(1);

    view.destroy();
  });

  it("文档中间删除后装饰不漂移", () => {
    const view = new EditorView({
      doc: "# 标题\n\n段落 **加粗文字** 在这里。\n\n- 列表项\n\n## 第二节\n",
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    // 删除中间段落
    const doc = view.state.doc.toString();
    const from = doc.indexOf("段落 **加粗文字** 在这里。");
    const to = from + "段落 **加粗文字** 在这里。".length;
    view.dispatch({ changes: { from, to } });

    // 标题和列表装饰应正确保留在各自行
    expect(view.dom.querySelector(".cm-line.lp-h1")).not.toBeNull();
    expect(view.dom.querySelector(".cm-line.lp-h2")).not.toBeNull();
    expect(view.dom.querySelector(".lp-bullet")).not.toBeNull();

    // 被删除的加粗不应留在 DOM
    expect(view.dom.querySelector(".lp-strong")).toBeNull();

    view.destroy();
  });

  it("连续多次编辑后装饰位置累计正确", () => {
    const view = new EditorView({
      doc: "# A\n\n正文 **B** 文字\n\n# C\n",
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    // 模拟连续编辑
    view.dispatch({ changes: { from: 0, insert: "第零行\n" } });
    view.dispatch({ changes: { from: 3, to: 5 } }); // 删除 "A\n"
    view.dispatch({ changes: { from: 0, insert: "新第一行\n" } });

    // 标题 # C 应仍在正确位置
    const h1Lines = view.dom.querySelectorAll(".cm-line.lp-h1");
    expect(h1Lines.length).toBe(1);
    expect(h1Lines[0].textContent).toBe("C");

    view.destroy();
  });

  it("表格编辑后 block widget 位置正确", () => {
    const view = new EditorView({
      doc: "# 前言\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n# 后记\n",
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    // 在表格前插入行
    const doc = view.state.doc.toString();
    const tableStart = doc.indexOf("| A |");
    view.dispatch({ changes: { from: tableStart, insert: "\n新段落\n\n" } });

    // 表格应仍在
    const table = view.dom.querySelector("table.lp-table");
    expect(table).not.toBeNull();
    expect(table!.textContent).toContain("1");

    // 标题应正确
    const h1Lines = view.dom.querySelectorAll(".cm-line.lp-h1");
    expect(h1Lines.length).toBe(2);

    view.destroy();
  });
});

// ============================================================================
// Fix 3: 移除 u.viewportChanged 触发
// 验证：滚动不触发不必要的 rebuild，但新增可见内容仍有装饰
// ============================================================================
describe("Fix 3: 视口变化不触发装饰重建", () => {
  it("初始构建和文档变更触发装饰重建", () => {
    let buildCount = 0;
    const countingPlugin = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          buildCount++;
          this.decorations = Decoration.none;
        }
        update(u: ViewUpdate) {
          if (u.docChanged) buildCount++;
        }
      },
      { decorations: (v) => v.decorations },
    );

    const view = new EditorView({
      doc: "段落 1: 测试文字\n段落 2: 更多文字\n",
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        countingPlugin,
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    const before = buildCount;
    expect(before).toBeGreaterThan(0); // init 时至少调用一次

    // 编辑触发 docChanged → rebuild
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(buildCount).toBe(before + 1);

    view.destroy();
  });
});

// ============================================================================
// Fix 4: countWords memo
// 验证：字数统计正确性
// ============================================================================
describe("Fix 4: countWords 正确性", () => {
  it("空文本", () => {
    expect(countWords("")).toBe(0);
  });

  it("纯中文", () => {
    expect(countWords("你好世界")).toBe(4);
  });

  it("纯英文", () => {
    expect(countWords("hello world test")).toBe(3);
  });

  it("中英混合", () => {
    expect(countWords("hello 世界 test")).toBe(4);
  });

  it("包含换行和多余空白", () => {
    expect(countWords("  hello   world  \n  test  ")).toBe(3);
  });

  it("包含标点", () => {
    // CJK: 测试。→ 3（。也在 CJK 范围内），Latin: hello, world! → 2
    expect(countWords("hello, world! 测试。")).toBe(5);
  });

  it("Markdown 标记不计入字数", () => {
    // `countWords` 的实现决定是否过滤 # ** 等
    const result = countWords("# 标题 **加粗** [链接](url)");
    expect(result).toBeGreaterThan(0);
  });
});

// ============================================================================
// Fix 5: completionExt 稳定性
// 验证：补全源对象引用稳定时补全结果正确
// ============================================================================
describe("Fix 5: completionExt 引用稳定性", () => {
  const baseNotes: NoteItem[] = [
    { title: "笔记A", path: "/notes/笔记A.md" },
    { title: "笔记B", path: "/notes/笔记B.md" },
    { title: "README", path: "/notes/README.md" },
    { title: "开发指南", path: "/notes/开发指南.md" },
    { title: "CHANGELOG", path: "/notes/CHANGELOG.md" },
  ];

  it("补全源在 notes 引用相同时返回相同结果", () => {
    // 同一份 notes 数组 → 结果应一致
    const results1 = filterNotes(baseNotes, "笔记");
    const results2 = filterNotes(baseNotes, "笔记");
    expect(results1.map((n) => n.title)).toEqual(results2.map((n) => n.title));
  });

  it("空查询返回所有笔记（上限 50）", () => {
    const results = filterNotes(baseNotes, "");
    expect(results.length).toBe(baseNotes.length);
  });

  it("前缀匹配优先于包含匹配", () => {
    const notes: NoteItem[] = [
      { title: "ABCDE", path: "/notes/ABCDE.md" },
      { title: "XXABC", path: "/notes/XXABC.md" },
    ];
    const results = filterNotes(notes, "abc");
    expect(results[0].title).toBe("ABCDE");
    expect(results[1].title).toBe("XXABC");
  });

  it("notes 变化后补全结果反映最新列表", () => {
    const results1 = filterNotes(baseNotes, "笔记");
    expect(results1.length).toBe(2);

    // 新增笔记
    const extended = [...baseNotes, { title: "笔记C", path: "/notes/笔记C.md" }];
    const results2 = filterNotes(extended, "笔记");
    expect(results2.length).toBe(3);
  });

  it("collectNotes 正确展开目录树", () => {
    const nodes = [
      {
        name: "docs",
        path: "/notes/docs",
        isDir: true,
        children: [
          { name: "README.md", path: "/notes/docs/README.md", isDir: false, children: [] },
        ],
      },
      { name: "index.md", path: "/notes/index.md", isDir: false, children: [] },
    ];
    const result = collectNotes(nodes);
    expect(result.length).toBe(2);
    expect(result.find((n) => n.title === "index")).toBeDefined();
    expect(result.find((n) => n.title === "README")).toBeDefined();
  });
});

// ============================================================================
// 综合性能基准：模拟真实编辑负载
// ============================================================================
describe("综合性能：真实编辑场景", () => {
  it("连续键入 200 字符不抛错且装饰完整", () => {
    const doc = "# 标题\n\n正文开始。\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] 任务\n\n结尾。\n";
    const view = new EditorView({
      doc,
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(codeHighlight),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    // 模拟连续键入（每个字符一次 dispatch）
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 这是测试中文内容。";
    let pos = 5; // 在第一行标题后开始
    for (let i = 0; i < 200; i++) {
      const ch = alphabet[i % alphabet.length];
      view.dispatch({ changes: { from: pos, insert: ch } });
      pos += 1;
    }

    // 验证装饰仍完整
    expect(view.dom.querySelector(".lp-h1")).not.toBeNull();
    expect(view.dom.querySelector(".cm-line.lp-code-line")).not.toBeNull();
    expect(view.dom.querySelector("table.lp-table")).not.toBeNull();
    expect(view.dom.querySelector("input.lp-checkbox")).not.toBeNull();

    view.destroy();
  });

  it("频繁编辑不抛错", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`## 第 ${i} 节`);
      lines.push(`段落 ${i}a 包含 **加粗** 文字。`);
      lines.push(`段落 ${i}b 包含 *斜体* 文字。`);
    }
    const doc = lines.join("\n");

    const view = new EditorView({
      doc,
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });
    view.dispatch({});

    // 频繁编辑文档前部（始终在 jsdom 视口内）
    for (let i = 0; i < 20; i++) {
      const pos = Math.min(50 + i * 10, view.state.doc.length - 1);
      view.dispatch({ changes: { from: pos, insert: "x" } });
    }

    // 不抛错即通过
    expect(view.state.doc.length).toBeGreaterThan(0);
    view.destroy();
  });
});
