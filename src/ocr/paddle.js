// PaddleOCR（移植自 Screenshot-OCR src/main/paddleOcr.ts）
// 使用 @gutenye/ocr-node（PaddleOCR + ONNX runtime），中文辨識效果比 Tesseract 好很多
const fs = require("fs");
const path = require("path");
const os = require("os");

let ocrInstance = null;
let isInitializing = false;

// 初始化 PaddleOCR（單例 + 並發保護）
async function getOcrInstance() {
  if (ocrInstance) {
    return ocrInstance;
  }

  if (isInitializing) {
    // 等待初始化完成
    while (isInitializing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return ocrInstance;
  }

  isInitializing = true;

  try {
    console.log("Initializing PaddleOCR...");
    // @gutenye/ocr-node 是 ESM，需動態 import
    const { default: Ocr } = await import("@gutenye/ocr-node");
    ocrInstance = await Ocr.create();
    console.log("PaddleOCR initialized successfully");
    return ocrInstance;
  } catch (error) {
    console.error("Failed to initialize PaddleOCR:", error);
    throw error;
  } finally {
    isInitializing = false;
  }
}

// 使用 PaddleOCR 辨識圖片（imageData：base64，可帶或不帶 data URL prefix）
async function recognizeWithPaddleOcr(imageData) {
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");

  // 建立臨時檔案（PaddleOCR 需要檔案路徑）
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `paddle_ocr_${Date.now()}.png`);

  try {
    const imageBuffer = Buffer.from(base64Data, "base64");
    fs.writeFileSync(tempFile, imageBuffer);

    const ocr = await getOcrInstance();

    console.log("Running PaddleOCR detection...");
    const result = await ocr.detect(tempFile);

    const lines =
      result.lines?.map((line) => ({
        text: line.text || "",
        confidence: line.confidence || 0,
        box: line.frame || { top: 0, left: 0, width: 0, height: 0 },
      })) || [];

    const fullText = lines.map((l) => l.text).join("\n");

    console.log(`PaddleOCR complete. Found ${lines.length} lines.`);

    return {
      success: true,
      text: fullText,
      lines,
    };
  } catch (error) {
    console.error("PaddleOCR error:", error);
    return {
      success: false,
      text: "",
      lines: [],
      error: error.message || String(error),
    };
  } finally {
    // 清理臨時檔案
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (e) {
      // 忽略清理錯誤
    }
  }
}

module.exports = { recognizeWithPaddleOcr };
