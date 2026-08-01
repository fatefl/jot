// @vitest-environment jsdom
import { describe, expect, it, beforeEach, beforeAll, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme } from "./useTheme";

// JSDOM 不支持 matchMedia，全局 mock
function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeAll(() => {
  // 默认 mock：亮色模式
  mockMatchMedia(false);
});

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  mockMatchMedia(false);
});

describe("useTheme", () => {
  it("默认 theme 为 system", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");
  });

  it("从 localStorage 恢复主题", () => {
    localStorage.setItem("notes-theme", "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("忽略无效的 localStorage 值", () => {
    localStorage.setItem("notes-theme", "unknown");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");
  });

  it("setTheme 可切换到 light", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("light"));
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("notes-theme")).toBe("light");
  });

  it("setTheme 可切换到 dark", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("dark"));
    expect(result.current.theme).toBe("dark");
    expect(localStorage.getItem("notes-theme")).toBe("dark");
  });

  it("setTheme 可切换回 system", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("dark"));
    act(() => result.current.setTheme("system"));
    expect(result.current.theme).toBe("system");
    expect(localStorage.getItem("notes-theme")).toBe("system");
  });

  it("system 模式下跟随系统暗色偏好（暗色）", () => {
    mockMatchMedia(true); // 暗色系统偏好
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("system 模式下跟随系统亮色偏好", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("dark 模式下强制暗色，忽略系统偏好", () => {
    mockMatchMedia(false); // 系统偏好为亮色
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("dark"));
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("light 模式下强制亮色，忽略系统偏好", () => {
    mockMatchMedia(true); // 系统偏好为暗色
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("light"));
    expect(result.current.isDark).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
