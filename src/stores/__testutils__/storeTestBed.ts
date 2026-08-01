// src/stores/__testutils__/storeTestBed.ts
import { act } from "@testing-library/react";

// 在测试中动态导入所有 store，这里提供重置函数
const storeInitialStates: Record<string, any> = {
  uiStore: {
    focusMode: false,
    sidebarVisible: true,
    tabBarVisible: false,
    zoomLevel: 0,
    settingsOpen: false,
    aboutOpen: false,
    closeDialogOpen: false,
    closeDialogResolve: null,
    authPrompt: false,
    authReason: null,
    authSnoozed: false,
    pandocDialogOpen: false,
    pandocDialogResolve: null,
    paletteOpen: false,
    emojiOpen: false,
    templatePickerOpen: false,
    templateList: [],
    outlineOpen: false,
    backlinksOpen: false,
    tagsOpen: false,
    activeTag: null,
    frontmatterPanelOpen: false,
    todoPanelOpen: false,
    menu: null,
    dragging: null,
    dragPos: { x: 0, y: 0 },
    dropTarget: null,
    externalDragZone: null,
    externalDropDir: null,
  },
  editorStore: {
    doc: "",
    selectedPath: null,
    docEpoch: 0,
    mode: "wysiwyg",
    saveState: "idle",
    cursorLine: null,
    jumpTarget: null,
    dirty: false,
    lastSavedDoc: "",
    lastSavedAt: null,
    autoCommitted: false,
  },
  appStore: {
    defaultDir: null,
    notesDir: null,
    config: null,
    showOnboarding: false,
    initializing: false,
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
  },
  fileStore: {
    rootChildren: [],
    collapsed: {},
    renamingPath: null,
    undoStash: null,
    backlinks: [],
    tagList: [],
  },
  tabStore: {
    tabs: [],
    activeTabIdx: 0,
    closedTabs: [],
    recentPaths: [],
  },
};

/**
 * 重置所有 Zustand store 到初始状态。
 * 调用前需先 import 各 store。
 */
export function resetAllStores(stores: Record<string, any>) {
  for (const [name, state] of Object.entries(storeInitialStates)) {
    const store = stores[name];
    if (store) {
      act(() => {
        store.setState({ ...state }, true);
      });
    }
  }
}

/** 等待 store 中异步 action 完成 */
export async function waitForStore(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
