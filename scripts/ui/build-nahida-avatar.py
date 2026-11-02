#!/usr/bin/env python3
"""
从原始立绘裁出 Nahida Chat 的纳西妲头像资产。

为什么需要这个脚本：原图 D:\\NAHIDA\\例子\\头像.png 是 2880x2880 的方形胸像，
头像要的是**脸部特写**，手裁一次就再也没法复现，所以裁切参数全部固定在
下面的 CROP 里，改构图只改这几个数，重新跑一遍即可。

尺寸变更记录（2026-11-02）：
  显示尺寸从 28px 提到 72px（侧栏头像已整体删除，头像只保留在消息列表）。
  72px x 3 倍屏 = 216px，所以 OUT_SIZE 从 128 提到 256，留足高分屏余量。

输出（写进 renderer 资产目录，由 assets/nahida/index.ts 用 import 引用）：
  avatar_transparent.png       日间
  avatar_dark_transparent.png  夜间

两张都是圆角透明遮罩的 PNG。

跑法：
  python scripts/ui/build-nahida-avatar.py
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit('需要 Pillow：pip install Pillow')

ROOT = Path(__file__).resolve().parents[2]
SRC = Path(r'D:\NAHIDA\例子\头像.png')
OUT_DIR = ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'nahida'

# 裁切参数：以「2048 宽」的参考坐标系给出，脚本按原图实际宽度自动换算。
#   cx / cy = 正方形裁切框的中心；side = 正方形边长
# 经验：脸要正、眼睛落在中线上方一点，头顶留出头发体积（否则小尺寸下只剩一张脸）。
# 2026-11-02 复核：side 1500 / 参考宽 2048 = 73%，与用户选定的「半身 72%」一致，保持不变。
CROP = {'cx': 900, 'cy': 820, 'side': 1500}
REFERENCE_WIDTH = 2048

# 输出边长：显示 72px，3 倍屏 216px，256 留余量。
OUT_SIZE = 256

# 圆角半径比例（相对边长）。与 CSS 的 border-radius 19px / 72px = 26% 对齐。
RADIUS_RATIO = 0.26

# 夜间那张压一点亮度并整体偏冷，避免把日间的暖绿直接怼到深色画布上。
DARK_BRIGHTNESS = 0.94


def crop_square(src: Image.Image) -> Image.Image:
    """按 CROP 的参数裁出正方形，并缩放到 OUT_SIZE。"""
    width, height = src.size
    scale = width / REFERENCE_WIDTH
    cx = CROP['cx'] * scale
    cy = CROP['cy'] * scale
    side = CROP['side'] * scale

    left = int(round(cx - side / 2))
    top = int(round(cy - side / 2))
    left = max(0, min(left, width - int(side)))
    top = max(0, min(top, height - int(side)))
    box = (left, top, left + int(side), top + int(side))
    return src.crop(box).resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)


def rounded_mask(size: int) -> Image.Image:
    """圆角透明遮罩。用 4 倍超采样再缩小，边缘才不会有锯齿。"""
    factor = 4
    big = Image.new("L", (size * factor, size * factor), 0)
    radius = int(size * factor * RADIUS_RATIO)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * factor - 1, size * factor - 1), radius=radius, fill=255
    )
    return big.resize((size, size), Image.LANCZOS)


def main() -> None:
    if not SRC.exists():
        sys.exit(f'找不到源图：{SRC}')

    src = Image.open(SRC).convert('RGB')
    print(f'源图 {SRC.name}  {src.size[0]}x{src.size[1]}')

    base = crop_square(src).convert('RGBA')
    mask = rounded_mask(OUT_SIZE)
    base.putalpha(mask)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    light_path = OUT_DIR / 'avatar_transparent.png'
    base.save(light_path, optimize=True)
    print(f'写出 {light_path.relative_to(ROOT)}  {light_path.stat().st_size} bytes')

    dark = base.copy()
    r, g, b, a = dark.split()
    f = DARK_BRIGHTNESS
    r = r.point(lambda v: int(v * f))
    g = g.point(lambda v: int(v * f))
    b = b.point(lambda v: int(v * f))
    dark = Image.merge('RGBA', (r, g, b, a))

    dark_path = OUT_DIR / 'avatar_dark_transparent.png'
    dark.save(dark_path, optimize=True)
    print(f'写出 {dark_path.relative_to(ROOT)}  {dark_path.stat().st_size} bytes')


if __name__ == '__main__':
    main()
