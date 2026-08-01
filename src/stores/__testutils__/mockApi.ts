// src/stores/__testutils__/mockApi.ts
import { vi } from "vitest";
import type { TreeNode, GitStatus, SyncOutcome } from "@/lib/tauri";

export interface MockApiOptions {
  tree?: TreeNode[];
  fileContents?: Record<string, string>;
  gitStatus?: GitStatus;
  gitAvailable?: boolean;
  syncResult?: SyncOutcome;
  writeFileFail?: string[];
  backlinks?: any[];
  tags?: any[];
  templates?: any[];
  displayScale?: number;
  pandocAvailable?: boolean;
}

export function createMockApi(opts: MockApiOptions = {}) {
  const tree = opts.tree ?? [
    {
      name: "notes",
      path: "notes",
      isDir: true,
      children: [
        { name: "a.md", path: "notes/a.md", isDir: false, children: [] },
        { name: "b.md", path: "notes/b.md", isDir: false, children: [] },
      ],
    },
  ];

  return {
    listTree: vi.fn().mockResolvedValue({ children: tree }),
    readFile: vi.fn().mockImplementation(
      (path: string) =>
        Promise.resolve(opts.fileContents?.[path] ?? `# ${path}\n`)
    ),
    writeFile: vi.fn().mockImplementation((path: string) => {
      if (opts.writeFileFail?.includes(path)) {
        return Promise.reject(new Error("Write failed"));
      }
      return Promise.resolve();
    }),
    deletePath: vi.fn().mockResolvedValue(undefined),
    createDir: vi.fn().mockResolvedValue(undefined),
    renamePath: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue("notes/new-note.md"),
    importFiles: vi
      .fn()
      .mockResolvedValue({ imported: ["notes/imported.md"], conflicts: 0 }),
    getConfig: vi.fn().mockResolvedValue({
      dataDir: "notes",
      remoteUrl: "",
      authType: "",
      username: "",
      token: "",
      reuseTab: false,
    }),
    setConfig: vi.fn().mockResolvedValue(undefined),
    setReuseTab: vi.fn().mockResolvedValue(undefined),
    changeDataDir: vi.fn().mockResolvedValue({ ok: true }),
    gitStatus: vi.fn().mockResolvedValue(
      opts.gitStatus ?? { isRepo: true, uncommitted: 0 }
    ),
    checkGitAvailable: vi
      .fn()
      .mockResolvedValue(opts.gitAvailable ?? true),
    gitSync: vi.fn().mockResolvedValue(
      opts.syncResult ?? {
        ok: true,
        synced: false,
        pulledChanges: false,
        conflicts: [],
        pending: 0,
      }
    ),
    getBacklinks: vi.fn().mockResolvedValue(opts.backlinks ?? []),
    listTags: vi.fn().mockResolvedValue(opts.tags ?? []),
    listTemplates: vi.fn().mockResolvedValue(opts.templates ?? []),
    getDisplayScale: vi.fn().mockResolvedValue(opts.displayScale ?? 1.0),
    checkPandoc: vi.fn().mockResolvedValue(opts.pandocAvailable ?? true),
    revealInFolder: vi.fn().mockResolvedValue(undefined),
    openInDefaultApp: vi.fn().mockResolvedValue(undefined),
    getDailyNotePath: vi
      .fn()
      .mockResolvedValue("notes/daily/2026-07-29.md"),
    ensureDir: vi.fn().mockResolvedValue(undefined),
  };
}
