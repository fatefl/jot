import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { SyncOutcome } from "@/lib/tauri";

interface AuthDialogProps {
  open: boolean;
  /** 触发弹窗的失败原因（中文友好文案） */
  reason: string | null;
  initialUsername: string;
  initialToken: string;
  /** 取消关闭（调用方据此 snooze 自动弹窗） */
  onClose: () => void;
  /** 验证成功关闭（不 snooze） */
  onSuccess: () => void;
  /** 保存凭据并立即重试同步 */
  onSubmit: (username: string, token: string) => Promise<SyncOutcome>;
}

/** 授权失败时弹出的重新验证框：平时不出现，仅 401/403 后询问一次 */
export function AuthDialog({
  open,
  reason,
  initialUsername,
  initialToken,
  onClose,
  onSuccess,
  onSubmit,
}: AuthDialogProps) {
  const [username, setUsername] = useState(initialUsername);
  const [token, setToken] = useState(initialToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUsername(initialUsername);
      setToken(initialToken);
      setError(null);
      setBusy(false);
    }
  }, [open, initialUsername, initialToken]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await onSubmit(username.trim(), token.trim());
      if (r.ok) {
        onSuccess();
      } else {
        setError(r.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="需要重新验证" width={380}>
      <div className="space-y-3">
        <p className="text-xs text-secondary">
          {reason
            ? `远程仓库授权失败：${reason}`
            : "输入远程仓库的凭据（Token 或密码）。"}
          <br />
          验证通过后将自动继续同步，凭据保存在系统密钥环中。
        </p>
        <Input
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Input
          type="password"
          placeholder="Token / 密码"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy && token.trim()) submit();
          }}
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !token.trim()} onClick={submit}>
            {busy && <Loader2 size={12} className="animate-spin" />}
            验证并同步
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
