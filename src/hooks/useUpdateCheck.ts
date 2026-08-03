// src/hooks/useUpdateCheck.ts
// 启动时静默检查一次更新：发现新版本时 toast 提示，其余情况（无更新/失败/无 Tauri runtime）静默。
import { useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate } from "@/lib/updateCheck";
import { api } from "@/lib/tauri";
import type { ToastFn } from "@/components/ui/toast";

export function useUpdateCheck(toast: ToastFn) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let version: string;
      try {
        version = await getVersion();
      } catch {
        return; // 纯前端 dev 环境无 Tauri runtime：跳过检查
      }
      const result = await checkForUpdate(version);
      if (cancelled || result.status !== "update-available") return;
      toast(`发现新版本 v${result.latestVersion}`, {
        label: "查看",
        duration: 8000,
        onClick: () => {
          api.openUrl(result.downloadUrl).catch(() => {});
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);
}
