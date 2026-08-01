import { Code, Eye, PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { shortcut } from "@/lib/platform";
import type { GitStatus } from "@/lib/tauri";

export type SaveState = "idle" | "saving" | "saved";
export type SyncState = "local" | "syncing" | "synced" | "offline";
export type EditorMode = "wysiwyg" | "source";

interface StatusBarProps {
  words: number;
  git: GitStatus | null;
  /** 系统是否安装了 git；false 时优先展示安装引导而非"离线" */
  gitAvailable?: boolean;
  saveState: SaveState;
  /** 当前文件是否外部（notesDir 之外）：覆盖状态显示为"手动保存" */
  external?: boolean;
  /** 当前文件是否只读（如打包的隐私政策等） */
  readOnly?: boolean;
  syncState: SyncState;
  /** 最近一次同步失败的原因（中文友好文案），展示在 tooltip */
  syncError: string | null;
  pending: number;
  lastSyncAt: number | null;
  editorMode: EditorMode;
  onToggleEditorMode: () => void;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
}

export function StatusBar({
  words,
  git,
  gitAvailable,
  saveState,
  syncState,
  syncError,
  pending,
  lastSyncAt,
  editorMode,
  onToggleEditorMode,
  sidebarVisible,
  onToggleSidebar,
  external,
  readOnly,
}: StatusBarProps) {
  let dot = "bg-secondary";
  let label = "离线";

  if (gitAvailable === false) {
    dot = "bg-yellow-500";
    label = "Git 未安装";
  } else if (readOnly) {
    dot = "bg-amber-500";
    label = "只读 · 不可编辑";
  } else if (external) {
    dot = "bg-secondary";
    label = `外部文件 · 手动保存 (${shortcut("⌘S")})`;
  } else if (git === null && syncState === "local") {
    // 首次轮询返回前不显示误导性的"离线"
    dot = "bg-secondary";
    label = "加载中";
  } else if (saveState === "saving" || syncState === "syncing") {
    dot = "bg-yellow-500";
    label = "同步中";
  } else if (syncState === "offline") {
    dot = "bg-red-400";
    label = pending > 0 ? `离线（${pending} 条待推送）` : "离线";
  } else if (syncState === "synced") {
    dot = "bg-green-500";
    label = "已同步";
  } else if (git?.isRepo) {
    // 仅本地模式
    if (git.uncommitted > 0) {
      dot = "bg-yellow-500";
      label = `未提交 ${git.uncommitted} 项`;
    } else {
      dot = "bg-green-500";
      label = "已提交";
    }
  }

  return (
    <footer className="flex h-10 shrink-0 items-center justify-between bg-editor px-3 text-xs text-secondary">
      <span className="flex min-w-0 items-center gap-2">
        <button
          className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-hover hover:text-foreground"
          onClick={onToggleSidebar}
          title={sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"}
        >
          <PanelLeft size={13} />
        </button>
        <button
          className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-hover hover:text-foreground"
          onClick={onToggleEditorMode}
          title={editorMode === "wysiwyg" ? "切换到源码模式" : "切换到所见即所得模式"}
        >
          {editorMode === "wysiwyg" ? <Code size={13} /> : <Eye size={13} />}
        </button>
        <span
          className="flex min-w-0 items-center gap-1.5"
          title={syncState === "offline" && syncError ? syncError : undefined}
        >
        <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} />
        <span className="truncate">{label}</span>
        {syncState === "offline" && syncError && (
          <span className="truncate opacity-80">· {syncError}</span>
        )}
        {syncState === "synced" && lastSyncAt && (
          <span className="ml-1 opacity-70">
            {new Date(lastSyncAt).toLocaleTimeString()}
          </span>
        )}
      </span>
      </span>
      <span className="shrink-0">{words} 字</span>
    </footer>
  );
}
