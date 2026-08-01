// src/stores/editorStore.ts
import { create } from "zustand";
import type { ExportFormat } from "@/lib/export";
import type { SaveState } from "@/components/StatusBar";
import type { ToastFn } from "@/components/ui/toast";
import { api } from "@/lib/tauri";
import { countWords, stripMdExtension, isExternalPath } from "@/lib/utils";
import { exportNote, isPandocFormat, renderHtml } from "@/lib/export";
import { finalizeActiveEdit } from "@/lib/editorViewCache";
import type { EditorMode } from "@/components/Editor";

export type { EditorMode, SaveState };

// 写盘串行化队列：所有文件写入统一经此队列执行，
// 避免在途自动保存与切换/手动保存乱序，旧内容后落盘回退磁盘
let writeQueue: Promise<unknown> = Promise.resolve();

/** 串行执行文件写入（自动保存、切换保存、手动保存共用） */
export function enqueueWriteFile(path: string, content: string): Promise<void> {
  const p = writeQueue.then(() => api.writeFile(path, content));
  writeQueue = p.catch(() => {});
  return p;
}

/** 读取文件 mtime 基准；后端命令不可用或失败时返回 null */
export async function fetchMtime(path: string): Promise<number | null> {
  try {
    const fn = (api as { fileMtime?: (p: string) => Promise<number> }).fileMtime;
    if (typeof fn !== "function") return null;
    const mt = await fn(path);
    return typeof mt === "number" && mt > 0 ? mt : null;
  } catch {
    return null;
  }
}

export interface EditorState {
  // 状态
  doc: string;
  selectedPath: string | null;
  docEpoch: number;
  mode: EditorMode;
  saveState: SaveState;
  cursorLine: number | null;
  jumpTarget: number | null;

  // 内部追踪（替代原 ref）
  dirty: boolean;
  lastSavedDoc: string;
  lastSavedAt: number | null;
  autoCommitted: boolean;
  /** 公式/图表编辑模式中——禁止自动保存，防止裸代码（无 $/``` 定界符）写入磁盘 */
  isFormulaEditing: boolean;
  /** 当前文档加载/保存时的磁盘 mtime 基准（毫秒），用于外部修改感知 */
  loadedMtime: number | null;
  /** 导出进行中——防止重复触发 */
  exporting: boolean;

  // 派生
  wordCount: () => number;
  fileName: () => string | null;

  // 简单 setter
  setDoc: (doc: string) => void;
  setSelectedPath: (path: string | null) => void;
  setDocEpoch: (e: number | ((prev: number) => number)) => void;
  setMode: (mode: EditorMode) => void;
  setCursorLine: (line: number) => void;
  setJumpTarget: (line: number | null) => void;
  setFormulaEditing: (v: boolean) => void;

  // 动作
  saveCurrent: () => Promise<void>;
  handleExport: (format: ExportFormat, toast?: ToastFn) => Promise<void>;
  handleSaveAs: () => Promise<void>;
  handlePrint: (toast?: ToastFn) => void;
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  doc: "",
  selectedPath: null,
  docEpoch: 0,
  mode: "wysiwyg",
  saveState: "idle",
  cursorLine: null,
  jumpTarget: null,
  dirty: false,
  lastSavedDoc: "",
  lastSavedAt: null,
  autoCommitted: false,
  isFormulaEditing: false,
  loadedMtime: null,
  exporting: false,

  wordCount: () => countWords(get().doc),
  fileName: () => {
    const path = get().selectedPath;
    return path ? path.split("/").pop() ?? null : null;
  },

  setDoc: (doc) => set({ doc }),
  setSelectedPath: (path) => set({ selectedPath: path }),
  setDocEpoch: (e) =>
    set((s) => ({ docEpoch: typeof e === "function" ? e(s.docEpoch) : e })),
  setMode: (mode) => set({ mode }),
  setCursorLine: (line) => set({ cursorLine: line }),
  setJumpTarget: (line) => set({ jumpTarget: line }),
  setFormulaEditing: (v) => set({ isFormulaEditing: v }),

  saveCurrent: async () => {
    // 公式/图表编辑中：先把编辑会话收尾（重新包裹回 $$…$$ / ```mermaid 定界符），
    // 再继续保存。收尾会经 finalizeActiveEdit 同步 setDoc，因此这里必须重新读取状态。
    // 若没有活动视图/会话（finalize 无效），isFormulaEditing 保持 true → 仍走守卫跳过，
    // 保证裸代码（无定界符）绝不落盘。
    if (get().isFormulaEditing) finalizeActiveEdit();
    const { doc, selectedPath, dirty, isFormulaEditing } = get();
    if (!selectedPath || !dirty) return;
    // 统一写盘入口的公式/图表守卫：doc 为剥离定界符的裸代码，
    // 所有保存路径（Cmd+S、切换标签、关闭确认、自动保存 flush）都必须走这里
    if (isFormulaEditing) return;

    set({ saveState: "saving" });
    try {
      await enqueueWriteFile(selectedPath, doc);
      const loadedMtime = await fetchMtime(selectedPath);
      set({
        lastSavedDoc: doc,
        dirty: false,
        saveState: "saved",
        lastSavedAt: Date.now(),
        autoCommitted: false,
        // 保存后刷新 mtime 基准，用于外部修改感知
        ...(loadedMtime !== null ? { loadedMtime } : {}),
      });
    } catch (e) {
      set({ saveState: "idle" });
      throw e;
    }
  },

  handleExport: async (format: ExportFormat, toast?: ToastFn) => {
    // 导出同样可能发生在公式/图表编辑中：先收尾编辑（恢复定界符）再取 doc，
    // 否则导出的 HTML/PNG 里公式/图表会变成裸文本
    if (get().isFormulaEditing) finalizeActiveEdit();
    const { doc, selectedPath, exporting } = get();
    if (!selectedPath || exporting) return;
    if (!isPandocFormat(format) && !doc) return;

    const title = stripMdExtension(selectedPath.split("/").pop() || "note");
    set({ exporting: true });
    // 导出可能耗时数秒（PNG 渲染 / Pandoc），"导出中"提示给足时长兜底，
    // 正常结束时在 finally 里主动关闭
    const progressId = toast?.("正在导出…", { duration: 30000 });
    try {
      const destPath = await exportNote(doc || "", selectedPath, title, format, async () => {
        // pandoc 不可用时的回调 — 通过 uiStore 弹窗
        const { useUiStore } = await import("./uiStore");
        return useUiStore.getState().showPandocDialog();
      });
      // 用户取消保存对话框（或 PDF 走打印对话框）时 destPath 为 null，不提示
      if (destPath) toast?.(`已导出到 ${destPath}`, { duration: 5000 });
    } catch (e) {
      toast?.(`导出失败：${e}`, { duration: 5000 });
    } finally {
      if (typeof progressId === "number") toast?.dismiss?.(progressId);
      set({ exporting: false });
    }
  },

  handleSaveAs: async () => {
    // 另存为同样可能发生在公式/图表编辑中：先收尾编辑（恢复定界符）再取 doc
    if (get().isFormulaEditing) finalizeActiveEdit();
    const { selectedPath, doc } = get();
    if (!selectedPath) return;

    const { save } = await import("@tauri-apps/plugin-dialog");
    const defaultName = stripMdExtension(selectedPath.split("/").pop() || "note");
    const destPath = await save({
      defaultPath: `${defaultName}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!destPath) return;

    try {
      await api.writeFile(destPath, doc);
      // 切换到新文件
      const { useTabStore } = await import("./tabStore");
      await useTabStore.getState().openFileByPath(destPath);
    } catch (e) {
      throw e;
    }
  },

  handlePrint: (toast?: ToastFn) => {
    const { doc, selectedPath } = get();
    if (!selectedPath) return;
    void (async () => {
      const html = await renderHtml(doc);

      // macOS：WKWebView 不实现 window.print()（iframe 打印静默失败），
      // 走原生离屏 webview + printOperation 弹系统打印面板。其余平台走 iframe。
      const { isMac } = await import("@/lib/platform");
      if (isMac) {
        try {
          await api.printNative(html);
        } catch (e) {
          toast?.(`打印失败：${e}`, { duration: 5000 });
        }
        return;
      }

      // 打印逻辑：渲染 HTML → 创建 iframe → 调用 print
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "none";
      document.body.appendChild(iframe);

      const doc2 = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc2) {
        // 无法访问 iframe 文档：移除已 append 的 iframe，避免泄漏
        document.body.removeChild(iframe);
        return;
      }

      // onload 与兜底定时器都可能触发，保证只打印一次、iframe 必被移除
      let printed = false;
      const printOnce = () => {
        if (printed) return;
        printed = true;
        const doPrint = () => {
          try {
            iframe.contentWindow?.print();
          } catch {}
          setTimeout(() => {
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
          }, 1000);
        };
        // 等内联的 KaTeX 字体加载完再打印，否则公式缺字形
        if (doc2.fonts?.ready) doc2.fonts.ready.then(doPrint, doPrint);
        else doPrint();
      };

      doc2.open();
      doc2.write(html);
      doc2.close();

      iframe.onload = printOnce;
      // 如果 onload 不触发，手动调用
      setTimeout(printOnce, 500);
    })();
  },
}));
