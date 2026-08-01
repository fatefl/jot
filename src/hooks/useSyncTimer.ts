// src/hooks/useSyncTimer.ts
import { useEffect } from "react";
import { useAppStore, SYNC_INTERVAL_MS } from "@/stores/appStore";

export function useSyncTimer() {
  const notesDir = useAppStore((s) => s.notesDir);
  const remoteUrl = useAppStore((s) => s.config?.remoteUrl);

  useEffect(() => {
    if (!notesDir || !remoteUrl) return;

    const store = useAppStore.getState();
    store.syncNow();

    const timer = setInterval(() => {
      const s = useAppStore.getState();
      const elapsed = Date.now() - s.lastSyncAttempt;
      const delay = s._computeBackoff(s.failCount);
      if (elapsed >= delay) s.syncNow();
    }, 15_000);

    return () => clearInterval(timer);
  }, [notesDir, remoteUrl]);
}
