import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  CheckSquare, FileText, Link, List, Maximize2, Minimize2, Tags, X,
} from "lucide-react";
import { api } from "@/lib/tauri";
import { cn, countWords, isExternalPath } from "@/lib/utils";
import { isMac, shortcut } from "@/lib/platform";
import { collectNotes } from "@/lib/noteCompletion";
import { filterTreeByPaths } from "@/lib/tagFilter";
import { useTheme } from "@/hooks/useTheme";
import { useToast } from "@/components/ui/toast";
import { ContextMenu } from "@/components/ui/context-menu";
import { MenuBar } from "@/components/MenuBar";
import { TitleBar } from "@/components/TitleBar";
import { Sidebar } from "@/components/Sidebar";
import type { EditorPanelHandle } from "@/components/Editor";
const EditorPanel = lazy(() => import("@/components/Editor").then((m) => ({ default: m.EditorPanel })));
import { BacklinksPanel } from "@/components/BacklinksPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { EmojiPicker } from "@/components/EmojiPicker";
import { OutlinePanel } from "@/components/OutlinePanel";
import { TabBar } from "@/components/TabBar";
import { TagPanel } from "@/components/TagPanel";
import { FrontmatterPanel } from "@/components/FrontmatterPanel";
import { TodoPanel } from "@/components/TodoPanel";
import { StatusBar } from "@/components/StatusBar";
import { Onboarding } from "@/components/Onboarding";
import { AuthDialog } from "@/components/AuthDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { Dialog } from "@/components/ui/dialog";
import { listenMenuEvents } from "@/lib/menuEvents";

// Stores
import { useAppStore } from "@/stores/appStore";
import { useEditorStore } from "@/stores/editorStore";
import { useFileStore } from "@/stores/fileStore";
import { useTabStore } from "@/stores/tabStore";
import { useUiStore } from "@/stores/uiStore";

// Effect hooks
import { useAutoSave } from "@/hooks/useAutoSave";
import { useSyncTimer } from "@/hooks/useSyncTimer";
import { useWindowFocusSync } from "@/hooks/useWindowFocusSync";
import { useGlobalKeyboard } from "@/hooks/useGlobalKeyboard";
import { useCloseConfirmation } from "@/hooks/useCloseConfirmation";
import { useGitAutoCommit } from "@/hooks/useGitAutoCommit";
import { useTabLifecycle } from "@/hooks/useTabLifecycle";
import { useAppShell } from "@/hooks/useAppShell";
import { useDragAndDrop } from "@/hooks/useDragAndDrop";
import { useFileTreeCallbacks } from "@/hooks/useFileTreeCallbacks";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";

// Menus
import { buildMenuGroups } from "@/menus/appMenu";
import { buildEditorContextMenu } from "@/menus/editorContextMenu";

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

export default function App() {
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  useUpdateCheck(toast);

  // 关于对话框的应用版本：运行时读取，避免硬编码随版本升级漏改
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => { /* 纯前端 dev 环境无 Tauri runtime */ });
  }, []);

  // DOM refs
  const editorRef = useRef<EditorPanelHandle>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // === Store subscriptions ===
  const initializing = useAppStore((s) => s.initializing);
  const showOnboarding = useAppStore((s) => s.showOnboarding);
  const defaultDir = useAppStore((s) => s.defaultDir);
  const notesDir = useAppStore((s) => s.notesDir);
  const config = useAppStore((s) => s.config);
  const git = useAppStore((s) => s.git);
  const gitAvailable = useAppStore((s) => s.gitAvailable);
  const syncState = useAppStore((s) => s.syncState);
  const syncError = useAppStore((s) => s.syncError);
  const pending = useAppStore((s) => s.pending);
  const lastSyncAt = useAppStore((s) => s.lastSyncAt);
  const conflictBanner = useAppStore((s) => s.conflictBanner);
  const pandocAvailable = useAppStore((s) => s.pandocAvailable);

  const doc = useEditorStore((s) => s.doc);
  const selectedPath = useEditorStore((s) => s.selectedPath);
  const mode = useEditorStore((s) => s.mode);
  const saveState = useEditorStore((s) => s.saveState);
  const cursorLine = useEditorStore((s) => s.cursorLine);
  const jumpTarget = useEditorStore((s) => s.jumpTarget);
  const docEpoch = useEditorStore((s) => s.docEpoch);

  const rootChildren = useFileStore((s) => s.rootChildren);
  const collapsed = useFileStore((s) => s.collapsed);
  const renamingPath = useFileStore((s) => s.renamingPath);
  const backlinks = useFileStore((s) => s.backlinks);
  const tagList = useFileStore((s) => s.tagList);

  const tabs = useTabStore((s) => s.tabs);
  const activeTabIdx = useTabStore((s) => s.activeTabIdx);
  const recentPaths = useTabStore((s) => s.recentPaths);

  const focusMode = useUiStore((s) => s.focusMode);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const tabBarVisible = useUiStore((s) => s.tabBarVisible);
  const zoomLevel = useUiStore((s) => s.zoomLevel);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const aboutOpen = useUiStore((s) => s.aboutOpen);
  const updateDialogOpen = useUiStore((s) => s.updateDialogOpen);
  const updateDialogState = useUiStore((s) => s.updateDialogState);
  const updateLatestVersion = useUiStore((s) => s.updateLatestVersion);
  const updateLatestUrl = useUiStore((s) => s.updateLatestUrl);
  const closeDialogOpen = useUiStore((s) => s.closeDialogOpen);
  const authPrompt = useUiStore((s) => s.authPrompt);
  const authReason = useUiStore((s) => s.authReason);
  const pandocDialogOpen = useUiStore((s) => s.pandocDialogOpen);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const emojiOpen = useUiStore((s) => s.emojiOpen);
  const templatePickerOpen = useUiStore((s) => s.templatePickerOpen);
  const templateList = useUiStore((s) => s.templateList);
  const outlineOpen = useUiStore((s) => s.outlineOpen);
  const backlinksOpen = useUiStore((s) => s.backlinksOpen);
  const tagsOpen = useUiStore((s) => s.tagsOpen);
  const activeTag = useUiStore((s) => s.activeTag);
  const frontmatterPanelOpen = useUiStore((s) => s.frontmatterPanelOpen);
  const todoPanelOpen = useUiStore((s) => s.todoPanelOpen);
  const menu = useUiStore((s) => s.menu);
  const dragging = useUiStore((s) => s.dragging);
  const dragPos = useUiStore((s) => s.dragPos);
  const dropTarget = useUiStore((s) => s.dropTarget);
  const externalDragZone = useUiStore((s) => s.externalDragZone);

  // === Effect hooks ===
  useTabLifecycle();           // tab 加载 → bootstrap → 持久化（有先后依赖，封装在一个 hook 中）
  useAutoSave();
  useSyncTimer();
  useWindowFocusSync();
  useGlobalKeyboard(editorRef);
  useCloseConfirmation();
  useGitAutoCommit();
  useAppShell();               // 窗口显示 / 缩放 / DPI / 焦点模式
  useDragAndDrop(sidebarRef, editorRef);  // 内部拖拽 + 外部文件拖入

  // EditorPanel 的 extensions memo 依赖这两个回调：传内联箭头会让 App
  // 每次重渲染（自动保存状态每 2 秒翻转）都触发 CM 全量 reconfigure +
  // livePreview 全文重建。回调只操作 store（无组件状态依赖），
  // 用空依赖 useCallback 稳定引用。
  const handleCursorLine = useCallback((line: number) => {
    useEditorStore.setState({ cursorLine: line });
  }, []);
  const handleEmojiTrigger = useCallback(() => {
    useUiStore.setState({ emojiOpen: true });
  }, []);

  // loadTags on tree change
  useEffect(() => {
    if (notesDir) useFileStore.getState().loadTags();
  }, [notesDir, rootChildren]);

  // 反向链接：仅在面板打开时扫描（懒加载，避免每次切换标签都全库扫描）。
  // 选中文件变化 / 文件树增删改名 / git 同步完成后刷新，保证面板不陈旧。
  useEffect(() => {
    if (backlinksOpen && selectedPath) {
      useFileStore.getState().loadBacklinks(selectedPath);
    }
  }, [backlinksOpen, selectedPath, lastSyncAt, rootChildren]);

  // Clear jump target when switching files
  useEffect(() => {
    useEditorStore.setState({ jumpTarget: null });
  }, [selectedPath, docEpoch]);

  // Sync active tab dirty status on tab switch
  useEffect(() => {
    if (tabs.length === 0) return;
    const { dirty } = useEditorStore.getState();
    useTabStore.setState((s) => ({
      tabs: s.tabs.map((t, i) =>
        i === activeTabIdx ? { ...t, dirty } : t
      ),
    }));
  }, [activeTabIdx]);

  // Sync active tab dirty status on doc/selectedPath change
  useEffect(() => {
    if (!selectedPath) return;
    const isDirty = doc !== useEditorStore.getState().lastSavedDoc;
    useTabStore.setState((s) => {
      if (s.tabs[activeTabIdx] && s.tabs[activeTabIdx].dirty !== isDirty) {
        return {
          tabs: s.tabs.map((t, i) =>
            i === activeTabIdx ? { ...t, dirty: isDirty } : t
          ),
        };
      }
      return {};
    });
  }, [doc, selectedPath, activeTabIdx]);

  // Recent paths
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("notes-recent-paths") || "[]");
      if (saved.length > 0) {
        useTabStore.setState({ recentPaths: saved });
      }
    } catch {}
  }, []);

  // 首次启动：文件管理器"打开方式"传入的 .md 路径在 Rust 端 OPENED_FILE 中，需主动拉取。
  // 必须等 bootstrap 完成（initializing=false，恢复上次标签）后再打开，
  // 否则 openFileByPath 的 readFileGuarded 快照会被 bootstrap 的 applyLoadedDoc 改变而放弃打开
  useEffect(() => {
    if (initializing) return;
    api
      .getOpenedFile()
      .then((path) => {
        if (path) {
          useTabStore.getState().openFileByPath(path).catch((e) => toast(`无法打开外部文件：${e}`));
        }
      })
      .catch(() => {});
  }, [initializing, toast]);

  // 桌面双击 / 右键"打开方式" → 已在运行的实例接收文件路径
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("open-external-file", (event) => {
      const path = event.payload;
      useTabStore.getState().openFileByPath(path).catch((e) =>
        toast(`无法打开外部文件：${e}`),
      );
    }).then((fn) => {
      unlisten = fn;
    });
    return () => { unlisten?.(); };
  }, [toast]);

  // === macOS native menu events ===
  useEffect(() => {
    if (!isMac) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    listenMenuEvents((action) => {
      switch (action) {
        case "undo": editorRef.current?.undo(); break;
        case "redo": editorRef.current?.redo(); break;
        case "find": editorRef.current?.focusSearch(); break;
        case "newNote": {
          const nDir = useAppStore.getState().notesDir;
          if (nDir) api.listTemplates(nDir).then((tmpl) => {
            if (tmpl.length > 0) { useUiStore.setState({ templateList: tmpl, templatePickerOpen: true }); }
            else useFileStore.getState().createNoteAt(nDir).then((p) => useTabStore.getState().openFileByPath(p));
          }).catch(() => useFileStore.getState().createNoteAt(nDir).then((p) => useTabStore.getState().openFileByPath(p)));
          break;
        }
        case "newFolder": {
          const nDir = useAppStore.getState().notesDir;
          if (nDir) useFileStore.getState().createDirAt(nDir);
          break;
        }
        case "save": useEditorStore.getState().saveCurrent(); break;
        case "saveAs": useEditorStore.getState().handleSaveAs(); break;
        case "openNotesDir": { if (useAppStore.getState().notesDir) api.revealInFolder(useAppStore.getState().notesDir!); break; }
        case "openFile": useTabStore.getState().openExternalFile(); break;
        case "importFiles": useTabStore.getState().importExternalFiles(); break;
        case "exportHtml": useEditorStore.getState().handleExport("html", toast); break;
        case "exportPdf": useEditorStore.getState().handleExport("pdf", toast); break;
        case "exportPng": useEditorStore.getState().handleExport("png", toast); break;
        case "exportDocx": useEditorStore.getState().handleExport("docx", toast); break;
        case "exportEpub": useEditorStore.getState().handleExport("epub", toast); break;
        case "exportLatex": useEditorStore.getState().handleExport("latex", toast); break;
        case "print": useEditorStore.getState().handlePrint(toast); break;
        case "openSettings": useUiStore.setState({ settingsOpen: true }); break;
        case "commandPalette": useUiStore.setState({ paletteOpen: true }); break;
        case "toggleSidebar": useUiStore.getState().toggleSidebar(); break;
        case "toggleLivePreview": useEditorStore.setState((s) => ({ mode: s.mode === "wysiwyg" ? "source" : "wysiwyg" })); break;
        case "zoomIn": useUiStore.setState((s) => ({ zoomLevel: Math.min(s.zoomLevel + 1, 5) })); break;
        case "zoomOut": useUiStore.setState((s) => ({ zoomLevel: Math.max(s.zoomLevel - 1, -3) })); break;
        case "zoomReset": useUiStore.setState({ zoomLevel: 0 }); break;
        case "toggleDarkMode": setTheme((t) => (t === "dark" ? "light" : "dark")); break;
        case "formatBold": editorRef.current?.toggleMark("**"); break;
        case "formatItalic": editorRef.current?.toggleMark("*"); break;
        case "formatStrikethrough": editorRef.current?.toggleMark("~~"); break;
        case "formatInlineCode": editorRef.current?.toggleMark("`"); break;
        case "formatLink": editorRef.current?.toggleLink(); break;
        case "formatHeading1": editorRef.current?.toggleHeading(1); break;
        case "formatHeading2": editorRef.current?.toggleHeading(2); break;
        case "formatHeading3": editorRef.current?.toggleHeading(3); break;
        case "formatBulletList": editorRef.current?.toggleBulletList(); break;
        case "formatOrderedList": editorRef.current?.toggleOrderedList(); break;
        case "formatTaskList": editorRef.current?.toggleTaskList(); break;
        case "formatBlockquote": editorRef.current?.toggleBlockquote(); break;
        case "formatCodeBlock": editorRef.current?.toggleCodeBlock(); break;
        case "formatInsertTable": editorRef.current?.insertTable(); break;
        case "formatHorizontalRule": editorRef.current?.insertMarkdown("\n---\n"); break;
        case "formatEmoji": useUiStore.setState({ emojiOpen: true }); break;
        case "syncNow": useAppStore.getState().syncNow(); break;
        case "commitAll": {
          const dir = useAppStore.getState().notesDir;
          if (dir) api.gitCommitAll(dir, "chore: manual commit").then((committed) => {
            if (committed) { toast("已提交所有更改"); useFileStore.getState().refreshTree(dir); }
          }).catch((e) => toast(`提交失败：${e}`));
          break;
        }
        case "syncSettings": useUiStore.setState({ settingsOpen: true }); break;
        case "about": useUiStore.setState({ aboutOpen: true }); break;
        case "userAgreement": {
          api.getResourcePath("用户协议.md")
            .then(async (path) => {
              await useTabStore.getState().openFileByPath(path);
              useTabStore.setState((s) => ({
                tabs: s.tabs.map((t) =>
                  t.path === path ? { ...t, readOnly: true } : t,
                ),
              }));
            })
            .catch((e) => toast(`无法打开用户协议：${e}`));
          break;
        }
        case "privacyPolicy": {
          api.getResourcePath("隐私政策.md")
            .then(async (path) => {
              await useTabStore.getState().openFileByPath(path);
              useTabStore.setState((s) => ({
                tabs: s.tabs.map((t) =>
                  t.path === path ? { ...t, readOnly: true } : t,
                ),
              }));
            })
            .catch((e) => toast(`无法打开隐私政策：${e}`));
          break;
        }
        case "mcpGuide": {
          api.getResourcePath("MCP 配置指南.md")
            .then(async (path) => {
              await useTabStore.getState().openFileByPath(path);
              useTabStore.setState((s) => ({
                tabs: s.tabs.map((t) =>
                  t.path === path ? { ...t, readOnly: true } : t,
                ),
              }));
            })
            .catch((e) => toast(`无法打开 MCP 配置指南：${e}`));
          break;
        }
      }
    }).then((fn) => { if (cancelled) fn(); else cleanup = fn; });
    return () => { cancelled = true; cleanup?.(); };
  }, []);

  // === Derived data ===
  const noteItems = useMemo(() => collectNotes(rootChildren), [rootChildren]);
  // 标签筛选：activeTag 命中时只把带该标签的笔记（及其祖先目录）显示在侧边栏。
  // 集合按 tagList 构造，树过滤是纯函数，rootChildren / tagList 未变时结果稳定。
  const tagKeepPaths = useMemo(() => {
    if (!activeTag) return null;
    const info = tagList.find((t) => t.tag === activeTag);
    return new Set(info?.files ?? []);
  }, [activeTag, tagList]);
  const visibleChildren = useMemo(
    () => (tagKeepPaths ? filterTreeByPaths(rootChildren, tagKeepPaths) : rootChildren),
    [rootChildren, tagKeepPaths],
  );
  // 字数统计防抖：countWords 单遍扫描在 5MB 大文档上 ~13ms，
  // 停笔 300ms 后再算即可（避免持续击键时反复全文扫描）
  const [wordCount, setWordCount] = useState(() => countWords(doc));
  useEffect(() => {
    const timer = setTimeout(() => setWordCount(countWords(doc)), 300);
    return () => clearTimeout(timer);
  }, [doc]);
  const activeTab = tabs[activeTabIdx];
  const fileName = selectedPath?.split("/").pop() ?? null;

  // === File tree callbacks ===
  const tree = useFileTreeCallbacks(toast);

  // === Menu groups ===
  const menuGroups = useMemo(
    () => buildMenuGroups(pandocAvailable, editorRef, toast, setTheme),
    [pandocAvailable, selectedPath],
  );

  // === Render ===
  if (showOnboarding) {
    return (
      <div className="flex flex-col h-full bg-editor text-foreground">
        {!isMac && (
          <TitleBar menuGroups={[]} fileName={null} onClose={() => {
            getCurrentWindow().close();
          }} />
        )}
        <Onboarding
          defaultDir={defaultDir ?? ""}
          onDone={(dir) => {
            useAppStore.getState().handleOnboardingDone(dir).catch((e) => toast(String(e)));
          }}
        />
      </div>
    );
  }

  if (initializing) {
    return <div className="flex h-full items-center justify-center bg-editor" />;
  }

  return (
    <div className="flex flex-col h-full bg-editor text-foreground">
      {!isMac && (
        <div className={cn(
          "transition-all duration-300 ease-out",
          focusMode ? "h-0 overflow-hidden" : "h-auto overflow-visible"
        )}>
          <TitleBar menuGroups={menuGroups} fileName={fileName} onClose={() => {
            getCurrentWindow().close();
          }} />
        </div>
      )}
      <div className="flex flex-1 min-h-0">
      <div
        ref={sidebarRef}
        className={cn(
          "h-full shrink-0 overflow-hidden transition-all duration-300 ease-out",
          (!focusMode && sidebarVisible) ? "w-64" : "w-0"
        )}
      >
        <Sidebar
          rootChildren={visibleChildren}
          filterTag={activeTag}
          onClearTag={() => useUiStore.setState({ activeTag: null })}
          collapsed={collapsed}
          selectedPath={selectedPath}
          renamingPath={renamingPath}
          dropTarget={dropTarget}
          onToggle={tree.onToggle}
          onSelect={tree.onSelect}
          onNodeContextMenu={tree.onNodeContextMenu}
          onBlankContextMenu={tree.onBlankContextMenu}
          onRenameSubmit={tree.onRenameSubmit}
          onRenameCancel={tree.onRenameCancel}
          onNewNoteIn={tree.onNewNoteIn}
          onMoreMenu={tree.onMoreMenu}
          onNewNote={tree.onNewNote}
          onNewDir={tree.onNewDir}
          onOpenSettings={tree.onOpenSettings}
          onNodeDragStart={tree.onNodeDragStart}
          onNodeDragEnd={tree.onNodeDragEnd}
          onDirDragOver={tree.onDirDragOver}
          onDropOnDir={tree.onDropOnDir}
          onDropToRoot={tree.onDropToRoot}
        />
      </div>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "flex h-9 shrink-0 items-center bg-sidebar",
            focusMode && "fixed top-0 left-0 right-0 z-50 transition-transform duration-200 ease-out",
            focusMode && (tabBarVisible ? "translate-y-0" : "-translate-y-full")
          )}
        >
          <TabBar
            tabs={tabs}
            activeIdx={activeTabIdx}
            onSelect={(idx) => useTabStore.getState().switchTab(idx)}
            onClose={(idx) => useTabStore.getState().closeTab(idx)}
            onCloseOthers={(idx) => useTabStore.getState().closeOthers(idx)}
            onCloseRight={(idx) => useTabStore.getState().closeRight(idx)}
          />
          <div className="flex-1" />
          {selectedPath && !focusMode && (
            <div className="flex items-center gap-1 px-2">
              {cursorLine != null && (
                <span className="text-[10px] text-secondary mr-1">L{cursorLine}</span>
              )}
              <button className={cn("flex h-6 w-6 items-center justify-center rounded text-xs transition-colors", outlineOpen ? "bg-accent-soft text-accent" : "text-secondary hover:text-foreground")}
                onClick={() => useUiStore.setState((s) => ({ outlineOpen: !s.outlineOpen }))} title="大纲 (Cmd+Shift+O)"><List size={13} /></button>
              <button className={cn("flex h-6 w-6 items-center justify-center rounded text-xs transition-colors", backlinksOpen ? "bg-accent-soft text-accent" : "text-secondary hover:text-foreground")}
                onClick={() => useUiStore.setState((s) => ({ backlinksOpen: !s.backlinksOpen }))} title="反向链接"><Link size={13} /></button>
              <button className={cn("flex h-6 w-6 items-center justify-center rounded text-xs transition-colors", tagsOpen ? "bg-accent-soft text-accent" : "text-secondary hover:text-foreground")}
                onClick={() => useUiStore.setState((s) => ({ tagsOpen: !s.tagsOpen }))} title="标签 (Cmd+Shift+G)"><Tags size={13} /></button>
              <button className={cn("flex h-6 w-6 items-center justify-center rounded text-xs transition-colors", frontmatterPanelOpen ? "bg-accent-soft text-accent" : "text-secondary hover:text-foreground")}
                onClick={() => useUiStore.setState((s) => ({ frontmatterPanelOpen: !s.frontmatterPanelOpen }))} title="元数据 (Cmd+Shift+M)"><FileText size={13} /></button>
              <button className={cn("flex h-6 w-6 items-center justify-center rounded text-xs transition-colors", todoPanelOpen ? "bg-accent-soft text-accent" : "text-secondary hover:text-foreground")}
                onClick={() => useUiStore.setState((s) => ({ todoPanelOpen: !s.todoPanelOpen }))} title="待办 (Cmd+Shift+D)"><CheckSquare size={13} /></button>
              <button className={cn("flex h-6 w-6 items-center justify-center rounded text-xs transition-colors", focusMode ? "bg-accent-soft text-accent" : "text-secondary hover:text-foreground")}
                onClick={() => useUiStore.getState().toggleFocusMode()} title="专注模式 (Cmd+Shift+F)">
                {focusMode ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
            </div>
          )}
          {focusMode && (
            <button className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-secondary hover:text-foreground hover:bg-hover transition-colors mr-2"
              onClick={() => useUiStore.getState().toggleFocusMode()} title="退出专注模式 (Esc)"><Minimize2 size={13} /></button>
          )}
        </div>

        {conflictBanner !== null && !focusMode && (
          <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-yellow-500/10 px-4 py-2 text-xs text-yellow-700 dark:text-yellow-300">
            <span>{conflictBanner} 个文件在其他设备修改，已另存为 conflict 副本</span>
            <button className="rounded p-0.5 hover:bg-hover" onClick={() => useAppStore.setState({ conflictBanner: null })}><X size={12} /></button>
          </div>
        )}

        <Suspense fallback={<div className="flex-1 bg-editor" />}>
          {selectedPath ? (
            <EditorPanel
              ref={editorRef}
              content={doc}
              mode={mode}
              assetBase={selectedPath.substring(0, selectedPath.lastIndexOf("/")) || "/"}
              notes={noteItems}
              notesDir={notesDir ?? undefined}
              currentFilePath={selectedPath}
              onChange={(newDoc) => useEditorStore.getState().setDoc(newDoc)}
              onContextMenu={(e) => {
                e.preventDefault();
                const entries = buildEditorContextMenu(e, editorRef, toast);
                useUiStore.setState({ menu: { x: e.clientX, y: e.clientY, entries } });
              }}
              onCursorLine={handleCursorLine}
              jumpTarget={jumpTarget}
              onEmojiTrigger={handleEmojiTrigger}
              readOnly={tabs[activeTabIdx]?.readOnly}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-secondary">
              <p>选择或新建一篇笔记开始写作</p>
              <button className="rounded-lg border border-border px-4 py-2 text-[14px] text-foreground hover:bg-hover hover-transition"
                onClick={() => { const dir = useAppStore.getState().notesDir; if (dir) useFileStore.getState().createNoteAt(dir).then((p) => useTabStore.getState().openFileByPath(p)); }}>
                新建笔记（{shortcut("⌘N")}）
              </button>
            </div>
          )}
        </Suspense>

        {externalDragZone === "editor" && (
          <div className="pointer-events-none absolute inset-2 z-40 rounded-xl border-2 border-dashed border-accent bg-accent-soft/40" />
        )}

        <div className={cn("shrink-0 overflow-hidden transition-all duration-300 ease-out", focusMode ? "h-0" : "h-10")}>
          <StatusBar words={wordCount} git={git} gitAvailable={gitAvailable}
            saveState={saveState} syncState={syncState} syncError={syncError}
            pending={pending} lastSyncAt={lastSyncAt} editorMode={mode}
            onToggleEditorMode={() => useEditorStore.setState((s) => ({ mode: s.mode === "wysiwyg" ? "source" : "wysiwyg" }))}
            sidebarVisible={sidebarVisible}
            onToggleSidebar={() => useUiStore.getState().toggleSidebar()}
            external={activeTab?.external ?? false}
            readOnly={activeTab?.readOnly ?? false} />
        </div>
      </main>

      {outlineOpen && selectedPath && (
        <OutlinePanel doc={doc} activeLine={cursorLine}
          onJump={(line) => editorRef.current?.scrollToLine(line)}
          onClose={() => useUiStore.setState({ outlineOpen: false })} />
      )}
      {backlinksOpen && selectedPath && (
        <BacklinksPanel backlinks={backlinks}
          onJump={(path, line) => {
            if (path === selectedPath) editorRef.current?.scrollToLine(line);
            else { useEditorStore.setState({ jumpTarget: line }); useTabStore.getState().openFile({ name: baseName(path), path, isDir: false, children: [] }); }
          }}
          onClose={() => useUiStore.setState({ backlinksOpen: false })} />
      )}
      {tagsOpen && notesDir && (
        <TagPanel tags={tagList} activeTag={activeTag}
          onSelectTag={(tag) => useUiStore.setState({ activeTag: tag })}
          onClearTag={() => useUiStore.setState({ activeTag: null })}
          onClose={() => useUiStore.setState({ tagsOpen: false })} />
      )}
      {frontmatterPanelOpen && selectedPath && (
        <FrontmatterPanel doc={doc}
          onChange={(newDoc) => { useEditorStore.setState({ doc: newDoc, lastSavedDoc: newDoc, dirty: true }); }}
          onClose={() => useUiStore.setState({ frontmatterPanelOpen: false })} />
      )}
      {todoPanelOpen && notesDir && (
        <TodoPanel notesDir={notesDir} currentFilePath={selectedPath}
          onJump={(path, line) => {
            if (path === selectedPath) editorRef.current?.scrollToLine(line);
            else { useEditorStore.setState({ jumpTarget: line }); useTabStore.getState().openFile({ name: baseName(path), path, isDir: false, children: [] }); }
          }}
          onClose={() => useUiStore.setState({ todoPanelOpen: false })} />
      )}

      {templatePickerOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30" onClick={() => useUiStore.setState({ templatePickerOpen: false })}>
          <div className="w-80 rounded-2xl border border-border bg-editor shadow-lg-soft p-5 animate-dialog-in" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium mb-3">选择模板</p>
            <div className="max-h-60 overflow-y-auto space-y-1 mb-3">
              <button className="flex w-full items-center gap-2 rounded-lg px-4 py-2.5 text-left text-sm hover:bg-hover" onClick={() => {
                useUiStore.setState({ templatePickerOpen: false });
                const dir = useAppStore.getState().notesDir;
                if (dir) useFileStore.getState().createNoteAt(dir).then((p) => useTabStore.getState().openFileByPath(p));
              }}>空笔记</button>
              {templateList.map((t) => (
                <button key={t.path} className="flex w-full items-center gap-2 rounded-lg px-4 py-2.5 text-left text-sm hover:bg-hover" onClick={() => {
                  useUiStore.setState({ templatePickerOpen: false });
                  const dir = useAppStore.getState().notesDir;
                  if (dir) useFileStore.getState().createNoteAt(dir, t.path, t.name).then((p) => useTabStore.getState().openFileByPath(p));
                }}>{t.name}</button>
              ))}
            </div>
            <div className="flex justify-end">
              <button className="rounded px-3 py-1.5 text-xs text-secondary hover:text-foreground" onClick={() => useUiStore.setState({ templatePickerOpen: false })}>取消</button>
            </div>
          </div>
        </div>
      )}

      {menu && (<ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => useUiStore.setState({ menu: null })} />)}
      {dragging && (<div className="pointer-events-none fixed z-[95] rounded border border-border bg-editor px-2 py-1 text-xs shadow-overlay" style={{ left: dragPos.x + 12, top: dragPos.y + 12 }}>{dragging.name}</div>)}
      <CommandPalette open={paletteOpen} notes={rootChildren} notesDir={notesDir ?? ""} recentPaths={recentPaths}
        onOpenFile={(path, line) => {
          if (path === useEditorStore.getState().selectedPath && line != null) { editorRef.current?.scrollToLine(line); return; }
          if (line != null) useEditorStore.setState({ jumpTarget: line });
          useTabStore.getState().openFile({ name: baseName(path), path, isDir: false, children: [] });
        }}
        onClose={() => useUiStore.setState({ paletteOpen: false })} />
      <EmojiPicker open={emojiOpen}
        onSelect={(emoji) => editorRef.current?.insertMarkdown(emoji)}
        onClose={() => useUiStore.setState({ emojiOpen: false })} />

      <SettingsDialog open={settingsOpen} onClose={() => useUiStore.setState({ settingsOpen: false })}
        theme={theme} setTheme={setTheme} notesDir={notesDir} config={config}
        reuseTab={config?.reuseTab ?? false}
        onSaveReuseTab={async (v) => { try { await api.setReuseTab(v); useAppStore.setState((s) => ({ config: s.config ? { ...s.config, reuseTab: v } : s.config })); } catch {} }}
        syncState={syncState} lastSyncAt={lastSyncAt}
        onSaveSync={(values) => useAppStore.getState().handleSaveSync(values)}
        onSyncNow={() => useAppStore.getState().syncNow()}
        onChangeDataDir={(dir) => useAppStore.getState().handleChangeDataDir(dir)}
        onConfigureAuth={() => { useUiStore.setState({ authSnoozed: false, authReason: null, authPrompt: true }); }} />

      <Dialog open={closeDialogOpen} onClose={() => { useUiStore.getState().closeDialogResolve?.("cancel"); useUiStore.setState({ closeDialogOpen: false, closeDialogResolve: null }); }}
        title="未保存的改动" width={400}>
        <div className="flex flex-col gap-5">
          <p className="text-[13px] text-secondary leading-relaxed">当前文档有未保存的改动，是否保存后退出？</p>
          <div className="flex items-center justify-end gap-2">
            <button className="rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-hover hover-transition"
              onClick={() => { useUiStore.getState().closeDialogResolve?.("discard"); useUiStore.setState({ closeDialogOpen: false, closeDialogResolve: null }); }}>不保存</button>
            <button className="rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-hover hover-transition"
              onClick={() => { useUiStore.getState().closeDialogResolve?.("cancel"); useUiStore.setState({ closeDialogOpen: false, closeDialogResolve: null }); }}>取消</button>
            <button className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 hover-transition"
              onClick={() => { useUiStore.getState().closeDialogResolve?.("save"); useUiStore.setState({ closeDialogOpen: false, closeDialogResolve: null }); }}>保存</button>
          </div>
        </div>
      </Dialog>

      <Dialog open={aboutOpen} onClose={() => useUiStore.setState({ aboutOpen: false })} title="关于 即记 (Jot)" width={380}>
        <div className="flex flex-col items-center gap-3 text-[13px] text-secondary">
          <div className="text-[22px] font-bold text-foreground">即记 Jot</div>
          <div className="text-[11px]">{appVersion ? `v${appVersion}` : ""}</div>
          <p className="text-center leading-relaxed">基于 git 同步的 Markdown 笔记应用<br />Tauri 2 + React + CodeMirror 6</p>
        </div>
      </Dialog>

      <Dialog
        open={updateDialogOpen}
        onClose={() => useUiStore.setState({ updateDialogOpen: false })}
        title="检查更新"
        width={380}
        footer={
          updateDialogState === "available" ? (
            <>
              <button
                className="rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-hover hover-transition"
                onClick={() => useUiStore.setState({ updateDialogOpen: false })}
              >稍后</button>
              <button
                className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 hover-transition"
                onClick={() => {
                  if (updateLatestUrl) api.openUrl(updateLatestUrl).catch(() => {});
                  useUiStore.setState({ updateDialogOpen: false });
                }}
              >前往下载</button>
            </>
          ) : undefined
        }
      >
        {updateDialogState === "checking" && (
          <p className="text-[13px] text-secondary">正在检查更新…</p>
        )}
        {updateDialogState === "available" && (
          <p className="text-[13px] text-secondary leading-relaxed">
            发现新版本 <span className="font-medium text-foreground">v{updateLatestVersion}</span>
            {appVersion ? <span>（当前 v{appVersion}）</span> : null}
          </p>
        )}
        {updateDialogState === "latest" && (
          <p className="text-[13px] text-secondary">
            当前已是最新版本{appVersion ? ` v${appVersion}` : ""}
          </p>
        )}
        {updateDialogState === "error" && (
          <p className="text-[13px] text-secondary">检查更新失败，请稍后再试</p>
        )}
      </Dialog>

      <AuthDialog open={authPrompt} reason={authReason} initialUsername={config?.username ?? ""} initialToken={config?.token ?? ""}
        onClose={() => { useUiStore.setState({ authPrompt: false, authSnoozed: true }); }}
        onSuccess={() => { useUiStore.setState({ authPrompt: false }); }}
        onSubmit={(user, token) => useAppStore.getState().handleReAuth(user, token)} />

      <ExportDialog open={pandocDialogOpen}
        onClose={() => { useUiStore.getState().pandocDialogResolve?.(false); useUiStore.setState({ pandocDialogOpen: false, pandocDialogResolve: null }); }}
        onInstalled={() => { useAppStore.setState({ pandocAvailable: true }); useUiStore.getState().pandocDialogResolve?.(true); useUiStore.setState({ pandocDialogOpen: false, pandocDialogResolve: null }); }} />
      </div>
    </div>
  );
}
