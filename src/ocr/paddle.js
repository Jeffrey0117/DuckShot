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
      // 模型路徑必須明確指到 app.asar.unpacked：onnxruntime 是原生碼直接 fopen，
      // 拿到 app.asar 內的路徑會 "File doesn't exist"（打包版 Paddle 從來沒成功過的根因）
      const instance = await Ocr.create({ models: resolveModelPaths() });
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

// 找出 @gutenye/ocr-models 的 assets 目錄；在 asar 內就改指 app.asar.unpacked（electron-builder asarUnpack 會放那裡）
function resolveModelPaths() {
  // package.json 不在 exports 內，改解析有匯出的 ./node 入口來找套件目錄
  const entry = require.resolve("@gutenye/ocr-models/node");
  const assets = path
    .join(path.dirname(entry), "assets")
    .replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  return {
    detectionPath: path.join(assets, "ch_PP-OCRv4_det_infer.onnx"),
    recognitionPath: path.join(assets, "ch_PP-OCRv4_rec_infer.onnx"),
    dictionaryPath: path.join(assets, "ppocr_keys_v1.txt"),
  };
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
    // @gutenye/ocr-node 的 detect() 直接回傳 Line[]（{text, mean, box}），
    // 不是 {lines}（原 Screenshot-OCR 讀 result.lines 永遠拿到空，導致 Paddle 形同虛設）
    const result = await ocr.detect(tempFile);
    const rawLines = Array.isArray(result) ? result : result?.lines || [];

    const lines = rawLines.map((line) => ({
      text: line.text || "",
      confidence: typeof line.mean === "number" ? line.mean : line.confidence || 0,
      box: line.box || line.frame || { top: 0, left: 0, width: 0, height: 0 },
    }));

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

// 實例是否已初始化（textExtractor 用來決定要不要跟 UIA 並行）
function isWarm() {
  return !!ocrInstance;
}

module.exports = { recognizeWithPaddleOcr, isWarm, resolveModelPaths };
