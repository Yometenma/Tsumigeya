#!/bin/bash
# 打包 Tsumigeya.app → .dmg
#
# ===== 这个脚本做什么（每一步都有理由）=====
#
# ① `swift build --configuration release`
# ② 组装 .app bundle（目录结构 + Info.plist + 图标 + 二进制）
# ③ **ad-hoc 签名**（`codesign -s -`）
#    ⚠️ arm64 上未签名的二进制有被系统 kill 的风险；ad-hoc 是零证书成本的正解
# ④ 打 .dmg（`hdiutil`）
#
# ===== ⚠️ 这个脚本**不做**什么 =====
#
# **不做公证（notarization）** —— 用户没有 Apple Developer 账号（$99/年）。
# 代价：用户第一次打开要手动绕过 Gatekeeper（见 docs/M7-P8-打包分发.md §4）。
#
# ⚠️ 别以为「ad-hoc 签名就等于能双击开」——
#    本鱼实测：ad-hoc 签名 + quarantine → **仍然不启动**，日志为空。
#    真正让用户「双击即开」的是公证，那需要账号。
#
# 用法：
#   ./scripts/package-macos.sh              # 默认 arm64
#   ./scripts/package-macos.sh --universal  # 通用二进制（需要 x86_64 SDK）
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Tsumigeya"
BUNDLE_ID="com.tsumigeya.launcher"
VERSION="${TSUMIGEYA_VERSION:-1.1.0}"
BUILD_NUM="$(date +%Y%m%d%H%M)"
OUT_DIR="dist"
APP_DIR="$OUT_DIR/$APP_NAME.app"
DMG_PATH="$OUT_DIR/$APP_NAME-$VERSION.dmg"

echo "== 1/5 清理旧产物 =="
rm -rf "$APP_DIR" "$DMG_PATH"

echo "== 2/5 构建 release =="
swift build --configuration release

BIN_PATH="$(swift build --configuration release --show-bin-path)/$APP_NAME"
if [ ! -f "$BIN_PATH" ]; then
  echo "❌ 找不到构建产物：$BIN_PATH" >&2
  exit 1
fi
echo "   二进制：$BIN_PATH"

echo "== 3/5 组装 .app bundle =="
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

cp "$BIN_PATH" "$APP_DIR/Contents/MacOS/$APP_NAME"
chmod +x "$APP_DIR/Contents/MacOS/$APP_NAME"

# 图标（复用 Electron 版生成的那套 icns）
#
# ⚠️ 路径问题：`mac-native/` 与仓库根的 `build/` **同级**
#    （本脚本 cd 到了 `mac-native/`，所以是 `../build/`）。
#    本鱼第一版写成 `../build/icon.icns` 却没找到 —— 因为跑脚本时
#    仓库根其实是 `~/tsmg-swift/`（只同步了 mac-native 与 build）。
#
#    所以这里**两个候选路径都试**：
#      ① `../build/icon.icns`      （仓库结构：根/build/）
#      ② `../../build/icon.icns`   （本机同步结构：~/tsmg-swift/build/）
ICNS=""
for candidate in "../build/icon.icns" "../../build/icon.icns"; do
  if [ -f "$candidate" ]; then ICNS="$candidate"; break; fi
done

if [ -n "$ICNS" ] && [ -f "$ICNS" ]; then
  cp "$ICNS" "$APP_DIR/Contents/Resources/AppIcon.icns"
  echo "   图标：已复制（$ICNS）"
else
  echo "   ⚠️ 找不到 icon.icns（试过 ../build 与 ../../build），将使用系统默认图标"
fi

# Info.plist
#
# ⚠️ **必须有的字段**：
#   · CFBundleIdentifier —— 系统用来识别应用（通知/偏好/TCC 权限都靠它）
#   · CFBundleShortVersionString —— 「关于」面板显示的版本
#   · CFBundleIconFile —— 图标文件名（**不带扩展名**）
#   · LSMinimumSystemVersion —— 与 Package.swift 的 .macOS(.v26) 对齐
#   · NSHighResolutionCapable —— 否则 Retina 屏上会糊
cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleVersion</key>
    <string>$BUILD_NUM</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>26.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>Tsumigeya</string>
</dict>
</plist>
PLIST

echo "== 4/5 ad-hoc 签名 =="
# ⚠️ `-s -` = ad-hoc 签名（无证书）
#    `--force` = 替换已有签名
#    ⚠️ **不加 `--options runtime`**：hardened runtime 是给公证用的，
#      没有公证就启用它**没有收益**，反而可能影响某些动态加载。
codesign -s - --force --deep "$APP_DIR"
echo "   签名完成（ad-hoc）"
codesign -dv "$APP_DIR" 2>&1 | sed 's/^/   /' | head -4

echo "== 5/5 打 dmg =="
mkdir -p "$OUT_DIR"
hdiutil create -volname "$APP_NAME" -srcfolder "$APP_DIR" -ov -format UDZO "$DMG_PATH" >/dev/null
echo "   $DMG_PATH"
ls -lh "$DMG_PATH" | awk '{print "   大小: " $5}'

echo ""
echo "✅ 完成"
echo ""
echo "⚠️ 用户拿到 dmg 后**第一次打开会被 Gatekeeper 拦**（本应用未公证，因为没有 Developer 账号）"
echo "   绕过方式（见 docs/M7-P8-打包分发.md §4）："
echo "     · 右键点 app →「打开」→ 再点「打开」"
echo "     · 或：xattr -dr com.apple.quarantine /Applications/$APP_NAME.app"
