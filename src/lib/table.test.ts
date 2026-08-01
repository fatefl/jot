// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { splitRow, parseTable, buildTableMarkdown } from "./livePreview";

describe("splitRow", () => {
  it("基本切分", () => {
    expect(splitRow("| a | b | c |")).toEqual(["a", "b", "c"]);
  });

  it("转义管道符不切列", () => {
    expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("空单元格", () => {
    expect(splitRow("| a || c |")).toEqual(["a", "", "c"]);
  });
});

describe("表格 markdown 往返", () => {
  const raw = [
    "| 名称 | 值 | 说明 |",
    "| :--- | ---: | :-: |",
    "| a | 1 | **粗** |",
    "| b | `x | y` | 尾 |",
  ].join("\n");

  it("parse → build 保持内容（含对齐与转义）", () => {
    const data = parseTable(raw);
    expect(data).not.toBeNull();
    const out = buildTableMarkdown(data!);
    // 重新解析后数据一致（布局空白允许差异）
    expect(parseTable(out)).toEqual(data);
  });

  it("buildTableMarkdown 生成对齐分隔符", () => {
    const data = parseTable(raw)!;
    const out = buildTableMarkdown(data);
    expect(out.split("\n")[1]).toBe("| :--- | ---: | :---: |");
  });

  it("编辑后含 | 的单元格被转义", () => {
    const data = parseTable("| a | b |\n| --- | --- |\n| 1 | 2 |")!;
    data.rows[0][1] = "x | y";
    const out = buildTableMarkdown(data);
    expect(out).toContain("x \\| y");
    expect(parseTable(out)!.rows[0][1]).toBe("x | y");
  });
});
