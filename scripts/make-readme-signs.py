# README 用的像素举牌娘动图：程序化绘制像素画，放大后输出透明 GIF。
# 用法：python3 scripts/make-readme-signs.py <Fusion Pixel 12px zh_hans 字体路径> [输出目录]
# 字体：Fusion Pixel Font（SIL OFL 1.1），https://github.com/TakWolf/fusion-pixel-font
import math, sys
from PIL import Image, ImageDraw, ImageFont

FONT = sys.argv[1] if len(sys.argv) > 1 else 'fusion-pixel-12px-proportional-zh_hans.ttf'
K = (59, 47, 63, 255)          # outline ink
HAIR, HAIR_D, HAIR_L = (242, 167, 189, 255), (214, 128, 156, 255), (255, 214, 226, 255)
MINT, MINT_D = (159, 224, 208, 255), (110, 190, 172, 255)
SKIN, SKIN_D = (255, 232, 218, 255), (244, 196, 180, 255)
BLUSH = (255, 156, 172, 255)
EYE, EYE_L = (176, 112, 52, 255), (255, 236, 190, 255)
GLASS = (222, 64, 82, 255)
WHITE, WHITE_D = (255, 255, 255, 255), (226, 220, 236, 255)
SCARF, SCARF_D = (236, 120, 150, 255), (204, 88, 120, 255)
SKIRT, SKIRT_D = (122, 104, 150, 255), (96, 80, 122, 255)
SHOE = (120, 82, 96, 255)
WOOD, WOOD_D = (196, 140, 96, 255), (150, 100, 66, 255)
BOARD, BOARD_D = (255, 250, 240, 255), (240, 226, 214, 255)
INK = (74, 58, 76, 255)
T = (0, 0, 0, 0)


def outline(im, color=K):
    """1px dark outline around every opaque pixel (4-neighbour)."""
    w, h = im.size
    src = im.load()
    out = im.copy()
    o = out.load()
    for y in range(h):
        for x in range(w):
            if src[x, y][3]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and src[nx, ny][3] and src[nx, ny] != color:
                    o[x, y] = color
                    break
    return out


def ellipse(d, cx, cy, rx, ry, fill):
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=fill)


def character(frame=0, blink=False):
    """Chibi girl on a 44×50 canvas; hands end at the top edge (y≈1) to grip the sign."""
    W_, H_ = 44, 56
    im = Image.new('RGBA', (W_, H_), T)
    d = ImageDraw.Draw(im)
    bob = [0, 0, 1, 1, 0, 0, 1, 1][frame % 8]
    hx, hy = 22, 17 + bob                       # head centre
    # back hair
    ellipse(d, hx, hy + 2, 13, 13, HAIR_D)
    # arms raised to the sign (drawn before body so the sleeves sit behind the head)
    for sx in (-1, 1):
        sh = (hx + sx * 7, hy + 15)
        el = (hx + sx * 16, hy + 3)
        hand = (hx + sx * 15, 2)
        d.line([sh, el], fill=WHITE, width=4)
        d.line([el, hand], fill=WHITE, width=4)
        ellipse(d, hand[0], hand[1], 2, 2, SKIN)
    # body (sailor uniform)
    by = hy + 13
    d.polygon([(hx - 7, by), (hx + 7, by), (hx + 9, by + 11), (hx - 9, by + 11)], fill=WHITE)
    d.polygon([(hx - 7, by), (hx + 7, by), (hx + 5, by + 4), (hx - 5, by + 4)], fill=WHITE_D)
    d.polygon([(hx - 3, by + 2), (hx + 3, by + 2), (hx, by + 7)], fill=SCARF)
    d.point([(hx - 1, by + 7), (hx, by + 8), (hx + 1, by + 7)], fill=SCARF_D)
    # skirt
    d.polygon([(hx - 9, by + 11), (hx + 9, by + 11), (hx + 11, by + 16), (hx - 11, by + 16)], fill=SKIRT)
    for x in range(hx - 8, hx + 11, 3):
        d.line([(x, by + 12), (x - 1, by + 16)], fill=SKIRT_D)
    # legs + shoes
    for sx in (-5, 2):
        d.rectangle((hx + sx, by + 17, hx + sx + 2, by + 20), fill=WHITE)
        d.rectangle((hx + sx - 1, by + 21, hx + sx + 3, by + 22), fill=SHOE)
    # braids over the shoulders, mint tips
    for sx in (-1, 1):
        bx = hx + sx * 10
        for i, yy in enumerate(range(hy + 8, hy + 22, 2)):
            sway = round(math.sin(frame * 0.8 + i * .7) * 0.5)
            col = HAIR if i < 4 else MINT if i < 6 else MINT_D
            d.rectangle((bx + sway - 1, yy, bx + sway + 1, yy + 1), fill=col)
    # face
    ellipse(d, hx, hy + 2, 11, 10, SKIN)
    # fringe
    fr = [(hx - 12, hy + 1)]
    pts = [-11, -8, -5, -2, 1, 4, 7, 10]
    for i, x in enumerate(pts):
        fr += [(hx + x, hy - 1 + (2 if i % 2 else 0)), (hx + x + 1, hy - 4)]
    fr += [(hx + 12, hy + 1), (hx + 12, hy - 9), (hx + 6, hy - 13), (hx - 6, hy - 13), (hx - 12, hy - 9)]
    d.polygon(fr, fill=HAIR)
    d.line([(hx - 8, hy - 9), (hx - 4, hy - 11)], fill=HAIR_L)
    d.point([(hx - 9, hy - 8), (hx + 5, hy - 10), (hx + 6, hy - 10)], fill=HAIR_L)
    # side locks
    for sx in (-1, 1):
        d.polygon([(hx + sx * 10, hy - 4), (hx + sx * 13, hy - 1), (hx + sx * 12, hy + 10), (hx + sx * 10, hy + 7)], fill=HAIR)
    # ahoge
    d.line([(hx, hy - 13), (hx + 2, hy - 16), (hx + 4, hy - 16), (hx + 5, hy - 15)], fill=HAIR)
    # eyes + glasses
    ey = hy + 2
    for sx in (-1, 1):
        ex = hx + sx * 5
        if blink:
            d.line([(ex - 2, ey + 1), (ex + 2, ey + 1)], fill=K)
            d.point([(ex - 2, ey), (ex + 2, ey)], fill=K)
        else:
            d.rectangle((ex - 1, ey - 1, ex + 1, ey + 2), fill=EYE)
            d.line([(ex - 1, ey - 2), (ex + 1, ey - 2)], fill=(107, 63, 42, 255))
            d.point((ex + sx * 2, ey - 2), fill=(107, 63, 42, 255))
            d.point((ex - 1, ey), fill=EYE_L)
            d.point((ex + 1, ey + 2), fill=(214, 156, 84, 255))
        d.line([(ex - 3, ey - 3), (ex + 3, ey - 3)], fill=GLASS)
        d.line([(ex - 3, ey + 4), (ex + 3, ey + 4)], fill=GLASS)
        d.line([(ex - 4, ey - 2), (ex - 4, ey + 3)], fill=GLASS)
        d.line([(ex + 4, ey - 2), (ex + 4, ey + 3)], fill=GLASS)
        d.point([(ex + sx * 3, ey + 6), (ex + sx * 4, ey + 6)], fill=BLUSH)
    d.line([(hx - 1, ey - 1), (hx + 1, ey - 1)], fill=GLASS)
    # cat mouth ω
    d.point([(hx - 2, ey + 6), (hx - 1, ey + 7), (hx, ey + 6), (hx + 1, ey + 7), (hx + 2, ey + 6)], fill=K)
    return outline(im)


def sign(lines, w=None):
    f = ImageFont.truetype(FONT, 12)
    tw = max(int(f.getlength(l)) for l in lines)
    w = w or tw + 14
    h = 12 * len(lines) + 15
    im = Image.new('RGBA', (w + 2, h + 2), T)
    d = ImageDraw.Draw(im)
    d.rectangle((1, 1, w, h), fill=WOOD)
    d.rectangle((3, 3, w - 2, h - 2), fill=BOARD)
    d.line([(3, h - 2), (w - 2, h - 2)], fill=BOARD_D)
    # draw text without anti-aliasing
    d.fontmode = '1'
    for i, l in enumerate(lines):
        lw = f.getlength(l)
        d.text((round((w + 2 - lw) / 2), 4 + i * 12), l, font=f, fill=INK)
    return outline(im)


def heart(c=(236, 120, 150, 255)):
    p = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...']
    im = Image.new('RGBA', (7, 6), T)
    for y, r in enumerate(p):
        for x, ch in enumerate(r):
            if ch == 'X': im.putpixel((x, y), c)
    im.putpixel((1, 1), (255, 220, 230, 255))
    return im


def compose(lines, frame, scale=4, sparkle=True):
    sg = sign(lines)
    ch = character(frame, blink=(frame == 5))
    bob = [0, 0, 1, 1, 0, 0, 1, 1][frame % 8]
    W_ = max(sg.width, ch.width) + 18
    H_ = sg.height + ch.height - 2
    im = Image.new('RGBA', (W_, H_), T)
    cx = W_ // 2
    sy = 1 + bob
    im.alpha_composite(sg, (cx - sg.width // 2, sy))
    im.alpha_composite(ch, (cx - ch.width // 2, sy + sg.height - 6))
    if sparkle:
        hb = heart()
        for x0, ph in ((2, 0), (W_ - 9, .5)):
            yy = int(H_ * .8 - ((frame / 8 + ph) % 1) * 26)
            im.alpha_composite(hb, (x0, yy))
    return im.resize((im.width * scale, im.height * scale), Image.NEAREST)


def gif(lines, path, scale=4):
    frames = [compose(lines, f, scale) for f in range(8)]
    KEY = (255, 0, 255)
    flat = []
    for f in frames:
        bg = Image.new('RGB', f.size, KEY)
        bg.paste(f, mask=f.split()[3].point(lambda a: 255 if a > 127 else 0))
        flat.append(bg)
    # one shared palette for all frames
    strip = Image.new('RGB', (flat[0].width, flat[0].height * len(flat)))
    for i, f in enumerate(flat): strip.paste(f, (0, i * f.height))
    pal = strip.quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    ps = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in flat]
    p = pal.getpalette(); n = len(p) // 3
    key = min(range(n), key=lambda i: sum((p[i*3+j]-KEY[j])**2 for j in range(3)))
    ps[0].save(path, save_all=True, append_images=ps[1:], duration=[200, 200, 200, 200, 200, 160, 200, 200], loop=0, disposal=2, transparency=key, optimize=False)


if __name__ == '__main__':
    out = sys.argv[2] if len(sys.argv) > 2 else '.github/assets/readme'
    for name, lines in [('welcome', ['欢迎来到', 'Tsumigeya!']), ('star', ['点个 Star', '好不好～']),
                        ('feedback', ['兼容性反馈', '募集中!']), ('mac', ['Mac 也要', '玩同人游戏!'])]:
        gif(lines, f'{out}/sign-{name}.gif', 3)
