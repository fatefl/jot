// src/stores/tabStore.ts
import { create } from "zustand";
import { api } from "@/lib/tauri";
import { isExternalPath, normPath } from "@/lib/utils";
import { setLivePreviewAssetBase } from "@/lib/livePreview";
import {
  swapEditorState,
  dropViewState,
  dropViewStatesForPath,
  remapViewStatesForRename,
} from "@/lib/editorViewCache";
import type { TreeNode } from "@/lib/tauri";

export interface TabInfo {
  path: string;
  name: string;
  dirty: boolean;
  external: boolean;
  /** 只读模式：禁止编辑，适用于许可证 / 隐私政策等打包资源文件 */
  readOnly?: boolean;
}

const MAX_TABS = 10;

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

/**
 * 标签内容内存快照：切换标签不再从磁盘重读。
 * 离开标签时从编辑器状态捕获，切回时直接恢复（零 IO）；
 * 干净快照恢复后异步校验磁盘 mtime，外部已修改则回退读盘。
 */
interface TabSnapshot {
  doc: string;
  dirty: boolean;
  lastSavedDoc: string;
  /** 捕获时的磁盘 mtime 基准（同 editorStore.loadedMtime），用于切回后校验外部修改 */
  loadedMtime: number | null;
  /** 捕获时的光标行（1-based），切回后经 jumpTarget 恢复大致位置 */
  cursorLine: number | null;
}

const tabSnapshots = new Map<string, TabSnapshot>();

/** 切换纪元：每发起一次切换/打开自增。异步步骤完成后比对，过期说明已被更新的操作取代 */
let switchEpoch = 0;

/** 测试专用：清空快照缓存与切换纪元 */
export function __resetTabSnapshotCache(): void {
  tabSnapshots.clear();
  switchEpoch = 0;
}

/** 同步丢弃内容快照与编辑器视图状态缓存 */
function dropTabSnapshot(path: string): void {
  tabSnapshots.delete(path);
  dropViewState(path);
}

/** 文件/目录删除后丢弃快照（目录含其前缀下所有文件） */
export function dropSnapshotsForPath(path: string, isDir: boolean): void {
  for (const key of [...tabSnapshots.keys()]) {
    if (key === path || (isDir && key.startsWith(path + "/"))) {
      tabSnapshots.delete(key);
    }
  }
  dropViewStatesForPath(path, isDir);
}

/** 重命名后迁移快照键（内容仍然有效，rename 保留 mtime） */
export function remapSnapshotsForRename(oldPath: string, newPath: string, isDir: boolean): void {
  for (const [key, snap] of [...tabSnapshots.entries()]) {
    if (key === oldPath) {
      tabSnapshots.delete(key);
      tabSnapshots.set(newPath, snap);
    } else if (isDir && key.startsWith(oldPath + "/")) {
      tabSnapshots.delete(key);
      tabSnapshots.set(newPath + key.slice(oldPath.length), snap);
    }
  }
  remapViewStatesForRename(oldPath, newPath, isDir);
}

export interface TabState {
  tabs: TabInfo[];
  activeTabIdx: number;
  closedTabs: string[];
  recentPaths: string[];

  activeTab: () => TabInfo | undefined;

  openFile: (node: TreeNode) => Promise<boolean>;
  openFileByPath: (path: string, name?: string) => Promise<boolean>;
  openExternalFile: () => Promise<void>;
  importExternalFiles: () => Promise<void>;
  reloadOpenFile: () => Promise<void>;
  openDailyNote: () => Promise<void>;

  closeTab: (idx: number) => Promise<void>;
  switchTab: (idx: number) => Promise<void>;
  closeOthers: (idx: number) => Promise<void>;
  closeRight: (idx: number) => Promise<void>;
  reopenTab: () => void;

  handleExternalDrop: (paths: string[], targetDir?: string) => Promise<void>;
}

/**
 * 读取文件内容，读取期间校验编辑器未被改动。
 * 返回 null 表示窗口期内有用户输入或另一次切换，调用方应放弃写入，
 * 防止 resolve 时无条件覆盖窗口期输入。
 */
async function readFileGuarded(path: string): Promise<string | null> {
  const { useEditorStore } = await import("./editorStore");
  const before = useEditorStore.getState();
  const snap = { selectedPath: before.selectedPath, doc: before.doc, docEpoch: before.docEpoch };
  const content = await api.readFile(path);
  const now = useEditorStore.getState();
  if (
    now.selectedPath !== snap.selectedPath ||
    now.doc !== snap.doc ||
    now.docEpoch !== snap.docEpoch
  ) {
    return null;
  }
  return content;
}

/** 读取校验通过后写入编辑器状态，并刷新 mtime 基准 */
async function applyLoadedDoc(path: string, content: string): Promise<void> {
  // 从磁盘加载了新内容：该路径的旧内存快照/视图状态缓存作废（下次离开时重新捕获）
  dropTabSnapshot(path);
  // 单视图换状态：磁盘内容强制刷新（不使用视图状态缓存）
  setLivePreviewAssetBase(parentOf(path));
  swapEditorState(path, content, false);
  const mod = await import("./editorStore");
  const { useEditorStore } = mod;
  // 测试 mock 可能不提供 fetchMtime 导出（vitest mock 代理访问缺失导出会抛错），防御性处理
  let loadedMtime: number | null = null;
  try {
    const fm = (mod as { fetchMtime?: (p: string) => Promise<number | null> }).fetchMtime;
    if (typeof fm === "function") loadedMtime = await fm(path);
  } catch { /* 忽略：mtime 基准不可用时保持原值 */ }
  useEditorStore.setState({
    selectedPath: path,
    doc: content,
    docEpoch: useEditorStore.getState().docEpoch + 1,
    lastSavedDoc: content,
    dirty: false,
    ...(loadedMtime !== null ? { loadedMtime } : {}),
  });
}

/** 清空编辑器（无标签时） */
async function resetEditor(): Promise<void> {
  const { useEditorStore } = await import("./editorStore");
  useEditorStore.setState({
    selectedPath: null, doc: "",
    docEpoch: useEditorStore.getState().docEpoch + 1,
    lastSavedDoc: "", dirty: false, loadedMtime: null,
  });
}

/** 离开标签前捕获编辑器状态到内存快照（切回时免读盘恢复） */
async function snapshotCurrentTab(): Promise<void> {
  const { useEditorStore } = await import("./editorStore");
  const e = useEditorStore.getState();
  if (!e.selectedPath) return;
  tabSnapshots.set(e.selectedPath, {
    doc: e.doc,
    dirty: e.dirty,
    lastSavedDoc: e.lastSavedDoc,
    loadedMtime: e.loadedMtime,
    cursorLine: e.cursorLine,
  });
}

/** 从内存快照恢复编辑器状态（替代读盘）；有活动视图时经 swapEditorState
 *  直接 setState 恢复缓存的 EditorState（零重建），docEpoch 仅作竞态守卫语义 */
async function applySnapshot(path: string, snap: TabSnapshot): Promise<void> {
  setLivePreviewAssetBase(parentOf(path));
  swapEditorState(path, snap.doc, true);
  const { useEditorStore } = await import("./editorStore");
  useEditorStore.setState({
    selectedPath: path,
    doc: snap.doc,
    docEpoch: useEditorStore.getState().docEpoch + 1,
    lastSavedDoc: snap.lastSavedDoc,
    dirty: snap.dirty,
    loadedMtime: snap.loadedMtime,
  });
}

/** 高亮回退到编辑器实际显示的文件（内容加载被中止时保持高亮与内容一致） */
async function revertActiveToEditor(): Promise<void> {
  const { useEditorStore } = await import("./editorStore");
  const { selectedPath } = useEditorStore.getState();
  useTabStore.setState((s) => {
    const back = s.tabs.findIndex((t) => t.path === selectedPath);
    return back >= 0 && back !== s.activeTabIdx ? { activeTabIdx: back } : {};
  });
}

/** 文件已被删除：移除对应标签；若移除的是当前显示的文件，加载相邻标签内容 */
async function removeStaleTab(path: string): Promise<void> {
  dropTabSnapshot(path);
  let removedActive = false;
  useTabStore.setState((s) => {
    const idx = s.tabs.findIndex((t) => t.path === path);
    if (idx < 0) return {};
    const next = s.tabs.filter((_, i) => i !== idx);
    if (next.length === 0) {
      void resetEditor();
      return { tabs: [], activeTabIdx: 0 };
    }
    removedActive = idx === s.activeTabIdx;
    const newActive = idx < s.activeTabIdx
      ? s.activeTabIdx - 1
      : Math.min(s.activeTabIdx, next.length - 1);
    return { tabs: next, activeTabIdx: newActive };
  });
  if (!removedActive) return;
  const { useEditorStore } = await import("./editorStore");
  if (useEditorStore.getState().selectedPath !== path) return;
  const { tabs, activeTabIdx } = useTabStore.getState();
  const tab = tabs[activeTabIdx];
  if (tab) await loadTabContent(tab.path, ++switchEpoch);
}

/**
 * 干净快照恢复后异步校验：磁盘被外部修改则回退读盘。
 * 内容已即时展示，校验在后台进行，不阻塞切换。
 */
async function verifySnapshotFreshness(path: string, snap: TabSnapshot, epoch: number): Promise<void> {
  const mod = await import("./editorStore");
  const { useEditorStore } = mod;
  // 测试 mock 可能不提供 fetchMtime 导出（vitest mock 代理访问缺失导出会抛错），防御性处理
  let mt: number | null = null;
  try {
    const fm = (mod as { fetchMtime?: (p: string) => Promise<number | null> }).fetchMtime;
    if (typeof fm === "function") mt = await fm(path);
  } catch { /* mtime 不可用则走读盘比对 */ }
  if (epoch !== switchEpoch) return;
  let cur = useEditorStore.getState();
  if (cur.selectedPath !== path || cur.dirty) return;
  // 能证明磁盘未变：无需读盘
  if (mt !== null && snap.loadedMtime !== null && mt === snap.loadedMtime) return;
  // mtime 不可用或不一致：读盘比对
  let content: string;
  try {
    content = await api.readFile(path);
  } catch {
    // 文件已被外部删除：移除过期标签
    if (epoch === switchEpoch) await removeStaleTab(path);
    return;
  }
  if (epoch !== switchEpoch) return;
  cur = useEditorStore.getState();
  if (cur.selectedPath !== path || cur.dirty) return;
  if (content === cur.doc) {
    // 内容一致，仅刷新 mtime 基准
    if (mt !== null) useEditorStore.setState({ loadedMtime: mt });
    return;
  }
  await applyLoadedDoc(path, content);
}

/**
 * 加载标签内容：优先内存快照（零 IO 即时恢复），未命中走读盘。
 * 返回 true 表示内容已应用（快照恢复或读盘成功）。
 */
async function loadTabContent(path: string, epoch: number): Promise<boolean> {
  const snap = tabSnapshots.get(path);
  if (snap) {
    if (epoch !== switchEpoch) return false;
    // 快照恢复：视图状态缓存命中时选区/滚动位置一并还原（见 swapEditorState）
    await applySnapshot(path, snap);
    // 干净快照：异步校验磁盘是否被外部修改（不阻塞切换）
    if (!snap.dirty) void verifySnapshotFreshness(path, snap, epoch);
    return true;
  }
  try {
    const content = await readFileGuarded(path);
    // 窗口期内有用户输入或另一次切换：放弃写入，高亮回退到实际显示的文件
    if (content === null) {
      if (epoch === switchEpoch) await revertActiveToEditor();
      return false;
    }
    if (epoch !== switchEpoch) return false;
    await applyLoadedDoc(path, content);
    return true;
  } catch {
    // 文件已被删除：自动关闭过期标签
    if (epoch === switchEpoch) await removeStaleTab(path);
    return false;
  }
}

/**
 * 切换/关闭前保存当前脏缓冲。统一走 editorStore.saveCurrent——
 * 公式/图表编辑中由 saveCurrent 的守卫跳过（裸代码不落盘）。
 * skipExternal=true 时外部文件不保存（沿用 openFile 原行为：外部文件永不自动写盘）。
 * 返回 false 表示保存失败，调用方应中止整个操作。
 */
async function saveDirtyBuffer(skipExternal: boolean): Promise<boolean> {
  const { useEditorStore } = await import("./editorStore");
  const editor = useEditorStore.getState();
  if (!editor.dirty || !editor.selectedPath) return true;
  if (skipExternal) {
    const { useAppStore } = await import("./appStore");
    if (isExternalPath(editor.selectedPath, useAppStore.getState().notesDir)) return true;
  }
  try {
    await editor.saveCurrent();
  } catch {
    return false;
  }
  // 保存成功则同步清除活动标签的 dirty 标志（公式编辑中被守卫跳过时保持 dirty）
  if (!useEditorStore.getState().dirty) {
    const { activeTabIdx } = useTabStore.getState();
    useTabStore.setState((s) => ({
      tabs: s.tabs.map((t, i) => (i === activeTabIdx ? { ...t, dirty: false } : t)),
    }));
  }
  return true;
}

export const useTabStore = create<TabState>()((set, get) => ({
  tabs: [],
  activeTabIdx: 0,
  closedTabs: [],
  recentPaths: [],

  activeTab: () => {
    const { tabs, activeTabIdx } = get();
    return tabs[activeTabIdx];
  },

  openFile: async (node) => {
    const { useEditorStore } = await import("./editorStore");
    const { useAppStore } = await import("./appStore");
    const { useFileStore } = await import("./fileStore");

    const editor = useEditorStore.getState();
    const app = useAppStore.getState();
    const { tabs, activeTabIdx } = get();

    // 已在当前标签
    if (node.path === editor.selectedPath) return true;

    // 已存在于其他标签
    const existingIdx = tabs.findIndex((t) => t.path === node.path);
    if (existingIdx >= 0 && existingIdx !== activeTabIdx) {
      const epoch = ++switchEpoch;
      // 高亮立即响应；内容优先内存快照恢复，未命中异步读盘补齐
      set({ activeTabIdx: existingIdx });

      // 保存当前脏文件，失败则回退高亮并中止
      if (!(await saveDirtyBuffer(true))) {
        if (epoch === switchEpoch) await revertActiveToEditor();
        return false;
      }
      if (epoch !== switchEpoch) return false;

      // 离开前快照当前标签，供切回时免读盘恢复
      await snapshotCurrentTab();

      const ok = await loadTabContent(node.path, epoch);
      if (!ok || epoch !== switchEpoch) return false;
      useFileStore.getState().expandTo(node.path);
      return true;
    }

    // reuseTab 模式
    if (app.config?.reuseTab && editor.selectedPath) {
      if (!(await saveDirtyBuffer(true))) return false;
      await snapshotCurrentTab();
      try {
        const content = await readFileGuarded(node.path);
        if (content === null) return false;
        await applyLoadedDoc(node.path, content);
        useFileStore.getState().expandTo(node.path);
        set((s) => ({
          tabs: s.tabs.map((t, i) =>
            i === s.activeTabIdx
              ? { path: node.path, name: node.name, dirty: false, external: isExternalPath(node.path, app.notesDir) }
              : t
          ),
        }));
        return true;
      } catch {
        return false;
      }
    }

    // 新标签
    if (!(await saveDirtyBuffer(true))) return false;
    await snapshotCurrentTab();

    try {
      const content = await readFileGuarded(node.path);
      if (content === null) return false;
      await applyLoadedDoc(node.path, content);
      useFileStore.getState().expandTo(node.path);

      set((s) => {
        const existing = s.tabs.findIndex((t) => t.path === node.path);
        if (existing >= 0) return { activeTabIdx: existing };

        const tab: TabInfo = {
          path: node.path, name: node.name, dirty: false,
          external: isExternalPath(node.path, app.notesDir),
        };
        let next = [...s.tabs, tab];
        if (next.length > MAX_TABS) {
          // 被淘汰标签的内存快照一并丢弃
          for (const t of next.slice(0, next.length - MAX_TABS)) {
            dropTabSnapshot(t.path);
          }
          next = next.slice(next.length - MAX_TABS);
        }
        return { tabs: next, activeTabIdx: next.length - 1 };
      });

      // 更新最近路径
      set((s) => {
        const next = [node.path, ...s.recentPaths.filter((p) => p !== node.path)].slice(0, 20);
        localStorage.setItem("notes-recent-paths", JSON.stringify(next));
        return { recentPaths: next };
      });
      return true;
    } catch {
      return false;
    }
  },

  openFileByPath: async (path, name) => {
    // 外部入口（文件对话框/OS"打开方式"/命令行参数）可能给 Windows 反斜杠路径，
    // 统一为 "/" 分隔再进入标签体系，保证 baseName/parentOf/expandTo 等成立
    path = normPath(path);
    const node: TreeNode = {
      name: name ?? baseName(path),
      path,
      isDir: false,
      children: [],
    };
    return get().openFile(node);
  },

  openExternalFile: async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mdwn"] }],
        multiple: false,
      });
      if (typeof selected === "string" && selected) {
        await get().openFileByPath(selected);
      }
    } catch { }
  },

  importExternalFiles: async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true });
      if (!selected) return;
      const paths = (Array.isArray(selected) ? selected : [selected]).map(normPath);

      const { useAppStore } = await import("./appStore");
      const dir = useAppStore.getState().notesDir;
      if (!dir || paths.length === 0) return;

      const { useEditorStore } = await import("./editorStore");
      const cur = useEditorStore.getState().selectedPath;
      const dest = cur && cur.startsWith(dir) ? parentOf(cur) : dir;

      const mdFiles = paths.filter((p) => p.toLowerCase().endsWith(".md"));
      const otherFiles = paths.filter((p) => !p.toLowerCase().endsWith(".md"));
      let count = 0;
      if (mdFiles.length > 0) {
        const r = await api.importFiles(dest, mdFiles, false);
        count += r.imported.length;
      }
      if (otherFiles.length > 0) {
        const r = await api.importFiles(dest, otherFiles, true);
        count += r.imported.length;
      }
      if (count > 0) {
        const { useFileStore } = await import("./fileStore");
        await useFileStore.getState().refreshTree(dir);
      }
    } catch { }
  },

  reloadOpenFile: async () => {
    const { useEditorStore } = await import("./editorStore");
    const editor = useEditorStore.getState();
    if (!editor.selectedPath || editor.dirty) return;
    const path = editor.selectedPath;
    try {
      const content = await readFileGuarded(path);
      // 窗口期内有用户输入或另一次切换：放弃写入
      if (content === null) return;
      await applyLoadedDoc(path, content);
    } catch {
      // 文件已被删除：移除过期标签并加载相邻标签
      set((s) => {
        const idx = s.tabs.findIndex((t) => t.path === path);
        if (idx < 0) return {};
        const next = s.tabs.filter((_, i) => i !== idx);
        if (next.length === 0) {
          void resetEditor();
          return { tabs: [], activeTabIdx: 0 };
        }
        return { tabs: next, activeTabIdx: Math.min(idx, next.length - 1) };
      });
      const { tabs, activeTabIdx } = get();
      const newTab = tabs[activeTabIdx];
      if (newTab && newTab.path !== path) {
        try {
          const c = await readFileGuarded(newTab.path);
          if (c !== null) await applyLoadedDoc(newTab.path, c);
        } catch { /* 保留现状 */ }
      }
    }
  },

  openDailyNote: async () => {
    try {
      const { useAppStore } = await import("./appStore");
      const dir = useAppStore.getState().notesDir;
      if (!dir) return;
      const today = new Date().toISOString().slice(0, 10);
      const dailyDir = `${dir}/daily`;
      await api.ensureDir(dailyDir);
      const path = `${dailyDir}/${today}.md`;
      try {
        await api.readFile(path);
      } catch {
        await api.writeFile(path, `# ${today}\n\n`);
        const { useFileStore } = await import("./fileStore");
        await useFileStore.getState().refreshTree(dir);
      }
      await get().openFileByPath(path);
    } catch { }
  },

  closeTab: async (idx) => {
    const { tabs, activeTabIdx } = get();
    const closed = tabs[idx];
    // 空标签/越界守卫
    if (!closed) return;

    const { useEditorStore } = await import("./editorStore");
    const editor = useEditorStore.getState();

    if (idx === activeTabIdx && editor.dirty && editor.selectedPath) {
      // 外部文件同样弹确认：外部文件永不自动保存，直接关闭会丢全部编辑
      const { useUiStore } = await import("./uiStore");
      const choice = await useUiStore.getState().showCloseDialog();
      if (choice === "cancel") return;
      if (choice === "save") {
        try {
          await editor.saveCurrent();
        } catch {
          return;
        }
      }
    }

    const wasActive = idx === activeTabIdx;
    const closedPath = editor.selectedPath;
    // 关闭即放弃内存快照：重新打开走读盘拿到磁盘最新内容
    dropTabSnapshot(closed.path);
    set((s) => {
      const next = s.tabs.filter((_, i) => i !== idx);
      const closedTabs = [...s.closedTabs, closed.path].slice(-20);
      if (next.length === 0) {
        void resetEditor();
        return { tabs: [], activeTabIdx: 0, closedTabs };
      }
      const newActive = activeTabIdx >= next.length
        ? next.length - 1
        : Math.max(0, activeTabIdx - (idx < activeTabIdx ? 1 : 0));
      return { tabs: next, activeTabIdx: newActive, closedTabs };
    });

    // 关闭的是活动标签：加载新活动标签内容并同步 selectedPath（优先内存快照）
    if (wasActive) {
      const { tabs: nextTabs, activeTabIdx: newIdx } = get();
      const newTab = nextTabs[newIdx];
      if (newTab && newTab.path !== closedPath) {
        await loadTabContent(newTab.path, ++switchEpoch);
      }
    }
  },

  switchTab: async (idx) => {
    const { tabs, activeTabIdx } = get();
    if (idx === activeTabIdx) return;
    const tab = tabs[idx];
    if (!tab) return;

    const epoch = ++switchEpoch;
    // 高亮立即响应；内容优先内存快照恢复，未命中异步读盘补齐
    set({ activeTabIdx: idx });

    // 保存当前脏标签（含外部文件——切换会丢弃缓冲）；
    // 保存失败则回退高亮并中止切换，与 openFile 行为对齐，避免丢缓冲
    if (!(await saveDirtyBuffer(false))) {
      if (epoch === switchEpoch) await revertActiveToEditor();
      return;
    }
    if (epoch !== switchEpoch) return;

    // 离开前快照当前标签，供切回时免读盘恢复
    await snapshotCurrentTab();

    const ok = await loadTabContent(tab.path, epoch);
    if (!ok || epoch !== switchEpoch) return;
  },

  closeOthers: async (idx) => {
    const { tabs, activeTabIdx } = get();
    const keep = tabs[idx];
    if (!keep) return;

    // 保留标签之外的内存快照一并丢弃
    for (const key of [...tabSnapshots.keys()]) {
      if (key !== keep.path) dropTabSnapshot(key);
    }

    if (idx === activeTabIdx) {
      // 保留活动标签：直接裁剪
      set({ tabs: [keep], activeTabIdx: 0 });
      return;
    }

    // 活动标签将被关闭：先走保存流程，保存失败则中止整个操作
    if (!(await saveDirtyBuffer(false))) return;
    set({ tabs: [keep], activeTabIdx: 0 });
    // 加载保留标签内容并同步 selectedPath/activeTabIdx（优先内存快照）
    const ok = await loadTabContent(keep.path, ++switchEpoch);
    if (!ok) {
      // 保留标签已不可用（被 loadTabContent 移除或加载中止）：清空编辑器
      const { tabs: cur } = get();
      if (cur.length === 0) await resetEditor();
    }
  },

  closeRight: async (idx) => {
    const { tabs, activeTabIdx } = get();
    if (!tabs[idx]) return;

    // 被裁掉标签的内存快照一并丢弃
    for (const t of tabs.slice(idx + 1)) dropTabSnapshot(t.path);

    if (activeTabIdx <= idx) {
      // 活动标签保留：直接裁剪右侧
      set((s) => ({ tabs: s.tabs.slice(0, idx + 1), activeTabIdx: s.activeTabIdx }));
      return;
    }

    // 活动标签将被关闭：先走保存流程，保存失败则中止整个操作
    if (!(await saveDirtyBuffer(false))) return;
    set((s) => ({ tabs: s.tabs.slice(0, idx + 1), activeTabIdx: idx }));
    // 加载保留的末尾标签内容并同步 selectedPath/activeTabIdx（优先内存快照）
    const keep = get().tabs[idx];
    if (keep) {
      const ok = await loadTabContent(keep.path, ++switchEpoch);
      if (!ok) {
        const { tabs: cur } = get();
        if (cur.length === 0) await resetEditor();
      }
    }
  },

  reopenTab: () => {
    const { closedTabs } = get();
    if (closedTabs.length === 0) return;
    const lastClosed = closedTabs[closedTabs.length - 1];
    set((s) => ({ closedTabs: s.closedTabs.slice(0, -1) }));
    get().openFileByPath(lastClosed);
  },

  handleExternalDrop: async (paths, targetDir) => {
    const { useAppStore } = await import("./appStore");
    const notesDir = useAppStore.getState().notesDir;
    if (!notesDir) return;
    const dest = targetDir || notesDir;

    const mdFiles = paths.filter((p) => p.toLowerCase().endsWith(".md"));
    const otherFiles = paths.filter((p) => !p.toLowerCase().endsWith(".md"));

    let firstPath: string | null = null;
    if (mdFiles.length > 0) {
      const r = await api.importFiles(dest, mdFiles, false);
      if (r.imported.length > 0) firstPath = r.imported[0].path;
    }
    if (otherFiles.length > 0) {
      await api.importFiles(dest, otherFiles, true);
    }
    const { useFileStore } = await import("./fileStore");
    await useFileStore.getState().refreshTree(notesDir);

    if (firstPath) {
      await get().openFileByPath(firstPath);
    }
  },
}));
