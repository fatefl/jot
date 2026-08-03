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
