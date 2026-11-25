#!/bin/bash
# 构建 release、组装 app、ad-hoc 签名并生成 DMG；不做公证。
# 用法：TSUMIGEYA_VERSION=<版本> ./scripts/package-macos.sh
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Tsumigeya"
BUNDLE_ID="com.tsumigeya.launcher"
VERSION="${TSUMIGEYA_VERSION:-3.1.0}"
BUILD_NUM="$(date +%Y%m%d%H%M)"
OUT_DIR="dist"
APP_DIR="$OUT_DIR/$APP_NAME.app"
DMG_PATH="$OUT_DIR/$APP_NAME-$VERSION.dmg"

echo "== 1/5 清理旧产物 =="
rm -rf "$APP_DIR" "$DMG_PATH"
# ⚠️ `dist/` 在用户目录里，里面的 .app 会被 Spotlight 索引，
#    于是启动台／聚焦搜索里出现**第二个 Tsumigeya**（和 /Applications 里安装的那份并列）。
#    放一个 .metadata_never_index 让 Spotlight 跳过整个 dist 目录。
mkdir -p "$OUT_DIR"
touch "$OUT_DIR/.metadata_never_index"

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
# 核心运行脚本必须随包分发，不能依赖 SwiftPM 开发目录的回退路径。
for target in TsumigeyaCore TsumigeyaApp; do
  RESOURCE_BUNDLE="$(dirname "$BIN_PATH")/Tsumigeya_${target}.bundle"
  if [ ! -d "$RESOURCE_BUNDLE" ]; then
    echo "❌ 缺少应用资源：$RESOURCE_BUNDLE" >&2
    exit 1
  fi
  cp -R "$RESOURCE_BUNDLE" "$APP_DIR/Contents/Resources/"
done

# SwiftUI 的 Text("…") 只查 Bundle.main：界面语言表必须平铺到 Contents/Resources/<lang>.lproj，
# 放在子 bundle 里 Text 找不到，切语言时界面会停在中文字面量上。
APP_RESOURCE_BUNDLE="$(dirname "$BIN_PATH")/Tsumigeya_TsumigeyaApp.bundle"
for lproj in "$APP_RESOURCE_BUNDLE"/Contents/Resources/*.lproj; do
  if [ -d "$lproj" ]; then
    cp -R "$lproj" "$APP_DIR/Contents/Resources/"
    echo "   界面语言表：$(basename "$lproj")"
  fi
done

ICNS=""
for candidate in "../assets/icon.icns" "../../assets/icon.icns"; do
  if [ -f "$candidate" ]; then ICNS="$candidate"; break; fi
done

if [ -n "$ICNS" ] && [ -f "$ICNS" ]; then
  cp "$ICNS" "$APP_DIR/Contents/Resources/AppIcon.icns"
  echo "   图标：已复制（$ICNS）"
else
  echo "   ⚠️ 找不到 assets/icon.icns，将使用系统默认图标"
fi

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
    <key>CFBundleDevelopmentRegion</key>
    <string>zh-Hans</string>
    <key>CFBundleLocalizations</key>
    <array>
        <string>zh-Hans</string>
        <string>en</string>
        <string>ja</string>
    </array>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>Tsumigeya</string>
</dict>
</plist>
PLIST

echo "== 4/5 ad-hoc 签名 =="
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
echo "⚠️ 本应用未公证，首次打开可能被 Gatekeeper 拦截"
echo "   确认来源可信后可移除隔离标记（见 docs/打包与分发.md）："
echo "     xattr -dr com.apple.quarantine /Applications/$APP_NAME.app"
