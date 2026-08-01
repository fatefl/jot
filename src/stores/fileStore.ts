// src/stores/fileStore.ts
import { create } from "zustand";
import { api, type TreeNode, type BacklinkInfo, type TagInfo } from "@/lib/tauri";
import { collectNotes, type NoteItem } from "@/lib/noteCompletion";
import { normalizeTree } from "@/lib/utils";
import { useAppStore } from "./appStore";

/** loadBacklinks 竞态防护的单调递增序号：每次请求自增，过期结果直接丢弃 */
let backlinkEpoch = 0;

interface UndoStash {
  files: { path: string; content: string }[];
  dirs: string[];
}

export interface FileState {
  rootChildren: TreeNode[];
  collapsed: Record<string, boolean>;
  renamingPath: string | null;
  undoStash: UndoStash | null;

  backlinks: BacklinkInfo[];
  tagList: TagInfo[];

  // 派生
  noteItems: () => NoteItem[];

  // 树操作
  refreshTree: (dir?: string) => Promise<void>;
  toggleCollapse: (path: string) => void;
  setAllCollapsed: (value: boolean) => void;
  expandTo: (path: string) => void;

  // CRUD
  createNoteAt: (dir: string, templatePath?: string, templateName?: string) => Promise<string>;
  createDirAt: (parentDir: string) => Promise<void>;
  deleteNode: (node: TreeNode) => Promise<void>;
  undoDelete: () => Promise<void>;

  // 重命名
  submitRename: (path: string, name: string, isDir: boolean) => Promise<void>;
  cancelRename: () => void;

  // 元数据
  loadBacklinks: (filePath: string) => Promise<void>;
  loadTags: () => Promise<void>;
}

export const useFileStore = create<FileState>()((set, get) => ({
  rootChildren: [],
  collapsed: {},
  renamingPath: null,
  undoStash: null,
  backlinks: [],
  tagList: [],

  noteItems: () => collectNotes(get().rootChildren),

  refreshTree: async (dir?: string) => {
    const targetDir = dir || getCollapsedKeyDir();
    if (!targetDir) return;
    const root = await api.listTree(targetDir);
    // 路径统一为 "/" 分隔（Windows 旧二进制可能返回反斜杠）
    set({ rootChildren: normalizeTree(root).children });
  },

  toggleCollapse: (path: string) => {
    set((s) => {
      const next = { ...s.collapsed, [path]: !(s.collapsed[path] ?? false) };
      persistCollapsed(next);
      return { collapsed: next };
    });
  },

  setAllCollapsed: (value: boolean) => {
    const { rootChildren } = get();
    const next: Record<string, boolean> = {};
    if (value) {
      const walk = (nodes: TreeNode[]) => {
        for (const n of nodes) {
          if (n.isDir) {
            next[n.path] = true;
            walk(n.children);
          }
        }
      };
      walk(rootChildren);
    }
    set({ collapsed: next });
    persistCollapsed(next);
  },

  expandTo: (path: string) => {
    set((s) => {
      const next = { ...s.collapsed };
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        delete next[parts.slice(0, i).join("/")];
      }
      return { collapsed: next };
    });
  },

  createNoteAt: async (dir, templatePath?, templateName?) => {
    const targetDir = getCollapsedKeyDir();
    let path: string;
    if (templatePath) {
      path = await api.createFromTemplate(dir, templatePath, templateName || "未命名");
    } else {
      path = await api.createNote(dir, templateName);
    }
    await get().refreshTree(targetDir);
    return path;
  },

  createDirAt: async (parentDir) => {
    const newPath = await api.createDir(parentDir);
    get().expandTo(parentDir);
    await get().refreshTree(getCollapsedKeyDir());
  },

  deleteNode: async (node) => {
    // 收集文件内容用于撤销
    const stash: UndoStash = { files: [], dirs: [] };
    const { useEditorStore } = await import("./editorStore");
    const editor = useEditorStore.getState();

    const collect = async (n: TreeNode) => {
      if (n.isDir) {
        stash.dirs.push(n.path);
        for (const c of n.children) await collect(c);
      } else if (n.path === editor.selectedPath && editor.dirty) {
        stash.files.push({ path: n.path, content: editor.doc });
      } else {
        const content = await api.readFile(n.path).catch(() => "");
        stash.files.push({ path: n.path, content });
      }
    };
    await collect(node);
    await api.deletePath(node.path);
    set({ undoStash: stash });

    // 清理引用已删除文件的标签
    const { useTabStore, dropSnapshotsForPath } = await import("./tabStore");
    dropSnapshotsForPath(node.path, node.isDir);
    const tabs = useTabStore.getState().tabs;
    let nextTabs = node.isDir
      ? tabs.filter((t) => !t.path.startsWith(node.path + "/") && t.path !== node.path)
      : tabs.filter((t) => t.path !== node.path);

    if (nextTabs.length === 0) {
      useEditorStore.setState((prev) => ({ selectedPath: null, doc: "", docEpoch: prev.docEpoch + 1, lastSavedDoc: "", dirty: false }));
      useTabStore.setState({ tabs: [], activeTabIdx: 0 });
    } else {
      const curActive = useTabStore.getState().activeTabIdx;
      const curPath = editor.selectedPath;
      if (curPath === node.path || (node.isDir && curPath?.startsWith(node.path + "/"))) {
        const newActive = Math.min(curActive, nextTabs.length - 1);
        useTabStore.setState({ activeTabIdx: newActive, tabs: nextTabs });
        const newTab = nextTabs[newActive];
        if (newTab && newTab.path !== curPath) {
          try {
            const content = await api.readFile(newTab.path);
            // 单视图换状态：优先缓存的 EditorState（零重建）
            const { swapEditorState } = await import("@/lib/editorViewCache");
            swapEditorState(newTab.path, content, true);
            useEditorStore.setState((prev) => ({ selectedPath: newTab.path, doc: content, docEpoch: prev.docEpoch + 1, lastSavedDoc: content, dirty: false }));
          } catch { }
        }
      } else if (curActive >= nextTabs.length) {
        useTabStore.setState({ activeTabIdx: Math.min(curActive, nextTabs.length - 1), tabs: nextTabs });
      } else {
        useTabStore.setState({ tabs: nextTabs });
      }
    }

    await get().refreshTree(getCollapsedKeyDir());
    // toast 通过组件层调用
  },

  undoDelete: async () => {
    const stash = get().undoStash;
    if (!stash) return;
    // 先恢复目录（按路径深度排序，父目录先于子目录）
    const dirsSorted = [...stash.dirs].sort((a, b) => a.length - b.length);
    for (const d of dirsSorted) {
      try {
        const parent = d.substring(0, d.lastIndexOf("/")) || "/";
        const name = d.split("/").pop() || d;
        await api.createDir(parent, name);
      } catch { }
    }
    // 再恢复文件
    for (const f of stash.files) {
      try {
        await api.writeFile(f.path, f.content);
      } catch { }
    }
    set({ undoStash: null });
    await get().refreshTree(getCollapsedKeyDir());
  },

  submitRename: async (path, name, isDir) => {
    try {
      // 非目录文件自动追加 .md 后缀
      let finalName = name.trim();
      if (!isDir && !finalName.endsWith(".md")) finalName += ".md";
      const newPath = await api.renamePath(path, finalName);
      set({ renamingPath: null });
      await get().refreshTree(getCollapsedKeyDir());
      // 更新关联标签的路径
      const { useTabStore, remapSnapshotsForRename } = await import("./tabStore");
      remapSnapshotsForRename(path, newPath, isDir);
      const tabs = useTabStore.getState().tabs;
      const updated = tabs.map((t) => {
        if (t.path === path) return { ...t, path: newPath, name: finalName };
        // 目录重命名时更新子文件路径前缀
        if (isDir && t.path.startsWith(path + "/")) {
          return { ...t, path: newPath + t.path.slice(path.length) };
        }
        return t;
      });
      useTabStore.setState({ tabs: updated });
      const { useEditorStore } = await import("./editorStore");
      const sp = useEditorStore.getState().selectedPath;
      if (sp === path) {
        useEditorStore.setState({ selectedPath: newPath });
      } else if (isDir && sp?.startsWith(path + "/")) {
        // 目录重命名时更新已打开文件的路径
        useEditorStore.setState({ selectedPath: newPath + sp.slice(path.length) });
      }
    } catch {
      set({ renamingPath: null });
    }
  },

  cancelRename: () => set({ renamingPath: null }),

  loadBacklinks: async (filePath) => {
    const collDir = getCollapsedKeyDir();
    if (!collDir) return;
    // 竞态防护：快速切换文件时，先发出的慢请求后返回会覆盖新文件的
    // 反链。用单调递增 epoch 丢弃过期结果（与 tabStore 的 switchEpoch 同思路）。
    const myEpoch = ++backlinkEpoch;
    try {
      const links = await api.getBacklinks(collDir, filePath);
      if (myEpoch !== backlinkEpoch) return;
      set({ backlinks: links });
    } catch {
      if (myEpoch !== backlinkEpoch) return;
      set({ backlinks: [] });
    }
  },

  loadTags: async () => {
    const collDir = getCollapsedKeyDir();
    if (!collDir) return;
    try {
      const tags = await api.listTags(collDir);
      set({ tagList: tags });
    } catch {
      set({ tagList: [] });
    }
  },
}));

/** 从 useAppStore 读取 notesDir 用于构造 collapsed key */
function getCollapsedKeyDir(): string | undefined {
  try {
    return useAppStore.getState().notesDir ?? undefined;
  } catch {
    return undefined;
  }
}

function persistCollapsed(collapsed: Record<string, boolean>) {
  const dir = getCollapsedKeyDir();
  if (!dir) return;
  localStorage.setItem(`notes-collapsed:${dir}`, JSON.stringify(collapsed));
}
