# Save-then-Sort Toast 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 截圖存檔成功後，右下角跳出 toast，可一鍵把剛存的檔案移到 gallery tab 對應的分類資料夾。

**Architecture:** 純邏輯（搬檔 + 同名改序號）抽成 `src/lib/moveFile.js` 以 node:test 做 TDD；主進程新增單例 toast BrowserWindow（無邊框、置頂、不可聚焦）與 `move-screenshot` IPC；toast UI 為獨立的 `renderer/toast.html`。分類清單直接讀既有 `galleryTabs`（electron-store），gallery 端零修改。

**Tech Stack:** Electron 38（純 JS、無打包器）、electron-store、node:test（Node 內建，不新增依賴）。

**Spec:** `docs/superpowers/specs/2026-06-12-save-then-sort-toast-design.md`

**重要背景（給零上下文的工程師）:**
- 入口 `src/main.js`（~2000 行，class 形式，IPC handler 都是 arrow function，`this` 是 app 實例）。
- 存檔有兩條路：IPC `save-screenshot`（main.js:867，區域截圖 `2`/`Enter` 與連續截圖 `4` 都走這）和 `saveScreenshotDirect()`（main.js:1830，全螢幕/視窗截圖）。兩者成功時都拿得到 `filePath`。
- `galleryTabs` 形如 `[{ name: "靈感", path: "C:\\...\\靈感" }]`，存於 electron-store；預設儲存資料夾由 `getValidSaveDir()`（async）取得。
- 既有 IPC `get-thumbnail(filePath, width)` 回傳 dataURL 字串（失敗回 null），toast 縮圖直接用它。
- preload（`src/preload.js`）用 contextBridge 暴露 `electronAPI`；事件監聽 `electronAPI.on(channel, cb)` 有 validChannels 白名單，新 channel 要加進去。
- 本專案目前**沒有任何測試**；本計畫引入 `node --test`（零依賴）。

---

### Task 1: 搬檔核心邏輯 `src/lib/moveFile.js`（TDD）

**Files:**
- Create: `src/lib/moveFile.js`
- Create: `tests/moveFile.test.js`
- Modify: `package.json`（scripts 加 `"test": "node --test tests/"`）

- [ ] **Step 1: 加 test script**

`package.json` 的 `scripts` 改為：

```json
  "scripts": {
    "start": "electron .",
    "dev": "electron . --dev",
    "test": "node --test tests/",
    "build": "electron-builder",
    "build:win": "electron-builder --win",
    "build:mac": "electron-builder --mac",
    "build:linux": "electron-builder --linux"
  },
```

- [ ] **Step 2: 寫失敗測試**

建立 `tests/moveFile.test.js`：

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { moveFile, uniqueTargetPath } = require("../src/lib/moveFile");

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "duckshot-move-test-"));
}

test("moveFile 把檔案移到目標資料夾並回傳新路徑", async () => {
  const srcDir = await makeTmpDir();
  const destDir = await makeTmpDir();
  const srcPath = path.join(srcDir, "shot.png");
  await fs.writeFile(srcPath, "fake-image");

  const newPath = await moveFile(srcPath, destDir);

  assert.equal(newPath, path.join(destDir, "shot.png"));
  assert.equal(await fs.readFile(newPath, "utf8"), "fake-image");
  await assert.rejects(fs.access(srcPath)); // 原檔已不在
});

test("目標已有同名檔時自動加序號 (1)、(2)", async () => {
  const srcDir = await makeTmpDir();
  const destDir = await makeTmpDir();
  await fs.writeFile(path.join(destDir, "shot.png"), "old");
  await fs.writeFile(path.join(destDir, "shot (1).png"), "old1");

  const srcPath = path.join(srcDir, "shot.png");
  await fs.writeFile(srcPath, "new");

  const newPath = await moveFile(srcPath, destDir);

  assert.equal(newPath, path.join(destDir, "shot (2).png"));
  assert.equal(await fs.readFile(newPath, "utf8"), "new");
  // 既有檔案不被覆蓋
  assert.equal(await fs.readFile(path.join(destDir, "shot.png"), "utf8"), "old");
});

test("目標資料夾不存在時拋錯且原檔保留", async () => {
  const srcDir = await makeTmpDir();
  const srcPath = path.join(srcDir, "shot.png");
  await fs.writeFile(srcPath, "fake-image");
  const missingDir = path.join(srcDir, "does-not-exist");

  await assert.rejects(moveFile(srcPath, missingDir));
  await fs.access(srcPath); // 原檔還在（不拋錯即通過）
});

test("uniqueTargetPath 無衝突時回傳原名", async () => {
  const destDir = await makeTmpDir();
  const result = await uniqueTargetPath(destDir, "shot.png");
  assert.equal(result, path.join(destDir, "shot.png"));
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lib/moveFile'`

- [ ] **Step 4: 最小實作**

建立 `src/lib/moveFile.js`：

```js
// 搬移截圖到分類資料夾的核心邏輯（純 Node，不依賴 Electron，可單元測試）
const fs = require("fs").promises;
const path = require("path");

// 回傳 targetDir 下不與既有檔案衝突的完整路徑：shot.png → shot (1).png → shot (2).png
async function uniqueTargetPath(targetDir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(targetDir, filename);
  let i = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(targetDir, `${base} (${i})${ext}`);
      i += 1;
    } catch {
      return candidate;
    }
  }
}

// 移動檔案；跨磁碟（EXDEV）時 fallback 為 copy + delete。回傳實際落地的新路徑。
async function moveFile(srcPath, targetDir) {
  const targetPath = await uniqueTargetPath(targetDir, path.basename(srcPath));
  try {
    await fs.rename(srcPath, targetPath);
  } catch (error) {
    if (error.code === "EXDEV") {
      await fs.copyFile(srcPath, targetPath);
      await fs.unlink(srcPath);
    } else {
      throw error;
    }
  }
  return targetPath;
}

module.exports = { moveFile, uniqueTargetPath };
```

（EXDEV 分支無法在單機測試模擬，靠 code review；其餘行為皆有測試覆蓋。）

- [ ] **Step 5: 跑測試確認通過**

Run: `npm test`
Expected: PASS，4 tests

- [ ] **Step 6: Commit**

```bash
git add package.json src/lib/moveFile.js tests/moveFile.test.js
git commit -m "feat(sort): add moveFile lib with unique-name and EXDEV fallback"
```

---

### Task 2: IPC `move-screenshot` + preload API

**Files:**
- Modify: `src/main.js`（頂部 require 區 + `save-gallery-tabs` handler 後，約 line 1030）
- Modify: `src/preload.js`（`files` 區塊 + `on` validChannels）

- [ ] **Step 1: main.js 頂部加 require**

在 main.js 頂部其他 `require` 旁加：

```js
const { moveFile } = require("./lib/moveFile");
```

- [ ] **Step 2: 新增 IPC handler**

在 `save-gallery-tabs` handler（`ipcMain.handle("save-gallery-tabs", ...)`）之後加：

```js
    // 把剛存的截圖搬到分類資料夾（存檔後快速分類 toast 用）
    ipcMain.handle("move-screenshot", async (_event, filePath, targetDir) => {
      try {
        if (typeof filePath !== "string" || !filePath.trim()) {
          throw new Error("無效的檔案路徑");
        }
        if (typeof targetDir !== "string" || !targetDir.trim()) {
          throw new Error("無效的目標資料夾");
        }
        const newPath = await moveFile(filePath, targetDir);
        return { success: true, path: newPath };
      } catch (error) {
        console.error("Error moving screenshot:", error);
        return { success: false, error: error.message };
      }
    });
```

- [ ] **Step 3: preload 暴露 API 與事件**

`src/preload.js` 的 `files` 物件內加：

```js
    // 存檔後快速分類：把檔案搬到分類資料夾
    moveScreenshot: (filePath, targetDir) =>
      ipcRenderer.invoke("move-screenshot", filePath, targetDir),
```

`on` 的 `validChannels` 陣列加 `"toast-data"`：

```js
    const validChannels = [
      "capture-completed",
      "capture-cancelled",
      "settings-updated",
      "screen-data",
      "more-files-loaded",
      "toggle-always-on-top",
      "set-always-on-top",
      "toast-data"
    ];
```

- [ ] **Step 4: 啟動驗證無迴歸**

Run: `npm start`（啟動後手動關閉）
Expected: app 正常啟動、無主進程錯誤（require 路徑正確）

- [ ] **Step 5: Commit**

```bash
git add src/main.js src/preload.js
git commit -m "feat(sort): add move-screenshot IPC and preload API"
```

---

### Task 3: Toast 視窗（主進程）

**Files:**
- Modify: `src/main.js`（class 內加 `showSortToast` 方法；建構式屬性區加 `this.toastWindow = null`；兩條存檔路徑接上）

- [ ] **Step 1: 建構式加屬性**

在 class 建構式中 `this.captureWindow = null;` 同區加：

```js
    this.toastWindow = null;
```

- [ ] **Step 2: 加 `showSortToast` 方法**

加在 `saveScreenshotDirect` 方法之後（同層級）：

```js
  // 存檔成功後顯示右下角快速分類 toast。
  // galleryTabs 只有預設資料夾（或為空）時不顯示，行為與舊版完全相同。
  async showSortToast(savedPath) {
    try {
      const saveDir = await this.getValidSaveDir();
      const allTabs = store.get("galleryTabs");
      const tabs = (Array.isArray(allTabs) ? allTabs : []).filter(
        (t) =>
          t &&
          typeof t.path === "string" &&
          path.resolve(t.path) !== path.resolve(saveDir)
      );
      if (tabs.length === 0) return;

      const payload = {
        filePath: savedPath,
        fileName: path.basename(savedPath),
        defaultName: path.basename(saveDir),
        tabs,
      };

      // 單例重用：連續截圖時更新內容、不堆疊
      if (this.toastWindow && !this.toastWindow.isDestroyed()) {
        this.toastWindow.webContents.send("toast-data", payload);
        return;
      }

      const workArea = electron.screen.getPrimaryDisplay().workArea;
      const TOAST_W = 340;
      const TOAST_H = 130;
      const MARGIN = 16;
      this.toastWindow = new BrowserWindow({
        width: TOAST_W,
        height: TOAST_H,
        x: workArea.x + workArea.width - TOAST_W - MARGIN,
        y: workArea.y + workArea.height - TOAST_H - MARGIN,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false, // 不搶鍵盤焦點，滑鼠仍可點擊
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, "preload.js"),
        },
      });
      this.toastWindow.on("closed", () => {
        this.toastWindow = null;
      });
      await this.toastWindow.loadFile(
        path.join(__dirname, "../renderer/toast.html")
      );
      if (this.toastWindow && !this.toastWindow.isDestroyed()) {
        this.toastWindow.webContents.send("toast-data", payload);
        this.toastWindow.showInactive(); // 顯示但不奪焦點
      }
    } catch (e) {
      console.error("showSortToast failed:", e);
    }
  }
```

注意：main.js 既有 `electron` 變數（`nativeImage` 以 `electron.nativeImage` 使用，見 get-thumbnail handler），`screen` 用 `electron.screen` 即可；若檔案頂部是解構式 import，改成從解構加入 `screen`，二擇一，跟現有寫法一致。

- [ ] **Step 3: 接上兩條存檔路徑**

(a) `save-screenshot` handler（main.js:867 起）成功 return 前（`return { success: true, path: filePath };` 之前一行）加：

```js
        this.showSortToast(filePath); // fire-and-forget，不阻塞存檔回應
```

(b) `saveScreenshotDirect`（main.js:1830 起）的 `return { success: true, path: filePath };` 之前一行加：

```js
      this.showSortToast(filePath);
```

- [ ] **Step 4: 啟動驗證**

Run: `npm start`，截一張區域圖按 `2`
Expected: 此時 toast.html 還不存在，主進程 console 出現 `showSortToast failed:` 或載入錯誤但 **app 不崩潰、存檔照常成功**（錯誤被 try/catch 吃掉）。若 galleryTabs 只有預設 tab，則什麼都不發生。

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "feat(sort): show sort toast window after every saved screenshot"
```

---

### Task 4: Toast UI（renderer）

**Files:**
- Create: `renderer/toast.html`
- Create: `renderer/js/toast.js`
- Create: `renderer/css/toast.css`

- [ ] **Step 1: 建立 `renderer/toast.html`**

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; img-src 'self' data:; style-src 'self'" />
  <title>DuckShot</title>
  <link rel="stylesheet" href="css/toast.css" />
</head>
<body>
  <div id="toast" class="toast">
    <img id="thumb" class="thumb" alt="" />
    <div class="body">
      <div id="message" class="message">✓ 已儲存</div>
      <div id="tabButtons" class="tab-buttons"></div>
    </div>
  </div>
  <script src="js/toast.js"></script>
</body>
</html>
```

- [ ] **Step 2: 建立 `renderer/css/toast.css`**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

html, body { background: transparent; overflow: hidden; }

.toast {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  width: 100%;
  height: 100vh;
  padding: 12px;
  background: rgba(30, 30, 30, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  color: #eee;
  font-family: "Segoe UI", "Microsoft JhengHei", sans-serif;
  opacity: 1;
  transition: opacity 0.25s ease;
}

.toast.fade-out { opacity: 0; }

.thumb {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 6px;
  background: #222;
  flex-shrink: 0;
}

.body { flex: 1; min-width: 0; }

.message {
  font-size: 13px;
  margin-bottom: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.message.error { color: #ff8585; white-space: normal; }

.tab-buttons { display: flex; flex-wrap: wrap; gap: 6px; }

.tab-btn {
  padding: 4px 10px;
  font-size: 12px;
  color: #eee;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  cursor: pointer;
}

.tab-btn:hover { background: rgba(255, 255, 255, 0.22); }

.tab-btn.done {
  background: rgba(76, 175, 80, 0.3);
  border-color: rgba(76, 175, 80, 0.6);
}

.tab-btn:disabled { opacity: 0.6; cursor: default; }
```

- [ ] **Step 3: 建立 `renderer/js/toast.js`**

```js
// 存檔後快速分類 toast：顯示剛存的截圖，提供一鍵移到分類資料夾
(() => {
  const AUTO_CLOSE_MS = 5000;
  const CLOSE_AFTER_MOVE_MS = 600;

  let closeTimer = null;
  let currentFilePath = null;

  const toastEl = document.getElementById("toast");
  const thumbEl = document.getElementById("thumb");
  const messageEl = document.getElementById("message");
  const tabButtonsEl = document.getElementById("tabButtons");

  function startCloseTimer() {
    stopCloseTimer();
    closeTimer = setTimeout(() => {
      toastEl.classList.add("fade-out");
      setTimeout(() => window.close(), 300);
    }, AUTO_CLOSE_MS);
  }

  function stopCloseTimer() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  // 滑鼠移入暫停倒數，移出重新計時
  document.body.addEventListener("mouseenter", stopCloseTimer);
  document.body.addEventListener("mouseleave", startCloseTimer);

  async function onTabClick(tab, btn) {
    stopCloseTimer();
    const allButtons = tabButtonsEl.querySelectorAll("button");
    allButtons.forEach((b) => (b.disabled = true));

    try {
      const result = await window.electronAPI.files.moveScreenshot(
        currentFilePath,
        tab.path
      );
      if (result && result.success) {
        btn.textContent = `✓ ${tab.name}`;
        btn.classList.add("done");
        setTimeout(() => window.close(), CLOSE_AFTER_MOVE_MS);
      } else {
        messageEl.textContent = `移動失敗：${(result && result.error) || "未知錯誤"}`;
        messageEl.classList.add("error");
        allButtons.forEach((b) => (b.disabled = false));
        startCloseTimer();
      }
    } catch (error) {
      messageEl.textContent = `移動失敗：${error.message}`;
      messageEl.classList.add("error");
      allButtons.forEach((b) => (b.disabled = false));
      startCloseTimer();
    }
  }

  function render(payload) {
    currentFilePath = payload.filePath;
    toastEl.classList.remove("fade-out");
    messageEl.textContent = `✓ 已儲存到 ${payload.defaultName}`;
    messageEl.classList.remove("error");

    // 縮圖（失敗就留空底）
    window.electronAPI.files
      .getThumbnail(payload.filePath, 128)
      .then((dataUrl) => {
        if (dataUrl) thumbEl.src = dataUrl;
      })
      .catch(() => {});

    tabButtonsEl.innerHTML = "";
    payload.tabs.forEach((tab) => {
      const btn = document.createElement("button");
      btn.className = "tab-btn";
      btn.textContent = tab.name;
      btn.addEventListener("click", () => onTabClick(tab, btn));
      tabButtonsEl.appendChild(btn);
    });

    startCloseTimer();
  }

  // 主進程在視窗載入後（與連續截圖每次存檔後）送 toast-data
  window.electronAPI.on("toast-data", (_event, payload) => render(payload));
})();
```

- [ ] **Step 4: 手動驗證（完整流程）**

前置：開 app → gallery 按「+」新增至少一個資料夾 tab（例如桌面建個「靈感」資料夾加進來）。

Run: `npm start`，依序驗證：
1. 區域截圖按 `2` → 存檔、右下角出現 toast（縮圖 + ✓ 已儲存到 DuckShot + 「靈感」按鈕），且**焦點未被奪走**（在記事本打字不中斷）
2. 不點 → 5 秒自動淡出，檔案留在預設資料夾
3. 再截一張按 `2` → 點「靈感」→ 按鈕變 ✓ 後 toast 關閉，檔案出現在靈感資料夾；gallery 切到靈感 tab 看得到
4. 滑鼠 hover toast → 不會自動消失；移開 → 恢復倒數
5. 連續截圖（按 `4` 數次）→ toast 只有一個，內容更新為最新一張
6. 靈感資料夾先放一張同名檔再移 → 新檔變 `xxx (1).png`，舊檔不被覆蓋
7. 把 galleryTabs 刪到只剩預設 → 截圖按 `2` → 不出現 toast
8. 全螢幕截圖快捷鍵 → toast 也出現

- [ ] **Step 5: 跑回歸測試**

Run: `npm test`
Expected: PASS（Task 1 的 4 個測試）

- [ ] **Step 6: Commit**

```bash
git add renderer/toast.html renderer/js/toast.js renderer/css/toast.css
git commit -m "feat(sort): toast UI with one-click move to gallery tab folders"
```

---

## Self-Review 記錄

- Spec 覆蓋：互動流程（Task 3+4）、單例重用（Task 3 Step 2）、搬檔含序號/EXDEV（Task 1）、錯誤顯示（Task 4 toast.js onTabClick）、只有預設 tab 不顯示（Task 3 filter + 驗證 7）、不搶焦點（focusable:false + showInactive + 驗證 1）、三條存檔路徑（save-screenshot 涵蓋 2/Enter/4，saveScreenshotDirect 涵蓋全螢幕/視窗，驗證 5、8）✓
- 無 TBD/佔位 ✓
- 命名一致：`moveFile`/`uniqueTargetPath`/`move-screenshot`/`moveScreenshot`/`toast-data`/`showSortToast` 各任務一致 ✓
