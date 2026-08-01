// src/menus/appMenu.ts
// 菜单栏 6 组菜单定义
import type { MenuGroup } from "@/components/MenuBar";
import { api } from "@/lib/tauri";
import { relativePath } from "@/lib/utils";
import { shortcut } from "@/lib/platform";
import { useAppStore } from "@/stores/appStore";
import { useEditorStore } from "@/stores/editorStore";
import { useFileStore } from "@/stores/fileStore";
import { useTabStore } from "@/stores/tabStore";
import { useUiStore } from "@/stores/uiStore";
import type { EditorPanelHandle } from "@/components/Editor";

export function buildMenuGroups(
  pandocAvailable: boolean,
  editorRef: React.RefObject<EditorPanelHandle>,
  toast: (msg: string) => void,
  setTheme: (value: any) => void,
): MenuGroup[] {
  return [
    {
      label: "文件",
      items: [
        {
          label: "新建笔记",
          shortcut: shortcut("⌘N"),
          onClick: () => {
            const nDir = useAppStore.getState().notesDir;
            if (!nDir) return;
            api
              .listTemplates(nDir)
              .then((tmpl) => {
                if (tmpl.length > 0) {
                  useUiStore.setState({
                    templateList: tmpl,
                    templatePickerOpen: true,
                  });
                } else
                  useFileStore
                    .getState()
                    .createNoteAt(nDir)
                    .then((p) => useTabStore.getState().openFileByPath(p));
              })
              .catch(() =>
                useFileStore
                  .getState()
                  .createNoteAt(nDir)
                  .then((p) => useTabStore.getState().openFileByPath(p)),
              );
          },
        },
        {
          label: "新建文件夹",
          onClick: () => {
            const nDir = useAppStore.getState().notesDir;
            if (nDir) useFileStore.getState().createDirAt(nDir);
          },
        },
        "separator" as const,
        {
          label: "保存",
          shortcut: shortcut("⌘S"),
          onClick: () => useEditorStore.getState().saveCurrent(),
        },
        {
          label: "另存为...",
          shortcut: shortcut("⌘⇧S"),
          disabled: !useEditorStore.getState().selectedPath,
          onClick: () => useEditorStore.getState().handleSaveAs(),
        },
        "separator" as const,
        {
          label: "打开笔记目录",
          onClick: () => {
            if (useAppStore.getState().notesDir)
              api.revealInFolder(useAppStore.getState().notesDir!);
          },
        },
        "separator" as const,
        {
          label: "打开文件...",
          shortcut: shortcut("⌘O"),
          onClick: () => useTabStore.getState().openExternalFile(),
        },
        {
          label: "导入文件...",
          onClick: () => useTabStore.getState().importExternalFiles(),
        },
        "separator" as const,
        {
          label: "导出",
          onClick: () => {},
          children: [
            {
              label: "HTML",
              disabled: !useEditorStore.getState().selectedPath,
              onClick: () => useEditorStore.getState().handleExport("html", toast),
            },
            {
              label: "PDF",
              disabled: !useEditorStore.getState().selectedPath,
              onClick: () => useEditorStore.getState().handleExport("pdf", toast),
            },
            {
              label: "PNG 图片",
              disabled: !useEditorStore.getState().selectedPath,
              onClick: () => useEditorStore.getState().handleExport("png", toast),
            },
            "separator" as const,
            {
              label: "DOCX",
              disabled:
                !useEditorStore.getState().selectedPath || !pandocAvailable,
              onClick: () => useEditorStore.getState().handleExport("docx", toast),
            },
            {
              label: "EPUB",
              disabled:
                !useEditorStore.getState().selectedPath || !pandocAvailable,
              onClick: () => useEditorStore.getState().handleExport("epub", toast),
            },
            {
              label: "LaTeX",
              disabled:
                !useEditorStore.getState().selectedPath || !pandocAvailable,
              onClick: () => useEditorStore.getState().handleExport("latex", toast),
            },
          ],
        },
        "separator" as const,
        {
          label: "打印",
          shortcut: shortcut("⌘P"),
          disabled: !useEditorStore.getState().selectedPath,
          onClick: () => useEditorStore.getState().handlePrint(toast),
        },
        "separator" as const,
        {
          label: "设置",
          shortcut: shortcut("⌘,"),
          onClick: () => useUiStore.setState({ settingsOpen: true }),
        },
      ],
    },
    {
      label: "编辑",
      items: [
        {
          label: "撤销",
          shortcut: shortcut("⌘Z"),
          onClick: () => editorRef.current?.undo(),
        },
        {
          label: "重做",
          shortcut: shortcut("⇧⌘Z"),
          onClick: () => editorRef.current?.redo(),
        },
        "separator" as const,
        {
          label: "剪切",
          shortcut: shortcut("⌘X"),
          onClick: () => document.execCommand("cut"),
        },
        {
          label: "复制",
          shortcut: shortcut("⌘C"),
          onClick: () => document.execCommand("copy"),
        },
        {
          label: "粘贴",
          shortcut: shortcut("⌘V"),
          onClick: () => {
            navigator.clipboard
              .readText()
              .then(
                (text) =>
                  text && document.execCommand("insertText", false, text),
              )
              .catch(() => {});
          },
        },
        "separator" as const,
        {
          label: "全选",
          shortcut: shortcut("⌘A"),
          onClick: () => document.execCommand("selectAll"),
        },
        "separator" as const,
        {
          label: "命令面板...",
          shortcut: shortcut("⌘⇧K"),
          onClick: () => useUiStore.setState({ paletteOpen: true }),
        },
        {
          label: "表情符号...",
          shortcut: shortcut("⌘⇧E"),
          onClick: () => useUiStore.setState({ emojiOpen: true }),
        },
        {
          label: "查找",
          shortcut: shortcut("⌘F"),
          onClick: () => editorRef.current?.focusSearch(),
        },
      ],
    },
    {
      label: "格式",
      items: [
        {
          label: "加粗",
          shortcut: shortcut("⌘B"),
          onClick: () => editorRef.current?.toggleMark("**"),
        },
        {
          label: "斜体",
          shortcut: shortcut("⌘I"),
          onClick: () => editorRef.current?.toggleMark("*"),
        },
        {
          label: "删除线",
          onClick: () => editorRef.current?.toggleMark("~~"),
        },
        {
          label: "行内代码",
          shortcut: shortcut("⌘E"),
          onClick: () => editorRef.current?.toggleMark("`"),
        },
        {
          label: "链接",
          shortcut: shortcut("⌘K"),
          onClick: () => editorRef.current?.toggleLink(),
        },
        "separator" as const,
        {
          label: "标题",
          onClick: () => {},
          children: [
            {
              label: "一级标题",
              onClick: () => editorRef.current?.toggleHeading(1),
            },
            {
              label: "二级标题",
              onClick: () => editorRef.current?.toggleHeading(2),
            },
            {
              label: "三级标题",
              onClick: () => editorRef.current?.toggleHeading(3),
            },
          ],
        },
        {
          label: "列表",
          onClick: () => {},
          children: [
            {
              label: "无序列表",
              onClick: () => editorRef.current?.toggleBulletList(),
            },
            {
              label: "有序列表",
              onClick: () => editorRef.current?.toggleOrderedList(),
            },
            {
              label: "任务列表",
              onClick: () => editorRef.current?.toggleTaskList(),
            },
          ],
        },
        {
          label: "引用",
          onClick: () => editorRef.current?.toggleBlockquote(),
        },
        {
          label: "代码块",
          onClick: () => editorRef.current?.toggleCodeBlock(),
        },
        "separator" as const,
        {
          label: "插入",
          onClick: () => {},
          children: [
            {
              label: "图片",
              onClick: () => {
                const dir = useAppStore.getState().notesDir;
                const cur = useEditorStore.getState().selectedPath;
                if (!dir || !cur) { toast("请先打开一篇笔记再插入图片"); return; }
                const input = document.createElement("input");
                input.type = "file"; input.accept = "image/*";
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  try {
                    const buf = new Uint8Array(await file.arrayBuffer());
                    const result = await api.saveAsset(dir, file.name, Array.from(buf));
                    const rel = relativePath(cur.substring(0, cur.lastIndexOf("/")), result.path);
                    editorRef.current?.insertImage(rel);
                  } catch (err) { toast(`插入图片失败：${err}`); }
                };
                input.click();
              },
            },
            {
              label: "表格",
              onClick: () => editorRef.current?.insertTable(),
            },
            {
              label: "Mermaid 图表",
              onClick: () => editorRef.current?.insertMermaid(),
            },
            {
              label: "公式",
              onClick: () => {},
              children: [
                { label: "行内公式 ($)", onClick: () => editorRef.current?.insertMath(false) },
                { label: "块级公式 ($$)", onClick: () => editorRef.current?.insertMath(true) },
              ],
            },
            {
              label: "分割线",
              onClick: () => editorRef.current?.insertMarkdown("\n---\n"),
            },
            "separator" as const,
            {
              label: "表情符号...",
              onClick: () => useUiStore.setState({ emojiOpen: true }),
            },
          ],
        },
      ],
    },
    {
      label: "视图",
      items: [
        {
          label: "切换侧边栏",
          shortcut: shortcut("⌘\\"),
          onClick: () => useUiStore.getState().toggleSidebar(),
        },
        {
          label: "切换即时渲染",
          shortcut: shortcut("⇧⌘P"),
          onClick: () =>
            useEditorStore.setState((s) => ({
              mode: s.mode === "wysiwyg" ? "source" : "wysiwyg",
            })),
        },
        "separator" as const,
        {
          label: "大纲",
          shortcut: shortcut("⇧⌘O"),
          onClick: () =>
            useUiStore.setState((s) => ({ outlineOpen: !s.outlineOpen })),
        },
        {
          label: "反向链接",
          shortcut: shortcut("⇧⌘B"),
          onClick: () =>
            useUiStore.setState((s) => ({ backlinksOpen: !s.backlinksOpen })),
        },
        {
          label: "标签",
          shortcut: shortcut("⇧⌘G"),
          onClick: () =>
            useUiStore.setState((s) => ({ tagsOpen: !s.tagsOpen })),
        },
        {
          label: "元数据",
          shortcut: shortcut("⇧⌘M"),
          onClick: () =>
            useUiStore.setState((s) => ({
              frontmatterPanelOpen: !s.frontmatterPanelOpen,
            })),
        },
        {
          label: "待办事项",
          shortcut: shortcut("⇧⌘D"),
          onClick: () =>
            useUiStore.setState((s) => ({
              todoPanelOpen: !s.todoPanelOpen,
            })),
        },
        "separator" as const,
        {
          label: "放大",
          onClick: () =>
            useUiStore.setState((s) => ({
              zoomLevel: Math.min(s.zoomLevel + 1, 5),
            })),
        },
        {
          label: "缩小",
          onClick: () =>
            useUiStore.setState((s) => ({
              zoomLevel: Math.max(s.zoomLevel - 1, -3),
            })),
        },
        {
          label: "重置缩放",
          onClick: () => useUiStore.setState({ zoomLevel: 0 }),
        },
        "separator" as const,
        {
          label: "暗色模式",
          onClick: () =>
            setTheme((t: string) => (t === "dark" ? "light" : "dark")),
        },
      ],
    },
    {
      label: "同步",
      items: [
        {
          label: "立即同步",
          onClick: () => useAppStore.getState().syncNow(),
        },
        {
          label: "提交所有更改",
          onClick: () => {
            const dir = useAppStore.getState().notesDir;
            if (dir)
              api
                .gitCommitAll(dir, "chore: manual commit")
                .then((committed) => {
                  if (committed) {
                    toast("已提交所有更改");
                    useFileStore.getState().refreshTree(dir);
                  }
                })
                .catch((e) => toast(`提交失败：${e}`));
          },
        },
        {
          label: "同步设置...",
          onClick: () => useUiStore.setState({ settingsOpen: true }),
        },
      ],
    },
    {
      label: "帮助",
      items: [
        {
          label: "用户协议",
          onClick: () => {
            api.getResourcePath("用户协议.md")
              .then(async (path) => {
                await useTabStore.getState().openFileByPath(path);
                useTabStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.path === path ? { ...t, readOnly: true } : t,
                  ),
                }));
              })
              .catch((e) => toast(`无法打开用户协议：${e}`));
          },
        },
        {
          label: "隐私政策",
          onClick: () => {
            api.getResourcePath("隐私政策.md")
              .then(async (path) => {
                await useTabStore.getState().openFileByPath(path);
                useTabStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.path === path ? { ...t, readOnly: true } : t,
                  ),
                }));
              })
              .catch((e) => toast(`无法打开隐私政策：${e}`));
          },
        },
        "separator" as const,
        {
          label: "MCP 配置指南",
          onClick: () => {
            api.getResourcePath("MCP 配置指南.md")
              .then(async (path) => {
                await useTabStore.getState().openFileByPath(path);
                useTabStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.path === path ? { ...t, readOnly: true } : t,
                  ),
                }));
              })
              .catch((e) => toast(`无法打开 MCP 配置指南：${e}`));
          },
        },
        "separator" as const,
        {
          label: "关于 即记 (Jot)",
          onClick: () => useUiStore.setState({ aboutOpen: true }),
        },
      ],
    },
  ];
}
