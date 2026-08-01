// src/stores/__testutils__/fixtures.ts
import type { TreeNode } from "@/lib/tauri";

/** 标准测试目录树 */
export const standardTree: TreeNode[] = [
  {
    name: "notes",
    path: "notes",
    isDir: true,
    children: [
      {
        name: "a.md",
        path: "notes/a.md",
        isDir: false,
        children: [],
      },
      {
        name: "b.md",
        path: "notes/b.md",
        isDir: false,
        children: [],
      },
      {
        name: "sub",
        path: "notes/sub",
        isDir: true,
        children: [
          {
            name: "c.md",
            path: "notes/sub/c.md",
            isDir: false,
            children: [],
          },
        ],
      },
    ],
  },
];

/** 标准文件内容 */
export const standardContents: Record<string, string> = {
  "notes/a.md": "# Note A\n\nContent of note A.",
  "notes/b.md": "# Note B\n\nContent of note B.",
  "notes/sub/c.md": "# Note C\n\nContent of note C.",
};

/** 空配置 */
export const emptyConfig = {
  dataDir: "",
  remoteUrl: "",
  authType: "",
  username: "",
  token: "",
  reuseTab: false,
};
