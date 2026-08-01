import { invoke } from "@tauri-apps/api/core";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

export interface DirStatus {
  exists: boolean;
  empty: boolean;
  hasMd: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  uncommitted: number;
}

export interface GitErrorPayload {
  kind:
    | "network"
    | "auth"
    | "not_found"
    | "not_a_repo"
    | "timeout"
    | "no_remote"
    | "git_not_found"
    | "other"
    | string;
  message: string;
}

export interface TestRemoteResult {
  ok: boolean;
  empty: boolean;
  error: GitErrorPayload | null;
}

export interface CloneResult {
  cloned: boolean;
  empty: boolean;
  error: GitErrorPayload | null;
}

export interface SyncResult {
  synced: boolean;
  pulledChanges: boolean;
  conflicts: string[];
  pending: number;
  error: GitErrorPayload | null;
}

/** syncNow 的即时反馈结果，用于"立即同步"按钮的状态展示 */
export interface SyncOutcome {
  ok: boolean;
  message: string;
}

export interface AppConfig {
  dataDir: string;
  remoteUrl: string;
  authType: string;
  username: string;
  token: string;
  /** 标签复用模式：侧边栏单击文件时复用当前标签而非新建 */
  reuseTab: boolean;
}

export interface AuthPayload {
  authType: string;
  username: string;
  token: string;
}

export interface ImportedFile {
  name: string;
  path: string;
}

export interface ImportResult {
  imported: ImportedFile[];
  skippedDirs: number;
}

export interface SearchMatch {
  name: string;
  path: string;
  line: number;
  context: string;
}

export interface TemplateInfo {
  name: string;
  path: string;
}

export interface BacklinkInfo {
  name: string;
  path: string;
  line: number;
  context: string;
}

export interface TagInfo {
  tag: string;
  count: number;
  files: string[];
}

export const api = {
  defaultNotesDir: () => invoke<string>("default_notes_dir"),
  dirStatus: (path: string) => invoke<DirStatus>("dir_status", { path }),
  listTree: (path: string) => invoke<TreeNode>("list_tree", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  /** 文件修改时间（Unix 毫秒时间戳）；文件不存在返回 0 */
  fileMtime: (path: string) => invoke<number>("file_mtime", { path }),
  writeFile: (path: string, content: string) =>
    invoke<void>("write_file", { path, content }),
  createNote: (dir: string, name?: string) =>
    invoke<string>("create_note", { dir, name: name ?? null }),
  createDir: (parent: string, name?: string) =>
    invoke<string>("create_dir", { parent, name: name ?? null }),
  renamePath: (path: string, newName: string) =>
    invoke<string>("rename_path", { path, newName }),
  deletePath: (path: string) => invoke<void>("delete_path", { path }),
  movePath: (src: string, destDir: string) =>
    invoke<string>("move_path", { src, destDir }),
  importFiles: (targetDir: string, paths: string[], isAsset: boolean) =>
    invoke<ImportResult>("import_files", { targetDir, paths, isAsset }),
  saveAsset: (notesDir: string, fileName: string, data: number[]) =>
    invoke<ImportedFile>("save_asset", { notesDir, fileName, data }),
  revealInFolder: (path: string) =>
    invoke<void>("reveal_in_folder", { path }),
  getConfig: () => invoke<AppConfig>("get_config"),
  saveSyncConfig: (
    url: string,
    authType: string,
    username: string,
    token: string,
  ) =>
    invoke<void>("save_sync_config", { url, authType, username, token }),
  setDataDir: (path: string) => invoke<DirStatus>("set_data_dir", { path }),
  setReuseTab: (value: boolean) => invoke<void>("set_reuse_tab", { value }),
  checkGitAvailable: () => invoke<boolean>("check_git_available"),
  gitStatus: (path: string) => invoke<GitStatus>("git_status", { path }),
  gitCommitAll: (path: string, message: string) =>
    invoke<boolean>("git_commit_all", { path, message }),
  initWorkspace: (path: string, mode: string) =>
    invoke<void>("init_workspace", { path, mode }),
  setRemote: (path: string, url: string) =>
    invoke<void>("set_remote", { path, url }),
  testRemote: (url: string, auth?: AuthPayload) =>
    invoke<TestRemoteResult>("test_remote", { url, auth: auth ?? null }),
  cloneRemote: (url: string, dest: string, auth?: AuthPayload) =>
    invoke<CloneResult>("clone_remote", { url, dest, auth: auth ?? null }),
  gitSync: (path: string, auth?: AuthPayload) =>
    invoke<SyncResult>("git_sync", { path, auth: auth ?? null }),
  searchContent: (dir: string, query: string) =>
    invoke<SearchMatch[]>("search_content", { dir, query }),
  listTemplates: (dir: string) =>
    invoke<TemplateInfo[]>("list_templates", { dir }),
  createFromTemplate: (dir: string, templatePath: string, targetName: string) =>
    invoke<string>("create_from_template", { dir, templatePath, targetName }),
  getBacklinks: (dir: string, targetFile: string) =>
    invoke<BacklinkInfo[]>("get_backlinks", { dir, targetFile }),
  listTags: (dir: string) => invoke<TagInfo[]>("list_tags", { dir }),
  getOpenedFile: () => invoke<string | null>("get_opened_file"),
  openInSystem: (path: string) => invoke<void>("open_in_system", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  getResourcePath: (name: string) =>
    invoke<string>("get_resource_path", { name }),
  readResource: (name: string) =>
    invoke<string>("read_resource", { name }),
  getDisplayScale: () => invoke<number>("get_display_scale"),

  /** 确保目录存在：若已存在则静默跳过。底层复用 create_dir。 */
  ensureDir: (path: string) => {
    const segs = path.split("/");
    const name = segs.pop() || "untitled";
    const parent = segs.join("/") || ".";
    return invoke<string>("create_dir", { parent, name })
      .then(() => {})
      .catch(() => {});
  },

  // ---- 导出 ----

  /** 写入导出文件（二进制内容——PNG 图片等） */
  exportFile: (destPath: string, content: number[]) =>
    invoke<void>("export_file", { destPath, content }),

  /** 写入导出文件（文本内容——HTML 等）。
   *  前端先将字符串编码为 UTF-8 字节数组传给 Rust。 */
  exportFileText: (destPath: string, content: string) =>
    invoke<void>("export_file", {
      destPath,
      content: Array.from(new TextEncoder().encode(content)),
    }),

  /** macOS：原生 WKWebView 渲染导出 PDF（WKWebView 不支持 window.print()）。
   *  命令仅 macOS 注册，调用前用 isMac 判断。 */
  exportPdfNative: (destPath: string, html: string) =>
    invoke<void>("export_pdf_native", { destPath, html }),

  /** macOS：原生 WKWebView 渲染并弹出系统打印面板（WKWebView 不支持 window.print()）。
   *  命令仅 macOS 注册，调用前用 isMac 判断。 */
  printNative: (html: string) =>
    invoke<void>("print_native", { html }),

  /** Pandoc：将 Markdown 源文件转换为目标格式 */
  pandocExport: (sourcePath: string, destPath: string) =>
    invoke<void>("pandoc_export", { sourcePath, destPath }),

  /** 检测系统是否安装了 Pandoc */
  checkPandocAvailable: () =>
    invoke<boolean>("check_pandoc_available"),

  /** Windows：自动下载 Pandoc portable 版。
   *  非 Windows 平台调用会收到 Tauri "command not found" 错误，
   *  前端应在调用前通过 platform 判断。 */
  downloadPandocWindows: () =>
    invoke<string>("download_pandoc_windows"),
};
