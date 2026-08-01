import { useState, useEffect } from "react";
import {
  AlertTriangle,
  Cloud,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Loader2,
  PartyPopper,
  Server,
  Terminal,
} from "lucide-react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import { api, type AuthPayload } from "@/lib/tauri";
import { marked } from "marked";

type SyncMode = "local" | "github" | "selfhosted";

const SYNC_OPTIONS: {
  value: SyncMode;
  label: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  {
    value: "local",
    label: "仅本地",
    desc: "只在本地用 git 管理版本，不同步到远程",
    icon: <HardDrive size={18} />,
  },
  {
    value: "github",
    label: "GitHub / Gitee 私有仓库",
    desc: "同步到 GitHub 或 Gitee 私有仓库（HTTPS Token）",
    icon: <Cloud size={18} />,
  },
  {
    value: "selfhosted",
    label: "自建服务器",
    desc: "同步到自己的 git 服务器（HTTPS Token）",
    icon: <Server size={18} />,
  },
];

/** 内置协议文档名 → 弹窗标题（协议内容互引跳转用） */
const AGREEMENT_TITLES: Record<string, string> = {
  "用户协议.md": "用户协议",
  "隐私政策.md": "隐私政策",
  "MCP 配置指南.md": "MCP 配置指南",
};

/** 弹窗链接 href → 资源文档名：%XX 解码后取 basename。
 *  资源文件平铺在 resources 根目录，`隐私政策.md` / `./隐私政策.md` / 百分号编码
 *  都应归一为纯文件名，才能命中 AGREEMENT_TITLES；同时只把纯文件名交给
 *  readResource（Rust 侧不拦截 `..` 逃逸，带路径的 name 有越权读取风险） */
export function resourceDocNameFromHref(href: string): string {
  try {
    return decodeURIComponent(href).split("/").pop() ?? "";
  } catch {
    return href.split("/").pop() ?? "";
  }
}

interface OnboardingProps {
  defaultDir: string;
  onDone: (dir: string) => void;
}

export function Onboarding({ defaultDir, onDone }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(defaultDir);
  const [dirLoading, setDirLoading] = useState(true);

  // 首次加载时获取默认目录（~/Notes）
  useEffect(() => {
    if (defaultDir) {
      setDirLoading(false);
      return;
    }
    api.defaultNotesDir().then((d) => {
      setDir((prev) => prev || d); // 不覆盖用户已输入的内容
      setDirLoading(false);
    }).catch(() => setDirLoading(false));
  }, [defaultDir]);
  const [mode, setMode] = useState<SyncMode>("local");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gitAvailable, setGitAvailable] = useState<boolean | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    api.checkGitAvailable().then(setGitAvailable);
  }, []);

  // 协议弹窗
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [agreementTitle, setAgreementTitle] = useState("");
  const [agreementContent, setAgreementContent] = useState("");
  const [agreementLoading, setAgreementLoading] = useState(false);

  const openAgreement = async (name: string, title: string) => {
    setAgreementTitle(title);
    setAgreementOpen(true);
    setAgreementContent("");
    setAgreementLoading(true);
    try {
      const content = await api.readResource(name);
      setAgreementContent(content);
    } catch {
      setAgreementContent("无法加载协议内容");
    } finally {
      setAgreementLoading(false);
    }
  };

  /** 协议弹窗内链接点击：内置协议互引切换内容；外部 http/mailto 走系统程序 */
  const handleAgreementLinkClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    const resName = resourceDocNameFromHref(href);
    const docTitle = AGREEMENT_TITLES[resName];
    if (docTitle) {
      // 只把纯文件名交给 readResource，避免相对路径的 `..` 逃逸被 Rust 侧误解析
      void openAgreement(resName, docTitle);
      return;
    }
    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      api.openUrl(href).catch((err) => console.warn("打开链接失败", err));
    }
  };

  const isRemote = mode !== "local";
  const auth: AuthPayload = { authType: "token", username, token };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testRemote(url, auth);
      if (r.ok) {
        setTestResult({
          ok: true,
          text: r.empty ? "连接成功，远端是空仓库" : "连接成功，远端已有内容",
        });
      } else {
        setTestResult({
          ok: false,
          text: r.error?.message ?? "连接失败",
        });
      }
    } catch (e) {
      setTestResult({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setDataDir(dir);
      if (!isRemote) {
        await api.initWorkspace(dir, "local");
      } else {
        const st = await api.dirStatus(dir);
        if (st.empty) {
          // 空目录：远端有内容则 clone，空远端则得到一个带 origin 的空仓库
          const c = await api.cloneRemote(url, dir, auth);
          if (c.error) throw new Error(c.error.message);
        }
        // init_workspace 幂等：已有仓库/笔记不会被覆盖
        await api.initWorkspace(dir, "local");
        await api.setRemote(dir, url);
        await api.saveSyncConfig(url, "token", username, token);
        const sync = await api.gitSync(dir, auth);
        if (sync.error) throw new Error(sync.error.message);
      }
      onDone(dir);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const steps = [
    { title: "选择数据目录", icon: <FolderOpen size={15} /> },
    { title: "选择同步方式", icon: <Cloud size={15} /> },
    { title: "完成", icon: <PartyPopper size={15} /> },
  ];

  return (
    <div className="flex h-full items-center justify-center bg-editor">
      <div className="w-[480px] rounded-2xl border border-border bg-editor shadow-lg-soft">
        {/* 步骤指示 */}
        <div className="flex border-b border-border">
          {steps.map((s, i) => (
            <div
              key={s.title}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 py-3.5 text-[14px]",
                i === step
                  ? "border-b-2 border-accent font-medium text-foreground"
                  : "text-secondary",
              )}
            >
              {s.icon}
              {s.title}
            </div>
          ))}
        </div>

        <div className="px-6 py-5">
          {/* Git 未安装指引 */}
          {gitAvailable === false && (
            <div className="mb-4 flex items-start gap-2.5 rounded border border-yellow-400/40 bg-yellow-50 p-3 dark:border-yellow-600/30 dark:bg-yellow-950/30">
              <AlertTriangle
                size={16}
                className="mt-0.5 shrink-0 text-yellow-600 dark:text-yellow-400"
              />
              <div className="min-w-0 space-y-1.5 text-[13px]">
                <p className="font-medium text-yellow-800 dark:text-yellow-300">
                  未检测到 Git
                </p>
                <p className="text-yellow-700 dark:text-yellow-400/80">
                  Git 用于笔记的版本管理和同步。你可以先安装 Git，也可以跳过，稍后在设置中配置。
                </p>
                <div className="space-y-1 rounded bg-white/60 p-2 dark:bg-black/20">
                  <p className="text-xs font-medium text-yellow-800 dark:text-yellow-300">
                    安装方法：
                  </p>
                  <div className="space-y-0.5 text-xs text-yellow-700 dark:text-yellow-400/80">
                    <p className="flex items-center gap-1">
                      <Terminal size={11} className="shrink-0" />
                      <span className="font-medium">macOS：</span>
                      <code className="rounded bg-yellow-100 px-1 py-px dark:bg-yellow-900/40">
                        brew install git
                      </code>
                      <span>或安装</span>
                      <a
                        href="https://git-scm.com/download/mac"
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-yellow-900 dark:hover:text-yellow-200"
                      >
                        官方包
                      </a>
                    </p>
                    <p className="flex items-center gap-1">
                      <Terminal size={11} className="shrink-0" />
                      <span className="font-medium">Windows：</span>
                      <code className="rounded bg-yellow-100 px-1 py-px dark:bg-yellow-900/40">
                        winget install Git.Git
                      </code>
                      <span>或</span>
                      <a
                        href="https://git-scm.com/download/win"
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-yellow-900 dark:hover:text-yellow-200"
                      >
                        官方安装包
                      </a>
                    </p>
                    <p className="flex items-center gap-1">
                      <Terminal size={11} className="shrink-0" />
                      <span className="font-medium">Linux：</span>
                      <code className="rounded bg-yellow-100 px-1 py-px dark:bg-yellow-900/40">
                        sudo apt install git
                      </code>
                    </p>
                  </div>
                </div>
                <p className="text-xs text-yellow-600/80 dark:text-yellow-500/60">
                  安装 Git 后重启应用即可使用版本管理功能。
                </p>
              </div>
            </div>
          )}
          {step === 0 && (
            <div className="space-y-3">
              <p className="text-[13px] text-secondary">
                笔记以真实 Markdown 文件存放在此目录中，目录树就是文件夹结构。
              </p>
              <div className="flex gap-2">
                <Input
                  value={dir}
                  onChange={(e) => { setDir(e.target.value); setHint(null); }}
                  placeholder={dirLoading ? "加载中…" : "输入或选择目录路径"}
                  disabled={dirLoading}
                />
                <Button
                  variant="outline"
                  className="shrink-0"
                  onClick={async () => {
                    try {
                      const { open } = await import("@tauri-apps/plugin-dialog");
                      const selected = await open({ directory: true, multiple: false });
                      if (typeof selected === "string" && selected) {
                        setDir(selected);
                        setHint(null);
                      }
                    } catch { /* 非 Tauri 环境降级 */ }
                  }}
                >
                  <FolderOpen size={14} className="mr-1.5" />
                  浏览
                </Button>
              </div>
              <p className="text-xs text-secondary">
                目录不存在时会自动创建，并写入一篇欢迎笔记。
              </p>

              {/* 协议同意 */}
              <label className="flex items-start gap-2 pt-2 border-t border-border cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => { setAgreed(e.target.checked); setHint(null); }}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent"
                />
                <span className="text-xs text-secondary leading-relaxed">
                  我已阅读并同意
                  <button
                    type="button"
                    className="mx-0.5 text-accent hover:underline inline-flex items-center gap-0.5"
                    onClick={(e) => { e.stopPropagation(); openAgreement("用户协议.md", "用户协议"); }}
                  >
                    用户协议
                  </button>
                  和
                  <button
                    type="button"
                    className="mx-0.5 text-accent hover:underline inline-flex items-center gap-0.5"
                    onClick={(e) => { e.stopPropagation(); openAgreement("隐私政策.md", "隐私政策"); }}
                  >
                    隐私政策
                    <ExternalLink size={9} />
                  </button>
                </span>
              </label>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-2">
              {SYNC_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border p-3.5 text-left",
                    mode === opt.value
                      ? "border-accent bg-accent-soft"
                      : "border-border hover:bg-hover",
                  )}
                  onClick={() => setMode(opt.value)}
                >
                  <span className="mt-0.5 text-secondary">{opt.icon}</span>
                  <span>
                    <span className="block text-[13px] font-medium">
                      {opt.label}
                    </span>
                    <span className="block text-xs text-secondary">
                      {opt.desc}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3 text-[13px]">
              {isRemote ? (
                <>
                  <div>
                    <label className="mb-1 block text-secondary">仓库地址</label>
                    <Input
                      placeholder="https://gitee.com/user/notes.git"
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setTestResult(null);
                      }}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="用户名"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                    />
                    <Input
                      type="password"
                      placeholder="Token / 密码"
                      value={token}
                      onChange={(e) => {
                        setToken(e.target.value);
                        setTestResult(null);
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!url.trim() || testing}
                      onClick={testConnection}
                    >
                      {testing && <Loader2 size={12} className="animate-spin" />}
                      测试连接
                    </Button>
                    {testResult && (
                      <span
                        className={cn(
                          "text-xs",
                          testResult.ok ? "text-green-600" : "text-red-500",
                        )}
                      >
                        {testResult.text}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-secondary">
                    远端为空时直接初始化并首次推送；远端有内容时 clone 到数据目录。
                  </p>
                  <p className="text-xs text-secondary">
                    Token 将安全存储到系统钥匙串，仅在同步时读取。
                  </p>
                </>
              ) : (
                <div className="space-y-3">
                  <p className="text-secondary">确认以下信息后开始使用：</p>
                  <div className="space-y-1.5 rounded border border-border p-3">
                    <div>
                      <span className="text-secondary">数据目录：</span>
                      {dir}
                    </div>
                    <div>
                      <span className="text-secondary">同步方式：</span>
                      {SYNC_OPTIONS.find((o) => o.value === mode)?.label}
                    </div>
                  </div>
                  <p className="text-xs text-secondary">
                    将执行：创建目录 → 写入欢迎笔记 → git init → 首次提交。
                  </p>
                </div>
              )}
              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
          )}
        </div>

        <div className="flex justify-between border-t border-border px-6 py-3">
          <Button
            variant="ghost"
            disabled={step === 0 || busy}
            onClick={() => setStep((s) => s - 1)}
          >
            上一步
          </Button>
          {step < 2 ? (
            <div className="flex items-center gap-2">
              {hint && (
                <span className="text-xs text-red-500">{hint}</span>
              )}
              <Button
                onClick={() => {
                  if (!dir.trim()) {
                    setHint("请先输入或选择数据目录");
                    return;
                  }
                  if (!agreed) {
                    setHint("请先阅读并同意用户协议和隐私政策");
                    return;
                  }
                  setHint(null);
                  setStep((s) => s + 1);
                }}
              >
                下一步
              </Button>
            </div>
          ) : (
            <Button
              onClick={finish}
              disabled={busy || (isRemote && !url.trim())}
            >
              {busy ? "初始化中…" : "开始使用"}
            </Button>
          )}
        </div>
      </div>

      {/* 协议弹窗 */}
      <Dialog
        open={agreementOpen}
        onClose={() => setAgreementOpen(false)}
        title={agreementTitle}
        width={560}
        footer={
          <Button
            variant="default"
            onClick={() => { setAgreed(true); setAgreementOpen(false); setHint(null); }}
          >
            同意并关闭
          </Button>
        }
      >
        {agreementLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-secondary" />
          </div>
        ) : (
          <div
            className="max-h-[60vh] overflow-y-auto text-[13px] leading-relaxed text-secondary agreement-content"
            onClick={handleAgreementLinkClick}
            dangerouslySetInnerHTML={{
              __html: marked.parse(agreementContent, { async: false }) as string,
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
