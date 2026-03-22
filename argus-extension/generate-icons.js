/**
 * Argus icon generator — pure Node.js, no external dependencies.
 *
 * Produces icons/icon16.png, icons/icon48.png, icons/icon128.png.
 * Each icon is a deep-navy circle with a stylised eye (white iris, blue pupil).
 *
 * Run with:  node generate-icons.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── CRC-32 ───────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── PNG writer ───────────────────────────────────────────────────────────────

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf   = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Build a PNG from RGBA pixel data.
 * @param {number}   width
 * @param {number}   height
 * @param {(x:number, y:number) => [number,number,number,number]} getPixel
 */
function makePNG(width, height, getPixel) {
  // Raw image data: one filter byte per row + 4 bytes (RGBA) per pixel
  const rowStride = 1 + width * 4;
  const raw = Buffer.alloc(rowStride * height, 0);

  for (let y = 0; y < height; y++) {
    raw[y * rowStride] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const off = y * rowStride + 1 + x * 4;
      raw[off]     = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // colour type: RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic bytes

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Icon drawing ─────────────────────────────────────────────────────────────

// Palette (RGBA)
const TRANSPARENT = [0,   0,   0,   0  ];
const NAVY        = [10,  22,  40,  255 ]; // #0A1628
const WHITE       = [255, 255, 255, 255 ];
const BLUE        = [59,  130, 246, 255 ]; // #3B82F6
const BLUE_DARK   = [37,  99,  235, 255 ]; // #2563EB (pupil rim)

/**
 * Anti-aliased coverage at pixel centre (x+0.5, y+0.5) for a circle of
 * radius r centred at (cx, cy).  Returns a value in [0, 1].
 */
function circCoverage(px, py, cx, cy, r) {
  const dx = px + 0.5 - cx;
  const dy = py + 0.5 - cy;
  const d  = Math.sqrt(dx * dx + dy * dy);
  // Feather over ±0.7 px
  return Math.max(0, Math.min(1, (r + 0.7 - d) / 1.4));
}

/** Blend src (RGBA) over dst (RGBA) using src alpha × extraAlpha. */
function blend(dst, src, alpha = 1) {
  const a = (src[3] / 255) * alpha;
  return [
    Math.round(dst[0] * (1 - a) + src[0] * a),
    Math.round(dst[1] * (1 - a) + src[1] * a),
    Math.round(dst[2] * (1 - a) + src[2] * a),
    Math.round(dst[3] + (255 - dst[3]) * a),
  ];
}

function drawIcon(size) {
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 0.5; // outer navy circle

  // Eye ellipse  (horizontal eye-almond shape)
  const eyeRx = outerR * 0.54;
  const eyeRy = outerR * 0.30;

  // Pupil (circle)
  const pupilR = outerR * 0.17;

  // Specular highlight (tiny white dot, offset up-left)
  const hiR  = Math.max(0.8, outerR * 0.065);
  const hiOx = -outerR * 0.08;
  const hiOy = -outerR * 0.09;

  return makePNG(size, size, (x, y) => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;

    // Outside the outer circle → transparent
    const outerCov = circCoverage(x, y, cx, cy, outerR);
    if (outerCov === 0) return TRANSPARENT;

    // Start with navy background
    let pixel = blend(TRANSPARENT, NAVY, outerCov);

    // Eye white — ellipse check
    const eyeQ = (dx * dx) / (eyeRx * eyeRx) + (dy * dy) / (eyeRy * eyeRy);
    // Feather the ellipse edge (±0.05 in normalised coords)
    const eyeAlpha = Math.max(0, Math.min(1, (1.05 - eyeQ) / 0.10));
    if (eyeAlpha > 0) pixel = blend(pixel, WHITE, eyeAlpha);

    // Pupil — circle
    const pupilCov = circCoverage(x, y, cx, cy, pupilR);
    if (pupilCov > 0) pixel = blend(pixel, BLUE, pupilCov);

    // Pupil rim (slightly darker ring at edge)
    const rimCov = circCoverage(x, y, cx, cy, pupilR + 1.2) - pupilCov;
    if (rimCov > 0) pixel = blend(pixel, BLUE_DARK, rimCov * 0.5);

    // Specular highlight
    const hiCov = circCoverage(x, y, cx + hiOx, cy + hiOy, hiR);
    if (hiCov > 0) pixel = blend(pixel, WHITE, hiCov * 0.85);

    return pixel;
  });
}

// ─── Generate & write ─────────────────────────────────────────────────────────

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png     = drawIcon(size);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`✓  icon${size}.png  (${png.length} bytes)`);
}

console.log('\nIcons written to argus-extension/icons/');
