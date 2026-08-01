import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { isWindows } from "@/lib/platform";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 判断字符是否属于 JS 正则 `\s` 的完整空白集合（V8 语义，含 NBSP、全角空格、零宽不换行空格）。 */
function isWhitespace(c: number): boolean {
  return (
    c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0x20 || // \t\n\v\f\r 空格
    c === 0xa0 || // NBSP
    c === 0x1680 || // Ogham 空格
    (c >= 0x2000 && c <= 0x200a) || // en/em 等各类空格
    c === 0x2028 || c === 0x2029 || // 行/段分隔符
    c === 0x202f || // 窄 NBSP
    c === 0x205f || // 中数学空格
    c === 0x3000 || // 全角空格
    c === 0xfeff // 零宽不换行空格
  );
}

/** 字数统计：CJK 字符逐字计数，其余按空白分词。单遍扫描，无中间数组/字符串分配。
 *  旧实现全文 match + replace + split，5MB 文档 ~300ms；本实现 ~13ms，结果完全一致。 */
export function countWords(text: string): number {
  let cjk = 0;
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) {
      cjk++; // CJK 单字即一字
      inWord = false; // 与 replace(CJK, " ") 语义一致：CJK 两侧视为断开
    } else if (isWhitespace(c)) {
      inWord = false;
    } else {
      if (!inWord) {
        words++;
        inWord = true;
      }
      // 代理对（emoji 等）整体算一个字符：高位代理后跳过其低位
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
        const lo = text.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) i++;
      }
    }
  }
  return cjk + words;
}

export function stripMdExtension(name: string): string {
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/** 规范化路径分隔符：统一为 "/"。Windows 上系统对话框/事件等外部入口可能给出
 *  反斜杠路径，进前端前先归一，保证下游 parentOf/relativePath/expandTo 等
 *  基于 "/" 的路径处理全部成立。 */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 深度归一化文件树节点路径。兼容 Windows 上旧版本 Rust 二进制返回的反斜杠路径。 */
export function normalizeTree<T extends { path?: string; children: T[] }>(node: T): T {
  return {
    ...node,
    ...(node.path ? { path: normPath(node.path) } : {}),
    children: node.children.map(normalizeTree),
  };
}

/** 外部文件判定：path 不在 notesDir 之下即为外部（手动保存、不参与 git 同步）。
 *  比较前把两边统一为 "/" 分隔——Windows 上 Rust/文件对话框返回的是反斜杠路径，
 *  直接拼 `notesDir + "/"` 前缀必然失配，会把内部文件误判为外部；
 *  再去掉 notesDir 尾部分隔符，避免 `C:\notes\` 拼出 `C:\notes//`。
 *  Windows 文件系统大小写不敏感，用小写前缀判断；尾随 "/" 避免 "/notes2" 误命中 "/notes"。 */
export function isExternalPath(path: string, notesDir: string | null | undefined): boolean {
  if (!notesDir) return true;
  const p = path.replace(/\\/g, "/");
  const d = notesDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (isWindows) {
    return !p.toLowerCase().startsWith(d.toLowerCase() + "/");
  }
  return !p.startsWith(d + "/");
}

/** 以 fromDir 为基准计算到 to 的相对路径（需要时补 ../ 前缀）。
 *  输入先归一为 "/" 分隔，Windows 反斜杠路径同样适用。 */
export function relativePath(fromDir: string, to: string): string {
  const from = normPath(fromDir).split("/").filter(Boolean);
  const target = normPath(to).split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < target.length && from[i] === target[i]) i++;
  const ups = from.length - i;
  const rest = target.slice(i).join("/");
  return (ups > 0 ? Array(ups).fill("..").join("/") + "/" : "") + rest;
}

/** 把链接中的路径解析为绝对路径：baseDir 为当前笔记所在目录，
 *  处理 ./ ../ 与 percent-encoding；绝对路径原样规范化后返回。
 *  输入 baseDir 先归一为 "/" 分隔，Windows 反斜杠路径同样适用。 */
export function resolveLinkPath(baseDir: string, linkPath: string): string {
  let decoded = normPath(linkPath);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* 非转义路径原样使用 */
  }
  const joined = decoded.startsWith("/") ? decoded : `${normPath(baseDir)}/${decoded}`;
  const out: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}
