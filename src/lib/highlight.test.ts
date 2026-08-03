// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { scanHighlights } from "./highlight";

describe("scanHighlights", () => {
  it("默认色 ==文字==", () => {
    expect(scanHighlights("a ==重点== b")).toEqual([
      { start: 2, end: 8, tokenText: null, color: null },
    ]);
  });

  it("中文命名色 =={红}…==", () => {
    expect(scanHighlights("=={红}重要==")).toEqual([
      { start: 0, end: 9, tokenText: "{红}", color: "red" },
    ]);
  });

  it("英文别名 {red} 与缩写 {r}", () => {
    expect(scanHighlights("=={red}重要==")[0].color).toBe("red");
    expect(scanHighlights("=={r}重要==")[0].color).toBe("red");
    expect(scanHighlights("=={p}重要==")[0].color).toBe("purple");
  });

  it("未知 token 保留字面、按默认色处理", () => {
    expect(scanHighlights("=={xyz}内容==")).toEqual([
      { start: 0, end: 11, tokenText: "{xyz}", color: null },
    ]);
  });

  it("空括号按字面", () => {
    expect(scanHighlights("=={}内容==")[0]).toMatchObject({
      tokenText: "{}",
      color: null,
    });
  });

  it("非贪婪：内层先闭合", () => {
    const ms = scanHighlights("==a ==b== c==");
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ start: 0, end: 6 });
    expect(ms[1]).toMatchObject({ start: 7, end: 13 });
  });

  it("内容允许跨行（段落内）", () => {
    expect(scanHighlights("==第一行\n第二行==")).toHaveLength(1);
  });

  it("无闭合 == 不匹配", () => {
    expect(scanHighlights("==未闭合")).toHaveLength(0);
    expect(scanHighlights("未开启==")).toHaveLength(0);
  });
});
