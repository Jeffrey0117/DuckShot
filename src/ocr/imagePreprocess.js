// 圖片預處理以提升 OCR 辨識率（Tesseract 後備路徑用）。
// 改用 sharp（libvips 原生，已隨 @gutenye/ocr-node 內建）取代 jimp：
// 安裝檔少掉 jimp 全家 ~26MB，縮放/卷積/編碼在原生層跑，老機器不再被純 JS 逐像素迴圈拖慢。
// 行為對齊舊版：放大 → 去掉高飽和亮色 UI 元素（非藝術字時）→ 灰階 → 自動反轉深色背景 →
// 依原始對比調整對比 → 去噪 → （選用）銳化 → （選用）Otsu 二值化 → PNG base64
const sharp = require("sharp");

async function preprocessImage(base64Image, options) {
  const opts = {
    scale: options?.scale ?? 2,
    grayscale: options?.grayscale ?? true,
    invert: options?.invert ?? "auto",
    contrast: options?.contrast ?? 1.5,
    threshold: options?.threshold ?? 0,
    sharpen: options?.sharpen ?? true,
    denoise: options?.denoise ?? true,
  };

  const pureBase64 = base64Image.includes(",") ? base64Image.split(",")[1] : base64Image;
  const input = Buffer.from(pureBase64, "base64");

  // 1) 放大（RGB raw，去掉 alpha 讓後面所有像素運算都是固定 3 通道）
  let pipeline = sharp(input).flatten({ background: "#ffffff" }).removeAlpha();
  const meta = await pipeline.metadata();
  const originalSize = { w: meta.width, h: meta.height };
  if (opts.scale !== 1) {
    pipeline = pipeline.resize({
      width: Math.max(1, Math.round(meta.width * opts.scale)),
      height: Math.max(1, Math.round(meta.height * opts.scale)),
      kernel: "lanczos3",
    });
  }
  const rgb = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const { width, height } = rgb.info;
  const data = rgb.data; // RGB

  // 2) 彩色像素統計：佔比高 → 可能是藝術字，不要過濾顏色
  let coloredPixels = 0;
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    if (max > 50 && (max - min) / max > 0.4) coloredPixels += 1;
  }
  const hasColoredText = coloredPixels > width * height * 0.05;
  if (!hasColoredText) {
    // 只過濾高飽和且亮的像素（如綠色游標），塗白
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      if (max > 0 && (max - min) / max > 0.6 && (r + g + b) / 3 > 150) {
        data[i] = data[i + 1] = data[i + 2] = 255;
      }
    }
  }

  // 3) 灰階（之後全部以單通道運算；grayscale=false 時仍以亮度做後續統計）
  const gray = Buffer.alloc(width * height);
  for (let i = 0, j = 0; i < data.length; i += 3, j++) {
    gray[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114 + 500) / 1000;
  }

  // 4) 亮度統計 → 自動反轉深色背景
  let total = 0, minB = 255, maxB = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    total += v;
    if (v < minB) minB = v;
    if (v > maxB) maxB = v;
  }
  const avgBrightness = total / gray.length;
  const contrastRange = maxB - minB;
  const shouldInvert = opts.invert === "auto" ? avgBrightness < 128 : !!opts.invert;
  if (shouldInvert) {
    for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i];
  }

  // 5) 對比：原始對比已高則減半；對應 jimp contrast(v) 的 factor = (v+1)/(1-v)
  if (opts.contrast !== 1) {
    const adjusted = contrastRange > 200 ? opts.contrast * 0.5 : opts.contrast;
    const v = Math.min(1, Math.max(-1, adjusted - 1));
    if (v !== 0 && v < 1) {
      const factor = (v + 1) / (1 - v);
      for (let i = 0; i < gray.length; i++) {
        const out = factor * (gray[i] - 127.5) + 127.5;
        gray[i] = out < 0 ? 0 : out > 255 ? 255 : out;
      }
    }
  }

  // 6) 去噪：與周圍 8 格平均差太多的孤立點用平均值取代（單通道、讀舊寫新）
  if (opts.denoise && width > 2 && height > 2) {
    const src = Buffer.from(gray);
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const idx = row + x;
        const avg =
          (src[idx - width - 1] + src[idx - width] + src[idx - width + 1] +
            src[idx - 1] + src[idx + 1] +
            src[idx + width - 1] + src[idx + width] + src[idx + width + 1]) / 8;
        if (Math.abs(src[idx] - avg) > 80) gray[idx] = Math.round(avg);
      }
    }
  }

  let image = sharp(gray, { raw: { width, height, channels: 1 } });

  // 7) 銳化（溫和卷積核，與舊版相同）
  if (opts.sharpen) {
    image = image.convolve({ width: 3, height: 3, kernel: [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0] });
  }

  // 8) Otsu 二值化（只在明確要求時）
  if (opts.threshold > 0) {
    const cur = opts.sharpen ? await image.raw().toBuffer() : gray;
    const hist = new Array(256).fill(0);
    for (let i = 0; i < cur.length; i++) hist[cur[i]]++;
    const totalPx = cur.length;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let w0 = 0, sum0 = 0, best = 128, maxVar = 0;
    for (let t = 1; t < 255; t++) {
      w0 += hist[t - 1];
      sum0 += (t - 1) * hist[t - 1];
      const w1 = totalPx - w0;
      if (w0 === 0 || w1 === 0) continue;
      const m0 = sum0 / w0, m1 = (sumAll - sum0) / w1;
      const variance = (w0 / totalPx) * (w1 / totalPx) * (m0 - m1) * (m0 - m1);
      if (variance > maxVar) { maxVar = variance; best = t; }
    }
    const bin = Buffer.alloc(cur.length);
    for (let i = 0; i < cur.length; i++) bin[i] = cur[i] > best ? 255 : 0;
    image = sharp(bin, { raw: { width, height, channels: 1 } });
  }

  const png = await image.png().toBuffer();
  console.log(`Preprocess: ${originalSize.w}x${originalSize.h} -> ${width}x${height} (invert=${shouldInvert}, colored=${hasColoredText})`);
  return "data:image/png;base64," + png.toString("base64");
}

module.exports = { preprocessImage };
