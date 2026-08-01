// @vitest-environment jsdom
/**
 * Mermaid 渲染超时兜底测试
 * mermaid 渲染挂起（懒加载图表 chunk 卡住 / 渲染器不返回）时，应在超时后显示
 * 错误态，而不是永久停在"渲染中"占位符。这里 mock 掉 mermaid 的 render 使其
 * 永不 settle，验证超时路径生效。
 */
import { describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { livePreview } from "./livePreview";

// 永不 resolve / reject 的 render：模拟 mermaid 渲染挂起
vi.mock("mermaid", () => ({
  default: {
    mermaidAPI: {
      render: () => new Promise(() => {}),
    },
    initialize: () => {},
  },
}));

const MERMAID_DOC = [
  "```mermaid",
  "graph LR",
  "  A-->B",
  "```",
].join("\n");

// 与 livePreview.ts 中 MERMAID_RENDER_TIMEOUT 对齐
const RENDER_TIMEOUT_MS = 15_000;

describe("Mermaid 渲染超时兜底", () => {
  it("渲染挂起时超时后显示错误态，而非永久停留在渲染中", async () => {
    vi.useFakeTimers();
    const div = document.createElement("div");
    div.classList.add("editor-body");
    document.body.appendChild(div);
    const view = new EditorView({
      doc: MERMAID_DOC,
      parent: div,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        livePreview({ assetBase: "/tmp/notes" }),
      ],
    });
    view.dispatch({});

    // 等微任务/0ms 定时器：让 loadMermaid 的 import 与 then 回调执行（已进入挂起的 render）
    await vi.advanceTimersByTimeAsync(50);

    const inner = div.querySelector<HTMLElement>(".lp-mermaid-inner")!;
    expect(inner).not.toBeNull();
    expect(inner.textContent).toBe("图表渲染中…");

    // 推进超过超时时长：应切换到错误态
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + 100);
    expect(inner.textContent).toBe("图表渲染超时");

    vi.useRealTimers();
    view.destroy();
    document.body.innerHTML = "";
  });
});
