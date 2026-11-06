const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { preprocessImage } = require("../src/ocr/imagePreprocess");

// 深色背景 + 淺色方塊 + 一個高飽和綠點（模擬游標）
async function makeInput() {
  const w = 64, h = 32;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const inBox = x >= 16 && x < 48 && y >= 8 && y < 24;
    const v = inBox ? 230 : 25;
    data[i] = v; data[i + 1] = v; data[i + 2] = v;
  }
  // 亮黃點：高飽和（1.0）且亮度 170 > 150 → 會被當 UI 元素塗白
  const g = (3 * w + 3) * 3; data[g] = 255; data[g + 1] = 255; data[g + 2] = 0;
  const png = await sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  return "data:image/png;base64," + png.toString("base64");
}

async function stats(dataUrl) {
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0; for (const v of data) sum += v;
  return { width: info.width, height: info.height, mean: sum / data.length, data };
}

test("放大 2 倍、輸出 PNG data URL", async () => {
  const out = await preprocessImage(await makeInput(), { scale: 2, sharpen: false });
  assert.match(out, /^data:image\/png;base64,/);
  const s = await stats(out);
  assert.equal(s.width, 128);
  assert.equal(s.height, 64);
});

test("深色背景自動反轉成亮底暗字；高飽和亮綠點被塗白", async () => {
  const out = await preprocessImage(await makeInput(), { scale: 1, sharpen: false, denoise: false });
  const s = await stats(out);
  assert.ok(s.mean > 128, `反轉後平均亮度應 >128，實際 ${s.mean.toFixed(1)}`);
  // 原本的淺色方塊 230 → 反轉 25 → 對比（原始對比 >200 故減半，factor 0.6）→ ≈66
  const box = s.data[16 * 64 + 32];
  assert.ok(box > 55 && box < 80, `方塊應 ≈66，實際 ${box}`);
  // 黃點：塗白 255 → 反轉 0 → 對比後 ≈51；若沒塗白會是灰 226 → 29 → ≈68
  const dot = s.data[3 * 64 + 3];
  assert.ok(dot < 58, `黃點應被塗白後反轉成最暗（≈51），實際 ${dot}`);
});

test("invert=false 保持原樣；threshold>0 會二值化成只有 0/255", async () => {
  const out = await preprocessImage(await makeInput(), { scale: 1, invert: false, sharpen: false, denoise: false, threshold: 1, contrast: 1 });
  const s = await stats(out);
  const uniq = new Set(s.data);
  assert.ok([...uniq].every((v) => v === 0 || v === 255), `二值化後只能有 0/255，實際 ${[...uniq].slice(0, 5)}`);
  assert.ok(s.mean < 128);
});
