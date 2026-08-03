// src/lib/updateCheck.test.ts
// 版本解析与比较的纯函数单测。
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseVersion, compareVersions, fetchLatestRelease, checkForUpdate } from "./updateCheck";

describe("parseVersion", () => {
  it("解析 v 前缀", () => {
    expect(parseVersion("v0.1.17")).toEqual({ major: 0, minor: 1, patch: 17 });
  });

  it("解析纯数字", () => {
    expect(parseVersion("0.1.19")).toEqual({ major: 0, minor: 1, patch: 19 });
  });

  it("忽略 pre-release 后缀", () => {
    expect(parseVersion("v0.2.0-beta.1")).toEqual({ major: 0, minor: 2, patch: 0 });
  });

  it("非法输入返回 null", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("0.1")).toBeNull();
    expect(parseVersion("abc")).toBeNull();
    expect(parseVersion("0.1.2.3")).toBeNull();
  });
});

describe("compareVersions", () => {
  const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });

  it("相等返回 0", () => {
    expect(compareVersions(v(0, 1, 19), v(0, 1, 19))).toBe(0);
  });

  it("major 优先", () => {
    expect(compareVersions(v(1, 0, 0), v(0, 99, 99))).toBe(1);
    expect(compareVersions(v(0, 99, 99), v(1, 0, 0))).toBe(-1);
  });

  it("minor 其次", () => {
    expect(compareVersions(v(0, 2, 0), v(0, 1, 99))).toBe(1);
  });

  it("patch 最后（0.1.19 > 0.1.2）", () => {
    expect(compareVersions(v(0, 1, 19), v(0, 1, 2))).toBe(1);
    expect(compareVersions(v(0, 1, 2), v(0, 1, 19))).toBe(-1);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLatestRelease", () => {
  it("200 时返回 tagName 与 htmlUrl", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: "v0.1.17",
        html_url: "https://github.com/fatefl/jot/releases/tag/v0.1.17",
      }),
    })));
    await expect(fetchLatestRelease()).resolves.toEqual({
      tagName: "v0.1.17",
      htmlUrl: "https://github.com/fatefl/jot/releases/tag/v0.1.17",
    });
  });

  it("非 200 抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
    await expect(fetchLatestRelease()).rejects.toThrow("HTTP 403");
  });

  it("响应缺字段抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await expect(fetchLatestRelease()).rejects.toThrow("malformed release payload");
  });
});

describe("checkForUpdate", () => {
  const mockFetch = (payload: object) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => payload })));

  it("远端更新 → update-available", async () => {
    mockFetch({
      tag_name: "v0.1.17",
      html_url: "https://github.com/fatefl/jot/releases/tag/v0.1.17",
    });
    await expect(checkForUpdate("0.1.16")).resolves.toEqual({
      status: "update-available",
      latestVersion: "0.1.17",
      downloadUrl: "https://github.com/fatefl/jot/releases/tag/v0.1.17",
    });
  });

  it("版本相同 → up-to-date", async () => {
    mockFetch({ tag_name: "v0.1.19", html_url: "https://github.com/fatefl/jot/releases/latest" });
    await expect(checkForUpdate("0.1.19")).resolves.toEqual({ status: "up-to-date" });
  });

  it("远端更旧 → up-to-date", async () => {
    mockFetch({ tag_name: "v0.1.17", html_url: "https://github.com/fatefl/jot/releases/latest" });
    await expect(checkForUpdate("0.1.19")).resolves.toEqual({ status: "up-to-date" });
  });

  it("fetch 抛错 → error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(checkForUpdate("0.1.19")).resolves.toEqual({ status: "error" });
  });

  it("fetch 携带超时信号", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: "v0.1.17",
        html_url: "https://github.com/fatefl/jot/releases/latest",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchLatestRelease();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/fatefl/jot/releases/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("当前版本非法 → error（不请求网络）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkForUpdate("abc")).resolves.toEqual({ status: "error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
