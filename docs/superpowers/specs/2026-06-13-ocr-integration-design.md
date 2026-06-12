# OCR 整合（移植 Screenshot-OCR）設計

日期：2026-06-13
狀態：已與使用者確認設計方向
來源：https://github.com/Jeffrey0117/Screenshot-OCR

## 目標

把 Screenshot-OCR 的文字辨識整套搬進 DuckShot，成為截圖工具列的第 5 個動作。
使用者裝一款 DuckShot 就同時有截圖管理 + OCR，不用裝兩個 Electron app
（兩個 app ≈ 400MB、快捷鍵互搶；融合 ≈ 280MB、一組快捷鍵）。

## 核心決策（已確認）

1. **融合為一款 app**，不做「加裝模組」或安裝期選配。
2. **四層辨識引擎全搬**：UI Automation → PaddleOCR → Tesseract，Gemini AI 手動觸發。
   程式碼從原 repo 移植（TS → 純 JS）。
3. **全部 lazy init**：引擎不在 app 啟動時初始化，第一次按 OCR 才載入
   （原 repo 是啟動即 `initOcr()`，移植時改掉）。不用 OCR 就零運行成本。
4. **結果視窗一模一樣**：`ResultPopup.css` 原封照抄，行為一比一以純 JS 重寫
   （DuckShot 無 React/打包器，不為單一視窗引入）。
5. **Screenshot-OCR 不退役**：其 README 加註「若同時需要截圖儲存/管理，DuckShot
   已內建同款 OCR；只需要 OCR 可繼續用本款」。兩產品互相指路。

## 使用者流程

1. 截圖選取範圍後，工具列新增 `5 = 文字辨識`（在 1 複製、2 儲存、3 上傳、4 連續之後）。
2. 按 5 → 關閉截圖 overlay → 開啟結果視窗（無邊框 popup，同原 app 外觀）：
   - 上半：截圖預覽（可在預覽上重新框選 → 對子區域重新辨識）
   - 中間：辨識文字（contentEditable 可直接修改）+ 辨識方法與信心度
   - 動作列：📋 複製、✂️ 裁切、🤖 AI（Gemini 重辨識）、🔍 Google 搜尋、📷 IG 搜尋
   - 標題列：📌 釘選（置頂）、✕ 關閉；Esc 關閉、Ctrl+C 複製全文
3. 辨識中顯示 spinner 與取消按鈕。

## 辨識管線（照搬 textExtractor 邏輯）

```
extractText(imageData, screenBounds)
  1. UI Automation（PowerShell + System.Windows.Automation）
     — 有 screenBounds 時先試；視窗文字元素直讀，100% 準、極快、零依賴
  2. PaddleOCR（@gutenye/ocr-node，ONNX）— 中文主力，離線
  3. Tesseract.js — fallback；語言檔（eng+chi_tra）首次使用時從 CDN 下載
  Gemini AI（@google/generative-ai）— 僅結果視窗按 🤖 AI 手動觸發，需 API key
```

含 `imagePreprocess`（jimp：放大 2x、灰階、auto-invert、對比 1.5）照搬。

## 技術設計

### 移植對照

| 原 repo (TS) | DuckShot (JS) | 說明 |
|---|---|---|
| `src/main/ocr.ts` | `src/ocr/tesseract.js` | 型別拿掉直翻 |
| `src/main/paddleOcr.ts` | `src/ocr/paddle.js` | 同上 |
| `src/main/geminiOcr.ts` | `src/ocr/gemini.js` | 同上 |
| `src/main/uiAutomation.ts` | `src/ocr/uiAutomation.js` | 同上 |
| `src/main/imagePreprocess.ts` | `src/ocr/imagePreprocess.js` | 同上 |
| `src/main/textExtractor.ts` | `src/ocr/textExtractor.js` | 改為全 lazy init |
| `src/renderer/components/ResultPopup.tsx` | `renderer/ocrResult.html` + `renderer/js/ocrResult.js` | React → 純 JS 重寫 |
| `src/renderer/styles/ResultPopup.css` | `renderer/css/ocrResult.css` | 原封照抄 |

新增依賴：`tesseract.js`、`@gutenye/ocr-node`、`jimp`、`@google/generative-ai`。

### 主進程整合（src/main.js）

- IPC `ocr-recognize(imageData, screenBounds)`：呼叫 `textExtractor.extractText`，
  回傳 `{ text, method, confidence }`。
- IPC `ocr-gemini(imageData)`、`ocr-cancel`。
- 結果視窗：無邊框 BrowserWindow，載入 `ocrResult.html`；釘選 = `setAlwaysOnTop`。
- 結果視窗的標題列按鈕對應 DuckShot 既有功能：📷 再截圖 → 觸發區域截圖、
  ⚙️ 設定 → DuckShot 設定頁。原 app 的「歷史」功能暫不移植（DuckShot 的
  gallery 即截圖歷史；純文字歷史屬 YAGNI，可日後補）。

### 截圖 overlay（renderer/capture.html）

- 數字鍵 `5` + 工具列按鈕「文字辨識」。
- 把選取區 imageData + 螢幕座標（給 UIA 用）送主進程後關閉 overlay。

### 設定頁

- 新增 OCR 區塊：Gemini API key（選填；空 = 🤖 AI 鈕停用）。
- OCR 語言、前處理參數先用原 repo 預設值，不開放 UI（YAGNI）。

## 邊界情況

- 三層引擎全失敗 / 無文字 → 結果視窗顯示錯誤訊息（同原 app）。
- Tesseract 語言檔 CDN 下載失敗（如 TLS 攔截環境）→ 該層 fallback 失敗不擋
  前兩層；錯誤訊息照實顯示。
- Paddle 初始化中再按 OCR → 重用同一初始化 Promise，不重複載入。
- 打包：`@gutenye/ocr-node` 的 onnxruntime 原生模組需確認 electron-builder
  `asarUnpack`，安裝包預估 +80MB。

## 測試重點

- textExtractor 層級 fallback 順序與 lazy init（啟動時不得載入任何 OCR 依賴）。
- 結果視窗：複製（全文/選取）、編輯後複製為新文字、重新框選後重新辨識、
  Gemini 無 key 時按鈕停用。
- 打包後（win-unpacked）PaddleOCR 可正常初始化。

## 不做（YAGNI）

- React/打包器引入。
- 文字歷史（History）視窗。
- OCR 語言/前處理設定 UI。
- 安裝期選配 OCR 模組。

## 後續（非本專案內）

- Screenshot-OCR repo README 加 DuckShot 互相指路說明（由使用者或另行處理）。
