// src/lib/editorViewCache.test.ts
// @vitest-environment jsdom
// 单视图 EditorState 缓存：swap 恢复零重建、撤销栈/选区保留、滚动还原、失效
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import {
  bindEditorView,
  unbindEditorView,
  swapEditorState,
  dropViewState,
  dropViewStatesForPath,
  remapViewStatesForRename,
  stashLiveState,
  setActiveEditFinalizer,
  __resetEditorViewCache,
} from "./editorViewCache";

function createState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [history()] });
}

let view: EditorView;

beforeEach(() => {
  __resetEditorViewCache();
  setActiveEditFinalizer(null);
  document.body.innerHTML = "";
  view = new EditorView({ state: createState("# A"), parent: document.body });
  bindEditorView(view, "notes/a.md", createState);
});

afterEach(() => {
  // jsdom 无布局：销毁视图取消挂起的 rAF measure，避免测试结束后抛未捕获异常
  view.destroy();
  document.body.innerHTML = "";
});

describe("editorViewCache", () => {
  it("swap 到缓存路径：内容/撤销栈恢复，且未新建状态（零重建）", () => {
    // 在 a 中编辑（留下撤销历史）
    view.dispatch({ changes: { from: view.state.doc.length, insert: " modified" } });
    expect(view.state.doc.toString()).toBe("# A modified");

    // 切到 b（新建状态），a 的状态被缓存
    expect(swapEditorState("notes/b.md", "# B", true)).toBe(true);
    expect(view.state.doc.toString()).toBe("# B");

    // 切回 a：缓存命中——文档与撤销栈一并恢复
    expect(swapEditorState("notes/a.md", "# A modified", true)).toBe(true);
    expect(view.state.doc.toString()).toBe("# A modified");
    undo(view); // 撤销栈来自缓存的 EditorState：可撤回到 "# A"
    expect(view.state.doc.toString()).toBe("# A");
  });

  it("swap 恢复选区与滚动位置", () => {
    view.dispatch({ selection: { anchor: 2 } });
    view.scrollDOM.scrollTop = 123;
    swapEditorState("notes/b.md", "# B", true);
    expect(view.state.selection.main.head).toBe(0); // 新建状态选区在 0

    swapEditorState("notes/a.md", "# A", true);
    expect(view.state.selection.main.head).toBe(2);
    expect(view.scrollDOM.scrollTop).toBe(123);
  });

  it("preferCache=false：丢弃该路径缓存，强制用传入内容新建", () => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: " dirty" } });
    stashLiveState();
    // 磁盘重新加载（外部修改）：即使刚缓存了 "dirty"，也必须用磁盘内容
    swapEditorState("notes/a.md", "# A external", false);
    expect(view.state.doc.toString()).toBe("# A external");
  });

  it("未命中缓存时用 createState 新建；live.path 随 swap 更新", () => {
    swapEditorState("notes/b.md", "# B", true);
    expect(view.state.doc.toString()).toBe("# B");
    // 再切到未访问过的 c：同样新建
    swapEditorState("notes/c.md", "# C", true);
    expect(view.state.doc.toString()).toBe("# C");
    // 此时 a/b 都在缓存中，切回 b 命中
    swapEditorState("notes/b.md", "# B", true);
    expect(view.state.doc.toString()).toBe("# B");
  });

  it("无活动视图时 swap 返回 false（走纯 store 路径）", () => {
    unbindEditorView(view);
    expect(swapEditorState("notes/x.md", "x", true)).toBe(false);
  });

  it("swap 前调用 activeEditFinalizer，且收尾结果被缓存（兜底防裸状态入缓存）", () => {
    // 模拟公式编辑收尾：幂等地把裸文档重新包裹回 $$ 定界符。
    // 兜底场景：某路径绕过 saveCurrent 直接 swap，也不能把裸状态缓存下来。
    setActiveEditFinalizer(() => {
      if (!view.state.doc.toString().endsWith("$$")) {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "$$" } });
      }
    });

    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } }); // a = "# Ax"
    expect(view.state.doc.toString()).toBe("# Ax");

    swapEditorState("notes/b.md", "# B", true); // a 入缓存（应含收尾后的 $$）
    swapEditorState("notes/a.md", "# A", true); // 命中缓存

    expect(view.state.doc.toString()).toBe("# Ax$$");
    setActiveEditFinalizer(null);
  });

  it("dropViewState / 目录级丢弃 / 重命名迁移", () => {
    swapEditorState("notes/b.md", "# B", true); // a 入缓存
    swapEditorState("notes/dir/c.md", "# C", true); // b 入缓存
    swapEditorState("notes/d.md", "# D", true); // dir/c 入缓存

    // 目录删除：dir/c 被丢弃，a/b 保留
    dropViewStatesForPath("notes/dir", true);
    swapEditorState("notes/dir/c.md", "# C new", true);
    expect(view.state.doc.toString()).toBe("# C new"); // 未命中 → 用传入内容

    // 重命名迁移：a → renamed/a.md，缓存状态保留
    remapViewStatesForRename("notes/a.md", "renamed/a.md", false);
    swapEditorState("renamed/a.md", "ignored", true);
    expect(view.state.doc.toString()).toBe("# A"); // 命中缓存而非传入内容

    // 单路径丢弃
    swapEditorState("notes/d.md", "# D", true);
    dropViewState("notes/b.md");
    swapEditorState("notes/b.md", "# B fresh", true);
    expect(view.state.doc.toString()).toBe("# B fresh");
  });
});
