// @vitest-environment jsdom
// 笔记链接补全（[[ 触发）的单元测试：
// 触发识别、候选过滤排序、代码上下文排除、apply 生成的链接格式。
import { describe, expect, it } from "vitest";
import {
  CompletionContext,
  autocompletion,
  completionStatus,
  startCompletion,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  collectNotes,
  extractWikiTrigger,
  filterNotes,
  noteCompletionSource,
  wikiLinkText,
  type NoteItem,
} from "./noteCompletion";

const NOTES: NoteItem[] = [
  { title: "欢迎使用", path: "/notes/欢迎使用.md" },
  { title: "周报模板", path: "/notes/work/周报模板.md" },
  { title: "Reading List", path: "/notes/work/reading-list.md" },
];

describe("extractWikiTrigger", () => {
  it("识别空查询", () => {
    expect(extractWikiTrigger("[[")).toEqual({ queryFrom: 2, query: "" });
  });

  it("识别行内部分查询", () => {
    expect(extractWikiTrigger("见 [[周")).toEqual({ queryFrom: 4, query: "周" });
  });

  it("普通单括号不触发", () => {
    expect(extractWikiTrigger("[链接")).toBeNull();
    expect(extractWikiTrigger("abc")).toBeNull();
  });

  it("已闭合的方括号不触发", () => {
    expect(extractWikiTrigger("[[a]b")).toBeNull();
  });
});

describe("filterNotes", () => {
  it("空查询返回全部（截断上限内）", () => {
    expect(filterNotes(NOTES, "")).toHaveLength(3);
  });

  it("大小写不敏感，前缀匹配排前", () => {
    const notes: NoteItem[] = [
      { title: "xx reading", path: "/n/xx reading.md" },
      { title: "Reading List", path: "/n/Reading List.md" },
    ];
    const out = filterNotes(notes, "reading");
    expect(out.map((n) => n.title)).toEqual(["Reading List", "xx reading"]);
  });

  it("路径也可命中", () => {
    const out = filterNotes(NOTES, "work");
    expect(out.map((n) => n.title)).toEqual(["周报模板", "Reading List"]);
  });

  it("无命中返回空数组", () => {
    expect(filterNotes(NOTES, "不存在的东西")).toEqual([]);
  });

  it("结果截断到 50 条", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      title: `笔记${i}`,
      path: `/n/${i}.md`,
    }));
    expect(filterNotes(many, "")).toHaveLength(50);
  });
});

describe("collectNotes", () => {
  it("递归收集 .md 文件并去掉扩展名", () => {
    const tree = [
      {
        name: "work",
        path: "/notes/work",
        isDir: true,
        children: [
          {
            name: "周报.md",
            path: "/notes/work/周报.md",
            isDir: false,
            children: [],
          },
          { name: "pic.png", path: "/notes/work/pic.png", isDir: false, children: [] },
        ],
      },
      { name: "首页.md", path: "/notes/首页.md", isDir: false, children: [] },
    ];
    expect(collectNotes(tree)).toEqual([
      { title: "周报", path: "/notes/work/周报.md" },
      { title: "首页", path: "/notes/首页.md" },
    ]);
  });
});

describe("wikiLinkText", () => {
  it("同目录生成直接相对路径", () => {
    expect(
      wikiLinkText(
        { title: "Reading List", path: "/notes/work/reading-list.md" },
        "/notes/work",
      ),
    ).toBe("[Reading List](<reading-list.md>)");
  });

  it("跨目录补 ../ 前缀", () => {
    expect(
      wikiLinkText({ title: "Old", path: "/notes/archive/old.md" }, "/notes/work"),
    ).toBe("[Old](<../archive/old.md>)");
  });
});

describe("noteCompletionSource", () => {
  function runSource(doc: string, pos: number, noteDir = "/notes") {
    const view = new EditorView({
      doc,
      parent: document.body,
      extensions: [markdown()],
    });
    const source = noteCompletionSource(NOTES, noteDir);
    // 本源是同步实现，直接收窄类型（CompletionSource 签名允许返回 Promise）
    const result = source(
      new CompletionContext(view.state, pos, false),
    ) as CompletionResult | null;
    return { view, result };
  }

  it("[[ 触发并返回全部候选", () => {
    const { view, result } = runSource("[[", 2);
    expect(result).not.toBeNull();
    expect(result!.from).toBe(2);
    expect(result!.options).toHaveLength(3);
    view.destroy();
  });

  it("按查询过滤候选", () => {
    const { view, result } = runSource("[[周", 3);
    expect(result!.options.map((o) => o.label)).toEqual(["周报模板"]);
    view.destroy();
  });

  it("单个 [ 与普通文本不触发", () => {
    for (const [doc, pos] of [
      ["[", 1],
      ["hello", 5],
      ["[a](", 4],
    ] as const) {
      const { view, result } = runSource(doc, pos);
      expect(result).toBeNull();
      view.destroy();
    }
  });

  it("围栏代码块内不触发", () => {
    const doc = "```\n[[\n```";
    const { view, result } = runSource(doc, 6);
    expect(result).toBeNull();
    view.destroy();
  });

  it("行内代码内不触发", () => {
    const { view, result } = runSource("`[[`", 3);
    expect(result).toBeNull();
    view.destroy();
  });

  it("apply 替换 [[query 为标准 Markdown 链接", () => {
    const doc = "见 [[周";
    const pos = doc.length;
    const { view, result } = runSource(doc, pos);
    const option = result!.options[0];
    const apply = option.apply;
    expect(typeof apply).toBe("function");
    (apply as (...args: unknown[]) => void)(
      view,
      option,
      result!.from,
      pos,
    );
    // 中文路径按应用惯例 percent-encode（同「复制为 Markdown 链接」）
    expect(view.state.doc.toString()).toBe(
      `见 [周报模板](<work/${encodeURI("周报模板")}.md>)`,
    );
    // 光标落在插入文本末尾
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    view.destroy();
  });

  it("detail 显示相对目录，根目录笔记无 detail", () => {
    const { view, result } = runSource("[[", 2);
    const byLabel = Object.fromEntries(
      result!.options.map((o) => [o.label, o.detail]),
    );
    expect(byLabel["周报模板"]).toBe("work");
    expect(byLabel["欢迎使用"]).toBeUndefined();
    view.destroy();
  });

  it("挂在 markdownLanguage.data 上时 autocompletion 能弹出（同 Editor.tsx 接线方式）", async () => {
    const view = new EditorView({
      doc: "[[",
      selection: { anchor: 2 },
      parent: document.body,
      extensions: [
        markdown(),
        markdownLanguage.data.of({
          autocomplete: noteCompletionSource(NOTES, "/notes"),
        }),
        autocompletion(),
      ],
    });
    startCompletion(view);
    // 补全结果经 promise 异步落回状态，等一个宏任务
    await new Promise((r) => setTimeout(r, 50));
    expect(completionStatus(view.state)).toBe("active");
    view.destroy();
  });
});
