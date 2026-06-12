# Save-then-Sort Toast（存檔後快速分類）設計

日期：2026-06-12
狀態：已與使用者確認設計方向

## 目標

截圖有不同目的（靈感收集、美學參考⋯）。讓使用者在存檔後一鍵把截圖移到分類資料夾，
且**完全不改變現有截圖流程的順暢度** — 不分類就跟現在一模一樣。

## 核心決策（已確認）

1. **互動模式：存完再分類。** 截圖照常存到預設資料夾，存檔成功後跳出右下角 toast，
   上面有分類按鈕可一鍵移過去。不在截圖 overlay 內加選資料夾的步驟。
2. **資料夾來源：直接用 galleryTabs。** Gallery 的 tab（`{ name, path }`，存於
   electron-store 的 `galleryTabs`）就是分類資料夾。使用者在 gallery 按「+」新增 tab，
   toast 就自動多一顆對應按鈕。不新增任何獨立設定。

## 使用者流程

1. 按 `2` / `Enter` 存檔 → 照樣存到預設資料夾、複製到剪貼簿、關閉截圖 overlay（不變）。
2. 右下角出現 toast：縮圖 +「✓ 已儲存到 <預設資料夾名>」+ 一排分類按鈕
   （= galleryTabs 中預設資料夾以外的每個 tab）。
3. 點分類按鈕 → 檔案移到該 tab 的資料夾，按鈕變 ✓，toast 收掉。
4. 約 5 秒無互動自動淡出（滑鼠 hover 暫停倒數）。沒點 = 留在預設資料夾。

## 涵蓋範圍

- 跳 toast：一般儲存（`2`/`Enter`）、連續截圖（`4`，每張都跳、新 toast 取代舊的）、
  全螢幕/視窗截圖（`saveScreenshotDirect`）。
- 不跳 toast：複製（`1`）、上傳（`3`）— 沒有檔案落地；
  以及 galleryTabs 只有預設一個 tab 時 — 行為與現在完全相同。

## 技術設計

### 元件

| 元件 | 職責 |
|------|------|
| `src/main.js` | 各存檔路徑成功後呼叫 `showSortToast(filePath)`；建立/重用 toast 視窗 |
| `renderer/toast.html`（新檔） | toast UI：縮圖、訊息、分類按鈕、自動消失倒數 |
| IPC `move-screenshot(filePath, targetDir)`（新增） | 主進程搬檔 |
| IPC `get-gallery-tabs`（既有） | toast 取得分類按鈕清單 |

### Toast 視窗

- 小型 BrowserWindow：無邊框、置頂、不搶焦點（`focusable: false` 或 show 時不 focus）、
  跳過工作列、定位於主螢幕右下角工作區內。
- 單一實例重用：連續截圖時更新內容並重設倒數，不堆疊多個視窗。

### 搬檔邏輯（move-screenshot）

- `fs.rename`；跨磁碟（EXDEV）時 fallback 為 copy + delete。
- 目標已有同名檔 → 自動加序號（`name (1).png`）。
- 失敗（資料夾不存在、權限）→ 回傳錯誤，toast 顯示錯誤訊息，檔案留在原地。

### 資料流

```
存檔成功 (main.js 取得 filePath)
  → showSortToast(filePath)
  → toast.html 載入 galleryTabs，過濾掉 path === 預設儲存資料夾的 tab
  → 使用者點按鈕 → invoke move-screenshot(filePath, tab.path)
  → 成功：顯示 ✓ 後關閉 toast
```

Gallery 端零修改：檔案搬進 tab 資料夾後，切到該 tab 自然列出。

## 測試重點

- move-screenshot：正常搬移、同名加序號、跨磁碟 fallback、目標資料夾不存在的錯誤處理。
- 只有預設 tab 時不跳 toast。
- 連續截圖時 toast 取代而非堆疊。
- toast 不搶焦點（不打斷使用者正在打字的視窗）。

## 不做（YAGNI）

- 截圖 overlay 內的資料夾選單或數字鍵直達分類。
- toast 上「新增資料夾」按鈕（去 gallery 加即可）。
- 獨立於 galleryTabs 的分類設定。
- 移動歷史 / undo（檔案總管可手動搬回）。
