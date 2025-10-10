# Dukshot MVP 開發路線圖與測試檢查清單

版本：1.0  
日期：2025-10-06  
基於：[prd.md](prd.md)

## MVP 思維原則

1. **核心價值優先**：先完成「截圖 → 儲存 → 分享」的最小閉環
2. **快速驗證**：每個功能完成後立即可測試與驗證
3. **漸進式增強**：從必須 → 重要 → 優化，分階段交付
4. **用戶體驗完整**：即使功能精簡，但體驗必須流暢無阻

## 階段劃分

### Phase 0：穩定現有核心（已完成 ✅）
- [x] 區域/全螢幕/視窗截圖流程
- [x] HiDPI 擷取與防模糊
- [x] 檔案儲存與命名
- [x] 基本 UI（主視窗、通知、主題）
- [x] 主視窗置頂切換
- [x] 全域快捷鍵管理器（主進程端）

### Phase 1：MVP 核心補完（本週目標）

**目標**：讓使用者完整走完「截圖 → 調整 → 上傳 → 分享」流程，無卡點

#### 1.1 截圖工具列自動定位（P0 - 必須）
- [ ] **實作** `updateToolbarPosition()` 於 [renderer/js/capture.js](renderer/js/capture.js)
  - 計算選區位置與螢幕邊界
  - 優先順序：上方 → 下方 → 右側 → 左側
  - 保持至少 8px 距離選區
  - 完全可視（不超出視窗）
- [ ] **整合** 於拖曳與縮放事件中呼叫
  - `onMouseMove` 中若 `isDraggingSelection` 或 `isResizing` 則呼叫
  - 節流（throttle 16ms）避免過度計算
- [ ] **測試場景**
  - 選區在四角（左上/右上/左下/右下）
  - 選區貼近螢幕邊緣
  - 極小選區（< 100px）
  - 極大選區（接近全螢幕）
  - 多螢幕與不同縮放比例

**驗收標準**：
- ✓ 任何選區位置/大小，工具列始終完全可見
- ✓ 工具列不遮擋選區內容
- ✓ 調整選區時工具列流暢跟隨（無閃爍/跳動）

#### 1.2 圖片上傳與結果彈窗（P0 - 必須）
- [ ] **API 整合**（[renderer/js/capture.js](renderer/js/capture.js)）
  - 新增 `uploadScreenshot()` 方法
  - Canvas → Blob → FormData(file, token, r18)
  - POST https://api.urusai.cc/v1/upload
  - 錯誤處理（網路/500/超時/格式錯誤）
- [ ] **工具列上傳按鈕**（[renderer/capture.html](renderer/capture.html)）
  - 新增按鈕與圖示（lucide upload 或 cloud-upload）
  - 綁定點擊事件至 `uploadScreenshot()`
- [ ] **結果彈窗 UI**（modal/overlay）
  - **Loading 狀態**
    - 半透明遮罩 + 置中卡片
    - 顯示進度動畫（spinner 或 progress bar）
    - 文字：「正在上傳...」
    - 禁用其他操作（disable toolbar）
  - **Success 狀態**
    - 縮圖預覽（若 API 回傳）
    - 三種連結（可複製）：
      - 預覽連結（view_url）
      - 直連連結（direct_url）
      - 刪除連結（delete_url）
    - 一鍵複製按鈕（每個連結旁）
    - 自動複製直連到剪貼簿
    - 成功訊息（綠色、icon check-circle）
    - 關閉按鈕
  - **Error 狀態**
    - 錯誤訊息（紅色、icon alert-circle）
    - 重試按鈕
    - 取消/關閉按鈕
    - 保留截圖視窗（不自動關閉）
- [ ] **Token 管理**（安全考量）
  - Token 存於主進程設定（[src/main.js](src/main.js) store）
  - 透過 IPC `get-upload-token` 取得（不明文前端）
  - 設定頁提供輸入/更新介面

**測試場景**：
- 網路正常 200 成功
- 網路離線/超時
- API 返回 400/500 錯誤
- 格式錯誤回應（非 JSON）
- 複製功能（三種連結各測）
- 自動複製直連驗證

**驗收標準**：
- ✓ 上傳成功顯示三連結，可複製，直連自動入剪貼簿
- ✓ 失敗有明確訊息與重試按鈕
- ✓ 上傳期間 UI 清楚反饋，無法誤操作
- ✓ Token 不明文前端，僅主進程持有

#### 1.3 快捷鍵設定 UI 完整化（P1 - 重要）
- [ ] **設定頁 UI 新增**（[renderer/settings.html](renderer/settings.html)）
  - 「快捷鍵設定」區塊
  - 總開關：「啟用全域快捷鍵」（checkbox）
  - 三項快捷鍵（區域/全螢幕/視窗）：
    - 名稱 label
    - 啟用開關（checkbox）
    - 目前組合顯示（readonly input 或 badge）
    - 編輯按鈕 → 開啟錄鍵模式
    - 重設按鈕 → 恢復預設值
- [ ] **錄鍵器實作**（[renderer/js/settingsPage.js](renderer/js/settingsPage.js)）
  - 點擊編輯後進入「等待按鍵」狀態
  - 監聽 keydown 事件，記錄 Ctrl/Alt/Shift/主鍵
  - 正規化為 Accelerator 格式（與主進程同序）
  - 限制：單鍵 或 1~2 修飾鍵 + 1 主鍵
  - 非法組合提示（如 Ctrl+Shift+Alt+X）
  - ESC 取消錄鍵
- [ ] **儲存與套用**
  - 呼叫 IPC `update-shortcuts` 或 `save-settings`
  - 解析主進程返回的 `failures` 與 `warnings`
  - 即時顯示錯誤/警告訊息（toast 或 inline）
  - Windows 修飾鍵+PrintScreen 顯示黃色警告（來自 warnings）
- [ ] **文案與引導**
  - 預設值說明（region: Ctrl+R, fullscreen: PrintScreen, window: Alt+W）
  - 跨平台注意事項（macOS Cmd, Windows/Linux Ctrl）
  - PrintScreen 限制提示（部分系統保留）

**測試場景**：
- 錄鍵正常（Ctrl+Shift+S）
- 錄鍵非法（三個修飾鍵）
- 錄鍵衝突（已被系統/其他軟體佔用）
- Windows 修飾鍵+PrintScreen 警告顯示
- 重設為預設值
- 總開關 ON/OFF 立即生效

**驗收標準**：
- ✓ 錄鍵流程直觀，限制清楚
- ✓ 非法/衝突有即時錯誤提示
- ✓ 儲存後立即生效（無需重啟）
- ✓ Windows PrintScreen 警告顯示

---

### Phase 2：體驗增強（下週目標）

**目標**：提升易用性與專業感

#### 2.1 全螢幕瀏覽模式（P1 - 重要）
- [ ] **F11 切換邏輯**（[renderer/js/main.js](renderer/js/main.js)）
  - `toggleFullscreen()` 實作：隱藏工具列、側邊欄、狀態列
  - 保留圖片網格與快捷導覽（方向鍵/PgUp/PgDn）
  - ESC 退出
  - 狀態同步（`this.isFullscreen`）
- [ ] **UI 狀態切換**
  - CSS class `.fullscreen-mode` 控制元素顯示/隱藏
  - 平滑過渡動畫（transition 200ms）
- [ ] **鍵盤導覽**
  - 左右鍵切換圖片
  - 空格鍵播放/暫停（若需幻燈片）
  - ESC 退出

**驗收標準**：
- ✓ F11 與 ESC 切換流暢
- ✓ 大量圖片時無明顯卡頓
- ✓ 快捷鍵正常運作

#### 2.2 系統托盤（P2 - 優化）
- [ ] **托盤圖示與選單**（[src/main.js](src/main.js)）
  - 使用 Electron Tray API
  - 選單項：
    - 開啟主視窗
    - 開始區域截圖
    - 切換置頂
    - 分隔線
    - 退出
- [ ] **最小化到托盤設定**
  - 設定選項：「最小化到托盤」（checkbox）
  - 關閉/最小化行為依設定執行
  - 托盤圖示點擊還原視窗

**驗收標準**：
- ✓ 最小化到托盤與還原正常
- ✓ 選單項功能正確
- ✓ 退出完全關閉應用

---

### Phase 3：進階功能（後續優化）

#### 3.1 上傳增強
- [ ] 上傳歷史記錄（本地存儲或資料庫）
- [ ] 批次上傳多張截圖
- [ ] 上傳前壓縮選項（quality slider）
- [ ] 浮水印功能（文字/圖片）

#### 3.2 檔案管理增強
- [ ] 標籤/分類系統
- [ ] 星號收藏
- [ ] 高級搜尋（日期範圍/尺寸/類型）

#### 3.3 跨平台優化
- [ ] macOS 原生快捷鍵文案
- [ ] Linux 桌面環境適配

---

## 測試檢查清單（依 Phase）

### Phase 1 測試（本週必完成）

#### 工具列定位測試
- [ ] 選區左上角：工具列在下方或右側
- [ ] 選區右上角：工具列在下方或左側
- [ ] 選區左下角：工具列在上方或右側
- [ ] 選區右下角：工具列在上方或左側
- [ ] 選區中央：工具列在上方
- [ ] 選區貼近頂部：工具列在下方
- [ ] 選區貼近底部：工具列在上方
- [ ] 極小選區（50x50）：工具列完全可視
- [ ] 極大選區（接近全螢幕）：工具列在邊緣可見
- [ ] 拖曳選區：工具列流暢跟隨
- [ ] 縮放選區：工具列即時調整
- [ ] 多螢幕：各螢幕定位正確
- [ ] 高 DPI（150%/200%）：定位與尺寸正確

#### 上傳功能測試
- [ ] 正常上傳：顯示三連結，可複製
- [ ] 自動複製直連：剪貼簿驗證
- [ ] 網路離線：顯示錯誤，可重試
- [ ] API 超時（mock 5s+）：顯示錯誤
- [ ] API 返回 500：顯示錯誤訊息
- [ ] API 返回非 JSON：錯誤處理正確
- [ ] 重試按鈕：可再次上傳
- [ ] 上傳期間：toolbar 禁用，loading 顯示
- [ ] 關閉彈窗：不影響截圖視窗
- [ ] Token 錯誤（401）：明確提示

#### 快捷鍵設定測試
- [ ] 總開關關閉：所有快捷鍵失效
- [ ] 總開關開啟：快捷鍵恢復
- [ ] 單項開關：該快捷鍵開關生效
- [ ] 錄鍵：Ctrl+Shift+S 成功
- [ ] 錄鍵非法：Ctrl+Shift+Alt+X 提示錯誤
- [ ] 錄鍵衝突：系統佔用提示
- [ ] Windows PrintScreen+修飾鍵：警告顯示
- [ ] 重設按鈕：恢復預設值
- [ ] 儲存後立即生效：無需重啟
- [ ] 跨重啟持久化：設定正確載入

### Phase 2 測試（下週）
- [ ] F11 全螢幕：UI 正確隱藏/顯示
- [ ] ESC 退出全螢幕：狀態恢復
- [ ] 全螢幕鍵盤導覽：左右鍵/空格/ESC
- [ ] 托盤圖示：顯示正確
- [ ] 托盤選單：各項功能正常
- [ ] 最小化到托盤：視窗隱藏
- [ ] 托盤還原：視窗顯示與狀態正確
- [ ] 退出：完全關閉無殘留

---

## 開發優先順序（MVP 思維）

### 本週必須完成（P0）
1. **截圖工具列自動定位**（核心體驗，無此功能操作受阻）
2. **上傳 API 整合與結果彈窗**（核心價值閉環，截圖 → 分享）

### 本週應該完成（P1）
3. **快捷鍵設定 UI 完整化**（可用性提升，解決衝突問題）

### 下週目標（P1-P2）
4. **全螢幕瀏覽模式**（體驗增強）
5. **系統托盤**（便利性）

### 後續優化（P3）
6. 上傳增強、批次、歷史
7. 檔案管理增強
8. 跨平台文案

---

## 風險與應對

| 風險 | 影響 | 應對 |
|------|------|------|
| 工具列定位計算覆雜 | 開發延遲 | 先完成基本四方位，再細化邊界判斷 |
| 上傳 API 不穩定/限流 | 使用者受阻 | 實作錯誤重試、清楚提示、考慮備用 API |
| 快捷鍵衝突頻繁 | 註冊失敗率高 | 提供替代預設值、衝突偵測與建議 |
| 多螢幕/高 DPI 組合測試不足 | 邊緣案例 bug | 建立測試環境矩陣、社群回饋快速修復 |

---

## 交付檢查（每個 Phase 完成後）

- [ ] 所有測試項目通過
- [ ] 程式碼已提交並標註版本
- [ ] README/CHANGELOG 更新
- [ ] 內部試用無阻塞問題
- [ ] 錯誤訊息人性化且有行動指引

---

## 參考程式檔對照

- **主進程/IPC/快捷鍵/設定**：[src/main.js](src/main.js)
- **渲染主頁/事件/UI**：[renderer/js/main.js](renderer/js/main.js)
- **截圖頁/工具列/上傳**：[renderer/capture.html](renderer/capture.html), [renderer/js/capture.js](renderer/js/capture.js)
- **設定頁/快捷鍵 UI**：[renderer/settings.html](renderer/settings.html), [renderer/js/settingsPage.js](renderer/js/settingsPage.js)
- **檔案管理**：[renderer/js/fileManager.js](renderer/js/fileManager.js)
- **UI 元件**：[renderer/js/ui.js](renderer/js/ui.js), [renderer/js/utils.js](renderer/js/utils.js)
- **需求文檔**：[prd.md](prd.md), [plan.md](plan.md)

---

## 總結

**MVP 核心**：截圖 → 調整（工具列流暢） → 上傳（一鍵分享） → 設定（快捷鍵無衝突）

**本週聚焦**：Phase 1（工具列定位、上傳彈窗、快捷鍵 UI）  
**下週目標**：Phase 2（全螢幕瀏覽、托盤）  
**後續優化**：Phase 3（進階功能）

以「快速可用 → 體驗完整 → 功能豐富」為路徑，確保每個階段交付即可實際使用與驗證價值。