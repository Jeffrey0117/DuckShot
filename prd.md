# Dukshot 產品需求文件（PRD）

版本：1.0  
日期：2025-10-06  
負責人：產品/工程/設計

- 專案代號：Dukshot
- 平台：Windows/macOS/Linux（Electron）
- 主要程式檔參考：
  - [src/main.js](src/main.js)
  - [src/preload.js](src/preload.js)
  - [renderer/index.html](renderer/index.html)
  - [renderer/capture.html](renderer/capture.html)
  - [renderer/settings.html](renderer/settings.html)
  - [renderer/js/main.js](renderer/js/main.js)
  - [renderer/js/capture.js](renderer/js/capture.js)
  - [renderer/js/settings.js](renderer/js/settings.js)
  - [renderer/js/settingsPage.js](renderer/js/settingsPage.js)
  - [renderer/js/fileManager.js](renderer/js/fileManager.js)
  - [renderer/js/ui.js](renderer/js/ui.js)
  - [renderer/js/utils.js](renderer/js/utils.js)

## 1. 背景與目標

Dukshot 是跨平台截圖工具，提供區域/全螢幕/視窗截圖、檔案管理、設定管理與高 DPI 支援。  
本 PRD 旨在：
- 明確已上線 vs. 未完成功能
- 定義未完成功能的產品需求、流程與驗收標準
- 對齊技術實作與時間表

## 2. 使用者價值主張

- 快速、高品質截圖（HiDPI 正確處理，避免縮放模糊）
- 便捷管理與搜尋截圖
- 熱鍵一鍵觸發
- 一鍵上傳取得分享連結（待完成）

## 3. Persona 與使用情境

- 工程師/設計師：文件、評審、回報 bug
- 內容創作者：產生素材與分享
- 客服/PM：截圖標註與傳遞

## 4. 用戶故事（高優先）

1) 作為使用者，我要一鍵區域截圖並快速儲存到預設資料夾  
2) 作為使用者，我要設定/開關全域快捷鍵，避免與其他應用衝突  
3) 作為使用者，我要工具列在調整選區時保持在可視位置（不擋視/不跑掉）  
4) 作為使用者，我要把截圖上傳到雲端並取得可分享連結  
5) 作為使用者，我要在主視窗上釘住置頂，避免被其他視窗遮住

## 5. 功能盤點（現況總結）

- 已完成（已驗證於程式碼）
  - 區域/全螢幕/視窗截圖流程（主進程與渲染溝通）：
    - IPC：get-desktop-sources/start-region-capture/start-fullscreen-capture/start-window-capture/save-screenshot（見 [src/main.js](src/main.js)）
  - HiDPI 擷取與縮放處理（DPR 感知）：getOptimalThumbnailSize（見 [src/main.js](src/main.js)）
  - 截圖檔案儲存與命名、清單載入/縮圖延遲生成（見 [src/main.js](src/main.js), [renderer/js/fileManager.js](renderer/js/fileManager.js)）
  - 主視窗置頂切換與狀態持久化（IPC toggle-always-on-top + store alwaysOnTop）（見 [src/main.js](src/main.js), [renderer/js/main.js](renderer/js/main.js)）
  - 基本 UI：主介面、搜尋、主題切換、檔案操作、通知（見 [renderer/js/main.js](renderer/js/main.js), [renderer/js/ui.js](renderer/js/ui.js)）
  - 設定保存與即時套用（save-settings/更新快捷鍵同步）（見 [src/main.js](src/main.js)）
  - 全域快捷鍵註冊管理器（ShortcutManager，支援開關、更新 key、衝突檢測基本處理）（見 [src/main.js](src/main.js)）

- 部分完成（主進程具能力，UI/流程待補）
  - 全域快捷鍵設定 UI/交互（啟用總開關、各鍵開關與編輯器、衝突提示）：
    - 主進程 IPC 已提供 update-shortcuts/save-settings 正規化與套用（見 [src/main.js](src/main.js)）
    - 渲染端設定 UI/錄鍵器/狀態提示尚未完成（見 [renderer/settings.html](renderer/settings.html), [renderer/js/settings*.js](renderer/js/settings.js)）
  - 啟動時置頂選項：儲存與套用具備，設定 UI 顯示與說明尚待完善

- 尚未完成（缺功能）
  - 截圖工具列自動重新定位（拖曳/調整選區時保持可見與不遮擋）：
    - 需在 capture.js 實作 updateToolbarPosition 與事件掛載（見 [plan.md](plan.md)）
  - 圖片上傳 API 整合（urusai.cc）與結果彈窗 UX
    - 按鈕、上傳流程、進度、成功/失敗回饋、快速複製連結
  - 系統托盤（最小化到系統托盤、還原、快捷功能）
  - 全螢幕檢視/瀏覽模式（renderer 側 F11 僅切狀態，無實作）
  - 快捷鍵預設/重設按鈕、跨平台加速鍵文案與限制提示
  - 上傳歷史、批次上傳、壓縮/浮水印選項（後續優化）

## 6. 功能需求詳述

### 6.1 全域快捷鍵管理（UI 完整化）
- 需求
  - 設定頁新增「快捷鍵設定」區塊（總開關 + 三項：區域/全螢幕/視窗）
  - 每項包含：啟用開關、目前組合顯示、編輯（錄鍵）、重設為預設值
  - 錄鍵器需做正規化（和主進程同序），限制為單鍵或 1~2 修飾鍵 + 1 主鍵
  - 衝突處理：主進程返回失敗/警告，UI 即時提示
- IPC/資料
  - 使用 save-settings 與 update-shortcuts（見 [src/main.js](src/main.js)）
- 驗收
  - 切換開關後立即生效
  - 錄鍵非法/衝突有明確錯誤提示
  - Windows 上「修飾鍵+PrintScreen」顯示警告（來自 warnings）

### 6.2 截圖工具列自動重新定位
- 需求
  - 拖曳/縮放選區過程中，工具列動態定位至選區外安全區（優先上方，其次下方，再次側邊）
  - 永遠保持完全可視（不超出視窗邊界）
  - 不遮擋選區內容（距離選區至少 8px）
- 技術
  - 在選區 onMouseMove / resize handler 呼叫 updateToolbarPosition（見 [renderer/capture.html](renderer/capture.html), [renderer/js/capture.js](renderer/js/capture.js)）
- 驗收
  - 在任意大小/邊界貼近/多螢幕縮放下，工具列始終可見且不遮擋

### 6.3 圖片上傳與結果彈窗
- 需求
  - 工具列新增「上傳」按鈕
  - 上傳流程：Canvas → Blob → FormData(file, token, r18) → fetch
  - 狀態：Loading（禁用操作、顯示進度/動畫）→ Success（縮圖與三種連結：預覽/直連/刪除），提供一鍵複製；失敗（錯誤訊息、重試、保留畫面）
  - 成功時自動複製直連到剪貼簿
- API
  - POST https://api.urusai.cc/v1/upload（token 以設定或安全儲存）
- 驗收
  - 成功 200/JSON 正確解析，顯示三連結；失敗清楚提示且可重試
  - 上傳期間 UI 可中止/關閉彈窗不影響已完成狀態

### 6.4 系統托盤與最小化到托盤
- 需求
  - 支援「最小化到托盤」設定
  - 托盤選單含：開啟主視窗、開始區域截圖、切換置頂、退出
- 驗收
  - 關閉/最小化邏輯符合設定；托盤常駐與功能正常

### 6.5 全螢幕瀏覽模式
- 需求
  - F11 切換全螢幕瀏覽：隱藏工具列與多餘 UI，保留快捷導覽
  - ESC 退出
- 驗收
  - 大量圖片時切換流暢，UI 元素狀態一致

## 7. 非功能性需求

- 效能
  - HiDPI 擷取保持 1:1 輸出；縮圖延遲與記憶體 LRU 快取（已有）（見 [src/main.js](src/main.js)）
  - 大量檔案載入需分批或延後 stat（已有背景 stat）（見 [src/main.js](src/main.js)）
- 穩定性
  - 截圖前「雙重隱身」策略避免擷取到主視窗；截圖後完整還原（見 [src/main.js](src/main.js)）
- 相容性
  - 快捷鍵在 Windows/macOS/Linux 均有清楚限制提示
- 隱私/安全
  - 上傳 token 不應明文硬編於前端；考慮存於主進程設定，透過 IPC 使用
- 可用性
  - 錯誤訊息人性化，操作可回復

## 8. 依賴與風險

- 作業系統對部分快捷鍵保留（尤其 PrintScreen）
- 多螢幕與縮放組合情境覆雜（工具列定位/尺寸對齊需多測）
- 上傳 API 可靠性與速率限制

## 9. 度量與 KPI

- 成功截圖數/失敗率
- 上傳成功率/平均耗時
- 快捷鍵註冊成功率/衝突率
- 問題回報（工具列定位問題）低於 1%

## 10. 里程碑與交付

- M1（本週）
  - 截圖工具列自動重新定位
  - 快捷鍵設定 UI（顯示/開關/錄鍵/重設/錯誤提示）
- M2（下週）
  - 上傳 API + 結果彈窗（含一鍵複製）
  - 全螢幕瀏覽模式
- M3
  - 系統托盤與最小化到托盤
  - 設定頁完整文案與引導
- M4（後續優化）
  - 批次上傳、上傳歷史、壓縮/浮水印

## 11. 驗收測試清單

- 快捷鍵
  - 總開關 ON/OFF 立即生效
  - 錄鍵非法/衝突提示正確，Windows 修飾鍵+PrintScreen 警告顯示
- 工具列定位
  - 四角/邊緣/極小選區/極大選區均保持可視且不遮擋
- 上傳
  - 成功：三連結正確、可複製、自動複製直連
  - 失敗：網路錯誤/500/格式錯誤皆有回饋與可重試
- 托盤
  - 最小化到托盤行為與選單項工作正常
- 全螢幕瀏覽
  - F11/ESC 邏輯與狀態同步正確

## 12. 目前缺漏摘要（待實作）

- 設定頁之「快捷鍵設定」完整 UI/交互（錄鍵器、提示、重設）與對接主進程（部分完成，UI 未就位）
- 截圖工具列自動重新定位（capture 流程中的定位演算法與事件整合）
- 上傳 API 整合與上傳結果彈窗（包含進度、成功/失敗 UI 與複製功能）
- 系統托盤與「最小化到托盤」
- 全螢幕瀏覽模式
- 文案與使用引導（尤其跨平台快捷鍵限制與 PrintScreen 注意）

## 13. 參考與對應程式碼

- 主進程（窗口/IPC/快捷鍵/檔案/縮圖/設定）：[src/main.js](src/main.js)
- 渲染主頁（工具列/事件/通知/搜尋/主題/置頂按鈕）：[renderer/js/main.js](renderer/js/main.js)
- 設定頁（檔/JS）：[renderer/settings.html](renderer/settings.html), [renderer/js/settings.js](renderer/js/settings.js), [renderer/js/settingsPage.js](renderer/js/settingsPage.js)
- 截圖頁與邏輯（需補工具列定位與上傳）：[renderer/capture.html](renderer/capture.html), [renderer/js/capture.js](renderer/js/capture.js)
- 檔案管理與縮圖延遲：[renderer/js/fileManager.js](renderer/js/fileManager.js)
- UI 元件與工具：[renderer/js/ui.js](renderer/js/ui.js), [renderer/js/utils.js](renderer/js/utils.js)
- 規劃草案：[@plan.md](plan.md)
