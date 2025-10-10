# Dukshot 區域截圖優化 PRD

版本：2.0  
日期：2025-10-08  
目標：優化區域截圖體驗與效能

## 1. 背景與問題

### 目前問題
1. **右鍵操作邏輯不完整**：
   - 目前右鍵可以取消選區（重新選擇）
   - 但取消後再按右鍵無法關閉截圖視窗
   - 使用者需要按 ESC 或點擊取消按鈕才能退出

2. **區域截圖開啟速度慢**：
   - 從觸發到視窗顯示需要較長時間
   - 可能原因：
     - 雙重隱身策略等待時間過長（64ms）
     - 桌面擷取 API 調用耗時
     - 視窗建立與載入流程複雜
     - 高解析度圖片處理耗時

## 2. 優化目標

### 2.1 右鍵操作優化
- **目標**：實現直覺的兩階段右鍵邏輯
- **流程**：
  1. 第一次右鍵：取消目前選區，重新選擇（已實作）
  2. 第二次右鍵：關閉截圖視窗，回到主程式
- **使用者價值**：更直覺的操作體驗，減少誤操作

### 2.2 開啟速度優化
- **目標**：將區域截圖開啟時間縮短 50% 以上
- **優化方向**：
  1. 減少合成器等待時間
  2. 優化視窗建立流程
  3. 改善圖片載入與處理效能
  4. 並行化可並行的操作

## 3. 技術方案

### 3.1 右鍵操作邏輯實作

#### 3.1.1 狀態追蹤
在 `HighDPICaptureSystem` 類別中新增狀態：
```javascript
this.hasSelection = false;           // 是否有選區
this.rightClickCount = 0;            // 右鍵點擊次數
this.lastRightClickTime = 0;         // 最後右鍵時間
this.RIGHT_CLICK_TIMEOUT = 2000;     // 右鍵計數重置時間（2秒）
```

#### 3.1.2 事件處理
```javascript
document.addEventListener('contextmenu', (e) => {
  e.preventDefault(); // 防止預設右鍵選單
  
  const now = Date.now();
  
  // 超過時限則重置計數
  if (now - this.lastRightClickTime > this.RIGHT_CLICK_TIMEOUT) {
    this.rightClickCount = 0;
  }
  
  this.rightClickCount++;
  this.lastRightClickTime = now;
  
  if (this.hasSelection) {
    // 有選區：第一次右鍵 = 取消選區
    this.clearSelection();
    this.rightClickCount = 0; // 重置計數
  } else {
    // 無選區：第二次右鍵（或超時後第一次）= 關閉視窗
    if (this.rightClickCount >= 1) {
      window.close();
    }
  }
});
```

#### 3.1.3 選區狀態同步
在選區建立/清除時更新狀態：
```javascript
// 選區建立時
this.hasSelection = true;
this.rightClickCount = 0;

// 選區清除時
this.hasSelection = false;
```

#### 3.1.4 提示文字更新
動態更新操作提示：
- 有選區：「拖曳選區｜Esc 取消｜右鍵重選｜Enter 儲存｜Ctrl+C 複製」
- 無選區：「拖曳選區｜Esc/右鍵 退出」

### 3.2 開啟速度優化方案

#### 3.2.1 合成器等待時間優化
**目前實作**（[`src/main.js:1330`](src/main.js:1330)）：
```javascript
await optimizedSleep(COMPOSITOR_WAIT_TIME_2, "區域截圖-合成器等待"); // 64ms
```

**優化方案**：
1. 動態調整等待時間（已部分實作）
2. 測試最小可行等待時間
3. 根據系統負載自適應調整

**建議調整**：
```javascript
// 降低基準等待時間（測試 32ms 是否足夠）
const COMPOSITOR_WAIT_TIME_FAST = 32; // 從 64ms 降到 32ms
await optimizedSleep(COMPOSITOR_WAIT_TIME_FAST, "區域截圖-合成器等待");
```

#### 3.2.2 視窗建立優化
**目前流程**：
1. 隱藏主視窗（透明 + 最小化 + 移出螢幕）
2. 等待合成器
3. 擷取桌面
4. 建立截圖視窗
5. 載入 HTML
6. 傳送螢幕資料
7. 顯示視窗

**優化策略**：
1. **預建立視窗**：在應用啟動時預建立隱藏的截圖視窗（類似視窗池）
2. **並行處理**：主視窗隱藏與視窗建立並行執行
3. **快取機制**：快取上次截圖的桌面數據（可選）

**預建立視窗實作**：
```javascript
// 在 DukshotApp 初始化時
this.prewarmCaptureWindow = null;

async initialize() {
  // ... 現有初始化 ...
  
  // 預建立截圖視窗（隱藏）
  this.createPrewarmCaptureWindow();
}

createPrewarmCaptureWindow() {
  this.prewarmCaptureWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    transparent: true,
    show: false,
    // ... 其他設定 ...
  });
  
  this.prewarmCaptureWindow.loadFile(
    path.join(__dirname, "../renderer/capture.html")
  );
}

// 修改 startRegionCapture
async startRegionCapture() {
  // 若有預建立視窗，直接使用
  if (this.prewarmCaptureWindow) {
    this.captureWindow = this.prewarmCaptureWindow;
    this.prewarmCaptureWindow = null;
    
    // 立即預建立下一個
    this.createPrewarmCaptureWindow();
  } else {
    this.createCaptureWindow();
  }
  
  // ... 其他流程 ...
}
```

#### 3.2.3 桌面擷取優化
**目前問題**：
- 每次都要重新調用 `desktopCapturer.getSources()`
- 高解析度擷取耗時

**優化方案**：
1. **降低擷取解析度**（僅用於預覽，實際截圖仍用高解析度）
2. **快取短期內的桌面快照**（例如 500ms 內重用）
3. **使用更快的擷取模式**

```javascript
// 快取機制
this.lastScreenCapture = {
  data: null,
  timestamp: 0,
  TTL: 500 // 500ms 快取
};

// 檢查快取
const now = Date.now();
if (this.lastScreenCapture.data && 
    now - this.lastScreenCapture.timestamp < this.lastScreenCapture.TTL) {
  // 使用快取
  screenData = this.lastScreenCapture.data;
} else {
  // 重新擷取
  const sources = await desktopCapturer.getSources({...});
  screenData = sources[0].thumbnail.toDataURL();
  this.lastScreenCapture = { data: screenData, timestamp: now };
}
```

#### 3.2.4 圖片載入優化
**目前流程**（[`renderer/capture.html:635`](renderer/capture.html:635)）：
- 圖片載入 → 繪製到 canvas → 顯示

**優化方案**：
1. **使用 ImageBitmap**（更快的解碼）
2. **並行解碼**
3. **漸進式顯示**（先低解析度，再高解析度）

```javascript
async loadHighResScreenImage(screenData) {
  // 使用 ImageBitmap 加速
  const response = await fetch(screenData);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  
  // 直接繪製 bitmap
  this.ctx.drawImage(bitmap, 0, 0);
  
  // 清理
  bitmap.close();
}
```

## 4. 實作優先順序

### P0（立即實作）
1. ✅ 右鍵操作優化（低風險，高體驗提升）
2. ✅ 合成器等待時間降低至 32ms（需測試）

### P1（短期實作）
3. 預建立視窗機制（中等複雜度）
4. 圖片載入優化（ImageBitmap）

### P2（中長期優化）
5. 桌面擷取快取機制
6. 並行化處理流程

## 5. 測試計劃

### 5.1 功能測試
- ✅ 右鍵第一次取消選區
- ✅ 右鍵第二次關閉視窗
- ✅ 超時後右鍵重置計數
- ✅ 提示文字正確更新

### 5.2 效能測試
**測試指標**：
- 從快捷鍵觸發到視窗完全顯示的時間
- 目標：< 300ms（目前約 500-800ms）

**測試方法**：
```javascript
// 在 startRegionCapture 開始
console.time('region-capture-total');

// 在視窗顯示後
console.timeEnd('region-capture-total');
```

**測試場景**：
1. 單螢幕 1080p
2. 單螢幕 4K
3. 雙螢幕混合解析度
4. 高系統負載情況

### 5.3 相容性測試
- Windows 10/11
- 不同 DPI 設定（100%, 125%, 150%, 200%）
- 不同 GPU（整合/獨立）

## 6. 風險評估

### 6.1 右鍵操作
- **風險**：低
- **影響**：使用者體驗
- **緩解**：充分測試，保留 ESC 退出選項

### 6.2 等待時間縮短
- **風險**：中（可能導致主視窗殘影）
- **影響**：截圖品質
- **緩解**：
  1. 逐步降低（64ms → 48ms → 32ms）
  2. 充分測試各種場景
  3. 保留動態調整機制

### 6.3 預建立視窗
- **風險**：低-中
- **影響**：記憶體使用（+約 50MB）
- **緩解**：可選功能，預設關閉

## 7. 成功指標

### 7.1 功能指標
- ✅ 右鍵操作符合直覺（使用者測試反饋）
- ✅ 無操作邏輯 bug

### 7.2 效能指標
- 開啟速度 < 300ms（P99）
- 記憶體增長 < 100MB
- CPU 峰值使用率 < 30%

### 7.3 品質指標
- 主視窗殘影率 < 1%
- 無明顯視覺閃爍
- 截圖品質不降低

## 8. 實作時程

### 第一週
- [ ] 實作右鍵操作優化
- [ ] 測試合成器等待時間縮短
- [ ] 效能基準測試

### 第二週  
- [ ] 實作預建立視窗機制
- [ ] 圖片載入優化
- [ ] 整合測試

### 第三週
- [ ] 效能調優
- [ ] 文件更新
- [ ] 發布測試版

## 9. 參考資料

### 相關檔案
- [`src/main.js`](src/main.js) - 主進程，截圖流程控制
- [`renderer/capture.html`](renderer/capture.html) - 截圖介面與邏輯
- [`renderer/js/capture.js`](renderer/js/capture.js) - 截圖管理器

### 技術參考
- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Canvas ImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap)
- [Web Performance APIs](https://developer.mozilla.org/en-US/docs/Web/API/Performance)

## 10. 後續優化方向

1. **智慧快取**：機器學習預測使用者截圖模式
2. **GPU 加速**：使用 WebGL 處理圖片
3. **增量更新**：僅擷取變化區域
4. **背景預載**：閒置時預先準備資源