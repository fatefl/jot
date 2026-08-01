import { describe, expect, it } from "vitest";
import { isExternalPath } from "./utils";

describe("isExternalPath", () => {
  it("notesDir 内的文件是内部", () => {
    expect(isExternalPath("/notes/a.md", "/notes")).toBe(false);
    expect(isExternalPath("/notes/sub/b.md", "/notes")).toBe(false);
    expect(isExternalPath("/notes/子目录/笔记.md", "/notes")).toBe(false);
  });

  it("notesDir 外的文件是外部", () => {
    expect(isExternalPath("/tmp/x.md", "/notes")).toBe(true);
    expect(isExternalPath("/home/u/Desktop/readme.md", "/notes")).toBe(true);
  });

  it("前缀相同但非子路径也算外部（/notes2 不命中 /notes）", () => {
    // 用 notesDir + "/" 判断，避免 /notes2 /notesback 误判为内部
    expect(isExternalPath("/notes2/x.md", "/notes")).toBe(true);
    expect(isExternalPath("/notesback/y.md", "/notes")).toBe(true);
    expect(isExternalPath("/notes.txt", "/notes")).toBe(true);
  });

  it("notesDir 为空时全部视为外部", () => {
    expect(isExternalPath("/notes/a.md", null)).toBe(true);
    expect(isExternalPath("/notes/a.md", undefined)).toBe(true);
    expect(isExternalPath("/notes/a.md", "")).toBe(true);
  });

  it("Windows 反斜杠路径：统一分隔符后正确判断（与当前平台无关）", () => {
    // 修复前 `notesDir + "/"` 用正斜杠拼接，永远匹配不上反斜杠路径 → 内部文件被误判外部
    expect(isExternalPath("C:\\notes\\a.md", "C:\\notes")).toBe(false);
    expect(isExternalPath("C:\\notes\\sub\\b.md", "C:\\notes")).toBe(false);
    expect(isExternalPath("C:\\tmp\\x.md", "C:\\notes")).toBe(true);
    // 同名前缀但非子路径
    expect(isExternalPath("C:\\notes2\\x.md", "C:\\notes")).toBe(true);
    expect(isExternalPath("C:\\notesback\\y.md", "C:\\notes")).toBe(true);
    // notesDir 尾部带反斜杠 / 混合分隔符
    expect(isExternalPath("C:\\notes\\a.md", "C:\\notes\\")).toBe(false);
    expect(isExternalPath("C:/notes/a.md", "C:\\notes")).toBe(false);
    expect(isExternalPath("C:\\notes\\a.md", "C:/notes")).toBe(false);
  });
});
