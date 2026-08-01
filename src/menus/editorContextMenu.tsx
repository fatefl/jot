// src/menus/editorContextMenu.tsx
// 编辑器右键菜单：根据上下文（图片/表格/普通文本）显示不同的操作菜单
import type React from "react";
import type { MenuEntry } from "@/components/ui/context-menu";
import {
  AlignLeft, Braces, Check, CheckSquare, Copy, Download, FolderOpen, Heading1,
  Heading2, Heading3, Image, List, ListOrdered,
  Minus, Network, Pen, Plus, Quote, Sigma, Table, Trash2, ZoomIn,
} from "lucide-react";
import { api } from "@/lib/tauri";
import { relativePath } from "@/lib/utils";
import { shortcut } from "@/lib/platform";
import { useAppStore } from "@/stores/appStore";
import { useEditorStore } from "@/stores/editorStore";
import { useUiStore } from "@/stores/uiStore";
import type { EditorPanelHandle } from "@/components/Editor";

const SCALE_PRESETS = [25, 50, 75, 100, 150, 200];

export function buildEditorContextMenu(
  e: React.MouseEvent,
  editorRef: React.RefObject<EditorPanelHandle>,
  toast: (msg: string) => void,
): MenuEntry[] {
  const ed = editorRef.current;

  // 检测右键位置：图片 / 表格 / 公式 / mermaid / 普通文本
  const target = e.target as HTMLElement;
  const isInTable = target?.closest?.(".lp-table-wrapper") != null;
  // 单元格编辑中的 textarea 选区不在 window.getSelection() 里，需单独判断
  const cellInput = target?.closest?.(".lp-cell-input") as HTMLTextAreaElement | null;
  const hasSelection =
    !window.getSelection()?.isCollapsed ||
    (cellInput != null && cellInput.selectionStart !== cellInput.selectionEnd);
  const imgWrap = target?.closest?.(".lp-image-wrap") as HTMLElement | null;
  const isOnImage = imgWrap != null;
  const imgPath = imgWrap?.getAttribute("data-img-path") ?? "";
  const imgFrom = parseInt(imgWrap?.getAttribute("data-img-from") ?? "0", 10);
  const imgTo = parseInt(imgWrap?.getAttribute("data-img-to") ?? "0", 10);
  const imgScale = imgWrap?.getAttribute("data-img-scale");
  const currentScale = imgScale ? parseInt(imgScale, 10) : null;

  // 数学公式检测
  const mathWrap = (target?.closest?.(".lp-math-inline") ?? target?.closest?.(".lp-math-block")) as HTMLElement | null;
  const isOnMath = mathWrap != null;
  const mathFrom = parseInt(mathWrap?.getAttribute("data-math-from") ?? "0", 10);
  const mathTo = parseInt(mathWrap?.getAttribute("data-math-to") ?? "0", 10);
  const mathFormula = mathWrap?.getAttribute("data-math-formula") ?? "";

  // Mermaid 图表检测
  const mermaidWrap = target?.closest?.(".lp-mermaid") as HTMLElement | null;
  const isOnMermaid = mermaidWrap != null;
  const mermaidFrom = parseInt(mermaidWrap?.getAttribute("data-mermaid-from") ?? "0", 10);
  const mermaidTo = parseInt(mermaidWrap?.getAttribute("data-mermaid-to") ?? "0", 10);
  const mermaidCode = mermaidWrap?.getAttribute("data-mermaid-code") ?? "";

  // 基础编辑（剪切/复制按惯例在无选中时置灰而不是隐藏）
  const basicEntries: MenuEntry[] = [
    { label: "剪切", disabled: !hasSelection, onClick: () => document.execCommand("cut") },
    { label: "复制", disabled: !hasSelection, onClick: () => document.execCommand("copy") },
    {
      label: "粘贴",
      onClick: () => {
        navigator.clipboard
          .readText()
          .then((text) => text && document.execCommand("insertText", false, text))
          .catch(() => toast("读取剪贴板失败"));
      },
    },
  ];

  // 数学公式专用菜单：编辑 → 复制 → 导出，删除垫底
  if (isOnMath) {
    return [
      {
        label: "编辑公式",
        icon: <Pen size={14} />,
        onClick: () => ed?.editMathFormula(mathWrap!),
      },
      {
        label: "复制公式",
        icon: <Copy size={14} />,
        onClick: () => {
          navigator.clipboard
            .writeText(mathFormula)
            .catch(() => toast("复制失败"));
        },
      },
      {
        label: "另存为 PNG",
        icon: <Download size={14} />,
        onClick: () => ed?.saveMathAsPng(mathWrap!),
      },
      "separator",
      {
        label: "删除公式",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => ed?.deleteMathFormula(mathFrom, mathTo),
      },
    ];
  }

  // Mermaid 图表专用菜单：编辑 → 复制 → 导出，删除垫底
  if (isOnMermaid) {
    return [
      {
        label: "编辑图表",
        icon: <Pen size={14} />,
        onClick: () => ed?.editMermaid(mermaidFrom, mermaidTo),
      },
      {
        label: "复制源码",
        icon: <Copy size={14} />,
        onClick: () => navigator.clipboard.writeText(mermaidCode).catch(() => toast("复制失败")),
      },
      {
        label: "另存为 PNG",
        icon: <Download size={14} />,
        onClick: () => ed?.saveMermaidAsPng(mermaidWrap!),
      },
      "separator",
      {
        label: "删除图表",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => ed?.deleteMermaid(mermaidFrom, mermaidTo),
      },
    ];
  }

  // 图片专用菜单：图片操作 → 基础编辑 → 删除垫底
  if (isOnImage) {
    const activeScale = currentScale ?? 100;
    return [
      {
        label: "复制图片",
        icon: <Copy size={14} />,
        onClick: () => ed?.copyImage(imgPath),
      },
      {
        label: "在文件夹中显示",
        icon: <FolderOpen size={14} />,
        onClick: () => ed?.revealImage(imgPath),
      },
      "separator",
      {
        label: "缩放图片",
        icon: <ZoomIn size={14} />,
        onClick: () => {},
        children: [
          ...SCALE_PRESETS.map((pct) => ({
            label: pct === 100 ? "100%（原始大小）" : `${pct}%`,
            icon: activeScale === pct
              ? <Check size={14} />
              : <span className="inline-block w-[14px]" />,
            onClick: () => ed?.resizeImage(imgFrom, imgTo, pct),
          })),
          "separator" as const,
          {
            label: "自定义...",
            icon: <span className="inline-block w-[14px]" />,
            onClick: () => {
              const input = window.prompt(
                "输入缩放百分比（如 80）",
                currentScale != null ? String(currentScale) : "100",
              );
              if (input == null) return;
              const pct = parseInt(input, 10);
              if (isNaN(pct) || pct < 1 || pct > 999) return;
              ed?.resizeImage(imgFrom, imgTo, pct);
            },
          },
        ],
      },
      "separator",
      ...basicEntries,
      "separator",
      {
        label: "删除图片",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => ed?.deleteImage(imgFrom, imgTo),
      },
    ];
  }

  // 表格专用菜单：表格操作 → 基础编辑 → 删除表格垫底
  // （表格是渲染 widget，通用文本格式化项在此处无意义，故不显示）
  if (isInTable) {
    return [
      { label: "在上方插入行", onClick: () => ed?.insertRowAbove() },
      { label: "在下方插入行", onClick: () => ed?.insertRowBelow() },
      { label: "删除当前行", onClick: () => ed?.deleteRow() },
      "separator",
      { label: "在左侧插入列", onClick: () => ed?.insertColumnLeft() },
      { label: "在右侧插入列", onClick: () => ed?.insertColumnRight() },
      { label: "删除当前列", onClick: () => ed?.deleteColumn() },
      "separator",
      {
        label: "列对齐",
        icon: <AlignLeft size={14} />,
        onClick: () => {},
        children: [
          { label: "左对齐", onClick: () => ed?.setColumnAlign("left") },
          { label: "居中", onClick: () => ed?.setColumnAlign("center") },
          { label: "右对齐", onClick: () => ed?.setColumnAlign("right") },
        ],
      },
      "separator",
      ...basicEntries,
      "separator",
      {
        label: "删除表格",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => ed?.deleteTable(),
      },
    ];
  }

  return [
    ...basicEntries,
    "separator",
    { label: `加粗 ${shortcut("⌘B")}`, onClick: () => ed?.toggleMark("**") },
    { label: `斜体 ${shortcut("⌘I")}`, onClick: () => ed?.toggleMark("*") },
    { label: "删除线", onClick: () => ed?.toggleMark("~~") },
    { label: `行内代码 ${shortcut("⌘E")}`, onClick: () => ed?.toggleMark("`") },
    { label: `链接 ${shortcut("⌘K")}`, onClick: () => ed?.toggleLink() },
    // 依赖选中文本的功能项：无选中时直接隐藏
    ...(hasSelection
      ? [
          {
            label: "包裹为公式",
            icon: <Sigma size={14} />,
            onClick: () => {},
            children: [
              { label: "行内公式 ($)", onClick: () => ed?.wrapAsMath(false) },
              { label: "块级公式 ($$)", onClick: () => ed?.wrapAsMath(true) },
            ],
          },
        ]
      : []),
    "separator",
    {
      label: "标题",
      icon: <Heading1 size={14} />,
      onClick: () => {},
      children: [
        { label: "一级标题", icon: <Heading1 size={14} />, onClick: () => ed?.toggleHeading(1) },
        { label: "二级标题", icon: <Heading2 size={14} />, onClick: () => ed?.toggleHeading(2) },
        { label: "三级标题", icon: <Heading3 size={14} />, onClick: () => ed?.toggleHeading(3) },
      ],
    },
    {
      label: "列表",
      icon: <List size={14} />,
      onClick: () => {},
      children: [
        { label: "无序列表", icon: <List size={14} />, onClick: () => ed?.toggleBulletList() },
        { label: "有序列表", icon: <ListOrdered size={14} />, onClick: () => ed?.toggleOrderedList() },
        { label: "任务列表", icon: <CheckSquare size={14} />, onClick: () => ed?.toggleTaskList() },
      ],
    },
    { label: "引用", icon: <Quote size={14} />, onClick: () => ed?.toggleBlockquote() },
    { label: "代码块", icon: <Braces size={14} />, onClick: () => ed?.toggleCodeBlock() },
    "separator",
    {
      label: "插入",
      icon: <Plus size={14} />,
      onClick: () => {},
      children: [
        {
          label: "表格",
          icon: <Table size={14} />,
          onClick: () => ed?.insertTable(),
        },
        {
          label: "图片",
          icon: <Image size={14} />,
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
                ed?.insertImage(rel);
              } catch (err) { toast(`插入图片失败：${err}`); }
            };
            input.click();
          },
        },
        {
          label: "Mermaid 图表",
          icon: <Network size={14} />,
          onClick: () => ed?.insertMermaid(),
        },
        {
          label: "公式",
          icon: <Sigma size={14} />,
          onClick: () => {},
          children: [
            { label: "行内公式 ($)", onClick: () => ed?.insertMath(false) },
            { label: "块级公式 ($$)", onClick: () => ed?.insertMath(true) },
          ],
        },
        {
          label: "代码块",
          icon: <Braces size={14} />,
          onClick: () => ed?.toggleCodeBlock(),
        },
        {
          label: "分割线",
          icon: <Minus size={14} />,
          onClick: () => ed?.insertMarkdown("\n---\n"),
        },
        "separator" as const,
        {
          label: "😀 表情符号...",
          onClick: () => useUiStore.setState({ emojiOpen: true }),
        },
      ],
    },
  ];
}
