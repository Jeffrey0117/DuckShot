// 圖片預處理以提升 OCR 辨識率（移植自 Screenshot-OCR src/main/imagePreprocess.ts）
// 針對中文藝術字體優化
const { Jimp } = require("jimp");

async function preprocessImage(base64Image, options) {
  const opts = {
    scale: options?.scale ?? 2, // 降低放大倍數，避免模糊
    grayscale: options?.grayscale ?? true,
    invert: options?.invert ?? "auto",
    contrast: options?.contrast ?? 1.5, // 降低對比度增強，保留更多細節
    threshold: options?.threshold ?? 0, // 預設不做二值化，保留灰階
    sharpen: options?.sharpen ?? true,
    denoise: options?.denoise ?? true,
  };

  // 移除 data URI 前綴
  let pureBase64 = base64Image;
  if (base64Image.includes(",")) {
    pureBase64 = base64Image.split(",")[1];
  }

  const buffer = Buffer.from(pureBase64, "base64");
  let image = await Jimp.read(buffer);

  const originalSize = { w: image.width, h: image.height };

  // 放大圖片（使用較佳的插值方法）
  if (opts.scale !== 1) {
    const newWidth = Math.round(image.width * opts.scale);
    const newHeight = Math.round(image.height * opts.scale);
    image = image.resize({ w: newWidth, h: newHeight });
  }

  // 計算原始圖片特徵
  let hasColoredText = false;
  let colorVariance = 0;
  const colorSamples = [];

  image.scan((_x, _y, idx) => {
    const r = image.bitmap.data[idx + 0];
    const g = image.bitmap.data[idx + 1];
    const b = image.bitmap.data[idx + 2];

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;

    // 記錄飽和度高的像素數量
    if (saturation > 0.4 && max > 50) {
      colorSamples.push(saturation);
    }
  });

  // 如果彩色像素佔比高，可能是藝術字，不要過濾顏色
  hasColoredText = colorSamples.length > image.width * image.height * 0.05;
  colorVariance = colorSamples.length;

  console.log(`Preprocess: coloredPixels=${colorVariance}, hasColoredText=${hasColoredText}`);

  // 只過濾明顯的游標/UI 元素（高飽和度的亮色），保留藝術字
  if (!hasColoredText) {
    image.scan((_x, _y, idx) => {
      const r = image.bitmap.data[idx + 0];
      const g = image.bitmap.data[idx + 1];
      const b = image.bitmap.data[idx + 2];

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const brightness = (r + g + b) / 3;

      // 只過濾高飽和度且亮的像素（如綠色游標）
      if (saturation > 0.6 && brightness > 150) {
        image.bitmap.data[idx + 0] = 255;
        image.bitmap.data[idx + 1] = 255;
        image.bitmap.data[idx + 2] = 255;
      }
    });
  }

  // 轉灰階
  if (opts.grayscale) {
    image = image.greyscale();
  }

  // 計算平均亮度和對比度
  let totalBrightness = 0;
  let minBrightness = 255;
  let maxBrightness = 0;
  const pixelCount = image.width * image.height;

  image.scan((_x, _y, idx) => {
    const gray = image.bitmap.data[idx];
    totalBrightness += gray;
    minBrightness = Math.min(minBrightness, gray);
    maxBrightness = Math.max(maxBrightness, gray);
  });

  const avgBrightness = totalBrightness / pixelCount;
  const contrastRange = maxBrightness - minBrightness;

  // 自動偵測深色背景並反轉
  let shouldInvert = false;
  if (opts.invert === "auto") {
    shouldInvert = avgBrightness < 128;
    console.log(`Preprocess: avgBrightness=${avgBrightness.toFixed(1)}, contrast=${contrastRange}, invert=${shouldInvert}`);
  } else {
    shouldInvert = opts.invert;
  }

  if (shouldInvert) {
    image = image.invert();
  }

  // 增強對比度（根據原始對比度調整）
  if (opts.contrast !== 1) {
    // 如果原始對比度已經夠高，減少增強
    const adjustedContrast = contrastRange > 200 ? opts.contrast * 0.5 : opts.contrast;
    const contrastValue = Math.min(1, Math.max(-1, adjustedContrast - 1));
    image = image.contrast(contrastValue);
  }

  // 去噪處理 - 使用中值濾波概念（簡化版）
  if (opts.denoise) {
    // 找出孤立的噪點並移除
    const width = image.width;
    const height = image.height;
    const data = image.bitmap.data;

    // 複製一份用於判斷
    const originalData = Buffer.from(data);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;
        const current = originalData[idx];

        // 收集周圍 8 個像素
        const neighbors = [
          originalData[((y - 1) * width + (x - 1)) * 4],
          originalData[((y - 1) * width + x) * 4],
          originalData[((y - 1) * width + (x + 1)) * 4],
          originalData[(y * width + (x - 1)) * 4],
          originalData[(y * width + (x + 1)) * 4],
          originalData[((y + 1) * width + (x - 1)) * 4],
          originalData[((y + 1) * width + x) * 4],
          originalData[((y + 1) * width + (x + 1)) * 4],
        ];

        const avgNeighbor = neighbors.reduce((a, b) => a + b, 0) / 8;

        // 如果當前像素與周圍差異太大，可能是噪點
        if (Math.abs(current - avgNeighbor) > 80) {
          // 用周圍平均值替代
          data[idx] = Math.round(avgNeighbor);
          data[idx + 1] = Math.round(avgNeighbor);
          data[idx + 2] = Math.round(avgNeighbor);
        }
      }
    }
  }

  // 銳化處理 - 強化文字邊緣
  if (opts.sharpen) {
    try {
      // 較溫和的銳化卷積核
      const sharpenKernel = [
        [0, -0.5, 0],
        [-0.5, 3, -0.5],
        [0, -0.5, 0],
      ];
      if (typeof image.convolute === "function") {
        image = image.convolute(sharpenKernel);
        console.log("Preprocess: Applied mild sharpening");
      }
    } catch {
      console.log("Preprocess: Sharpening not available");
    }
  }

  // 二值化處理 - 只在明確需要時使用
  if (opts.threshold > 0) {
    // 使用 Otsu's method 概念找最佳閾值
    const histogram = new Array(256).fill(0);

    image.scan((_x, _y, idx) => {
      const gray = image.bitmap.data[idx];
      histogram[gray]++;
    });

    // 找雙峰之間的最佳閾值
    let bestThreshold = 128;
    let maxVariance = 0;
    const total = image.width * image.height;

    for (let t = 1; t < 255; t++) {
      let w0 = 0, w1 = 0, sum0 = 0, sum1 = 0;

      for (let i = 0; i < t; i++) {
        w0 += histogram[i];
        sum0 += i * histogram[i];
      }
      for (let i = t; i < 256; i++) {
        w1 += histogram[i];
        sum1 += i * histogram[i];
      }

      if (w0 === 0 || w1 === 0) continue;

      const mean0 = sum0 / w0;
      const mean1 = sum1 / w1;
      const variance = (w0 / total) * (w1 / total) * Math.pow(mean0 - mean1, 2);

      if (variance > maxVariance) {
        maxVariance = variance;
        bestThreshold = t;
      }
    }

    console.log(`Preprocess: Otsu threshold=${bestThreshold}`);

    // 應用二值化
    image.scan((_x, _y, idx) => {
      const gray = image.bitmap.data[idx];
      const newValue = gray > bestThreshold ? 255 : 0;
      image.bitmap.data[idx + 0] = newValue;
      image.bitmap.data[idx + 1] = newValue;
      image.bitmap.data[idx + 2] = newValue;
    });
  }

  const newSize = { w: image.width, h: image.height };
  console.log(`Preprocess: ${originalSize.w}x${originalSize.h} -> ${newSize.w}x${newSize.h}`);

  // 輸出為 base64
  const outputBase64 = await image.getBase64("image/png");

  return outputBase64;
}

module.exports = { preprocessImage };
