/** 当前是否为 macOS 平台 */
export const isMac =
  typeof navigator !== "undefined" &&
  /Mac/i.test(navigator.platform);

/** 当前是否为 Windows 平台（路径用反斜杠、文件系统大小写不敏感） */
export const isWindows =
  typeof navigator !== "undefined" &&
  /Win/i.test(navigator.platform);

/**
 * 将 macOS 风格的快捷键显示字符串转换为当前平台适用的形式。
 * - macOS：保留 ⌘ / ⇧ 符号
 * - Windows / Linux：替换为 Ctrl+ / Shift+
 *
 * 用法：shortcut("⌘N") → macOS: "⌘N"  Windows: "Ctrl+N"
 */
export function shortcut(macDisplay: string): string {
  if (isMac) return macDisplay;
  return macDisplay.replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+");
}
