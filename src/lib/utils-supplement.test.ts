// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cn, countWords, stripMdExtension, relativePath } from "./utils";

describe("cn (className 合并)", () => {
  it("合并单个类名", () => {
    expect(cn("foo")).toBe("foo");
  });

  it("合并多个类名", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("条件合并", () => {
    expect(cn("base", false && "hidden", "extra")).toBe("base extra");
  });

  it("Tailwind 冲突去重", () => {
    const result = cn("px-4", "px-3");
    expect(result).toBe("px-3");
  });

  it("空输入返回空字符串", () => {
    expect(cn("")).toBe("");
    expect(cn()).toBe("");
  });
});

describe("countWords 补充", () => {
  it("纯英文标点按空白分词各自计数", () => {
    // "..."、 "---"、"***" 各算一个 token
    expect(countWords("... --- ***")).toBe(3);
  });

  it("全角标点连续无空格，整体算一个词", () => {
    // ，。！？都在 CJK regex 范围外，走拉丁路径。连续无空格 → 一个 token
    expect(countWords("，。！？")).toBe(1);
  });

  it("日文假名不在 CJK regex 范围内，按拉丁分词", () => {
    // あいうえお → U+3040 block（Hiragana），不在 CJK regex 范围
    // 没有空格分隔 → 整个算一个词
    expect(countWords("あいうえお")).toBe(1);
  });

  it("中文和全角标点混合", () => {
    // 你好世界=4 CJK + ，！=2 非 CJK token = 6
    expect(countWords("你好，世界！")).toBe(6);
  });

  it("数字按拉丁分词", () => {
    expect(countWords("123 456")).toBe(2);
  });

  it("URL 不算多个词", () => {
    expect(countWords("https://example.com/path")).toBe(1);
  });

  it("单字符单词", () => {
    expect(countWords("a b c")).toBe(3);
  });
});

describe("stripMdExtension 补充", () => {
  it("大小写敏感：仅去掉小写 .md", () => {
    // endsWith 是大小写敏感的，所以 .MD 不去掉
    expect(stripMdExtension("NOTE.MD")).toBe("NOTE.MD");
  });

  it(".md 在中间不去掉", () => {
    expect(stripMdExtension("a.md.file")).toBe("a.md.file");
  });

  it("只有 .md 返回空串", () => {
    expect(stripMdExtension(".md")).toBe("");
  });

  it("路径格式也不影响", () => {
    expect(stripMdExtension("/path/to/note.md")).toBe("/path/to/note");
  });

  it("混合大小写", () => {
    expect(stripMdExtension("Note.md")).toBe("Note");
  });
});

describe("relativePath 补充", () => {
  it("根目录下同级文件", () => {
    expect(relativePath("/", "/a.md")).toBe("a.md");
  });

  it("多级向上", () => {
    expect(relativePath("/a/b/c/d", "/a/e.md")).toBe("../../../e.md");
  });

  it("目标在深处", () => {
    expect(relativePath("/a", "/a/b/c/d.md")).toBe("b/c/d.md");
  });

  it("空路径段不受影响", () => {
    expect(relativePath("/a/b", "/a/b/c.md")).toBe("c.md");
  });
});
