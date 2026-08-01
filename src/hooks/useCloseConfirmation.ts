// src/hooks/useCloseConfirmation.ts
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEditorStore } from "@/stores/editorStore";
import { useUiStore } from "@/stores/uiStore";

export function useCloseConfirmation() {
  const closeWithConfirm = useRef<() => Promise<void>>(async () => {});

  closeWithConfirm.current = async () => {
    const { selectedPath, doc, lastSavedDoc } = useEditorStore.getState();
    if (!selectedPath || doc === lastSavedDoc) {
      await getCurrentWindow().destroy();
      return;
    }

    const choice = await useUiStore.getState().showCloseDialog();
    if (choice === "cancel") return;

    if (choice === "save") {
      try {
        // 统一走 saveCurrent：公式/图表编辑中由守卫跳过（裸代码不落盘），且写入串行化
        await useEditorStore.getState().saveCurrent();
      } catch {
        return;
      }
    }
    await getCurrentWindow().destroy();
  };

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    getCurrentWindow()
      .onCloseRequested(async (event) => {
        const { selectedPath, doc, lastSavedDoc } = useEditorStore.getState();
        if (!selectedPath || doc === lastSavedDoc) return;
        event.preventDefault();
        await closeWithConfirm.current();
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
