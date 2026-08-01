// 链接点击/悬浮卡片共用的打开逻辑与语法树解析
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { api } from "@/lib/tauri";
import { isExternalPath, resolveLinkPath } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { useEditorStore } from "@/stores/editorStore";
import { useTabStore } from "@/stores/tabStore";

// toast 出口：本模块是非 React 代码，useToast 只能在组件内调用，
// 由 Editor 组件挂载时通过 setLinkToastHandler 注入
let toastFn: ((msg: string) => void) | null = null;
export function setLinkToastHandler(fn: ((msg: string) => void) | null) {
  toastFn = fn;
}
const linkToast = (msg: string) => toastFn?.(msg);

/** 随应用打包的只读资源文档：位于笔记工作区外（getResourcePath），
 *  常规链接解析会被工作区守卫挡掉，需按文件名命中后打开 */
const RESOURCE_DOCS = ["用户协议.md", "隐私政策.md", "MCP 配置指南.md"];

/** 打开内置资源文档为只读标签；读取失败返回 false（由调用方决定 toast 文案） */
async function openResourceDoc(resName: string): Promise<boolean> {
  try {
    const resPath = await api.getResourcePath(resName);
    const ok = await useTabStore.getState().openFileByPath(resPath);
    if (ok === false) return false;
    useTabStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === resPath ? { ...t, readOnly: true } : t,
      ),
    }));
    return true;
  } catch {
    return false;
  }
}

/** 语法树中一个链接的完整信息（供悬浮卡片编辑/移除用） */
export interface LinkInfo {
  url: string;
  /** 链接显示文字（Autolink 时等于 url） */
  text: string;
  /** 整个 Link/Autolink 节点范围 */
  linkFrom: number;
  linkTo: number;
  /** URL 子节点范围 */
  urlFrom: number;
  urlTo: number;
  /** 源码中 URL 是否被 `<>` 包裹：包裹内 `#`/`?` 是字面量（文件名可含），不得按锚点剥离 */
  angleWrapped: boolean;
}

/** 光标处的链接节点信息：Link 取 URL 子节点 + LinkMark 间文字；
 *  Autolink 的 URL 节点即全部内容。引用式链接（无 URL 子节点）返回 null。 */
export function linkInfoAt(view: EditorView, pos: number): LinkInfo | null {
  let info: LinkInfo | null = null;
  syntaxTree(view.state).iterate({
    from: pos,
    to: pos,
    enter(node) {
      if (node.name === "Link") {
        const urlNode = node.node.getChild("URL");
        if (!urlNode) return false; // 引用式链接不支持卡片编辑
        const linkMarks = node.node.getChildren("LinkMark");
        const text =
          linkMarks.length >= 2
            ? view.state.sliceDoc(linkMarks[0].to, linkMarks[1].from)
            : "";
        info = {
          url: view.state.sliceDoc(urlNode.from, urlNode.to),
          text,
          linkFrom: node.from,
          linkTo: node.to,
          urlFrom: urlNode.from,
          urlTo: urlNode.to,
          // URL 节点内容不含 `<>`，通过前一字符判断源码是否包裹（补全写入恒包裹）
          angleWrapped:
            urlNode.from > 0 &&
            view.state.sliceDoc(urlNode.from - 1, urlNode.from) === "<",
        };
        return false;
      }
      if (node.name === "Autolink") {
        const urlNode = node.node.getChild("URL");
        if (!urlNode) return false;
        const url = view.state.sliceDoc(urlNode.from, urlNode.to);
        info = {
          url,
          text: url,
          linkFrom: node.from,
          linkTo: node.to,
          urlFrom: urlNode.from,
          urlTo: urlNode.to,
          angleWrapped: true, // Autolink 恒为 `<url>` 形态
        };
        return false;
      }
    },
  });
  return info;
}

/** 当前笔记所在目录（解析相对路径链接的基准） */
function currentNoteDir(): string {
  const p = useEditorStore.getState().selectedPath;
  return p ? p.slice(0, p.lastIndexOf("/")) : "";
}

/** 链接 URL → 目标路径（保留 %XX 编码，交给 resolveLinkPath 解码）。
 *  仅对非 `<>` 包裹的裸 URL 剥离 `#`/`?`（锚点/查询分隔符）；
 *  `<>` 包裹（补全写入恒包裹）内 `#`/`?` 是字面量——文件名可含这些字符，
 *  encodeURI 不编码它们，剥离会导致 `a#b.md` 被错误解析成 `a.md`。 */
export function linkTargetPath(url: string, angleWrapped: boolean): string {
  if (url.startsWith("#")) return ""; // 纯锚点：暂不实现文档内跳转
  return angleWrapped ? url : url.split(/[?#]/)[0];
}

/** 双基准解析链接目标：文件相对（当前笔记目录）优先、仓库根相对（notesDir）兜底，
 *  与反链扫描的 dual-base 匹配一致（src-tauri lib.rs first_match_line）。
 *  返回按优先级排序、已过滤工作区外的绝对路径候选；不存在/越界为空数组。 */
export function resolveLinkCandidates(
  target: string,
  noteDir: string,
  notesDir: string,
): string[] {
  const abs1 = noteDir ? resolveLinkPath(noteDir, target) : "";
  const abs2 = notesDir ? resolveLinkPath(notesDir, target) : "";
  const out: string[] = [];
  for (const p of [abs1, abs2]) {
    if (p && !out.includes(p) && !isExternalPath(p, notesDir)) out.push(p);
  }
  return out;
}

/** 打开链接目标：
 *  - http(s)：系统浏览器
 *  - mailto:/tel:：系统默认程序；其余未知 scheme 拒绝
 *  - 纯锚点 #xxx：暂不实现文档内跳转，静默忽略
 *  - 相对路径 .md：应用内打开（双基准：文件相对优先、仓库根相对兜底）
 *  - 其他本地路径（PDF 等附件）：系统默认程序
 *  安全约束：本地路径解析后必须仍在笔记工作区内，越界拒绝。
 *  angleWrapped：源码中 URL 被 `<>` 包裹时为 true（影响 `#`/`?` 的剥离）。 */
export async function openLinkTarget(
  url: string,
  opts: { angleWrapped?: boolean } = {},
): Promise<void> {
  if (/^https?:\/\//i.test(url)) {
    api.openUrl(url).catch((e) => console.warn("打开链接失败", e));
    return;
  }
  // 显式 scheme 分流（mailto:/tel:/自定义协议等）
  const schemeMatch = url.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "mailto" || scheme === "tel") {
      api.openUrl(url).catch((e) => console.warn("打开链接失败", e));
    } else {
      linkToast(`不支持打开 ${scheme}: 协议的链接`);
    }
    return;
  }
  // 纯锚点链接：split 后会解析成当前目录本身去 open_in_system，行为怪异，
  // 锚点跳转暂不实现，直接忽略
  if (url.startsWith("#")) return;
  const notesDir = useAppStore.getState().notesDir;
  if (!notesDir) {
    linkToast("链接目标超出笔记目录，已阻止打开");
    return;
  }
  const target = linkTargetPath(url, opts.angleWrapped ?? false);
  const candidates = resolveLinkCandidates(target, currentNoteDir(), notesDir);
  if (candidates.length === 0) {
    // 双基准解析后仍无工作区内候选（挡 ../ 逃逸、外部绝对路径、
    // percent-encoding 绕过——resolveLinkPath 已 decodeURIComponent + 规范化）。
    // 兜底：打包资源文档（用户协议/隐私政策等）位于笔记工作区外，上面的守卫
    // 会把它们挡掉；文件名命中内置资源则打开只读标签（文档内互引跳转依赖此分支）
    const resName = target.split("/").pop() ?? target;
    if (RESOURCE_DOCS.includes(resName)) {
      if (!(await openResourceDoc(resName))) linkToast(`无法打开 ${resName}`);
      return;
    }
    linkToast("链接目标超出笔记目录，已阻止打开");
    return;
  }
  // 存在性优先：文件相对与仓库根相对都合法时打开实际存在的目标；
  // 都不存在则退回文件相对候选（保留"目标文件不存在"的报错路径）
  const mtimes = await Promise.all(
    candidates.map((p) => api.fileMtime(p).catch(() => 0)),
  );
  const existing = candidates.find((_, i) => mtimes[i] > 0);
  const abs = existing ?? candidates[0];
  if (!existing) {
    // 工作区目标不存在（存在性检查在前，避免打开失败后再兜底）。
    // 若文件名命中内置资源文档（用户协议/隐私政策等），直接打开打包资源；
    // 否则保留原有"目标文件不存在"报错路径（走下方 openFile，读盘失败触发 toast）
    const resName = abs.split("/").pop() ?? abs;
    if (RESOURCE_DOCS.includes(resName)) {
      if (!(await openResourceDoc(resName))) linkToast(`无法打开 ${resName}`);
      return;
    }
  }
  if (/\.md$/i.test(abs)) {
    useTabStore
      .getState()
      .openFile({
        name: abs.split("/").pop() ?? abs,
        path: abs,
        isDir: false,
        children: [],
      })
      .then((ok: unknown) => {
        // openFile 契约：读取失败返回 false（如目标已被删除）。
        // 用 unknown + 显式 === false 判断，兼容契约落地前的 void 返回
        if (ok === false) linkToast("目标文件不存在");
      });
    return;
  }
  api.openInSystem(abs).catch((e) => console.warn("系统打开失败", e));
}
