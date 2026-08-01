import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import type { Theme } from "@/hooks/useTheme";
import type { SyncState } from "./StatusBar";
import type { AppConfig, SyncOutcome } from "@/lib/tauri";

export interface SyncFormValues {
  remoteUrl: string;
  authType: string;
  username: string;
  token: string;
}

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  notesDir: string | null;
  config: AppConfig | null;
  reuseTab: boolean;
  onSaveReuseTab: (value: boolean) => Promise<void>;
  syncState: SyncState;
  lastSyncAt: number | null;
  onSaveSync: (values: SyncFormValues) => Promise<void>;
  onSyncNow: () => Promise<SyncOutcome>;
  onChangeDataDir: (path: string) => Promise<void>;
  /** 打开凭据弹窗（Token 模式的唯一凭据录入入口） */
  onConfigureAuth: () => void;
}

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function SettingsDialog({
  open,
  onClose,
  theme,
  setTheme,
  notesDir,
  config,
  reuseTab,
  onSaveReuseTab,
  syncState,
  lastSyncAt,
  onSaveSync,
  onSyncNow,
  onChangeDataDir,
  onConfigureAuth,
}: SettingsDialogProps) {
  const [dirDraft, setDirDraft] = useState(notesDir ?? "");
  const [remoteUrl, setRemoteUrl] = useState(config?.remoteUrl ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const handleSyncNow = async () => {
    setBusy("sync");
    setSyncMsg(null);
    try {
      const r = await onSyncNow();
      setSyncMsg({ ok: r.ok, text: r.message });
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (open) {
      setDirDraft(notesDir ?? "");
      setRemoteUrl(config?.remoteUrl ?? "");
      setMessage(null);
      setSyncMsg(null);
    }
  }, [open, notesDir, config]);

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
    } catch (e) {
      setMessage(`失败：${e}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="设置" width={460}>
      <div className="space-y-5">
        {/* 主题 */}
        <section>
          <h3 className="mb-2.5 text-sm font-medium">主题</h3>
          <div className="flex gap-1 rounded-lg border border-border bg-editor p-1">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={cn(
                  "flex-1 rounded-md py-1.5 text-[13px] transition-colors",
                  theme === opt.value
                    ? "bg-accent text-white shadow-sm"
                    : "text-secondary hover:text-foreground",
                )}
                onClick={() => setTheme(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        {/* 编辑器 */}
        <section>
          <h3 className="mb-2.5 text-sm font-medium">编辑器</h3>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={reuseTab}
              onChange={(e) => onSaveReuseTab(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-accent"
            />
            <span className="text-[13px]">单击侧边栏文件时复用当前标签页</span>
          </label>
          <p className="mt-1.5 text-xs text-secondary leading-relaxed">
            关闭后每次单击都会新建标签页；开启后仅在当前标签页中切换内容。
          </p>
        </section>

        {/* 数据目录 */}
        <section>
          <h3 className="mb-2.5 text-sm font-medium">数据目录</h3>
          <div className="flex gap-2">
            <Input
              value={dirDraft}
              onChange={(e) => setDirDraft(e.target.value)}
            />
            <Button
              variant="outline"
              size="default"
              disabled={busy !== null || !dirDraft.trim() || dirDraft === notesDir}
              onClick={() =>
                run("dir", () => onChangeDataDir(dirDraft.trim()), "数据目录已切换")
              }
            >
              {busy === "dir" && <Loader2 size={12} className="animate-spin" />}
              切换
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-secondary">
            不存在则创建；空目录会初始化，已有内容则直接使用。
          </p>
        </section>

        {/* 同步 */}
        <section>
          <h3 className="mb-2.5 text-sm font-medium">同步</h3>
          <div className="space-y-2">
            <Input
              placeholder="远程仓库地址（https://…，留空则仅本地）"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
            />
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-editor px-3 py-2.5 text-xs">
              <span className={cn((config?.remoteUrl && config?.authType === "token") ? "text-green-600 dark:text-green-400" : "text-secondary")}>
                {(config?.remoteUrl && config?.authType === "token")
                  ? `已配置凭据（${config.username || "未设置用户名"}）`
                  : "未配置凭据"}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onClose();
                  onConfigureAuth();
                }}
              >
                {(config?.remoteUrl && config?.authType === "token") ? "更换" : "配置"}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  run(
                    "save",
                    () =>
                      onSaveSync({
                        remoteUrl: remoteUrl.trim(),
                        authType: "token",
                        username: config?.username ?? "",
                        token: config?.token ?? "",
                      }),
                    "同步设置已保存",
                  )
                }
              >
                {busy === "save" && <Loader2 size={12} className="animate-spin" />}
                保存配置
              </Button>
              <Button
                variant="outline"
                disabled={busy !== null || !config?.remoteUrl}
                onClick={handleSyncNow}
              >
                <RefreshCw
                  size={12}
                  className={
                    busy === "sync" || syncState === "syncing"
                      ? "animate-spin"
                      : ""
                  }
                />
                {busy === "sync" ? "同步中…" : "立即同步"}
              </Button>
              {lastSyncAt && (
                <span className="text-xs text-secondary ml-auto">
                  {new Date(lastSyncAt).toLocaleTimeString()}
                </span>
              )}
            </div>
            {syncMsg && (
              <p
                className={cn(
                  "text-xs",
                  syncMsg.ok ? "text-green-600 dark:text-green-400" : "text-red-500",
                )}
              >
                {syncMsg.text}
              </p>
            )}
          </div>
        </section>

        {message && (
          <p className="text-center text-xs text-accent">{message}</p>
        )}
      </div>
    </Dialog>
  );
}
