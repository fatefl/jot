// @vitest-environment jsdom
// 富文本粘贴 → Markdown 转换：isRichHtml 判定 + htmlToMarkdown 清洗/图片落地/转换
import { describe, expect, it, vi, beforeEach } from "vitest";
import { api } from "@/lib/tauri";
import {
  isRichHtml,
  htmlToMarkdown,
  classifyImageSrc,
  sanitizeHtml,
  extractVisibleText,
} from "./htmlToMarkdown";

const saveAsset = vi.fn();
const importFiles = vi.fn();

vi.mock("@/lib/tauri", () => ({
  api: {
    saveAsset: (...args: unknown[]) => saveAsset(...args),
    importFiles: (...args: unknown[]) => importFiles(...args),
  },
}));

const CTX = { notesDir: "/notes", currentFilePath: "/notes/a.md" };

beforeEach(() => {
  saveAsset.mockReset();
  importFiles.mockReset();
});

describe("isRichHtml", () => {
  it("富文本（加粗段落）判定为可转换", () => {
    expect(isRichHtml("<p>Hello <strong>World</strong></p>", "Hello World")).toBe(true);
  });

  it("多块段落：剥标签后的文本与纯文本一致", () => {
    expect(isRichHtml("<p>甲</p><p>乙</p>", "甲\n乙")).toBe(true);
  });

  it("纯文本包装（外层 div）同样可转，内容不损", () => {
    expect(isRichHtml("<div>Hello World</div>", "Hello World")).toBe(true);
  });

  it("复制的代码片段：text/plain 是 HTML 源码 → 排除", () => {
    expect(isRichHtml("<pre><code>&lt;div&gt;foo&lt;/div&gt;</code></pre>", "<div>foo</div>")).toBe(false);
  });

  it("复制的非 HTML 代码块（JS）：可见文本一致 → 可转", () => {
    expect(
      isRichHtml('<pre><code class="language-js"><span>const</span> a = 1</code></pre>', "const a = 1"),
    ).toBe(true);
  });

  it("空 html 或空纯文本 → 不转", () => {
    expect(isRichHtml("", "x")).toBe(false);
    expect(isRichHtml("<p>x</p>", "")).toBe(false);
  });
});

describe("classifyImageSrc", () => {
  it("远程 http(s) URL → 保留", () => {
    expect(classifyImageSrc("https://x.com/pic.png")).toEqual({ kind: "keep" });
    expect(classifyImageSrc("http://x.com/pic.png")).toEqual({ kind: "keep" });
  });

  it("data:image base64 → 解码落地", () => {
    expect(classifyImageSrc("data:image/png;base64,AAAA")).toEqual({
      kind: "dataUri",
      mime: "image/png",
      base64: "AAAA",
    });
  });

  it("非 base64 的 data URI → 丢弃", () => {
    expect(classifyImageSrc("data:image/png,%89PNG")).toEqual({ kind: "drop" });
  });

  it("file:// 路径 → 落地（解码 percent-encoding）", () => {
    expect(classifyImageSrc("file:///Users/me/%E5%9B%BE.png")).toEqual({
      kind: "localFile",
      path: "/Users/me/图.png",
    });
  });

  it("unix/Windows 绝对路径 → 落地", () => {
    expect(classifyImageSrc("/Users/me/pic.png")).toEqual({ kind: "localFile", path: "/Users/me/pic.png" });
    expect(classifyImageSrc("C:\\Users\\me\\pic.png")).toEqual({ kind: "localFile", path: "C:\\Users\\me\\pic.png" });
  });

  it("相对路径无法解析 base → 保留原样", () => {
    expect(classifyImageSrc("./pic.png")).toEqual({ kind: "keep" });
    expect(classifyImageSrc("../img/pic.png")).toEqual({ kind: "keep" });
  });

  it("危险/不可用 scheme → 丢弃", () => {
    expect(classifyImageSrc("javascript:alert(1)")).toEqual({ kind: "drop" });
    expect(classifyImageSrc("blob:https://x/abc")).toEqual({ kind: "drop" });
    expect(classifyImageSrc("")).toEqual({ kind: "drop" });
  });
});

describe("sanitizeHtml", () => {
  it("移除 script/style/iframe 与 on* 事件属性、内联样式", () => {
    const doc = new DOMParser().parseFromString(
      '<p onclick="alert(1)" style="color:red">文本</p><script>evil()</script><iframe src="x"></iframe>',
      "text/html",
    );
    sanitizeHtml(doc.body);
    expect(doc.body.innerHTML).toBe("<p>文本</p>");
  });

  it("javascript: 链接降级为纯文本（去掉 href 保留文字）", () => {
    const doc = new DOMParser().parseFromString(
      '<a href="javascript:alert(1)">点击</a>',
      "text/html",
    );
    sanitizeHtml(doc.body);
    expect(doc.body.innerHTML).toBe("<a>点击</a>");
  });

  it("保留 class 属性（代码语言识别依赖）", () => {
    const doc = new DOMParser().parseFromString(
      '<code class="language-js">const a = 1</code>',
      "text/html",
    );
    sanitizeHtml(doc.body);
    expect(doc.body.innerHTML).toBe('<code class="language-js">const a = 1</code>');
  });
});

describe("extractVisibleText", () => {
  it("块级边界插入换行，避免文字粘连", () => {
    const doc = new DOMParser().parseFromString("<p>甲</p><p>乙</p>", "text/html");
    expect(extractVisibleText(doc.body).replace(/\s+/g, " ").trim()).toBe("甲 乙");
  });
});

describe("htmlToMarkdown", () => {
  it("加粗/链接/标题/列表 → markdown", async () => {
    const html =
      '<h2>标题</h2><p>今天学习了 <strong>CodeMirror</strong> 的 <a href="https://cm.dev">装饰器</a></p><ul><li>甲</li><li>乙</li></ul>';
    const md = await htmlToMarkdown(html, CTX);
    expect(md).toBe(
      "## 标题\n\n今天学习了 **CodeMirror** 的 [装饰器](https://cm.dev)\n\n- 甲\n- 乙",
    );
  });

  it("表格 → GFM 管道表格", async () => {
    const html =
      "<table><tr><th>列A</th><th>列B</th></tr><tr><td>甲</td><td>乙</td></tr></table>";
    const md = await htmlToMarkdown(html, CTX);
    expect(md).toBe("| 列A | 列B |\n| --- | --- |\n| 甲 | 乙 |");
  });

  it("代码块 → fenced + 语言", async () => {
    const html = '<pre><code class="language-ts">const a = 1</code></pre>';
    const md = await htmlToMarkdown(html, CTX);
    expect(md).toBe("```ts\nconst a = 1\n```");
  });

  it("script/事件属性在转换结果中不可见", async () => {
    const html = '<p onclick="evil()">正文</p><script>evil()</script>';
    const md = await htmlToMarkdown(html, CTX);
    expect(md).toBe("正文");
  });

  it("javascript: 链接被降级为纯文本", async () => {
    const md = await htmlToMarkdown('<a href="javascript:alert(1)">点击</a>', CTX);
    expect(md).toBe("点击");
  });

  it("远程图片保留 URL，不触发落盘", async () => {
    const html = '<img src="https://x.com/pic.png" alt="架构图">';
    const md = await htmlToMarkdown(html, CTX);
    expect(md).toBe("![架构图](https://x.com/pic.png)");
    expect(saveAsset).not.toHaveBeenCalled();
  });

  it("data URI 图片 → save_asset 落地并改写为相对引用", async () => {
    saveAsset.mockResolvedValue({ name: "paste-abc.png", path: "/notes/.assets/paste-abc.png" });
    const html = '<img src="data:image/png;base64,aGVsbG8=" alt="图">';
    const md = await htmlToMarkdown(html, CTX);
    // "aGVsbG8=" = "hello"，5 字节：104 101 108 108 111
    expect(saveAsset).toHaveBeenCalledWith("/notes", expect.stringMatching(/^paste-.*\.png$/), [104, 101, 108, 108, 111]);
    expect(md).toBe("![图](.assets/paste-abc.png)");
  });

  it("file:// 本地图片 → import_files 复制到 .assets 并改写相对引用", async () => {
    importFiles.mockResolvedValue({
      imported: [{ name: "pic.png", path: "/notes/.assets/pic.png" }],
      skippedDirs: 0,
    });
    const html = '<img src="file:///Users/me/pic.png" alt="本地图">';
    const md = await htmlToMarkdown(html, CTX);
    expect(importFiles).toHaveBeenCalledWith("/notes", ["/Users/me/pic.png"], true);
    expect(md).toBe("![本地图](.assets/pic.png)");
  });

  it("blob: 等不可用图片被丢弃", async () => {
    const html = '<p>正文</p><img src="blob:https://x/abc" alt="x">';
    const md = await htmlToMarkdown(html, CTX);
    expect(md).toBe("正文");
  });

  it("相对路径图片无 base 可解析 → 保留原样", async () => {
    const html = '<img src="../img/pic.png" alt="x">';
    const md = await htmlToMarkdown(html, CTX);
    expect(md).toBe("![x](../img/pic.png)");
  });
});
