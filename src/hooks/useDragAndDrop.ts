// src/hooks/useDragAndDrop.ts
// 内部拖拽（文件树节点移动）+ 外部拖入（OS 文件管理器 → 窗口）
import { useEffect, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useUiStore } from "@/stores/uiStore";
import { useTabStore } from "@/stores/tabStore";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/tauri";
import { relativePath } from "@/lib/utils";
import type { EditorPanelHandle } from "@/components/Editor";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];
const isImagePath = (p: string) =>
  IMAGE_EXTS.some((ext) => p.toLowerCase().endsWith(ext));

export function useDragAndDrop(
  sidebarRef: RefObject<HTMLDivElement>,
  editorRef?: RefObject<EditorPanelHandle | null>,
) {
  const toast = useToast();
  const dragging = useUiStore((s) => s.dragging);

  // 拖拽幽灵位置跟踪
  useEffect(() => {
    if (!dragging) return;
    const move = (e: DragEvent) =>
      useUiStore.setState({ dragPos: { x: e.clientX, y: e.clientY } });
    const end = () => {
      useUiStore.setState({ dragging: null, dropTarget: null });
    };
    window.addEventListener("dragover", move);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragover", move);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, [dragging]);

  // Shift 键跟踪（外部拖入时 Shift+drop = 直接打开原文件而非复制）
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift") useUiStore.setState({ shiftHeld: true } as any);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") useUiStore.setState({ shiftHeld: false } as any);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // 外部拖入：OS 文件管理器 → app 窗口
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const hitTest = (x: number, y: number): "editor" | "sidebar" => {
      const side = sidebarRef.current?.getBoundingClientRect();
      if (
        side &&
        x >= side.left &&
        x <= side.right &&
        y >= side.top &&
        y <= side.bottom
      ) {
        const el = document
          .elementFromPoint(x, y)
          ?.closest("[data-tree-path]");
        const dirPath =
          el?.getAttribute("data-tree-dir") === "true"
            ? el.getAttribute("data-tree-path")
            : null;
        useUiStore.setState({ externalDropDir: dirPath, dropTarget: dirPath });
        return "sidebar";
      }
      useUiStore.setState({ externalDropDir: null, dropTarget: null });
      return "editor";
    };

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const payload = event.payload;
        const dpr = window.devicePixelRatio || 1;
        if (payload.type === "enter" || payload.type === "over") {
          const zone = hitTest(
            payload.position.x / dpr,
            payload.position.y / dpr,
          );
          useUiStore.setState({ externalDragZone: zone });
        } else if (payload.type === "drop") {
          const zone = hitTest(
            payload.position.x / dpr,
            payload.position.y / dpr,
          );
          const dir = useUiStore.getState().externalDropDir;
          useUiStore.setState({
            externalDragZone: null,
            dropTarget: null,
            externalDropDir: null,
          });
          if ((useUiStore.getState() as any).shiftHeld) {
            const mds = payload.paths.filter((p: string) =>
              p.toLowerCase().endsWith(".md"),
            );
            if (mds.length > 0) {
              for (const p of mds)
                await useTabStore.getState().openFileByPath(p);
            } else {
              toast("Shift+拖拽仅支持打开 .md 文件");
            }
          } else {
            // 拖到编辑器区域的图片：复制进 .assets 并在落点插入 ![]() 引用；
            // 其余文件维持原行为（导入到文件树目标目录）
            const images = payload.paths.filter(isImagePath);
            const rest = payload.paths.filter((p) => !isImagePath(p));
            if (zone === "editor" && images.length > 0 && editorRef?.current) {
              insertDroppedImages(
                images,
                payload.position.x / dpr,
                payload.position.y / dpr,
                editorRef,
                toast,
              );
            } else if (images.length > 0) {
              rest.push(...images);
            }
            if (rest.length > 0) {
              useTabStore
                .getState()
                .handleExternalDrop(rest, dir ?? undefined);
            }
          }
        } else {
          useUiStore.setState({ externalDragZone: null, dropTarget: null });
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

/** 拖入编辑器的图片：复制到 notesDir/.assets/，在落点坐标处插入相对路径引用 */
async function insertDroppedImages(
  paths: string[],
  x: number,
  y: number,
  editorRef: RefObject<EditorPanelHandle | null>,
  toast: (msg: string) => void,
) {
  const { useAppStore } = await import("@/stores/appStore");
  const { useEditorStore } = await import("@/stores/editorStore");
  const notesDir = useAppStore.getState().notesDir;
  const filePath = useEditorStore.getState().selectedPath;
  if (!notesDir || !filePath) return;
  try {
    const r = await api.importFiles(notesDir, paths, true);
    if (r.imported.length === 0) return;
    const fileDir = filePath.substring(0, filePath.lastIndexOf("/") + 1);
    const rels = r.imported.map((f) => relativePath(fileDir, f.path));
    editorRef.current?.insertImagesAtPoint(x, y, rels);
  } catch {
    toast("图片导入失败");
  }
}
