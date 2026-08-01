// src/lib/editorViewCache.ts
// 单编辑器视图 + per-tab EditorState 缓存：tab 切换不再销毁重建 CodeMirror
// 视图，而是把当前视图状态（语法树/装饰/撤销栈/选区）按路径缓存，
// 切回时 view.setState() 直接恢复——零解析、零装饰重建、撤销历史保留。
import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

interface CachedViewState {
  state: EditorState;
  scrollTop: number;
}

interface LiveBinding {
  view: EditorView;
  path: string | null;
  /** 用当前生效的 extensions 新建状态（缓存未命中/强制刷新时） */
  createState: (doc: string) => EditorState;
}

const cache = new Map<string, CachedViewState>();
let live: LiveBinding | null = null;

/** 活动公式/Mermaid 编辑会话的收尾函数（由 Editor.tsx 注册）。
 *  在保存 / 快照 / 视图换挡前调用：把剥离了定界符的裸代码重新包裹回
 *  $$…$$ / ```mermaid 围栏，防止裸文本被写盘或缓存后丢失标记。 */
let activeEditFinalizer: (() => void) | null = null;

export function setActiveEditFinalizer(fn: (() => void) | null): void {
  activeEditFinalizer = fn;
}

/** 收尾当前活动编辑会话（若存在）。幂等：无会话或已结束时无操作。 */
export function finalizeActiveEdit(): void {
  activeEditFinalizer?.();
}

/** EditorPanel 创建视图后绑定；同一时刻只存在一个活动编辑器视图 */
export function bindEditorView(
  view: EditorView,
  path: string | null,
  createState: (doc: string) => EditorState,
): void {
  live = { view, path, createState };
}

/** 视图销毁时解绑（按视图身份校验，防止误清新绑定） */
export function unbindEditorView(view: EditorView | undefined): void {
  if (live && live.view === view) live = null;
}

/** 把当前视图状态按路径存入缓存（swap 内部调用；测试可直接使用） */
export function stashLiveState(): void {
  if (!live || !live.path) return;
  cache.set(live.path, {
    state: live.view.state,
    scrollTop: live.view.scrollDOM.scrollTop,
  });
}

/**
 * 把活动编辑器切换到 path 对应的内容：
 * - 先把当前视图状态缓存到旧路径下；
 * - preferCache 且命中缓存：setState 恢复（零重建），并还原滚动位置；
 * - 否则用当前 extensions 新建状态（成本等同原重建，但无 React 卸载/挂载）。
 * preferCache=false 用于磁盘重新加载（外部修改/同步拉取），
 * 该路径的缓存状态必然过期，直接丢弃。
 * 返回 false 表示当前无活动视图（未挂载/测试中），调用方走纯 store 路径。
 */
export function swapEditorState(path: string, doc: string, preferCache: boolean): boolean {
  if (!live) return false;
  const { view, createState } = live;
  // 离开当前文件前收尾进行中的公式/Mermaid 编辑（恢复定界符）。
  // 常规路径已由 saveCurrent 收尾，这里是兜底：任何绕过保存直接换挡的
  // 路径，也不能把剥离定界符的裸状态缓存下来（切回时会被自动保存丢标记）。
  finalizeActiveEdit();
  stashLiveState();
  if (!preferCache) cache.delete(path);
  const cached = preferCache ? cache.get(path) : undefined;
  if (cached) {
    cache.delete(path);
    view.setState(cached.state);
    // 选区已在 state 中恢复，滚动位置单独还原
    view.scrollDOM.scrollTop = cached.scrollTop;
  } else {
    view.setState(createState(doc));
  }
  live.path = path;
  return true;
}

/** 丢弃指定路径的缓存状态（标签关闭/文件删除时与内容快照同步失效） */
export function dropViewState(path: string): void {
  cache.delete(path);
}

/** 批量丢弃（目录删除：含前缀下所有文件） */
export function dropViewStatesForPath(path: string, isDir: boolean): void {
  for (const key of [...cache.keys()]) {
    if (key === path || (isDir && key.startsWith(path + "/"))) cache.delete(key);
  }
}

/** 重命名后迁移缓存键（状态仍然有效，rename 保留内容与 mtime） */
export function remapViewStatesForRename(oldPath: string, newPath: string, isDir: boolean): void {
  for (const [key, entry] of [...cache.entries()]) {
    if (key === oldPath) {
      cache.delete(key);
      cache.set(newPath, entry);
    } else if (isDir && key.startsWith(oldPath + "/")) {
      cache.delete(key);
      cache.set(newPath + key.slice(oldPath.length), entry);
    }
  }
}

/** 测试专用：清空缓存与绑定 */
export function __resetEditorViewCache(): void {
  cache.clear();
  live = null;
}
