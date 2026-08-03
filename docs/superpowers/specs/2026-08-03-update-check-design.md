# 检查更新功能设计

日期：2026-08-03
状态：已确认

## 目标

为即记 (Jot) 添加「检查更新」功能：检测 GitHub Releases 上是否有新版本，有则提示用户并引导到下载页。不做应用内下载安装。

## 决策摘要

- **更新方式**：仅提示 + 跳转浏览器下载页（GitHub Releases 页面）
- **实现路径**：纯前端检查 GitHub Releases API（方案 A），零 Rust 改动、零新依赖
- **检查时机**：启动时自动检查一次（静默）+ 帮助菜单手动「检查更新...」
- **比较基准**：`https://api.github.com/repos/fatefl/jot/releases/latest` 的 `tag_name`（如 `v0.1.17`）与运行时 `getVersion()` 对比，**远端 > 本地才提示**

## 架构

新文件 `src/lib/updateCheck.ts`（纯函数模块）：

| 函数 | 职责 |
|---|---|
| `parseVersion(v)` | 解析 `v0.1.19` / `0.1.19` → `{major, minor, patch}`；非法输入（空串、`0.1`、`abc`）返回 `null`。忽略 pre-release 后缀（`releases/latest` 不含预发布版） |
| `compareVersions(a, b)` | 数字逐段比较，缺失段按 0 补齐（如 `0.1.19` > `0.1.2`）→ `-1 / 0 / 1` |
| `fetchLatestRelease()` | `fetch("https://api.github.com/repos/fatefl/jot/releases/latest")`，校验 HTTP 200 + 解析 `tag_name` / `html_url`；失败抛错 |
| `checkForUpdate(currentVersion)` | 组合以上 → `"update-available" \| "up-to-date" \| "error"`；`update-available` 时附带最新版本号与下载页 URL |

接入点（改动现有文件）：

- `src/menus/appMenu.tsx` — 帮助菜单「关于 即记 (Jot)」上方新增「检查更新...」菜单项
- `src/App.tsx` — 启动流程调一次自动检查（静默）
- `src/stores/uiStore.ts` — 新增检查更新对话框状态（沿用 `aboutOpen` 的现有模式）
- 手动检查结果对话框复用现有 `Dialog` 组件；自动检查用现有 toast（支持 action 按钮）
- 「前往下载」使用现有 `api.openUrl`（`src/lib/tauri.ts` 已封装）打开 `html_url`（即 `https://github.com/fatefl/jot/releases/latest`，各平台安装包均在该页）

## 数据流

**启动自动检查（静默）：**

```
App 启动 → getVersion() 成功 → checkForUpdate(version)
  ├─ update-available → toast「发现新版本 vX.Y.Z」+ 按钮「查看」(openUrl → 下载页)
  ├─ up-to-date / error → 无任何提示
```

dev 环境（`pnpm dev` 纯前端，无 Tauri runtime）：`getVersion()` 失败 → 静默跳过，不检查。

**手动检查（菜单「检查更新...」）：**

```
点击 → 对话框显示「正在检查…」→ checkForUpdate(version)
  ├─ update-available → 「发现新版本 vX.Y.Z（当前 vA.B.C）」+「前往下载」按钮
  ├─ up-to-date → 「当前已是最新版本 vA.B.C」
  └─ error → 「检查更新失败，请稍后再试」（对话框内展示）
```

## 错误处理

- 网络失败 / 非 200 / JSON 解析失败 / 版本解析失败 → 一律走 `error` 分支
- 自动检查失败静默忽略，不影响启动
- 不做去重/缓存：启动只调一次，手动检查可随时重试，天然无重复提示问题
- fetch 带 15 秒超时（`AbortSignal.timeout(15_000)`）：断网/挂起时手动检查对话框 15 秒内从「正在检查…」转「检查更新失败」，避免 WebKitGTK 默认超时（约 300 秒）卡住对话框（终审裁定，2026-08-03）
- GitHub API 未认证限流 60 次/时/IP，启动 + 手动频率远低于此

## 测试

`src/lib/updateCheck.test.ts`（vitest，纯函数单测）：

- `parseVersion`：`v` 前缀、纯数字、非法输入（空串、`0.1`、`abc`）→ `null`
- `compareVersions`：相等、major 不同、minor 不同、patch 不同、跨长度（`0.1.19` vs `0.1.2`）
- `checkForUpdate`：mock `fetch` + mock 当前版本 → 三种状态各一条（API 返回新版 / 返回同版本 / fetch 抛错）
- `fetchLatestRelease`：断言 fetch 被调用时携带超时信号（`AbortSignal`）——fake timers 无法拦截 `AbortSignal.timeout` 的原生定时器，故不测真实超时触发，仅测信号接线

## 发布约定（重要）

每次发版必须：升级三处版本号（`package.json` / `tauri.conf.json` / `Cargo.toml`）→ 打 tag `vX.Y.Z` → 在 GitHub 创建对应 Release 并上传安装包。**否则检查功能形同虚设。**

现状说明：GitHub 最新 release 为 v0.1.17，应用版本已到 0.1.19（先升级版本号、后补 release 的节奏）。不影响功能（远端 > 本地才提示），但 v0.1.20 起必须遵守上述约定。

## 明确不做（YAGNI）

- 不做应用内下载安装、不做升级日志页、不做「跳过此版本」、不做定时自动检查
- 版本比较不做 pre-release 语义
- 不引入新依赖（自写约 20 行比较逻辑）
