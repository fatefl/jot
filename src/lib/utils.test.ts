import { describe, expect, it } from "vitest";
import { countWords, relativePath, resolveLinkPath, normalizeTree, stripMdExtension } from "./utils";

describe("countWords", () => {
  it("空字符串和纯空白都是 0", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  \n\t  ")).toBe(0);
  });

  it("CJK 字符逐字计数", () => {
    expect(countWords("你好世界")).toBe(4);
  });

  it("拉丁文按空白分词", () => {
    expect(countWords("hello world")).toBe(2);
    expect(countWords("  multiple   spaces\tand\nnewlines  ")).toBe(4);
  });

  it("中英混排分别计数", () => {
    expect(countWords("用 Markdown 记笔记")).toBe(5); // 4 个汉字 + 1 个单词
  });
});

describe("stripMdExtension", () => {
  it("去掉 .md 后缀", () => {
    expect(stripMdExtension("note.md")).toBe("note");
  });

  it("没有后缀时原样返回", () => {
    expect(stripMdExtension("note")).toBe("note");
    expect(stripMdExtension("note.markdown")).toBe("note.markdown");
  });

  it("只去末尾一个后缀", () => {
    expect(stripMdExtension("a.md.md")).toBe("a.md");
  });
});

describe("relativePath", () => {
  it("同目录直接给文件名", () => {
    expect(relativePath("/notes", "/notes/a.md")).toBe("a.md");
  });

  it("目标是子目录", () => {
    expect(relativePath("/notes", "/notes/assets/img.png")).toBe(
      "assets/img.png",
    );
  });

  it("目标是上级目录，补 ../ 前缀", () => {
    expect(relativePath("/notes/sub", "/notes/a.md")).toBe("../a.md");
  });

  it("分叉到兄弟分支", () => {
    expect(relativePath("/notes/a/b", "/notes/c/d.md")).toBe("../../c/d.md");
  });

  it("根目录为基准", () => {
    expect(relativePath("/", "/notes/a.md")).toBe("notes/a.md");
  });

  it(".assets 子目录：正确处理点号前缀", () => {
    expect(relativePath("/notes", "/notes/.assets/img.png")).toBe(".assets/img.png");
  });

  it("子目录笔记引用 .assets：需 ../ 前缀", () => {
    expect(relativePath("/notes/sub", "/notes/.assets/img.png")).toBe("../.assets/img.png");
  });

  it("中文文件名：不编码直接返回原始中文路径", () => {
    expect(relativePath("/notes", "/notes/.assets/图片1.png")).toBe(".assets/图片1.png");
  });

  it("Windows 反斜杠输入归一为 / 分隔", () => {
    expect(relativePath("C:\\notes\\sub", "C:\\notes\\a.md")).toBe("../a.md");
    expect(relativePath("C:\\notes", "C:\\notes\\.assets\\img.png")).toBe(".assets/img.png");
  });
});

describe("resolveLinkPath", () => {
  it("同目录相对路径", () => {
    expect(resolveLinkPath("/notes/sub", "a.md")).toBe("/notes/sub/a.md");
  });

  it("上级目录 ../ 逐层回退", () => {
    expect(resolveLinkPath("/notes/a/b", "../../c.md")).toBe("/notes/c.md");
  });

  it("./ 前缀直接去掉", () => {
    expect(resolveLinkPath("/notes", "./sub/a.md")).toBe("/notes/sub/a.md");
  });

  it("绝对路径原样规范化", () => {
    expect(resolveLinkPath("/notes", "/etc/../tmp/a.pdf")).toBe("/tmp/a.pdf");
  });

  it("percent-encoded 路径先解码", () => {
    expect(resolveLinkPath("/notes", "%E5%9B%BE%E7%89%87/a%20b.md")).toBe(
      "/notes/图片/a b.md",
    );
  });

  it("超出根目录的 ../ 被截断", () => {
    expect(resolveLinkPath("/notes", "../../../a.md")).toBe("/a.md");
  });

  it("Windows 反斜杠 baseDir 归一为 / 分隔", () => {
    expect(resolveLinkPath("C:\\notes\\sub", "a.md")).toBe("/C:/notes/sub/a.md");
    expect(resolveLinkPath("C:\\notes\\sub", "..\\a.md")).toBe("/C:/notes/a.md");
  });
});

describe("normalizeTree", () => {
  it("深度归一化反斜杠路径", () => {
    const t = normalizeTree({
      name: "notes", path: "C:\\notes", isDir: true, children: [
        { name: "a.md", path: "C:\\notes\\a.md", isDir: false, children: [] },
        { name: "sub", path: "C:\\notes\\sub", isDir: true, children: [
          { name: "b.md", path: "C:\\notes\\sub\\b.md", isDir: false, children: [] },
        ]},
      ],
    });
    expect(t.path).toBe("C:/notes");
    expect(t.children[0].path).toBe("C:/notes/a.md");
    expect(t.children[1].children[0].path).toBe("C:/notes/sub/b.md");
  });

  it("无 path 字段的节点不崩溃（防御）", () => {
    const t = normalizeTree<{ path?: string; children: never[] }>({ children: [] });
    expect(t.path).toBeUndefined();
    expect(t.children).toEqual([]);
  });
});
