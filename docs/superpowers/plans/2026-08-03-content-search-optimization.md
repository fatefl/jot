# 命令面板内容搜索优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内容搜索从"同步全量扫描 + 文件名排序 + 单字符不可搜"升级为"异步扫描 + 相关性排序 + 单字符可搜 + 关键词高亮"，并堵住全部 panic 隐患。

**Architecture:** Rust 侧沿用项目现有 `async fn` + `tauri::async_runtime::spawn_blocking` 模式（与 `get_backlinks` 一致）把全量扫描移出 IPC 回调线程；`search_walk` 增加深度/文件大小限制并改为每文件聚合一条结果（携带 `match_count`）；前端统一排序公式（文件名分 200/180/140/100，内容分 `clamp(10×matchCount−line/10, 0, 90)`），去掉单字符门槛，`<mark>` 高亮命中关键词。

**Tech Stack:** Rust (Tauri 2.11.5, tokio spawn_blocking) / TypeScript / React 18 / Zustand / vitest + testing-library / CodeMirror 6

**Spec:** `docs/superpowers/specs/2026-08-03-content-search-optimization-design.md`

## Global Constraints

- 排序原则：内容分上限 90 < 文件名最低分 100，**文件名命中永远优先于纯内容命中**
- Rust 侧常量：递归深度 ≤ 12 层、文件 >5MB 跳过、结果上限 200 个文件（每文件一条，不再按行计数）
- `SearchMatch` 结构 `#[serde(rename_all = "camelCase")]`：`match_count` 序列化为 `matchCount`，与 `src/lib/tauri.ts` 的 TS 接口对应
- 高亮用 React 元素数组渲染 `<mark className="search-hit">`，**禁止 `dangerouslySetInnerHTML`**
- 防抖 200ms；`searchIdRef` 软取消机制保留
- 工作区已有未提交改动（上一轮 `&line[..117]` 修复 + 2 个回归测试），Task 1 提交时一并带上
- 界面文案为中文；路径别名 `@/` → `src/`

---

### Task 1: Rust 侧 —— 异步化 + 扫描限制 + 每文件聚合

**Files:**
- Modify: `src-tauri/src/lib.rs:132-139`（SearchMatch 结构）、`src-tauri/src/lib.rs:813-870`（search_content / search_walk）
- Test: `src-tauri/src/lib.rs` tests 模块（约 2569 行起的 `mod tests`，`mk_vault` 辅助函数已存在）

**Interfaces:**
- Produces:
  - `async fn search_content(dir: String, query: String) -> Vec<SearchMatch>`（Tauri command，供前端 invoke）
  - `fn search_content_blocking(dir: &str, query: &str) -> Vec<SearchMatch>`（同步版，供测试直接调用）
  - `SearchMatch { name: String, path: String, line: usize, context: String, match_count: usize }`
  - 语义：每文件聚合一条；`line` = 最早命中行（1 起）；`match_count` = 文件内命中行数；结果按 `match_count` 降序、`line` 升序；上限 200 个文件；深度 ≤ 12；>5MB 跳过

- [ ] **Step 1: 写失败测试（6 个新增 + 2 个已有测试改调用点）**

在 `mod tests` 中新增以下测试，并把上一轮 2 个测试（`search_content_long_line_with_emoji_no_panic`、`search_content_pure_chinese_long_line_no_panic`）里的 `search_content(...)` 调用改为 `search_content_blocking(...)`（形参从 `tmp.to_string_lossy().to_string()` 改为 `&tmp.to_string_lossy()`）：

```rust
#[test]
fn search_content_aggregates_per_file() {
    let tmp = mk_vault("search-agg");
    fs::write(
        tmp.join("a.md"),
        "第一行没有命中\n记录 git 使用\n中间\n记录 git 配置\n",
    )
    .unwrap();
    let results = search_content_blocking(&tmp.to_string_lossy(), "记录");
    assert_eq!(results.len(), 1, "每文件只聚合一条");
    assert_eq!(results[0].name, "a");
    assert_eq!(results[0].line, 2, "取最早命中行");
    assert_eq!(results[0].match_count, 2, "命中行数聚合");
    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn search_content_limit_200_files() {
    let tmp = mk_vault("search-200");
    for i in 1..=201 {
        fs::write(tmp.join(format!("n{:03}.md", i)), "共享关键词\n").unwrap();
    }
    let results = search_content_blocking(&tmp.to_string_lossy(), "共享关键词");
    assert_eq!(results.len(), 200, "上限 200 个文件");
    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn search_content_sorts_by_match_count() {
    let tmp = mk_vault("search-sort");
    fs::write(tmp.join("b.md"), "关键词\n关键词\n关键词\n").unwrap();
    fs::write(tmp.join("a.md"), "关键词\n").unwrap();
    let results = search_content_blocking(&tmp.to_string_lossy(), "关键词");
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].name, "b", "match_count 多的排前");
    assert_eq!(results[0].match_count, 3);
    assert_eq!(results[1].name, "a");
    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn search_content_depth_limit() {
    let tmp = mk_vault("search-depth");
    // 12 层内可搜到
    let mut dir12 = tmp.clone();
    for i in 1..=12 {
        dir12 = dir12.join(format!("d{}", i));
    }
    fs::create_dir_all(&dir12).unwrap();
    fs::write(dir12.join("deep12.md"), "深层关键词\n").unwrap();
    // 13 层搜不到（depth > 12 直接返回）
    let dir13 = dir12.join("d13");
    fs::create_dir_all(&dir13).unwrap();
    fs::write(dir13.join("deep13.md"), "深层关键词\n").unwrap();

    let results = search_content_blocking(&tmp.to_string_lossy(), "深层关键词");
    let names: Vec<&str> = results.iter().map(|r| r.name.as_str()).collect();
    assert!(names.contains(&"deep12"), "12 层内应搜到");
    assert!(!names.contains(&"deep13"), "13 层应跳过");
    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn search_content_skips_large_file() {
    let tmp = mk_vault("search-large");
    let big = tmp.join("big.md");
    fs::File::create(&big).unwrap().set_len(5 * 1024 * 1024 + 1).unwrap(); // 稀疏文件 >5MB
    fs::write(tmp.join("small.md"), "关键词\n").unwrap();
    let results = search_content_blocking(&tmp.to_string_lossy(), "关键词");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].name, "small");
    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn search_content_single_char() {
    let tmp = mk_vault("search-1char");
    fs::write(tmp.join("note.md"), "今天记了笔记\n").unwrap();
    let results = search_content_blocking(&tmp.to_string_lossy(), "记");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].name, "note");
    let _ = fs::remove_dir_all(&tmp);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test search_content_ 2>&1 | tail -20`
Expected: 编译错误 `cannot find function 'search_content_blocking'`（函数与 `match_count` 字段均不存在）。

- [ ] **Step 3: 实现**

`SearchMatch` 结构加字段（`src-tauri/src/lib.rs:132-139`）：

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    name: String,
    path: String,
    line: usize,
    context: String,
    match_count: usize,
}
```

`search_content` 改 async，原同步逻辑移入 `search_content_blocking`，`search_walk` 加限制并改为每文件聚合（替换 `src-tauri/src/lib.rs:813-870` 整段）：

```rust
const MAX_SEARCH_DEPTH: usize = 12;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 200;

#[tauri::command]
async fn search_content(dir: String, query: String) -> Vec<SearchMatch> {
    tauri::async_runtime::spawn_blocking(move || search_content_blocking(&dir, &query))
        .await
        .unwrap_or_default()
}

fn search_content_blocking(dir: &str, query: &str) -> Vec<SearchMatch> {
    let q = query.to_lowercase();
    let mut results: Vec<SearchMatch> = Vec::new();
    search_walk(Path::new(dir), &q, &mut results, 0);
    results.sort_by(|a, b| {
        b.match_count
            .cmp(&a.match_count)
            .then_with(|| a.line.cmp(&b.line))
    });
    results
}

fn search_walk(dir: &Path, query: &str, out: &mut Vec<SearchMatch>, depth: usize) {
    if depth > MAX_SEARCH_DEPTH {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_SEARCH_RESULTS {
            return;
        }
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name.starts_with('_') {
            continue;
        }
        // 跳过符号链接，防止链接环栈溢出/越界访问外部文件
        if is_symlink(&path) {
            continue;
        }
        if path.is_dir() {
            search_walk(&path, query, out, depth + 1);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            // 超大文件跳过，避免单文件逐行扫描拖慢整体搜索
            if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path) {
                let mut first_line = 0usize;
                let mut context = String::new();
                let mut count = 0usize;
                for (idx, line) in content.lines().enumerate() {
                    if line.to_lowercase().contains(query) {
                        if count == 0 {
                            first_line = idx + 1;
                            context = if line.len() > 120 {
                                // 与 truncate_line 相同的字符边界截断：117 是字节索引，
                                // 落在多字节字符（emoji/中文混排）内部时字节切片会 panic → 闪退
                                let end = line.floor_char_boundary(117);
                                format!("{}…", &line[..end])
                            } else {
                                line.to_string()
                            };
                        }
                        count += 1;
                    }
                }
                if count > 0 {
                    out.push(SearchMatch {
                        name: path
                            .file_stem()
                            .and_then(|n| n.to_str())
                            .unwrap_or(name)
                            .to_string(),
                        path: disp(&path),
                        line: first_line,
                        context,
                        match_count: count,
                    });
                }
            }
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test 2>&1 | grep -E "^test result"`
Expected: `78 passed`（原 76 + 新增 6，其中上一轮 2 个测试仍在）+ `0 failed`。

- [ ] **Step 5: 提交**

```bash
cd /home/job/Desktop/jot
git add src-tauri/src/lib.rs
git commit -m "fix(search): 内容搜索异步化 + 深度/大小限制 + 每文件聚合

- search_content 改 async + spawn_blocking，扫描移出 IPC 回调线程（修 UI 卡顿）
- 递归深度 ≤12、>5MB 文件跳过、结果上限 200 文件（原按行计数会被单文件占满）
- 每文件聚合一条并返回 match_count，按命中数降序、行号升序
- 保留 floor_char_boundary 字符边界截断（emoji/中文混排长行不再闪退）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 前端 —— 合并排序 + 单字符 + 防抖

**Files:**
- Modify: `src/lib/tauri.ts:87-92`（SearchMatch 接口加 matchCount）
- Modify: `src/components/CommandPalette.tsx`（PaletteItem、fuzzyMatch、useEffect、results useMemo）
- Test: `src/components/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `SearchMatch { name, path, line, context, matchCount }`
- Produces:
  - `PaletteItem.score: number`（必填字段）
  - `fuzzyMatch(items, query): PaletteItem[]`（返回携带 score，已排序截断 10）
  - `contentScore(matchCount: number, line: number): number` = `Math.max(0, Math.min(90, 10 * matchCount - Math.floor(line / 10)))`
  - 合并结果：`[...nameResults, ...contentResults]` 按 score 降序，截断 10

- [ ] **Step 1: tauri.ts 类型更新 + 写失败测试**

`src/lib/tauri.ts:87-92`：

```ts
export interface SearchMatch {
  name: string;
  path: string;
  line: number;
  context: string;
  matchCount: number;
}
```

`src/components/CommandPalette.test.tsx` 顶部加 `act` import（`import { render, fireEvent, act } from "@testing-library/react";`），新增 2 个测试：

```tsx
describe("CommandPalette — 内容搜索", () => {
  it("单字符输入触发内容搜索（中文刚需）", () => {
    vi.useFakeTimers();
    const { container } = renderPalette();
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "记" } });
    act(() => { vi.advanceTimersByTime(200); });
    expect(api.searchContent).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("文件名匹配优先于内容匹配，内容按 matchCount 排序", async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchContent).mockResolvedValue([
      { name: "alpha", path: "/notes/alpha.md", line: 3, context: "git 使用记录", matchCount: 5 },
      { name: "beta", path: "/notes/beta.md", line: 1, context: "git 说明", matchCount: 1 },
    ]);
    const notes: TreeNode[] = [
      makeNode("/notes", "notes", true, [
        makeNode("/notes/git.md", "git.md", false),
        makeNode("/notes/alpha.md", "alpha.md", false),
        makeNode("/notes/beta.md", "beta.md", false),
      ]),
    ];
    const { container } = render(
      <CommandPalette
        open={true}
        notes={notes}
        notesDir="/notes"
        recentPaths={[]}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "git" } });
    act(() => { vi.advanceTimersByTime(200); });
    await act(async () => { await Promise.resolve(); }); // flush mock promise

    const btns = resultBtns(container);
    expect(btns[0].textContent).toContain("git.md"); // 文件名命中 180 第一
    const texts = btns.map((b) => b.textContent ?? "");
    const idxAlpha = texts.findIndex((t) => t.includes("alpha.md"));
    const idxBeta = texts.findIndex((t) => t.includes("beta.md"));
    expect(idxAlpha).toBeGreaterThanOrEqual(0);
    expect(idxBeta).toBeGreaterThanOrEqual(0);
    expect(idxAlpha).toBeLessThan(idxBeta); // matchCount 5 → 50 分 > 1 → 10 分
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- --run CommandPalette 2>&1 | tail -25`
Expected: 单字符测试 FAIL（searchContent 未被调用）；类型错误：`PaletteItem` 缺 `score`、`SearchMatch` 缺 `matchCount`。

- [ ] **Step 3: 实现**

`src/components/CommandPalette.tsx` 逐处修改：

a) 接口加 score（第 7-17 行）：

```ts
export interface PaletteItem {
  name: string;
  path: string;
  relDir: string;
  /** 内容匹配时的行号 */
  matchLine?: number;
  /** 内容匹配时的上下文 */
  matchContext?: string;
  /** 内容匹配 */
  kind?: "file" | "content";
  /** 统一排序分：文件名 200/180/140/100，内容 ≤90 */
  score: number;
}
```

b) `collectPaletteItems` 的 push 加 `score: 0`（第 39-45 行，fuzzyMatch 会覆盖）：

```ts
out.push({
  name: n.name,
  path: n.path,
  relDir: i > 0 ? rel.slice(0, i) : "",
  kind: "file",
  score: 0,
});
```

c) 重写 `fuzzyMatch`（第 52-71 行，删除无用的 `seen`/`out` 死代码，返回携带 score）：

```ts
function fuzzyMatch(items: PaletteItem[], query: string): PaletteItem[] {
  const q = query.toLowerCase();
  return items
    .map((item) => {
      const name = item.name.toLowerCase();
      const path = item.path.toLowerCase();
      let score = 0;
      if (name === q) score = 200;
      else if (name.startsWith(q)) score = 180;
      else if (name.includes(q)) score = 140;
      else if (path.includes(q)) score = 100;
      return { ...item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}
```

d) 新增 `contentScore`（放 fuzzyMatch 之后）：

```ts
/** 内容命中分：匹配次数越多、行越靠前越高；上限 90 < 文件名最低分 100 */
function contentScore(matchCount: number, line: number): number {
  return Math.max(0, Math.min(90, 10 * matchCount - Math.floor(line / 10)));
}
```

e) 内容搜索 useEffect（第 101-140 行）：门槛去掉 `query.length < 2`、防抖 300→200、push 时带 score：

```ts
  // 内容搜索（200ms 防抖）
  useEffect(() => {
    if (!query.trim()) {
      setContentResults([]);
      setSearching(false);
      return;
    }
    const id = ++searchIdRef.current;
    setSearching(true);
    const t = setTimeout(() => {
      // 防御：searchContent 在个别环境（如 mock 被重置）下可能返回 undefined，
      // 直接 .then 会产生未处理异常；生产环境 invoke 恒返回 Promise，此分支不触发
      const p = api.searchContent(notesDir, query.trim());
      if (!p || typeof p.then !== "function") {
        if (id === searchIdRef.current) setSearching(false);
        return;
      }
      p.then((matches) => {
        if (id !== searchIdRef.current) return;
        // 排除已经通过文件名搜索匹配到的
        const namePaths = new Set(nameResults.map((n) => n.path));
        const items: PaletteItem[] = [];
        for (const m of matches) {
          if (namePaths.has(m.path)) continue;
          items.push({
            name: m.name + ".md",
            path: m.path,
            relDir: "",
            matchLine: m.line,
            matchContext: m.context,
            kind: "content",
            score: contentScore(m.matchCount, m.line),
          });
        }
        setContentResults(items.slice(0, 10));
        setSearching(false);
      }).catch(() => {
        if (id === searchIdRef.current) setSearching(false);
      });
    }, 200);
    return () => { clearTimeout(t); };
  }, [query, notesDir, nameResults]);
```

f) `results` useMemo 统一排序（第 142-149 行）：

```ts
  const results = useMemo(() => {
    if (!query.trim()) {
      return recentPaths
        .map((p) => allItems.find((item) => item.path === p))
        .filter(Boolean) as PaletteItem[];
    }
    return [...nameResults, ...contentResults]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }, [query, allItems, recentPaths, nameResults, contentResults]);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- --run CommandPalette 2>&1 | tail -15`
Expected: 全部通过（原有 16 个 + 新增 2 个）。

- [ ] **Step 5: 提交**

```bash
cd /home/job/Desktop/jot
git add src/lib/tauri.ts src/components/CommandPalette.tsx src/components/CommandPalette.test.tsx
git commit -m "feat(search): 内容搜索合并排序 + 单字符可搜 + 防抖 200ms

- PaletteItem 携带统一 score：文件名 200/180/140/100，内容 ≤90，文件名命中永远优先
- 去掉 query.length < 2 门槛，单字符（中文刚需）可触发内容搜索
- 防抖 300ms → 200ms
- fuzzyMatch 清理无用 seen/out 死代码

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 前端 —— 关键词高亮

**Files:**
- Modify: `src/components/CommandPalette.tsx`（highlight helper + 渲染）
- Modify: `src/index.css`（.search-hit 样式）
- Test: `src/components/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `contentResults`（含 `matchContext`）
- Produces: `highlight(text: string, query: string): ReactNode[]`（React 节点数组，`<mark className="search-hit">` 包裹命中片段，大小写不敏感）

- [ ] **Step 1: 写失败测试**

`src/components/CommandPalette.test.tsx` 新增（放在"内容搜索" describe 内）：

```tsx
  it("内容结果上下文关键词高亮", async () => {
    vi.useFakeTimers();
    vi.mocked(api.searchContent).mockResolvedValue([
      { name: "alpha", path: "/notes/alpha.md", line: 1, context: "git 使用记录 git", matchCount: 1 },
    ]);
    const notes: TreeNode[] = [
      makeNode("/notes", "notes", true, [
        makeNode("/notes/alpha.md", "alpha.md", false),
      ]),
    ];
    const { container } = render(
      <CommandPalette
        open={true}
        notes={notes}
        notesDir="/notes"
        recentPaths={[]}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "git" } });
    act(() => { vi.advanceTimersByTime(200); });
    await act(async () => { await Promise.resolve(); });

    const marks = container.querySelectorAll("mark");
    expect(marks.length).toBe(2);
    expect(marks[0].textContent).toBe("git");
    vi.useRealTimers();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- --run CommandPalette 2>&1 | tail -15`
Expected: FAIL（无 `<mark>` 元素，`marks.length` 为 0）。

- [ ] **Step 3: 实现**

`src/components/CommandPalette.tsx`：

a) import 加 `ReactNode`（第 1 行）：

```ts
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
```

b) 新增 highlight helper（放 `contentScore` 之后）：

```ts
/** 在 context 行内按 query 高亮命中片段，返回 React 节点数组（避免 dangerouslySetInnerHTML） */
function highlight(text: string, query: string): ReactNode[] {
  const q = query.toLowerCase();
  const nodes: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest.length > 0) {
    const idx = rest.toLowerCase().indexOf(q);
    if (idx < 0) {
      nodes.push(rest);
      break;
    }
    if (idx > 0) nodes.push(rest.slice(0, idx));
    nodes.push(
      <mark key={key++} className="search-hit">
        {rest.slice(idx, idx + q.length)}
      </mark>,
    );
    rest = rest.slice(idx + q.length);
  }
  return nodes;
}
```

c) `matchContext` 渲染分支（第 243-247 行）改为：

```tsx
                {item.matchContext ? (
                  <span className="block truncate text-xs text-secondary">
                    {highlight(item.matchContext, query)}
                  </span>
                ) : item.relDir ? (
```

`src/index.css` 末尾新增：

```css
/* 命令面板内容搜索命中关键词高亮 */
mark.search-hit {
  background-color: var(--accent-soft);
  border-radius: 2px;
  padding: 0 1px;
  color: inherit;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- --run CommandPalette 2>&1 | tail -15`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
cd /home/job/Desktop/jot
git add src/components/CommandPalette.tsx src/index.css src/components/CommandPalette.test.tsx
git commit -m "feat(search): 内容结果关键词高亮

- highlight() 按小写匹配切分 context，<mark class=search-hit> 包裹命中片段
- React 节点数组渲染，不用 dangerouslySetInnerHTML（无 XSS）
- 高亮样式走 --accent-soft 设计 token

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 过期响应回归测试 + 全量验证 + 收尾

**Files:**
- Test: `src/components/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `searchIdRef` 软取消机制（现有实现，本任务只补回归测试）

- [ ] **Step 1: 写回归测试**

`src/components/CommandPalette.test.tsx` 新增（放在"内容搜索" describe 内；`SearchMatch` 类型从 `@/lib/tauri` import）：

```tsx
  it("过期内容搜索响应被丢弃", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (v: SearchMatch[]) => void;
    vi.mocked(api.searchContent)
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockResolvedValueOnce([
        { name: "fresh", path: "/notes/fresh.md", line: 1, context: "新查询结果", matchCount: 1 },
      ]);
    const notes: TreeNode[] = [
      makeNode("/notes", "notes", true, [
        makeNode("/notes/fresh.md", "fresh.md", false),
      ]),
    ];
    const { container } = render(
      <CommandPalette
        open={true}
        notes={notes}
        notesDir="/notes"
        recentPaths={[]}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const inp = inputEl(container)!;
    fireEvent.change(inp, { target: { value: "git" } });
    act(() => { vi.advanceTimersByTime(200); }); // 第 1 次调用，promise 挂起
    fireEvent.change(inp, { target: { value: "gita" } });
    act(() => { vi.advanceTimersByTime(200); }); // 第 2 次调用
    await act(async () => { await Promise.resolve(); }); // 第 2 次结果渲染

    // 第 1 次响应现在才到 → id 过期 → 丢弃
    resolveFirst([
      { name: "stale", path: "/notes/stale.md", line: 1, context: "旧查询结果", matchCount: 1 },
    ]);
    await act(async () => { await Promise.resolve(); });

    const btns = resultBtns(container);
    expect(btns.some((b) => b.textContent?.includes("stale"))).toBe(false);
    expect(btns.some((b) => b.textContent?.includes("fresh"))).toBe(true);
    vi.useRealTimers();
  });
```

测试文件顶部 import 更新：`import type { SearchMatch, TreeNode } from "@/lib/tauri";`（替换现有 `import type { TreeNode } from "@/lib/tauri";`）。

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm test -- --run CommandPalette 2>&1 | tail -15`
Expected: 全部通过（`searchIdRef` 机制已存在，此测试为回归保护）。

- [ ] **Step 3: 全量验证**

Run 依次：

```bash
cd /home/job/Desktop/jot/src-tauri && cargo test 2>&1 | grep -E "^test result"
```
Expected: `78 passed, 0 failed`。

```bash
cd /home/job/Desktop/jot && pnpm test 2>&1 | tail -8
```
Expected: 全部 suite 通过，无失败。

```bash
cd /home/job/Desktop/jot && pnpm build 2>&1 | tail -8
```
Expected: TypeScript 类型检查通过 + Vite 构建成功。

- [ ] **Step 4: 最终提交（如有遗漏改动）**

```bash
cd /home/job/Desktop/jot
git status --short   # 应只剩 Cargo.lock（构建产生）或为空
git add src-tauri/src/lib.rs src/lib/tauri.ts src/components/CommandPalette.tsx src/index.css src/components/CommandPalette.test.tsx docs/superpowers/specs/2026-08-03-content-search-optimization-design.md
git commit -m "test(search): 过期内容搜索响应丢弃回归测试

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 5: 用户实测验收**

提示用户运行 `pnpm tauri dev`，在真实中库下验证：
1. 输入单字符（如"记"）能出内容结果
2. 打字过程不卡顿（扫描已移出 UI 线程）
3. 内容结果按相关性排序、关键词高亮、`L行号` 徽标跳转正常
4. 不再闪退（长中文行 + emoji 场景）
