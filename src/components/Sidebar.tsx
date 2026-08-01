import { memo } from "react";
import { FilePlus, FolderPlus, Settings } from "lucide-react";
import { FileTree } from "./FileTree";
import { Tooltip } from "./ui/tooltip";
import type { TreeNode } from "@/lib/tauri";

interface SidebarProps {
  rootChildren: TreeNode[];
  /** 正在按标签过滤（对应 TagPanel 中选中的标签），null 表示未过滤 */
  filterTag: string | null;
  onClearTag: () => void;
  collapsed: Record<string, boolean>;
  selectedPath: string | null;
  renamingPath: string | null;
  dropTarget: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
  onNodeContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  onBlankContextMenu: (e: React.MouseEvent) => void;
  onRenameSubmit: (node: TreeNode, newName: string) => void;
  onRenameCancel: () => void;
  onNewNoteIn: (dir: TreeNode) => void;
  onMoreMenu: (e: React.MouseEvent, node: TreeNode) => void;
  onNewNote: () => void;
  onNewDir: () => void;
  onOpenSettings: () => void;
  onNodeDragStart: (node: TreeNode) => void;
  onNodeDragEnd: () => void;
  onDirDragOver: (e: React.DragEvent, node: TreeNode) => void;
  onDropOnDir: (node: TreeNode) => void;
  onDropToRoot: () => void;
}

// memo：编辑器每次按键都会让 App 重渲染，侧边栏（含整棵 FileTree）不应跟着重渲染
export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-sidebar select-none">
      {/* 标签过滤指示条：点击标签后仅显示命中笔记，可在此清除过滤 */}
      {props.filterTag && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-1.5">
          <span className="truncate rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
            #{props.filterTag}
          </span>
          <span className="shrink-0 text-[10px] text-secondary/60">已过滤</span>
          <button
            className="ml-auto shrink-0 text-[10px] text-secondary hover:text-foreground"
            onClick={props.onClearTag}
          >
            清除
          </button>
        </div>
      )}

      {/* 目录树 */}
      <div
        className="m-1 flex-1 overflow-y-auto rounded pb-4"
        onContextMenu={(e) => {
          e.preventDefault();
          props.onBlankContextMenu(e);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          props.onDropToRoot();
        }}
      >
        {props.filterTag && props.rootChildren.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-secondary/60">
            该标签下暂无笔记
          </p>
        ) : (
          <FileTree
            nodes={props.rootChildren}
            collapsed={props.collapsed}
            selectedPath={props.selectedPath}
            renamingPath={props.renamingPath}
            dropTarget={props.dropTarget}
            onToggle={props.onToggle}
            onSelect={props.onSelect}
            onContextMenu={props.onNodeContextMenu}
            onRenameSubmit={props.onRenameSubmit}
            onRenameCancel={props.onRenameCancel}
            onNewNoteIn={props.onNewNoteIn}
            onMoreMenu={props.onMoreMenu}
            onNodeDragStart={props.onNodeDragStart}
            onNodeDragEnd={props.onNodeDragEnd}
            onDirDragOver={props.onDirDragOver}
            onDropOnDir={props.onDropOnDir}
          />
        )}
      </div>

      {/* 底部操作 */}
      <div className="flex h-10 shrink-0 items-center px-2">
        <Tooltip label="新建笔记">
          <button
            className="flex h-7 w-7 items-center justify-center rounded text-secondary transition-colors hover:bg-hover hover:text-foreground"
            onClick={props.onNewNote}
          >
            <FilePlus size={15} strokeWidth={1.8} />
          </button>
        </Tooltip>
        <Tooltip label="新建目录">
          <button
            className="flex h-7 w-7 items-center justify-center rounded text-secondary transition-colors hover:bg-hover hover:text-foreground"
            onClick={props.onNewDir}
          >
            <FolderPlus size={15} strokeWidth={1.8} />
          </button>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip label="设置">
          <button
            className="flex h-7 w-7 items-center justify-center rounded text-secondary transition-colors hover:bg-hover hover:text-foreground"
            onClick={props.onOpenSettings}
          >
            <Settings size={15} strokeWidth={1.8} />
          </button>
        </Tooltip>
      </div>
    </aside>
  );
});
