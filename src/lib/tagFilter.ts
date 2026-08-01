import type { TreeNode } from "@/lib/tauri";

/**
 * 按文件绝对路径集合过滤目录树（标签筛选用）。
 * - 文件节点：路径命中集合才保留
 * - 目录节点：递归过滤子节点后，若仍含至少一个保留节点则保留（保留目录层级，
 *   让用户仍能沿文件夹结构定位匹配的笔记）
 *
 * 返回新的树结构（目录节点被浅拷贝 + 替换 children），未命中的文件节点直接丢弃，
 * 命中的文件节点复用原对象引用。
 */
export function filterTreeByPaths(
  nodes: TreeNode[],
  keepPaths: ReadonlySet<string>,
): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (node.isDir) {
      const children = filterTreeByPaths(node.children, keepPaths);
      if (children.length > 0) {
        out.push({ ...node, children });
      }
    } else if (keepPaths.has(node.path)) {
      out.push(node);
    }
  }
  return out;
}
