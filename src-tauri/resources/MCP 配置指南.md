# Jot MCP Server 配置指南

`jot-mcp` 是一个 MCP Server，让 AI 工具（Claude、Cursor 等）可以搜索、读取和编辑你的 Markdown 笔记。它**随 Jot 安装包一同安装**，无需单独下载；只能访问你指定的笔记目录，不会发起任何网络请求。

## 一键获取配置（推荐）

菜单栏 → **帮助 → 复制 MCP 配置**：自动生成包含 jot-mcp 安装路径和你当前笔记目录的 JSON 并复制到剪贴板。粘贴到 AI 客户端的 MCP 配置文件中即可：

| 客户端 | 配置文件 |
|--------|---------|
| Claude Code | `~/.claude/mcp.json` |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`；Linux `~/.config/Claude/`；Windows `%APPDATA%\Claude\` |
| Cursor | `~/.cursor/mcp.json` |
| 其他（Cline、Trae、Cherry Studio 等） | 设置中找到 MCP → 手动配置 JSON |

粘贴后形如：

```json
{
  "mcpServers": {
    "jot": {
      "command": "/usr/bin/jot-mcp",
      "args": ["--data-dir", "/path/to/notes"]
    }
  }
}
```

修改配置后重启客户端生效。

## 可用工具

搜索（`search_notes`）、目录树（`list_directory`）、读取（`read_note`）、追加（`append_note`）、覆盖写入（`write_note`）、重命名（`rename_note`）、移动（`move_note`）、建目录（`create_directory`）、反向链接（`list_backlinks`）、标签（`list_tags`）、删除（`delete_note`，**不可恢复**）。

配置后可直接用自然语言测试，如"列出我的笔记目录"、"搜索包含 MCP 的笔记"。

## 故障排查

- **提示"请先打开笔记目录"** → 先在 Jot 中打开你的笔记文件夹，再点"复制 MCP 配置"
- **客户端连接失败** → 把复制的 JSON 中 `command` 的路径拿到终端手动验证：
  `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | <command路径> --data-dir <笔记目录>`，正常会输出工具列表 JSON

## 开发者：从源码构建

开发模式下需在 Jot 源码目录执行一次 `bash scripts/prepare-sidecar.sh`（构建 jot-mcp 并放入 `src-tauri/binaries/`，否则 `tauri dev` 会因缺少 sidecar 报错）。"复制 MCP 配置"会自动使用开发构建的二进制。
