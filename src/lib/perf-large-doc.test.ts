// @vitest-environment jsdom
// 超长文档基准：加载 test/超长压力测试.md（22031 行 / 5.5MB）到与
// Editor.tsx 相同的扩展链中，分阶段计时，输出每阶段毫秒数。
// 目的：量化"加载慢 / 打字卡"的瓶颈分布，优化前后对比。
// 注意：jsdom 无布局引擎，DOM 布局耗时不在测量范围内（真实布局在
// WebView 中只增不减）；这里测量的是纯 JS 主线程耗时。
//
// 基准默认跳过（普通 pnpm test 不跑，避免 16GB 机器内存被打满）。
// 手动跑基准时必须限制 worker 数，否则 vitest 按 CPU 核数起 fork、
// 每个都构建完整编辑器链，会拖进 swap/OOM：
//   RUN_BENCH=1 vitest run src/lib/perf-large-doc.test.ts --minWorkers=1 --maxWorkers=1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, syntaxTree, ensureSyntaxTree } from "@codemirror/language";
import { livePreview } from "./livePreview";
import { codeHighlight } from "@/components/Editor";
import { countWords } from "./utils";

/** 性能探针汇总器：注入 __lpPerf，按名称累加耗时 */
function installPerfProbe(): {
  table: () => Map<string, { count: number; total: number; max: number }>;
  clear: () => void;
} {
  const table = new Map<string, { count: number; total: number; max: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__lpPerf = (name: string, ms: number) => {
    let e = table.get(name);
    if (!e) {
      e = { count: 0, total: 0, max: 0 };
      table.set(name, e);
    }
    e.count++;
    e.total += ms;
    if (ms > e.max) e.max = ms;
  };
  return { table: () => table, clear: () => table.clear() };
}

function dumpProbe(title: string, getTable: () => Map<string, { count: number; total: number; max: number }>) {
  const rows = [...getTable().entries()].sort((a, b) => b[1].total - a[1].total);
  console.log(`  [probe] ${title}:`);
  for (const [name, { count, total, max }] of rows) {
    console.log(
      `    ${name.padEnd(24)} ×${String(count).padStart(4)}  合计 ${total.toFixed(1)}ms  单次最大 ${max.toFixed(1)}ms`,
    );
  }
  return rows.reduce((acc, [, v]) => acc + v.total, 0);
}

const DOC = readFileSync(resolve(process.cwd(), "test/超长压力测试.md"), "utf-8");

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

/** 核心扩展链（与 Editor.tsx 的 extensions useMemo 一致，去掉交互类扩展） */
function coreExtensions(): Extension[] {
  return [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(codeHighlight),
    livePreview({ assetBase: "/tmp" }),
    EditorView.lineWrapping,
  ];
}

// 门控：设 RUN_BENCH=1 才跑（见文件头注释），避免默认 pnpm test 加载超大文档。
const isBench = !!process.env.RUN_BENCH;
describe.skipIf(!isBench)("超长文档基准（test/超长压力测试.md）", () => {
  it("加载分阶段耗时", () => {
    const results: string[] = [];
    const t0 = performance.now();

    // Phase 1: Lezer 纯解析（理论下限，不可消除）
    let parseTime = 0;
    {
      const t = performance.now();
      const tree = markdownLanguage.parser.parse(DOC);
      parseTime = performance.now() - t;
      results.push(`Lezer 全量解析: ${fmt(parseTime)}`);
      expect(tree.length).toBeGreaterThan(0);
    }

    // Phase 2: EditorState.create —— 冷开视口化后只扫已解析区间（~3000 字符），
    // 不再每字段 ensureSyntaxTree(500) 强推全文（原 5.5MB 文档累计数秒冻结）
    const t1 = performance.now();
    const state = EditorState.create({
      doc: DOC,
      extensions: coreExtensions(),
    });
    const stateCreate = performance.now() - t1;
    results.push(`EditorState.create(4 个 field): ${fmt(stateCreate)}`);
    expect(stateCreate).toBeLessThan(200);

    // Phase 3: ViewPlugin build + 初始视口 DOM
    const t2 = performance.now();
    const view = new EditorView({ state, parent: document.body });
    const viewCreate = performance.now() - t2;
    results.push(`EditorView 创建(plugin build): ${fmt(viewCreate)}`);
    expect(viewCreate).toBeLessThan(200);

    // Phase 4: 语法树覆盖（初始 ~3000 字符解析窗口；全文由 parseWorker 后台分片补齐）
    const t4 = performance.now();
    const tree = syntaxTree(view.state);
    const treeHeight = tree.topNode.to - tree.topNode.from;
    results.push(`初始语法树覆盖: ${treeHeight}/${DOC.length} 字符`);
    results.push(`初始语法树解析耗时: ${fmt(performance.now() - t4)}`);

    // Phase 5: 首帧视口装饰规模
    const t5 = performance.now();
    const decos = view.dom.querySelectorAll(".lp-strong, .lp-em, .lp-inline-code, .lp-h1, .lp-h2, .lp-h3, .lp-h4, .lp-checkbox, .lp-bullet, .lp-quote, .lp-math-inline, .lp-math-block, .lp-mermaid, table.lp-table");
    results.push(`首帧视口装饰 DOM 元素: ${decos.length}`);
    const count = countWords(DOC);
    results.push(`countWords(全文): ${fmt(performance.now() - t5)} (${count} 字)`);

    // Phase 6: 连续击键 —— 树未完整时（真实应用加载后的渐进解析状态，正常视口）
    const probe = installPerfProbe();
    const pos = Math.floor(DOC.length / 3);
    const keystrokes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      view.dispatch({ changes: { from: pos + i, insert: "a" } });
      keystrokes.push(performance.now() - t);
    }
    keystrokes.sort((a, b) => a - b);
    const avg = keystrokes.reduce((a, b) => a + b, 0) / keystrokes.length;
    const p95 = keystrokes[Math.floor(keystrokes.length * 0.95)];
    results.push(
      `击键 dispatch(树未完整): avg ${fmt(avg)} / p95 ${fmt(p95)} / max ${fmt(keystrokes[keystrokes.length - 1])}`,
    );
    dumpProbe("树未完整 20 键分项", probe.table);

    // Phase 7: 强制全量解析后（稳定状态）再测 20 键（清零探针，只看本阶段）
    const t6 = performance.now();
    let tree8 = syntaxTree(view.state);
    while (tree8.topNode.to < view.state.doc.length) {
      tree8 = ensureSyntaxTree(view.state, view.state.doc.length, 200) ?? tree8;
    }
    // 空事务让 LanguageState 拾取已完成的语法树（等价于 longDocParsePlugin 完成帧），
    // 否则首键会把"state 陈旧树 → 全文"当作树推进整段重建，非真实场景。
    view.dispatch({});
    results.push(`强制全量解析: ${fmt(performance.now() - t6)}`);
    probe.clear();

    const keystrokes2: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      view.dispatch({ changes: { from: pos + i, insert: "b" } });
      keystrokes2.push(performance.now() - t);
    }
    keystrokes2.sort((a, b) => a - b);
    const avg2 = keystrokes2.reduce((a, b) => a + b, 0) / keystrokes2.length;
    const p95_2 = keystrokes2[Math.floor(keystrokes2.length * 0.95)];
    results.push(
      `击键 dispatch(树完整): avg ${fmt(avg2)} / p95 ${fmt(p95_2)} / max ${fmt(keystrokes2[keystrokes2.length - 1])}`,
    );
    const typingTotal = dumpProbe("树完整 20 键分项", probe.table);
    results.push(`20 键重建合计（探针）: ${fmt(typingTotal)}`);
    // 关键断言：稳定状态下每键 mergeRanges（build:incremental）平均 < 100ms——
    // 增量重建 + RangeSet.update 整块复用应把每键成本压到 O(变化区)。
    const inc = probe.table().get("build:incremental");
    const incAvg = inc && inc.count > 0 ? inc.total / inc.count : 0;
    results.push(`build:incremental 平均: ${fmt(incAvg)}`);
    expect(incAvg).toBeLessThan(100);

    // Phase 8: 强制全量渲染 DOM（真实应用 fullRenderViewport 对 ≤5000 行文档
    // 直接全量建 DOM——超大文档超阈值走虚拟滚动，此阶段仅量化首帧全量渲染成本）
    const t3 = performance.now();
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vs = (view as any).viewState;
      vs.pixelViewport.bottom = 1e9;
      vs.printing = true;
      vs.viewport = vs.getViewport(0, null);
      vs.updateForViewport();
      vs.updateViewportLines();
    }
    const fullRender = performance.now() - t3;
    const domLines = view.dom.querySelectorAll(".cm-line").length;
    results.push(`强制全量渲染全文 DOM: ${fmt(fullRender)} (DOM 行数 ${domLines}/${state.doc.lines})`);

    view.destroy();
    const total = performance.now() - t0;
    results.push(`── 总计: ${fmt(total)}`);
    console.log("[perf-large-doc] 超长文档基准:");
    for (const line of results) console.log("  ", line);
  });

  it("最小复现：30 行公式文档，末尾编辑时顶部公式是否重渲染", () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(`第 ${i} 行段落，包含公式 $E = mc^2$ 与文字。`);
    const doc = lines.join("\n");
    const state = EditorState.create({ doc, extensions: coreExtensions() });
    const view = new EditorView({ state, parent: document.body });
    // 强制全量解析 + 空事务让装饰建立
    let tr = syntaxTree(view.state);
    while (tr.topNode.to < view.state.doc.length) {
      tr = ensureSyntaxTree(view.state, view.state.doc.length, 200) ?? tr;
    }
    view.dispatch({});
    const probe = installPerfProbe();
    // 末尾插入 10 次，统计渲染
    for (let i = 0; i < 10; i++) {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\n追加 " + i } });
    }
    const t = probe.table();
    console.log(
      `[最小复现] 末尾 10 键后 katex:render=${t.get("katex:render")?.count ?? 0} 次 build:ranges=${t.get("build:ranges")?.count ?? 0} 次`,
    );
    view.destroy();
  });

  it("扩展链增量归因：纯 CM6 → +highlight → +livePreview", () => {
    const mk = (exts: Extension[]) => {
      const s = EditorState.create({ doc: DOC, extensions: exts });
      const v = new EditorView({ state: s, parent: document.body });
      // 静置等待 longDocParsePlugin 的异步 dispatch 完成，保证对比公平
      const times: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t = performance.now();
        v.dispatch({ changes: { from: Math.floor(DOC.length / 2) + i, insert: "x" } });
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      v.destroy();
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      return { avg, p95: times[Math.floor(times.length * 0.95)] };
    };

    const base = mk([markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping]);
    console.log(`[归因] 纯 CM6+markdown: avg ${base.avg.toFixed(1)}ms`);
    const hl = mk([markdown({ base: markdownLanguage, codeLanguages: languages }), syntaxHighlighting(codeHighlight), EditorView.lineWrapping]);
    console.log(`[归因] +syntaxHighlighting: avg ${hl.avg.toFixed(1)}ms（增量 ${(hl.avg - base.avg).toFixed(1)}ms）`);
    const lp = mk([markdown({ base: markdownLanguage, codeLanguages: languages }), syntaxHighlighting(codeHighlight), livePreview({ assetBase: "/tmp" }), EditorView.lineWrapping]);
    console.log(`[归因] +livePreview: avg ${lp.avg.toFixed(1)}ms（增量 ${(lp.avg - hl.avg).toFixed(1)}ms）`);
  });

  it("快速滚动模拟：分块滚动全文，测每块 tile 创建耗时", () => {
    const state = EditorState.create({ doc: DOC, extensions: coreExtensions() });
    const view = new EditorView({ state, parent: document.body });
    // 强制全量解析
    let tr = syntaxTree(view.state);
    while (tr.topNode.to < view.state.doc.length) {
      tr = ensureSyntaxTree(view.state, view.state.doc.length, 300) ?? tr;
    }
    view.dispatch({});

    // 模拟快速滚动：把 viewport 按 2000px 步长分块推进，每块创建 DOM
    const CHUNK = 2000;
    const viewportHeight = 800; // 典型窗口高度
    const lineH = 26;           // CM6 默认行高
    const linesPerChunk = Math.ceil(CHUNK / lineH); // ~77 行/块
    // 模拟像素视口：CM6 按 pixelViewport + viewportMargin 决定创建哪些行的 DOM
    let scrollTop = 0;
    const times: number[] = [];
    const maxScroll = view.defaultLineHeight * view.state.doc.lines - viewportHeight;

    while (scrollTop < maxScroll) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vs = (view as any).viewState;
      vs.pixelViewport.top = scrollTop;
      vs.pixelViewport.bottom = scrollTop + viewportHeight + CHUNK * 2; // margin
      const t = performance.now();
      vs.viewport = vs.getViewport(scrollTop + CHUNK, null);
      vs.updateForViewport();
      vs.updateViewportLines();
      times.push(performance.now() - t);
      scrollTop += CHUNK;
    }

    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = times[times.length - 1];
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(
      `[滚动模拟] ${times.length} 块, 每块 ~${linesPerChunk} 行: avg ${avg.toFixed(1)}ms / p95 ${p95.toFixed(1)}ms / max ${max.toFixed(1)}ms`,
    );
    // 找出最慢块的装饰类型（表格、公式密集区）
    const domLines = view.dom.querySelectorAll(".cm-line").length;
    console.log(`[滚动模拟] 当前视口 DOM 行数: ${domLines}`);

    view.destroy();
  });

  it("装饰量对照：去掉行内标记（粗体/斜体/代码/删除线）后 dispatch 时间", () => {
    // 行内 mark 装饰是装饰总量的大头，验证 CM6 每键成本是否 ∝ 装饰总量
    const docPlain = DOC
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1");
    const s = EditorState.create({ doc: docPlain, extensions: coreExtensions() });
    const v = new EditorView({ state: s, parent: document.body });
    // 等 longDocParsePlugin 全量解析完成
    let tr = syntaxTree(v.state);
    while (tr.topNode.to < v.state.doc.length) {
      tr = ensureSyntaxTree(v.state, v.state.doc.length, 300) ?? tr;
    }
    v.dispatch({});
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      v.dispatch({ changes: { from: Math.floor(docPlain.length / 3) + i, insert: "x" } });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`[装饰量对照] 去行内标记后 dispatch avg ${avg.toFixed(1)}ms（原文 229ms）`);
    v.destroy();
  });

  it("无公式文档对照（mathField 是否为主热点）", () => {
    // 去掉 $ 的变体：120 行内 + 20 块级公式全部替换成普通文本
    const docNoMath = DOC.replace(/\$\$[\s\S]*?\$\$/g, "块级公式").replace(
      /\$[^$\n]+\$/g,
      "行内公式",
    );

    const t = performance.now();
    const state = EditorState.create({
      doc: docNoMath,
      extensions: coreExtensions(),
    });
    const withFields = performance.now() - t;

    const t2 = performance.now();
    const state2 = EditorState.create({
      doc: docNoMath,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(codeHighlight),
        EditorView.lineWrapping,
      ],
    });
    const noFields = performance.now() - t2;

    console.log(
      "[perf-large-doc] 无公式文档 stateCreate: livePreview 全链",
      fmt(withFields),
      "/ 无 livePreview",
      fmt(noFields),
      "/ livePreview 增量",
      fmt(withFields - noFields),
    );
    expect(state.doc.length).toBeGreaterThan(0);
    expect(state2.doc.length).toBeGreaterThan(0);
  });
});
