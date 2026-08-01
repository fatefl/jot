// src/stores/appStore.ts
import { create } from "zustand";
import {
  api,
  type AppConfig,
  type GitStatus,
  type SyncOutcome,
} from "@/lib/tauri";
import type { SyncState } from "@/components/StatusBar";
import type { SyncFormValues } from "@/components/SettingsDialog";
import { normPath } from "@/lib/utils";

export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const SYNC_INTERVAL_MS = 5 * 60_000;

const EMPTY_CONFIG: AppConfig = {
  dataDir: "",
  remoteUrl: "",
  authType: "",
  username: "",
  token: "",
  reuseTab: false,
};

export interface AppState {
  // 配置
  defaultDir: string | null;
  notesDir: string | null;
  config: AppConfig | null;
  showOnboarding: boolean;
  initializing: boolean;
  pandocAvailable: boolean;

  // 同步
  syncState: SyncState;
  syncError: string | null;
  git: GitStatus | null;
  gitAvailable: boolean;
  pending: number;
  lastSyncAt: number | null;
  conflictBanner: number | null;

  // 内部
  syncing: boolean;
  failCount: number;
  lastSyncAttempt: number;

  // 动作
  bootstrap: () => Promise<void>;
  handleOnboardingDone: (dir: string) => Promise<void>;
  handleChangeDataDir: (newDir: string) => Promise<void>;
  handleSaveSync: (values: SyncFormValues) => Promise<void>;
  handleReAuth: (username: string, token: string) => Promise<SyncOutcome>;
  syncNow: () => Promise<SyncOutcome>;

  // 纯工具
  _computeBackoff: (failCount: number) => number;
}

export const useAppStore = create<AppState>()((set, get) => ({
  defaultDir: null,
  notesDir: null,
  config: null,
  showOnboarding: false,
  initializing: true,
  pandocAvailable: true,
  syncState: "local",
  syncError: null,
  git: null,
  gitAvailable: true,
  pending: 0,
  lastSyncAt: null,
  conflictBanner: null,
  syncing: false,
  failCount: 0,
  lastSyncAttempt: 0,

  _computeBackoff: (failCount) => {
    if (failCount <= 0) return SYNC_INTERVAL_MS;
    const idx = Math.min(failCount - 1, BACKOFF_MS.length - 1);
    return BACKOFF_MS[idx];
  },

  bootstrap: async () => {
    try {
      const [cfg, gitOk] = await Promise.all([
        api.getConfig(),
        api.checkGitAvailable(),
      ]);
      // 兼容历史配置/旧二进制：dataDir 统一为 "/" 分隔
      cfg.dataDir = normPath(cfg.dataDir);
      set({
        config: cfg,
        gitAvailable: gitOk,
        defaultDir: cfg.dataDir || null,
      });

      if (cfg.dataDir) {
        const root = await api.listTree(cfg.dataDir);
        const { useFileStore } = await import("./fileStore");
        const { useTabStore } = await import("./tabStore");
        useFileStore.setState({ rootChildren: root.children });
        set({ notesDir: cfg.dataDir });

        const key = `notes-collapsed:${cfg.dataDir}`;
        try {
          const saved = localStorage.getItem(key);
          if (saved) useFileStore.setState({ collapsed: JSON.parse(saved) });
        } catch {}

        // 恢复上次打开的标签页
        const tabs = useTabStore.getState().tabs;
        if (tabs.length > 0) {
          const idx = Math.min(useTabStore.getState().activeTabIdx, tabs.length - 1);
          const tab = tabs[idx];
          if (tab) {
            // openFileByPath 返回 false 表示读取失败（文件已删除等），清理过期标签
            const ok = await useTabStore.getState().openFileByPath(tab.path, tab.name);
            if (ok) {
              set({ initializing: false });
              return;
            }
            useTabStore.setState((s) => {
              const next = s.tabs.filter((_, i) => i !== idx);
              return { tabs: next, activeTabIdx: 0 };
            });
          }
        }

        // 无标签或恢复失败：打开第一个文件
        const first = findFirstFile(root.children);
        if (first) await useTabStore.getState().openFile(first);
      } else {
        set({ showOnboarding: true });
      }
    } catch {
      // 无法读取配置
    }
    set({ initializing: false });
  },

  handleOnboardingDone: async (dir: string) => {
    dir = normPath(dir); // 目录选择器在 Windows 上返回反斜杠路径
    set({ notesDir: dir, showOnboarding: false });
    const key = `notes-collapsed:${dir}`;
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const { useFileStore } = await import("./fileStore");
        useFileStore.setState({ collapsed: JSON.parse(saved) });
      }
    } catch {}

    const root = await api.listTree(dir);
    const { useFileStore } = await import("./fileStore");
    useFileStore.setState({ rootChildren: root.children });
    const { useTabStore } = await import("./tabStore");

    // 恢复标签
    const tabs = useTabStore.getState().tabs;
    if (tabs.length > 0) {
      const idx = Math.min(
        useTabStore.getState().activeTabIdx,
        tabs.length - 1
      );
      const tab = tabs[idx];
      if (tab) {
        // openFileByPath 返回 false 表示恢复失败，落到下面打开第一个文件
        const ok = await useTabStore.getState().openFileByPath(tab.path, tab.name);
        if (ok) return;
      }
    }

    // 打开第一个文件
    const first = findFirstFile(root.children);
    if (first) await useTabStore.getState().openFile(first);
  },

  handleChangeDataDir: async (newDir: string) => {
    newDir = normPath(newDir); // 目录选择器在 Windows 上返回反斜杠路径
    // 切换前保存未保存的编辑（统一走 saveCurrent：公式/图表编辑中由守卫跳过）
    const { useEditorStore } = await import("./editorStore");
    const editor = useEditorStore.getState();
    if (editor.dirty && editor.selectedPath) {
      try {
        await editor.saveCurrent();
      } catch {
        return;
      }
    }
    const st = await api.setDataDir(newDir);
    if (st.empty) await api.initWorkspace(newDir, "local");

    // 清空编辑器 + 标签页状态
    useEditorStore.setState({
      selectedPath: null, doc: "", lastSavedDoc: "", dirty: false,
    });
    const { useTabStore } = await import("./tabStore");
    useTabStore.setState({ tabs: [], activeTabIdx: 0, closedTabs: [] });
    // useTabLifecycle 的持久化 effect 在 tabs 为空时跳过写入，
    // 旧目录的持久化标签必须显式清除，否则下次启动会恢复旧目录的标签
    localStorage.removeItem("notes-open-tabs");
    localStorage.removeItem("notes-active-tab-idx");

    // 重置同步/撤销状态
    set({
      notesDir: newDir, config: { ...(get().config ?? EMPTY_CONFIG), dataDir: newDir },
      conflictBanner: null, syncState: "local", syncError: null,
      pending: 0, lastSyncAt: null, failCount: 0,
    });

    // 在新目录运行 bootstrap
    const root = await api.listTree(newDir);
    const { useFileStore } = await import("./fileStore");
    useFileStore.setState({ rootChildren: root.children });
  },

  handleSaveSync: async (values: SyncFormValues) => {
    await api.saveSyncConfig(values.remoteUrl, values.authType, values.username, values.token);
    const nd = get().notesDir;
    if (nd && values.remoteUrl) {
      await api.setRemote(nd, values.remoteUrl);
    }
    const cfg: AppConfig = {
      ...(get().config ?? EMPTY_CONFIG),
      remoteUrl: values.remoteUrl, authType: values.authType,
      username: values.username, token: values.token,
    };
    set({ config: cfg });
    if (values.remoteUrl) {
      set({ failCount: 0 });
      setTimeout(() => get().syncNow(), 0);
    } else {
      set({ syncState: "local" });
    }
  },

  handleReAuth: async (username: string, token: string) => {
    const cfg = get().config;
    if (!cfg) return { ok: false, message: "未配置" };
    await api.saveSyncConfig(cfg.remoteUrl ?? "", "token", username, token);
    const newCfg: AppConfig = { ...cfg, authType: "token", username, token };
    set({ config: newCfg });
    const { useUiStore } = await import("./uiStore");
    useUiStore.setState({ authSnoozed: false });
    return get().syncNow();
  },

  syncNow: async () => {
    const { notesDir, config, syncing } = get();
    if (!notesDir) return { ok: false, message: "未设置数据目录" };
    if (!config?.remoteUrl) return { ok: false, message: "未配置远程仓库" };
    if (syncing) return { ok: false, message: "同步正在进行中…" };

    // sync 前 flush：git 拉取会改写工作区，先把待写入的脏缓冲落盘
    {
      const { useEditorStore } = await import("./editorStore");
      const ed = useEditorStore.getState();
      if (ed.dirty && ed.selectedPath) {
        try {
          await ed.saveCurrent();
        } catch {
          return { ok: false, message: "保存失败，已取消同步" };
        }
      }
    }

    set({ syncing: true, syncState: "syncing", lastSyncAttempt: Date.now() });
    try {
      // token 不在此处传递——Rust 侧惰性从系统钥匙串读取，避免启动时弹授权框
      const res = await api.gitSync(notesDir, {
        authType: config.authType,
        username: config.username,
        token: "",
      });

      if (res.error) {
        if (res.error.kind === "no_remote") {
          set({ syncState: "local" });
          return { ok: false, message: res.error.message };
        }
        set((s) => ({
          failCount: s.failCount + 1,
          syncState: "offline",
          syncError: res.error!.message,
        }));

        const { useUiStore } = await import("./uiStore");
        const ui = useUiStore.getState();
        if (res.error.kind === "auth" && !ui.authSnoozed) {
          useUiStore.setState({
            authPrompt: true,
            authReason: res.error.message,
          });
        }
        return { ok: false, message: res.error.message };
      }

      if (res.synced) {
        set({
          failCount: 0,
          syncState: "synced",
          syncError: null,
          pending: res.pending,
          lastSyncAt: Date.now(),
        });

        const { useUiStore } = await import("./uiStore");
        useUiStore.setState({ authSnoozed: false });

        if (res.conflicts.length > 0) {
          set({ conflictBanner: res.conflicts.length });
        }

        if (res.pulledChanges || res.conflicts.length > 0) {
          const { useFileStore } = await import("./fileStore");
          await useFileStore.getState().refreshTree(notesDir);
          const { useTabStore } = await import("./tabStore");
          await useTabStore.getState().reloadOpenFile();
          useFileStore.getState().loadTags();
        }
        set({ git: await api.gitStatus(notesDir) });
        return {
          ok: true,
          message:
            res.conflicts.length > 0
              ? `已同步，${res.conflicts.length} 个文件另存为冲突副本`
              : res.pulledChanges
                ? "已同步（拉取了远端改动）"
                : "已同步",
        };
      }
      return { ok: true, message: "没有需要同步的改动" };
    } catch {
      set((s) => ({
        failCount: s.failCount + 1,
        syncState: "offline",
        syncError: "同步请求失败",
      }));
      return { ok: false, message: "同步请求失败" };
    } finally {
      set({ syncing: false });
    }
  },
}));

/** 查找目录树中的第一个文件 */
function findFirstFile(nodes: { name: string; path: string; isDir: boolean; children: any[] }[]): any | null {
  for (const n of nodes) {
    if (!n.isDir) return n;
    const found = findFirstFile(n.children);
    if (found) return found;
  }
  return null;
}
