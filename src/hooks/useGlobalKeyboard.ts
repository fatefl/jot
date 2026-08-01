// src/hooks/useGlobalKeyboard.ts
import { useEffect, type RefObject } from "react";
import { useEditorStore } from "@/stores/editorStore";
import { useTabStore } from "@/stores/tabStore";
import { useAppStore } from "@/stores/appStore";
import { useUiStore } from "@/stores/uiStore";
import { useFileStore } from "@/stores/fileStore";
import { api } from "@/lib/tauri";
import type { EditorPanelHandle } from "@/components/Editor";

export function useGlobalKeyboard(editorRef: RefObject<EditorPanelHandle | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // Cmd+S — 保存
      if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        useEditorStore.getState().saveCurrent();
      }

      // Cmd+Shift+S — 另存为
      if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        useEditorStore.getState().handleSaveAs();
      }

      // Cmd+O — 打开外部文件
      if (mod && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        useTabStore.getState().openExternalFile();
      }

      // Cmd+Shift+K — 命令面板（Cmd+K 被原生菜单 format_link 占用）
      if (mod && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useUiStore.setState({ paletteOpen: true });
      }

      // Cmd+Shift+E — 表情选择器
      if (mod && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        useUiStore.setState({ emojiOpen: true });
      }

      // Cmd+P — 打印
      if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        useEditorStore.getState().handlePrint();
      }

      // Cmd+Shift+P — 切换模式
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        useEditorStore.setState((s) => ({
          mode: s.mode === "wysiwyg" ? "source" : "wysiwyg",
        }));
      }

      // Cmd+N — 新建笔记
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        const dir = useAppStore.getState().notesDir;
        if (!dir) return;
        api.listTemplates(dir).then((tmpl) => {
          if (tmpl.length > 0) {
            useUiStore.setState({ templateList: tmpl, templatePickerOpen: true });
          } else {
            useFileStore.getState().createNoteAt(dir).then((path) => {
              useTabStore.getState().openFileByPath(path);
            });
          }
        }).catch(() => {
          useFileStore.getState().createNoteAt(dir).then((path) => {
            useTabStore.getState().openFileByPath(path);
          });
        });
      }

      // Cmd+D — 日记
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        useTabStore.getState().openDailyNote();
      }

      // Cmd+Shift+F — 专注模式
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        useUiStore.getState().toggleFocusMode();
      }

      // Cmd+W — 关闭标签
      if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const { activeTabIdx, closeTab } = useTabStore.getState();
        closeTab(activeTabIdx);
      }

      // Cmd+Shift+T — 重新打开关闭的标签
      if (mod && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        useTabStore.getState().reopenTab();
      }

      // Cmd+Shift+O — 大纲面板
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        useUiStore.setState((s) => ({ outlineOpen: !s.outlineOpen }));
      }

      // Cmd+Shift+G — 标签面板
      if (mod && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        useUiStore.setState((s) => ({ tagsOpen: !s.tagsOpen }));
      }

      // Cmd+Shift+M — 元数据面板
      if (mod && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        useUiStore.setState((s) => ({ frontmatterPanelOpen: !s.frontmatterPanelOpen }));
      }

      // Cmd+Shift+D — 待办面板
      if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        useUiStore.setState((s) => ({ todoPanelOpen: !s.todoPanelOpen }));
      }

      // Esc — 退出专注模式
      if (e.key === "Escape" && useUiStore.getState().focusMode) {
        useUiStore.setState({ focusMode: false });
      }

      // Cmd+, — 设置
      if (mod && e.key === ",") {
        e.preventDefault();
        useUiStore.setState({ settingsOpen: true });
      }

      // Ctrl+Tab — 切换下一个标签
      if (e.ctrlKey && e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const { tabs, activeTabIdx } = useTabStore.getState();
        useTabStore.getState().switchTab((activeTabIdx + 1) % tabs.length);
      }

      // Ctrl+Shift+Tab — 切换上一个标签
      if (e.ctrlKey && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        const { tabs, activeTabIdx } = useTabStore.getState();
        useTabStore.getState().switchTab((activeTabIdx - 1 + tabs.length) % tabs.length);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // 空依赖 — getState() 始终返回最新值
}
