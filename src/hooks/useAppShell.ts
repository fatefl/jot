// src/hooks/useAppShell.ts
// 窗口外壳相关 effect：缩放、DPI、焦点模式
import { useEffect } from "react";
import { api } from "@/lib/tauri";
import { useUiStore } from "@/stores/uiStore";

export function useAppShell() {
  const focusMode = useUiStore((s) => s.focusMode);
  const zoomLevel = useUiStore((s) => s.zoomLevel);

  // 启动后移除过渡抑制标记，恢复正常的主题切换动画
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      document.body.classList.remove("no-transition");
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // 焦点模式 CSS class
  useEffect(() => {
    document.documentElement.classList.toggle("focus-mode", focusMode);
  }, [focusMode]);

  // 焦点模式：鼠标移到顶部时显示 tab 栏
  useEffect(() => {
    if (!focusMode) {
      useUiStore.setState({ tabBarVisible: false });
      return;
    }
    const TRIGGER_HEIGHT = 36;
    const handleMouseMove = (e: MouseEvent) => {
      useUiStore.setState({ tabBarVisible: e.clientY < TRIGGER_HEIGHT });
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [focusMode]);

  // 缩放
  useEffect(() => {
    const scale = 1 + zoomLevel * 0.2;
    document.body.style.zoom = `${(scale * 100).toFixed(0)}%`;
  }, [zoomLevel]);

  // DPI 适配
  useEffect(() => {
    api.getDisplayScale().then((scale) => {
      if (scale !== 1.0) {
        document.documentElement.style.fontSize = `${(15 * scale).toFixed(1)}px`;
      }
    });
  }, []);
}
