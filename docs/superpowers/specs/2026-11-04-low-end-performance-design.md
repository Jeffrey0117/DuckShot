# DuckShot 低階筆電效能強化 — 設計

日期：2026-11-04
目標機器：老舊筆電（雙核 CPU、4GB RAM、無獨顯、1366×768 或 1080p、可能離線）。
原則：**少做事 > 做快一點**。每條改動都要能說出「省掉了哪個工作」。

## 1. 現況問題（實際讀碼確認）

| # | 位置 | 問題 | 影響 |
|---|------|------|------|
| 1 | `renderer/js/fileManager.js`, `main.js list-screenshots` | 圖庫每張卡片 `<img src>` 直接指向**全解析度** PNG；主進程縮圖 IPC 是死碼（`thumbnail` 永遠有值 → 隊列永遠空） | 500 張截圖 = 500 次全圖解碼，記憶體與 CPU 爆 |
| 2 | `list-screenshots` | 檔案 id = `path:Date.now()`，每次 refresh 都是新 id → grid diff 永遠全刪全建；stat 在 `return` 之後才做，資料永遠到不了 renderer（size=0、createdAt=now、排序失效） | 每次視窗 focus 都整格重繪 |
| 3 | `renderer/index.html` | Lucide 從 unpkg CDN `@latest` 同步載入；離線時 `lucide` undefined → `createIcons()` 在通知/網格路徑直接拋錯 | 啟動多一趟網路、離線壞掉 |
| 4 | `ui.js`/`main.js` | `lucide.createIcons()` 每次通知、每次網格更新都掃**整份文件** | 無謂 DOM 掃描 |
| 5 | `src/main.js createCaptureWindow` | 每次截圖新建 BrowserWindow + 載入 capture.html | 老機器 200~500ms 才看到覆蓋層 |
| 6 | `getValidSaveDir`, `ocr/uiAutomation.js` | `exec('powershell …')` 無 `windowsHide`、無快取 | 黑窗閃爍、每次 300ms+ |
| 7 | `getDynamicWaitTime` | `os.loadavg()` 在 Windows 永遠 0 → 永遠「低負載」分支；每次還呼叫 `os.cpus()` | 死邏輯 |
| 8 | `ocr/textExtractor.js` | UIA 成功時 PaddleOCR 仍冷啟動（ONNX 模型載入、數百 MB） | 老機器 OCR 時整台卡 |
| 9 | `capture.html` | 存檔/複製用 `toDataURL`（同步、主執行緒）+ base64 → IPC → Buffer 解碼 | 大選區卡頓、記憶體 ×2 |
| 10 | `capture.html` | 鴨鴨游標 `duck-bob` 無限動畫 + `drop-shadow` 在全螢幕透明視窗 | 覆蓋層期間持續出幀 |
| 11 | `main.js` 啟動參數 | `--disable-software-rasterizer`（無 GPU 老機反而危險）、`--disable-features=VizDisplayCompositor`（早已無效） | 清掉 |
| 12 | `getOptimalThumbnailSize` | `Math.max(w,1920)` / 後備 8K → 1366×768 機器被要求放大擷取 | 全螢幕/視窗截圖更慢更糊 |
| 13 | `display-metrics-changed` | 每次觸發都 `getSources`（200~500ms） | 工作列自動隱藏等事件連發 |

## 2. 改動

### 2.1 圖庫（最大宗）
- `list-screenshots` 改為 `src/lib/listImages.js` 純函式：`readdir` + 並行 `stat`，回傳 `{ name, path, size, mtimeMs }`，依 mtime 降冪。id = `${path}|${mtimeMs}`（穩定，檔案沒變就不變）。
- renderer 卡片一律先放 placeholder，`IntersectionObserver` 進視口才產縮圖；縮圖在 **renderer** 用 `createImageBitmap(blob, { resizeWidth })` 產生（Chromium 內部解碼縮放、不佔主進程），結果存 `canvas.toBlob` → object URL，LRU 400 張，驅逐時 `revokeObjectURL`。並行度 2。
- 主進程 `fs.watch` 目前瀏覽的資料夾（debounce 300ms）→ `folder-changed` 事件；移除 focus 定時 refresh 與存檔後的 `setTimeout(refresh)` 補刀。watch 失敗時退回 focus refresh。
- `capture-completed` 不再夾帶整張 base64，只送路徑。
- `getFilteredFiles` 以 `mtimeMs` 數字排序。

### 2.2 圖示
- `scripts/build-icons.js` 從 `lucide-static` 抽出用到的 icon 內容，產出 `renderer/js/icons.js`（已 commit，使用者不需重 build）。
- 提供 `window.lucide.createIcons({ root })` 相容介面，只掃指定根節點；呼叫端改傳剛建立的節點。
- 移除 CDN `<script>`。

### 2.3 覆蓋層常駐
- 啟動後預建隱藏的截圖覆蓋層視窗並常駐；截圖 = `setBounds(目標螢幕)` + 送 `screen-data` + `show`。
- renderer 關閉改為送 `capture-dismiss` IPC；主進程 `hide()` 並執行原本 `closed` 的還原邏輯（主視窗還原、OCR 延後還原）。
- 每次 `screen-data` 到達時 renderer 重置狀態（選區、工具列、modal、右鍵武裝、提示文字、DPR、canvas 尺寸）。
- 隱藏時清空 canvas 釋放點陣圖。視窗若被銷毀（renderer crash）則下次重建。

### 2.4 主進程雜項
- `getValidSaveDir`：Pictures 路徑解析結果快取（process 生命週期）；`exec` 加 `windowsHide: true`。UIA 同樣加 `windowsHide`。
- 合成器等待改常數 48ms（主視窗可見時才等）。
- `getOptimalThumbnailSize` → 依「游標所在螢幕」實際物理像素；不再放大。全螢幕截圖改抓游標所在螢幕。
- `display-*` 事件 debounce 500ms 後才 `refreshScreenSourceId`。
- 清掉無效 Chromium switch。
- `get-thumbnail`（toast 用）去掉逐次 log。

### 2.5 截圖資料路徑
- `capture.html` 新增 `selectionToPng()`：`toBlob` → `ArrayBuffer`（非同步編碼、零 base64）。`save-screenshot` 與 `clipboard-write-image` 接受 `ArrayBuffer/Uint8Array`（`nativeImage.createFromBuffer`）。OCR/上傳路徑維持現狀。
- 移除 `duck-bob` 動畫（鴨鴨改靜態）。

### 2.6 OCR
- PaddleOCR 只有在「實例已暖」時才與 UIA 並行；冷的時候先跑 UIA，UIA 失敗才初始化 Paddle。
- `imagePreprocess.js`：彩色像素改計數（不再 push 百萬筆陣列）。

## 3. 非目標
- 不改 UI 外觀、不改快捷鍵、不換 OCR 引擎、不動設定頁架構（`nodeIntegration` 問題另案）。
- 不做磁碟縮圖快取（先用 renderer 記憶體 LRU，量測後再說）。

## 4. 驗證
- `npm test`：`listImages`、`saveDir` 解析、icons 產出。
- 手動：啟動（離線也要有圖示）、Alt+A 連按三次覆蓋層秒出、存檔後圖庫立即出現且不整格重繪、500 張資料夾捲動不卡、OCR 一次。

## 5. 審查後補強（同日）

code review 抓到的問題與處置：

- **縮放比不再用 `devicePixelRatio`**：`screen-data` 多帶 `boundsWidth/boundsHeight/scaleFactor`，覆蓋層以「擷取幀物理寬 ÷ 螢幕 DIP 寬」算縮放。`highDpiCapture` 關閉、或視窗剛搬到不同 DPI 的螢幕時，選區裁切才會正確。畫布 CSS 尺寸改 `100vw/100vh`。
- **覆蓋層透明門控**：顯示前 `setOpacity(0)`，renderer 畫好凍結幀送 `capture-drawn` 才調回 1（4 秒保險）。重用視窗不會閃上一次的殘影，視訊流也絕不會把覆蓋層截進畫面（煙霧測試以桌面亮度 vs 凍結幀亮度比對驗證）。renderer 關閉時先 `resetState()`、等兩幀再送 `capture-dismiss`。
- **連續截圖改走視訊流**（不再主進程整張 PNG + base64 IPC）；且只轉透明不 `hide()`：hide/show 會讓首幀偶發拖到 2~3 秒。
- **序號作廢**：每輪 `captureSeq+1`，Esc 後才回來的串流/後備結果直接丟棄；後備 IPC 在 `captureActive=false` 時拒絕。
- **toast 數字鍵**：覆蓋層收掉時若 toast 還在，重新註冊 1~9。
- **資料夾監看**：`watch-folder` 只接受預設資料夾或 galleryTabs；watcher 出錯送 `folder-watch-lost` 讓前端退回 focus 刷新；首次存檔後若尚未監看會再掛一次。載入中切分頁改載「最後要求的」資料夾。
- **縮圖 LRU 驅逐**時同時清掉仍在 DOM 的 `<img>` 並重新觀察（記憶體真的回收）；超寬圖寬度封頂、透明 PNG 鋪白底、失敗 2 秒後重試一次。
- **OCR 冷啟動**：UIA 先跑 1.5 秒內成功就不碰 Paddle；超過 1.5 秒 Paddle 提前並行開跑（不再最壞等 UIA 10 秒）。
- `save-screenshot` 加來源視窗檢查與 64MB 上限；覆蓋層載入失敗/逾時會 reject 並重建；保留 `--disable-gpu-sandbox`；合成器等待維持 56ms。
- 未處理（已知）：`getUserMedia` 桌面擷取啟動偶發 1~3 秒（OS 層，舊版同樣存在）。

## 6. 上傳鏈（2026-11-06，Jeff 定案）

- 順序固定 **URUSAI!（第三方、免費匿名）→ duk.tw（自家）備援**。自家只在真的需要時用：設定頁填 `x-api-key` 才啟用，另有「啟用 duk.tw 備援」開關。
- 實作 `src/upload/providers.js`：`buildProviderChain(settings, env)` + `uploadWithFallback(providers, ctx)`，fetch 注入（主進程用 `net.fetch`，測試用假的）。任一家失敗（HTTP 錯、逾時、回應格式不符）換下一家；全失敗回 `上傳失敗（urusai: …；duk: …）`。
- duk.tw 契約（upimg CLAUDE.md）：multipart 欄位 `image`、header `x-api-key`、回 `{ shortUrl }`。
- 設定存 `settings.upload = { urusaiToken, dukApiKey, dukEnabled }`，相容舊頂層 `urusaiToken` / `dukApiKey` 與 env `URUSAI_TOKEN` / `UPIMG_UPLOAD_KEY`。
- 設定頁新增「上傳圖床」區塊；上傳成功彈窗顯示用了哪家。
- `upload-duk` IPC 加來源視窗檢查與 64MB 上限。
