// src/lib/updateCheck.test.ts
// 版本解析与比较的纯函数单测。
import { describe, expect, it } from "vitest";
import { parseVersion, compareVersions } from "./updateCheck";

describe("parseVersion", () => {
  it("解析 v 前缀", () => {
    expect(parseVersion("v0.1.17")).toEqual({ major: 0, minor: 1, patch: 17 });
  });

  it("解析纯数字", () => {
    expect(parseVersion("0.1.19")).toEqual({ major: 0, minor: 1, patch: 19 });
  });

  it("忽略 pre-release 后缀", () => {
    expect(parseVersion("v0.2.0-beta.1")).toEqual({ major: 0, minor: 2, patch: 0 });
  });

  it("非法输入返回 null", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("0.1")).toBeNull();
    expect(parseVersion("abc")).toBeNull();
    expect(parseVersion("0.1.2.3")).toBeNull();
  });
});

describe("compareVersions", () => {
  const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });

  it("相等返回 0", () => {
    expect(compareVersions(v(0, 1, 19), v(0, 1, 19))).toBe(0);
  });

  it("major 优先", () => {
    expect(compareVersions(v(1, 0, 0), v(0, 99, 99))).toBe(1);
    expect(compareVersions(v(0, 99, 99), v(1, 0, 0))).toBe(-1);
  });

  it("minor 其次", () => {
    expect(compareVersions(v(0, 2, 0), v(0, 1, 99))).toBe(1);
  });

  it("patch 最后（0.1.19 > 0.1.2）", () => {
    expect(compareVersions(v(0, 1, 19), v(0, 1, 2))).toBe(1);
    expect(compareVersions(v(0, 1, 2), v(0, 1, 19))).toBe(-1);
  });
});
