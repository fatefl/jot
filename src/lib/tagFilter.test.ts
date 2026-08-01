import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/lib/tauri";
import { filterTreeByPaths } from "./tagFilter";

function file(name: string, path: string): TreeNode {
  return { name, path, isDir: false, children: [] };
}
function dir(name: string, path: string, children: TreeNode[]): TreeNode {
  return { name, path, isDir: true, children };
}

describe("filterTreeByPaths", () => {
  it("只保留路径命中的文件", () => {
    const tree = [
      file("a.md", "/notes/a.md"),
      file("b.md", "/notes/b.md"),
    ];
    const out = filterTreeByPaths(tree, new Set(["/notes/a.md"]));
    expect(out.map((n) => n.path)).toEqual(["/notes/a.md"]);
  });

  it("目录仅在包含命中文件时保留，且保留目录层级", () => {
    const tree = [
      dir("work", "/notes/work", [
        file("keep.md", "/notes/work/keep.md"),
        file("drop.md", "/notes/work/drop.md"),
      ]),
      dir("empty-hit", "/notes/empty-hit", [file("x.md", "/notes/empty-hit/x.md")]),
    ];
    const out = filterTreeByPaths(tree, new Set(["/notes/work/keep.md"]));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("work");
    expect(out[0].children.map((n) => n.path)).toEqual(["/notes/work/keep.md"]);
  });

  it("递归嵌套目录：命中深层文件时逐级保留祖先目录", () => {
    const tree = [
      dir("top", "/notes/top", [
        dir("sub", "/notes/top/sub", [
          file("deep.md", "/notes/top/sub/deep.md"),
          file("other.md", "/notes/top/sub/other.md"),
        ]),
      ]),
    ];
    const out = filterTreeByPaths(tree, new Set(["/notes/top/sub/deep.md"]));
    expect(out[0].name).toBe("top");
    expect(out[0].children[0].name).toBe("sub");
    expect(out[0].children[0].children.map((n) => n.path)).toEqual([
      "/notes/top/sub/deep.md",
    ]);
  });

  it("空集合 → 空结果", () => {
    const tree = [dir("/notes", "a", [file("x.md", "/notes/a/x.md")])];
    expect(filterTreeByPaths(tree, new Set())).toEqual([]);
  });

  it("不修改原树：目录节点浅拷贝，未命中文件被丢弃", () => {
    const keep = file("keep.md", "/notes/keep.md");
    const tree = [
      keep,
      file("drop.md", "/notes/drop.md"),
      dir("d", "/notes/d", [file("y.md", "/notes/d/y.md")]),
    ];
    const out = filterTreeByPaths(tree, new Set(["/notes/keep.md"]));
    expect(out[0]).toBe(keep); // 命中文件复用原引用
    expect(out).toHaveLength(1);
    expect(tree).toHaveLength(3); // 原树不受影响
    expect(tree[2].children).toHaveLength(1);
  });
});
