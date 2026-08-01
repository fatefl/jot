# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作提供指引。

## 构建与测试

```bash
pnpm dev              # Vite 开发服务器（端口 1420）—— 仅前端，不含 Tauri
pnpm tauri dev        # 完整 Tauri 桌面应用（启动 Vite + Rust 后端）
pnpm build            # TypeScript 类型检查 + Vite 生产构建
pnpm test             # 运行 vitest（全部测试）
pnpm test -- --run <pattern>  # vitest 按模式过滤单测
pnpm tauri build      # 生产环境桌面打包
```

Tauri 开发服务器要求 Vite 运行在 1420 端口（`vite.config.ts` 和 `tauri.conf.json` 中配置）。使用 `pnpm tauri dev` 同时启动两者。

注意：`tauri.conf.json` 通过 `bundle.externalBin` 把 `jot-mcp` 作为 sidecar 打包，要求 `src-tauri/binaries/jot-mcp-<target-triple>` 存在（已 gitignore）。新克隆仓库后先执行一次 `bash scripts/prepare-sidecar.sh`，否则 `pnpm tauri dev` / `pnpm tauri build` 会报 sidecar 不存在。

## 架构

**即记 (Jot)** 是一款基于 git 同步的桌面 Markdown 笔记应用（Tauri 2 + React + CodeMirror 6），直接操作真实文件系统中的文件。工作方式类似 VS Code 或 IDEA——没有数据库，没有导入/导出步骤；笔记就是磁盘上按真实目录组织的 `.md` 文件。

### 双层架构

1. **Rust 后端** (`src-tauri/src/lib.rs`)：所有文件系统 I/O 和 git 操作在此执行，通过 Tauri command 调用。Git 通过系统 `git` CLI 驱动（30 秒超时，结构化错误分类，stdout/stderr 由专门线程排空防管道阻塞）。HTTPS token 认证经 `GIT_CONFIG_*` 环境变量按 host 限域注入 `Authorization: Basic` 请求头（绝不嵌入 remote URL，也不出现在命令行参数中）；`git@`/`ssh://` 远程走系统 ssh，不校验 token。Token 存储在 OS keyring 中，不可用时降级到 `~/.config/notes/config.toml`（权限 0600）；保存同步配置时空 token 表示"保留现有凭据"。`git_sync` 有全局互斥拒重入，commit/sync 前自动清理过期 `index.lock`。

2. **React 前端** (`src/App.tsx`)：单页应用，侧边栏目录树 + 标签栏 + 编辑器面板 + 状态栏。状态管理使用 **Zustand**（5 个 store：`appStore`、`editorStore`、`fileStore`、`tabStore`、`uiStore`），通过 `src/stores/` 中的 `create()` 定义。自定义 hook（`src/hooks/`）编排副作用；菜单事件通过 `src/menus/` 分发。应用启动 → 从 Rust 读取配置 → 显示引导向导或进入工作区。

### 编辑器：CodeMirror 6 + 自定义即时渲染

编辑器使用 **CodeMirror 6**（不再是 Milkdown——Milkdown 仍然在 `package.json` 中，但 `Editor.tsx` 中实际编辑器通过 `@uiw/react-codemirror` 直接使用 CodeMirror）。

两种模式：
- **所见即所得** (`lp-mode`)：`src/lib/livePreview.ts` 中的自定义装饰器隐藏 markdown 语法标记，渲染对应的视觉效果（粗体、标题、代码块、表格、图片、复选框等）。Markdown 源码是唯一事实源——装饰器是只读的视觉覆盖层；光标进入装饰节点**不会**还原源码。切换至源码模式才能编辑原始 markdown。
- **源码模式**：纯 CodeMirror 配 markdown 语法高亮（无装饰器）。

核心编辑器文件：
- `src/components/Editor.tsx` — EditorPanel 组件，组装所有扩展
- `src/lib/livePreview.ts` — ViewPlugin + StateField，从 Lezer 语法树构建 `DecorationSet`。表格使用 `StateField`（CM6 规定 ViewPlugin 不能提供 block decoration）。图片渲染为真实 `<img>` 元素，点击可用系统程序打开。
- `src/lib/editorKeymap.ts` — 键盘快捷键（Cmd+B/I/E/K 对应加粗/斜体/行内代码/链接）以及块级格式切换函数（标题、列表、引用、代码块）。通过 `Prec.high` keymap 导出以覆盖 basicSetup 默认行为。
- `src/lib/linkActions.ts` — 链接交互：Cmd/Ctrl+点击打开链接（http(s) 走系统浏览器、相对 .md 在应用内打开、其他本地文件走系统默认程序），普通点击弹出悬浮编辑卡片（`src/components/LinkCard.tsx`，打开/复制/编辑/移除）。选中文字粘贴纯 URL 时自动包装为 `[文字](url)`。
- `src/lib/noteCompletion.ts` — `[[` wiki 链接自动补全源。从目录树读取全部笔记列表，按标题/路径的前缀/包含匹配过滤，插入 `[标题](相对路径.md)`。

状态与副作用：
- `src/stores/appStore.ts` — 应用级状态（配置、同步、引导流程）
- `src/stores/fileStore.ts` — 文件树数据与操作
- `src/stores/tabStore.ts` — 多标签页生命周期管理
- `src/stores/editorStore.ts` — 编辑器视图状态（模式、聚焦、选区）
- `src/stores/uiStore.ts` — UI 面板显隐状态
- `src/hooks/` — 自定义 hook（autoSave、syncTimer、globalKeyboard、dragAndDrop、tabLifecycle 等）
- `src/menus/` — 菜单定义（appMenu.tsx、editorContextMenu.tsx）

### 文件树与文件系统

`src-tauri/src/lib.rs` 实现了真实的目录树：
- `list_tree` 遍历目录，过滤隐藏文件和符号链接，排序（目录优先，然后大小写不敏感），仅向前端暴露 `.md` 文件
- 原子写入：所有文件写入都经过临时文件 + rename，避免崩溃时数据丢失
- 拖拽导入：`import_files` 将 OS 路径下的文件复制到笔记目录（重名自动加 `-N` 后缀）

### Git 同步引擎

同步流程（`git_sync` command + `App.tsx` 定时器逻辑）：
1. 编辑停顿 2 秒后自动保存（写入磁盘）
2. 空闲 30 秒后自动提交（`git add -A && git commit`）
3. 每 5 分钟定时同步（15 秒检查间隔）+ 窗口重获焦点时同步
4. 同步顺序：commit → fetch → 检查 ahead/behind → 若 behind 且 ahead=0：快进合并；若分叉：rebase；若 rebase 冲突：abort + 保存冲突副本 + `-X ours` 合并
5. 失败指数退避：1 分钟 → 5 分钟 → 15 分钟

冲突处理：rebase 失败时，远端版本的每个冲突文件另存为 `原名 (conflict YYYY-MM-DD HH-mm).md`，保留在本地版本旁边。

### Rust 后端扩展功能

- **模板系统**：`_templates/` 目录中的 `.md` 文件，创建笔记时支持 `{{title}}`、`{{date}}`、`{{time}}`、`{{datetime}}` 变量替换
- **反向链接**：扫描所有笔记中的 `[[链接]]` 和 `[文本](路径.md)` 引用，构建引用关系图
- **标签聚合**：从 YAML frontmatter 的 `tags:` 字段提取标签，支持 `[a, b]` 行内列表和 `- tag` YAML 列表两种写法
- **导出**：HTML（前端渲染内容 + Rust 原子写文件，KaTeX 公式与 Mermaid 图表渲染后内联，公式字体以 data URI 自包含）、PNG（snapdom：DOM 序列化为 SVG foreignObject 后由浏览器引擎栅格化，样式与编辑器一致）、Pandoc 转换（docx/pdf 等格式；Windows 上自动下载 portable 版 Pandoc）
- **资源管理**：拖入或粘贴的图片等二进制文件存入 `.assets/` 目录（隐藏目录，排序时置底）
- **系统集成**：托盘图标（左键显示/隐藏窗口，右键菜单退出）、单实例锁（第二个实例激活已有窗口并转发文件路径）、Linux X11 物理 DPI 检测
- **菜单系统**：macOS 使用 Rust 原生菜单（`src-tauri/src/menu.rs`），Linux/Windows 使用前端自定义菜单（`src/components/MenuBar.tsx`）

### 组件树

```
App
├── Onboarding（首次引导向导：选择目录、初始化 git、配置远程仓库）
├── Sidebar
│   └── FileTree（递归渲染，处理行内重命名、拖拽移动、右键菜单）
├── TabBar（多标签页管理）
├── EditorPanel（CodeMirror 包装器，lazy 加载，暴露命令式句柄）
├── StatusBar（字数统计、git 状态、保存/同步状态）
├── SettingsDialog（主题、数据目录、同步配置）
├── AuthDialog（401/403 时弹出重新认证）
├── TitleBar（Linux/Windows 自定义标题栏 + 菜单栏）
├── MenuBar（Linux/Windows 前端菜单栏；macOS 使用 Rust 原生菜单）
├── CommandPalette（Cmd+P 命令面板，模糊搜索笔记/命令）
├── OutlinePanel（文档标题层级导航）
├── TagPanel（按 frontmatter 标签聚合笔记）
├── FrontmatterPanel（YAML 前置元数据编辑）
├── BacklinksPanel（反向链接面板）
├── TodoPanel（任务/复选框聚合面板）
├── ExportDialog（导出 HTML / PNG / Pandoc 格式）
├── EmojiPicker（emoji 选择器）
└── ui/（共享 UI 原语：Button、Dialog、Tooltip、Toast、Switch、Input、ContextMenu）
```

### 设计 Token

`src/index.css` 中的 CSS 变量定义了颜色体系（通过 `.dark` 类切换亮/暗色），对齐飞书文档设计语言：主蓝色 `#3370FF`、中性灰色。所有编辑器 UI 消费这些 token——CodeMirror 主题通过 `EditorView.theme()` 覆写为使用相同变量，因此暗色模式无需 CM 内置主题系统即可工作。

### 关键约定

- **状态管理**：Zustand stores (`src/stores/`) 持有全局状态，组件通过 selector 订阅；自定义 hook (`src/hooks/`) 编排副作用（自动保存、同步定时器、键盘快捷键等），使 App 组件保持精简
- 所有 Tauri command 在 `src/lib/tauri.ts` 中以完整 TypeScript 接口定义类型，与 Rust 结构体对应（`#[serde(rename_all = "camelCase")]`）
- 界面文案为中文（应用面向中文用户）
- 路径别名：`@/` 映射到 `src/`（在 `vite.config.ts` 和 `tsconfig.json` 中均有配置）
- `tauri.conf.json` 中 `dragDropEnabled: true`（Tauri 默认值）。**注意：切勿改为 false** —— `onDragDropEvent`（`src/hooks/useDragAndDrop.ts` 的外部拖入逻辑）依赖它才能触发；false 时 Tauri 不拦截拖放，编辑器区域 drop 会触发 WebKitGTK/Chromium 默认行为——整个 webview 导航到被拖入文件的 `file://` URL，导致白屏乱码（曾因误解该配置含义而踩坑）

### CM6 Block Widget 渲染规范（防点击偏移）

任何 `Decoration.replace({ widget, block: true })` 的 block widget（如公式、图表、表格、分割线）必须遵守三条铁律，否则点击 widget 后面的内容时光标会偏移：

1. **间距用 `padding`，不用 `margin`**：CM6 测量 block widget 只计 border-box（content+padding+border），margin 不被计入。每个带 margin 的 widget 产生累积偏移。已有正确示例：`.lp-table-wrapper` 的 `padding: 0.5em 0`。
2. **widget 根元素不设 `overflow-x: auto`**：CSS 规范规定 overflow-x 非 visible 时 overflow-y:visible 会被强制计算为 auto → 元素变成 scroll container → CM6 ResizeObserver 高度追踪失效。如需水平滚动，放到内部子元素且 `overflow-y: hidden`。
3. **异步渲染（KaTeX/Mermaid）要同步化**：`toDOM()` 返回后 CM6 立即测量高度，异步渲染意味着初始高度为 0。预加载模块（`import()` 在模块顶层）+ `toDOM()` 命中缓存时同步渲染；冷启动用 `textContent` 或 `min-height` 占位。


git tag -a v0.1.10 -m "v0.1.10 release" && git push origin v0.1.10
