# 命令面板内容搜索优化设计

日期：2026-08-03
状态：已确认（四节设计逐节评审通过）

## 1. 背景与问题

命令面板（Cmd+P）内容搜索存在三类问题：

1. **闪退**（已修复，见下）：Rust `search_walk` 中 `&line[..117]` 字节切片在长中文行混入 emoji 时 panic，panic 发生在 Tauri IPC 回调线程且无 `catch_unwind`，直接导致进程 abort。已在 `src-tauri/src/lib.rs` 修复为 `floor_char_boundary(117)`，并新增 2 个回归测试（`search_content_long_line_with_emoji_no_panic`、`search_content_pure_chinese_long_line_no_panic`）。
2. **只能搜文件名**：前端 `query.length < 2` 门槛导致单字符查询（中文刚需，如"记"）不触发内容搜索；且内容搜索触发即闪退，用户感知为不可用。
3. **卡顿与隐藏缺陷**：同步 command 在 IPC 回调线程全量扫描，数千文件期间 UI 冻结；`out.len() >= 200` 按命中行计数而非按文件计数，单个多行命中文件可占满上限，其他文件结果丢失；结果按文件名排序而非相关性。

## 2. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 笔记库规模 | 中库（数千文件、单文件可达上百 KB） | 用户确认 |
| 是否建索引 | **否** | 中库下异步全量扫描足够；索引与"文件即真相"架构冲突，记为未来大库扩展点 |
| 方案 | **B：Rust 异步化 + 前端体验优化** | 沿用项目现有 `async fn` + `spawn_blocking` 模式，改动 ~200 行，风险低。方案 A（仅异步化）体验提升不足；方案 C（索引）过重 |

## 3. Rust 侧设计

### 3.1 异步化

```rust
#[tauri::command]
async fn search_content(dir: String, query: String) -> Vec<SearchMatch> {
    tauri::async_runtime::spawn_blocking(move || search_content_blocking(&dir, &query))
        .await
        .unwrap_or_default()
}
```

与项目现有 `get_backlinks`、`git_sync` 等 6 处模式完全一致。改动要点：

- 现同步 `search_content` 重命名为 `search_content_blocking`（纯逻辑，可被测试直接调用）
- 扫描移入 tokio 线程池后，即使有未发现的 panic 点，也只是 worker 线程级 panic，`unwrap_or_default()` 返回空结果——**不再存在"主线程 panic → 进程 abort"的闪退路径**

### 3.2 扫描限制（search_walk 变更）

| 变更 | 实现 | 理由 |
|---|---|---|
| 递归深度上限 | `search_walk(dir, query, out, depth)`，`depth > 12` 停止 | 符号链接已跳过，此为防深层结构的第二道保险 |
| 超大文件跳过 | 读文件前 `metadata().len() > 5MB` 跳过 | 单文件逐行扫描是最大耗时点；笔记库 5MB 单文件几乎不存在 |
| 每文件聚合一条 | 单文件扫描完聚合：`line` = 最早命中行，`context` = 该行内容，`match_count` = 命中行数 | 修掉"200 条上限被单文件占满"的隐藏缺陷；上限语义变为 200 个文件；前端无需按 path 去重 |
| 匹配次数 | `SearchMatch` 增加 `match_count: usize` 字段 | 排序需要（见第 4 节） |
| 确定性粗排 | `match_count` 降序 → `line` 升序 | 输出确定，便于测试；精确排序交给前端统一公式 |

`SearchMatch` 结构（新增 `match_count`，`#[serde(rename_all = "camelCase")]`，前端 `tauri.ts` 同步更新类型）：

```rust
struct SearchMatch {
    name: String,          // 文件 stem
    path: String,          // 绝对路径
    line: usize,           // 最早命中行号（1 起）
    context: String,       // 该行内容，>120 字节按字符边界截断加省略号
    match_count: usize,    // 文件内命中行数
}
```

### 3.3 保留的现有护栏

符号链接跳过（防环）、`.`/`_` 前缀目录跳过、字符边界截断、结果上限 200 文件。

## 4. 统一排序模型

**原则**：文件名命中永远优先于纯内容命中；内容结果内部按相关性强弱排序。

score 计算全部在前端（`fuzzyMatch` 已有，公式只在 TS 一处）；Rust 只做确定性粗排（3.2）。注意：现有 `fuzzyMatch` 计算 score 后未随结果返回，实施时需让 `PaletteItem` 携带 `score` 字段供合并排序使用。

```
文件名命中（保留现有）：
  name == query     → 200
  name 前缀匹配     → 180
  name 包含         → 140
  path 包含         → 100

内容命中（新增）：
  content_score = clamp(10 × matchCount − line/10, 0, 90)
  └─ 上限 90 < 100 → 内容命中永远排在文件名命中之后
  └─ 匹配次数越多、行越靠前 → 分越高
```

合并逻辑（CommandPalette 内 useMemo）：

```ts
// 内容结果已排除文件名命中的文件（现有 namePaths 逻辑保留），
// 同一文件天然只出现一次，无需去重
[...nameResults, ...contentResults]
  .sort((a, b) => b.score - a.score)   // 统一降序
  .slice(0, 10)                         // 截断 10 条
```

行为示例：
- 搜 `git`：`git.md`（文件名前缀 180）永远排在正文提到 git 的笔记（≤90）前面
- 搜 `记录`：无文件名命中，引用"记录"最多的笔记排最前

显示不变：内容结果带 `L行号` 徽标 + 上下文行，文件名结果带相对目录。

## 5. 前端交互

### 5.1 单字符搜索

```ts
// 去掉 query.length < 2 门槛：
if (!query.trim()) { setContentResults([]); ... return; }
```

结果量安全边界：每文件一条 + Rust 上限 200 文件 + 前端截断 10 条。

### 5.2 防抖

300ms → 200ms，中库（单次扫描 ≤200ms）下节奏匹配。

### 5.3 关键词高亮

`matchContext` 行内高亮 query。`highlight(text, query)` helper：按小写匹配切分，返回 React 节点数组，用 `<mark>` 包裹命中片段。**不用 `dangerouslySetInnerHTML`**（无 XSS）。大小写不敏感；中文/英文/单字符均适用。文件名结果不高亮。

### 5.4 取消过期请求

现有 `searchIdRef` 机制原样保留（递增 id，响应回来 id 不匹配即丢弃）。这是"软取消"：过期扫描仍会跑完，但结果不污染 UI（接受的权衡）。

## 6. 稳定性清单

| # | 护栏 | 状态 |
|---|---|---|
| 1 | 字符边界截断 `floor_char_boundary` | 已修复（回归测试已有） |
| 2 | 递归深度 ≤ 12 层 | 新增 |
| 3 | >5MB 文件跳过 | 新增 |
| 4 | 符号链接跳过（防环） | 现有 |
| 5 | `.`/`_` 前缀目录跳过 | 现有 |
| 6 | 每文件聚合一条 | 新增 |
| 7 | 结果上限 200 文件 | 现有 |
| 8 | `spawn_blocking` + `unwrap_or_default` 兜底 | 新增 |

## 7. 测试计划

Rust（`cargo test`，全部调 `search_content_blocking` 同步版，不依赖 tauri runtime）：

- 已有：emoji 长行不 panic、纯中文长行不 panic
- 新增：
  - 每文件聚合：1 文件 3 行命中 → 1 条记录，`match_count=3`，`line` = 最早行
  - 200 文件上限：201 个文件 → 200 条
  - 排序：`match_count` 降序、`line` 升序
  - 深度限制：13 层深文件内容搜不到
  - 大文件跳过：>5MB 不返回
  - 单字符：单字可搜到

前端（vitest，mock `api.searchContent`）：

- 更新：单字符输入 → `searchContent` 被调用
- 新增：高亮渲染 `<mark>` 包裹 query；文件名/内容合并排序顺序；过期响应丢弃（先 A 后 B，A 后到不显示）

## 8. 明确不做

- 磁盘索引（大库扩展点，方案 C 已否决）
- 扫描真取消（AtomicBool 每文件检查）
- 改文件名 `fuzzyMatch` 逻辑
- 改 UI 布局/样式（高亮走现有设计 token）

## 9. 验收标准

1. Rust `cargo test` 全绿（含新增 6 项）
2. 前端 vitest 全绿（含新增 3 项、更新 1 项）
3. 真实中库 `pnpm tauri dev` 实测：命令面板输入打字不卡顿、内容结果按相关性排序、命中行关键词高亮、单字符可搜、无闪退
