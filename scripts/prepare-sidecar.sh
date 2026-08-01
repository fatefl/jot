#!/bin/bash
# 构建 jot-mcp 并按当前平台 target triple 放入 src-tauri/binaries/
# tauri.conf.json 的 bundle.externalBin 要求 sidecar 存在，否则 tauri dev/build 报错。
# 新克隆仓库后、或 src-tauri/binaries/ 被清理后，执行一次即可。
set -e

PROFILE="${1:-debug}"
if [ "$PROFILE" = "release" ]; then
    cargo build --release -p jot-mcp
else
    cargo build -p jot-mcp
fi

TRIPLE=$(rustc -vV | awk '/^host:/{print $2}')
EXT=""
case "$TRIPLE" in *windows*) EXT=".exe" ;; esac

mkdir -p src-tauri/binaries
cp "target/$PROFILE/jot-mcp$EXT" "src-tauri/binaries/jot-mcp-$TRIPLE$EXT"
echo "✓ 已就绪: src-tauri/binaries/jot-mcp-$TRIPLE$EXT"
