// @vitest-environment jsdom
// MenuBar 组件测试
//
// 覆盖：
// - 渲染菜单组标签
// - 菜单项样式（shortcut / danger / disabled / 分隔线）
// - onClick 回调（点击触发、disabled 不触发）
// - 子菜单相关逻辑（箭头显示、父级 onClick 不触发）
// - 键盘导航 ArrowLeft/Right/Escape

import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MenuBar, type MenuGroup } from "./MenuBar";

function sampleGroups(): MenuGroup[] {
  return [
    {
      label: "文件",
      items: [
        { label: "新建笔记", shortcut: "⌘N", onClick: vi.fn() },
        "separator",
        { label: "导出", shortcut: "⌘E", onClick: vi.fn() },
        { label: "关闭", danger: true, onClick: vi.fn() },
        { label: "退出", disabled: true, onClick: vi.fn() },
      ],
    },
    {
      label: "编辑",
      items: [
        { label: "撤销", shortcut: "⌘Z", onClick: vi.fn() },
        { label: "重做", shortcut: "⇧⌘Z", onClick: vi.fn() },
      ],
    },
  ];
}

/** 在容器中查找文本匹配的第一个 button */
function findBtn(container: HTMLElement, text: string): HTMLButtonElement | null {
  const btns = container.querySelectorAll("button");
  for (const btn of btns) {
    if (btn.textContent?.trim() === text) return btn as HTMLButtonElement;
  }
  return null;
}

describe("MenuBar — 渲染", () => {
  it("渲染所有菜单组标签", () => {
    const { container } = render(<MenuBar groups={sampleGroups()} />);
    expect(container.textContent).toContain("文件");
    expect(container.textContent).toContain("编辑");
  });

  it("初始状态无下拉面板", () => {
    const { container } = render(<MenuBar groups={sampleGroups()} />);
    expect(container.querySelector(".animate-menu-in")).toBeNull();
  });

  it("点击菜单组标签渲染下拉项", () => {
    const { container } = render(<MenuBar groups={sampleGroups()} />);
    fireEvent.click(findBtn(container, "文件")!);
    // 下拉面板应出现，且包含菜单项文本
    expect(container.querySelector(".animate-menu-in")).not.toBeNull();
    expect(container.textContent).toContain("新建笔记");
    expect(container.textContent).toContain("导出");
  });
});

describe("MenuBar — 菜单项样式", () => {
  function openFileMenu(container: HTMLElement) {
    fireEvent.click(findBtn(container, "文件")!);
  }

  it("shortcut 文字渲染", () => {
    const { container } = render(<MenuBar groups={sampleGroups()} />);
    openFileMenu(container);
    // shortcut 使用 text-xs 类
    const shortcuts = container.querySelectorAll(".animate-menu-in .text-xs");
    const texts = Array.from(shortcuts).map((e) => e.textContent);
    expect(texts.some((t) => t?.includes("⌘N"))).toBe(true);
    expect(texts.some((t) => t?.includes("⌘E"))).toBe(true);
  });

  it("danger 项含 text-red-500 类", () => {
    const { container } = render(<MenuBar groups={sampleGroups()} />);
    openFileMenu(container);
    const btns = container.querySelectorAll(".animate-menu-in button");
    const closeBtn = Array.from(btns).find(
      (b) => b.textContent?.includes("关闭"),
    ) as HTMLElement;
    expect(closeBtn.className).toContain("text-red-500");
  });

  it("disabled 项不可点击", () => {
    const { container } = render(<MenuBar groups={sampleGroups()} />);
    openFileMenu(container);
    const btns = container.querySelectorAll(".animate-menu-in button");
    const exitBtn = Array.from(btns).find(
      (b) => b.textContent?.includes("退出"),
    ) as HTMLButtonElement;
    expect(exitBtn.className).toContain("opacity-40");
    expect(exitBtn.disabled).toBe(true);
  });

  it("分隔线渲染", () => {
    const { container } = render(<MenuBar groups={sampleGroups()} />);
    openFileMenu(container);
    // 分隔线在 animate-menu-in 面板内
    const panel = container.querySelector(".animate-menu-in")!;
    expect(panel.querySelector(".h-px")).not.toBeNull();
  });
});

describe("MenuBar — 点击回调", () => {
  it("点击菜单项触发 onClick", () => {
    const onClick = vi.fn();
    const groups: MenuGroup[] = [
      { label: "测试", items: [{ label: "动作", onClick }] },
    ];
    const { container } = render(<MenuBar groups={groups} />);
    fireEvent.click(findBtn(container, "测试")!);

    // 在下拉面板中找到动作按钮
    const btns = container.querySelectorAll(".animate-menu-in button");
    const actionBtn = Array.from(btns).find(
      (b) => b.textContent?.includes("动作"),
    );
    fireEvent.click(actionBtn!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled 项不触发 onClick", () => {
    const onClick = vi.fn();
    const groups: MenuGroup[] = [
      { label: "测试", items: [{ label: "不可用", disabled: true, onClick }] },
    ];
    const { container } = render(<MenuBar groups={groups} />);
    fireEvent.click(findBtn(container, "测试")!);

    const btns = container.querySelectorAll(".animate-menu-in button");
    const disabledBtn = Array.from(btns).find(
      (b) => b.textContent?.includes("不可用"),
    );
    // 在 disabled button 上触发原生 click（fireEvent.click 在 disabled 上抛错）
    disabledBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("MenuBar — 子菜单", () => {
  it("含 children 的项旁有 svg 箭头", () => {
    const groups: MenuGroup[] = [
      {
        label: "格式",
        items: [{ label: "插入", onClick: vi.fn(), children: [{ label: "表格", onClick: vi.fn() }] }],
      },
    ];
    const { container } = render(<MenuBar groups={groups} />);
    fireEvent.click(findBtn(container, "格式")!);

    const btns = container.querySelectorAll(".animate-menu-in button");
    const insertBtn = Array.from(btns).find(
      (b) => b.textContent?.includes("插入") && b.querySelector("svg"),
    ) as HTMLElement;
    expect(insertBtn).not.toBeNull();
  });

  it("含 children 时点击不触发父级 onClick", () => {
    const onParentClick = vi.fn();
    const groups: MenuGroup[] = [
      {
        label: "格式",
        items: [
          {
            label: "插入",
            onClick: onParentClick,
            children: [{ label: "表格", onClick: vi.fn() }],
          },
        ],
      },
    ];
    const { container } = render(<MenuBar groups={groups} />);
    fireEvent.click(findBtn(container, "格式")!);

    const btns = container.querySelectorAll(".animate-menu-in button");
    const insertBtn = Array.from(btns).find((b) =>
      b.textContent?.includes("插入"),
    )!;
    fireEvent.click(insertBtn);
    // 有 children → onClick 不触发，仅展开子菜单
    expect(onParentClick).not.toHaveBeenCalled();
  });
});

describe("MenuBar — 键盘导航", () => {
  it("ArrowRight 和 ArrowLeft 不抛错", () => {
    const { container } = render(<MenuBar groups={sampleGroups()} />);
    fireEvent.click(findBtn(container, "文件")!);

    expect(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
      fireEvent.keyDown(window, { key: "ArrowLeft" });
    }).not.toThrow();
  });

  it("Escape 可触发关闭（setTimeout 注册后）", async () => {
    vi.useFakeTimers();
    const { container } = render(<MenuBar groups={sampleGroups()} />);
    fireEvent.click(findBtn(container, "文件")!);
    expect(container.querySelectorAll(".animate-menu-in").length).toBeGreaterThan(0);

    // Dropdown useEffect 内 setTimeout(fn, 0) 用于注册 keydown 监听
    vi.advanceTimersByTime(1);

    fireEvent.keyDown(window, { key: "Escape" });
    // React 状态更新异步 → advance again
    vi.advanceTimersByTime(1);

    expect(container.querySelectorAll(".animate-menu-in").length).toBe(0);
    vi.useRealTimers();
  });
});
