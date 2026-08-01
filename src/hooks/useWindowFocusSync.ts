// src/hooks/useWindowFocusSync.ts
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "@/stores/appStore";
import { useFileStore } from "@/stores/fileStore";
import { useEditorStore, fetchMtime } from "@/stores/editorStore";
import { useTabStore } from "@/stores/tabStore";
import { useToast } from "@/components/ui/toast";

export function useWindowFocusSync() {
  const notesDir = useAppStore((s) => s.notesDir);
  const toast = useToast();
  // 已提示过的外部变更（`path:mtime`），同一变更只提示一次
  const warnedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!notesDir) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    // 外部修改感知：焦点回归时检查当前活动文件是否被磁盘改动，
    // 否则自动保存会静默覆盖外部改动
    const checkExternalChange = async () => {
      const editor = useEditorStore.getState();
      const path = editor.selectedPath;
      if (!path) return;

      if (editor.dirty) {
        // 本地有未保存修改：磁盘 mtime 晚于上次加载时提示（同一变更只提示一次）
        const mt = await fetchMtime(path);
        if (cancelled || mt === null) return;
        if (editor.loadedMtime === null || mt <= editor.loadedMtime) return;
        const key = `${path}:${mt}`;
        if (warnedRef.current === key) return;
        warnedRef.current = key;
        toast(
          `「${path.split("/").pop()}」已被外部修改，继续编辑保存将覆盖外部改动`,
          { duration: 6000 },
        );
        return;
      }

      // 非 dirty：能证明磁盘未变（mtime 一致）则跳过，否则直接重新加载
      const mt = await fetchMtime(path);
      if (cancelled) return;
      if (mt !== null && editor.loadedMtime !== null && mt === editor.loadedMtime) return;
      await useTabStore.getState().reloadOpenFile();
    };

    getCurrentWindow()
      .listen("tauri://focus", () => {
        if (cancelled) return;
        useFileStore.getState().refreshTree(notesDir);
        useAppStore.getState().syncNow();
        void checkExternalChange();
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
  }, [notesDir, toast]);
}
