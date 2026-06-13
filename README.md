<p align="center">
  <img src="assets/icons/app-icon.png" width="120" alt="DuckShot logo" />
</p>

<h1 align="center">DuckShot 截圖鴨鴨 🦆</h1>

<p align="center">高畫質桌面截圖工具 — 區域 / 全螢幕 / 視窗截圖，一鍵儲存、複製、上傳分享。</p>

<p align="center">
  <a href="https://github.com/Jeffrey0117/DuckShot/releases/latest/download/DuckShot-Setup-1.1.1.exe"><b>⬇️ 下載 Windows 安裝檔</b></a> ·
  <a href="https://jeffrey0117.github.io/DuckShot/">官方網站</a> ·
  <a href="https://github.com/Jeffrey0117/DuckShot/releases">所有版本</a>
</p>

---

## ✨ 功能特色

- 🎯 三種截圖模式：區域、全螢幕、視窗
- 🖼️ HiDPI / DPR 感知的高畫質擷取（文字銳利不糊）
- ⌨️ 可自訂的全域快捷鍵
- 📋 一鍵複製到剪貼簿或儲存到桌面
- ☁️ 一鍵上傳到 [duk.tw](https://duk.tw) 取得分享連結
- 🗂️ 內建圖庫瀏覽 / 刪除（可移至資源回收桶）
- 📌 視窗置頂、最小化到系統托盤

## ⌨️ 預設快捷鍵

| 動作 | 快捷鍵 |
|------|--------|
| 區域截圖 | `Ctrl + R` |
| 全螢幕截圖 | `PrintScreen` |
| 視窗截圖 | `Alt + W` |

截圖介面內：`Enter` 儲存、`Ctrl/Cmd + C` 複製、`Esc` 取消、`F6` 切換影像平滑。

## 📦 技術棧

- **框架**：Electron 38
- **前端**：HTML5 / CSS3 / JavaScript、Lucide Icons
- **打包**：electron-builder（NSIS 安裝檔）

## 🗂️ 專案結構

```
├── src/                # 主進程
│   ├── main.js         # 應用程式入口、IPC、截圖邏輯
│   └── preload.js      # 安全橋接 API
├── renderer/           # 渲染進程（UI）
│   ├── index.html      # 主視窗
│   ├── capture.html    # 截圖覆蓋層
│   ├── settings.html   # 設定頁
│   ├── css/ js/        # 樣式與模組
├── assets/icons/       # 應用圖示（app-icon.ico / png、logo）
└── package.json        # 專案與打包設定
```

## 🛠️ 開發

```bash
npm install      # 安裝依賴
npm run dev      # 開發模式（DevTools）
npm start        # 一般啟動
```

## 🚀 打包（Windows）

```bash
npm run build:win        # 產出 dist/DuckShot-Setup-<version>.exe
```

> 圖示由 `assets/icons/` 提供；如需重新產生，可參考 `scripts/make-icons.js`。

## 📥 安裝

到 [Releases](https://github.com/Jeffrey0117/DuckShot/releases/latest) 下載 `DuckShot-Setup-1.1.1.exe` 執行即可。Windows 10 / 11（x64）。

## 📄 授權

MIT License
