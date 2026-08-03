// src/lib/updateCheck.ts
// 检查更新的纯函数：版本解析/比较、GitHub Releases 拉取、状态机组合。
// 全部为无副作用函数（网络层唯一副作用是 fetch），便于 vitest 单测。

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

// 完整 x.y.z，可带 v 前缀；pre-release/build 后缀（-beta.1 / +build）忽略，仅比较主版本段
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseVersion(v: string): Version | null {
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareVersions(a: Version, b: Version): number {
  const keys = ["major", "minor", "patch"] as const;
  for (const key of keys) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

export interface LatestRelease {
  tagName: string;
  htmlUrl: string;
}

const RELEASES_LATEST_URL = "https://api.github.com/repos/apidata-cc/jot/releases/latest";

export async function fetchLatestRelease(): Promise<LatestRelease> {
  const res = await fetch(RELEASES_LATEST_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
  if (typeof data.tag_name !== "string" || typeof data.html_url !== "string") {
    throw new Error("malformed release payload");
  }
  return { tagName: data.tag_name, htmlUrl: data.html_url };
}

export type UpdateResult =
  | { status: "update-available"; latestVersion: string; downloadUrl: string }
  | { status: "up-to-date" }
  | { status: "error" };

export async function checkForUpdate(currentVersion: string): Promise<UpdateResult> {
  const current = parseVersion(currentVersion);
  if (!current) return { status: "error" };
  try {
    const latest = await fetchLatestRelease();
    const latestParsed = parseVersion(latest.tagName);
    if (!latestParsed) return { status: "error" };
    if (compareVersions(latestParsed, current) > 0) {
      return {
        status: "update-available",
        latestVersion: latest.tagName.replace(/^v/, ""),
        downloadUrl: latest.htmlUrl,
      };
    }
    return { status: "up-to-date" };
  } catch {
    return { status: "error" };
  }
}
