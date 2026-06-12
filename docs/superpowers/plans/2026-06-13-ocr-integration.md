# OCR 整合實作計畫（移植 Screenshot-OCR）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Screenshot-OCR 的四層文字辨識（UIA → Paddle → Tesseract + Gemini 手動）移植進 DuckShot，截圖工具列新增 `5 = 文字辨識`，結果顯示在與原 app 外觀一致的結果視窗。

**Architecture:** OCR 引擎模組移植到 `src/ocr/`（TS→純 JS、全 lazy init、不依賴 electron-store — 設定由 main.js 呼叫端注入）。結果視窗為新 BrowserWindow（`renderer/ocrResult.html`），CSS 照抄原 repo，行為以純 JS 重寫。

**Tech Stack:** Electron 38、tesseract.js、@gutenye/ocr-node（ONNX）、jimp、@google/generative-ai。

**Spec:** `docs/superpowers/specs/2026-06-13-ocr-integration-design.md`

**重要背景（給零上下文的工程師）:**
- 來源 repo：https://github.com/Jeffrey0117/Screenshot-OCR （TS + electron-vite + React）。本計畫 Task 0 會 clone 到本機參考位置，之後各移植任務都從那裡讀原始碼。
- DuckShot 是純 CJS JS、無打包器。`src/main.js` 是 class 形式 app，IPC handler 都是 arrow function（`this` = app 實例）。
- **此開發機有 TLS 攔截**：npm install 需要 `npm config set strict-ssl false`（或環境變數 `NODE_TLS_REJECT_UNAUTHORIZED=0`）才裝得了套件。
- 截圖 overlay：`renderer/capture.html`（內嵌 JS class），工具列按鈕 `1 複製 / 2 儲存 / 3 上傳 / 4 繼續`（HTML 在 ~line 504-535，keydown 在 `onKeyDown` ~line 1114，按鈕綁定 ~line 816-819）。
- 設定視窗：`renderer/settings.html` + `renderer/js/settingsPage.js`；設定存於 electron-store（IPC `get-settings` / `save-settings`）。

---

### Task 0: 來源參考 clone + 安裝依賴

**Files:**
- Modify: `package.json`（dependencies）

- [ ] **Step 1: clone 來源 repo 到參考位置**

```powershell
if (-not (Test-Path "$env:TEMP\Screenshot-OCR")) { git clone --depth 1 https://github.com/Jeffrey0117/Screenshot-OCR "$env:TEMP\Screenshot-OCR" }
```

之後所有「來源」路徑都指 `$env:TEMP\Screenshot-OCR\`。

- [ ] **Step 2: 安裝依賴**

```powershell
npm config set strict-ssl false
npm install tesseract.js@^5.1.1 @gutenye/ocr-node@^1.4.8 jimp@^1.6.0 @google/generative-ai@^0.24.1
```

Expected: package.json `dependencies` 出現四個套件（注意是 dependencies 不是 devDependencies，打包需要）。

- [ ] **Step 3: 驗證可載入**

```powershell
node -e "require('tesseract.js'); require('jimp'); console.log('ok')"
```

Expected: 輸出 `ok`（@gutenye/ocr-node 是 ESM，於 Task 2 以動態 import 載入，這裡不驗）。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(ocr): add OCR dependencies (tesseract.js, paddle-ocr, jimp, gemini)"
```

---

### Task 1: 移植引擎模組（機械轉換）

**Files:**
- Create: `src/ocr/imagePreprocess.js`（源：`src/main/imagePreprocess.ts`）
- Create: `src/ocr/tesseract.js`（源：`src/main/ocr.ts`）
- Create: `src/ocr/paddle.js`（源：`src/main/paddleOcr.ts`）
- Create: `src/ocr/gemini.js`（源：`src/main/geminiOcr.ts`）
- Create: `src/ocr/uiAutomation.js`（源：`src/main/uiAutomation.ts`）

**統一轉換規則（每個檔案都套用）:**
1. 移除所有 `interface` / 型別註記 / `as` 斷言 /（`: string` 等）。
2. `import X from 'y'` → `const X = require("y")`；`export function f` → 檔尾 `module.exports = { f, ... }`。
3. 移除 `import { getSettings } from './store'` — ocr 模組**不得**依賴設定存取，改由參數注入（見各檔說明）。
4. 其餘邏輯逐行照抄，不重構、不改行為。

- [ ] **Step 1: `src/ocr/imagePreprocess.js`**

照源檔轉換。檔頭/檔尾：

```js
// 圖片預處理（移植自 Screenshot-OCR src/main/imagePreprocess.ts）
const { Jimp } = require("jimp");

async function preprocessImage(base64Image, options) {
  // ……（源檔 21-216 行邏輯逐行照抄，去掉型別）
}

module.exports = { preprocessImage };
```

- [ ] **Step 2: `src/ocr/tesseract.js`**

照源檔 `ocr.ts` 轉換，兩處刻意修改：
(a) 移除 `getSettings` import；`recognizeImage(imageData)` 改簽名為 `recognizeImage(imageData, preprocessOptions)`，函式內 `if (settings.preprocessEnabled !== false)` 區塊改為：

```js
    let processedImage = imageData;
    if (preprocessOptions !== false) {
      console.log("Preprocessing image...");
      processedImage = await preprocessImage(imageData, {
        scale: 2,
        grayscale: true,
        invert: "auto",
        contrast: 1.5,
        threshold: 0,
        sharpen: false,
      });
    }
```

(b) 檔尾：

```js
module.exports = { initOcr, recognizeImage, setOcrLanguages, terminateOcr, cancelOcr };
```

- [ ] **Step 3: `src/ocr/paddle.js`**

照源檔 `paddleOcr.ts` 轉換。注意保留：`@gutenye/ocr-node` 是 ESM，初始化必須用動態 `await import("@gutenye/ocr-node")`（源檔本來就這樣寫，照抄即可）；`isInitializing` 等待迴圈照抄（防止並發重複初始化）。檔尾 `module.exports = { recognizeWithPaddleOcr };`（依源檔實際 export 名）。

- [ ] **Step 4: `src/ocr/gemini.js`**

照源檔 `geminiOcr.ts` 轉換，API key 改為參數注入（移除 getSettings）：

```js
// Gemini Vision OCR（移植自 Screenshot-OCR src/main/geminiOcr.ts，API key 由呼叫端注入）
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

async function recognizeWithGemini(imageData, apiKey) {
  const ai = getGenAI(apiKey);
  if (!ai) {
    return { success: false, text: "", error: "Gemini API key not configured" };
  }
  // ……（源檔 51-98 行 try/catch 邏輯逐行照抄：解析 data URL、
  //    getGenerativeModel({ model: "gemini-2.0-flash" })、generateContent、回傳 text）
}

module.exports = { recognizeWithGemini };
```

（源檔的 `isGeminiAvailable` / `setGeminiApiKey` 不移植 — 可用性 = main.js 端 `!!apiKey`。）

- [ ] **Step 5: `src/ocr/uiAutomation.js`**

照源檔 `uiAutomation.ts`（267 行）轉換：PowerShell script 字串與 exec 邏輯逐行照抄。只移植截圖流程實際用到的 `getTextFromRect`（與其依賴的內部函式）；`getTextFromPoint` 若 `getTextFromRect` 沒用到就不搬。檔尾 `module.exports = { getTextFromRect };`。

- [ ] **Step 6: 語法驗證**

```powershell
node -e "require('./src/ocr/imagePreprocess'); require('./src/ocr/tesseract'); require('./src/ocr/paddle'); require('./src/ocr/gemini'); require('./src/ocr/uiAutomation'); console.log('all ok')"
```

Expected: `all ok`（純 require 不觸發任何引擎初始化 — 這同時驗證了 lazy 邊界）。

- [ ] **Step 7: Commit**

```bash
git add src/ocr/
git commit -m "feat(ocr): port OCR engine modules from Screenshot-OCR (TS->JS, config injected)"
```

---

### Task 2: `src/ocr/textExtractor.js`（lazy init 統一入口）

**Files:**
- Create: `src/ocr/textExtractor.js`（源：`src/main/textExtractor.ts`，但改為全 lazy）

- [ ] **Step 1: 完整實作（這是有「實質修改」的檔案，全文如下）**

```js
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

  // 1. UI Automation（有螢幕座標才能用；視窗文字元素直讀，100% 準）
  if (tryUIAutomation && screenBounds && process.platform === "win32") {
    try {
      const { getTextFromRect } = require("./uiAutomation");
      const uiaResult = await getTextFromRect(
        screenBounds.x, screenBounds.y, screenBounds.width, screenBounds.height
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
  try {
    const { recognizeWithPaddleOcr } = require("./paddle");
    const paddleResult = await recognizeWithPaddleOcr(imageData);
    if (paddleResult.success && paddleResult.text.length > 0) {
      const avgConfidence = paddleResult.lines.length > 0
        ? (paddleResult.lines.reduce((sum, l) => sum + l.confidence, 0) /
            paddleResult.lines.length) * 100
        : 90;
      return { text: paddleResult.text, method: "paddle-ocr", confidence: avgConfidence };
    }
    console.log("PaddleOCR returned no text, falling back to Tesseract");
  } catch (error) {
    console.log("PaddleOCR failed:", error.message);
  }

  // 3. Tesseract fallback（語言檔第一次使用時自 CDN 下載）
  try {
    const { initOcr, recognizeImage } = require("./tesseract");
    if (!tesseractInited) {
      await initOcr(["eng", "chi_tra"]);
      tesseractInited = true;
    }
    const ocrResult = await recognizeImage(imageData);
    return { text: ocrResult.text, method: "tesseract", confidence: ocrResult.confidence };
  } catch (error) {
    console.error("Tesseract OCR failed:", error.message);
  }

  return { text: "", method: "none", confidence: 0 };
}

// Gemini 手動重辨識（結果視窗 🤖 AI 鈕）
async function extractWithGemini(imageData, apiKey) {
  const { recognizeWithGemini } = require("./gemini");
  const geminiResult = await recognizeWithGemini(imageData, apiKey);
  if (geminiResult.success && geminiResult.text.length > 0) {
    return { text: geminiResult.text, method: "gemini-ai", confidence: 98 };
  }
  return {
    text: "", method: "gemini-ai", confidence: 0,
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
```

- [ ] **Step 2: 冒煙測試（真實辨識一張字圖）**

```powershell
node -e "const {extractText}=require('./src/ocr/textExtractor'); const {createCanvas}=(()=>{try{return require('canvas')}catch{return{}}})(); console.log('manual smoke in Task 5')"
```

（無 headless 畫布依賴，真實辨識留待 Task 5 端到端手動驗證；此步只確認 `require('./src/ocr/textExtractor')` 不報錯。）

Run: `node -e "require('./src/ocr/textExtractor'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add src/ocr/textExtractor.js
git commit -m "feat(ocr): unified textExtractor with full lazy engine init"
```

---

### Task 3: 主進程整合（IPC + 結果視窗）

**Files:**
- Modify: `src/main.js`
- Modify: `src/preload.js`

- [ ] **Step 1: 建構式屬性**

```js
    this.ocrResultWindow = null;
```

- [ ] **Step 2: class 加 `openOcrResultWindow` 方法（放在 `showSortToast` 之後）**

```js
  // 開啟（或重用）OCR 結果視窗並開始辨識
  async openOcrResultWindow(imageData, screenBounds) {
    try {
      if (!this.ocrResultWindow || this.ocrResultWindow.isDestroyed()) {
        this.ocrResultWindow = new BrowserWindow({
          width: 420,
          height: 560,
          frame: false,
          resizable: true,
          alwaysOnTop: false,
          skipTaskbar: false,
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
          },
        });
        this.ocrResultWindow.on("closed", () => {
          this.ocrResultWindow = null;
        });
        await this.ocrResultWindow.loadFile(
          path.join(__dirname, "../renderer/ocrResult.html")
        );
      }
      const win = this.ocrResultWindow;
      win.show();
      win.webContents.send("ocr-start", { image: imageData });

      const { extractText, formatConfidence } = require("./ocr/textExtractor");
      const result = await extractText({ imageData, screenBounds });
      if (win.isDestroyed()) return;
      if (result.text) {
        win.webContents.send("ocr-result", {
          image: imageData,
          text: result.text,
          method: result.method,
          confidence: result.confidence,
          methodDisplay: formatConfidence(result.method, result.confidence),
        });
      } else {
        win.webContents.send("ocr-error", { message: "辨識不到文字" });
      }
    } catch (error) {
      console.error("OCR failed:", error);
      if (this.ocrResultWindow && !this.ocrResultWindow.isDestroyed()) {
        this.ocrResultWindow.webContents.send("ocr-error", {
          message: error.message || "OCR failed",
        });
      }
    }
  }
```

- [ ] **Step 3: 新增 IPC handlers（放在 `move-screenshot` handler 之後）**

```js
    // OCR：截圖 overlay 按 5 → 開結果視窗並辨識
    ipcMain.handle("ocr-recognize", async (_event, imageData, screenBounds) => {
      this.openOcrResultWindow(imageData, screenBounds); // fire-and-forget
      return { success: true };
    });

    // OCR：結果視窗內重新框選後對子圖重新辨識
    ipcMain.handle("ocr-recognize-region", async (_event, imageData) => {
      this.openOcrResultWindow(imageData, null);
      return { success: true };
    });

    // OCR：Gemini 手動重辨識
    ipcMain.handle("ocr-gemini", async (_event, imageData) => {
      try {
        const { extractWithGemini, formatConfidence } = require("./ocr/textExtractor");
        const apiKey = store.get("geminiApiKey") || "";
        const result = await extractWithGemini(imageData, apiKey);
        if (result.text) {
          return {
            success: true,
            text: result.text,
            methodDisplay: formatConfidence(result.method, result.confidence),
          };
        }
        return { success: false, error: result.error || "辨識不到文字" };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // OCR：結果視窗釘選切換 / 關閉 / 再截一張
    ipcMain.handle("ocr-toggle-pin", () => {
      if (!this.ocrResultWindow || this.ocrResultWindow.isDestroyed()) return false;
      const next = !this.ocrResultWindow.isAlwaysOnTop();
      this.ocrResultWindow.setAlwaysOnTop(next);
      return next;
    });
    ipcMain.handle("ocr-is-gemini-available", () => !!store.get("geminiApiKey"));
```

- [ ] **Step 4: preload 暴露 `ocr` 區塊**

`src/preload.js` 的 `electronAPI` 內加：

```js
  // OCR 文字辨識
  ocr: {
    recognize: (imageData, screenBounds) =>
      ipcRenderer.invoke("ocr-recognize", imageData, screenBounds),
    recognizeRegion: (imageData) =>
      ipcRenderer.invoke("ocr-recognize-region", imageData),
    gemini: (imageData) => ipcRenderer.invoke("ocr-gemini", imageData),
    togglePin: () => ipcRenderer.invoke("ocr-toggle-pin"),
    isGeminiAvailable: () => ipcRenderer.invoke("ocr-is-gemini-available"),
    openExternal: (url) => ipcRenderer.invoke("ocr-open-external", url),
  },
```

`on` 的 validChannels 加 `"ocr-start"`, `"ocr-result"`, `"ocr-error"`。

- [ ] **Step 5: 外部連結 handler（🔍 搜尋 / 📷 IG 用）**

```js
    ipcMain.handle("ocr-open-external", (_event, url) => {
      if (typeof url === "string" && /^https:\/\//.test(url)) {
        electron.shell.openExternal(url);
      }
    });
```

- [ ] **Step 6: 啟動驗證**

Run: `npm start`
Expected: 正常啟動。**啟動時主進程不得載入任何 OCR 引擎**（確認啟動 console 沒有 "Initializing OCR/PaddleOCR" 字樣）。

- [ ] **Step 7: Commit**

```bash
git add src/main.js src/preload.js
git commit -m "feat(ocr): main-process OCR IPC and result window lifecycle"
```

---

### Task 4: 截圖 overlay 加「5 = 文字辨識」

**Files:**
- Modify: `renderer/capture.html`（工具列 HTML ~line 528、按鈕綁定 ~line 819、onKeyDown ~line 1127、class 加方法）

- [ ] **Step 1: 工具列加按鈕**

在 `continueBtn` 按鈕之後、`cancelBtn` 之前插入：

```html
      <button class="capture-btn" id="ocrBtn" title="文字辨識 OCR (5)">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M5 4h3v2H6v2H4V5c0-.55.45-1 1-1zm14 0c.55 0 1 .45 1 1v3h-2V6h-2V4h3zM6 18h2v2H5c-.55 0-1-.45-1-1v-3h2v2zm14-2v3c0 .55-.45 1-1 1h-3v-2h2v-2h2zM9 8h6v2h-2v6h-2v-6H9V8z" fill="currentColor"/>
        </svg>
        <div class="btn-text">文字</div>
      </button>
```

- [ ] **Step 2: 綁定點擊與數字鍵**

按鈕綁定區（~line 819 後）加：

```js
          document.getElementById('ocrBtn').addEventListener('click', () => this.ocrScreenshot());
```

`onKeyDown` 的數字鍵區（`else if (e.key === '4')` 後）加：

```js
            else if (e.key === '5') { e.preventDefault(); this.ocrScreenshot(); }
```

- [ ] **Step 3: class 加 `ocrScreenshot` 方法（放在 `uploadScreenshot` 之前，裁切邏輯與 `saveScreenshot` 相同）**

```js
        // 文字辨識：把選取區送主進程 OCR，開結果視窗顯示
        async ocrScreenshot() {
          if (!this.selection) return;
          try {
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            tempCanvas.width = this.selection.width * this.dpr;
            tempCanvas.height = this.selection.height * this.dpr;
            tempCtx.imageSmoothingEnabled = false;
            tempCtx.drawImage(
              this.canvas,
              this.selection.x * this.dpr,
              this.selection.y * this.dpr,
              this.selection.width * this.dpr,
              this.selection.height * this.dpr,
              0, 0, tempCanvas.width, tempCanvas.height
            );
            const imageData = tempCanvas.toDataURL('image/png');
            // UIA 需要螢幕座標：overlay 全螢幕覆蓋，選取座標即螢幕座標（加上視窗原點防多螢幕）
            const screenBounds = {
              x: Math.round(window.screenX + this.selection.x),
              y: Math.round(window.screenY + this.selection.y),
              width: Math.round(this.selection.width),
              height: Math.round(this.selection.height),
            };
            await window.electronAPI.ocr.recognize(imageData, screenBounds);
            window.close();
          } catch (error) {
            console.error('文字辨識失敗:', error);
          }
        }
```

- [ ] **Step 4: Commit**

```bash
git add renderer/capture.html
git commit -m "feat(ocr): add OCR action (key 5) to capture toolbar"
```

---

### Task 5: OCR 結果視窗 UI（照抄原 app 外觀）

**Files:**
- Create: `renderer/css/ocrResult.css`（源 CSS 照抄 + 標題列拖曳屬性）
- Create: `renderer/ocrResult.html`
- Create: `renderer/js/ocrResult.js`

- [ ] **Step 1: 複製 CSS**

```powershell
Copy-Item "$env:TEMP\Screenshot-OCR\src\renderer\styles\ResultPopup.css" "renderer\css\ocrResult.css"
```

然後在檔尾追加（無邊框視窗拖曳 + 基本 reset，原 app 由全域 index.css 提供）：

```css
/* DuckShot 整合追加 */
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: "Segoe UI", "Microsoft JhengHei", sans-serif; }
.popup-titlebar { -webkit-app-region: drag; }
.popup-titlebar button { -webkit-app-region: no-drag; }
.result-popup { height: 100vh; display: flex; flex-direction: column; }
```

- [ ] **Step 2: 建立 `renderer/ocrResult.html`**

結構對照源檔 `ResultPopup.tsx` 的 JSX（class 名完全一致以吃到照抄的 CSS）：

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; img-src 'self' data:; style-src 'self'" />
  <title>文字辨識 - DuckShot</title>
  <link rel="stylesheet" href="css/ocrResult.css" />
</head>
<body>
  <div class="result-popup" id="popup">
    <div class="popup-titlebar">
      <div class="popup-title-left">
        <span class="popup-title">文字辨識</span>
      </div>
      <div class="popup-controls">
        <button class="control-btn capture" id="btnCapture" title="再截一張">📷 截圖</button>
        <button class="control-btn" id="btnPin" title="釘選視窗 (Ctrl+P)">📌 釘選</button>
        <button class="control-btn" id="btnSettings" title="設定">⚙️ 設定</button>
        <button class="control-btn close" id="btnClose" title="關閉 (Esc)">✕</button>
      </div>
    </div>
    <div class="popup-content">
      <div class="result-image" id="imageWrap" style="display:none">
        <img id="resultImage" alt="Captured" draggable="false" />
        <div class="crop-overlay" id="cropOverlay" style="display:none"></div>
        <div class="crop-rect" id="cropRect" style="display:none"></div>
        <canvas id="cropCanvas" style="display:none"></canvas>
      </div>
      <div class="result-loading" id="loading" style="display:none">
        <div class="spinner"></div><span>辨識中…</span>
      </div>
      <div class="result-error" id="errorBox" style="display:none"></div>
      <div class="result-text-wrapper" id="textWrap" style="display:none">
        <div class="result-text" id="resultText" contenteditable="true" spellcheck="false"></div>
      </div>
      <div class="result-confidence" id="confidence"></div>
    </div>
    <div class="popup-actions">
      <button class="action-btn primary" id="btnCopy" disabled>📋 複製</button>
      <button class="action-btn" id="btnCrop" disabled title="重新框選辨識範圍">✂️ 裁切</button>
      <button class="action-btn ai" id="btnAI" disabled title="用 Gemini AI 重新辨識">🤖 AI</button>
      <button class="action-btn" id="btnSearch" disabled>🔍 搜尋</button>
      <button class="action-btn instagram" id="btnIG" disabled>📷 IG</button>
    </div>
  </div>
  <script src="js/ocrResult.js"></script>
</body>
</html>
```

- [ ] **Step 3: 建立 `renderer/js/ocrResult.js`（行為一比一移植 ResultPopup.tsx）**

```js
// OCR 結果視窗（行為移植自 Screenshot-OCR ResultPopup.tsx，純 JS 重寫）
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    imageWrap: $("imageWrap"), image: $("resultImage"),
    cropOverlay: $("cropOverlay"), cropRect: $("cropRect"), cropCanvas: $("cropCanvas"),
    loading: $("loading"), errorBox: $("errorBox"),
    textWrap: $("textWrap"), text: $("resultText"), confidence: $("confidence"),
    copy: $("btnCopy"), crop: $("btnCrop"), ai: $("btnAI"),
    search: $("btnSearch"), ig: $("btnIG"),
    capture: $("btnCapture"), pin: $("btnPin"), settings: $("btnSettings"), close: $("btnClose"),
  };

  let currentImage = null;
  let isEditingCrop = false;
  let cropStart = null;
  let cropEnd = null;
  let isDragging = false;

  function setActionsEnabled(enabled) {
    [els.copy, els.crop, els.search, els.ig].forEach((b) => (b.disabled = !enabled));
    window.electronAPI.ocr.isGeminiAvailable().then((ok) => {
      els.ai.disabled = !enabled || !ok;
    });
  }

  function showLoading(image) {
    currentImage = image || currentImage;
    if (currentImage) {
      els.image.src = currentImage;
      els.imageWrap.style.display = "";
    }
    els.loading.style.display = "";
    els.errorBox.style.display = "none";
    els.textWrap.style.display = "none";
    els.confidence.textContent = "";
    setActionsEnabled(false);
  }

  function showResult(payload) {
    currentImage = payload.image || currentImage;
    if (currentImage) {
      els.image.src = currentImage;
      els.imageWrap.style.display = "";
    }
    els.loading.style.display = "none";
    els.errorBox.style.display = "none";
    els.textWrap.style.display = "";
    els.text.textContent = payload.text || "";
    els.confidence.textContent = payload.methodDisplay || "";
    setActionsEnabled(true);
  }

  function showError(message) {
    els.loading.style.display = "none";
    els.errorBox.style.display = "";
    els.errorBox.textContent = message;
    els.textWrap.style.display = "none";
    setActionsEnabled(false);
    if (currentImage) els.ai.disabled = false; // 仍可用 AI 重試
    window.electronAPI.ocr.isGeminiAvailable().then((ok) => {
      if (!ok) els.ai.disabled = true;
    });
  }

  function getCurrentText() {
    const sel = window.getSelection();
    const selected = sel && sel.toString().trim();
    return selected || els.text.textContent || "";
  }

  // --- 動作列 ---
  els.copy.addEventListener("click", async () => {
    const text = getCurrentText();
    if (!text) return;
    await window.electronAPI.clipboard.writeText(text);
    els.copy.textContent = "✓ 已複製";
    els.copy.classList.add("copied");
    setTimeout(() => {
      els.copy.textContent = "📋 複製";
      els.copy.classList.remove("copied");
    }, 2000);
  });

  els.search.addEventListener("click", () => {
    const text = getCurrentText();
    if (text) window.electronAPI.ocr.openExternal(
      "https://www.google.com/search?q=" + encodeURIComponent(text));
  });

  els.ig.addEventListener("click", () => {
    const text = getCurrentText();
    if (text) window.electronAPI.ocr.openExternal(
      "https://www.instagram.com/explore/search/keyword/?q=" + encodeURIComponent(text));
  });

  els.ai.addEventListener("click", async () => {
    if (!currentImage) return;
    showLoading(currentImage);
    const result = await window.electronAPI.ocr.gemini(currentImage);
    if (result.success) {
      showResult({ image: currentImage, text: result.text, methodDisplay: result.methodDisplay });
    } else {
      showError(result.error || "Gemini 辨識失敗");
    }
  });

  // --- 裁切重辨識（行為同原 app：在預覽圖上拖選 → 確認 → 對子圖重新 OCR）---
  els.crop.addEventListener("click", () => {
    isEditingCrop = true;
    els.imageWrap.classList.add("editing");
    els.crop.textContent = "✓ 確認裁切";
    els.crop.removeEventListener("click", null);
  });

  els.imageWrap.addEventListener("mousedown", (e) => {
    if (!isEditingCrop) return;
    const rect = els.imageWrap.getBoundingClientRect();
    cropStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    cropEnd = { ...cropStart };
    isDragging = true;
    els.cropOverlay.style.display = "";
    els.cropRect.style.display = "";
    updateCropRect();
  });
  els.imageWrap.addEventListener("mousemove", (e) => {
    if (!isDragging || !isEditingCrop) return;
    const rect = els.imageWrap.getBoundingClientRect();
    cropEnd = {
      x: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(e.clientY - rect.top, rect.height)),
    };
    updateCropRect();
  });
  els.imageWrap.addEventListener("mouseup", () => {
    if (!isEditingCrop || !isDragging) return;
    isDragging = false;
    applyCrop();
  });

  function updateCropRect() {
    if (!cropStart || !cropEnd) return;
    const left = Math.min(cropStart.x, cropEnd.x);
    const top = Math.min(cropStart.y, cropEnd.y);
    Object.assign(els.cropRect.style, {
      left: left + "px", top: top + "px",
      width: Math.abs(cropEnd.x - cropStart.x) + "px",
      height: Math.abs(cropEnd.y - cropStart.y) + "px",
    });
  }

  function exitCropMode() {
    isEditingCrop = false;
    isDragging = false;
    cropStart = cropEnd = null;
    els.imageWrap.classList.remove("editing");
    els.cropOverlay.style.display = "none";
    els.cropRect.style.display = "none";
    els.crop.textContent = "✂️ 裁切";
  }

  function applyCrop() {
    const img = els.image;
    if (!cropStart || !cropEnd || !img.naturalWidth) return exitCropMode();
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;
    const x1 = Math.min(cropStart.x, cropEnd.x) * scaleX;
    const y1 = Math.min(cropStart.y, cropEnd.y) * scaleY;
    const w = Math.abs(cropEnd.x - cropStart.x) * scaleX;
    const h = Math.abs(cropEnd.y - cropStart.y) * scaleY;
    if (w < 10 || h < 10) return exitCropMode();

    const canvas = els.cropCanvas;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, x1, y1, w, h, 0, 0, w, h);
    const cropped = canvas.toDataURL("image/png");
    exitCropMode();
    window.electronAPI.ocr.recognizeRegion(cropped);
  }

  // --- 標題列 ---
  els.capture.addEventListener("click", () => window.electronAPI.capture.startRegionCapture());
  els.pin.addEventListener("click", async () => {
    const pinned = await window.electronAPI.ocr.togglePin();
    els.pin.classList.toggle("active", pinned);
  });
  els.settings.addEventListener("click", () => window.electronAPI.settings.openWindow());
  els.close.addEventListener("click", () => window.close());

  // --- 鍵盤（同原 app：Esc 關閉、Ctrl+C 無選取時複製全文、Ctrl+P 釘選）---
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.close();
    else if ((e.ctrlKey || e.metaKey) && e.key === "p") { e.preventDefault(); els.pin.click(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      const sel = window.getSelection();
      if (!sel || !sel.toString().trim()) { e.preventDefault(); els.copy.click(); }
    }
  });

  // --- 主進程事件 ---
  window.electronAPI.on("ocr-start", (_e, payload) => showLoading(payload.image));
  window.electronAPI.on("ocr-result", (_e, payload) => showResult(payload));
  window.electronAPI.on("ocr-error", (_e, payload) => showError(payload.message));
})();
```

- [ ] **Step 4: 端到端手動驗證**

Run: `npm start`
1. 區域截一段**網頁文字**按 `5` → 結果視窗開啟，loading → 文字出現；方法顯示「視窗文字直讀」或「PaddleOCR」；第一次 Paddle 初始化會多等幾秒
2. 截一張**圖片裡的中文字**按 `5` → PaddleOCR 結果合理
3. 📋 複製 → 貼到記事本一致；選取部分文字再複製 → 只複製選取
4. 在文字區直接編輯 → 複製到的是編輯後文字
5. ✂️ 裁切 → 在預覽拖選一塊 → 自動對子圖重新辨識
6. 設定沒填 Gemini key → 🤖 AI 鈕停用
7. 🔍 搜尋 → 預設瀏覽器開 Google 搜尋該文字
8. 📌 釘選 → 視窗置頂、再按解除；Esc 關閉
9. **重啟 app 不按 5 → 啟動 console 無任何 OCR 引擎初始化訊息**

- [ ] **Step 5: Commit**

```bash
git add renderer/ocrResult.html renderer/js/ocrResult.js renderer/css/ocrResult.css
git commit -m "feat(ocr): result window UI ported from Screenshot-OCR ResultPopup"
```

---

### Task 6: 設定頁加 Gemini API key

**Files:**
- Modify: `renderer/settings.html`（在儲存位置設定區塊後加 OCR 區塊，跟隨現有 markup 風格）
- Modify: `renderer/js/settingsPage.js`（載入/儲存 `geminiApiKey`）
- Modify: `src/main.js`（確認 `get-settings`/`save-settings` 把 `geminiApiKey` 一起存取 — 若 settings 是整包物件直接 set/get 則無需改）

- [ ] **Step 1: settings.html 加欄位**

讀現有 settings.html 的儲存位置區塊 markup，複製同樣結構新增：標籤「Gemini API Key（選填，OCR 的 🤖 AI 重辨識用）」+ `<input type="password" id="geminiApiKey" placeholder="AIza...">`。

- [ ] **Step 2: settingsPage.js 接線**

依該檔現有「載入設定 → 填 UI / 儲存時收集 UI 值」的模式，把 `geminiApiKey` 加入載入與儲存兩端。儲存時寫入頂層 `store`（main.js 的 save-settings handler；若 handler 是整包 settings 物件存 store，確認 `geminiApiKey` 在物件內，且 `ocr-gemini` handler 的 `store.get("geminiApiKey")` 改成與儲存位置一致的讀法）。

**一致性檢查（重要）**：Task 3 的 `ocr-gemini` / `ocr-is-gemini-available` 用 `store.get("geminiApiKey")`，此步驟必須讓儲存端寫到同一個 key；若 settings 實際存成巢狀（如 `store.get("settings").geminiApiKey`），統一改 Task 3 兩處讀法。

- [ ] **Step 3: 手動驗證**

設定頁填入 key → 儲存 → 重開設定頁仍在；OCR 結果視窗 🤖 AI 鈕變可用；按下用真 key 辨識成功（或無 key 時保持停用）。

- [ ] **Step 4: Commit**

```bash
git add renderer/settings.html renderer/js/settingsPage.js src/main.js
git commit -m "feat(ocr): Gemini API key setting"
```

---

### Task 7: 打包驗證（onnxruntime 原生模組）

**Files:**
- Modify: `package.json`（build 設定）

- [ ] **Step 1: asarUnpack 設定**

`package.json` 的 `build` 內加：

```json
    "asarUnpack": [
      "node_modules/@gutenye/ocr-node/**",
      "node_modules/@gutenye/ocr-common/**",
      "node_modules/onnxruntime-node/**"
    ],
```

（實際套件名以 `npm ls` 看到的 @gutenye 相依為準，把含 `.node` 原生檔與模型檔的套件都列入。）

- [ ] **Step 2: 打包並冒煙**

```powershell
npm run build:win
```

Expected: build 成功。開 `dist\win-unpacked\DuckShot.exe` → 截圖按 `5` → PaddleOCR 能初始化並辨識（這是 asarUnpack 是否正確的關鍵驗證）。

- [ ] **Step 3: 回歸**

Run: `npm test`
Expected: PASS（toast 計畫的測試不受影響）

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(ocr): asarUnpack onnx/paddle native modules for packaging"
```

---

## Self-Review 記錄

- Spec 覆蓋：四層引擎（Task 1+2）、lazy init（Task 2 + Task 3 Step 6 驗證 + Task 5 驗證 9）、工具列 5（Task 4）、結果視窗一比一（Task 5，CSS 照抄）、Gemini 設定（Task 6）、打包 asarUnpack（Task 7）、歷史不移植（spec 已載明）✓
- Spec「後續」的 Screenshot-OCR README 互相指路：另一個 repo，不在本計畫，留待使用者指示 ✓
- 命名一致：`extractText`/`extractWithGemini`/`formatConfidence`（Task 2 定義、Task 3 使用）、IPC `ocr-recognize`/`ocr-recognize-region`/`ocr-gemini`/`ocr-toggle-pin`/`ocr-is-gemini-available`/`ocr-open-external`（Task 3 定義、Task 4/5 使用）✓
- 已知風險已標注：Task 6 geminiApiKey 儲存位置一致性檢查；Task 7 @gutenye 相依套件名以 npm ls 為準。
