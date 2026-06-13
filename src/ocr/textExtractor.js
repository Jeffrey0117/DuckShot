// 統一文字擷取（移植自 Screenshot-OCR src/main/textExtractor.ts）
// 順序：UI Automation → PaddleOCR → Tesseract。Gemini 手動觸發。
// 修改：全 lazy init — 各引擎模組在第一次用到時才 require/初始化，
//       app 啟動與不使用 OCR 時零成本。
let tesseractInited = false;

async function extractText(options) {
  const { imageData, screenBounds, tryUIAutomation = true } = options;

  if (typeof imageData !== "string") {
    throw new Error(`imageData must be a string, got ${typeof imageData}`);
  }

  // PaddleOCR 與 UIA 並行開跑（recognizeWithPaddleOcr 不會 reject，失敗回 {success:false}）：
  // UIA 有結果就用 UIA，否則直接收割已在跑的 Paddle — 延遲是 max() 而非兩者相加
  const { recognizeWithPaddleOcr } = require("./paddle");
  const paddlePromise = recognizeWithPaddleOcr(imageData);

  // 1. UI Automation（有螢幕座標才能用；視窗文字元素直讀，100% 準）
  if (tryUIAutomation && screenBounds && process.platform === "win32") {
    try {
      const { getTextFromRect } = require("./uiAutomation");
      const uiaResult = await getTextFromRect(
        screenBounds.x,
        screenBounds.y,
        screenBounds.width,
        screenBounds.height
      );
      if (uiaResult.success && uiaResult.text.length > 0) {
        return { text: uiaResult.text, method: "ui-automation", confidence: 100 };
      }
      console.log("UI Automation returned no text, falling back to OCR");
    } catch (error) {
      console.log("UI Automation failed:", error.message);
    }
  }

  // 2. PaddleOCR（中文主力；模組內部已有單例 + 並發保護）
  let paddleFallback = null;
  try {
    const paddleResult = await paddlePromise;
    if (paddleResult.success && paddleResult.text.length > 0) {
      const text = paddleResult.text;
      const avgConfidence =
        paddleResult.lines.length > 0
          ? (paddleResult.lines.reduce((sum, l) => sum + l.confidence, 0) /
              paddleResult.lines.length) * 100
          : 90;
      // PaddleOCR 是為中文設計，辨識純英文時常把單字黏在一起（缺空格）。
      // 含中日韓文字 → 直接用 Paddle；純拉丁文字且明顯缺空格 → 改用 Tesseract（空格正確）。
      if (hasCjk(text) || !looksSpaceDeficient(text)) {
        return { text, method: "paddle-ocr", confidence: avgConfidence };
      }
      console.log("Paddle 結果疑似缺空格的英文，改用 Tesseract");
      paddleFallback = { text, method: "paddle-ocr", confidence: avgConfidence };
    } else {
      console.log("PaddleOCR returned no text, falling back to Tesseract");
    }
  } catch (error) {
    console.log("PaddleOCR failed:", error.message);
  }

  // 3. Tesseract（語言檔第一次使用時自 CDN 下載；英文空格處理比 Paddle 好）
  try {
    const { initOcr, recognizeImage } = require("./tesseract");
    if (!tesseractInited) {
      await initOcr(["eng", "chi_tra"]);
      tesseractInited = true;
    }
    const ocrResult = await recognizeImage(imageData);
    if (ocrResult.text && ocrResult.text.trim().length > 0) {
      return { text: ocrResult.text, method: "tesseract", confidence: ocrResult.confidence };
    }
  } catch (error) {
    console.error("Tesseract OCR failed:", error.message);
  }

  // Tesseract 沒結果但 Paddle 有（缺空格的英文）→ 退回 Paddle，至少有字
  if (paddleFallback) return paddleFallback;

  return { text: "", method: "none", confidence: 0 };
}

// 是否含中日韓文字（含則維持 PaddleOCR）
function hasCjk(text) {
  return /[㐀-鿿぀-ヿ가-힯]/.test(text);
}

// 純拉丁文字是否「明顯缺空格」（PaddleOCR 黏字的特徵）
function looksSpaceDeficient(text) {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  if (letters < 12) return false; // 太短不誤判
  const spaces = (text.match(/ /g) || []).length;
  const runs = text.match(/[A-Za-z]+/g) || [];
  const longestRun = runs.reduce((m, w) => Math.max(m, w.length), 0);
  // 出現超長無空格字母串，或空格相對字母數明顯偏少 → 視為缺空格
  return longestRun >= 18 || spaces / letters < 0.08;
}

// Gemini 手動重辨識（結果視窗 🤖 AI 鈕）
async function extractWithGemini(imageData, apiKey) {
  const { recognizeWithGemini } = require("./gemini");
  const geminiResult = await recognizeWithGemini(imageData, apiKey);
  if (geminiResult.success && geminiResult.text.length > 0) {
    return { text: geminiResult.text, method: "gemini-ai", confidence: 98 };
  }
  return {
    text: "",
    method: "gemini-ai",
    confidence: 0,
    error: geminiResult.error || "辨識不到文字",
  };
}

const METHOD_NAMES = {
  "ui-automation": "視窗文字直讀",
  "paddle-ocr": "PaddleOCR",
  "tesseract": "Tesseract",
  "gemini-ai": "Gemini AI",
  "none": "無法辨識",
};

function formatConfidence(method, confidence) {
  const name = METHOD_NAMES[method] || method;
  if (method === "ui-automation") return `✓ ${name} (100%)`;
  return `${name} (${Math.round(confidence)}%)`;
}

module.exports = { extractText, extractWithGemini, formatConfidence };
