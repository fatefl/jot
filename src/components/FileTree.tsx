import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TreeNode } from "@/lib/tauri";

interface FileTreeProps {
  nodes: TreeNode[];
  depth?: number;
  collapsed: Record<string, boolean>;
  selectedPath: string | null;
  renamingPath: string | null;
  dropTarget: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  onRenameSubmit: (node: TreeNode, newName: string) => void;
  onRenameCancel: () => void;
  onNewNoteIn: (dir: TreeNode) => void;
  onMoreMenu: (e: React.MouseEvent, node: TreeNode) => void;
  onNodeDragStart: (node: TreeNode) => void;
  onNodeDragEnd: () => void;
  onDirDragOver: (e: React.DragEvent, node: TreeNode) => void;
  onDropOnDir: (node: TreeNode) => void;
}

export function FileTree(props: FileTreeProps) {
  const { nodes, depth = 0 } = props;
  return (
    <div>
      {nodes.map((node) => (
        <TreeRow key={node.path} node={node} depth={depth} {...props} />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  collapsed,
  selectedPath,
  renamingPath,
  dropTarget,
  onToggle,
  onSelect,
  onContextMenu,
  onRenameSubmit,
  onRenameCancel,
  onNewNoteIn,
  onMoreMenu,
  onNodeDragStart,
  onNodeDragEnd,
  onDirDragOver,
  onDropOnDir,
}: FileTreeProps & { node: TreeNode; depth: number }) {
  const isCollapsed = collapsed[node.path] ?? false;
  const isSelected = selectedPath === node.path;
  const isRenaming = renamingPath === node.path;
  const isDropTarget = dropTarget === node.path;
  const [draft, setDraft] = useState(node.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setDraft(node.name);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isRenaming, node.name]);

  const commitRename = () => {
    const name = draft.trim();
    if (name && name !== node.name) onRenameSubmit(node, name);
    else onRenameCancel();
  };

  return (
    <div>
      <div
        className={cn(
          "group relative mx-1 flex h-8 cursor-pointer items-center gap-1 rounded-lg pr-1 text-[14px]",
          isDropTarget
            ? "bg-accent-soft ring-1 ring-inset ring-accent"
            : isSelected
              ? "bg-[#818cf8] font-medium text-white"
              : "hover:bg-hover",
        )}
        style={{ paddingLeft: 12 + depth * 20 }}
        data-tree-path={node.path}
        data-tree-dir={node.isDir ? "true" : "false"}
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.path);
          onNodeDragStart(node);
        }}
        onDragEnd={onNodeDragEnd}
        onDragOver={
          node.isDir
            ? (e) => {
                e.stopPropagation();
                onDirDragOver(e, node);
              }
            : undefined
        }
        onDrop={
          node.isDir
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onDropOnDir(node);
              }
            : undefined
        }
        onClick={() => (node.isDir ? onToggle(node.path) : onSelect(node))}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, node);
        }}
      >
        {node.isDir ? (
          <>
            <ChevronRight
              size={13}
              className={cn(
                "shrink-0 transition-transform",
                isSelected ? "text-white" : "text-secondary",
                !isCollapsed && "rotate-90",
              )}
            />
            {isCollapsed ? (
              <Folder
                size={14}
                className={cn(
                  "shrink-0",
                  isSelected ? "text-white" : "text-secondary",
                )}
              />
            ) : (
              <FolderOpen
                size={14}
                className={cn(
                  "shrink-0",
                  isSelected ? "text-white" : "text-secondary",
                )}
              />
            )}
          </>
        ) : (
          <>
            <span className="w-[13px] shrink-0" />
            <FileText
              size={14}
              className={cn(
                "shrink-0",
                isSelected ? "text-white" : "text-secondary",
              )}
            />
          </>
        )}
        {isRenaming ? (
          <input
            ref={inputRef}
            className="ml-0.5 h-5 flex-1 rounded border border-accent bg-editor px-1 text-[13px] text-foreground outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}
        {node.isDir && !isRenaming && (
          <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
            <button
              className="rounded p-0.5 text-secondary hover:bg-border hover:text-foreground"
              title="新建笔记"
              onClick={(e) => {
                e.stopPropagation();
                onNewNoteIn(node);
              }}
            >
              <Plus size={13} />
            </button>
            <button
              className="rounded p-0.5 text-secondary hover:bg-border hover:text-foreground"
              title="更多"
              onClick={(e) => {
                e.stopPropagation();
                onMoreMenu(e, node);
              }}
            >
              <MoreHorizontal size={13} />
            </button>
          </span>
        )}
      </div>
      {node.isDir && !isCollapsed && node.children.length > 0 && (
        <FileTree
          nodes={node.children}
          depth={depth + 1}
          collapsed={collapsed}
          selectedPath={selectedPath}
          renamingPath={renamingPath}
          dropTarget={dropTarget}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          onNewNoteIn={onNewNoteIn}
          onMoreMenu={onMoreMenu}
          onNodeDragStart={onNodeDragStart}
          onNodeDragEnd={onNodeDragEnd}
          onDirDragOver={onDirDragOver}
          onDropOnDir={onDropOnDir}
        />
      )}
    </div>
  );
}
