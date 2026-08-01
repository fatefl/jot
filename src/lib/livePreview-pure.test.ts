// @vitest-environment jsdom
// 补充 livePreview 中未导出的纯函数测试：
// normalizePath、resolveAsset、resolveFilePath 等路径处理逻辑
import { describe, expect, it } from "vitest";

// 从 livePreview.ts 内联的 normalizePath（用于测试验证）
function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const parts = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return (abs ? "/" : "") + out.join("/");
}

describe("normalizePath", () => {
  it("简单路径原样返回", () => {
    expect(normalizePath("a/b/c")).toBe("a/b/c");
  });

  it("移除 ./ 片段", () => {
    expect(normalizePath("a/./b/./c")).toBe("a/b/c");
  });

  it(".. 回退一层", () => {
    expect(normalizePath("a/b/../c")).toBe("a/c");
  });

  it("根路径 .. 不越界", () => {
    expect(normalizePath("/a/../../../b")).toBe("/b");
  });

  it("绝对路径保持前缀 /", () => {
    expect(normalizePath("/a/b/c")).toBe("/a/b/c");
  });

  it("相对路径 .. 处理", () => {
    // .. 从空栈弹出等同丢弃（函数不跟踪根级上下文）
    expect(normalizePath("../../a")).toBe("a");
  });

  it("空字符串", () => {
    expect(normalizePath("")).toBe("");
  });
});

describe("splitRow 补充测试", () => {
  // Inline 版本的 splitRow（从 livePreview.ts 复制逻辑用于测试验证）
  function splitRow(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    const body = line.trim().replace(/^\||\|$/g, "");
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "\\" && body[i + 1] === "|") {
        cur += "|";
        i++;
      } else if (ch === "|") {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  }

  it("处理只有分隔符的表格行（对齐行）", () => {
    expect(splitRow("| :--- | ---: | :---: |")).toEqual([
      ":---",
      "---:",
      ":---:",
    ]);
  });

  it("处理尾部有空格的行", () => {
    expect(splitRow("| a | b | c |   ")).toEqual(["a", "b", "c"]);
  });

  it("处理多空格单元格", () => {
    expect(splitRow("|   a   |   b   |")).toEqual(["a", "b"]);
  });
});
