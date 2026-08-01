import { listen } from "@tauri-apps/api/event";

export interface MenuActionPayload {
  action: string;
}

/**
 * 监听 Rust 侧全局菜单发出的 menu-action 事件。
 * 返回取消监听的函数，与 useEffect 清理逻辑配合。
 */
export async function listenMenuEvents(
  handler: (action: string) => void,
): Promise<() => void> {
  try {
    const unlisten = await listen<MenuActionPayload>("menu-action", (event) => {
      console.log("[menu] frontend received:", event.payload.action);
      handler(event.payload.action);
    });
    console.log("[menu] listener registered ✓");
    return unlisten;
  } catch (e) {
    console.error("[menu] failed to register listener:", e);
    return () => {};
  }
}
