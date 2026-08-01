// src/hooks/useAutoSave.ts
import { useEffect } from "react";
import { useEditorStore, enqueueWriteFile, fetchMtime } from "@/stores/editorStore";
import { useAppStore } from "@/stores/appStore";
import { useTabStore } from "@/stores/tabStore";
import { api } from "@/lib/tauri";
import { isExternalPath } from "@/lib/utils";

const AUTO_SAVE_MS = 2000;

export function useAutoSave() {
  const doc = useEditorStore((s) => s.doc);
  const selectedPath = useEditorStore((s) => s.selectedPath);

  useEffect(() => {
    const { dirty, lastSavedDoc, isFormulaEditing } = useEditorStore.getState();
    if (!selectedPath || doc === lastSavedDoc) return;
    // 公式/图表编辑模式中禁止自动保存：
    // doc 中的源码不含 $/``` 定界符，直接落盘会导致下次加载时渲染为普通文本
    if (isFormulaEditing) return;

    useEditorStore.setState({ dirty: true });

    const notesDir = useAppStore.getState().notesDir;
    if (isExternalPath(selectedPath, notesDir)) return;

    useEditorStore.setState({ saveState: "saving" });
    const savedPath = selectedPath;
    const savedDoc = doc;

    const timer = setTimeout(async () => {
      try {
        // 写入串行化：与切换/手动保存共用队列，避免在途保存与切换保存乱序回退磁盘
        await enqueueWriteFile(savedPath, savedDoc);
        const editor = useEditorStore.getState();
        if (editor.selectedPath === savedPath) {
          // 刷新 mtime 基准，用于外部修改感知
          const mt = await fetchMtime(savedPath);
          useEditorStore.setState({
            lastSavedDoc: savedDoc,
            ...(mt !== null ? { loadedMtime: mt } : {}),
          });
          if (editor.doc === savedDoc) {
            useEditorStore.setState({
              dirty: false,
              saveState: "saved",
              lastSavedAt: Date.now(),
              autoCommitted: false,
            });

            const { tabs, activeTabIdx } = useTabStore.getState();
            const updated = tabs.map((t, i) =>
              i === activeTabIdx ? { ...t, dirty: false } : t
            );
            useTabStore.setState({ tabs: updated });

            const nd = useAppStore.getState().notesDir;
            if (nd) {
              const git = await api.gitStatus(nd);
              useAppStore.setState({ git });
            }
          }
        } else {
          // 守卫不命中（已切换到其他标签）：重置 saveState，避免永久卡在 saving
          const cur = useEditorStore.getState();
          if (cur.saveState === "saving") {
            useEditorStore.setState({
              saveState: cur.doc === cur.lastSavedDoc ? "saved" : "idle",
            });
          }
        }
      } catch {
        useEditorStore.setState({ saveState: "idle" });
      }
    }, AUTO_SAVE_MS);

    return () => clearTimeout(timer);
  }, [doc, selectedPath]);
}
