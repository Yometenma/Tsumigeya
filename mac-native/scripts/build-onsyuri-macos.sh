#!/bin/bash
# 构建 ONS（NScripter）运行时依赖包：onsyuri + 它依赖的全部 dylib。
#
# ===== 为什么需要这个脚本 =====
#
# ONSyuri 上游只发布**动态链接到 /opt/homebrew** 的 macOS 二进制（lua 5.5 / sdl2 /
# sdl2_ttf / sdl2_image / sdl2_mixer）。用户机器上没有 Homebrew 就 dyld 直接拒载，
# 所以由我方重新打包成自包含目录，发布成**依赖 release**，
# 用户在「引擎」页点安装时才下载到 `modules/nscripter/deps/onsyuri/`。
# App 本身不内置任何部分。
#
# 用法（Apple Silicon Mac）：
#   ./scripts/build-onsyuri-macos.sh
#
# 产物：$WORK/onsyuri-macos-arm64.tar.gz
# 上传到 GitHub Release 后，把 sha256 填进 EngineDependencies 的 nscripter 项。
set -euo pipefail
export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH

ONSYURI_VERSION=${ONSYURI_VERSION:-v0.7.7beta}
WORK=${WORK:-$PWD/.build-onsyuri}

echo "== 1/5 依赖 =="
brew install lua sdl2 sdl2_ttf sdl2_image sdl2_mixer dylibbundler

mkdir -p "$WORK/out/lib"
cd "$WORK"

echo "== 2/5 取上游二进制 =="
if [ ! -x onsyuri ]; then
    curl -sSL -o onsyuri \
        "https://github.com/YuriSizuku/OnscripterYuri/releases/download/${ONSYURI_VERSION}/onsyuri_${ONSYURI_VERSION}_aarch64_darwin"
    chmod +x onsyuri
fi
shasum -a 256 onsyuri

echo "== 3/5 打包 dylib =="
rm -rf out/onsyuri out/lib/*
cp -f onsyuri out/onsyuri
dylibbundler -od -b -x out/onsyuri -d out/lib -p @loader_path/lib

# brew 的 `sdl2` 现在是 **sdl2-compat**（基于 SDL3），它的 libSDL2 运行时会自己 dlopen：
#     @loader_path/libSDL3.dylib
#     @executable_path/libSDL3.dylib
# dylibbundler 看不见这种运行时加载，所以必须手动补——否则启动直接
# `Fatal error! Failed loading SDL3 library.`
echo "  补 SDL3（sdl2-compat 的运行时依赖）"
cp -f /opt/homebrew/opt/sdl3/lib/libSDL3.0.dylib out/lib/libSDL3.0.dylib
ln -sf libSDL3.0.dylib out/lib/libSDL3.dylib

# dylibbundler 会把 lib/ 里那些 dylib 的传递依赖也写成 `@loader_path/lib/X`，
# 但它们的 @loader_path 已经是 out/lib，于是解析成 out/lib/lib/X（不存在）。
# 二进制用 `@loader_path/lib/X`，lib 内的 dylib 用 `@loader_path/X`。
echo "== 4/5 修正多套一层的路径 =="
for f in out/lib/*.dylib; do
    otool -L "$f" | awk '/@loader_path\/lib\//{print $1}' | while read -r dep; do
        install_name_tool -change "$dep" "@loader_path/${dep#@loader_path/lib/}" "$f"
    done
done

for f in out/lib/*.dylib; do codesign --force --timestamp=none -s - "$f" >/dev/null 2>&1 || true; done
codesign --force --timestamp=none -s - out/onsyuri >/dev/null 2>&1 || true

echo "== 5/5 校验并打包 =="
if [ ! -e out/lib/libSDL3.dylib ] || [ ! -e out/lib/libSDL3.0.dylib ]; then
    echo "缺少 SDL3（sdl2-compat 会在运行时 dlopen 它）" >&2
    exit 1
fi
for f in out/onsyuri out/lib/*.dylib; do
    otool -L "$f" | awk 'NR>1 {print $1}' | grep -E '^(/opt/homebrew|@loader_path)' | while read -r dep; do
        case "$dep" in
            @loader_path/lib/*) path="out/${dep#@loader_path/}" ;;
            @loader_path/*)     path="out/lib/${dep#@loader_path/}" ;;
            *)                  path="$dep" ;;
        esac
        if [ ! -e "$path" ]; then echo "缺失依赖：$f -> $dep"; exit 1; fi
    done
done

tar czf onsyuri-macos-arm64.tar.gz -C out .
shasum -a 256 onsyuri-macos-arm64.tar.gz
echo "产物：$WORK/onsyuri-macos-arm64.tar.gz（$(du -h onsyuri-macos-arm64.tar.gz | cut -f1)）"
