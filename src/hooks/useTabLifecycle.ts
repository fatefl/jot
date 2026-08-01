// src/hooks/useTabLifecycle.ts
// 标签页生命周期：加载 → bootstrap → 持久化
// 这三个 effect 有隐式时序依赖，封装在一个 hook 内避免拆分引入回归
import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useTabStore } from "@/stores/tabStore";

export function useTabLifecycle() {
  const tabs = useTabStore((s) => s.tabs);
  const activeTabIdx = useTabStore((s) => s.activeTabIdx);

  // Step 1: 从 localStorage 恢复标签（必须在 bootstrap 之前执行）
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("notes-open-tabs") || "[]");
      const savedIdx = JSON.parse(localStorage.getItem("notes-active-tab-idx") || "0");
      if (Array.isArray(saved) && saved.length > 0) {
        useTabStore.setState({
          tabs: saved,
          activeTabIdx: typeof savedIdx === "number" ? savedIdx : 0,
        });
      }
    } catch {}
  }, []);

  // Step 2: 启动（读取 store 中的 tabs，打开对应文件）
  useEffect(() => {
    useAppStore.getState().bootstrap();
  }, []);

  // Step 3: 标签变化时持久化回 localStorage（空标签不写，避免覆盖未加载的旧数据）
  useEffect(() => {
    if (tabs.length === 0) return;
    localStorage.setItem("notes-open-tabs", JSON.stringify(tabs));
    localStorage.setItem("notes-active-tab-idx", JSON.stringify(activeTabIdx));
  }, [tabs, activeTabIdx]);
}
