import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { ToastProvider } from "./components/ui/toast";
import "katex/dist/katex.min.css";
import "./index.css";

// ---- 启动性能测量 ----
const t0 = performance.now();
const marks: string[] = [];
function mark(label: string) {
  const elapsed = (performance.now() - t0).toFixed(1);
  const line = `[${elapsed}ms] ${label}`;
  marks.push(line);
  console.log(`⏱ ${label}  @ ${elapsed}ms`);
  // 转发到 Rust 终端输出，方便开发时诊断
  invoke("startup_log", { msg: line }).catch(() => {});
}
(window as any).__startupMarks = marks;
(window as any).__startupMark = mark;
mark("main.tsx 开始执行");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
