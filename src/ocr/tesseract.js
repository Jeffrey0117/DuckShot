// Tesseract OCR（移植自 Screenshot-OCR src/main/ocr.ts）
// 修改：前處理選項由呼叫端注入（preprocessOptions === false 時跳過），不依賴設定存取
const Tesseract = require("tesseract.js");
const { preprocessImage } = require("./imagePreprocess");

let worker = null;
let currentLanguages = [];

// 初始化 OCR worker。Tesseract.js 5.x 會自動從 CDN 下載語言檔。
async function initOcr(languages = ["eng", "chi_tra"]) {
  // 同語言的 worker 已存在則跳過
  if (worker && arraysEqual(currentLanguages, languages)) {
    return;
  }

  if (worker) {
    await worker.terminate();
    worker = null;
  }

  console.log("Initializing OCR with languages:", languages);

  const langString = languages.join("+");

  try {
    worker = await Tesseract.createWorker(langString, 1, {
      logger: (m) => {
        if (m.status === "recognizing text") {
          console.log(`OCR Progress: ${Math.round(m.progress * 100)}%`);
        } else {
          console.log(`OCR: ${m.status}`);
        }
      },
    });

    currentLanguages = [...languages];
    console.log("OCR initialized successfully");
  } catch (error) {
    console.error("Failed to initialize OCR:", error);
    throw error;
  }
}

// 辨識圖片文字
async function recognizeImage(imageData, preprocessOptions) {
  if (!worker) {
    throw new Error("OCR not initialized. Call initOcr() first.");
  }

  console.log("Starting OCR recognition...");

  try {
    let processedImage = imageData;
    if (preprocessOptions !== false) {
      console.log("Preprocessing image...");
      processedImage = await preprocessImage(imageData, {
        scale: 2, // 放大 2 倍（太大會造成幻覺）
        grayscale: true,
        invert: "auto",
        contrast: 1.5, // 適中對比度
        threshold: 0, // 關閉二值化，避免幻覺
        sharpen: false, // 關閉銳化，避免雜訊
      });
    }

    // data URL 轉 buffer
    let imageBuffer = processedImage;
    if (processedImage.startsWith("data:")) {
      const base64Data = processedImage.replace(/^data:image\/\w+;base64,/, "");
      imageBuffer = Buffer.from(base64Data, "base64");
    }

    await worker.setParameters({
      tessedit_char_whitelist: "", // Allow all characters
      preserve_interword_spaces: "1",
    });

    const result = await worker.recognize(imageBuffer);

    const words =
      result.data.words?.map((w) => ({
        text: w.text,
        bbox: w.bbox,
        confidence: w.confidence,
      })) || [];

    console.log(`OCR complete. Found ${words.length} words.`);

    return {
      text: result.data.text.trim(),
      confidence: result.data.confidence,
      words,
    };
  } catch (error) {
    console.error("OCR recognition failed:", error);
    throw error;
  }
}

// 切換 OCR 語言
async function setOcrLanguages(languages) {
  await initOcr(languages);
}

// 終止 OCR worker
async function terminateOcr() {
  if (worker) {
    console.log("Terminating OCR worker...");
    await worker.terminate();
    worker = null;
    currentLanguages = [];
    console.log("OCR worker terminated");
  }
}

// 取消進行中的辨識（Tesseract.js 沒有直接 cancel，改為終止後待下次重建）
async function cancelOcr() {
  console.log("Cancelling OCR...");
  await terminateOcr();
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((val, index) => val === b[index]);
}

module.exports = { initOcr, recognizeImage, setOcrLanguages, terminateOcr, cancelOcr };
