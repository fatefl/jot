// src/hooks/useFileTreeCallbacks.ts
// 文件树所有回调：右键菜单、拖拽移动、重命名
import { useCallback } from "react";
import type React from "react";
import type { TreeNode } from "@/lib/tauri";
import type { MenuEntry } from "@/components/ui/context-menu";
import { api } from "@/lib/tauri";
import { stripMdExtension } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { useEditorStore } from "@/stores/editorStore";
import { useFileStore } from "@/stores/fileStore";
import { useTabStore } from "@/stores/tabStore";
import { useUiStore } from "@/stores/uiStore";
import type { ToastAction } from "@/components/ui/toast";

export function useFileTreeCallbacks(toast: (msg: string, action?: ToastAction) => void) {
  const onSelect = useCallback((node: TreeNode) => {
    useTabStore.getState().openFile(node);
  }, []);

  const onToggle = useCallback((path: string) => {
    useFileStore.getState().toggleCollapse(path);
  }, []);

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: TreeNode) => {
      const entries: MenuEntry[] = [];
      if (node.isDir) {
        entries.push(
          {
            label: "新建笔记",
            onClick: () =>
              useFileStore
                .getState()
                .createNoteAt(node.path)
                .then((p) => useTabStore.getState().openFileByPath(p)),
          },
          {
            label: "新建子目录",
            onClick: () => useFileStore.getState().createDirAt(node.path),
          },
          "separator",
          {
            label: "重命名",
            onClick: () => useFileStore.setState({ renamingPath: node.path }),
          },
          "separator",
          {
            label: "在文件管理器中显示",
            onClick: () => api.revealInFolder(node.path).catch(() => {}),
          },
          {
            label: "复制路径",
            onClick: () =>
              navigator.clipboard
                .writeText(node.path)
                .then(() => toast("已复制路径")),
          },
          "separator",
          {
            label: "删除",
            danger: true,
            onClick: async () => {
              try {
                await useFileStore.getState().deleteNode(node);
                toast(`已删除 ${node.name}`, {
                  label: "撤销", duration: 4000,
                  onClick: () => useFileStore.getState().undoDelete(),
                });
              } catch {}
            },
          },
        );
      } else {
        entries.push(
          {
            label: "重命名",
            onClick: () => useFileStore.setState({ renamingPath: node.path }),
          },
          {
            label: "复制为 Markdown 链接",
            onClick: () => {
              const dir = useAppStore.getState().notesDir!;
              // 仓库根相对路径（任意笔记粘贴后，打开端按双基准解析均能命中：
              // 文件相对优先、仓库根相对兜底，见 linkActions.resolveLinkCandidates）
              const rel = node.path.startsWith(dir + "/")
                ? encodeURI(node.path.slice(dir.length + 1))
                : encodeURI(node.path);
              // 与补全输出一致用 `<>` 包裹：CommonMark 允许路径含 ()，
              // 否则 [x](a(b).md) 会在第一个 ) 处被解析器截断
              navigator.clipboard
                .writeText(`[${stripMdExtension(node.name)}](<${rel}>)`)
                .then(() => toast("已复制链接"));
            },
          },
          "separator",
          {
            label: "在文件管理器中显示",
            onClick: () => api.revealInFolder(node.path).catch(() => {}),
          },
          {
            label: "复制路径",
            onClick: () =>
              navigator.clipboard
                .writeText(node.path)
                .then(() => toast("已复制路径")),
          },
          "separator",
          {
            label: "删除",
            danger: true,
            onClick: async () => {
              try {
                await useFileStore.getState().deleteNode(node);
                toast(`已删除 ${node.name}`, {
                  label: "撤销", duration: 4000,
                  onClick: () => useFileStore.getState().undoDelete(),
                });
              } catch {}
            },
          },
        );
      }
      useUiStore.setState({
        menu: { x: e.clientX, y: e.clientY, entries },
      });
    },
    [toast],
  );

  const onBlankContextMenu = useCallback((e: React.MouseEvent) => {
    const entries: MenuEntry[] = [
      {
        label: "新建笔记",
        onClick: () => {
          const dir = useAppStore.getState().notesDir;
          if (dir)
            useFileStore
              .getState()
              .createNoteAt(dir)
              .then((p) => useTabStore.getState().openFileByPath(p));
        },
      },
      {
        label: "新建目录",
        onClick: () => {
          const dir = useAppStore.getState().notesDir;
          if (dir) useFileStore.getState().createDirAt(dir);
        },
      },
      "separator",
      {
        label: "全部折叠",
        onClick: () => useFileStore.getState().setAllCollapsed(true),
      },
      {
        label: "全部展开",
        onClick: () => useFileStore.getState().setAllCollapsed(false),
      },
    ];
    useUiStore.setState({
      menu: { x: e.clientX, y: e.clientY, entries },
    });
  }, []);

  const onRenameSubmit = useCallback(
    (node: TreeNode, name: string) =>
      useFileStore.getState().submitRename(node.path, name, node.isDir),
    [],
  );
  const onRenameCancel = useCallback(
    () => useFileStore.getState().cancelRename(),
    [],
  );

  const onNewNoteIn = useCallback(
    (node: TreeNode) =>
      useFileStore
        .getState()
        .createNoteAt(node.path)
        .then((p) => useTabStore.getState().openFileByPath(p)),
    [],
  );

  // onMoreMenu 复用完整右键菜单（与 onNodeContextMenu 相同）
  const onMoreMenu = onNodeContextMenu;

  const onNewNote = useCallback(() => {
    const dir = useAppStore.getState().notesDir;
    if (dir)
      useFileStore
        .getState()
        .createNoteAt(dir)
        .then((p) => useTabStore.getState().openFileByPath(p));
  }, []);

  const onNewDir = useCallback(() => {
    const dir = useAppStore.getState().notesDir;
    if (dir) useFileStore.getState().createDirAt(dir);
  }, []);

  const onOpenSettings = useCallback(
    () => useUiStore.setState({ settingsOpen: true }),
    [],
  );

  const onNodeDragStart = useCallback(
    (node: TreeNode) => useUiStore.setState({ dragging: node }),
    [],
  );
  const onNodeDragEnd = useCallback(
    () => useUiStore.setState({ dragging: null, dropTarget: null }),
    [],
  );

  const parentOf = (path: string): string => {
    const i = path.lastIndexOf("/");
    return i > 0 ? path.slice(0, i) : "/";
  };

  // 移动文件/目录后同步标签路径与编辑器选中路径
  // （与 fileStore.submitRename 的 tabs+selectedPath 前缀重写逻辑一致），
  // 否则自动保存会把文件"复活"到旧路径、标签失效
  const remapOpenedPaths = (oldPath: string, newPath: string) => {
    const tabs = useTabStore.getState().tabs;
    useTabStore.setState({
      tabs: tabs.map((t) => {
        if (t.path === oldPath) {
          return { ...t, path: newPath, name: newPath.split("/").pop() ?? t.name };
        }
        // 目录移动时更新子文件路径前缀
        if (t.path.startsWith(oldPath + "/")) {
          return { ...t, path: newPath + t.path.slice(oldPath.length) };
        }
        return t;
      }),
    });
    const sp = useEditorStore.getState().selectedPath;
    if (sp === oldPath) {
      useEditorStore.setState({ selectedPath: newPath });
    } else if (sp?.startsWith(oldPath + "/")) {
      useEditorStore.setState({ selectedPath: newPath + sp.slice(oldPath.length) });
    }
  };

  const onDirDragOver = useCallback(
    (e: React.DragEvent, node: TreeNode) => {
      const d = useUiStore.getState().dragging;
      if (!d || !node.isDir) return;
      if (node.path === d.path) return;
      if (node.path.startsWith(d.path + "/")) return;
      if (parentOf(d.path) === node.path) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      useUiStore.setState({ dropTarget: node.path });
    },
    [],
  );

  const onDropOnDir = useCallback(async (node: TreeNode) => {
    const d = useUiStore.getState().dragging;
    if (!d || !node.isDir) return;
    if (node.path === d.path) return;
    if (node.path.startsWith(d.path + "/")) return;
    try {
      const newPath = await api.movePath(d.path, node.path);
      const nd = useAppStore.getState().notesDir;
      if (nd) await useFileStore.getState().refreshTree(nd);
      remapOpenedPaths(d.path, newPath);
      toast(`已移动 ${d.name}`);
    } catch (e) {
      toast(`移动失败：${e}`);
    } finally {
      useUiStore.setState({ dropTarget: null, dragging: null });
    }
  }, [toast]);

  const onDropToRoot = useCallback(async () => {
    const d = useUiStore.getState().dragging;
    const nd = useAppStore.getState().notesDir;
    if (!d || !nd) return;
    if (parentOf(d.path) === nd) return;
    try {
      const newPath = await api.movePath(d.path, nd);
      await useFileStore.getState().refreshTree(nd);
      remapOpenedPaths(d.path, newPath);
      toast(`已移动 ${d.name}`);
    } catch (e) {
      toast(`移动失败：${e}`);
    } finally {
      useUiStore.setState({ dropTarget: null, dragging: null });
    }
  }, [toast]);

  return {
    onSelect,
    onToggle,
    onNodeContextMenu,
    onBlankContextMenu,
    onRenameSubmit,
    onRenameCancel,
    onNewNoteIn,
    onMoreMenu,
    onNewNote,
    onNewDir,
    onOpenSettings,
    onNodeDragStart,
    onNodeDragEnd,
    onDirDragOver,
    onDropOnDir,
    onDropToRoot,
  };
}
