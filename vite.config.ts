import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Tauri expects a fixed port in dev
  clearScreen: false,
  test: {
    // 默认 false 会把 CSS 导入 mock 成空模块，导致 ?raw 内联导出样式拿不到内容
    css: true,
    // 内存密集型 jsdom 测试：vitest 默认按 CPU 核数起 fork，8 核并发下
    // 16GB 机器会被拖进 swap 并引发 flake，限制并行数保证 pnpm test 稳定
    minWorkers: 1,
    maxWorkers: 4,
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // 每次启动强制重新预构建依赖：牺牲几秒冷启动，换 WebView immutable
  // 缓存把「半新半旧的 deps 目录」固化成持续故障的问题不再复发。
  // 仅作用于 dev server，生产构建（vite build 走 Rollup）不受影响。
  optimizeDeps: {
    force: true,
  },
});
