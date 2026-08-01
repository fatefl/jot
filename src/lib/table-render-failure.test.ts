// @vitest-environment jsdom
// 表格渲染失败诊断测试：逐一验证各种失败场景的根因
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { livePreview, parseTable, splitRow, buildTableMarkdown } from "./livePreview";

/** 创建带即时渲染的 view，返回 view + 表格是否在语法树中存在 */
function checkTableNode(doc: string) {
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
  const tree = syntaxTree(view.state);
  let tableFound = false;
  let tableRange: { from: number; to: number } | null = null;
  tree.iterate({
    enter(node) {
      if (node.name === "Table") {
        tableFound = true;
        tableRange = { from: node.from, to: node.to };
        return false;
      }
    },
  });
  const hasRendered = view.dom.querySelector("table.lp-table") !== null;
  const hasWrapper = view.dom.querySelector(".lp-table-wrapper") !== null;
  view.destroy();
  return { tableFound, tableRange, hasRendered, hasWrapper };
}

describe("表格渲染失败原因诊断", () => {
  // ================================================================
  // 原因1：语法树未识别出 Table 节点（GFM 解析器未启用或语法无效）
  // ================================================================
  describe("根因1：语法树中不存在 Table 节点", () => {
    it("正常表格：语法树中有 Table 节点", () => {
      const { tableFound, hasRendered } = checkTableNode("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
      expect(tableFound).toBe(true);
      expect(hasRendered).toBe(true);
    });

    it("❌ 分隔行每列只有一个 -：语法树中仍有 Table 节点，渲染正常", () => {
      // /^:?-+:?$/ 中 -+ 匹配1个或多个，单个 - 也合法
      const { tableFound, hasRendered } = checkTableNode("| a | b |\n| - | - |\n| 1 | 2 |\n");
      expect(tableFound).toBe(true);
      expect(hasRendered).toBe(true);
    });

    it("分隔行没有管道包裹：cmark-gfm 宽容，仍识别为 Table", () => {
      // cmark-gfm 对 leading/trailing pipe 容忍度很高，即使分隔行
      // 没有 | 也能识别为表格
      const { tableFound, hasRendered } = checkTableNode("| a | b |\n--- | ---\n| 1 | 2 |\n");
      expect(tableFound).toBe(true);
      expect(hasRendered).toBe(true);
    });

    it("表头没有管道包裹：cmark-gfm 同样容忍", () => {
      const { tableFound } = checkTableNode("a | b\n| --- | --- |\n| 1 | 2 |\n");
      expect(tableFound).toBe(true);
    });

    it("❌ 没有分隔行：parseTable 返回 null → 显示为普通文字", () => {
      const { tableFound } = checkTableNode("| a | b |\n| 1 | 2 |\n");
      expect(tableFound).toBe(false);
    });

    it("❌ 表格前没有空行：可能导致 GFM 不识别", () => {
      // GFM 规范要求表格前有空行，但 cmark-gfm 可能容忍
      const { tableFound } = checkTableNode("文字\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
      expect(tableFound).toBe(true); // cmark-gfm 通常容忍
    });

    it("❌ 使用 commonmarkLanguage 而非 markdownLanguage：GFM 扩展不加载", () => {
      // 模拟 Editor.tsx 中 base 改回 commonmarkLanguage 的 bug
      const view = new EditorView({
        doc: "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
        parent: document.body,
        extensions: [
          // 只用 commonmark 不用 GFM
          markdown({ codeLanguages: languages }),
        ],
      });
      view.dispatch({});
      const tree = syntaxTree(view.state);
      let tableFound = false;
      tree.iterate({ enter(n) { if (n.name === "Table") tableFound = true; } });
      expect(tableFound).toBe(false); // commonmark 没有 Table 节点！
      view.destroy();
    });

    it("❌ 列数不一致（header 3 列，分隔行 2 列）：GFM 不识别", () => {
      const { tableFound } = checkTableNode("| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |\n");
      expect(tableFound).toBe(false);
    });
  });

  // ================================================================
  // 原因2：parseTable 中分隔行正则校验失败
  // ================================================================
  describe("根因2：parseTable 分隔行校验失败 (/^:?-+:?$/)", () => {
    it("splitRow 含空字符串时校验失败", () => {
      // splitRow("| | --- |") 去首尾 | → " | --- "，按 | 切分 → [" ", " --- "]
      // trim 后 → ["", "---"]
      // 然后 [""].every(c => /^:?-+:?$/.test("")) → false！
      const cells = splitRow("| | --- |");
      expect(cells).toEqual(["", "---"]);
      expect(cells.every((c) => /^:?-+:?$/.test(c))).toBe(false);
    });

    it("❌ 表格某列的分隔符是纯空格：parseTable 返回 null", () => {
      const raw = "| a | b |\n|     | --- |\n| 1 | 2 |\n";
      const data = parseTable(raw);
      expect(data).toBeNull();
      // TableWidget.toDOM 中 data 为 null → 渲染 raw 文本而非 <table>
    });

    it("分隔行某列是纯空格：GFM 不识别为表格 → 语法树无 Table 节点", () => {
      // GFM 要求分隔行每列至少含一个 - 字符，纯空格列不满足要求
      const { tableFound, hasRendered } = checkTableNode("| a | b |\n|     | --- |\n| 1 | 2 |\n");
      expect(tableFound).toBe(false);  // GFM 拒绝此表格
      expect(hasRendered).toBe(false); // 无 Table 节点 → 无 TableWidget → 无渲染
    });

    it("正常：所有分隔列都有 - 字符", () => {
      const raw = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
      const data = parseTable(raw);
      expect(data).not.toBeNull();
    });
  });

  // ================================================================
  // 原因3：parseTable 中 blank line 过滤导致数据丢失
  // ================================================================
  describe("根因3：parseTable 的 filter(l => l.trim()) 过滤空行", () => {
    it("表格中间有空行：GFM 空行切断表格，后段无分隔行不被识别", () => {
      // 原始文档含空行：
      // | a | b |     ← Table 1 header
      // | --- | --- | ← Table 1 delimiter
      // | 1 | 2 |     ← Table 1 row
      //              ← 空行切断 Table 1
      // | 3 | 4 |     ← 无分隔行，GFM 不识别为表格（解析为段落）
      const view = new EditorView({
        doc: "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| 3 | 4 |\n",
        parent: document.body,
        extensions: [
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          livePreview({ assetBase: "/tmp/test" }),
          EditorView.lineWrapping,
        ],
      });
      view.dispatch({});
      const tree = syntaxTree(view.state);
      let tableCount = 0;
      tree.iterate({ enter(n) { if (n.name === "Table") tableCount++; } });
      // 只有一个 Table：空行后的 | 3 | 4 | 无分隔行，不是表格
      expect(tableCount).toBe(1);
      view.destroy();
    });

    it("tableField update 仅在 docChanged 时重新 findTables：语法树增量解析后不更新", () => {
      // tableField update 条件是 tr.docChanged，但语法树在 docChanged 后
      // 异步完成增量解析——这意味着如果第一次 create 时语法树还没解析完，
      // 表格不会渲染，且后续语法树更新不触发 tableField 重新 findTables
      const view = new EditorView({
        doc: "前缀段落\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
        parent: document.body,
        extensions: [
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          livePreview({ assetBase: "/tmp/test" }),
          EditorView.lineWrapping,
        ],
      });
      view.dispatch({});
      // 此时语法树已解析（dispatch({}) 同步等待 requestMeasure）
      const hasRendered = view.dom.querySelector("table.lp-table") !== null;
      expect(hasRendered).toBe(true);
      view.destroy();
    });
  });

  // ================================================================
  // 原因4：初始化时语法树未解析（syntaxTree 返回不完整）
  // ================================================================
  describe("根因4：findTables 中 syntaxTree 不完整", () => {
    it("构建后立即查询：ensureSyntaxTree(500ms) 能争取到完整树", () => {
      // findTables 与 build() 现在都用 ensureSyntaxTree 强制解析整篇（前者
      // 500ms、后者 100ms）。早期版本两者都曾只用裸 syntaxTree，导致未解析
      // 区域的表格与行内装饰缺失（commit ebb3626 修表格、本次修 build）。
      const view = new EditorView({
        doc: "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
        parent: document.body,
        extensions: [
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          livePreview({ assetBase: "/tmp/test" }),
          EditorView.lineWrapping,
        ],
      });
      view.dispatch({});
      // 断言：表格已渲染
      expect(view.dom.querySelector("table.lp-table")).not.toBeNull();
      view.destroy();
    });
  });

  // ================================================================
  // 原因5：TableWidget.toDOM 中 parseTable 返回 null
  // ================================================================
  describe("根因5：TableWidget 构造时 parseTable 返回 null", () => {
    it("parseTable 成功 → 渲染 <table>", () => {
      const view = new EditorView({
        doc: "| a | b |\n| :-: | ---: |\n| 1 | 2 |\n",
        parent: document.body,
        extensions: [
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          livePreview({ assetBase: "/tmp/test" }),
          EditorView.lineWrapping,
        ],
      });
      view.dispatch({});
      expect(view.dom.querySelector("table.lp-table")).not.toBeNull();
      view.destroy();
    });

    it("分隔行某列为空：GFM 拒绝 → 无 Table 节点 → 无 wrapper", () => {
      // GFM 要求分隔行每列至少一个 -，空字符串不符合要求 → 不产生 Table 节点
      const view = new EditorView({
        doc: "| a | b |\n|  | --- |\n| 1 | 2 |\n",
        parent: document.body,
        extensions: [
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          livePreview({ assetBase: "/tmp/test" }),
          EditorView.lineWrapping,
        ],
      });
      view.dispatch({});
      // 无 Table 节点 → findTables 不产生 TableWidget → 无 .lp-table-wrapper
      // 文档以普通段落显示
      const tableNode = view.dom.querySelector(".lp-table-wrapper");
      expect(tableNode).toBeNull();
      view.destroy();
    });
  });

  // ================================================================
  // 综合场景：列出所有可诊断的失败条件
  // ================================================================
  describe("综合诊断清单", () => {
    const cases: Record<string, { doc: string; expectRender: boolean; reason: string }> = {
      "完整表格": {
        doc: "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
        expectRender: true,
        reason: "一切正常",
      },
      "单字符分隔符 -": {
        doc: "| a | b |\n| - | - |\n| 1 | 2 |\n",
        expectRender: true,
        reason: "/^:?-+:?$/ 匹配单个 -",
      },
      "分隔行某列为空": {
        doc: "| a | b |\n|  | --- |\n| 1 | 2 |\n",
        expectRender: false,
        reason: "GFM 拒绝空分隔列 → 无 Table 节点 → 不做任何渲染",
      },
      "分隔行全是空格": {
        doc: "| a | b |\n|     | --- |\n| 1 | 2 |\n",
        expectRender: false,
        reason: "GFM 拒绝纯空格分隔列 → 语法树无 Table 节点",
      },
      "无分隔行": {
        doc: "| a | b |\n| 1 | 2 |\n",
        expectRender: false,
        reason: "GFM 不识别为 Table → 语法树无 Table 节点",
      },
      "分隔行无管道": {
        doc: "| a | b |\n--- | ---\n| 1 | 2 |\n",
        expectRender: true,
        reason: "cmark-gfm 对管道包裹宽容，仍然识别为表格并正常渲染",
      },
      "列数不匹配": {
        doc: "| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |\n",
        expectRender: false,
        reason: "GFM 要求头部与分隔行列数相同",
      },
      "commonmark 而非 GFM": {
        doc: "[用 commonmark 解析器]",
        expectRender: false,
        reason: "commonmark 不含 GFM 扩展 → 无 Table 节点",
      },
      "分隔列空白但含冒号": {
        doc: "| a | b |\n| : | :--- |\n| 1 | 2 |\n",
        expectRender: false,
        reason: "':' 不含 - → 正则不匹配 → parseTable null",
      },
    };

    for (const [name, { doc, expectRender, reason }] of Object.entries(cases)) {
      if (doc === "[用 commonmark 解析器]") {
        it(`${name}: ${reason}`, () => {
          const view = new EditorView({
            doc: "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
            parent: document.body,
            extensions: [markdown({ codeLanguages: languages })],
          });
          view.dispatch({});
          expect(view.dom.querySelector("table.lp-table")).toBeNull();
          view.destroy();
        });
      } else {
        it(`${name}: ${reason} → 渲染=${expectRender}`, () => {
          const { hasRendered } = checkTableNode(doc);
          expect(hasRendered).toBe(expectRender);
        });
      }
    }
  });

  // ================================================================
  // 诊断工具：批量扫描文档，逐一报告每个表格的渲染状态
  // ================================================================
  describe("文件级批量诊断", () => {
    /**
     * 诊断单个表格的渲染失败原因
     * 返回 null 表示正常，返回 string 表示失败原因
     */
    function diagnoseTable(raw: string, index: number): string | null {
      const lines = raw.split("\n");
      const nonEmpty = lines.filter((l) => l.trim());

      // 1. 行数检查
      if (nonEmpty.length < 2) {
        return `行数不足（${nonEmpty.length} 行，需要 ≥2）：可能是表格被空行切断，仅剩表头或单行`;
      }

      // 2. 分隔行检查
      const delimCells = splitRow(nonEmpty[1]);
      if (delimCells.length === 0) {
        return `分隔行 splitRow 返回空数组`;
      }

      // 3. 逐列检查分隔符
      const badCells: { idx: number; raw: string }[] = [];
      for (let i = 0; i < delimCells.length; i++) {
        if (!/^:?-+:?$/.test(delimCells[i])) {
          badCells.push({ idx: i, raw: delimCells[i] });
        }
      }
      if (badCells.length > 0) {
        const details = badCells.map((c) => `第${c.idx + 1}列="[${c.raw}]"(不匹配 /^:?-+:?$/)`).join("; ");
        return `分隔行校验失败: ${details}`;
      }

      // 4. 列数一致性检查（parseTable 不检查，但 GFM 在解析阶段就拒绝）
      const headerCells = splitRow(nonEmpty[0]);
      if (headerCells.length !== delimCells.length) {
        return `表头 ${headerCells.length} 列 vs 分隔行 ${delimCells.length} 列不匹配 → GFM 拒绝该表格`;
      }

      // 5. 数据行检查
      const dataLines = nonEmpty.slice(2);
      for (let i = 0; i < dataLines.length; i++) {
        const cells = splitRow(dataLines[i]);
        if (cells.length !== headerCells.length) {
          return `数据行 ${i + 1} 有 ${cells.length} 列（表头 ${headerCells.length} 列不匹配）`;
        }
      }

      // 6. parseTable 最终校验
      const data = parseTable(raw);
      if (!data) {
        return `parseTable 返回 null（原因未知，可能是边界条件）`;
      }

      return null; // OK
    }

    /**
     * 从 Markdown 文档中提取所有 GFM 识别的 Table 节点，逐一诊断。
     * 同时扫描"看起来像表格"但 GFM 没识别的文本块。
     */
    function scanDocument(doc: string): {
      tables: { index: number; raw: string; error: string | null }[];
      missedByGfm: { index: number; snippet: string }[];
    } {
      const view = new EditorView({
        doc,
        parent: document.body,
        extensions: [
          markdown({ base: markdownLanguage, codeLanguages: languages }),
        ],
      });
      view.dispatch({});

      const tree = syntaxTree(view.state);
      const tables: { index: number; from: number; to: number }[] = [];

      tree.iterate({
        enter(node) {
          if (node.name === "Table") {
            tables.push({ index: tables.length, from: node.from, to: node.to });
            return false;
          }
        },
      });

      const results = tables.map((t) => {
        const raw = view.state.sliceDoc(t.from, t.to);
        return {
          index: t.index,
          raw,
          error: diagnoseTable(raw, t.index),
        };
      });

      // 查找 GFM 没识别但"看起来像表格"的行
      const lines = doc.split("\n");
      const tableRanges = new Set<number>();
      for (const t of tables) {
        for (let i = view.state.doc.lineAt(t.from).number; i <= view.state.doc.lineAt(t.to).number; i++) {
          tableRanges.add(i);
        }
      }

      const missedByGfm: { index: number; snippet: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!tableRanges.has(i + 1) && line.includes("|") && line.includes("-")) {
          // 检查连续几行是否构成一个候选表格
          const chunk = [];
          for (let j = i; j < Math.min(i + 10, lines.length); j++) {
            chunk.push(lines[j]);
            if (!lines[j].includes("|")) break;
          }
          if (chunk.length >= 2) {
            missedByGfm.push({
              index: missedByGfm.length,
              snippet: chunk.join("\n"),
            });
            i += chunk.length - 1;
          }
        }
      }

      view.destroy();
      return { tables: results, missedByGfm };
    }

    it("诊断结果输出（供人工检查）", () => {
      // 构造一个包含正常和异常表格的测试文档
      const doc = [
        "## 正常表格",
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "## 分隔行某列为纯空格（第1列是空格 trim 后为空）",
        "| a | b |",
        "|     | --- |",
        "| 1 | 2 |",
        "",
        "## 分隔行某列为纯冒号（: 不含 -）",
        "| a | b |",
        "| : | :--- |",
        "| 1 | 2 |",
        "",
        "## 无分隔行（看起来像表格但缺少 --- 行）",
        "| a | b |",
        "| 1 | 2 |",
        "",
        "## 正常表格含对齐",
        "| L | C | R |",
        "| :--- | :---: | ---: |",
        "| a | b | c |",
      ].join("\n");

      const { tables, missedByGfm } = scanDocument(doc);

      console.log(`=== 表格渲染诊断报告 ===`);
      console.log(`GFM 识别到 ${tables.length} 个 Table 节点，${missedByGfm.length} 个候选被 GFM 拒绝\n`);

      let passCount = 0;
      let failCount = 0;

      for (const t of tables) {
        if (t.error) {
          failCount++;
          console.log(`❌ 表格 #${t.index + 1} 渲染失败`);
          console.log(`   源码: ${t.raw.split("\n")[0]}...`);
          console.log(`   原因: ${t.error}\n`);
        } else {
          passCount++;
          console.log(`✅ 表格 #${t.index + 1} 正常渲染`);
        }
      }

      for (const m of missedByGfm) {
        console.log(`⚠️  GFM 拒绝的候选表格 #${m.index + 1}:`);
        console.log(`   ${m.snippet.split("\n")[0]}...`);
        console.log(`   原因: GFM 解析器未生成 Table 节点（分隔行缺失或列数不匹配）\n`);
      }

      console.log(`=== 汇总: ${passCount} 正常, ${failCount} 失败, ${missedByGfm.length} 被 GFM 拒绝 ===`);

      // 验证断言：2 个正常表格 → GFM 有 Table 节点
      // 2 个分隔符非法（空格/纯冒号）→ GFM 直接拒绝 → 无 Table 节点 → 归入 missedByGfm
      expect(tables.length).toBe(2);
      expect(missedByGfm.length).toBe(2); // 空格分隔 + 纯冒号分隔（无分隔行case的启发式未命中，正常）
    });
  });
});
