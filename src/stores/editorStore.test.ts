// src/stores/editorStore.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { useEditorStore } from "./editorStore";
import { api } from "@/lib/tauri";
import { setActiveEditFinalizer } from "@/lib/editorViewCache";

// Mock api
vi.mock("@/lib/tauri", () => ({
  api: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("# test"),
  },
}));

const initial = useEditorStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  setActiveEditFinalizer(null);
  act(() => {
    useEditorStore.setState({ ...initial }, true);
  });
});

describe("editorStore — 基础 setter", () => {
  it("setDoc 应更新文档内容", () => {
    act(() => useEditorStore.getState().setDoc("# Hello"));
    expect(useEditorStore.getState().doc).toBe("# Hello");
  });

  it("setSelectedPath 应更新路径", () => {
    act(() => useEditorStore.getState().setSelectedPath("notes/a.md"));
    expect(useEditorStore.getState().selectedPath).toBe("notes/a.md");
  });

  it("setMode 应切换模式", () => {
    act(() => useEditorStore.getState().setMode("source"));
    expect(useEditorStore.getState().mode).toBe("source");
  });

  it("wordCount 应返回字数", () => {
    act(() => useEditorStore.getState().setDoc("hello world test"));
    expect(useEditorStore.getState().wordCount()).toBe(3);
  });

  it("fileName 应返回文件名", () => {
    act(() => useEditorStore.getState().setSelectedPath("notes/my-note.md"));
    expect(useEditorStore.getState().fileName()).toBe("my-note.md");
  });

  it("fileName null 时应返回 null", () => {
    expect(useEditorStore.getState().fileName()).toBeNull();
  });
});

describe("editorStore — saveCurrent", () => {
  it("无 selectedPath 时应跳过", async () => {
    act(() => {
      useEditorStore.setState({ doc: "changed", dirty: true, selectedPath: null });
    });
    await act(async () => {
      await useEditorStore.getState().saveCurrent();
    });
    // saveState 应保持 idle
    expect(useEditorStore.getState().saveState).toBe("idle");
  });

  it("无 dirty 时应跳过", async () => {
    act(() => {
      useEditorStore.setState({ doc: "same", dirty: false, selectedPath: "notes/a.md", lastSavedDoc: "same" });
    });
    await act(async () => {
      await useEditorStore.getState().saveCurrent();
    });
    expect(useEditorStore.getState().saveState).toBe("idle");
  });

  it("保存成功后 dirty 应清空", async () => {
    act(() => {
      useEditorStore.setState({
        doc: "new content",
        dirty: true,
        selectedPath: "notes/a.md",
        lastSavedDoc: "old content",
      });
    });
    await act(async () => {
      await useEditorStore.getState().saveCurrent();
    });
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(useEditorStore.getState().lastSavedDoc).toBe("new content");
    expect(useEditorStore.getState().saveState).toBe("saved");
  });

  it("公式编辑中保存：先收尾会话（恢复定界符）再落盘，标记不丢失", async () => {
    // 模拟 Editor.tsx 注册的会话收尾函数：裸代码 → 重新包裹回 $ 定界符
    setActiveEditFinalizer(() => {
      act(() => {
        useEditorStore.setState({ doc: "$x^2$", isFormulaEditing: false });
      });
    });
    act(() => {
      useEditorStore.setState({
        doc: "x^2",
        dirty: true,
        selectedPath: "notes/a.md",
        lastSavedDoc: "$x$",
        isFormulaEditing: true,
      });
    });

    await act(async () => {
      await useEditorStore.getState().saveCurrent();
    });

    // 收尾函数被调用，落盘的是带 $ 定界符的完整文档，而非裸代码
    expect(api.writeFile).toHaveBeenCalledWith("notes/a.md", "$x^2$");
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(useEditorStore.getState().saveState).toBe("saved");
    expect(useEditorStore.getState().isFormulaEditing).toBe(false);
  });

  it("无会话收尾函数时保持守卫：公式编辑中裸代码绝不落盘", async () => {
    act(() => {
      useEditorStore.setState({
        doc: "x^2",
        dirty: true,
        selectedPath: "notes/a.md",
        lastSavedDoc: "$x$",
        isFormulaEditing: true,
      });
    });

    await act(async () => {
      await useEditorStore.getState().saveCurrent();
    });

    expect(api.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().dirty).toBe(true);
    expect(useEditorStore.getState().isFormulaEditing).toBe(true);
  });
});
