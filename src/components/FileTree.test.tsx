// @vitest-environment jsdom
// FileTree 组件测试
//
// 覆盖：
// - 文件和目录节点渲染（含 data-* 属性标记）
// - 展开/折叠及子节点可见性
// - 选中态高亮
// - 重命名流程（draft / Enter / Escape / blur / 空白拒绝）
// - Drop target 高亮
// - 拖拽回调（dragStart / dragEnd / dragOver / drop）
// - 新建笔记 & 更多按钮（仅目录显示）
// - 嵌套缩进 padding

import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { FileTree } from "./FileTree";
import type { TreeNode } from "@/lib/tauri";

function makeNode(
  path: string,
  name: string,
  isDir: boolean,
  children: TreeNode[] = [],
): TreeNode {
  return { path, name, isDir, children };
}

const NOOP = {
  onToggle: vi.fn(),
  onSelect: vi.fn(),
  onContextMenu: vi.fn(),
  onRenameSubmit: vi.fn(),
  onRenameCancel: vi.fn(),
  onNewNoteIn: vi.fn(),
  onMoreMenu: vi.fn(),
  onNodeDragStart: vi.fn(),
  onNodeDragEnd: vi.fn(),
  onDirDragOver: vi.fn(),
  onDropOnDir: vi.fn(),
};

function freshNoop() {
  return {
    onToggle: vi.fn(),
    onSelect: vi.fn(),
    onContextMenu: vi.fn(),
    onRenameSubmit: vi.fn(),
    onRenameCancel: vi.fn(),
    onNewNoteIn: vi.fn(),
    onMoreMenu: vi.fn(),
    onNodeDragStart: vi.fn(),
    onNodeDragEnd: vi.fn(),
    onDirDragOver: vi.fn(),
    onDropOnDir: vi.fn(),
  };
}

// ============================================================================

describe("FileTree — 渲染", () => {
  it("渲染文件节点并标记 data-tree-dir='false'", () => {
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/a.md"]') as HTMLElement;
    expect(r).not.toBeNull();
    expect(r.getAttribute("data-tree-dir")).toBe("false");
  });

  it("渲染目录节点并标记 data-tree-dir='true'", () => {
    const { container } = render(
      <FileTree
        nodes={[makeNode("/f", "f", true)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/f"]') as HTMLElement;
    expect(r).not.toBeNull();
    expect(r.getAttribute("data-tree-dir")).toBe("true");
  });

  it("展开目录时子节点可见", () => {
    const tree = [makeNode("/a", "a", true, [makeNode("/a/x.md", "x.md", false)])];
    const { container } = render(
      <FileTree
        nodes={tree}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    expect(container.querySelector('[data-tree-path="/a/x.md"]')).not.toBeNull();
  });

  it("折叠目录时子节点不可见", () => {
    const tree = [makeNode("/a", "a", true, [makeNode("/a/x.md", "x.md", false)])];
    const { container } = render(
      <FileTree
        nodes={tree}
        collapsed={{ "/a": true }}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    expect(container.querySelector('[data-tree-path="/a/x.md"]')).toBeNull();
  });

  it("空目录无子节点", () => {
    const { container } = render(
      <FileTree
        nodes={[makeNode("/empty", "empty", true, [])]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    expect(container.querySelector('[data-tree-path="/empty"]')).not.toBeNull();
  });
});

describe("FileTree — 交互", () => {
  it("点击文件调用 onSelect", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={onSelect}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const div = container.querySelector('[data-tree-path="/a.md"]')!;
    fireEvent.click(div);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].path).toBe("/a.md");
  });

  it("点击目录调用 onToggle", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/d", "d", true)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        onToggle={onToggle}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const div = container.querySelector('[data-tree-path="/d"]')!;
    fireEvent.click(div);
    expect(onToggle).toHaveBeenCalledWith("/d");
  });

  it("右键调用 onContextMenu", () => {
    const onContextMenu = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={onContextMenu}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const div = container.querySelector('[data-tree-path="/a.md"]')!;
    fireEvent.contextMenu(div);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });
});

describe("FileTree — 重命名", () => {
  it("renamingPath 匹配时显示 input", () => {
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath="/a.md"
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    const inp = container.querySelector("input") as HTMLInputElement;
    expect(inp).not.toBeNull();
    expect(inp.value).toBe("a.md");
  });

  it("Enter 提交新名称", () => {
    const onRenameSubmit = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath="/a.md"
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={vi.fn()}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const inp = container.querySelector("input") as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "renamed.md" } });
    fireEvent.keyDown(inp, { key: "Enter" });
    expect(onRenameSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/a.md" }),
      "renamed.md",
    );
  });

  it("Escape 取消重命名", () => {
    const onRenameCancel = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath="/a.md"
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={onRenameCancel}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const inp = container.querySelector("input") as HTMLInputElement;
    fireEvent.keyDown(inp, { key: "Escape" });
    expect(onRenameCancel).toHaveBeenCalled();
  });

  it("Blur 后名称改变 → 提交", () => {
    const onRenameSubmit = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath="/a.md"
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={vi.fn()}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const inp = container.querySelector("input") as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "new.md" } });
    fireEvent.blur(inp);
    expect(onRenameSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/a.md" }),
      "new.md",
    );
  });

  it("Blur 后名称未变 → 取消", () => {
    const onRenameCancel = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath="/a.md"
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={onRenameCancel}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const inp = container.querySelector("input") as HTMLInputElement;
    fireEvent.blur(inp);
    expect(onRenameCancel).toHaveBeenCalled();
  });

  it("空白名称拒绝提交", () => {
    const onRenameCancel = vi.fn();
    const onRenameSubmit = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath="/a.md"
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={onRenameCancel}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const inp = container.querySelector("input") as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "   " } });
    fireEvent.keyDown(inp, { key: "Enter" });
    expect(onRenameSubmit).not.toHaveBeenCalled();
    expect(onRenameCancel).toHaveBeenCalled();
  });
});

describe("FileTree — 拖拽 & Drop Target", () => {
  it("文件节点可拖拽（draggable=true）", () => {
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/a.md"]') as HTMLElement;
    expect(r.draggable).toBe(true);
  });

  it("dragStart 回调", () => {
    const onNodeDragStart = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={onNodeDragStart}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/a.md"]') as HTMLElement;
    // jsdom 没有 DragEvent 构造函数也不带 dataTransfer，用 Event 模拟
    const dt = { effectAllowed: "", setData: vi.fn(), getData: vi.fn() };
    const event = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: dt });
    r.dispatchEvent(event);
    expect(onNodeDragStart).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/a.md" }),
    );
  });

  it("dragEnd 回调", () => {
    const onNodeDragEnd = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={onNodeDragEnd}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/a.md"]') as HTMLElement;
    fireEvent.dragEnd(r);
    expect(onNodeDragEnd).toHaveBeenCalled();
  });

  it("dropTarget 高亮", () => {
    const { container } = render(
      <FileTree
        nodes={[makeNode("/d", "d", true)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget="/d"
        {...freshNoop()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/d"]') as HTMLElement;
    expect(r.className).toContain("bg-accent-soft");
    expect(r.className).toContain("ring-1");
  });

  it("dragOver 回调（仅目录）", () => {
    const onDirDragOver = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/d", "d", true)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={onDirDragOver}
        onDropOnDir={vi.fn()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/d"]') as HTMLElement;
    fireEvent.dragOver(r);
    expect(onDirDragOver).toHaveBeenCalled();
  });

  it("drop 回调（仅目录）", () => {
    const onDropOnDir = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/d", "d", true)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        onNewNoteIn={vi.fn()}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={onDropOnDir}
      />,
    );
    const r = container.querySelector('[data-tree-path="/d"]') as HTMLElement;
    fireEvent.drop(r);
    expect(onDropOnDir).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/d" }),
    );
  });
});

describe("FileTree — 选中态", () => {
  it("selectedPath 匹配时高亮", () => {
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath="/a.md"
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/a.md"]') as HTMLElement;
    expect(r.className).toContain("bg-[#818cf8]");
  });

  it("未选中时不带高亮类", () => {
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/a.md"]') as HTMLElement;
    expect(r.className).not.toContain("bg-[#818cf8]");
  });
});

describe("FileTree — 新建笔记 & 更多按钮", () => {
  it("目录有新建笔记按钮", () => {
    const onNewNoteIn = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/d", "d", true)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        onNewNoteIn={onNewNoteIn}
        onMoreMenu={vi.fn()}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const btn = container.querySelector('[title="新建笔记"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(onNewNoteIn).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/d" }),
    );
  });

  it("目录有更多按钮", () => {
    const onMoreMenu = vi.fn();
    const { container } = render(
      <FileTree
        nodes={[makeNode("/d", "d", true)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        onNewNoteIn={vi.fn()}
        onMoreMenu={onMoreMenu}
        onNodeDragStart={vi.fn()}
        onNodeDragEnd={vi.fn()}
        onDirDragOver={vi.fn()}
        onDropOnDir={vi.fn()}
      />,
    );
    const btn = container.querySelector('[title="更多"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(onMoreMenu).toHaveBeenCalled();
  });

  it("文件没有新建笔记/更多按钮", () => {
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    expect(container.querySelector('[title="新建笔记"]')).toBeNull();
    expect(container.querySelector('[title="更多"]')).toBeNull();
  });
});

describe("FileTree — 缩进", () => {
  it("根节点 paddingLeft = 12px", () => {
    const { container } = render(
      <FileTree
        nodes={[makeNode("/a.md", "a.md", false)]}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/a.md"]') as HTMLElement;
    expect(r.style.paddingLeft).toBe("12px");
  });

  it("嵌套深度 2 时 paddingLeft = 52px", () => {
    const tree = [
      makeNode("/a", "a", true, [
        makeNode("/a/b", "b", true, [makeNode("/a/b/c.md", "c.md", false)]),
      ]),
    ];
    const { container } = render(
      <FileTree
        nodes={tree}
        collapsed={{}}
        selectedPath={null}
        renamingPath={null}
        dropTarget={null}
        {...freshNoop()}
      />,
    );
    const r = container.querySelector('[data-tree-path="/a/b/c.md"]') as HTMLElement;
    expect(r.style.paddingLeft).toBe("52px");
  });
});
