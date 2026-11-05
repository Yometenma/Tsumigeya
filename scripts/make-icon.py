"""
Tsumigeya 应用图标：从源图「像素复刻」→ 生成全套平台图标。

════════════════════════════════════════════════════════════════════
用法
════════════════════════════════════════════════════════════════════

    py scripts/make-icon.py

输入：build/icon-source.jpg（手绘/GEN 的图标源图，灰底 #92887e）
输出：
    build/icon_1024.png         Apple 规范 1024 画布母版（RGBA）
    build/icon.icns            macOS 包（11 档，含 icp4/icp5 两个小档）
    build/icon.ico             Windows 包（7 档，含 256）
    build/icon.png             512 通用兜底
    build/iconset/*.png        Apple iconutil 的 10 档拆解（便于人工核对）

换图标的正确姿势：**换 build/icon-source.jpg，重跑本脚本**。
不要去改 build/iconset 里的某个小档 —— 它是生成物，下次会被覆盖。

════════════════════════════════════════════════════════════════════
为什么要「像素复刻」而不是直接缩放（这张图踩了 4 版）
════════════════════════════════════════════════════════════════════

源图是像素画，但本市图的实际情况是：**它已经被放大过、且被 JPEG 压过**
（每格约 8.5px，非整数；边缘带振铃伪影）。直接把 256×274 的图案
LANCZOS 放大到 824 内容区（3.0x），会得到一张「糊掉的像素画」——
每个像素块边缘都是柔的，看着像低质 JPEG 放大图。

四版试错记录（别重走）：

  ✗ v1  dist>TOL 直接判透明
        → 反锯齿边留成不透明的浅色，放大后一圈白毛

  ✗ v2  除以 alpha 反解前景色 fg=(C-bg*(1-a))/a
        → 低 alpha 时分母趋零，数值爆炸，边缘被**提亮成白圈**

  ✗ v3  形态学腐蚀 2px 削振铃环
        → 白圈没了，但**心形被挖出洞**（心形顶部尖角只有 1~2px 宽，
          腐蚀直接磨断），且心形内部的高光被当成噪点筛掉

  ✓ v4（本版）**像素复刻**
        ① 推断原始像素画分辨率 —— 按「格内色差最小」扫描 10~45 格
           实测最优是 **30×32**（格内色差 9.05；30/34 格回升到 9.55/12.03，
           这个"U 型回升"是分带对上了的典型信号）
        ② 每格取**中位色**（中位比均值更抗 JPEG 振铃 —— 均值会被亮边拉高）
        ③ 颜色聚类成调色板（实测收敛到 20 色），把 JPEG 的抖动噪声吃干净
        ④ 离背景近的格 → alpha 0
        ⑤ **最近邻整数倍放大**（k=25）→ 硬边，刀切一样
        ⑥ 补齐到内容区尺寸（最后一步不可避免要一次非整数缩放，可接受）

结果：每个像素块都是**纯色 + 硬边**，16px 小图标也能一眼认出剑穿心 + 花瓣。

════════════════════════════════════════════════════════════════════
版面（Apple 规范，macOS 11+ Big Sur 起）
════════════════════════════════════════════════════════════════════

  画布 1024×1024，内容区 824×824，四边各留 100px 透明。
  **图标本身是方的**，圆角由系统统一裁切（macOS 会给所有 App 图标套同一个遮罩）。
  垂直略上移 2.2% —— 因为图标下方系统要放应用名，纯几何居中会显得偏下。
"""
import io
import os
import shutil
import struct
import sys
from collections import Counter

import numpy as np
from PIL import Image
from PIL import ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
SRC = os.path.join(BUILD, "icon-source.jpg")

CANVAS = 1024
MARGIN = 100
CONTENT = CANVAS - MARGIN * 2      # 824

BG = np.array([146.0, 136.0, 126.0])   # 源图背景实测 #92887e

# 图案区（实测：图案在 y<380，文字在 y>=390，中间 25px 空带）
ART = (384, 91, 640, 365)
# 原始像素画分辨率（实测最优）
NX, NY = 30, 32
# 前景判定阈值：格的中位色离背景多远算背景
BG_TOL = 11
# 调色板聚类容差
PALETTE_TOL = 14


def log(msg):
    print(msg, flush=True)


def infer_grid(sub, lo=10, hi=46):
    """推断原始像素画分辨率：返回格内色差最小的 (nx, ny)。

    判据：按 nx×ny 切格后，格内像素的平均色差越小，说明切得越准。
    原始分辨率处每格都是纯色 → 色差骤降。扫描全范围比只测正方形更准，
    因为源图的宽高比未必等于像素画的宽高比（本例 256×274 而格数是 30×32）。
    """
    sh, sw = sub.shape[:2]

    def score(nx, ny):
        xs = np.linspace(0, sw, nx + 1).round().astype(int)
        ys = np.linspace(0, sh, ny + 1).round().astype(int)
        total, count = 0.0, 0
        for j in range(ny):
            for i in range(nx):
                cell = sub[ys[j]:ys[j + 1], xs[i]:xs[i + 1]]
                if cell.size == 0:
                    continue
                m = cell.reshape(-1, 3)
                total += float(np.abs(m - m.mean(axis=0)).mean())
                count += 1
        return total / max(count, 1)

    best = (float("inf"), NX, NY)
    for nx in range(lo, hi):
        for ny in range(lo, hi):
            s = score(nx, ny)
            if s < best[0]:
                best = (s, nx, ny)
    return best


def extract_sprite():
    """从源图像素复刻出低分辨率精灵，返回 (Image RGBA, palette)。"""
    im = Image.open(SRC).convert("RGB")
    a = np.asarray(im).astype(np.float32)

    x0, y0, x1, y1 = ART
    sub = a[y0:y1, x0:x1]
    sh, sw = sub.shape[:2]
    log(f"图案区 {sw}×{sh} px")

    # ① 用实测常数（也打印一遍推断结果，源图换了能立刻发现）
    s, nx_i, ny_i = infer_grid(sub)
    log(f"分辨率推断: {nx_i}×{ny_i}（格内色差 {s:.2f}）；本脚本采用实测常数 {NX}×{NY}")

    # ② 逐格取中位色
    xs = np.linspace(0, sw, NX + 1).round().astype(int)
    ys = np.linspace(0, sh, NY + 1).round().astype(int)
    cells = np.zeros((NY, NX, 3), dtype=np.float32)
    for j in range(NY):
        for i in range(NX):
            patch = sub[ys[j]:ys[j + 1], xs[i]:xs[i + 1]]
            cells[j, i] = (
                BG if patch.size == 0 else np.median(patch.reshape(-1, 3), axis=0)
            )

    # ③ 背景判定（中位色离背景近 → 透明）
    cd = np.abs(cells - BG.reshape(1, 1, 3)).max(axis=2)
    is_bg = cd < BG_TOL
    log(f"背景格 {int(is_bg.sum())} / {NX * NY}")

    # ④ 调色板聚类（贪心：与已有色差 <= tol 则并入）
    pal = []
    for c in cells[~is_bg]:
        if all(np.abs(c - p).max() > PALETTE_TOL for p in pal):
            pal.append(np.round(c).astype(np.float32))
    pal = np.array(pal) if pal else np.zeros((1, 3), dtype=np.float32)
    log(f"调色板 {len(pal)} 色")

    if len(pal):
        d = np.abs(cells.reshape(-1, 1, 3) - pal.reshape(1, -1, 3)).max(axis=2)
        clean = pal[d.argmin(axis=1)].reshape(NY, NX, 3)
    else:
        clean = cells
    cells = clean

    sprite = Image.fromarray(
        np.dstack([cells.astype(np.uint8),
                   np.where(is_bg, 0, 255).astype(np.uint8)]), "RGBA"
    )
    return sprite, pal


def build_canvas(sprite):
    """精灵 → Apple 规范 1024 画布。"""
    bbox = sprite.getbbox()
    if bbox:
        sprite = sprite.crop(bbox)
    sw, sh = sprite.size

    # 最近邻整数倍放大：这一步是"硬边"的来源
    k = max(1, int(CONTENT // max(sw, sh)))
    big = sprite.resize((sw * k, sh * k), Image.NEAREST)
    log(f"精灵 {sw}×{sh} → {k}x 最近邻 → {big.size[0]}×{big.size[1]}")

    # 补齐到内容区（最后一步非整数缩放，幅度小，可接受）
    if max(big.size) < CONTENT:
        s = CONTENT / max(big.size)
        big = big.resize((int(round(big.width * s)), int(round(big.height * s))),
                         Image.LANCZOS)
    log(f"内容区尺寸 {big.size[0]}×{big.size[1]}")

    cur = (CANVAS - big.width) // 2
    coy = int(round((CANVAS - big.height) / 2 - CANVAS * 0.022))
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(big, (cur, coy))
    return canvas


def write_icns(canvas, path):
    """自己按 ICNS 容器格式拼，补齐 Pillow 不写的 icp4/icp5 小档。

    Pillow 的 save("ICNS") 只写 ic07~ic14；缺 icp4(16)/icp5(32) 时，
    Finder 列表视图和菜单栏要么糊、要么回落通用文档图标。
    自己拼一遍 11 档即可，不引入任何依赖。
    """
    # 类型 → 像素尺寸（ic11~ic14 是各自基准档的 @2x）
    blocks = [
        ("icp4", 16), ("icp5", 32), ("icp6", 64),
        ("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024),
        ("ic11", 32), ("ic12", 64), ("ic13", 256), ("ic14", 512),
    ]
    cache = {}
    chunks = []
    for typ, px in blocks:
        if px not in cache:
            buf = io.BytesIO()
            canvas.resize((px, px), Image.LANCZOS).save(buf, "PNG", optimize=True)
            cache[px] = buf.getvalue()
        chunks.append((typ, cache[px]))

    body = b"".join(
        t.encode("ascii") + struct.pack(">I", len(d) + 8) + d for t, d in chunks
    )
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main():
    if not os.path.exists(SRC):
        log(f"✗ 找不到源图 {SRC}")
        return 1
    os.makedirs(BUILD, exist_ok=True)

    log("=" * 60)
    log("Tsumigeya 图标生成（像素复刻）")
    log("=" * 60)

    sprite, pal = extract_sprite()
    sprite.save(os.path.join(BUILD, "sprite-source.png"))
    log("精灵存档 → build/sprite-source.png")

    canvas = build_canvas(sprite)
    master = os.path.join(BUILD, "icon_1024.png")
    canvas.save(master, "PNG", optimize=True)
    log(f"母版 → build/icon_1024.png")

    # ---- icns ----
    icns_path = os.path.join(BUILD, "icon.icns")
    write_icns(canvas, icns_path)
    log(f"[OK] icon.icns  {os.path.getsize(icns_path):,} 字节  11 档")

    # ---- ico ----
    ico_path = os.path.join(BUILD, "icon.ico")
    canvas.save(ico_path, "ICO",
                sizes=[(256, 256), (128, 128), (64, 64), (48, 48),
                       (32, 32), (24, 24), (16, 16)])
    log(f"[OK] icon.ico   {os.path.getsize(ico_path):,} 字节  7 档")

    # ---- 兜底 png ----
    png_path = os.path.join(BUILD, "icon.png")
    canvas.resize((512, 512), Image.LANCZOS).save(png_path, "PNG", optimize=True)
    log(f"[OK] icon.png   512×512  {os.path.getsize(png_path):,} 字节")

    # ---- iconset（Apple iconutil 的 10 档，便于核对）----
    ICONSET = os.path.join(BUILD, "iconset")
    if os.path.isdir(ICONSET):
        shutil.rmtree(ICONSET)
    os.makedirs(ICONSET)
    for name, px in [
        ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
    ]:
        canvas.resize((px, px), Image.LANCZOS).save(
            os.path.join(ICONSET, name), "PNG")
    log(f"[OK] iconset/  10 档")

    # ---- 调色板清单（便于改图时对齐用色）----
    with open(os.path.join(BUILD, "palette.txt"), "w", encoding="utf-8") as f:
        f.write(f"原始分辨率 {NX}×{NY}，{len(pal)} 色\n\n")
        for i, c in enumerate(pal.astype(int), 1):
            f.write(f"{i:2d}. #{c[0]:02x}{c[1]:02x}{c[2]:02x}\n")
    log(f"[OK] palette.txt")

    # ---- 校验 ----
    aa = np.asarray(canvas)[:, :, 3]
    ys_, xs_ = np.where(aa > 128)
    log("\n=== 校验 ===")
    log(f"四角 alpha: {aa[0, 0]} {aa[0, -1]} {aa[-1, 0]} {aa[-1, -1]}（应全 0）")
    log(f"内容 bbox {xs_.max() - xs_.min() + 1}×{ys_.max() - ys_.min() + 1}"
        f"  中心 ({(xs_.min() + xs_.max()) / 2:.1f}, {(ys_.min() + ys_.max()) / 2:.1f})")
    log(f"内容尺寸目标 {CONTENT}，允许 ±8")
    ok = abs((ys_.max() - ys_.min() + 1) - CONTENT) <= 8
    log("✅ 通过" if ok else "❌ 内容尺寸偏离规范")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
