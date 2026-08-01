// src/hooks/useGitAutoCommit.ts
import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useEditorStore } from "@/stores/editorStore";
import { api } from "@/lib/tauri";

const AUTO_COMMIT_IDLE_MS = 30_000;

/** Git 状态轮询 + 空闲自动提交 */
export function useGitAutoCommit() {
  const notesDir = useAppStore((s) => s.notesDir);
  const gitAvailable = useAppStore((s) => s.gitAvailable);

  useEffect(() => {
    if (!notesDir || !gitAvailable) return;

    let cancelled = false;

    // Git 状态轮询（首次 2s 延迟，之后每 5s）
    const pollGitStatus = async () => {
      try {
        const s = await api.gitStatus(notesDir);
        if (!cancelled) useAppStore.setState({ git: s });
      } catch {
        /* git 不可用时保持离线态 */
      }
    };
    const initialDelay = setTimeout(pollGitStatus, 2000);
    const statusTimer = setInterval(pollGitStatus, 5000);

    // 空闲 30 秒自动提交
    const autoCommitTimer = setInterval(async () => {
      const editor = useEditorStore.getState();
      const savedAt = editor.lastSavedAt;
      if (!savedAt || editor.autoCommitted) return;
      if (Date.now() - savedAt < AUTO_COMMIT_IDLE_MS) return;

      try {
        await api.gitCommitAll(notesDir, "chore: auto-save notes");
        // 提交在途期间用户可能又保存（lastSavedAt 变化、autoCommitted 被重置），
        // 仅当 lastSavedAt 未变时才置位，避免误标
        if (useEditorStore.getState().lastSavedAt === savedAt) {
          useEditorStore.setState({ autoCommitted: true });
        }
        const gs = await api.gitStatus(notesDir);
        if (!cancelled) {
          useAppStore.setState({ git: gs });
          const appStore = useAppStore.getState();
          if (appStore.failCount === 0) appStore.syncNow();
        }
      } catch {
        /* 静默失败：git 不可用或无可提交内容 */
      }
    }, 5000);

    return () => {
      cancelled = true;
      clearTimeout(initialDelay);
      clearInterval(statusTimer);
      clearInterval(autoCommitTimer);
    };
  }, [notesDir, gitAvailable]);
}
