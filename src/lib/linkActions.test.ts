// 链接打开的单元测试：锚点剥离规则、双基准解析、存在性优先选择。
// openLinkTarget 依赖 Tauri api 与全局 store，这里 mock tauri 的 api 方法。
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./tauri", () => ({
  api: {
    fileMtime: vi.fn(async () => 0),
    openInSystem: vi.fn(async () => {}),
    openUrl: vi.fn(async () => {}),
    getResourcePath: vi.fn(async () => ""),
  },
}));

import { api } from "./tauri";
import { linkTargetPath, openLinkTarget, resolveLinkCandidates } from "./linkActions";
import { useAppStore } from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useTabStore } from "../stores/tabStore";

const openFile = () => vi.fn(async () => true);

function setupOpenFile() {
  const mock = openFile();
  useTabStore.setState({ openFile: mock });
  return mock;
}

beforeEach(() => {
  useAppStore.setState({ notesDir: "/notes" });
  useEditorStore.setState({ selectedPath: "/notes/sub/a.md" });
  vi.mocked(api.fileMtime).mockReset().mockResolvedValue(0);
  // mockClear 而非 mockReset：reset 会清掉 async 实现，调用返回 undefined
  vi.mocked(api.openInSystem).mockClear();
  vi.mocked(api.openUrl).mockClear();
  vi.mocked(api.getResourcePath).mockReset().mockResolvedValue("");
});

describe("linkTargetPath 锚点剥离", () => {
  it("裸 URL 剥离 #/?", () => {
    expect(linkTargetPath("b.md#heading", false)).toBe("b.md");
    expect(linkTargetPath("a.md?x=1", false)).toBe("a.md");
  });

  it("尖括号包裹时 #/? 是字面量，保留", () => {
    expect(linkTargetPath("a#b.md", true)).toBe("a#b.md");
    expect(linkTargetPath("a%20b.md?x", true)).toBe("a%20b.md?x");
  });

  it("纯锚点返回空串", () => {
    expect(linkTargetPath("#heading", false)).toBe("");
  });
});

describe("resolveLinkCandidates 双基准", () => {
  it("文件相对优先，仓库根相对兜底", () => {
    expect(resolveLinkCandidates("b.md", "/notes/sub", "/notes")).toEqual([
      "/notes/sub/b.md",
      "/notes/b.md",
    ]);
  });

  it("两个基准解析到同一路径时去重", () => {
    expect(resolveLinkCandidates("a.md", "/notes", "/notes")).toEqual([
      "/notes/a.md",
    ]);
  });

  it("越界路径被过滤", () => {
    expect(resolveLinkCandidates("../../../etc/passwd", "/notes/sub", "/notes")).toEqual([]);
  });

  it("无当前笔记（selectedPath 为空）时只用仓库根相对", () => {
    expect(resolveLinkCandidates("b.md", "", "/notes")).toEqual(["/notes/b.md"]);
  });

  it("percent-encoding 解码后解析", () => {
    expect(resolveLinkCandidates("%E5%9B%BE%E7%89%87/a.md", "/notes", "/notes")).toEqual([
      "/notes/图片/a.md",
    ]);
  });
});

describe("openLinkTarget 双基准打开", () => {
  it("文件相对目标存在时打开文件相对", async () => {
    vi.mocked(api.fileMtime).mockImplementation(async (p) => p === "/notes/b.md" ? 1 : 0);
    const mock = setupOpenFile();
    await openLinkTarget("../b.md");
    expect(mock).toHaveBeenCalledWith(expect.objectContaining({ path: "/notes/b.md" }));
  });

  it("文件相对不存在时兜底到仓库根相对", async () => {
    vi.mocked(api.fileMtime).mockImplementation(async (p) => p === "/notes/b.md" ? 1 : 0);
    const mock = setupOpenFile();
    await openLinkTarget("b.md", { angleWrapped: true });
    expect(mock).toHaveBeenCalledWith(expect.objectContaining({ path: "/notes/b.md" }));
  });

  it("两个基准都存在时优先文件相对", async () => {
    vi.mocked(api.fileMtime).mockImplementation(async (p) =>
      p === "/notes/sub/b.md" ? 123 : p === "/notes/b.md" ? 456 : 0,
    );
    const mock = setupOpenFile();
    await openLinkTarget("b.md", { angleWrapped: true });
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/notes/sub/b.md" }),
    );
  });

  it("尖括号包裹时 # 文件名不被剥离", async () => {
    vi.mocked(api.fileMtime).mockResolvedValue(1);
    const mock = setupOpenFile();
    await openLinkTarget("a#b.md", { angleWrapped: true });
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/notes/sub/a#b.md" }),
    );
  });

  it("裸 URL 剥离锚点后打开", async () => {
    vi.mocked(api.fileMtime).mockResolvedValue(1);
    const mock = setupOpenFile();
    await openLinkTarget("b.md#heading");
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/notes/sub/b.md" }),
    );
  });

  it("越界目标被拦截，不打开", async () => {
    const mock = setupOpenFile();
    await openLinkTarget("../../../etc/passwd");
    expect(mock).not.toHaveBeenCalled();
  });

  it("非 md 附件走系统打开", async () => {
    vi.mocked(api.fileMtime).mockResolvedValue(1);
    await openLinkTarget("a.pdf", { angleWrapped: true });
    expect(api.openInSystem).toHaveBeenCalledWith("/notes/sub/a.pdf");
  });
});

describe("openLinkTarget 内置资源文档互引", () => {
  it("工作区目标不存在时兜底打开打包资源", async () => {
    const resPath = "/app-resources/用户协议.md";
    vi.mocked(api.fileMtime).mockResolvedValue(0); // 双基准候选都不存在
    vi.mocked(api.getResourcePath).mockResolvedValue(resPath);
    // openFile：工作区候选读盘失败(false)，资源路径成功(true)
    const mock = vi.fn(async (node: { path: string }) => node.path === resPath);
    useTabStore.setState({ openFile: mock });
    await openLinkTarget("用户协议.md", { angleWrapped: true });
    // 存在性检查前置，兜底在 await 内完成，无需排空微任务
    expect(mock).toHaveBeenCalledWith(expect.objectContaining({ path: resPath }));
  });

  it("工作区已有同名文件时优先打开工作区文件", async () => {
    vi.mocked(api.fileMtime).mockImplementation(async (p) =>
      p === "/notes/sub/用户协议.md" ? 1 : 0,
    );
    const mock = setupOpenFile();
    await openLinkTarget("用户协议.md", { angleWrapped: true });
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/notes/sub/用户协议.md" }),
    );
  });
});
