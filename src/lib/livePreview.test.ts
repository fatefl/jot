// @vitest-environment jsdom
// livePreview 装饰构建的冒烟测试：用真实笔记文档实例化 EditorView，
// 任何装饰冲突（重叠替换/非法区间）都会在构造时抛错——
// 这类错误在生产环境就是"页面白了"的根因。
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { livePreview, setHtmlBadgeClickHandler } from "./livePreview";

const SAMPLE = `# 标题一
## 标题二
正文 **加粗** *斜体* ~~删除线~~ \`行内代码\` 混合 **粗中有 *斜* 体**。

> 引用第一行
> 引用第二行 **加粗**

---

- 无序列表项
- [ ] 任务一
- [x] 任务二

1. 有序一
2. 有序二

\`\`\`json
{ "a": 1 }
\`\`\`

| 名称 | 值 | 说明 |
| :--- | ---: | :-: |
| a | 1 | **粗** |
| b | \`code\` | [链接](https://example.com) |

[普通链接](https://example.com) 和 ![图片](.assets/pic.png)

> # 引用里的标题
> \`\`\`js
> const x = 1;
> \`\`\`

Setext 标题
===========

结尾无换行`;

function buildView(doc: string) {
  return new EditorView({
    doc,
    parent: document.body,
    extensions: [
      // 与 Editor.tsx 保持一致：base 为 GFM 版 markdownLanguage
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      livePreview({ assetBase: "/tmp/notes" }),
      EditorView.lineWrapping,
    ],
  });
}

/** 收集语法树中出现过的节点名 */
function nodeNames(view: EditorView): Set<string> {
  const names = new Set<string>();
  syntaxTree(view.state).iterate({
    enter(node) {
      names.add(node.name);
    },
  });
  return names;
}

describe("livePreview 装饰构建", () => {
  it("典型 markdown 全要素文档不抛错", () => {
    const view = buildView(SAMPLE);
    // 强制一次完整更新（触发视口内装饰计算）
    view.dispatch({});
    view.destroy();
  });

  it("真实笔记文档不抛错", () => {
    const path = join(homedir(), "Notes", "欢迎使用.md");
    if (!existsSync(path)) return; // 本地样本不存在时跳过
    const doc = readFileSync(path, "utf-8");
    const view = buildView(doc);
    view.dispatch({});
    view.destroy();
  });

  it("编辑操作后重建不抛错", () => {
    const view = buildView(SAMPLE);
    // 在表格中间插入一行、删除标题标记等
    view.dispatch({ changes: { from: 0, insert: "# " } });
    view.dispatch({ changes: { from: 5, to: 8 } });
    expect(view.state.doc.length).toBeGreaterThan(0);
    view.destroy();
  });

  it("GFM 语法节点真实存在于语法树（表格/删除线/任务列表）", () => {
    // 防止 base 被改回 commonmarkLanguage：装饰代码还在但
    // 解析器不产生节点，表现为"表格等样式全部不显示"且无报错
    const view = buildView(SAMPLE);
    const names = nodeNames(view);
    expect(names.has("Table")).toBe(true);
    expect(names.has("Strikethrough")).toBe(true);
    expect(names.has("TaskMarker")).toBe(true);
    view.destroy();
  });

  it("GFM 装饰真实渲染到 DOM（表格/勾选框/删除线）", () => {
    const view = buildView(SAMPLE);
    expect(view.dom.querySelector("table.lp-table")).not.toBeNull();
    expect(view.dom.querySelector("input.lp-checkbox")).not.toBeNull();
    expect(view.dom.querySelector(".lp-strike")).not.toBeNull();
    view.destroy();
  });
});

describe("tableField 语法树更新后重建（回归修复）", () => {
  it("200 行前缀 + 末尾表格：ensureSyntaxTree 保证完整解析后表格可渲染", () => {
    // 构造长文档，表格在 200 行之后（超出初始 ~3000 字符解析窗口）。
    // 冷开只扫已解析区间，表格由树推进（longDocParsePlugin 后台分片）补齐——
    // 这里显式驱动 parseWorker 的取树动作（ensureSyntaxTree 到全文 + 空事务），
    // 验证 tableField 的树推进增量路径能补上 frontier 外的 Table 节点。
    const prefix: string[] = [];
    for (let i = 0; i < 200; i++) {
      prefix.push(`段落 ${i}: 这是一些填充文本内容用于测试表格渲染。`);
    }
    prefix.push("");
    prefix.push("| 名称 | 值 | 说明 |");
    prefix.push("| :--- | ---: | :-: |");
    prefix.push("| 测试 | 123 | 这是一条说明 |");
    prefix.push("| 项目 | 456 | 另一条 |");

    const view = new EditorView({
      doc: prefix.join("\n"),
      parent: document.body,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/test" }),
        EditorView.lineWrapping,
      ],
    });

    // 强制全文解析 + 空事务让树推进被字段拾取（等价于 longDocParsePlugin 完成帧）
    let tree = syntaxTree(view.state);
    while (tree.topNode.to < view.state.doc.length) {
      tree = ensureSyntaxTree(view.state, view.state.doc.length, 200) ?? tree;
    }
    view.dispatch({});

    // block widget 仅在视口内渲染 DOM，先滚动到文档末尾
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length) });
    view.dispatch({});

    // 核心断言：表格已渲染为 HTML table
    const table = view.dom.querySelector("table.lp-table");
    expect(table).not.toBeNull();

    view.destroy();
  });
});

describe("HTML 占位徽标", () => {
  it("HTML 块塌缩为块级徽标：源码隐藏、hover 提示、标签名为徽标文案", () => {
    const view = buildView("<div>\n  <p>块级 HTML</p>\n</div>\n");
    const badge = view.dom.querySelector<HTMLElement>(
      ".lp-html-badge.lp-html-badge-block",
    );
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("div");
    // 源码不在可见文本里
    expect(view.dom.textContent).not.toContain("<div>");
    expect(view.dom.textContent).not.toContain("块级 HTML");
    // tooltip 含完整源码
    expect(badge!.title).toContain("<div>");
    expect(badge!.title).toContain("</div>");
    view.destroy();
  });

  it("内联 HTML 标签原位替换为徽标，其余文本可见", () => {
    const view = buildView('这是 <span class="x">行内</span> HTML<br>换行\n');
    const badges = view.dom.querySelectorAll<HTMLElement>(".lp-html-badge");
    expect(badges.length).toBe(3); // <span> </span> <br>
    expect(badges[0].textContent).toBe("span");
    expect(badges[1].textContent).toBe("/span");
    expect(badges[2].textContent).toBe("br");
    expect(view.dom.textContent).toContain("行内");
    expect(view.dom.textContent).toContain("换行");
    view.destroy();
  });

  it("内联注释显示「注释」徽标", () => {
    const view = buildView("正文 <!-- 隐藏注释 --> 继续\n");
    const badge = view.dom.querySelector<HTMLElement>(".lp-html-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("注释");
    expect(view.dom.textContent).toContain("正文");
    view.destroy();
  });

  it("跨行注释块塌缩为「注释」徽标", () => {
    const view = buildView("<!-- 注释\n跨行 -->\n");
    const badge = view.dom.querySelector<HTMLElement>(".lp-html-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("注释");
    expect(view.dom.textContent).not.toContain("跨行");
    view.destroy();
  });

  it("HTML 实体仍解码显示（不受徽标改动影响）", () => {
    const view = buildView("价格 &lt; 100\n");
    expect(view.dom.textContent).toContain("<");
    expect(view.dom.querySelector(".lp-html-badge")).toBeNull();
    view.destroy();
  });

  it("点击徽标触发注入回调并携带源码位置", () => {
    let hit: { from: number; line: number } | null = null;
    setHtmlBadgeClickHandler((from, line) => {
      hit = { from, line };
    });
    const view = buildView("段落一\n\n<div>\n  内容\n</div>\n");
    const badge = view.dom.querySelector<HTMLElement>(".lp-html-badge")!;
    badge.click();
    expect(hit).not.toBeNull();
    // HTMLBlock 从第 3 行开始
    expect(hit!.line).toBe(3);
    expect(view.state.sliceDoc(hit!.from, hit!.from + 5)).toBe("<div>");
    setHtmlBadgeClickHandler(null);
    view.destroy();
  });
});
