mod menu;

#[cfg(target_os = "macos")]
mod export_pdf_macos;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::time::Duration;
use wait_timeout::ChildExt;

const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// 统一输出 "/" 分隔的路径字符串。前端所有路径处理（isExternalPath / parentOf /
/// relativePath / resolveLinkPath / expandTo 等）都假设 "/" 分隔符，而 Windows 上
/// Path::to_string_lossy 返回反斜杠路径，必须在这里统一替换，否则内部文件会被误判
/// 为外部、目录树展开/链接解析失效。
fn disp(p: impl AsRef<Path>) -> String {
    p.as_ref().to_string_lossy().replace('\\', "/").to_string()
}

// 外部打开的文件路径（系统右键 → 打开方式）
static OPENED_FILE: Mutex<Option<String>> = Mutex::new(None);

// git_sync 重入互斥：定时器/聚焦/手动三条路径可能并发触发同步，
// 并发同步会互踩 index.lock / rebase 中间态，已在同步中直接拒绝。
static SYNC_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

// 原子写临时文件序号：与 PID 拼接保证同一进程内并发写同一路径时 tmp 名唯一
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Types returned to the frontend
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<TreeNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirStatus {
    exists: bool,
    empty: bool,
    has_md: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    is_repo: bool,
    uncommitted: u32,
}

/// 结构化错误，避免把原始 git 错误直接抛给前端。
/// kind: network | auth | not_found | not_a_repo | timeout | no_remote | index_lock | other
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct GitErrorPayload {
    kind: String,
    message: String,
}

impl GitErrorPayload {
    fn new(kind: &str, message: &str) -> Self {
        GitErrorPayload {
            kind: kind.to_string(),
            message: message.to_string(),
        }
    }
    fn friendly(kind: &str) -> Self {
        let msg = match kind {
            "network" => "网络不可达，请检查网络连接",
            "auth" => "认证失败，请检查凭据",
            "not_found" => "仓库不存在或无访问权限",
            "not_a_repo" => "目标不是一个 git 仓库",
            "timeout" => "操作超时（30 秒）",
            "no_remote" => "未配置远程仓库",
            "git_not_found" => "未检测到 Git，请安装后重试",
            "index_lock" => "Git 索引锁文件残留（.git/index.lock），请稍后重试或手动删除",
            _ => "操作失败",
        };
        GitErrorPayload::new(kind, msg)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestRemoteResult {
    ok: bool,
    empty: bool,
    error: Option<GitErrorPayload>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloneResult {
    cloned: bool,
    empty: bool,
    error: Option<GitErrorPayload>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncResult {
    synced: bool,
    pulled_changes: bool,
    conflicts: Vec<String>,
    pending: u32,
    error: Option<GitErrorPayload>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    name: String,
    path: String,
    line: usize,
    context: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TemplateInfo {
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BacklinkInfo {
    name: String,
    path: String,
    line: usize,
    context: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TagInfo {
    tag: String,
    count: usize,
    files: Vec<String>,
}

/// 前端传入的认证信息。authType: "" | "ssh" | "token"
#[derive(Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
struct AuthPayload {
    auth_type: String,
    username: String,
    token: String,
}

// ---------------------------------------------------------------------------
// Persisted config (~/.config/notes/config.toml, mode 0600)
// token 存系统 keyring；keyring 不可用时（如无 Secret Service）回退明文 0600 文件
// ---------------------------------------------------------------------------

const KEYRING_SERVICE: &str = "jot-notes";
const KEYRING_TOKEN_KEY: &str = "sync-token";

/// 仅写入非空 token；清空凭据必须走 keyring_delete_token 显式删除，
/// 防止"保存时传了空串"把用户已有 token 静默抹掉。
fn keyring_store_token(token: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_TOKEN_KEY).map_err(|e| e.to_string())?;
    entry.set_password(token).map_err(|e| e.to_string())
}

fn keyring_delete_token() -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_TOKEN_KEY).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn keyring_load_token() -> Option<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_TOKEN_KEY).ok()?;
    entry.get_password().ok()
}

/// 惰性补全 token：auth.token 为空时从系统钥匙串读取。
/// 避免启动时访问钥匙串（macOS 会弹授权框），只在真正执行远程操作时才取。
fn resolve_auth_token(mut auth: AuthPayload) -> AuthPayload {
    if auth.token.is_empty() {
        // 先从钥匙串读，读不到再读配置文件兜底（兼容 keyring 不可用的环境）
        if let Some(t) = keyring_load_token() {
            auth.token = t;
        } else if let Ok(cfg) = load_config() {
            auth.token = cfg.token;
        }
    }
    auth
}

/// 判断 remote 地址是否为 SSH 形式（git@host:path 或 ssh://…）。
fn is_ssh_remote(url: &str) -> bool {
    url.starts_with("ssh://") || (url.contains('@') && !url.contains("://") && url.contains(':'))
}

/// HTTPS + Token 模式：发起网络操作前校验地址协议与凭据。
/// 明文 http:// 会让 token 被截获，直接拒绝。
/// SSH（auth_type == "ssh" 或地址为 git@/ssh:// 形式）交给系统 ssh
/// （~/.ssh、agent、known_hosts 全部由系统处理），跳过 URL/token 校验。
fn check_auth_url_match(url: &str, auth: &AuthPayload) -> Result<(), GitErrorPayload> {
    if auth.auth_type == "ssh" || is_ssh_remote(url) {
        return Ok(());
    }
    if url.starts_with("http://") {
        return Err(GitErrorPayload::new(
            "auth",
            "仅支持 HTTPS 地址（明文 HTTP 会泄露凭据）",
        ));
    }
    if !url.starts_with("https://") {
        return Err(GitErrorPayload::new(
            "auth",
            "仅支持 HTTPS 仓库地址（https://…）",
        ));
    }
    if auth.token.is_empty() {
        return Err(GitErrorPayload::new("auth", "未填写 Token"));
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AppConfig {
    data_dir: String,
    remote_url: String,
    auth_type: String,
    username: String,
    token: String,
    #[serde(default)]
    reuse_tab: bool,
}

fn config_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or("cannot resolve config dir")?;
    Ok(base.join("notes").join("config.toml"))
}

fn load_config() -> Result<AppConfig, String> {
    let p = config_path()?;
    if !p.exists() {
        return Ok(AppConfig::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    toml::from_str(&s).map_err(|e| e.to_string())
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let p = config_path()?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let serialized = toml::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    // 原子写：临时文件 + rename，避免中途失败写坏配置
    let tmp = p.with_file_name("config.toml.tmp");
    fs::write(&tmp, serialized).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// System git runner (VS Code / IDEA 模式：全部走系统 git 命令)
// ---------------------------------------------------------------------------

/// 从父进程环境中剔除的 GIT_* 变量：从导出过 GIT_DIR 等变量的 shell 启动应用时，
/// 继承这些变量会让所有 git 操作打到错误的仓库/索引/全局配置上。
const GIT_ENV_BLOCKLIST: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_SSH",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
];

/// 执行系统 git。GIT_TERMINAL_PROMPT=0 保证绝不交互询问；30s 超时后 kill。
/// extra_configs 以 `git -c key=value` 形式注入（兜底签名等公开配置）；
/// envs 以环境变量形式注入（认证头等敏感配置，避免 argv 被 ps 看到）。
/// 等待期间用两个线程持续排空 stdout/stderr——否则管道缓冲（64KB）写满后
/// 子进程阻塞，造成千级脏文件的 git status 等场景假超时。
fn run_git(
    dir: Option<&Path>,
    args: &[&str],
    extra_configs: &[String],
) -> Result<String, GitErrorPayload> {
    run_git_full(dir, args, extra_configs, &[])
}

fn run_git_full(
    dir: Option<&Path>,
    args: &[&str],
    extra_configs: &[String],
    envs: &[(String, String)],
) -> Result<String, GitErrorPayload> {
    let mut cmd = Command::new("git");
    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW：防止每次 git 调用弹出控制台窗口
        cmd.creation_flags(0x08000000);
    }
    for c in extra_configs {
        cmd.arg("-c").arg(c);
    }
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C") // 强制英文报错，保证 stderr 可解析分类
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for k in GIT_ENV_BLOCKLIST {
        cmd.env_remove(k);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| GitErrorPayload::new("other", &format!("无法启动 git：{}", e)))?;
    // 持续读取管道到缓冲区，防止子进程写满管道缓冲后阻塞
    let mut child_out = child.stdout.take();
    let mut child_err = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut o) = child_out {
            let _ = o.read_to_end(&mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut e) = child_err {
            let _ = e.read_to_end(&mut buf);
        }
        buf
    });
    let status = match child.wait_timeout(GIT_TIMEOUT) {
        Ok(Some(status)) => status,
        Ok(None) => {
            // 注意：kill 只杀直接子进程，git 拉起的远端传输子进程（ssh/remote-helper）
            // 可能残留；零依赖下无法可靠杀进程组（需 libc setsid/killpg），暂不做。
            let _ = child.kill();
            let _ = child.wait();
            let _ = out_handle.join();
            let _ = err_handle.join();
            return Err(GitErrorPayload::friendly("timeout"));
        }
        Err(e) => return Err(GitErrorPayload::new("other", &e.to_string())),
    };
    // 进程退出后管道关闭，读取线程随之结束
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    if status.success() {
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    } else {
        Err(classify(&String::from_utf8_lossy(&stderr)))
    }
}

/// URL 脱敏：`://user:pass@host` → `://***@host`，防止内嵌凭据随错误信息泄漏到前端。
fn redact_userinfo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find("://") {
        out.push_str(&rest[..idx + 3]);
        rest = &rest[idx + 3..];
        // authority 结束于第一个路径/空白/引号字符
        let auth_end = rest
            .find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"')
            .unwrap_or(rest.len());
        let authority = &rest[..auth_end];
        if let Some(at) = authority.rfind('@') {
            out.push_str("***@");
            out.push_str(&authority[at + 1..]);
        } else {
            out.push_str(authority);
        }
        rest = &rest[auth_end..];
    }
    out.push_str(rest);
    out
}

/// 解析 stderr 文本进行错误分类，不向前端暴露原始报错。
fn classify(stderr: &str) -> GitErrorPayload {
    let m = stderr.to_lowercase();
    let kind = if m.contains("index.lock") {
        // 超时 kill 或异常退出残留的 .git/index.lock，提示用户自愈方式
        "index_lock"
    } else if m.contains("permission denied")
        || m.contains("authentication failed")
        || m.contains("could not read username")
        || m.contains("access denied")
        || m.contains("returned error: 40") // HTTP 401/403/404 优先判 auth
    {
        "auth"
    } else if m.contains("not a git repository") {
        "not_a_repo"
    } else if m.contains("repository not found")
        || m.contains("not found")
        || m.contains("does not exist")
    {
        "not_found"
    } else if m.contains("could not resolve host")
        || m.contains("connection refused")
        || m.contains("timed out")
        || m.contains("unreachable")
        || m.contains("failed to connect")
        || m.contains("name or service not known")
        || m.contains("unable to access")
        || m.contains("handshake")
        || m.contains("gnutls")
        || m.contains("ssl")
        || m.contains("tls")
    {
        "network"
    } else {
        "other"
    };
    let mut payload = GitErrorPayload::friendly(kind);
    if kind == "other" {
        let first = stderr.lines().next().unwrap_or("").trim();
        if !first.is_empty() {
            // stderr 原样抛出前脱敏：去掉 URL 中内嵌的 user:pass
            payload.message = format!("操作失败：{}", redact_userinfo(first));
        }
    }
    payload
}

/// HTTPS token 认证：不嵌进 URL（避免泄露到 .git/config），
/// 通过 GIT_CONFIG_* 环境变量逐命令注入 Authorization 头——argv 注入
/// 运行期 ps aux 可读。键名用 `http.https://<host>.extraHeader` 限定作用域，
/// 跨主机重定向不会把凭据带给 redirect 目标（git http.<url>.* 匹配规则）。
/// ssh 模式交给系统 ssh（~/.ssh、agent、known_hosts 全部由系统处理），返回空。
fn auth_envs(auth: &AuthPayload, url: &str) -> Vec<(String, String)> {
    if auth.auth_type == "token" && !auth.token.is_empty() {
        let user = if auth.username.is_empty() {
            "git"
        } else {
            auth.username.as_str()
        };
        let encoded = BASE64.encode(format!("{}:{}", user, auth.token));
        vec![
            ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
            (
                "GIT_CONFIG_KEY_0".to_string(),
                format!("http.{}.extraHeader", url_scope_prefix(url)),
            ),
            (
                "GIT_CONFIG_VALUE_0".to_string(),
                format!("Authorization: Basic {}", encoded),
            ),
        ]
    } else {
        vec![]
    }
}

/// 取 URL 的 `scheme://host[:port]` 前缀，作为 http.<url>.* 配置的作用域。
/// 非 http(s) 形式（ssh 等）原样返回（此时不会用于注入认证头）。
fn url_scope_prefix(url: &str) -> String {
    let scheme = match url.split_once("://") {
        Some((s, _)) if s == "http" || s == "https" => s,
        _ => return url.trim().to_string(),
    };
    let rest = &url[scheme.len() + 3..];
    let authority = rest.split('/').next().unwrap_or("");
    // 剥离可能存在的 userinfo（仅用于作用域键名，凭据不应出现在 URL 里）
    let host = authority.rsplit('@').next().unwrap_or(authority);
    format!("{}://{}", scheme, host)
}

/// 校验 remote URL：拒绝 `-` 开头（会被 git 当作选项）与内嵌凭据
/// （user:pass@host 会明文持久化到 .git/config，违背"绝不嵌入 URL"设计）。
fn validate_remote_url(url: &str) -> Result<(), String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("远程地址不能为空".to_string());
    }
    if u.starts_with('-') {
        return Err("非法的远程地址".to_string());
    }
    if let Some((scheme, rest)) = u.split_once("://") {
        if matches!(scheme, "http" | "https" | "ssh" | "git" | "ftp") {
            let authority = rest.split('/').next().unwrap_or("");
            if authority.contains('@') {
                return Err(
                    "远程地址不允许内嵌用户名/密码（凭据请通过认证配置提供）".to_string()
                );
            }
        }
    }
    Ok(())
}

/// 用户没配 user.name/email 时 commit 会失败，用 -c 兜底签名。
fn ident_configs(dir: &Path) -> Vec<String> {
    match run_git(Some(dir), &["var", "GIT_AUTHOR_IDENT"], &[]) {
        Ok(_) => vec![],
        Err(_) => vec![
            "user.name=Notes App".to_string(),
            "user.email=notes@localhost".to_string(),
        ],
    }
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

const WELCOME_NOTE: &str = r#"# 欢迎使用 Notes

这是一个基于 **git** 的个人 Markdown 笔记应用。

- 左侧是真实的目录树，每一个节点都是磁盘上的真实文件/文件夹
- 右侧是所见即所得编辑器（右上角可切换源码模式）
- 所有笔记由 git 负责版本管理与同步

## 快速上手

1. 点击左下角 **新建笔记** 开始写作
2. 右键目录树节点可进行重命名、删除等操作
3. 编辑停顿 2 秒后自动保存到磁盘

祝你记录愉快！
"#;

fn is_hidden(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

fn sort_entries(mut entries: Vec<PathBuf>) -> Vec<PathBuf> {
    entries.sort_by(|a, b| {
        let a_dir = a.is_dir();
        let b_dir = b.is_dir();
        if a_dir != b_dir {
            return if a_dir { Ordering::Less } else { Ordering::Greater };
        }
        let a_name = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let b_name = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if a_dir && (a_name == ".assets") != (b_name == ".assets") {
            return if a_name == ".assets" {
                Ordering::Greater
            } else {
                Ordering::Less
            };
        }
        a_name.to_lowercase().cmp(&b_name.to_lowercase())
    });
    entries
}

fn build_tree(dir: &Path) -> Result<TreeNode, String> {
    let mut children = Vec::new();
    if dir.is_dir() {
        let entries: Vec<PathBuf> = fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| !is_hidden(p))
            // 跳过符号链接，防止链接环导致递归栈溢出
            .filter(|p| {
                fs::symlink_metadata(p)
                    .map(|m| !m.file_type().is_symlink())
                    .unwrap_or(false)
            })
            .collect();
        for entry in sort_entries(entries) {
            if entry.is_dir() {
                children.push(build_tree(&entry)?);
            } else if entry.extension().and_then(|e| e.to_str()) == Some("md") {
                children.push(TreeNode {
                    name: entry
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                    path: disp(&entry),
                    is_dir: false,
                    children: vec![],
                });
            }
        }
    }
    Ok(TreeNode {
        name: dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
        path: disp(dir),
        is_dir: true,
        children,
    })
}

fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let candidate = dir.join(format!("{}{}", stem, ext));
    if !candidate.exists() {
        return candidate;
    }
    // 冲突时持续增大后缀，绝不返回已存在的路径（否则会覆盖文件）
    let mut i = 2u32;
    loop {
        let c = dir.join(format!("{}-{}{}", stem, i, ext));
        if !c.exists() {
            return c;
        }
        i += 1;
    }
}

/// 是否为符号链接。目录遍历时跳过，防止 git 同步来的仓库里
/// 链接环导致递归栈溢出、或越界读写链接目标的外部文件。
fn is_symlink(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// 原子写临时文件路径：PID + 进程内原子序号，保证并发写同一路径时 tmp 名唯一。
fn tmp_path_for(p: &Path, fallback: &str) -> PathBuf {
    let n = TMP_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
    p.with_file_name(format!(
        ".{}.tmp-{}-{}",
        p.file_name().and_then(|n| n.to_str()).unwrap_or(fallback),
        std::process::id(),
        n
    ))
}

/// 是否 Markdown 路径（大小写不敏感，兼容 ".MD"）
fn is_markdown_path(s: &str) -> bool {
    Path::new(s)
        .extension()
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// File system commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_opened_file() -> Option<String> {
    OPENED_FILE.lock().ok()?.take()
}

#[tauri::command]
fn default_notes_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("cannot resolve home directory")?;
    Ok(disp(home.join("Notes")))
}

#[tauri::command]
fn dir_status(path: String) -> Result<DirStatus, String> {
    let t0 = std::time::Instant::now();
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(DirStatus {
            exists: false,
            empty: true,
            has_md: false,
        });
    }
    let entries: Vec<PathBuf> = fs::read_dir(p)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| !is_hidden(p))
        .collect();
    let has_md = entries
        .iter()
        .any(|f| f.extension().and_then(|e| e.to_str()) == Some("md"));
    let result = DirStatus {
        exists: true,
        empty: entries.is_empty(),
        has_md,
    };
    eprintln!("⏱ [Rust] dir_status: {:.1}ms", t0.elapsed().as_secs_f64() * 1000.0);
    Ok(result)
}

/// 迁移旧 assets/ → .assets/：重命名目录 + 更新所有 .md 文件中的引用路径。
/// 幂等：仅当旧 assets/ 存在且 .assets/ 不存在时执行。
fn migrate_assets_dir(notes_dir: &Path) {
    let old_dir = notes_dir.join("assets");
    let new_dir = notes_dir.join(".assets");
    if !old_dir.is_dir() || new_dir.exists() {
        return;
    }
    // 1. 重命名目录
    if fs::rename(&old_dir, &new_dir).is_err() {
        return;
    }
    // 2. 扫描所有 .md 文件，替换 ](assets/ → ](.assets/
    if let Err(e) = migrate_asset_refs(notes_dir) {
        eprintln!("migrate asset refs warning: {}", e);
    }
}

/// 递归遍历目录，将 .md 文件中 `](assets/` 替换为 `](.assets/`。
fn migrate_asset_refs(dir: &Path) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name.starts_with('_') {
            continue;
        }
        // 跳过符号链接，防止链接环栈溢出/越界访问外部文件
        if is_symlink(&path) {
            continue;
        }
        if path.is_dir() {
            migrate_asset_refs(&path)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            if content.contains("](assets/") {
                let updated = content.replace("](assets/", "](.assets/");
                // 原子写（与 write_file 保持一致）
                let tmp = tmp_path_for(&path, "migrate");
                fs::write(&tmp, &updated).map_err(|e| e.to_string())?;
                fs::rename(&tmp, &path).map_err(|e| {
                    let _ = fs::remove_file(&tmp); // rename 失败不残留 tmp
                    e.to_string()
                })?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn list_tree(path: String) -> Result<TreeNode, String> {
    let t0 = std::time::Instant::now();
    let p = Path::new(&path);
    if !p.exists() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
        fs::write(p.join("欢迎使用.md"), WELCOME_NOTE).map_err(|e| e.to_string())?;
    }
    migrate_assets_dir(p);
    let tree = build_tree(p)?;
    eprintln!("⏱ [Rust] list_tree: {:.1}ms", t0.elapsed().as_secs_f64() * 1000.0);
    Ok(tree)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let t0 = std::time::Instant::now();
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    eprintln!("⏱ [Rust] read_file ({}B): {:.1}ms", content.len(), t0.elapsed().as_secs_f64() * 1000.0);
    Ok(content)
}

/// 返回文件修改时间的 Unix 毫秒时间戳；文件不存在返回 0。
#[tauri::command]
fn file_mtime(path: String) -> Result<u64, String> {
    let meta = match fs::metadata(Path::new(&path)) {
        Ok(m) => m,
        Err(_) => return Ok(0),
    };
    let mtime = meta.modified().map_err(|e| e.to_string())?;
    Ok(mtime
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

#[tauri::command]
fn search_content(dir: String, query: String) -> Vec<SearchMatch> {
    let q = query.to_lowercase();
    let mut results: Vec<SearchMatch> = Vec::new();
    search_walk(Path::new(&dir), &q, &mut results);
    results.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
    });
    results
}

fn search_walk(dir: &Path, query: &str, out: &mut Vec<SearchMatch>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name.starts_with('_') {
            continue;
        }
        // 跳过符号链接，防止链接环栈溢出/越界访问外部文件
        if is_symlink(&path) {
            continue;
        }
        if path.is_dir() {
            search_walk(&path, query, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            if let Ok(content) = fs::read_to_string(&path) {
                for (idx, line) in content.lines().enumerate() {
                    if line.to_lowercase().contains(query) {
                        let ctx = if line.len() > 120 {
                            format!("{}…", &line[..117])
                        } else {
                            line.to_string()
                        };
                        out.push(SearchMatch {
                            name: path
                                .file_stem()
                                .and_then(|n| n.to_str())
                                .unwrap_or(name)
                                .to_string(),
                            path: disp(&path),
                            line: idx + 1,
                            context: ctx,
                        });
                        if out.len() >= 200 {
                            return;
                        }
                    }
                }
            }
        }
    }
}

// ---------- 模板 ----------

#[tauri::command]
fn list_templates(dir: String) -> Vec<TemplateInfo> {
    let tmpl_dir = Path::new(&dir).join("_templates");
    if !tmpl_dir.is_dir() {
        return vec![];
    }
    let mut out: Vec<TemplateInfo> = Vec::new();
    if let Ok(entries) = fs::read_dir(&tmpl_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                out.push(TemplateInfo {
                    name: path
                        .file_stem()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                    path: disp(&path),
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
fn create_from_template(dir: String, template_path: String, target_name: String) -> Result<String, String> {
    // 名称消毒：`../` 等可越界写到目标目录之外
    let target_name = sanitize_name(&target_name)?.to_string();
    let content = fs::read_to_string(&template_path).map_err(|e| e.to_string())?;
    let now = chrono::Local::now();
    let rendered = content
        .replace("{{title}}", &target_name)
        .replace("{{date}}", &now.format("%Y-%m-%d").to_string())
        .replace("{{time}}", &now.format("%H:%M").to_string())
        .replace("{{datetime}}", &now.format("%Y-%m-%d %H:%M").to_string());
    let p = Path::new(&dir).join(format!("{}.md", &target_name));
    // 重名处理
    let mut final_path = p.clone();
    let mut n = 2;
    while final_path.exists() {
        final_path = Path::new(&dir).join(format!("{}-{}.md", &target_name, n));
        n += 1;
    }
    fs::write(&final_path, &rendered).map_err(|e| e.to_string())?;
    Ok(disp(&final_path))
}

// ---------- 反向链接 ----------

/// 异步化：全库递归扫描在 blocking 线程池执行，避免同步命令阻塞主线程（UI 卡顿）。
#[tauri::command]
async fn get_backlinks(dir: String, target_file: String) -> Vec<BacklinkInfo> {
    tauri::async_runtime::spawn_blocking(move || get_backlinks_blocking(&dir, &target_file))
        .await
        .unwrap_or_default()
}

fn get_backlinks_blocking(dir: &str, target_file: &str) -> Vec<BacklinkInfo> {
    // 统一分隔符：Windows 侧 target_file 可能含 `\`，Unix 上 Path::new 不把 `\` 当分隔符，
    // 先归一为 `/` 再解析，保证组件级相对路径与 stem 提取跨平台一致
    let dir = dir.replace('\\', "/");
    let target_file = target_file.replace('\\', "/");
    let root = Path::new(&dir);
    let target = Path::new(&target_file);
    let stem = target
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    // 根相对路径（无扩展名）用于匹配 [[目录/文件名]] 形式的 wiki 链接；与源文件目录无关，只算一次
    let rootrel = rel_path(root, target);
    let mut results: Vec<BacklinkInfo> = Vec::new();
    search_backlinks(root, &stem, &rootrel, &target_file, &mut results);
    // read_dir 顺序是 inode 序，输出做确定性排序
    results.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    results
}

fn search_backlinks(
    dir: &Path,
    stem: &str,
    rootrel: &str,
    target_path: &str,
    out: &mut Vec<BacklinkInfo>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // 跳过隐藏文件/目录与 _templates 模板目录；`_` 开头但其余部分不是模板的笔记仍参与扫描
        // （文件树 list_tree 只过滤隐藏项，若这里一律跳过 `_` 前缀会漏掉树上可见的笔记）
        // 符号链接防止链接环栈溢出/越界访问外部文件
        if name.starts_with('.') || name == "_templates" || is_symlink(&path) {
            continue;
        }
        if path.is_dir() {
            search_backlinks(&path, stem, rootrel, target_path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let current = disp(&path);
            // Windows 下 target_path 可能含 `\`，统一归一为 `/` 再比较，否则自身会被误报
            if current.replace('\\', "/") == target_path.replace('\\', "/") {
                continue; // 跳过自身
            }
            let parent = match path.parent() {
                Some(p) => p,
                None => continue,
            };
            if let Ok(content) = fs::read_to_string(&path) {
                // 文件相对路径：以"本文件所在目录"为基准（与 noteCompletion 写入、
                // linkActions 点击解析的约定一致），这是反链匹配的主基准；
                // rootrel 作为根相对基准兜底兼容手写的 `](子目录/文件.md)` 链接
                let rel = rel_path(parent, Path::new(target_path));
                if let Some((line, context)) = first_match_line(&content, stem, &rel, rootrel) {
                    out.push(BacklinkInfo {
                        name: path
                            .file_stem()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                            .to_string(),
                        path: current,
                        line,
                        context,
                    });
                }
            }
        }
    }
}

/// 计算 from_dir 到 target 的组件级相对路径（含必要 `../` 前缀）。
/// 组件级比较（而非字符串 strip_prefix），避免 `/a/b` 误剥 `/a/bc/...`。
fn rel_path(from_dir: &Path, target: &Path) -> String {
    let from: Vec<_> = from_dir.components().collect();
    let tgt: Vec<_> = target.components().collect();
    let mut common = 0;
    while common < from.len() && common < tgt.len() && from[common] == tgt[common] {
        common += 1;
    }
    let mut parts: Vec<String> = (0..(from.len() - common))
        .map(|_| "..".to_string())
        .collect();
    parts.extend(
        tgt[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

/// 逐行扫描 content，跳过 fenced code block（代码块里的 [[...]]/](...) 是误报），
/// 返回第一个命中行的 (1-based 行号, 截断后的上下文)。
///
/// 匹配的链接形态（均大小写不敏感）：
/// - wiki：`[[名]]`、`[[名|别名]]`、`[[名#锚点]]`、`[[名.md]]`、`[[目录/名]]`（带/不带扩展名）
/// - markdown：`](文件相对路径)`、`](<文件相对路径>)`（app 补全会包尖括号）、带 `./` 前缀、
///   根相对路径、以及百分号编码（`encodeURI` 风格，空格→%20、非 ASCII→%XX）的路径
fn first_match_line(content: &str, stem: &str, rel: &str, rootrel: &str) -> Option<(usize, String)> {
    let rootrel_noext = rootrel.strip_suffix(".md").unwrap_or(rootrel).to_lowercase();
    let stem = stem.to_lowercase();

    // wiki 候选：stem 与根相对路径（无扩展名）各派生一组
    let mut wiki: Vec<String> = Vec::new();
    for base in [stem.clone(), rootrel_noext.clone()] {
        wiki.push(format!("[[{}]]", base));
        wiki.push(format!("[[{}|", base));
        wiki.push(format!("[[{}#", base));
        wiki.push(format!("[[{}.md]]", base));
        wiki.push(format!("[[{}.md|", base));
        wiki.push(format!("[[{}.md#", base));
    }
    let wiki: Vec<String> = wiki.into_iter().map(|s| s.to_lowercase()).collect();

    // markdown 链接候选：文件相对 + 根相对，raw 与 percent-encoded，带/不带 `./`
    let mut md: Vec<String> = Vec::new();
    let mut push_md = |p: &str| {
        let p = p.to_lowercase();
        md.push(format!("]({p}"));
        md.push(format!("](<{p}>"));
    };
    let bases = [
        rel.to_string(),
        format!("./{}", rel),
        rootrel.to_string(),
        format!("./{}", rootrel),
    ];
    for base in &bases {
        push_md(base);
        push_md(&percent_encode_uri(base));
    }

    let mut in_code = false;
    for (idx, raw) in content.lines().enumerate() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        let lower = raw.to_lowercase();
        let hit = wiki.iter().any(|p| lower.contains(p.as_str()))
            || md.iter().any(|p| lower.contains(p.as_str()));
        if hit {
            return Some((idx + 1, truncate_line(raw)));
        }
    }
    None
}

/// 上下文截断：超过 100 字节时截到字符边界（避免 `&str` 字节切片在多字节字符中间 panic，
/// 中文每字 3 字节，长中文行极易踩中）。
fn truncate_line(line: &str) -> String {
    if line.len() <= 100 {
        return line.to_string();
    }
    let end = line.floor_char_boundary(97);
    format!("{}…", &line[..end])
}

/// encodeURI 风格百分号编码：保留 URL 安全字符，其余（含空格、非 ASCII）逐字节 %XX。
/// 与前端 noteCompletion 的 encodeURI 对齐，使带空格/中文名的文件链接也能被匹配。
fn percent_encode_uri(path: &str) -> String {
    let keep = b";,/?:@&=+$-_.!~*'()#";
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || keep.contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

// ---------- 标签 ----------

#[tauri::command]
fn list_tags(dir: String) -> Vec<TagInfo> {
    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    collect_tags(Path::new(&dir), &mut map);
    let mut out: Vec<TagInfo> = map
        .into_iter()
        .map(|(tag, files)| TagInfo {
            count: files.len(),
            tag,
            files,
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.tag.cmp(&b.tag)));
    out
}

fn collect_tags(dir: &Path, map: &mut std::collections::HashMap<String, Vec<String>>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name.starts_with('_') {
            continue;
        }
        // 跳过符号链接，防止链接环栈溢出/越界访问外部文件
        if is_symlink(&path) {
            continue;
        }
        if path.is_dir() {
            collect_tags(&path, map);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Some(tags) = extract_frontmatter_tags(&content) {
                    for tag in tags {
                        map.entry(tag).or_default().push(disp(&path));
                    }
                }
            }
        }
    }
}

fn extract_frontmatter_tags(content: &str) -> Option<Vec<String>> {
    if !content.starts_with("---\n") { return None; }
    let rest = &content[3..];
    let end = rest.find("\n---")?;
    let fm = &rest[..end];
    if let Some(tag_line) = fm.lines().find(|l| l.starts_with("tags:")) {
        let val = tag_line.trim_start_matches("tags:").trim();
        if val.starts_with('[') {
            let inner = val.trim_start_matches('[').trim_end_matches(']');
            return Some(inner.split(',').map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string()).filter(|s| !s.is_empty()).collect());
        } else if !val.is_empty() {
            return Some(vec![val.to_string()]);
        } else {
            let mut tags = Vec::new();
            let mut in_tags = false;
            for line in fm.lines() {
                if line.starts_with("tags:") { in_tags = true; continue; }
                if in_tags {
                    if let Some(t) = line.trim().strip_prefix("- ") {
                        tags.push(t.trim().to_string());
                    } else if !line.trim().starts_with('-') { break; }
                }
            }
            if !tags.is_empty() { return Some(tags); }
        }
    }
    None
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 原子写：先写临时文件再 rename 替换，避免中途崩溃留下半截文件
    let tmp = tmp_path_for(p, "notes");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, p).map_err(|e| {
        let _ = fs::remove_file(&tmp); // rename 失败不残留 tmp
        e.to_string()
    })
}

/// 名称消毒：拒绝空、路径分隔符、. 与 ..（create_note/create_dir/rename_path 共用）
fn sanitize_name(name: &str) -> Result<&str, String> {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." || n.contains('/') || n.contains('\\') {
        return Err("非法名称".to_string());
    }
    Ok(n)
}

#[tauri::command]
fn create_note(dir: String, name: Option<String>) -> Result<String, String> {
    let dir = Path::new(&dir);
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = match name {
        Some(n) if !n.trim().is_empty() => {
            let n = sanitize_name(&n)?;
            let n = n.trim_end_matches(".md");
            dir.join(format!("{}.md", n))
        }
        _ => unique_path(dir, "未命名", ".md"),
    };
    if path.exists() {
        return Err("同名文件已存在".to_string());
    }
    let title = path.file_stem().and_then(|s| s.to_str()).unwrap_or("未命名");
    fs::write(&path, format!("# {}\n", title)).map_err(|e| e.to_string())?;
    Ok(disp(&path))
}

#[tauri::command]
fn create_dir(parent: String, name: Option<String>) -> Result<String, String> {
    let parent = Path::new(&parent);
    let path = match name {
        Some(n) if !n.trim().is_empty() => parent.join(sanitize_name(&n)?),
        _ => unique_path(parent, "未命名目录", ""),
    };
    if path.exists() {
        return Err("同名目录已存在".to_string());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(disp(&path))
}

#[tauri::command]
fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let old = Path::new(&path);
    let new_name = sanitize_name(&new_name)?.to_string();
    let parent = old.parent().ok_or("invalid path")?;
    let new_path = parent.join(&new_name);
    if new_path.exists() {
        return Err("同名文件或目录已存在".to_string());
    }
    fs::rename(old, &new_path).map_err(|e| e.to_string())?;
    Ok(disp(&new_path))
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// 拖拽移动。git mv 语义：若在 git 仓库内，移动后 `git add -A` 登记
/// （同时覆盖旧路径删除与新路径新增）。
#[tauri::command]
fn move_path(src: String, dest_dir: String) -> Result<String, String> {
    let src_p = Path::new(&src);
    let dest_d = Path::new(&dest_dir);
    if !src_p.exists() {
        return Err("源文件不存在".to_string());
    }
    if !dest_d.is_dir() {
        return Err("目标不是目录".to_string());
    }
    let canon_src = fs::canonicalize(src_p).map_err(|e| e.to_string())?;
    let canon_dest = fs::canonicalize(dest_d).map_err(|e| e.to_string())?;
    if canon_dest == canon_src || canon_dest.starts_with(&canon_src) {
        return Err("不能移动到自身内部".to_string());
    }
    let dest = dest_d.join(src_p.file_name().ok_or("invalid path")?);
    if dest.exists() {
        return Err("目标位置已存在同名文件或目录".to_string());
    }
    fs::rename(src_p, &dest).map_err(|e| e.to_string())?;
    // git mv 语义：在仓库内只登记源与目标两条路径（不整树 add）
    if let Ok(root) = run_git(Some(dest_d), &["rev-parse", "--show-toplevel"], &[]) {
        let _ = run_git(
            Some(Path::new(root.trim())),
            &["add", "-A", "--", &src, &dest.to_string_lossy()],
            &[],
        );
    }
    Ok(disp(&dest))
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_system(path: String) -> Result<(), String> {
    // 用系统默认程序打开任意文件（附件 PDF/Office 文档等）。
    // 与 reveal_in_folder（在文件管理器中定位）不同：这里真正启动关联程序。
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // 用系统默认浏览器打开 http(s) 链接
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// External file import (drag & drop from the OS file manager)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedFile {
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    imported: Vec<ImportedFile>,
    skipped_dirs: u32,
}

/// 重名去重：`name.ext` → `name-1.ext` → `name-2.ext` …
fn dedup_file_name(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let fp = Path::new(file_name);
    let stem = fp.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    let ext = fp
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    for i in 1..1000 {
        let c = dir.join(format!("{}-{}{}", stem, i, ext));
        if !c.exists() {
            return c;
        }
    }
    candidate
}

/// 从系统文件管理器拖入外部文件：复制（不动原件）到 target_dir，
/// is_asset 时落到 target_dir/.assets/。目录不处理，计入 skippedDirs。
/// 文件名非 UTF-8 时用 lossy 转换容错。
#[tauri::command]
async fn import_files(
    target_dir: String,
    paths: Vec<String>,
    is_asset: bool,
) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || import_files_blocking(target_dir, paths, is_asset))
        .await
        .map_err(|e| e.to_string())?
}

fn import_files_blocking(
    target_dir: String,
    paths: Vec<String>,
    is_asset: bool,
) -> Result<ImportResult, String> {
    let dest_dir = if is_asset {
        Path::new(&target_dir).join(".assets")
    } else {
        PathBuf::from(&target_dir)
    };
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let mut imported = Vec::new();
    let mut skipped_dirs = 0u32;
    for p in &paths {
        let src = Path::new(p);
        if src.is_dir() {
            skipped_dirs += 1;
            continue;
        }
        if !src.is_file() {
            continue;
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| format!("无法读取文件名: {}", p))?;
        let dest = dedup_file_name(&dest_dir, &name);
        fs::copy(src, &dest).map_err(|e| format!("复制 {} 失败: {}", p, e))?;
        imported.push(ImportedFile {
            name: dest
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or(name),
            path: disp(&dest),
        });
    }
    Ok(ImportResult {
        imported,
        skipped_dirs,
    })
}

/// 保存二进制资源（webview 文件选择、剪贴板粘贴的图片等没有磁盘路径的
/// 来源）到 notes_dir/.assets/，文件名去重规则与 import_files 一致。
#[tauri::command]
async fn save_asset(
    notes_dir: String,
    file_name: String,
    data: Vec<u8>,
) -> Result<ImportedFile, String> {
    tauri::async_runtime::spawn_blocking(move || save_asset_blocking(notes_dir, file_name, data))
        .await
        .map_err(|e| e.to_string())?
}

fn save_asset_blocking(
    notes_dir: String,
    file_name: String,
    data: Vec<u8>,
) -> Result<ImportedFile, String> {
    // 名称消毒：`../` 等可越界写到 .assets 之外
    let file_name = sanitize_name(&file_name)?.to_string();
    let dest_dir = Path::new(&notes_dir).join(".assets");
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dedup_file_name(&dest_dir, &file_name);
    fs::write(&dest, &data).map_err(|e| format!("写入 {} 失败: {}", dest.display(), e))?;
    Ok(ImportedFile {
        name: dest
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or(file_name),
        path: disp(&dest),
    })
}

// ---------------------------------------------------------------------------
// Export commands
// ---------------------------------------------------------------------------

/// 将前端生成的内容原子写入磁盘（HTML / PNG 等导出）。
/// content 为原始字节——HTML 导出的 UTF-8 文本或 PNG 导出的二进制数据均适用。
/// 原子写：临时文件 + rename，防止崩溃留下半截文件。
#[tauri::command]
fn export_file(dest_path: String, content: Vec<u8>) -> Result<(), String> {
    let p = Path::new(&dest_path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = tmp_path_for(p, "export");
    fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, p).map_err(|e| {
        let _ = fs::remove_file(&tmp); // rename 失败不残留 tmp
        e.to_string()
    })
}

/// 检测系统是否安装了 Pandoc（运行 `pandoc --version` 判断）。
#[tauri::command]
fn check_pandoc_available() -> bool {
    run_version_probe("pandoc")
}

/// 运行 `<program> --version` 探测程序是否可用，带 30 秒超时
/// （子进程挂起时不等死，避免 UI 卡死）。
fn run_version_probe(program: &str) -> bool {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match child.wait_timeout(GIT_TIMEOUT) {
        Ok(Some(s)) => s.success(),
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            false
        }
        Err(_) => false,
    }
}

/// 调用系统 Pandoc 将 Markdown 源文件转换为目标格式。
/// 格式根据目标文件扩展名由 Pandoc 自动推断。
/// 超时 30 秒，与 git 操作一致。
#[tauri::command]
fn pandoc_export(source_path: String, dest_path: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&dest_path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Windows 上优先使用本地安装的 Pandoc
    #[cfg(target_os = "windows")]
    let pandoc_path = {
        let local = dirs::data_local_dir()
            .unwrap_or_default()
            .join("jot")
            .join("pandoc")
            .join("pandoc.exe");
        if local.exists() { local } else { PathBuf::from("pandoc") }
    };
    #[cfg(not(target_os = "windows"))]
    let pandoc_path = PathBuf::from("pandoc");

    let mut cmd = Command::new(&pandoc_path);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.args(["-f", "markdown", &source_path, "-o", &dest_path])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 Pandoc：{}", e))?;

    match child.wait_timeout(GIT_TIMEOUT) {
        Ok(Some(status)) => {
            if status.success() {
                Ok(())
            } else {
                let output = child.wait_with_output().unwrap_or(std::process::Output {
                    status,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                });
                let stderr = String::from_utf8_lossy(&output.stderr);
                let msg = if stderr.to_lowercase().contains("not found")
                    || stderr.to_lowercase().contains("no such file")
                {
                    "Pandoc 未安装或输入文件不存在"
                } else {
                    let first = stderr.lines().next().unwrap_or("").trim();
                    if first.is_empty() { "Pandoc 转换失败" } else { first }
                };
                Err(msg.to_string())
            }
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err("Pandoc 超时（30 秒），请检查文件大小".to_string())
        }
        Err(e) => Err(format!("Pandoc 运行异常：{}", e)),
    }
}

// ---------------------------------------------------------------------------
// Windows Pandoc 下载（自动安装 portable 版）
// ---------------------------------------------------------------------------

/// Windows：通过 PowerShell 下载 Pandoc portable 版到
/// %LOCALAPPDATA%/jot/pandoc/ 并返回 pandoc.exe 的完整路径。
/// 仅在 Windows 平台编译注册——macOS/Linux 通过包管理器安装。
#[cfg(target_os = "windows")]
#[tauri::command]
async fn download_pandoc_windows() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| download_pandoc_blocking())
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
fn download_pandoc_blocking() -> Result<String, String> {
    let local_app_data = dirs::data_local_dir().ok_or("无法获取本地数据目录")?;
    let install_dir = local_app_data.join("jot").join("pandoc");
    fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;

    let pandoc_exe = install_dir.join("pandoc.exe");
    if pandoc_exe.exists() {
        return Ok(disp(&pandoc_exe));
    }

    let zip_path = install_dir.join("pandoc.zip");
    // Pandoc 3.6.4 — 可后续升级版本号（升级时必须同步更新下方哈希）
    let url = "https://github.com/jgm/pandoc/releases/download/3.6.4/pandoc-3.6.4-windows-x86_64.zip";
    // 官方 release zip 的 SHA-256（取自 GitHub Releases 原始工件，
    // 2026-07 经 HTTPS 下载实测校验）。下载后强制校验，不匹配拒绝执行。
    const EXPECTED_SHA256: &str =
        "a9e5feb3d56d2fb0e3e765d1c33b8ee6b72e6963d7de31504edeec8cd1be34b1";

    // Step 1: PowerShell 下载（路径经 ps_quote 转义，防用户名含 ' 造成脚本注入）
    let ps_script = format!(
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; \
         Invoke-WebRequest -Uri '{}' -OutFile '{}' -UseBasicParsing",
        ps_quote(url),
        ps_quote(&zip_path.to_string_lossy())
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .status()
        .map_err(|e| format!("启动下载失败：{}", e))?;
    if !status.success() {
        let _ = fs::remove_file(&zip_path);
        return Err("Pandoc 下载失败，请检查网络连接".to_string());
    }

    // Step 1.5: SHA-256 校验，防止被篡改的压缩包落地执行
    let hash_script = format!(
        "(Get-FileHash -Algorithm SHA256 -Path '{}').Hash",
        ps_quote(&zip_path.to_string_lossy())
    );
    let hash_out = Command::new("powershell")
        .args(["-NoProfile", "-Command", &hash_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("校验失败：{}", e))?;
    let actual = String::from_utf8_lossy(&hash_out.stdout).trim().to_string();
    if !actual.eq_ignore_ascii_case(EXPECTED_SHA256) {
        let _ = fs::remove_file(&zip_path);
        return Err("Pandoc 下载校验失败（SHA-256 不匹配），已拒绝安装".to_string());
    }

    // Step 2: 解压
    let extract_dir = install_dir.join("extracted");
    let _ = fs::remove_dir_all(&extract_dir);
    let ps_extract = format!(
        "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
        ps_quote(&zip_path.to_string_lossy()),
        ps_quote(&extract_dir.to_string_lossy())
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_extract])
        .creation_flags(0x08000000)
        .status()
        .map_err(|e| format!("解压失败：{}", e))?;
    if !status.success() {
        let _ = fs::remove_dir_all(&extract_dir);
        let _ = fs::remove_file(&zip_path);
        return Err("Pandoc 解压失败".to_string());
    }

    // Step 3: 找到 pandoc.exe 并移动到 install_dir
    let found = find_pandoc_exe(&extract_dir)?;
    fs::rename(&found, &pandoc_exe).map_err(|e| e.to_string())?;

    // 清理
    let _ = fs::remove_dir_all(&extract_dir);
    let _ = fs::remove_file(&zip_path);

    Ok(disp(&pandoc_exe))
}

/// PowerShell 单引号字符串转义：`'` → `''`。
/// 用户名含单引号时，直接插值会造成脚本注入。
#[cfg(target_os = "windows")]
fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn find_pandoc_exe(dir: &Path) -> Result<PathBuf, String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            match find_pandoc_exe(&path) {
                Ok(p) => return Ok(p),
                Err(_) => continue,
            }
        } else if path.file_name().and_then(|n| n.to_str()) == Some("pandoc.exe") {
            return Ok(path);
        }
    }
    Err("下载的压缩包中未找到 pandoc.exe".to_string())
}

// ---------------------------------------------------------------------------
// Config commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config() -> Result<AppConfig, String> {
    let t0 = std::time::Instant::now();
    let mut cfg = load_config()?;
    // 兼容历史配置：data_dir 可能存的是 Windows 反斜杠路径，统一为 "/" 分隔
    cfg.data_dir = cfg.data_dir.replace('\\', "/");
    // 不在启动时访问钥匙串以避免 macOS 弹出授权对话框。
    // Token 在 git_sync/test_remote/clone_remote 等实际操作时才从钥匙串惰性加载。
    eprintln!("⏱ [Rust] get_config: {:.1}ms", t0.elapsed().as_secs_f64() * 1000.0);
    Ok(cfg)
}

/// 保存同步配置。token 语义：非空 → 更新凭据；空 → 保留现有凭据不动
/// （前端当前传 `config?.token ?? ""`，默认语义必须是"空=不动"，
/// 否则只改 remote URL 点保存就会把 keyring 里的 token 静默删掉）；
/// 只有 clear_token 显式为 true 时才删除凭据。
#[tauri::command]
fn save_sync_config(
    url: String,
    auth_type: String,
    username: String,
    token: String,
    clear_token: Option<bool>,
) -> Result<(), String> {
    let mut cfg = load_config()?;
    cfg.remote_url = url;
    cfg.auth_type = auth_type;
    cfg.username = username;
    if clear_token == Some(true) {
        let _ = keyring_delete_token();
        cfg.token = String::new();
    } else if !token.is_empty() {
        if keyring_store_token(&token).is_ok() {
            cfg.token = String::new(); // 已入 keyring，不再落盘明文
        } else {
            cfg.token = token; // keyring 不可用，回退 0600 配置文件
        }
    }
    save_config(&cfg)
}

/// 校验并切换数据目录：不存在则创建，不可写则报错。旧目录不做任何改动。
#[tauri::command]
fn set_data_dir(path: String) -> Result<DirStatus, String> {
    let p = Path::new(&path);
    if !p.exists() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let probe = p.join(".notes-write-test");
    fs::write(&probe, b"").map_err(|_| "目录不可写".to_string())?;
    let _ = fs::remove_file(&probe);
    let mut cfg = load_config()?;
    // 持久化统一为 "/" 分隔，保证重启后前端读到的 notesDir 也是同一格式
    cfg.data_dir = path.replace('\\', "/");
    save_config(&cfg)?;
    dir_status(path)
}

#[tauri::command]
fn set_reuse_tab(value: bool) -> Result<(), String> {
    let mut cfg = load_config()?;
    cfg.reuse_tab = value;
    save_config(&cfg)
}

// ---------------------------------------------------------------------------
// Local git commands
// ---------------------------------------------------------------------------

/// commit/sync 前自愈：超时 kill 发生在 commit 中途会留下 .git/index.lock，
/// 之后所有 commit 永远失败。锁文件存在且 mtime 超过 60 秒视为孤儿锁，删除。
fn clear_stale_index_lock(dir: &Path) {
    let Ok(git_dir) = run_git(Some(dir), &["rev-parse", "--git-dir"], &[]) else {
        return;
    };
    let git_dir = PathBuf::from(git_dir.trim());
    let git_dir = if git_dir.is_absolute() {
        git_dir
    } else {
        dir.join(git_dir)
    };
    let lock = git_dir.join("index.lock");
    let Ok(meta) = fs::metadata(&lock) else {
        return;
    };
    let stale = meta
        .modified()
        .ok()
        .and_then(|m| m.elapsed().ok())
        .map(|e| e > Duration::from_secs(60))
        .unwrap_or(false);
    if stale {
        let _ = fs::remove_file(&lock);
    }
}

/// add -A + 有改动才 commit。返回是否有新提交。
fn commit_all(dir: &Path, message: &str) -> Result<bool, GitErrorPayload> {
    clear_stale_index_lock(dir);
    run_git(Some(dir), &["add", "-A"], &[])?;
    // diff --cached --quiet：有暂存改动时退出码为 1
    let has_staged = run_git(Some(dir), &["diff", "--cached", "--quiet"], &[]).is_err();
    if !has_staged {
        return Ok(false);
    }
    let ident = ident_configs(dir);
    run_git(Some(dir), &["commit", "-m", message], &ident)?;
    Ok(true)
}

/// 检测系统是否安装了 git（运行 `git --version` 判断）。
/// 在引导流程和启动时调用，用于决定是否展示安装指引。
#[tauri::command]
fn check_git_available() -> bool {
    let t0 = std::time::Instant::now();
    let result = run_version_probe("git");
    eprintln!("⏱ [Rust] check_git_available: {:.1}ms", t0.elapsed().as_secs_f64() * 1000.0);
    result
}

#[tauri::command]
fn git_status(path: String) -> Result<GitStatus, String> {
    let p = Path::new(&path);
    match run_git(Some(p), &["rev-parse", "--is-inside-work-tree"], &[]) {
        Ok(_) => {
            // 错误向上传递（如管道假超时、index.lock），不吞掉伪装成"0 未提交"
            let out = run_git(Some(p), &["status", "--porcelain"], &[])
                .map_err(|e| e.message)?;
            Ok(GitStatus {
                is_repo: true,
                uncommitted: out.lines().count() as u32,
            })
        }
        Err(_) => Ok(GitStatus {
            is_repo: false,
            uncommitted: 0,
        }),
    }
}

#[tauri::command]
fn git_commit_all(path: String, message: String) -> Result<bool, String> {
    let p = Path::new(&path);
    run_git(Some(p), &["rev-parse", "--is-inside-work-tree"], &[])
        .map_err(|_| "目标不是一个 git 仓库".to_string())?;
    commit_all(p, &message).map_err(|e| e.message)
}

/// One-step workspace bootstrap used by the onboarding wizard.
#[tauri::command]
async fn init_workspace(path: String, mode: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || init_workspace_blocking(path, mode))
        .await
        .map_err(|e| e.to_string())?
}

fn init_workspace_blocking(path: String, mode: String) -> Result<(), String> {
    let p = Path::new(&path);
    fs::create_dir_all(p).map_err(|e| e.to_string())?;

    let has_md = fs::read_dir(p)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .any(|f| f.extension().and_then(|e| e.to_str()) == Some("md"));
    if !has_md {
        fs::write(p.join("欢迎使用.md"), WELCOME_NOTE).map_err(|e| e.to_string())?;
    }

    if run_git(Some(p), &["rev-parse", "--is-inside-work-tree"], &[]).is_err() {
        run_git(Some(p), &["init", "-b", "main"], &[]).map_err(|e| e.message)?;
    }
    commit_all(p, "Initial commit").map_err(|e| e.message)?;
    let _ = mode; // 远程模式由 clone_remote/set_remote/git_sync 组合完成
    Ok(())
}

// ---------------------------------------------------------------------------
// Remote git commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn set_remote(path: String, url: String) -> Result<(), String> {
    validate_remote_url(&url)?;
    let p = Path::new(&path);
    let exists = run_git(Some(p), &["remote", "get-url", "origin"], &[]).is_ok();
    let result = if exists {
        run_git(Some(p), &["remote", "set-url", "origin", &url], &[])
    } else {
        run_git(Some(p), &["remote", "add", "origin", &url], &[])
    };
    result.map(|_| ()).map_err(|e| e.message)
}

/// ls-remote 探测：成功且无输出 → 空仓库。
#[tauri::command]
async fn test_remote(url: String, auth: Option<AuthPayload>) -> TestRemoteResult {
    tauri::async_runtime::spawn_blocking(move || test_remote_blocking(url, auth))
        .await
        .unwrap_or_else(|e| TestRemoteResult {
            ok: false,
            empty: false,
            error: Some(GitErrorPayload::new("other", &e.to_string())),
        })
}

fn test_remote_blocking(url: String, auth: Option<AuthPayload>) -> TestRemoteResult {
    let auth = resolve_auth_token(auth.unwrap_or_default());
    if let Err(e) = check_auth_url_match(&url, &auth) {
        return TestRemoteResult {
            ok: false,
            empty: false,
            error: Some(e),
        };
    }
    let envs = auth_envs(&auth, &url);
    match run_git_full(None, &["ls-remote", &url], &[], &envs) {
        Ok(out) => TestRemoteResult {
            ok: true,
            empty: out.lines().count() == 0,
            error: None,
        },
        Err(e) => TestRemoteResult {
            ok: false,
            empty: false,
            error: Some(e),
        },
    }
}

/// 远端有内容 → clone；远端为空 → clone 出的空仓库（git 会警告但成功），
/// 等价于 init + remote add，由调用方继续首次提交与推送。
#[tauri::command]
async fn clone_remote(url: String, dest: String, auth: Option<AuthPayload>) -> CloneResult {
    tauri::async_runtime::spawn_blocking(move || clone_remote_blocking(url, dest, auth))
        .await
        .unwrap_or_else(|e| CloneResult {
            cloned: false,
            empty: false,
            error: Some(GitErrorPayload::new("other", &e.to_string())),
        })
}

fn clone_remote_blocking(url: String, dest: String, auth: Option<AuthPayload>) -> CloneResult {
    let auth = resolve_auth_token(auth.unwrap_or_default());
    if let Err(e) = check_auth_url_match(&url, &auth) {
        return CloneResult {
            cloned: false,
            empty: false,
            error: Some(e),
        };
    }
    let envs = auth_envs(&auth, &url);
    let p = Path::new(&dest);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match run_git_full(None, &["clone", &url, &dest], &[], &envs) {
        Ok(_) => {
            let empty = run_git(Some(p), &["rev-parse", "--verify", "HEAD"], &[]).is_err();
            CloneResult {
                cloned: !empty,
                empty,
                error: None,
            }
        }
        Err(e) => CloneResult {
            cloned: false,
            empty: false,
            error: Some(e),
        },
    }
}

/// 冲突相关 git 调用统一加 core.quotePath=false，否则非 ASCII 路径
/// （如中文文件名）会被转义成 "\345\274\240…" 导致后续 git show 找不到路径。
fn quotepath_cfg() -> Vec<String> {
    vec!["core.quotePath=false".to_string()]
}

/// 把远端版本的冲突文件另存为 `原名 (conflict YYYY-MM-DD HH-mm).md`。
fn write_conflict_copies(workdir: &Path, upstream: &str, paths: &[String]) {
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M").to_string();
    for rel in paths {
        let Ok(content) = run_git(
            Some(workdir),
            &["show", &format!("{}:{}", upstream, rel)],
            &quotepath_cfg(),
        ) else {
            continue;
        };
        let src = Path::new(rel);
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("note");
        let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("md");
        let dir = workdir.join(src.parent().unwrap_or(Path::new("")));
        let copy = unique_path(
            &dir,
            &format!("{} (conflict {})", stem, stamp),
            &format!(".{}", ext),
        );
        let _ = fs::write(copy, content);
    }
}

fn git_sync_inner(path: &str, auth: AuthPayload) -> Result<SyncResult, GitErrorPayload> {
    let p = Path::new(path);
    if run_git(Some(p), &["rev-parse", "--is-inside-work-tree"], &[]).is_err() {
        return Err(GitErrorPayload::friendly("not_a_repo"));
    }
    // 上次同步被超时 kill 可能留下 index.lock，先自愈
    clear_stale_index_lock(p);
    // 1. 提交未提交改动
    commit_all(p, "chore: auto-save notes")?;

    // 2. remote / branch
    let remote_url = match run_git(Some(p), &["remote", "get-url", "origin"], &[]) {
        Ok(u) => u.trim().to_string(),
        Err(_) => return Err(GitErrorPayload::friendly("no_remote")),
    };
    check_auth_url_match(&remote_url, &auth)?;
    let envs = auth_envs(&auth, &remote_url);
    let branch = run_git(Some(p), &["branch", "--show-current"], &[])
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty());
    let branch = match branch {
        Some(b) => b,
        // detached HEAD 时兜底 main 会静默推错分支，必须明确报错
        None => {
            return Err(GitErrorPayload::new(
                "other",
                "处于 detached HEAD 状态，请切回分支后再同步",
            ));
        }
    };
    let upstream = format!("origin/{}", branch);

    // 3. fetch（失败且本地无任何 origin 引用 → 视为空远端，直接推送；
    //    若远端其实不可达，push 会给出正确分类的错误）
    let fetch_result = run_git_full(Some(p), &["fetch", "origin"], &[], &envs);
    let has_upstream = run_git(Some(p), &["rev-parse", "--verify", &upstream], &[]).is_ok();
    if let Err(e) = fetch_result {
        if has_upstream {
            return Err(e);
        }
    }

    // 4. ahead/behind
    let (ahead, behind) = if has_upstream {
        let out = run_git(
            Some(p),
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("HEAD...{}", upstream),
            ],
            &[],
        )?;
        let mut it = out.split_whitespace();
        let a = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        let b = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        (a, b)
    } else {
        (0, 0)
    };

    let mut pulled_changes = false;
    let mut conflicts: Vec<String> = Vec::new();

    // 5. pull：纯快进 → ff-only；分叉 → rebase，冲突则 abort + 冲突副本
    //    + merge -X ours
    if behind > 0 {
        pulled_changes = true;
        if ahead == 0 {
            run_git(Some(p), &["merge", "--ff-only", &upstream], &[])?;
        } else if run_git(Some(p), &["rebase", &upstream], &[]).is_err() {
            conflicts = run_git(
                Some(p),
                &["diff", "--name-only", "--diff-filter=U"],
                &quotepath_cfg(),
            )
            .map(|o| o.lines().map(|s| s.to_string()).collect())
            .unwrap_or_default();
            let _ = run_git(Some(p), &["rebase", "--abort"], &[]);
            // 远端版本另存 conflict 副本（本地版本保留原名）
            write_conflict_copies(p, &upstream, &conflicts);
            if let Err(e) = run_git(
                Some(p),
                &["merge", "-X", "ours", "--allow-unrelated-histories", &upstream],
                &[],
            ) {
                // 合并失败不能留在 MERGING 中间态
                let _ = run_git(Some(p), &["merge", "--abort"], &[]);
                return Ok(SyncResult {
                    synced: false,
                    pulled_changes: true,
                    conflicts,
                    pending: 0,
                    error: Some(e),
                });
            }
            // 冲突副本单独提交
            commit_all(p, "chore: save conflict copies")?;
        }
    }

    // 6. push
    run_git_full(Some(p), &["push", "-u", "origin", &branch], &[], &envs)?;

    // 7. pending：未推送提交数 + 工作区改动数；无上游时按全部本地提交算
    let has_upstream = run_git(Some(p), &["rev-parse", "--verify", &upstream], &[]).is_ok();
    let unpushed = if has_upstream {
        run_git(Some(p), &["rev-list", "--count", &format!("{}..HEAD", upstream)], &[])
    } else {
        run_git(Some(p), &["rev-list", "--count", "HEAD"], &[])
    }
    .ok()
    .and_then(|s| s.trim().parse::<u32>().ok())
    .unwrap_or(0);
    let dirty = run_git(Some(p), &["status", "--porcelain"], &[])
        .map(|o| o.lines().count() as u32)
        .unwrap_or(0);

    Ok(SyncResult {
        synced: true,
        pulled_changes,
        conflicts,
        pending: unpushed + dirty,
        error: None,
    })
}

/// 一步同步：commit → pull --rebase → push。
#[tauri::command]
async fn git_sync(path: String, auth: Option<AuthPayload>) -> SyncResult {
    tauri::async_runtime::spawn_blocking(move || git_sync_blocking(path, auth))
        .await
        .unwrap_or_else(|e| SyncResult {
            synced: false,
            pulled_changes: false,
            conflicts: vec![],
            pending: 0,
            error: Some(GitErrorPayload::new("other", &e.to_string())),
        })
}

fn git_sync_blocking(path: String, auth: Option<AuthPayload>) -> SyncResult {
    // 重入互斥：定时器/窗口聚焦/手动同步可能并发触发，并发同步会互踩
    // index.lock 与 rebase 中间态，已在同步中直接返回提示
    if SYNC_IN_PROGRESS
        .compare_exchange(false, true, AtomicOrdering::SeqCst, AtomicOrdering::SeqCst)
        .is_err()
    {
        return SyncResult {
            synced: false,
            pulled_changes: false,
            conflicts: vec![],
            pending: 0,
            error: Some(GitErrorPayload::new("other", "同步进行中，请稍候")),
        };
    }
    // panic 也必须释放标志位
    struct SyncGuard;
    impl Drop for SyncGuard {
        fn drop(&mut self) {
            SYNC_IN_PROGRESS.store(false, AtomicOrdering::SeqCst);
        }
    }
    let _guard = SyncGuard;
    let auth = match auth {
        Some(a) => resolve_auth_token(a),
        None => {
            let cfg = load_config().unwrap_or_default();
            resolve_auth_token(AuthPayload {
                auth_type: cfg.auth_type,
                username: cfg.username,
                token: String::new(),
            })
        }
    };
    match git_sync_inner(&path, auth) {
        Ok(r) => r,
        Err(e) => SyncResult {
            synced: false,
            pulled_changes: false,
            conflicts: vec![],
            pending: 0,
            error: Some(e),
        },
    }
}

// ---------------------------------------------------------------------------
// Linux DPI 检测（通过 xrandr 获取显示器物理尺寸，仅 Linux/X11 用）
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
struct MonitorInfo {
    #[allow(dead_code)]
    name: String,
    res_w: f64,
    res_h: f64,
    mm_w: f64,
    mm_h: f64,
    is_primary: bool,
}

/// 解析 xrandr --query 输出，提取每个已连接显示器的分辨率、物理尺寸。
/// 示例行：HDMI-2 connected primary 2560x1440+0+0 (normal ...) 597mm x 336mm
#[cfg(target_os = "linux")]
fn parse_xrandr_monitors() -> Vec<MonitorInfo> {
    let output = match Command::new("xrandr").arg("--query").output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return vec![],
    };

    let mut monitors: Vec<MonitorInfo> = Vec::new();

    for line in output.lines() {
        if !line.contains(" connected") {
            continue;
        }

        let is_primary = line.contains("primary");
        let name = line.split_whitespace().next().unwrap_or("").to_string();

        // 从行中提取分辨率（如 2560x1440）
        let (mut res_w, mut res_h) = (0.0f64, 0.0f64);
        let (mut mm_w, mut mm_h) = (0.0f64, 0.0f64);

        for token in line.split_whitespace() {
            // 分辨率：首字符为数字且含 'x'，如 "2560x1440+0+0"
            if let Some(first_char) = token.chars().next() {
                if first_char.is_ascii_digit() && token.contains('x') {
                    if let Some(x_pos) = token.find('x') {
                        let w_str = &token[..x_pos];
                        let h_str: String = token[x_pos + 1..]
                            .chars()
                            .take_while(|c| c.is_ascii_digit())
                            .collect();
                        res_w = w_str.parse().unwrap_or(0.0);
                        res_h = h_str.parse().unwrap_or(0.0);
                    }
                }
            }
            // 物理尺寸：如 "597mm"
            if token.ends_with("mm") {
                let val: f64 = token.trim_end_matches("mm").parse().unwrap_or(0.0);
                if mm_w == 0.0 {
                    mm_w = val;
                } else {
                    mm_h = val;
                }
            }
        }

        if res_w > 0.0 && res_h > 0.0 && mm_w > 0.0 && mm_h > 0.0 {
            monitors.push(MonitorInfo {
                name,
                res_w,
                res_h,
                mm_w,
                mm_h,
                is_primary,
            });
        }
    }

    monitors
}

/// 计算显示器的物理 DPI
#[cfg(target_os = "linux")]
fn monitor_dpi(m: &MonitorInfo) -> f64 {
    let dpi_x = m.res_w / (m.mm_w / 25.4);
    let dpi_y = m.res_h / (m.mm_h / 25.4);
    (dpi_x + dpi_y) / 2.0
}

/// 获取主显示器相对于 96 DPI（X11 默认）的缩放因子。
/// 仅在 X11 下有意义——Wayland/macOS/Windows 由系统合成器处理 DPI 缩放。
/// 返回值在 1.0 附近（±5%）时返回 1.0，避免微调引起的不必要缩放。
#[cfg(target_os = "linux")]
fn get_x11_scale_factor() -> f64 {
    let session_type = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    if session_type != "x11" {
        return 1.0;
    }
    let monitors = parse_xrandr_monitors();
    if monitors.is_empty() {
        return 1.0;
    }
    let primary = monitors
        .iter()
        .find(|m| m.is_primary)
        .unwrap_or(&monitors[0]);
    let dpi = monitor_dpi(primary);
    if dpi <= 0.0 {
        return 1.0;
    }
    let scale = dpi / 96.0;
    // 仅当缩放偏差超过 5% 时才返回非 1.0 值
    if (scale - 1.0).abs() < 0.05 {
        1.0
    } else {
        (scale * 100.0).round() / 100.0 // 保留两位小数
    }
}

/// 供前端查询的 DPI 缩放因子
#[tauri::command]
fn get_display_scale() -> f64 {
    #[cfg(target_os = "linux")]
    {
        get_x11_scale_factor()
    }
    #[cfg(not(target_os = "linux"))]
    {
        1.0
    }
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

/// 前端启动性能计时：将 console 日志转发到终端，方便开发阶段诊断。
#[tauri::command]
fn startup_log(msg: String) {
    eprintln!("⏱ [WebView] {}", msg);
}

/// 获取打包资源文件在磁盘上的绝对路径。
/// `name` 参数为 resources 目录下的文件名（例如 "隐私政策.md"）。
/// 开发模式下文件位于 `src-tauri/resources/`，打包后直接放在 Resource 根目录。
#[tauri::command]
fn get_resource_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
    // 打包后：资源文件直接放在 Resource 根目录
    // dev 模式：resource_dir() 返回 target/debug/，资源还在 src-tauri/resources/
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(&name);
        if bundled.exists() {
            return Ok(disp(&bundled));
        }
        let dev = resource_dir.join("resources").join(&name);
        if dev.exists() {
            return Ok(disp(&dev));
        }
    }

    // dev 兜底：直接以 CARGO_MANIFEST_DIR（src-tauri/）为基准查找
    let manifest_dir: std::path::PathBuf = env!("CARGO_MANIFEST_DIR").into();
    let resources_dir = manifest_dir.join("resources").join(&name);
    if resources_dir.exists() {
        return Ok(disp(&resources_dir));
    }

    Err(format!("资源文件不存在: {}", name))
}

#[tauri::command]
fn read_resource(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let path = get_resource_path(app, name)?;
    fs::read_to_string(&path).map_err(|e| format!("读取资源失败: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 注意：不再无条件关闭 WebKit GPU 合成。
    // 早期版本为缓解 X11 双屏混 DPI 文字间歇模糊而设置
    // WEBKIT_DISABLE_COMPOSITING_MODE=1 / WEBKIT_DISABLE_DMABUF_RENDERER=1，
    // 但副作用是**所有** Linux 用户（包括单屏）字体渲染质量下降。
    // 若特定环境下仍需这些环境变量，用户可自行设置。
    // 512x512 用于系统托盘（需要较大源图以保证在各种 DPI 下缩放清晰）
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
        .expect("Failed to load tray icon");
    // 128x128 用于窗口图标（Linux dock/任务栏 `_NET_WM_ICON` 大数据可能被忽略）
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let window_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))
        .expect("Failed to load window icon");

    let _app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 第二个实例启动 → 激活第一个实例的窗口（否则用户看不到任何反应）
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            // 从 args 中提取 .md 文件路径，转发给前端打开
            for arg in args {
                let path_str = if let Some(stripped) = arg.strip_prefix("file://") {
                    stripped.to_string()
                } else {
                    arg
                };
                if is_markdown_path(&path_str) && Path::new(&path_str).exists() {
                    let _ = app.emit("open-external-file", path_str);
                    break;
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            // 显式设置窗口图标（Linux 任务栏/启动器显示用）
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(window_icon.clone());
            }

            // 系统托盘图标
            let show_hide = MenuItemBuilder::with_id("tray_show", "显示/隐藏窗口").build(app)?;
            let quit_tray = MenuItemBuilder::with_id("tray_quit", "退出").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_hide)
                .item(&quit_tray)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon.clone())
                .tooltip("即记 (Jot)")
                .menu(&tray_menu)
                .on_menu_event(|app_handle, event| match event.id().as_ref() {
                    "tray_show" => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    "tray_quit" => {
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // 从命令行参数中检测外部打开的 .md 文件
            // Linux DE 右键"打开方式"可能传 file:// URL（%U）或纯路径（%f），二者都支持
            // 用 args_os 容错：非 UTF-8 路径不 panic（args() 遇非法 UTF-8 直接崩溃）
            for arg in std::env::args_os().skip(1) {
                let arg = arg.to_string_lossy().into_owned();
                let path_str = if let Some(stripped) = arg.strip_prefix("file://") {
                    stripped.to_string()
                } else {
                    arg
                };
                if is_markdown_path(&path_str) && Path::new(&path_str).exists() {
                    if let Ok(mut f) = OPENED_FILE.lock() {
                        *f = Some(path_str);
                    }
                    break;
                }
            }
            // macOS：使用系统原生菜单栏 + 恢复原生窗口装饰；
            // Linux/Windows：前端自定义菜单 + 自定义标题栏（装饰已在配置文件关闭）
            #[cfg(target_os = "macos")]
            {
                // 配置文件中 decorations:false 关闭了所有平台的原生装饰，
                // macOS 需要恢复原生窗口控件（红绿灯按钮）
                if let Some(win) = app.get_webview_window("main") {
                    win.set_decorations(true)?;
                }
                let handle = app.handle().clone();
                let menu = menu::build_menu(&handle).expect("failed to build menu");
                app.set_menu(menu).expect("failed to set menu");
            }
            Ok(())
        })
        .on_menu_event(|app_handle, event| {
            menu::handle_menu_event(app_handle, event);
        })
        .invoke_handler(tauri::generate_handler![
            startup_log,
            get_resource_path,
            read_resource,
            get_display_scale,
            get_opened_file,
            default_notes_dir,
            dir_status,
            list_tree,
            read_file,
            file_mtime,
            search_content,
            list_templates,
            create_from_template,
            get_backlinks,
            list_tags,
            write_file,
            create_note,
            create_dir,
            rename_path,
            delete_path,
            move_path,
            import_files,
            save_asset,
            reveal_in_folder,
            open_in_system,
            open_url,
            get_config,
            save_sync_config,
            set_data_dir,
            set_reuse_tab,
            check_git_available,
            git_status,
            git_commit_all,
            init_workspace,
            set_remote,
            test_remote,
            clone_remote,
            git_sync,
            // export commands
            export_file,
            check_pandoc_available,
            pandoc_export,
            #[cfg(target_os = "windows")]
            download_pandoc_windows,
            #[cfg(target_os = "macos")]
            export_pdf_macos::export_pdf_native,
            #[cfg(target_os = "macos")]
            export_pdf_macos::print_native,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- classify (error classification from git stderr) ----

    #[test]
    fn classify_auth_permission_denied() {
        let e = classify("fatal: Authentication failed for 'https://...'");
        assert_eq!(e.kind, "auth");
    }

    #[test]
    fn classify_auth_access_denied() {
        let e = classify("remote: Access denied");
        assert_eq!(e.kind, "auth");
    }

    #[test]
    fn classify_auth_http_401() {
        let e = classify("fatal: unable to access '...': The requested URL returned error: 401");
        assert_eq!(e.kind, "auth");
    }

    #[test]
    fn classify_auth_http_403() {
        let e = classify("The requested URL returned error: 403");
        assert_eq!(e.kind, "auth");
    }

    #[test]
    fn classify_not_a_repo() {
        let e = classify("fatal: not a git repository (or any of the parent directories): .git");
        assert_eq!(e.kind, "not_a_repo");
    }

    #[test]
    fn classify_not_found() {
        let e = classify("fatal: repository 'https://...' not found");
        assert_eq!(e.kind, "not_found");
    }

    #[test]
    fn classify_network_unreachable() {
        let e = classify("fatal: unable to access 'https://...': Could not resolve host");
        assert_eq!(e.kind, "network");
    }

    #[test]
    fn classify_network_connection_refused() {
        let e = classify("fatal: unable to connect: Connection refused");
        assert_eq!(e.kind, "network");
    }

    #[test]
    fn classify_network_timeout() {
        let e = classify("fatal: unable to access '...': Failed to connect: Connection timed out");
        assert_eq!(e.kind, "network");
    }

    #[test]
    fn classify_network_ssl_error() {
        let e = classify("fatal: unable to access '...': SSL certificate problem");
        assert_eq!(e.kind, "network");
    }

    #[test]
    fn classify_other_unknown() {
        let e = classify("something weird happened");
        assert_eq!(e.kind, "other");
    }

    #[test]
    fn classify_other_includes_first_line() {
        let e = classify("unexpected error: disk full");
        assert_eq!(e.kind, "other");
        assert!(e.message.contains("disk full"));
    }

    // ---- GitErrorPayload::friendly ----

    #[test]
    fn friendly_network_message() {
        let e = GitErrorPayload::friendly("network");
        assert!(e.message.contains("网络"));
    }

    #[test]
    fn friendly_auth_message() {
        let e = GitErrorPayload::friendly("auth");
        assert!(e.message.contains("认证"));
    }

    #[test]
    fn friendly_not_found_message() {
        let e = GitErrorPayload::friendly("not_found");
        assert!(e.message.contains("仓库"));
    }

    #[test]
    fn friendly_not_a_repo_message() {
        let e = GitErrorPayload::friendly("not_a_repo");
        assert!(e.message.contains("git 仓库"));
    }

    #[test]
    fn friendly_timeout_message() {
        let e = GitErrorPayload::friendly("timeout");
        assert!(e.message.contains("30 秒"));
    }

    #[test]
    fn friendly_no_remote_message() {
        let e = GitErrorPayload::friendly("no_remote");
        assert!(e.message.contains("远程仓库"));
    }

    #[test]
    fn friendly_unknown_message() {
        let e = GitErrorPayload::friendly("something_else");
        assert_eq!(e.message, "操作失败");
    }

    // ---- sanitize_name ----

    #[test]
    fn sanitize_valid_name() {
        assert_eq!(sanitize_name("hello"), Ok("hello"));
        assert_eq!(sanitize_name("笔记 2024"), Ok("笔记 2024"));
    }

    #[test]
    fn sanitize_trims_whitespace() {
        assert_eq!(sanitize_name("  hello  "), Ok("hello"));
    }

    #[test]
    fn sanitize_rejects_empty() {
        assert!(sanitize_name("").is_err());
        assert!(sanitize_name("   ").is_err());
    }

    #[test]
    fn sanitize_rejects_dot() {
        assert!(sanitize_name(".").is_err());
        assert!(sanitize_name("..").is_err());
    }

    #[test]
    fn sanitize_rejects_path_separator() {
        assert!(sanitize_name("a/b").is_err());
        assert!(sanitize_name("a\\b").is_err());
    }

    // ---- auth_envs ----

    #[test]
    fn auth_envs_token_generates_basic_header() {
        let auth = AuthPayload {
            auth_type: "token".to_string(),
            username: "git".to_string(),
            token: "test-token-123".to_string(),
        };
        let envs = auth_envs(&auth, "https://github.com/user/repo.git");
        assert_eq!(envs.len(), 3);
        assert_eq!(envs[0], ("GIT_CONFIG_COUNT".to_string(), "1".to_string()));
        assert_eq!(
            envs[1].0, "GIT_CONFIG_KEY_0",
        );
        // 键名按 host 限域，跨主机重定向不会带出凭据
        assert_eq!(envs[1].1, "http.https://github.com.extraHeader");
        assert_eq!(envs[2].0, "GIT_CONFIG_VALUE_0");
        assert!(envs[2].1.starts_with("Authorization: Basic "));
        let encoded = BASE64.encode("git:test-token-123");
        assert!(envs[2].1.contains(&encoded));
    }

    #[test]
    fn auth_envs_defaults_username_to_git() {
        let auth = AuthPayload {
            auth_type: "token".to_string(),
            username: "".to_string(),
            token: "ghp_abc".to_string(),
        };
        let envs = auth_envs(&auth, "https://example.com/r.git");
        let encoded = BASE64.encode("git:ghp_abc");
        assert!(envs[2].1.contains(&encoded));
    }

    #[test]
    fn auth_envs_strips_port_and_userinfo_from_scope() {
        let auth = AuthPayload {
            auth_type: "token".to_string(),
            username: "git".to_string(),
            token: "t".to_string(),
        };
        let envs = auth_envs(&auth, "https://user:pass@example.com:8443/a/b.git");
        assert_eq!(envs[1].1, "http.https://example.com:8443.extraHeader");
    }

    #[test]
    fn auth_envs_empty_token_no_header() {
        let auth = AuthPayload {
            auth_type: "token".to_string(),
            username: "git".to_string(),
            token: "".to_string(),
        };
        let envs = auth_envs(&auth, "https://github.com/u/r.git");
        assert!(envs.is_empty());
    }

    #[test]
    fn auth_envs_ssh_no_header() {
        let auth = AuthPayload {
            auth_type: "ssh".to_string(),
            username: "git".to_string(),
            token: "some-key".to_string(),
        };
        let envs = auth_envs(&auth, "git@github.com:u/r.git");
        assert!(envs.is_empty());
    }

    #[test]
    fn auth_envs_empty_type_no_header() {
        let auth = AuthPayload::default();
        let envs = auth_envs(&auth, "https://github.com/u/r.git");
        assert!(envs.is_empty());
    }

    // ---- check_auth_url_match ----

    #[test]
    fn check_rejects_http() {
        let auth = AuthPayload {
            auth_type: "token".to_string(),
            username: "git".to_string(),
            token: "x".to_string(),
        };
        let r = check_auth_url_match("http://github.com/user/repo.git", &auth);
        assert!(r.is_err());
        assert!(r.unwrap_err().message.contains("HTTP"));
    }

    #[test]
    fn check_allows_ssh_remote() {
        // SSH 形式地址（git@ / ssh://）交给系统 ssh，跳过 URL/token 校验
        let auth = AuthPayload {
            auth_type: "token".to_string(),
            username: "git".to_string(),
            token: "x".to_string(),
        };
        assert!(check_auth_url_match("git@github.com:user/repo.git", &auth).is_ok());
        assert!(check_auth_url_match("ssh://git@github.com/user/repo.git", &auth).is_ok());
    }

    #[test]
    fn check_allows_ssh_auth_type() {
        let auth = AuthPayload {
            auth_type: "ssh".to_string(),
            username: "git".to_string(),
            token: "".to_string(),
        };
        assert!(check_auth_url_match("git@github.com:user/repo.git", &auth).is_ok());
    }

    #[test]
    fn check_rejects_other_non_https_scheme() {
        let auth = AuthPayload {
            auth_type: "token".to_string(),
            username: "git".to_string(),
            token: "x".to_string(),
        };
        let r = check_auth_url_match("ftp://example.com/repo.git", &auth);
        assert!(r.is_err());
        assert!(r.unwrap_err().message.contains("HTTPS"));
    }

    #[test]
    fn check_rejects_empty_token() {
        let r = check_auth_url_match("https://github.com/user/repo.git", &AuthPayload::default());
        assert!(r.is_err());
        assert!(r.unwrap_err().message.contains("Token"));
    }

    #[test]
    fn check_allows_https_with_token() {
        let auth = AuthPayload {
            auth_type: "token".to_string(),
            username: "git".to_string(),
            token: "x".to_string(),
        };
        assert!(check_auth_url_match("https://github.com/user/repo.git", &auth).is_ok());
    }

    // ---- extract_frontmatter_tags ----

    #[test]
    fn frontmatter_no_tags() {
        let content = "---\ntitle: hello\n---\n# Content";
        assert_eq!(extract_frontmatter_tags(content), None);
    }

    #[test]
    fn frontmatter_tags_bracket_list() {
        let content = "---\ntags: [\"rust\", \"testing\"]\n---\n# Content";
        let tags = extract_frontmatter_tags(content).unwrap();
        assert_eq!(tags, vec!["rust", "testing"]);
    }

    #[test]
    fn frontmatter_tags_single_value() {
        let content = "---\ntags: rust\n---\n# Content";
        let tags = extract_frontmatter_tags(content).unwrap();
        assert_eq!(tags, vec!["rust"]);
    }

    #[test]
    fn frontmatter_tags_yaml_list() {
        let content = "---\ntags:\n- rust\n- testing\n- notes\n---\n# Content";
        let tags = extract_frontmatter_tags(content).unwrap();
        assert_eq!(tags, vec!["rust", "testing", "notes"]);
    }

    #[test]
    fn frontmatter_no_frontmatter() {
        assert_eq!(extract_frontmatter_tags("# Just a heading\n\nContent"), None);
    }

    #[test]
    fn frontmatter_unclosed_frontmatter() {
        let content = "---\ntags: [rust]\n# Content";
        assert_eq!(extract_frontmatter_tags(content), None);
    }

    // ---- is_hidden ----

    #[test]
    fn hidden_dotfile() {
        assert!(is_hidden(Path::new("/some/.git")));
        assert!(is_hidden(Path::new(".hidden")));
    }

    #[test]
    fn not_hidden_normal() {
        assert!(!is_hidden(Path::new("/some/note.md")));
        assert!(!is_hidden(Path::new("README.md")));
    }

    // ---- dedup_file_name ----

    #[test]
    fn dedup_first_candidate_free() {
        let dir = std::env::temp_dir();
        let result = dedup_file_name(&dir, "unique-test-xyz.md");
        // No file with this name should exist
        assert!(!result.exists());
        assert_eq!(result.file_name().unwrap(), "unique-test-xyz.md");
    }

    // ---- Token encoding round-trip ----

    #[test]
    fn base64_token_encoding_is_standard() {
        let encoded = BASE64.encode("git:test-token-123");
        let decoded = String::from_utf8(BASE64.decode(&encoded).unwrap()).unwrap();
        assert_eq!(decoded, "git:test-token-123");
    }

    #[test]
    fn base64_token_special_chars() {
        let token = "ghp_abc123";
        let encoded = BASE64.encode(format!("git:{}", token));
        // Standard base64, no URL-safe variant
        assert!(!encoded.contains('_'));
        // Must decode back correctly
        let decoded = String::from_utf8(BASE64.decode(&encoded).unwrap()).unwrap();
        assert_eq!(decoded, format!("git:{}", token));
    }

    // ---- WELCOME_NOTE content ----

    #[test]
    fn welcome_note_is_valid() {
        assert!(WELCOME_NOTE.starts_with("# 欢迎使用"));
        assert!(WELCOME_NOTE.contains("## 快速上手"));
        assert!(WELCOME_NOTE.contains("git"));
    }

    // ---- create_from_template placeholder replacement ----

    #[test]
    fn template_rendering_formats_match() {
        let now = chrono::Local::now();
        let date = now.format("%Y-%m-%d").to_string();
        let time = now.format("%H:%M").to_string();
        let datetime = now.format("%Y-%m-%d %H:%M").to_string();

        assert!(date.contains('-'));
        assert!(time.contains(':'));
        assert!(datetime.contains(' '));

        let rendered = "Title: {{title}}, Date: {{date}}"
            .replace("{{title}}", "MyNote")
            .replace("{{date}}", &date);
        assert!(rendered.starts_with("Title: MyNote, Date: "));
        assert!(!rendered.contains("{{"));
    }

    // ---- sort_entries ----

    use std::fs;

    #[test]
    fn sort_entries_dirs_before_files() {
        let tmp = std::env::temp_dir().join("jot-test-sort");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("b.md"), "").unwrap();
        fs::create_dir_all(tmp.join("a-dir")).unwrap();
        fs::write(tmp.join("c.md"), "").unwrap();
        fs::create_dir_all(tmp.join("z-dir")).unwrap();

        let entries: Vec<PathBuf> = fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        let sorted = sort_entries(entries);
        let names: Vec<&str> = sorted
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap())
            .collect();

        // 目录在前，文件在后
        assert!(names[0] == "a-dir" || names[0] == "z-dir");
        assert!(names[1] == "a-dir" || names[1] == "z-dir");
        assert!(names[2] == "b.md" || names[2] == "c.md");
        assert!(names[3] == "b.md" || names[3] == "c.md");

        // 分别有序（大小写不敏感）
        let dirs: Vec<_> = names.iter().filter(|n| !n.ends_with(".md")).collect();
        let files: Vec<_> = names.iter().filter(|n| n.ends_with(".md")).collect();
        assert!(dirs[0].to_lowercase() <= dirs[1].to_lowercase());
        assert!(files[0].to_lowercase() <= files[1].to_lowercase());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sort_entries_assets_dir_last_among_dirs() {
        let tmp = std::env::temp_dir().join("jot-test-sort-asset");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::create_dir_all(tmp.join("blog")).unwrap();
        fs::create_dir_all(tmp.join(".assets")).unwrap();
        fs::create_dir_all(tmp.join("notes")).unwrap();

        let entries: Vec<PathBuf> = fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        let sorted = sort_entries(entries);
        let dirs: Vec<&str> = sorted
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap())
            .collect();

        // .assets 目录排在最后
        assert_eq!(dirs.last().unwrap(), &".assets");

        let _ = fs::remove_dir_all(&tmp);
    }

    // ---- unique_path ----

    #[test]
    fn unique_path_no_conflict() {
        let tmp = std::env::temp_dir();
        let result = unique_path(&tmp, "brand-new-note", ".md");
        assert!(!result.exists());
        assert_eq!(result.file_name().unwrap(), "brand-new-note.md");
    }

    #[test]
    fn unique_path_conflict_adds_suffix() {
        let tmp = std::env::temp_dir().join("jot-test-unique");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("note.md"), "").unwrap();
        fs::write(tmp.join("note-2.md"), "").unwrap();

        let result = unique_path(&tmp, "note", ".md");
        assert_eq!(result.file_name().unwrap(), "note-3.md");

        let _ = fs::remove_dir_all(&tmp);
    }

    // ---- quotepath_cfg ----

    #[test]
    fn quotepath_cfg_disables_quoting() {
        let cfgs = quotepath_cfg();
        assert_eq!(cfgs.len(), 1);
        assert_eq!(cfgs[0], "core.quotePath=false");
    }

    // ---- classify: index.lock 与 URL 脱敏 ----

    #[test]
    fn classify_index_lock() {
        let e = classify(
            "fatal: Unable to create '/repo/.git/index.lock': File exists.",
        );
        assert_eq!(e.kind, "index_lock");
        assert!(e.message.contains("index.lock"));
    }

    #[test]
    fn redact_userinfo_masks_credentials() {
        assert_eq!(
            redact_userinfo("fatal: 'https://user:pass@example.com/repo.git' failed"),
            "fatal: 'https://***@example.com/repo.git' failed"
        );
        // 无凭据的 URL 原样保留
        assert_eq!(
            redact_userinfo("https://example.com/repo.git"),
            "https://example.com/repo.git"
        );
        // 多个 URL 全部脱敏
        assert_eq!(
            redact_userinfo("https://a:b@h1/x and http://c:d@h2/y"),
            "https://***@h1/x and http://***@h2/y"
        );
    }

    #[test]
    fn classify_other_redacts_embedded_credentials() {
        let e = classify("something weird: https://user:secret-token@example.com/r.git");
        assert_eq!(e.kind, "other");
        assert!(!e.message.contains("secret-token"));
        assert!(e.message.contains("***@example.com"));
    }

    // ---- file_mtime ----

    #[test]
    fn file_mtime_existing_file() {
        let tmp = std::env::temp_dir().join("jot-test-mtime.md");
        fs::write(&tmp, "hello").unwrap();
        let m = file_mtime(tmp.to_string_lossy().to_string()).unwrap();
        assert!(m > 0);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn file_mtime_missing_returns_zero() {
        let m = file_mtime("/nonexistent/path/xyz.md".to_string()).unwrap();
        assert_eq!(m, 0);
    }

    // ---- save_asset 名称消毒 ----

    #[test]
    fn save_asset_rejects_traversal() {
        let r = save_asset_blocking(
            std::env::temp_dir().to_string_lossy().to_string(),
            "../evil.png".to_string(),
            b"x".to_vec(),
        );
        assert!(r.is_err());
        assert!(r.err().unwrap().contains("非法名称"));
    }

    #[test]
    fn save_asset_writes_into_assets_dir() {
        let tmp = std::env::temp_dir().join("jot-test-asset");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let r = save_asset_blocking(
            tmp.to_string_lossy().to_string(),
            "pic.png".to_string(),
            b"png".to_vec(),
        )
        .unwrap();
        assert!(r.path.contains(".assets"));
        assert!(Path::new(&r.path).exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    // ---- create_from_template 名称消毒 ----

    #[test]
    fn create_from_template_rejects_traversal() {
        let r = create_from_template(
            std::env::temp_dir().to_string_lossy().to_string(),
            "/nonexistent/template.md".to_string(),
            "../evil".to_string(),
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("非法名称"));
    }

    #[test]
    fn create_from_template_creates_note() {
        let tmp = std::env::temp_dir().join("jot-test-tmpl");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let tmpl = tmp.join("t.md");
        fs::write(&tmpl, "# {{title}}\n").unwrap();
        let r = create_from_template(
            tmp.to_string_lossy().to_string(),
            tmpl.to_string_lossy().to_string(),
            "新笔记".to_string(),
        )
        .unwrap();
        assert!(r.ends_with("新笔记.md"));
        assert_eq!(fs::read_to_string(&r).unwrap(), "# 新笔记\n");
        let _ = fs::remove_dir_all(&tmp);
    }

    // ---- 反向链接 ----

    /// 快速构造一个临时 vault 目录（各测试用唯一目录名，避免并行跑测试互相干扰）。
    fn mk_vault(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jot-test-{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        dir
    }

    #[test]
    fn backlinks_match_with_backslash_target_path() {
        let tmp = mk_vault("backslash");
        let target = tmp.join("sub").join("b.md");
        fs::write(&target, "# B\n").unwrap();
        fs::write(tmp.join("a.md"), "link to ](sub/b.md)\n").unwrap();

        // 模拟 Windows 风格 target_file（目录前缀相同、分隔符为 `\`）
        let target_win = format!("{}\\sub\\b.md", tmp.to_string_lossy());
        let results = get_backlinks_blocking(&tmp.to_string_lossy(), &target_win);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "a");
        assert_eq!(results[0].line, 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn backlinks_long_chinese_line_no_panic() {
        let tmp = mk_vault("long-cn");
        let target = tmp.join("b.md");
        fs::write(&target, "# B\n").unwrap();
        // 33+ 个中文字符的长行（>100 字节，旧实现 `&line[..97]` 会在字符中间切片 panic）
        let long_cn = "这是很长的一行中文内容用于触发上下文截断的字节边界问题".repeat(2);
        fs::write(tmp.join("a.md"), format!("{} [[b]] 结尾\n", long_cn)).unwrap();

        let results = get_backlinks_blocking(&tmp.to_string_lossy(), &target.to_string_lossy());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "a");
        // 上下文被截断且以省略号结尾（能到这里说明没有 panic）
        assert!(results[0].context.ends_with('…'));
        assert!(results[0].context.chars().count() <= 101);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn backlinks_match_file_relative_sibling_and_up() {
        let tmp = mk_vault("file-rel");
        let target = tmp.join("sub").join("b.md");
        fs::write(&target, "# B\n").unwrap();
        // 同目录兄弟笔记用文件相对链接 `](b.md)` 与 `](./b.md)`（app 补全/点击解析都是这个约定）
        fs::write(tmp.join("sub").join("c.md"), "see [b](b.md)\n").unwrap();
        fs::write(tmp.join("sub").join("d.md"), "see [b](./b.md)\n").unwrap();
        // 子目录笔记用 `../` 链接到根目录
        fs::write(tmp.join("a.md"), "# A\n").unwrap();
        fs::write(tmp.join("sub").join("e.md"), "see [a](../a.md)\n").unwrap();

        let results = get_backlinks_blocking(&tmp.to_string_lossy(), &target.to_string_lossy());
        assert_eq!(results.len(), 2, "同目录 `](b.md)` 与 `](./b.md)` 都应命中");
        let names: Vec<&str> = results.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"c") && names.contains(&"d"));

        let target_a = tmp.join("a.md");
        let results_a = get_backlinks_blocking(&tmp.to_string_lossy(), &target_a.to_string_lossy());
        assert_eq!(results_a.len(), 1);
        assert_eq!(results_a[0].name, "e");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn backlinks_match_wiki_path_extension_anchor_alias() {
        let tmp = mk_vault("wiki-forms");
        let target = tmp.join("sub").join("b.md");
        fs::write(&target, "# B\n").unwrap();
        fs::write(tmp.join("w1.md"), "x [[sub/b]] y\n").unwrap();
        fs::write(tmp.join("w2.md"), "x [[b.md]] y\n").unwrap();
        fs::write(tmp.join("w3.md"), "x [[b#heading]] y\n").unwrap();
        fs::write(tmp.join("w4.md"), "x [[b|别名]] y\n").unwrap();
        // app 补全风格：尖括号包裹的根相对链接
        fs::write(tmp.join("w5.md"), "x [text](<sub/b.md>) y\n").unwrap();

        let results = get_backlinks_blocking(&tmp.to_string_lossy(), &target.to_string_lossy());
        assert_eq!(results.len(), 5);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn backlinks_skip_fenced_code() {
        let tmp = mk_vault("skip-code");
        let target = tmp.join("b.md");
        fs::write(&target, "# B\n").unwrap();
        // [[b]] 只出现在 fenced code block 里，不应算反链
        fs::write(
            tmp.join("a.md"),
            "```\nthis is code with [[b]] inside\n```\n",
        )
        .unwrap();
        // 代码块之外没有命中 → 不返回该文件
        fs::write(
            tmp.join("c.md"),
            "```\ncode [[b]]\n```\nreal link [[b]] here\n",
        )
        .unwrap();

        let results = get_backlinks_blocking(&tmp.to_string_lossy(), &target.to_string_lossy());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "c");
        assert_eq!(results[0].line, 4);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn backlinks_scan_underscore_note_but_skip_templates() {
        let tmp = mk_vault("underscore");
        let target = tmp.join("b.md");
        fs::write(&target, "# B\n").unwrap();
        // `_` 开头的普通笔记可见于文件树，应参与扫描
        fs::write(tmp.join("_private.md"), "see [[b]]\n").unwrap();
        // _templates 是模板目录，应跳过
        fs::create_dir_all(tmp.join("_templates")).unwrap();
        fs::write(tmp.join("_templates").join("t.md"), "see [[b]]\n").unwrap();

        let results = get_backlinks_blocking(&tmp.to_string_lossy(), &target.to_string_lossy());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "_private");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn backlinks_match_percent_encoded_paths() {
        let tmp = mk_vault("encoded");
        let target = tmp.join("sub").join("hello world.md");
        fs::write(&target, "# hello world\n").unwrap();
        fs::write(
            tmp.join("e1.md"),
            "see [x](<sub/hello%20world.md>)\n",
        )
        .unwrap();
        fs::write(tmp.join("e2.md"), "see [x](sub/hello%20world.md)\n").unwrap();

        let results = get_backlinks_blocking(&tmp.to_string_lossy(), &target.to_string_lossy());
        assert_eq!(results.len(), 2);

        // 中文文件名：app 补全写入 encodeURI 后的路径
        let target_cn = tmp.join("sub").join("你好.md");
        fs::write(&target_cn, "# 你好\n").unwrap();
        fs::write(
            tmp.join("e3.md"),
            "see [你好](<sub/%E4%BD%A0%E5%A5%BD.md>)\n",
        )
        .unwrap();
        let results_cn = get_backlinks_blocking(&tmp.to_string_lossy(), &target_cn.to_string_lossy());
        assert_eq!(results_cn.len(), 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn backlinks_skip_self_and_sort_deterministically() {
        let tmp = mk_vault("sort");
        let target = tmp.join("b.md");
        fs::write(&target, "# B\nself link [[b]]\n").unwrap();
        fs::write(tmp.join("a.md"), "see [[b]]\n").unwrap();
        fs::write(tmp.join("z.md"), "see [[b]]\n").unwrap();

        let results = get_backlinks_blocking(&tmp.to_string_lossy(), &target.to_string_lossy());
        // 自身 [[b]] 不算反链
        assert_eq!(results.len(), 2);
        // 确定性排序：按路径
        assert_eq!(results[0].name, "a");
        assert_eq!(results[1].name, "z");
        let _ = fs::remove_dir_all(&tmp);
    }

    // ---- validate_remote_url ----

    #[test]
    fn remote_url_rejects_embedded_credentials() {
        assert!(validate_remote_url("https://user:token@host.com/r.git").is_err());
        assert!(validate_remote_url("ssh://git@host.com/r.git").is_err());
    }

    #[test]
    fn remote_url_rejects_dash_prefix() {
        assert!(validate_remote_url("-upload-pack=evil").is_err());
        assert!(validate_remote_url("").is_err());
    }

    #[test]
    fn remote_url_allows_normal_urls() {
        assert!(validate_remote_url("https://github.com/u/r.git").is_ok());
        assert!(validate_remote_url("git@github.com:u/r.git").is_ok());
    }

    // ---- is_markdown_path ----

    #[test]
    fn markdown_path_case_insensitive() {
        assert!(is_markdown_path("/a/b.md"));
        assert!(is_markdown_path("/a/b.MD"));
        assert!(is_markdown_path("/a/笔记.Md"));
        assert!(!is_markdown_path("/a/b.txt"));
        assert!(!is_markdown_path("/a/md"));
    }

    // ---- is_symlink ----

    #[cfg(unix)]
    #[test]
    fn symlink_detected() {
        let tmp = std::env::temp_dir().join("jot-test-symlink");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let real = tmp.join("real.md");
        fs::write(&real, "x").unwrap();
        let link = tmp.join("link.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(is_symlink(&link));
        assert!(!is_symlink(&real));
        let _ = fs::remove_dir_all(&tmp);
    }
}
