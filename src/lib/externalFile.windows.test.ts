import { describe, expect, it, vi } from "vitest";

// 模拟 Windows 平台：isExternalPath 内部走大小写不敏感分支
vi.mock("@/lib/platform", () => ({
  isWindows: true,
  isMac: false,
  shortcut: (s: string) => s,
}));

import { isExternalPath } from "./utils";

describe("isExternalPath（Windows 平台）", () => {
  it("反斜杠路径：notesDir 内的文件是内部", () => {
    expect(isExternalPath("C:\\Users\\foo\\notes\\a.md", "C:\\Users\\foo\\notes")).toBe(false);
    expect(isExternalPath("C:\\Users\\foo\\notes\\sub\\b.md", "C:\\Users\\foo\\notes")).toBe(false);
  });

  it("大小写不敏感：盘符/目录大小写不同仍判内部", () => {
    expect(isExternalPath("c:\\users\\foo\\notes\\a.md", "C:\\Users\\foo\\notes")).toBe(false);
    expect(isExternalPath("C:\\Users\\Foo\\Notes\\a.md", "C:\\Users\\foo\\notes")).toBe(false);
  });

  it("notesDir 之外仍判外部", () => {
    expect(isExternalPath("D:\\other\\a.md", "C:\\Users\\foo\\notes")).toBe(true);
    expect(isExternalPath("C:\\Users\\foo\\notes2\\a.md", "C:\\Users\\foo\\notes")).toBe(true);
  });
});
