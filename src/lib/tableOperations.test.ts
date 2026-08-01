// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  addRow,
  deleteRow,
  addColumn,
  deleteColumn,
  cycleAlign,
  setAlign,
  deleteTable,
  swapRows,
  swapColumns,
  tableTemplate,
} from "./tableOperations";

// 标准 3 列 × 2 数据行测试表格
const SRC = [
  "| 名称 | 值 | 说明 |",
  "| :--- | ---: | :---: |",
  "| a | 1 | **粗** |",
  "| b | 2 | 尾 |",
].join("\n");

describe("addRow", () => {
  it("表头上方插入忽略", () => {
    // above 表头无意义，应返回原表（往返后等价）
    const out = addRow(SRC, 0, "above");
    expect(out).not.toBeNull();
    // 行数不变
    expect(out!.split("\n").length).toBe(SRC.split("\n").length);
  });

  it("表头下方插入（below 表头）", () => {
    const out = addRow(SRC, 0, "below");
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    // 表头、分隔行、新空行、原有数据行…
    expect(lines.length).toBe(5);
    // 新行应在分隔行之后、第一个数据行之前
    expect(lines[2]).toContain("|  |  |  |");
    expect(lines[2]).not.toContain("---"); // 不是分隔行
  });

  it("数据行上方插入", () => {
    const out = addRow(SRC, 1, "above");
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    expect(lines.length).toBe(5);
    // 新行在 rowIdx=1 (第一行数据)之前 → 位置索引 2
    expect(lines[2]).toContain("|  |  |  |");
  });

  it("数据行下方插入", () => {
    const out = addRow(SRC, 1, "below");
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    expect(lines.length).toBe(5);
    expect(lines[3]).toContain("|  |  |  |");
  });

  it("非法表格返回 null", () => {
    expect(addRow("不是表格", 0, "below")).toBeNull();
  });
});

describe("deleteRow", () => {
  it("删除数据行", () => {
    const out = deleteRow(SRC, 1);
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    expect(lines.length).toBe(3); // 表头+分隔+1数据行
  });

  it("拒绝删除表头行", () => {
    expect(deleteRow(SRC, 0)).toBeNull();
  });

  it("拒绝删除最后一行数据", () => {
    const one = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(deleteRow(one, 1)).toBeNull();
  });
});

describe("addColumn", () => {
  it("左侧插入列", () => {
    const out = addColumn(SRC, 0, "left");
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    // 表头应多一列在前面
    expect(lines[0]).toMatch(/^\|  \|/);
    // 对齐也应多一列
    expect(lines[1]).toMatch(/^\| --- \|/);
  });

  it("右侧插入列", () => {
    const out = addColumn(SRC, 2, "right");
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    expect(lines[0]).toMatch(/\|  \|$/);
  });

  it("非法表格返回 null", () => {
    expect(addColumn("不是表格", 0, "left")).toBeNull();
  });
});

describe("deleteColumn", () => {
  it("删除中间列", () => {
    const out = deleteColumn(SRC, 1);
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    expect(lines[0]).toBe("| 名称 | 说明 |");
  });

  it("拒绝删除唯一的列", () => {
    const one = "| a |\n| --- |\n| 1 |";
    expect(deleteColumn(one, 0)).toBeNull();
  });

  it("非法索引返回 null", () => {
    expect(deleteColumn(SRC, 99)).toBeNull();
  });
});

describe("cycleAlign", () => {
  it("null → left", () => {
    // 第一列已有 :--- (left)，第二列 ---: (right)，第三列 :---: (center)
    // 用一个新的无对齐列测试
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const out = cycleAlign(src, 0);
    expect(out).not.toBeNull();
    expect(out!.split("\n")[1]).toContain(":---");
  });

  it("循环四阶段", () => {
    const src = "| a |\n| --- |\n| 1 |";
    const s1 = cycleAlign(src, 0)!;
    expect(s1.split("\n")[1]).toBe("| :--- |"); // null→left
    const s2 = cycleAlign(s1, 0)!;
    expect(s2.split("\n")[1]).toBe("| :---: |"); // left→center
    const s3 = cycleAlign(s2, 0)!;
    expect(s3.split("\n")[1]).toBe("| ---: |"); // center→right
    const s4 = cycleAlign(s3, 0)!;
    expect(s4.split("\n")[1]).toBe("| --- |"); // right→null
  });
});

describe("setAlign", () => {
  it("设置左对齐", () => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const out = setAlign(src, 0, "left");
    expect(out!.split("\n")[1]).toContain(":---");
  });

  it("设置居中", () => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const out = setAlign(src, 1, "center");
    expect(out!.split("\n")[1]).toContain(":---:");
  });
});

describe("deleteTable", () => {
  it("返回空字符串", () => {
    expect(deleteTable(SRC)).toBe("");
  });
});

describe("swapRows", () => {
  it("交换两数据行", () => {
    const out = swapRows(SRC, 1, 2);
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    expect(lines[2]).toContain("b");
    expect(lines[3]).toContain("a");
  });

  it("拒绝交换表头", () => {
    expect(swapRows(SRC, 0, 1)).toBeNull();
  });
});

describe("swapColumns", () => {
  it("交换两列", () => {
    const out = swapColumns(SRC, 0, 2);
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    expect(lines[0]).toBe("| 说明 | 值 | 名称 |");
    expect(lines[1]).toBe("| :---: | ---: | :--- |");
  });

  it("非法索引返回 null", () => {
    expect(swapColumns(SRC, 0, 99)).toBeNull();
  });
});

describe("tableTemplate", () => {
  it("生成 3 列表格", () => {
    const t = tableTemplate();
    expect(t).toContain("列 1");
    expect(t).toContain("列 2");
    expect(t).toContain("列 3");
    expect(t).toContain("|------|------|------|");
  });
});
