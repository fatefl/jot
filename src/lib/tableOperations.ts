// 表格结构操作纯函数：对 markdown 表格源码进行增删行列、对齐切换等操作。
// 所有函数接收表格原始源码字符串，返回修改后的源码字符串。
// 复用 livePreview.ts 中已导出的 parseTable()、buildTableMarkdown()。
import { parseTable, buildTableMarkdown, splitRow } from "./livePreview";

// ---------- 辅助 ----------

/** 根据对列表生成空单元格行 */
function emptyRow(colCount: number): string[] {
  return Array(colCount).fill("");
}

/** 整表操作：解析 → 变换 → 序列化，失败返回 null */
function transformTable(
  src: string,
  fn: (data: ReturnType<typeof parseTable>) => ReturnType<typeof parseTable> | null,
): string | null {
  const data = parseTable(src);
  if (!data) return null;
  const next = fn(data);
  if (!next) return null;
  return buildTableMarkdown(next);
}

// ---------- 行操作 ----------

/** 在指定行上方或下方插入空行。rowIdx 含表头（0=表头, 1=第一行数据…） */
export function addRow(
  src: string,
  rowIdx: number,
  pos: "above" | "below",
): string | null {
  const data = parseTable(src);
  if (!data) return null;
  const colCount = data.header.length;
  // rowIdx 0=表头, 1+=数据行
  if (rowIdx === 0) {
    // 表头下：在分隔行和数据第一行之间插入
    if (pos === "below") {
      data.rows.splice(0, 0, emptyRow(colCount));
    }
    // above 对表头无意义（无行在表头上方），忽略
  } else {
    const dataIdx = rowIdx - 1; // 转为 data.rows 索引
    const insertIdx = pos === "above" ? dataIdx : dataIdx + 1;
    if (insertIdx >= 0 && insertIdx <= data.rows.length) {
      data.rows.splice(insertIdx, 0, emptyRow(colCount));
    }
  }
  return buildTableMarkdown(data);
}

/** 删除指定行。rowIdx 含表头。若整个表格只剩下 ≤2 行（表头+分隔+≤0 数据行）则拒绝 */
export function deleteRow(
  src: string,
  rowIdx: number,
): string | null {
  const data = parseTable(src);
  if (!data) return null;
  if (rowIdx === 0) return null; // 不能删除表头行
  const dataIdx = rowIdx - 1;
  if (dataIdx < 0 || dataIdx >= data.rows.length) return null;
  if (data.rows.length <= 1) return null; // 至少保留一行数据
  data.rows.splice(dataIdx, 1);
  return buildTableMarkdown(data);
}

// ---------- 列操作 ----------

/** 在指定列左侧或右侧插入空列 */
export function addColumn(
  src: string,
  colIdx: number,
  pos: "left" | "right",
): string | null {
  const data = parseTable(src);
  if (!data) return null;
  const insertIdx = pos === "left" ? colIdx : colIdx + 1;
  if (insertIdx < 0 || insertIdx > data.header.length) return null;

  data.header.splice(insertIdx, 0, "");
  data.aligns.splice(insertIdx, 0, null);
  for (const row of data.rows) {
    row.splice(insertIdx, 0, "");
  }
  return buildTableMarkdown(data);
}

/** 删除指定列。若只有 1 列则拒绝 */
export function deleteColumn(
  src: string,
  colIdx: number,
): string | null {
  const data = parseTable(src);
  if (!data) return null;
  if (data.header.length <= 1) return null; // 至少保留一列
  if (colIdx < 0 || colIdx >= data.header.length) return null;

  data.header.splice(colIdx, 1);
  data.aligns.splice(colIdx, 1);
  for (const row of data.rows) {
    row.splice(colIdx, 1);
  }
  return buildTableMarkdown(data);
}

// ---------- 对齐 ----------

/** 循环切换指定列对齐：null → left → center → right → null */
export function cycleAlign(
  src: string,
  colIdx: number,
): string | null {
  const data = parseTable(src);
  if (!data) return null;
  if (colIdx < 0 || colIdx >= data.aligns.length) return null;

  const order: Array<typeof data.aligns[number]> = [null, "left", "center", "right"];
  const cur = data.aligns[colIdx];
  const idx = order.indexOf(cur); // -1 for anything unrecognized → wraps to 0 (null)
  data.aligns[colIdx] = order[(idx + 1) % order.length];
  return buildTableMarkdown(data);
}

/** 设置指定列对齐 */
export function setAlign(
  src: string,
  colIdx: number,
  align: "left" | "center" | "right" | null,
): string | null {
  const data = parseTable(src);
  if (!data) return null;
  if (colIdx < 0 || colIdx >= data.aligns.length) return null;
  data.aligns[colIdx] = align;
  return buildTableMarkdown(data);
}

// ---------- 整表 ----------

/** 删除整张表格（返回空字符串） */
export function deleteTable(_src: string): string {
  return "";
}

// ---------- 行列交换 ----------

/** 交换两行（rowIdx 含表头）。rowA=0 表示表头 */
export function swapRows(
  src: string,
  rowA: number,
  rowB: number,
): string | null {
  const data = parseTable(src);
  if (!data) return null;
  // 不允许交换表头
  if (rowA === 0 || rowB === 0) return null;
  const a = rowA - 1;
  const b = rowB - 1;
  if (a < 0 || a >= data.rows.length || b < 0 || b >= data.rows.length) return null;
  const tmp = data.rows[a];
  data.rows[a] = data.rows[b];
  data.rows[b] = tmp;
  return buildTableMarkdown(data);
}

/** 交换两列 */
export function swapColumns(
  src: string,
  colA: number,
  colB: number,
): string | null {
  const data = parseTable(src);
  if (!data) return null;
  if (
    colA < 0 || colA >= data.header.length ||
    colB < 0 || colB >= data.header.length
  ) return null;

  // 交换表头
  [data.header[colA], data.header[colB]] = [data.header[colB], data.header[colA]];
  // 交换对齐
  [data.aligns[colA], data.aligns[colB]] = [data.aligns[colB], data.aligns[colA]];
  // 交换数据行
  for (const row of data.rows) {
    [row[colA], row[colB]] = [row[colB], row[colA]];
  }
  return buildTableMarkdown(data);
}

/**
 * 标准 3×3 表格模板（表头 + 分隔行 + 1 数据行）。
 * 末尾带换行，方便插入后光标定位到表格后方。
 */
export function tableTemplate(): string {
  return (
    "\n| 列 1 | 列 2 | 列 3 |\n" +
    "|------|------|------|\n" +
    "|      |      |      |\n"
  );
}
