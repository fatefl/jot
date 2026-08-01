import { useState, useEffect } from "react";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/lib/tauri";

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  onInstalled: () => void;
}

function isWindows(): boolean {
  return /Win/i.test(navigator.platform);
}

function getInstallCommand(): string {
  if (/Mac/i.test(navigator.platform)) return "brew install pandoc";
  // Linux：展示最常见 apt 命令（无法精确判断发行版）
  return "sudo apt install pandoc";
}

export function ExportDialog({ open, onClose, onInstalled }: ExportDialogProps) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setDownloading(false);
      setError(null);
      setCopied(false);
    }
  }, [open]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(getInstallCommand());
    } catch {
      // fallback: clipboard API 不可用时仍标记为已复制提示用户手动选择
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRefresh = async () => {
    const ok = await api.checkPandocAvailable();
    if (ok) {
      onInstalled();
    } else {
      setError("仍未检测到 Pandoc，请确认安装完成后重试");
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      await api.downloadPandocWindows();
      const ok = await api.checkPandocAvailable();
      if (ok) {
        onInstalled();
      } else {
        setError("下载完成但未检测到 Pandoc，请重试");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(false);
    }
  };

  const command = getInstallCommand();

  return (
    <Dialog open={open} onClose={onClose} title="需要安装 Pandoc" width={460}>
      <div className="flex flex-col gap-4 text-[13px] leading-relaxed text-secondary">
        <p>导出为 DOCX / EPUB / LaTeX 需要 Pandoc。</p>

        {isWindows() ? (
          <>
            <p>将自动下载并配置到应用本地（约 50MB），无需管理员权限。</p>
            {error && <p className="text-red-500 text-[12px]">{error}</p>}
            <div className="flex gap-2">
              <button
                disabled={downloading}
                className="flex-1 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                onClick={handleDownload}
              >
                {downloading ? "下载中..." : "下载并安装"}
              </button>
              <button
                className="rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-hover"
                onClick={onClose}
              >
                取消
              </button>
            </div>
            {downloading && (
              <p className="text-[12px] text-secondary">
                正在下载 Pandoc，请耐心等待...
              </p>
            )}
          </>
        ) : (
          <>
            <p>请打开终端运行以下命令：</p>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-hover px-3 py-2.5 font-mono text-[12px]">
              <span className="flex-1 select-all">{command}</span>
              <button
                className="shrink-0 rounded px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent-soft"
                onClick={handleCopy}
              >
                {copied ? "✓ 已复制" : "📋 复制"}
              </button>
            </div>
            {copied && (
              <p className="text-[12px] text-accent">
                已复制，请在终端中粘贴运行
              </p>
            )}
            {error && <p className="text-red-500 text-[12px]">{error}</p>}
            <div className="flex gap-2">
              <button
                className="flex-1 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90"
                onClick={handleRefresh}
              >
                安装完成，刷新状态
              </button>
              <button
                className="rounded-lg border border-border px-4 py-2 text-[13px] hover:bg-hover"
                onClick={onClose}
              >
                稍后提醒
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
