// Gemini Vision OCR（移植自 Screenshot-OCR src/main/geminiOcr.ts）
// 修改：API key 由呼叫端注入，不依賴設定存取。中文、藝術字體效果都很好。
const { GoogleGenerativeAI } = require("@google/generative-ai");

let genAI = null;
let lastApiKey = null;

function getGenAI(apiKey) {
  if (!apiKey) return null;
  if (genAI && lastApiKey === apiKey) return genAI;
  genAI = new GoogleGenerativeAI(apiKey);
  lastApiKey = apiKey;
  return genAI;
}

// 使用 Gemini Vision 辨識圖片文字（imageData：base64，可帶或不帶 data URL prefix）
async function recognizeWithGemini(imageData, apiKey) {
  const ai = getGenAI(apiKey);

  if (!ai) {
    return {
      success: false,
      text: "",
      error: "Gemini API key not configured",
    };
  }

  try {
    // 移除 data URL prefix 並取得 mime type
    let base64Data = imageData;
    let mimeType = "image/png";

    if (imageData.startsWith("data:")) {
      const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        mimeType = matches[1];
        base64Data = matches[2];
      }
    }

    console.log("Calling Gemini Vision API...");

    // 使用 Gemini 2.0 Flash（便宜又快）
    const model = ai.getGenerativeModel({ model: "gemini-2.0-flash" });

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType,
          data: base64Data,
        },
      },
      {
        text: "請辨識這張圖片中的所有文字，包括藝術字體、特殊字型。只輸出辨識到的文字內容，不要加任何說明或格式。如果有多行文字，請保持原本的換行格式。",
      },
    ]);

    const response = await result.response;
    const text = response.text().trim();

    console.log(`Gemini OCR succeeded: "${text.substring(0, 50)}..."`);

    return {
      success: true,
      text,
    };
  } catch (error) {
    console.error("Gemini OCR error:", error);
    return {
      success: false,
      text: "",
      error: error.message || String(error),
    };
  }
}

module.exports = { recognizeWithGemini };
