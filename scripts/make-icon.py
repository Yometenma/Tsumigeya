"""从 assets/icon-source.jpg 生成 assets/icon.icns。

依赖 Pillow、NumPy；在仓库根运行 python scripts/make-icon.py。
源图经过 JPEG 压缩，先按像素网格取中位色并聚类，再放大以避免模糊与白边。
预览、母版及调色板写入 .dev-scratch/icons/。
"""
import io
import os
import struct
import sys
from collections import Counter

import numpy as np
from PIL import Image
from PIL import ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
BUILD = os.path.join(ROOT, ".dev-scratch", "icons")
SRC = os.path.join(ASSETS, "icon-source.jpg")

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
    log("精灵存档 → .dev-scratch/icons/sprite-source.png")

    canvas = build_canvas(sprite)
    master = os.path.join(BUILD, "icon_1024.png")
    canvas.save(master, "PNG", optimize=True)
    log(f"母版 → .dev-scratch/icons/icon_1024.png")

    # ---- icns ----
    icns_path = os.path.join(ASSETS, "icon.icns")
    write_icns(canvas, icns_path)
    log(f"[OK] icon.icns  {os.path.getsize(icns_path):,} 字节  11 档")

    # ---- 兜底 png ----
    png_path = os.path.join(BUILD, "icon.png")
    canvas.resize((512, 512), Image.LANCZOS).save(png_path, "PNG", optimize=True)
    log(f"[OK] icon.png   512×512  {os.path.getsize(png_path):,} 字节")

    # ---- iconset（Apple iconutil 的 10 档，便于核对）----
    ICONSET = os.path.join(BUILD, "iconset")
    os.makedirs(ICONSET, exist_ok=True)
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
