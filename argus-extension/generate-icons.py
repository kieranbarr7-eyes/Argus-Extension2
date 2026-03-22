"""
Argus icon generator — pure Python 3, no external dependencies.

Produces icons/icon16.png, icons/icon48.png, icons/icon128.png.
Each icon is a deep-navy circle with a stylised eye (white iris, blue pupil).

Run with:  python generate-icons.py
"""

import math
import struct
import zlib
import os

# ── Colours (RGBA) ────────────────────────────────────────────────────────────
TRANSPARENT = (0,   0,   0,   0  )
NAVY        = (10,  22,  40,  255)   # #0A1628
WHITE       = (255, 255, 255, 255)
BLUE        = (59,  130, 246, 255)   # #3B82F6
BLUE_DARK   = (37,  99,  235, 255)   # #2563EB

# ── PNG helpers ───────────────────────────────────────────────────────────────

def _chunk(tag: bytes, data: bytes) -> bytes:
    c = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", c)

def make_png(width: int, height: int, pixels) -> bytes:
    """
    pixels: list of lists of (r,g,b,a) tuples, row-major.
    """
    raw_rows = []
    for row in pixels:
        row_bytes = bytearray([0])       # filter byte: None
        for r, g, b, a in row:
            row_bytes += bytes([r, g, b, a])
        raw_rows.append(bytes(row_bytes))

    raw = b"".join(raw_rows)
    compressed = zlib.compress(raw, 9)

    ihdr_data = (
        struct.pack(">II", width, height)
        + bytes([8, 6, 0, 0, 0])          # bit-depth=8, colour=RGBA, rest 0
    )

    PNG_SIG = b"\x89PNG\r\n\x1a\n"
    return (
        PNG_SIG
        + _chunk(b"IHDR", ihdr_data)
        + _chunk(b"IDAT", compressed)
        + _chunk(b"IEND", b"")
    )

# ── Pixel helpers ─────────────────────────────────────────────────────────────

def circ_coverage(px, py, cx, cy, r):
    """Anti-aliased circle coverage at pixel centre (px+0.5, py+0.5)."""
    dx = px + 0.5 - cx
    dy = py + 0.5 - cy
    d  = math.sqrt(dx*dx + dy*dy)
    return max(0.0, min(1.0, (r + 0.7 - d) / 1.4))

def blend(dst, src, alpha=1.0):
    """Blend src RGBA over dst RGBA using src.alpha * alpha."""
    a = (src[3] / 255.0) * alpha
    return (
        int(round(dst[0] * (1-a) + src[0] * a)),
        int(round(dst[1] * (1-a) + src[1] * a)),
        int(round(dst[2] * (1-a) + src[2] * a)),
        int(round(dst[3] + (255 - dst[3]) * a)),
    )

# ── Icon drawing ──────────────────────────────────────────────────────────────

def draw_icon(size: int) -> bytes:
    cx = cy = size / 2.0
    outer_r = size / 2.0 - 0.5

    eye_rx = outer_r * 0.54    # horizontal semi-axis of eye ellipse
    eye_ry = outer_r * 0.30    # vertical semi-axis
    pupil_r = outer_r * 0.17   # pupil radius

    # Specular highlight offset (up-left of centre)
    hi_r  = max(0.8, outer_r * 0.065)
    hi_cx = cx - outer_r * 0.08
    hi_cy = cy - outer_r * 0.09

    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy

            outer_cov = circ_coverage(x, y, cx, cy, outer_r)
            if outer_cov == 0.0:
                row.append(TRANSPARENT)
                continue

            # Start with navy
            pixel = blend(TRANSPARENT, NAVY, outer_cov)

            # Eye ellipse (white iris)
            eye_q = (dx*dx) / (eye_rx*eye_rx) + (dy*dy) / (eye_ry*eye_ry)
            eye_alpha = max(0.0, min(1.0, (1.05 - eye_q) / 0.10))
            if eye_alpha > 0:
                pixel = blend(pixel, WHITE, eye_alpha)

            # Pupil (blue)
            pupil_cov = circ_coverage(x, y, cx, cy, pupil_r)
            if pupil_cov > 0:
                pixel = blend(pixel, BLUE, pupil_cov)

            # Pupil rim (dark-blue feather at pupil edge)
            rim_cov = circ_coverage(x, y, cx, cy, pupil_r + 1.2) - pupil_cov
            if rim_cov > 0:
                pixel = blend(pixel, BLUE_DARK, rim_cov * 0.5)

            # Specular highlight
            hi_cov = circ_coverage(x, y, hi_cx, hi_cy, hi_r)
            if hi_cov > 0:
                pixel = blend(pixel, WHITE, hi_cov * 0.85)

            row.append(pixel)
        pixels.append(row)

    return make_png(size, size, pixels)

# ── Main ──────────────────────────────────────────────────────────────────────

icons_dir = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(icons_dir, exist_ok=True)

for size in [16, 48, 128]:
    png = draw_icon(size)
    out_path = os.path.join(icons_dir, f"icon{size}.png")
    with open(out_path, "wb") as f:
        f.write(png)
    print(f"  icon{size}.png  ({len(png)} bytes)")

print("\nIcons written to argus-extension/icons/")
