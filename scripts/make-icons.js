// Recolor the green duck -> soft light orange, then emit all PNG sizes + a multi-size .ico
// Run with: electron _logo_src/make-icons.js
const { app, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SRC = path.join(__dirname);
const OUT = path.join(__dirname, "..", "assets", "icons");

// --- color helpers (operate on 0..255) ---
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return [h, s, l];
}
function hue2rgb(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Recolor a BGRA bitmap buffer in place: green body -> soft light orange
function recolorBGRA(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3];
    if (a < 8) continue; // transparent
    const B = buf[i], G = buf[i + 1], R = buf[i + 2];
    let [h, s, l] = rgbToHsl(R, G, B);
    // green / yellow-green range only; leave orange beak, pink cheeks, etc.
    if (h >= 55 && h <= 175 && s > 0.1) {
      const isOutline = l < 0.3;
      h = 31; // soft orange target
      if (isOutline) {
        // dark outline -> deep orange-brown, keep it dark for contrast
        s = Math.min(1, s + 0.2);
        l = Math.min(0.34, l * 1.15);
      } else {
        // body -> light, vivid, soft orange ("橘色淺淺")
        s = Math.min(0.95, 0.58 + s * 0.35);
        l = Math.min(0.82, 0.36 + l * 0.52);
      }
      const [r2, g2, b2] = hslToRgb(h, s, l);
      buf[i] = b2; buf[i + 1] = g2; buf[i + 2] = r2;
    }
  }
  return buf;
}

function recoloredImageFromFile(file) {
  const img = nativeImage.createFromPath(file);
  const size = img.getSize();
  const bmp = Buffer.from(img.toBitmap()); // BGRA
  recolorBGRA(bmp);
  return nativeImage.createFromBitmap(bmp, { width: size.width, height: size.height });
}

// Build a .ico containing PNGs of several sizes (Vista+ supports PNG-in-ICO)
function buildIco(baseImage, sizes) {
  const pngs = sizes.map((s) => ({
    size: s,
    data: baseImage.resize({ width: s, height: s, quality: "best" }).toPNG(),
  }));
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngs.forEach((p, idx) => {
    const e = idx * 16;
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 0); // width (0 => 256)
    entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1); // height
    entries.writeUInt8(0, e + 2); // colors in palette
    entries.writeUInt8(0, e + 3); // reserved
    entries.writeUInt16LE(1, e + 4); // color planes
    entries.writeUInt16LE(32, e + 6); // bpp
    entries.writeUInt32LE(p.data.length, e + 8); // size of data
    entries.writeUInt32LE(offset, e + 12); // offset
    offset += p.data.length;
  });
  return Buffer.concat([header, entries, ...pngs.map((p) => p.data)]);
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });

  const duck1 = recoloredImageFromFile(path.join(SRC, "duck_01.png"));
  const duck2 = recoloredImageFromFile(path.join(SRC, "duck_02.png"));

  // UI / app PNGs
  fs.writeFileSync(path.join(OUT, "logo-imgup.png"), duck1.toPNG());
  fs.writeFileSync(path.join(OUT, "app-icon.png"), duck1.resize({ width: 512, height: 512, quality: "best" }).toPNG());
  fs.writeFileSync(path.join(OUT, "logo-imgup2.png"), duck2.toPNG());

  // Windows multi-size icon
  const ico = buildIco(duck1, [16, 24, 32, 48, 64, 128, 256]);
  fs.writeFileSync(path.join(OUT, "app-icon.ico"), ico);

  // Small preview for visual check
  fs.writeFileSync(path.join(SRC, "preview-orange-duck.png"), duck1.resize({ width: 256, height: 256, quality: "best" }).toPNG());

  console.log("ICONS_DONE",
    "logo-imgup.png", fs.statSync(path.join(OUT, "logo-imgup.png")).size,
    "app-icon.png", fs.statSync(path.join(OUT, "app-icon.png")).size,
    "logo-imgup2.png", fs.statSync(path.join(OUT, "logo-imgup2.png")).size,
    "app-icon.ico", fs.statSync(path.join(OUT, "app-icon.ico")).size);
  app.quit();
}
main().catch((e) => { console.error("ICON_ERR", e); app.quit(); });
