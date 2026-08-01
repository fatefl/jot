#!/bin/bash
# 修复 Tauri 生成的 .deb 包中的 .desktop 文件
# Tauri v2 bundler 目前不会自动将 fileAssociations 翻译为 MimeType
# 此脚本在 tauri build 之后运行，补丁 .deb 包

set -e

DEB_DIR=$(find src-tauri/target/release/bundle/deb -maxdepth 1 -name "*.deb" -type f | sort -r | head -1)

if [ -z "$DEB_DIR" ]; then
    echo "未找到 .deb 包，跳过修复。"
    exit 0
fi

echo "正在修复 $DEB_DIR 中的 .desktop 文件..."

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# 解包
dpkg-deb -x "$DEB_DIR" "$WORKDIR/"
dpkg-deb -e "$DEB_DIR" "$WORKDIR/DEBIAN"

DESKTOP_FILE="$WORKDIR/usr/share/applications/jot.desktop"

if [ -f "$DESKTOP_FILE" ]; then
    # 覆盖 .desktop 文件
    cat > "$DESKTOP_FILE" << 'EOF'
[Desktop Entry]
Categories=Office;TextEditor;
Comment=Personal git-backed markdown notes
Exec=jot %f
StartupWMClass=jot
Icon=jot
MimeType=text/markdown;text/x-markdown;
Name=即记 (Jot)
Terminal=false
Type=Application
EOF

    # 添加 postinst 脚本
    cat > "$WORKDIR/DEBIAN/postinst" << 'XEOF'
#!/bin/sh
set -e
if [ -x "$(command -v update-desktop-database)" ]; then
    update-desktop-database -q /usr/share/applications || true
fi
if [ -x "$(command -v update-mime-database)" ]; then
    update-mime-database /usr/share/mime || true
fi
XEOF
    chmod 755 "$WORKDIR/DEBIAN/postinst"

    # 重新打包
    dpkg-deb --build "$WORKDIR/" "$DEB_DIR"
    echo "✓ 已修复 $DEB_DIR"
else
    echo "未找到 .desktop 文件，跳过。"
fi
