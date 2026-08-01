import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";

/**
 * 专注模式 Typewriter 效果：
 * 编辑/光标移动时，光标所在行保持在编辑器垂直居中位置。
 * 仅当 document.documentElement 上有 .focus-mode 类时生效。
 */
function centerCursor(view: EditorView) {
  const pos = view.state.selection.main.head;
  const line = view.lineBlockAt(pos);
  const editorHeight = view.scrollDOM.clientHeight;
  if (editorHeight <= 0) return;
  const target = line.top - (editorHeight - line.height) / 2;
  view.scrollDOM.scrollTop = Math.max(0, target);
}

export const focusTypewriter = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      // 初次打开文件时若已在专注模式，居中光标
      if (document.documentElement.classList.contains("focus-mode")) {
        requestAnimationFrame(() => centerCursor(view));
      }
    }

    update(update: ViewUpdate) {
      // 仅专注模式下生效
      if (!document.documentElement.classList.contains("focus-mode")) return;
      // 仅在选区变化时居中（用户点击或移动光标），
      // docChanged（纯文本替换不移动光标）不触发，避免干扰手动滚动
      if (!update.selectionSet) return;
      requestAnimationFrame(() => centerCursor(update.view));
    }
  },
);
