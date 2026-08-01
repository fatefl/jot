// 协议弹窗链接 href 归一化的单元测试：相对资源路径（./、前导 /、%XX 编码）
// 都应归一为纯文件名，命中内置协议文档表；外部链接不受影响。
import { describe, expect, it } from "vitest";
import { resourceDocNameFromHref } from "./Onboarding";

describe("resourceDocNameFromHref", () => {
  it("纯文件名原样保留", () => {
    expect(resourceDocNameFromHref("隐私政策.md")).toBe("隐私政策.md");
  });

  it("剥掉 ./ 前缀", () => {
    expect(resourceDocNameFromHref("./隐私政策.md")).toBe("隐私政策.md");
  });

  it("剥掉前导 /", () => {
    expect(resourceDocNameFromHref("/用户协议.md")).toBe("用户协议.md");
  });

  it("百分号编码解码后取文件名", () => {
    expect(resourceDocNameFromHref("%E9%9A%90%E7%A7%81%E6%94%BF%E7%AD%96.md")).toBe(
      "隐私政策.md",
    );
  });

  it("外部链接不影响：取到的不是内置文档名", () => {
    expect(resourceDocNameFromHref("https://apidata.cc")).toBe("apidata.cc");
    // mailto 无 `/`，取 basename 即整串，仍不会命中内置文档表
    expect(resourceDocNameFromHref("mailto:hi@apidata.cc")).toBe(
      "mailto:hi@apidata.cc",
    );
  });

  it("非法 %XX 编码不抛错，退化为取 basename", () => {
    expect(resourceDocNameFromHref("%E0%E4%E8/用户协议.md")).toBe("用户协议.md");
  });
});
