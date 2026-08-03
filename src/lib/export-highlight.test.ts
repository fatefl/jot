// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHtml } from "./export";

describe("export — 高亮 =={色}…==", () => {
  it("默认色", async () => {
    const html = await renderHtml("==重点==");
    expect(html).toContain('<mark class="hl-default">重点</mark>');
  });

  it("中文命名色", async () => {
    const html = await renderHtml("=={红}重点==");
    expect(html).toContain('<mark class="hl-red">重点</mark>');
  });

  it("英文别名", async () => {
    const html = await renderHtml("=={red}重点==");
    expect(html).toContain('<mark class="hl-red">重点</mark>');
  });

  it("未知 token 保留字面", async () => {
    const html = await renderHtml("=={xyz}内容==");
    expect(html).toContain('<mark class="hl-default">{xyz}内容</mark>');
  });

  it("行内代码内 == 不受影响", async () => {
    const html = await renderHtml("`==x==`");
    expect(html).toContain("<code>==x==</code>");
    expect(html).not.toContain("<mark");
  });

  it("高亮内可嵌套加粗", async () => {
    const html = await renderHtml("=={蓝}**粗**==");
    expect(html).toContain('<mark class="hl-blue"><strong>粗</strong></mark>');
  });

  it("导出样式包含高亮色", async () => {
    const html = await renderHtml("=={蓝}x==");
    expect(html).toContain("mark.hl-blue");
  });
});
