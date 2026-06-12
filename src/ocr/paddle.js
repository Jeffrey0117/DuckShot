// PaddleOCR（移植自 Screenshot-OCR src/main/paddleOcr.ts）
// 使用 @gutenye/ocr-node（PaddleOCR + ONNX runtime），中文辨識效果比 Tesseract 好很多
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

let ocrInstance = null;
let initPromise = null;

// 初始化 PaddleOCR（單例；並發呼叫共享同一個初始化 Promise，失敗會傳給所有等待者並允許重試）
async function getOcrInstance() {
  if (ocrInstance) {
    return ocrInstance;
  }

  if (!initPromise) {
    initPromise = (async () => {
      console.log("Initializing PaddleOCR...");
      // @gutenye/ocr-node 是 ESM，需動態 import
      const { default: Ocr } = await import("@gutenye/ocr-node");
      const instance = await Ocr.create();
      console.log("PaddleOCR initialized successfully");
      return instance;
    })().catch((error) => {
      console.error("Failed to initialize PaddleOCR:", error);
      initPromise = null; // 失敗後允許下次重試
      throw error;
    });
  }

  ocrInstance = await initPromise;
  return ocrInstance;
}

// 使用 PaddleOCR 辨識圖片（imageData：base64，可帶或不帶 data URL prefix）
async function recognizeWithPaddleOcr(imageData) {
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");

  // 建立臨時檔案（PaddleOCR 需要檔案路徑）
  const tempDir = os.tmpdir();
  // 隨機檔名避免並發辨識時碰撞（Date.now() 同毫秒會重複）
  const tempFile = path.join(tempDir, `paddle_ocr_${crypto.randomUUID()}.png`);

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
