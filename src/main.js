const electron = require("electron");
const {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  desktopCapturer,
  dialog,
  shell,
  app,
  net,
  clipboard,
} = electron;
const path = require("path");
const fs = require("fs").promises;
const os = require("os");
const { moveFile } = require("./lib/moveFile");
const { listImages, imageEntryId } = require("./lib/listImages");
const { createSaveDirResolver } = require("./lib/saveDir");
const { buildSourceMap, queryDisplayDevices } = require("./lib/screenSourceMap");
const { buildProviderChain, uploadWithFallback } = require("./upload/providers");
const createFamily = require("family-kit");

app.commandLine.appendSwitch('--disable-gpu-sandbox');
// 常駐的覆蓋層視窗在背景時不能被節流（否則 show 出來第一幀會延遲）
app.commandLine.appendSwitch('--disable-background-timer-throttling');
app.commandLine.appendSwitch('--disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('--disable-renderer-backgrounding');
// 注意：不要加 --disable-software-rasterizer（老筆電 GPU 被封鎖時需要軟體後備）；
// --disable-features=VizDisplayCompositor 在現代 Chromium 早已無效，一併移除。

// 在應用程式初始化前設定快取路徑至用戶目錄
const userDataPath = path.join(os.homedir(), 'AppData', 'Local', 'Dukshot');
app.setPath('userData', userDataPath);

// 指定螢幕的物理像素尺寸（highDpiCapture 關閉時用 DIP）。
// 只抓「該螢幕的實際大小」：不再 max(…,1920)/8K 後備，1366×768 的老筆電不會被要求放大擷取。
function displayPhysicalSize(display) {
  const useHiDpi = typeof store?.get === "function" ? store.get("highDpiCapture") !== false : true;
  const scale = useHiDpi ? display.scaleFactor || 1 : 1;
  return {
    width: Math.max(1, Math.round(display.size.width * scale)),
    height: Math.max(1, Math.round(display.size.height * scale)),
  };
}

function displayUnderCursor() {
  const pt = electron.screen.getCursorScreenPoint();
  return { cursorPt: pt, display: electron.screen.getDisplayNearestPoint(pt) };
}

// 把 renderer 送來的影像（data URL / base64 字串，或 ArrayBuffer / Uint8Array 位元組）轉成 Buffer
function toImageBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === "string" && input.length > 0) {
    const base64 = input.includes(",") ? input.slice(input.indexOf(",") + 1) : input;
    if (!base64) throw new Error("No base64 data found");
    return Buffer.from(base64, "base64");
  }
  throw new Error("Invalid image data format");
}

const ALLOWED_FORMATS = new Set(["png", "jpg", "jpeg", "webp"]);

// 工具函式：用於控制等待時機
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 主視窗隱身後等合成器把它真的從桌面拿掉的時間。
// 舊版「依 os.loadavg() 動態調整」在 Windows 永遠拿到 0，是死邏輯，改為常數。
const COMPOSITOR_WAIT_MS = 56;
// 覆蓋層「隱身等擷取」時的不透明度。不能是 0：Windows 上 alpha 0 的 layered window 不吃滑鼠 hit-test，
// capture.html 的 cursor:none 就不生效，硬體游標會被視訊流截進畫面（v1.2.0 的 regression）。
// 0.01 肉眼看不見，但視窗仍接得到滑鼠，游標才藏得掉。
const CAPTURE_HIDDEN_OPACITY = 0.01;

// 隱藏視窗時的螢幕外座標
const HIDE_OFFSCREEN_POS = { x: -10000, y: -10000 };

// 快速分類 toast 視窗尺寸
const TOAST_WIDTH = 340;
const TOAST_MARGIN = 16;

// 設定檔案路徑
const settingsPath = path.join(
  os.homedir(),
  "AppData",
  "Local",
  "Dukshot",
  "settings.json"
);

// 設定存儲類別
class SettingsStore {
  constructor() {
    // 同步載入設定，確保 app 啟動時（註冊全域快捷鍵前）設定已就緒，
    // 避免快捷鍵以預設值註冊、要重新儲存設定才生效的問題。
    this.settings = {};
    this.loadSync();
  }

  loadSync() {
    try {
      const data = require("fs").readFileSync(settingsPath, "utf8");
      this.settings = JSON.parse(data);
      this.migrate();
    } catch (error) {
      this.settings = this.defaultSettings();
      this.save();
    }
  }

  // 設定遷移：把舊版的桌面預設儲存路徑改為新的「圖片/DuckShot」
  migrate() {
    try {
      const sd = this.settings.saveDirectory;
      const isOldDesktopDefault =
        typeof sd === "string" && /[\\/](Desktop|桌面)\/?$/i.test(sd.trim());
      // 只有在使用者沒有自訂儲存路徑時才遷移，避免覆蓋使用者的選擇
      const userCustomized = this.settings.customSavePath === true;
      if (isOldDesktopDefault && !userCustomized) {
        this.settings.saveDirectory = path.join(os.homedir(), "Pictures", "DuckShot");
        this.save();
        console.log("[settings] migrated saveDirectory: Desktop -> Pictures/DuckShot");
      }
    } catch (e) {
      console.warn("[settings] migrate failed:", e.message);
    }
  }

  defaultSettings() {
    return {
        theme: "light",
        // 預設儲存到「圖片」資料夾下的 DuckShot 子目錄（可在設定中覆蓋）
        saveDirectory: path.join(os.homedir(), "Pictures", "DuckShot"),
        // 僅在開發模式且此設定為 true 時才會自動開啟 DevTools
        openDevTools: false,
        // 影像/畫質相關設定
        highDpiCapture: true,     // 啟用高 DPI 擷取（DPR 感知）
        smoothing: false,         // 預設關閉影像平滑，避免文字模糊
        captureQuality: "highest" // 擷取品質：highest, high, medium
      };
  }

  async save() {
    try {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error("Error saving settings:", error);
    }
  }

  get(key) {
    return this.settings[key];
  }

  set(key, value) {
    this.settings[key] = value;
    this.save();
  }

  get store() {
    return this.settings;
  }

  set store(newSettings) {
    this.settings = newSettings;
    this.save();
  }
}

const store = new SettingsStore();

// 快捷鍵管理器
class ShortcutManager {
  constructor() {
    this.shortcuts = new Map();
    this.enabled = true;
    this.defaultKeys = {
      region: "Alt+A",
      fullscreen: "PrintScreen",
      window: "Alt+W"
    };
  }

  register(shortcut, callback) {
    // 獲取所有快捷鍵設定
    const shortcuts = store.get("shortcuts") || {};
    const shortcutConfig = shortcuts[shortcut];
    const isEnabled = shortcutConfig ? shortcutConfig.enabled !== false : true;

    if (!isEnabled || !this.enabled) {
      console.log(`快捷鍵 ${shortcut} 已停用`);
      return false;
    }

    // 獲取快捷鍵組合
    const key = shortcutConfig?.key || this.defaultKeys[shortcut];
    if (!key) {
      console.log(`快捷鍵 ${shortcut} 無有效按鍵組合`);
      return false;
    }

    try {
      // 先取消註冊（避免重複）
      if (globalShortcut.isRegistered(key)) {
        globalShortcut.unregister(key);
      }

      // 註冊新的快捷鍵
      console.log(`嘗試註冊快捷鍵: ${shortcut} -> ${key}`);
      const success = globalShortcut.register(key, callback);
      if (success) {
        this.shortcuts.set(shortcut, { key, callback });
        console.log(`成功註冊快捷鍵: ${shortcut} -> ${key}`);
      } else {
        console.error(`註冊快捷鍵失敗: ${shortcut} -> ${key}`);
      }
      return success;
    } catch (error) {
      console.error(`Failed to register shortcut ${shortcut}:`, error);
      return false;
    }
  }

  unregister(shortcut) {
    const data = this.shortcuts.get(shortcut);
    if (data) {
      try {
        globalShortcut.unregister(data.key);
        this.shortcuts.delete(shortcut);
        return true;
      } catch (error) {
        console.error(`Failed to unregister shortcut ${shortcut}:`, error);
        return false;
      }
    }
    return false;
  }

  toggleShortcut(shortcut, enabled) {
    if (enabled) {
      const data = this.shortcuts.get(shortcut);
      if (data) {
        this.register(shortcut, data.callback);
      }
    } else {
      this.unregister(shortcut);
    }
    const shortcuts = store.get("shortcuts") || {};
    shortcuts[shortcut] = shortcuts[shortcut] || {};
    shortcuts[shortcut].enabled = enabled;
    store.set("shortcuts", shortcuts);
  }

  updateShortcutKey(shortcut, newKey) {
    // 檢查衝突
    if (globalShortcut.isRegistered(newKey)) {
      return { error: "快捷鍵已被使用" };
    }

    const data = this.shortcuts.get(shortcut);
    if (!data) {
      return { error: "快捷鍵不存在" };
    }

    // 保存原始 callback
    const originalCallback = data.callback;

    // 更新快捷鍵
    this.unregister(shortcut);
    const shortcuts = store.get("shortcuts") || {};
    shortcuts[shortcut] = shortcuts[shortcut] || {};
    shortcuts[shortcut].key = newKey;
    store.set("shortcuts", shortcuts);

    // 使用原始 callback 重新註冊
    const success = this.register(shortcut, originalCallback);

    return success ? { success: true } : { error: "註冊失敗" };
  }

  unregisterAll() {
    this.shortcuts.forEach((data, shortcut) => {
      this.unregister(shortcut);
    });
  }

  toggleGlobal(enabled) {
    this.enabled = enabled;
    if (enabled) {
      // 重新註冊所有快捷鍵
      this.shortcuts.forEach((data, shortcut) => {
        this.register(shortcut, data.callback);
      });
    } else {
      // 取消所有快捷鍵
      this.unregisterAll();
    }
    store.set("shortcuts.globalEnabled", enabled);
  }
}

class DukshotApp {
  constructor() {
    this.mainWindow = null;
    this.captureWindow = null;
    this.settingsWindow = null;
    this.toastWindow = null;
    this.toastWindowLoaded = false;
    this.toastLatestPayload = null;
    this.ocrResultWindow = null;
    this.ocrWindowReady = false;
    this.ocrPendingMessages = [];
    this.ocrRequestId = 0;
    // OCR 流程中跳過主視窗還原，等 OCR 結果視窗關閉才還原
    this.skipNextMainRestore = false;
    this.pendingMainRestoreAfterOcr = false;
    // 螢幕來源 ID 快取（display_id → sourceId）：getSources 即使不抓縮圖也要 200-500ms，
    // 啟動時與螢幕配置變更時預先快取，按快捷鍵時零等待。多螢幕依游標所在螢幕挑來源。
    this.cachedScreenSources = null;
    this.cachedFirstSourceId = null;
    this.isDebug = process.argv.includes("--dev");
    this.originalMainWindowBounds = null; // 記錄主視窗原始位置，供還原使用
    this.originalMainWindowState = null; // 記錄主視窗原始狀態
    this.shortcutManager = new ShortcutManager();
    this.tray = null;
    this.isQuitting = false;
    // 常駐覆蓋層：captureActive 表示覆蓋層目前正在截圖中（視窗本身平常是隱藏常駐）
    this.captureActive = false;
    this.captureWindowReady = null;
    // 圖庫資料夾監看
    this.folderWatcher = null;
    this.folderWatchDebounce = null;
    this.displayRefreshTimer = null;
    // 儲存資料夾解析（Windows 圖片路徑只問系統一次）
    this.saveDirResolver = createSaveDirResolver({ homedir: os.homedir() });
  }

  // 使用者又啟動了一次：把已在跑的主視窗叫到前面（截圖進行中就不打擾）
  focusMainWindow() {
    if (this.captureActive) return;
    const mw = this.mainWindow;
    if (mw && !mw.isDestroyed()) {
      if (mw.isMinimized()) mw.restore();
      mw.show();
      mw.focus();
    } else if (electron.app.isReady()) {
      this.createMainWindow();
    }
  }

  async initialize() {
    // 等待 Electron 準備完成
    await electron.app.whenReady();

    // 預先快取螢幕來源 ID（截圖快捷鍵按下時零等待），螢幕配置變更時刷新。
    // display-metrics-changed 會連發（工作列自動隱藏、DPI 切換），debounce 後只查一次。
    this.refreshScreenSourceId();
    const scheduleSourceRefresh = () => {
      clearTimeout(this.displayRefreshTimer);
      this.displayRefreshTimer = setTimeout(() => this.refreshScreenSourceId(), 500);
    };
    electron.screen.on("display-added", scheduleSourceRefresh);
    electron.screen.on("display-removed", scheduleSourceRefresh);
    electron.screen.on("display-metrics-changed", scheduleSourceRefresh);

    // 開發驗證用：`electron . --test-toast` 啟動後 4 秒以最近一張截圖觸發分類 toast，
    // 方便調整 toast 外觀（正常啟動不帶此參數，零影響）
    if (process.argv.includes("--test-toast")) {
      setTimeout(async () => {
        try {
          const dir = await this.getValidSaveDir();
          const files = await fs.readdir(dir);
          const png = files.find((f) => f.toLowerCase().endsWith(".png"));
          if (png) this.showSortToast(path.join(dir, png));
        } catch (e) {
          console.error("test-toast failed:", e);
        }
      }, 4000);
    }

    // 開發驗證用：`electron . --test-ocr <圖片路徑>` 以指定圖片開啟 OCR 結果視窗
    const testOcrIdx = process.argv.indexOf("--test-ocr");
    if (testOcrIdx !== -1 && process.argv[testOcrIdx + 1]) {
      const testImagePath = process.argv[testOcrIdx + 1];
      setTimeout(async () => {
        try {
          const buf = await fs.readFile(testImagePath);
          const dataUrl = "data:image/png;base64," + buf.toString("base64");
          this.openOcrResultWindow(dataUrl, null);
        } catch (e) {
          console.error("test-ocr failed:", e);
        }
      }, 3000);
    }

    // 移除預設應用選單，避免 Electron 內建快捷鍵（Ctrl+R 重新整理、F5、Ctrl+W 關閉、
    // Ctrl+Shift+I 開發者工具等）在正式版誤觸。所有截圖快捷鍵改由設定頁自訂。
    electron.Menu.setApplicationMenu(null);

    // 創建主視窗
    this.createMainWindow();

    // 註冊全域快捷鍵
    this.registerGlobalShortcuts();

    // 設定應用事件
    this.setupAppEvents();

    // 建立系統托盤
    this.createTray();

    // 設定 IPC 處理器
    this.setupIpcHandlers();

    // 主視窗先上，再預建常駐的截圖覆蓋層（老機器啟動時不要兩個視窗搶 CPU）
    setTimeout(() => this.prewarmCaptureWindow(), 1500);
  }

  createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 900,
      height: 650,
      minWidth: 800,
      minHeight: 600,
      frame: false, // 隱藏原生標題列
      titleBarStyle: "hidden", // Windows 平台隱藏標題列
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
        // 允許載入本機 file:/// 圖片（避免跨來源限制導致縮圖不顯示）
        webSecurity: false,
      },
      icon: path.join(__dirname, "../assets/icons/logo-imgup.png"),
      show: false, // 先不顯示，等載入完成後再顯示
    });

    // 載入主界面
    this.mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

    // 視窗準備好後顯示
    this.mainWindow.once("ready-to-show", () => {
      this.mainWindow.show();

      // 套用已儲存的置頂狀態（顯式同步 true/false，並確保層級/工作區狀態正確）
      const alwaysOnTop = store.get("alwaysOnTop") === true;
      // 先清為 normal 層級的 false，再依設定套用，避免殘留 OS 層級
      this.mainWindow.setAlwaysOnTop(false, 'normal');
      try { this.mainWindow.setVisibleOnAllWorkspaces(false); } catch {}
      if (alwaysOnTop) {
        this.mainWindow.setAlwaysOnTop(true, 'normal');
      }

      // 開發模式且設定允許時才開啟開發者工具
      if (this.isDebug && store.get("openDevTools") === true) {
        this.mainWindow.webContents.openDevTools();
      }
    });

    // 最小化到托盤
    this.mainWindow.on("minimize", (e) => {
      try {
        if (this.shouldMinimizeToTray()) {
          e.preventDefault();
          this.mainWindow.hide();
        }
      } catch {}
    });

    // 關閉時最小化到托盤（非退出）
    this.mainWindow.on("close", (e) => {
      if (this.isQuitting) return;
      try {
        if (this.shouldMinimizeToTray()) {
          e.preventDefault();
          this.mainWindow.hide();
        }
      } catch {}
    });

    // 視窗關閉事件：常駐的覆蓋層若還在，window-all-closed 永遠不會觸發 → 一併銷毀
    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
      this.closeFolderWatcher();
      if (this.captureWindow && !this.captureWindow.isDestroyed()) {
        try { this.captureWindow.destroy(); } catch {}
      }
    });
  }

  registerGlobalShortcuts() {
    // 檢查是否啟用全域快捷鍵
    const shortcuts = store.get("shortcuts") || {};
    const globalEnabled = shortcuts.enabled !== false;

    console.log("註冊全域快捷鍵，設定值:", shortcuts);

    if (!globalEnabled) {
      console.log("全域快捷鍵已停用");
      return;
    }

    // 區域截圖快捷鍵
    this.shortcutManager.register("region", () => {
      console.log("快捷鍵觸發: 區域截圖");
      this.startRegionCapture();
    });

    // 全螢幕截圖快捷鍵
    this.shortcutManager.register("fullscreen", () => {
      console.log("快捷鍵觸發: 全螢幕截圖");
      this.startFullScreenCapture();
    });

    // 當前視窗截圖快捷鍵
    this.shortcutManager.register("window", () => {
      console.log("快捷鍵觸發: 視窗截圖");
      this.startActiveWindowCapture();
    });
  }

  setupAppEvents() {
    // 當所有視窗關閉時
    electron.app.on("window-all-closed", () => {
      if (process.platform !== "darwin") {
        electron.app.quit();
      }
    });

    // macOS 重新激活應用
    electron.app.on("activate", () => {
      if (this.mainWindow === null) {
        this.createMainWindow();
      }
    });

    // 應用退出前清理
    electron.app.on("before-quit", () => {
      this.isQuitting = true;
      // 清理全域快捷鍵
      if (this.shortcutManager) {
        this.shortcutManager.unregisterAll();
      }
      globalShortcut.unregisterAll();
      this.closeFolderWatcher();
      try {
        if (this.tray) {
          this.tray.destroy();
          this.tray = null;
        }
      } catch {}
    });

    // 視窗獲得焦點時，若偵測到未註冊任何快捷鍵且已啟用，嘗試自我修復重註冊
    electron.app.on("browser-window-focus", () => {
      try {
        // 強制同步主視窗置頂狀態，避免意外維持置頂
        try {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            const aot = store.get("alwaysOnTop") === true;
            this.mainWindow.setAlwaysOnTop(aot, 'normal');
            try { this.mainWindow.setVisibleOnAllWorkspaces(false); } catch {}
            console.debug("[focus] 同步主視窗置頂狀態:", aot);
          }
        } catch (e) {
          console.warn("[focus] 同步置頂狀態失敗：", e.message);
        }

        const shortcuts = store.get("shortcuts") || {};
        const globalEnabled = shortcuts.enabled !== false;
        if (!globalEnabled) return;

        if (this.shortcutManager && this.shortcutManager.shortcuts.size === 0) {
          console.log("[focus] 偵測到已啟用但未註冊任何快捷鍵，嘗試重註冊…");
          const callbacks = {
            region: () => {
              console.log("快捷鍵觸發: 區域截圖");
              this.startRegionCapture();
            },
            fullscreen: () => {
              console.log("快捷鍵觸發: 全螢幕截圖");
              this.startFullScreenCapture();
            },
            window: () => {
              console.log("快捷鍵觸發: 視窗截圖");
              this.startActiveWindowCapture();
            },
          };
          ["region","fullscreen","window"].forEach(type => {
            const cfg = shortcuts[type];
            if (!cfg || cfg.enabled === false) return;
            const key = cfg.key || this.shortcutManager.defaultKeys[type];
            if (!globalShortcut.isRegistered(key)) {
              this.shortcutManager.register(type, callbacks[type]);
            }
          });
          console.log("[focus] 重註冊完成，目前數量：", this.shortcutManager.shortcuts.size);
        }
      } catch (e) {
        console.warn("[focus] 自我修復註冊失敗：", e.message);
      }
    });
  }

  // 是否最小化到托盤（相容不同設定鍵位）
  shouldMinimizeToTray() {
    try {
      const w = store.get("window");
      if (w && typeof w.minimizeToTray === "boolean") return w.minimizeToTray;
    } catch {}
    const legacy = store.get("minimizeToTray");
    return legacy === true;
  }

  // 建立系統托盤
  createTray() {
    try {
      if (this.tray) return;
      const iconPath = path.join(__dirname, "../assets/icons/logo-imgup.png");
      this.tray = new electron.Tray(iconPath);
      this.updateTrayTooltip();

      const buildMenu = () => {
        const aot = !!store.get("alwaysOnTop");
        const template = [
          {
            label: "顯示主視窗",
            click: () => {
              if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.show();
                this.mainWindow.focus();
              } else {
                this.createMainWindow();
              }
            },
          },
          {
            label: "開始區域截圖",
            click: () => this.startRegionCapture(),
          },
          {
            type: "separator",
          },
          {
            label: aot ? "取消置頂" : "設為置頂",
            click: () => {
              const next = !aot;
              try {
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                  this.mainWindow.setAlwaysOnTop(next);
                }
                store.set("alwaysOnTop", next);
                this.tray.setContextMenu(electron.Menu.buildFromTemplate(buildMenu()));
              } catch (e) {}
            },
          },
          {
            label: this.shouldMinimizeToTray()
              ? "已啟用最小化到托盤"
              : "最小化到托盤（可於設定切換）",
            enabled: false,
          },
          {
            type: "separator",
          },
          {
            label: "退出",
            click: () => {
              this.isQuitting = true;
              electron.app.quit();
            },
          },
        ];
        return template;
      };

      this.tray.setContextMenu(electron.Menu.buildFromTemplate(buildMenu()));

      this.tray.on("click", () => {
        // 左鍵單擊還原/顯示
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.show();
          this.mainWindow.focus();
        } else {
          this.createMainWindow();
        }
      });
    } catch (e) {
      console.warn("[tray] 建立托盤失敗：", e.message);
    }
  }

  updateTrayTooltip() {
    try {
      if (!this.tray) return;
      const aot = !!store.get("alwaysOnTop");
      const tip = `Dukshot 截圖工具${aot ? "（置頂）" : ""}`;
      this.tray.setToolTip(tip);
    } catch {}
  }

  setupIpcHandlers() {
    // 視窗控制 IPC 處理
    ipcMain.on("minimize-window", () => {
      if (this.mainWindow) this.mainWindow.minimize();
    });

    ipcMain.on("maximize-window", () => {
      if (this.mainWindow) {
        if (this.mainWindow.isMaximized()) {
          this.mainWindow.unmaximize();
        } else {
          this.mainWindow.maximize();
        }
      }
    });

    ipcMain.on("close-window", () => {
      if (this.mainWindow) this.mainWindow.close();
    });

    // 視窗置頂功能
    ipcMain.on("toggle-always-on-top", (event, isOnTop) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        // 使用 normal 層級明確覆寫，並確保不在所有工作區顯示
        this.mainWindow.setAlwaysOnTop(!!isOnTop, 'normal');
        try { this.mainWindow.setVisibleOnAllWorkspaces(false); } catch {}
        // 儲存狀態到設定
        store.set("alwaysOnTop", !!isOnTop);
      }
    });

    // 讀取目前置頂狀態（診斷用）
    ipcMain.handle("get-always-on-top-state", () => {
      try {
        const winOnTop = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow.isAlwaysOnTop() : null;
        const setting = store.get("alwaysOnTop") === true;
        return { success: true, winOnTop, setting };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // 強制清除置頂（診斷/修復）
    ipcMain.handle("force-clear-always-on-top", () => {
      try {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.setAlwaysOnTop(false, 'normal');
          try { this.mainWindow.setVisibleOnAllWorkspaces(false); } catch {}
        }
        store.set("alwaysOnTop", false);
        const winOnTop = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow.isAlwaysOnTop() : null;
        return { success: true, winOnTop, setting: false };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // 直接設定置頂（提供設定頁使用的別名事件）
    ipcMain.on("set-always-on-top", (event, isOnTop) => {
      try {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.setAlwaysOnTop(!!isOnTop);
          store.set("alwaysOnTop", !!isOnTop);
          console.log("[set-always-on-top] aot=", !!isOnTop);
        }
      } catch (e) {
        console.warn("[set-always-on-top] failed:", e.message);
      }
    });

    // 回傳目前已註冊的快捷鍵（供設定頁顯示診斷資訊）
    ipcMain.handle("get-registered-shortcuts", () => {
      try {
        const shortcuts = store.get("shortcuts") || {};
        const globalEnabled = shortcuts.enabled !== false;
        const registered = {};
        if (this.shortcutManager && this.shortcutManager.shortcuts) {
          this.shortcutManager.shortcuts.forEach((val, type) => {
            registered[type] = val?.key || null;
          });
        }
        const count = this.shortcutManager ? this.shortcutManager.shortcuts.size : 0;
        return { success: true, globalEnabled, count, registered };
      } catch (e) {
        return { success: false, error: e.message, globalEnabled: false, count: 0, registered: {} };
      }
    });

    // 視窗狀態變化通知
    this.mainWindow.on("maximize", () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("window-maximized");
      }
    });

    this.mainWindow.on("unmaximize", () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("window-unmaximized");
      }
    });

    // 獲取螢幕截圖源
    ipcMain.handle("get-desktop-sources", async () => {
      try {
        console.log("Requesting desktop sources...");

        const thumbnailSize = displayPhysicalSize(displayUnderCursor().display);

        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: thumbnailSize,
          fetchWindowIcons: false,
        });

        console.log(`Found ${sources.length} sources`);

        if (sources.length === 0) {
          console.warn("No desktop sources found");
          return [];
        }

        // 轉換 NativeImage 為 data URL
        const processedSources = sources.map((source, index) => {
          try {
            console.log(`Processing source ${index}: ${source.name}`);
            return {
              id: source.id,
              name: source.name,
              thumbnail: source.thumbnail.toDataURL(),
            };
          } catch (error) {
            console.error(`Error processing source ${index}:`, error);
            // 提供備用的空白圖像
            return {
              id: source.id,
              name: source.name,
              thumbnail:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
            };
          }
        });

        console.log("Successfully processed sources");
        return processedSources;
      } catch (error) {
        console.error("Error getting desktop sources:", error);
        return [];
      }
    });

    // 開始區域截圖
    ipcMain.handle("start-region-capture", () => {
      return this.startRegionCapture();
    });

    // 覆蓋層視訊流擷取失敗時的後備：用舊方法抓整張縮圖送回（慢但穩）
    ipcMain.handle("region-capture-fallback", async (event) => {
      try {
        if (!this.captureWindow || event.sender !== this.captureWindow.webContents || !this.captureActive) {
          return { success: false, error: "no capture window" };
        }
        // 記下是哪一輪截圖要的：抓圖期間使用者可能已經 Esc 又開了新一輪，
        // 舊的這張不能送過去蓋掉新一輪的畫面
        const round = this.captureDrawnSeq;
        const dataUrl = await this.grabScreenDataUrlForCaptureWindow();
        if (!this.captureActive || this.captureDrawnSeq !== round) {
          return { success: false, error: "capture ended" };
        }
        if (this.captureWindow && !this.captureWindow.isDestroyed()) {
          this.captureWindow.webContents.send("screen-data", dataUrl);
        }
        return { success: true };
      } catch (error) {
        console.error("region-capture-fallback failed:", error);
        return { success: false, error: error.message };
      }
    });

    // 開始全螢幕截圖
    ipcMain.handle("start-fullscreen-capture", () => {
      return this.startFullScreenCapture();
    });

    // 開始視窗截圖
    ipcMain.handle("start-window-capture", () => {
      return this.startActiveWindowCapture();
    });

    // 繼續截圖：沿用同一個覆蓋層視窗，重新擷取桌面送回去（用於連續截圖）
    ipcMain.handle("continue-region-capture", async (event) => {
      try {
        const cw = this.captureWindow;
        if (!cw || cw.isDestroyed() || !this.captureActive || event.sender !== cw.webContents) {
          return { success: false, error: "截圖視窗不存在" };
        }
        // 只把覆蓋層轉成完全透明（不 hide：hide/show 會讓 Chromium 重排可見性，
        // 視訊流首幀偶爾會拖到 2~3 秒），透明視窗不會被擷取進下一張畫面；
        // 然後重新走視訊流路徑（跟第一次一樣快，不在主進程編整張 PNG 再塞 IPC）
        try { cw.setOpacity(CAPTURE_HIDDEN_OPACITY); } catch {}
        await sleep(COMPOSITOR_WAIT_MS);
        if (!this.captureActive || cw.isDestroyed()) return { success: false, error: "截圖已結束" };
        const display = electron.screen.getDisplayMatching(cw.getBounds());
        await this.presentCapture(display, electron.screen.getCursorScreenPoint());
        return { success: true };
      } catch (e) {
        console.error("continue-region-capture failed:", e);
        this.hideCaptureWindow();
        return { success: false, error: e.message };
      }
    });

    // 覆蓋層回報凍結幀已畫好 → 把不透明度調回 1（在這之前它是透明的，不會被截進畫面）
    ipcMain.on("capture-drawn", (event) => {
      if (!this.captureWindow || event.sender !== this.captureWindow.webContents) return;
      this.revealCaptureWindow();
    });

    // 覆蓋層自己要求關閉（Esc/右鍵/存檔完成）：視窗常駐只隱藏
    ipcMain.on("capture-dismiss", (event) => {
      if (!this.captureWindow || event.sender !== this.captureWindow.webContents) return;
      this.hideCaptureWindow();
    });

    // 儲存截圖（支援可選 label 以利 A/B 命名）
    const MAX_SAVE_BYTES = 64 * 1024 * 1024;
    ipcMain.handle("save-screenshot", async (event, imageData, format, label) => {
      try {
        if (!this.isTrustedSender(event.sender)) throw new Error("拒絕的來源");
        const fmt = String(format || "png").toLowerCase();
        if (!ALLOWED_FORMATS.has(fmt)) throw new Error("不支援的圖片格式");
        const buffer = toImageBuffer(imageData);
        if (buffer.length === 0 || buffer.length > MAX_SAVE_BYTES) throw new Error("圖片資料大小不合法");
        const entry = await this.writeScreenshotFile(buffer, fmt, label);
        return { success: true, path: entry.path, entry };
      } catch (error) {
        console.error("Error saving screenshot:", error);
        return { success: false, error: error.message };
      }
    });

    // 開啟檔案夾（若未提供路徑，開啟預設截圖資料夾）
    ipcMain.handle("open-folder", async (event, folderPath) => {
      try {
        const targetPath = folderPath || await this.getValidSaveDir();
        const result = await shell.openPath(targetPath);
        if (result) {
          // shell.openPath 返回錯誤字串時表示失敗
          console.error("Error opening folder:", result);
          return { success: false, error: result };
        }
        return { success: true, path: targetPath };
      } catch (error) {
        console.error("Error opening folder:", error);
        return { success: false, error: error.message };
      }
    });

    // 獲取設定
    ipcMain.handle("get-settings", () => {
      return store.store;
    });

    // 取得目前有效的截圖儲存資料夾（供設定頁顯示）
    ipcMain.handle("get-save-directory", async () => {
      try {
        return { success: true, path: await this.getValidSaveDir() };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // 讓使用者選擇截圖儲存資料夾
    ipcMain.handle("choose-save-directory", async () => {
      try {
        const win = this.settingsWindow && !this.settingsWindow.isDestroyed()
          ? this.settingsWindow
          : this.mainWindow;
        const result = await dialog.showOpenDialog(win, {
          title: "選擇截圖儲存位置",
          properties: ["openDirectory", "createDirectory"],
          defaultPath: await this.getValidSaveDir(),
        });
        if (result.canceled || !result.filePaths || !result.filePaths.length) {
          return { success: false, canceled: true };
        }
        const dir = result.filePaths[0];
        store.set("saveDirectory", dir);
        store.set("customSavePath", true); // 標記為使用者自訂，避免被遷移邏輯改回預設
        return { success: true, path: dir };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // 選一個資料夾來瀏覽（圖庫分頁用，不會改變儲存位置）
    ipcMain.handle("pick-directory", async () => {
      try {
        const win = this.mainWindow;
        const result = await dialog.showOpenDialog(win, {
          title: "選擇要瀏覽的資料夾",
          properties: ["openDirectory"],
        });
        if (result.canceled || !result.filePaths || !result.filePaths.length) {
          return { success: false, canceled: true };
        }
        return { success: true, path: result.filePaths[0] };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // 圖庫分頁（可瀏覽的資料夾清單）持久化
    ipcMain.handle("get-gallery-tabs", async () => {
      try {
        const saveDir = await this.getValidSaveDir();
        let tabs = store.get("galleryTabs");
        if (!Array.isArray(tabs) || tabs.length === 0) {
          tabs = [{ name: "DuckShot", path: saveDir }];
        }
        return { success: true, tabs, defaultPath: saveDir };
      } catch (e) {
        return { success: false, error: e.message, tabs: [] };
      }
    });

    ipcMain.handle("save-gallery-tabs", (_event, tabs) => {
      try {
        store.set("galleryTabs", Array.isArray(tabs) ? tabs : []);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // 把剛存的截圖搬到分類資料夾（存檔後快速分類 toast 用）
    ipcMain.handle("move-screenshot", async (_event, filePath, targetDir) => {
      try {
        if (typeof filePath !== "string" || !filePath.trim()) {
          throw new Error("無效的檔案路徑");
        }
        if (typeof targetDir !== "string" || !targetDir.trim()) {
          throw new Error("無效的目標資料夾");
        }
        // 來源限定在預設儲存資料夾內、目標限定在 galleryTabs 白名單內，
        // 避免 renderer 透過此 IPC 搬移任意檔案
        const saveDir = path.resolve(await this.getValidSaveDir());
        if (path.dirname(path.resolve(filePath)) !== saveDir) {
          throw new Error("僅能搬移預設資料夾內的截圖");
        }
        const tabs = store.get("galleryTabs");
        const allowed =
          Array.isArray(tabs) &&
          tabs.some(
            (t) =>
              t &&
              typeof t.path === "string" &&
              path.resolve(t.path) === path.resolve(targetDir)
          );
        if (!allowed) {
          throw new Error("目標資料夾不在圖庫分頁清單中");
        }
        const newPath = await moveFile(filePath, targetDir);
        return { success: true, path: newPath };
      } catch (error) {
        console.error("Error moving screenshot:", error);
        return { success: false, error: error.message };
      }
    });

    // OCR 影像資料上限（base64 字串長度，~48MB 原始圖），防 renderer 餵超大資料
    const MAX_OCR_IMAGE_CHARS = 64 * 1024 * 1024;
    const isValidOcrImage = (d) =>
      typeof d === "string" && d.length > 0 && d.length <= MAX_OCR_IMAGE_CHARS;

    // OCR：截圖 overlay 按 5 → 開結果視窗並辨識
    ipcMain.handle("ocr-recognize", async (_event, imageData, screenBounds) => {
      if (!isValidOcrImage(imageData)) {
        return { success: false, error: "無效的圖片資料" };
      }
      // 從截圖 overlay 觸發：overlay 關閉時主視窗先不要跳出來
      if (this.captureActive) {
        this.skipNextMainRestore = true;
      }
      // 在 IPC 信任邊界驗證 screenBounds 形狀（4 個有限數字），不合法就跳過 UIA
      const b = screenBounds;
      const validBounds =
        b && typeof b === "object" &&
        [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))
          ? { x: b.x, y: b.y, width: b.width, height: b.height }
          : null;
      this.openOcrResultWindow(imageData, validBounds).catch((e) =>
        console.error("openOcrResultWindow failed:", e)
      );
      return { success: true };
    });

    // OCR：結果視窗內重新框選後對子圖重新辨識（子圖沒有螢幕座標，跳過 UIA）
    ipcMain.handle("ocr-recognize-region", async (_event, imageData) => {
      if (!isValidOcrImage(imageData)) {
        return { success: false, error: "無效的圖片資料" };
      }
      this.openOcrResultWindow(imageData, null).catch((e) =>
        console.error("openOcrResultWindow failed:", e)
      );
      return { success: true };
    });

    // toast 依內容回報實際高度，視窗貼齊右下角縮放（砍掉多餘空白）
    ipcMain.on("toast-resize", (event, height) => {
      if (!this.toastWindow || this.toastWindow.isDestroyed()) return;
      if (event.sender !== this.toastWindow.webContents) return;
      const h = Math.max(60, Math.min(400, Math.round(Number(height) || 0)));
      if (!h) return;
      const workArea = electron.screen.getPrimaryDisplay().workArea;
      this.toastWindow.setBounds({
        x: workArea.x + workArea.width - TOAST_WIDTH - TOAST_MARGIN,
        y: workArea.y + workArea.height - h - TOAST_MARGIN,
        width: TOAST_WIDTH,
        height: h,
      });
    });

    // OCR：結果視窗 renderer 註冊好監聽後通知主進程 flush 緩衝訊息
    ipcMain.on("ocr-ready", (event) => {
      if (!this.ocrResultWindow || this.ocrResultWindow.isDestroyed()) return;
      if (event.sender !== this.ocrResultWindow.webContents) return;
      this.ocrWindowReady = true;
      const pending = this.ocrPendingMessages;
      this.ocrPendingMessages = [];
      pending.forEach(([channel, payload]) =>
        this.ocrResultWindow.webContents.send(channel, payload)
      );
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

    // OCR：結果視窗釘選切換
    ipcMain.handle("ocr-toggle-pin", () => {
      if (!this.ocrResultWindow || this.ocrResultWindow.isDestroyed()) return false;
      const next = !this.ocrResultWindow.isAlwaysOnTop();
      this.ocrResultWindow.setAlwaysOnTop(next);
      return next;
    });

    ipcMain.handle("ocr-is-gemini-available", () => !!store.get("geminiApiKey"));

    // OCR：結果視窗的 🔍 搜尋 / 📷 IG 以預設瀏覽器開啟（僅允許已知目標網域）
    ipcMain.handle("ocr-open-external", (_event, url) => {
      try {
        const u = new URL(url);
        const allowedHosts = ["www.google.com", "www.instagram.com"];
        if (u.protocol === "https:" && allowedHosts.includes(u.hostname)) {
          shell.openExternal(u.href);
        }
      } catch {
        // 非法 URL 直接忽略
      }
    });

    // 儲存設定（並確保快捷鍵與置頂狀態立即套用）
    ipcMain.handle("save-settings", (event, settings) => {
      store.store = settings;

      // 立即同步主視窗置頂狀態（避免使用者關掉後仍維持置頂）
      try {
        const aot = settings && typeof settings.alwaysOnTop === "boolean" ? settings.alwaysOnTop : false;
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.setAlwaysOnTop(!!aot, 'normal');
          try { this.mainWindow.setVisibleOnAllWorkspaces(false); } catch {}
          console.log("[save-settings] 同步主視窗置頂狀態:", !!aot);
        }
      } catch (e) {
        console.warn("[save-settings] 同步置頂狀態失敗:", e.message);
      }

      // 若帶有快捷鍵設定，立即套用（防止前端未呼叫 update-shortcuts 的情況）
      if (settings && settings.shortcuts) {
        try {
          // 與 update-shortcuts 相同的正規化與註冊流程（內嵌精簡版）
          const normalizeAccelerator = (acc) => {
            if (!acc || typeof acc !== "string") return acc;
            let a = acc
              .replace(/\bControl\b/g, "Ctrl")
              .replace(/\bOption\b/g, "Alt")
              .replace(/\bReturn\b/g, "Enter");
            const parts = a.split("+").filter(Boolean);
            const mods = new Set([
              "CommandOrControl",
              "Command",
              "Ctrl",
              "Alt",
              "Shift",
              "Super",
            ]);
            const order = [
              "CommandOrControl",
              "Command",
              "Ctrl",
              "Alt",
              "Shift",
              "Super",
            ];
            const ordered = [];
            for (const m of order) if (parts.includes(m)) ordered.push(m);
            const keys = parts.filter((p) => !mods.has(p));
            const key = keys.length ? keys[keys.length - 1] : "";
            return [...ordered, key].filter(Boolean).join("+");
          };

          const isSupportedAccelerator = (acc) => {
            if (!acc || typeof acc !== "string") return false;
            const parts = acc.split("+").filter(Boolean);
            const modifiers = new Set([
              "CommandOrControl",
              "Command",
              "Ctrl",
              "Alt",
              "Shift",
              "Super",
            ]);
            // 單鍵允許（F鍵/功能鍵等），或 2~3 鍵：1~2 個修飾鍵 + 1 個主鍵
            if (parts.length === 1) return true;
            if (parts.length >= 2 && parts.length <= 3) {
              const mainKeys = parts.filter(p => !modifiers.has(p));
              const modKeys = parts.filter(p => modifiers.has(p));
              return mainKeys.length === 1 && modKeys.length >= 1 && modKeys.length <= 2;
            }
            return false;
          };

          // 兼容兩種結構：
          // A) 新結構：{ region:{key,enabled}, fullscreen:{...}, window:{...}, enabled:true }
          // B) 舊結構：{ regionCapture:"...", fullScreenCapture:"...", activeWindowCapture:"...", enableHotkeys:true }
          let normalized = {};
          const s = settings.shortcuts || {};
          if (s.region || s.fullscreen || s.window) {
            // A 格式
            normalized = JSON.parse(JSON.stringify(s));
            ["region", "fullscreen", "window"].forEach((t) => {
              if (normalized[t] && typeof normalized[t].key === "string") {
                normalized[t].key = normalizeAccelerator(normalized[t].key);
              }
              if (normalized[t] && typeof normalized[t].enabled === "undefined") {
                normalized[t].enabled = true;
              }
            });
            if (typeof normalized.enabled === "undefined") normalized.enabled = true;
          } else {
            // B 格式 → 轉換成 A 格式
            const mapBtoA = {
              region: s.regionCapture,
              fullscreen: s.fullScreenCapture,
              window: s.activeWindowCapture,
            };
            normalized.enabled = s.enableHotkeys !== false;
            ["region", "fullscreen", "window"].forEach((t) => {
              const keyStr = mapBtoA[t];
              if (typeof keyStr === "string" && keyStr.trim().length > 0) {
                const key = normalizeAccelerator(keyStr.trim());
                normalized[t] = { key, enabled: true };
              }
            });
          }

          // 先取消所有現有的快捷鍵
          this.shortcutManager.unregisterAll();

          // 儲存快捷鍵設定
          store.set("shortcuts", normalized);

          // 重新註冊
          const callbacks = {
            region: () => {
              console.log("快捷鍵觸發: 區域截圖");
              this.startRegionCapture();
            },
            fullscreen: () => {
              console.log("快捷鍵觸發: 全螢幕截圖");
              this.startFullScreenCapture();
            },
            window: () => {
              console.log("快捷鍵觸發: 視窗截圖");
              this.startActiveWindowCapture();
            },
          };

          const globalEnabled = normalized.enabled !== false;
          if (globalEnabled) {
            ["region", "fullscreen", "window"].forEach((type) => {
              const cfg = normalized[type];
              if (!cfg || cfg.enabled === false) return;
              const key = cfg.key || this.shortcutManager.defaultKeys[type];
              if (!isSupportedAccelerator(key)) return;
              this.shortcutManager.register(type, callbacks[type]);
            });
          }
        } catch (e) {
          console.warn("[save-settings] Apply shortcuts immediately failed:", e.message);
        }
      }

      return { success: true };
    });

    // 開啟設定視窗
    ipcMain.handle("open-settings-window", () => {
      this.openSettingsWindow();
      return { success: true };
    });

    // 更新快捷鍵設定（回傳逐項結果，便於前端提示）
    ipcMain.handle("update-shortcuts", (event, shortcuts) => {
      console.log("更新快捷鍵設定:", shortcuts);

      // 內部正規化：確保符合 Electron Accelerator
      const normalizeAccelerator = (acc) => {
        if (!acc || typeof acc !== 'string') return acc;
        let a = acc
          .replace(/\bControl\b/g, 'Ctrl')
          .replace(/\bOption\b/g, 'Alt')
          .replace(/\bReturn\b/g, 'Enter');

        const parts = a.split('+').filter(Boolean);
        const mods = new Set(['CommandOrControl','Command','Ctrl','Alt','Shift','Super']);
        const order = ['CommandOrControl','Command','Ctrl','Alt','Shift','Super'];
        const ordered = [];
        for (const m of order) if (parts.includes(m)) ordered.push(m);
        const keys = parts.filter(p => !mods.has(p));
        const key = keys.length ? keys[keys.length - 1] : '';
        return [...ordered, key].filter(Boolean).join('+');
      };

      // 僅支援：單鍵（F1~F12/PrintScreen 等）或 2 鍵（1 修飾鍵 + 1 主鍵）
      const isSupportedAccelerator = (acc) => {
        if (!acc || typeof acc !== 'string') return false;
        const parts = acc.split('+').filter(Boolean);
        const modifiers = new Set(['CommandOrControl','Command','Ctrl','Alt','Shift','Super']);
        // 單鍵允許，或 2~3 鍵：1~2 個修飾鍵 + 1 個主鍵
        if (parts.length === 1) return true;
        if (parts.length >= 2 && parts.length <= 3) {
          const mainKeys = parts.filter(p => !modifiers.has(p));
          const modKeys = parts.filter(p => modifiers.has(p));
          return mainKeys.length === 1 && modKeys.length >= 1 && modKeys.length <= 2;
        }
        return false;
      };

      // 先做一份正規化副本
      const normalized = JSON.parse(JSON.stringify(shortcuts || {}));
      ['region','fullscreen','window'].forEach(t => {
        if (normalized[t] && typeof normalized[t].key === 'string') {
          normalized[t].key = normalizeAccelerator(normalized[t].key);
        }
      });

      const failures = [];
      const warnings = [];

      // 保存原有的 callback
      const callbacks = {
        region: () => {
          console.log("快捷鍵觸發: 區域截圖");
          this.startRegionCapture();
        },
        fullscreen: () => {
          console.log("快捷鍵觸發: 全螢幕截圖");
          this.startFullScreenCapture();
        },
        window: () => {
          console.log("快捷鍵觸發: 視窗截圖");
          this.startActiveWindowCapture();
        },
      };

      // 先取消所有現有的快捷鍵
      this.shortcutManager.unregisterAll();

      // 儲存快捷鍵設定
      store.set("shortcuts", normalized);

      const globalEnabled = normalized.enabled !== false;

      if (globalEnabled) {
        // 逐一註冊並收集失敗原因
        ["region", "fullscreen", "window"].forEach((type) => {
          const cfg = normalized[type];
          if (!cfg || cfg.enabled === false) return;

          const key = cfg.key || this.shortcutManager.defaultKeys[type];

          // 規則：僅支援單鍵或 2 鍵（1 修飾鍵 + 1 主鍵）
          if (!isSupportedAccelerator(key)) {
            failures.push({
              type,
              key,
              reason: "本版本僅支援單鍵（F1~F12/PrintScreen）或 2 鍵（1 修飾鍵 + 1 主鍵）",
            });
            return;
          }

          // Windows 上 PrintScreen 搭配修飾鍵在部分系統可能無法註冊
          const isWin = process.platform === "win32";
          const hasModifier = typeof key === "string" && key.includes("+");
          if (isWin && typeof key === "string" && key.includes("PrintScreen") && hasModifier) {
            warnings.push({ type, key, reason: "Windows 可能不支援帶修飾鍵的 PrintScreen 快捷鍵" });
          }

          const ok = this.shortcutManager.register(type, callbacks[type]);
          if (!ok) {
            failures.push({
              type,
              key,
              reason:
                globalShortcut.isRegistered(key)
                  ? "按鍵已被其他程式或系統佔用"
                  : "Electron 無法註冊該快捷鍵（可能被系統保留）",
            });
          }
        });
      }

      return { success: failures.length === 0, failures, warnings };
    });

    // 列出資料夾圖片：readdir + 並行 stat，一次回傳（含真實 size/mtime 與穩定 id）。
    // 舊版的「稍後背景 stat」在 return 之後才改物件，資料永遠到不了 renderer，是死碼。
    ipcMain.handle("list-screenshots", async (_event, folderPath) => {
      try {
        const requested =
          typeof folderPath === "string" && folderPath.trim() ? folderPath : null;
        const saveDir = await this.getValidSaveDir();
        const dir = requested || saveDir;
        // 只替預設儲存資料夾建目錄（首次啟動還不存在）；瀏覽別的資料夾不應該順手建資料夾
        if (path.resolve(dir) === path.resolve(saveDir)) {
          await fs.mkdir(dir, { recursive: true }).catch(() => {});
        }
        const files = await listImages(dir);
        return { success: true, files, directory: dir, totalCount: files.length };
      } catch (error) {
        console.error("[list-screenshots] 錯誤:", error);
        return { success: false, error: error.message, files: [] };
      }
    });

    // 主視窗要求監看目前瀏覽的資料夾（內容變動 → "folder-changed"）
    ipcMain.handle("watch-folder", async (event, dir) => {
      if (!this.mainWindow || event.sender !== this.mainWindow.webContents) {
        return { success: false, error: "not main window" };
      }
      if (!(await this.isGalleryFolder(dir))) {
        return { success: false, error: "not a gallery folder" };
      }
      return { success: this.watchFolder(dir) };
    });

    // 新增獨立的縮圖生成 API（按需調用）
    // 縮圖快取（記憶體 LRU）
    const crypto = require("crypto");
    const THUMB_CACHE_MAX = 300;
    const thumbMemCache = new Map(); // key -> dataURL
    function thumbKey(filePath, mtimeMs, width) {
      return `${filePath}|${mtimeMs}|w${width}`;
    }
    function thumbCacheGet(key) {
      if (!thumbMemCache.has(key)) return null;
      const val = thumbMemCache.get(key);
      // LRU：移到尾端
      thumbMemCache.delete(key);
      thumbMemCache.set(key, val);
      return val;
    }
    function thumbCacheSet(key, dataUrl) {
      thumbMemCache.set(key, dataUrl);
      if (thumbMemCache.size > THUMB_CACHE_MAX) {
        const oldest = thumbMemCache.keys().next().value;
        thumbMemCache.delete(oldest);
      }
    }

    ipcMain.handle("get-thumbnail", async (event, filePath, width = 300) => {
      try {
        if (!filePath || typeof filePath !== "string") {
          console.warn("[get-thumbnail] Invalid filePath:", filePath);
          return null;
        }

        // 檢查檔案是否存在
        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch (statError) {
          console.warn("[get-thumbnail] File not found:", filePath, statError.message);
          return null;
        }

        const key = thumbKey(filePath, stat.mtimeMs, width);

        // 記憶體快取命中
        const cached = thumbCacheGet(key);
        if (cached) return cached;

        const ni = electron.nativeImage.createFromPath(filePath);
        if (ni.isEmpty()) {
          console.warn("[get-thumbnail] nativeImage is empty for:", filePath);
          return null;
        }

        const resized = ni.resize({ width, quality: 'good' });
        if (resized.isEmpty()) {
          console.warn("[get-thumbnail] Resized image is empty for:", filePath);
          return null;
        }

        const dataUrl = resized.toDataURL();

        // 存入快取
        thumbCacheSet(key, dataUrl);
        return dataUrl;
      } catch (error) {
        console.error("[get-thumbnail] Error generating thumbnail:", error, "for file:", filePath);
        return null;
      }
    });

    // 實際刪除檔案（預設移至資源回收桶）
    ipcMain.handle("delete-files", async (_event, paths, options) => {
      try {
        const toTrash = options && options.toTrash !== false;
        const deleted = [];
        const failed = [];

        if (!Array.isArray(paths) || paths.length === 0) {
          return { success: true, deleted: [], failed: [] };
        }

        for (let p of paths) {
          if (typeof p !== "string" || p.length === 0) continue;
          try {
            // 防呆：若不小心傳來 file:///，轉回系統路徑
            if (p.startsWith("file:///")) {
              try {
                const withoutScheme = p.replace(/^file:\/\/\//, "");
                const decoded = decodeURIComponent(withoutScheme);
                if (process.platform === "win32") p = decoded.replace(/\//g, "\\");
                else p = "/" + decoded;
              } catch {}
            }

            let ok = false;
            let lastErr = null;

            if (toTrash && typeof shell.trashItem === "function") {
              try {
                await shell.trashItem(p);
                ok = true;
              } catch (e1) {
                lastErr = e1;
              }
            }

            // 退而求其次：直接刪除
            if (!ok) {
              try {
                await fs.unlink(p);
                ok = true;
              } catch (e2) {
                lastErr = e2;
              }
            }

            if (ok) {
              deleted.push({ path: p });
            } else {
              failed.push({ path: p, error: lastErr?.message || "Unknown error" });
            }
          } catch (e) {
            failed.push({ path: p, error: e.message });
          }
        }

        // 詳細記錄
        try {
          console.log("[delete-files] result:", {
            toTrash,
            total: paths.length,
            deleted: deleted.length,
            failed: failed
          });
        } catch {}

        return { success: failed.length === 0, deleted, failed };
      } catch (e) {
        return { success: false, error: e.message, deleted: [], failed: [] };
      }
    });

    // 由主進程代理上傳圖片（避免 CORS / TLS 攔截）。
    // 供應商鏈：URUSAI!（第三方、免費匿名）優先 → duk.tw（自家）只當備援，且要在設定頁填 API 金鑰才啟用。
    // 任一家失敗自動換下一家；截圖本身一律已存本機，這裡只影響分享連結。
    ipcMain.handle("upload-duk", async (event, payload) => {
      try {
        if (!this.isTrustedSender(event.sender)) return { success: false, error: "拒絕的來源" };
        const { bytes, filename, contentType, apiKey } = payload || {};
        if (!bytes) return { success: false, error: "缺少圖片位元組" };
        const buffer = toImageBuffer(bytes);
        if (buffer.length > 64 * 1024 * 1024) return { success: false, error: "圖片過大" };

        // 渲染端傳入的金鑰（舊介面）視為 URUSAI token 覆寫
        const settings = { ...store.store };
        if (apiKey && typeof apiKey === "string" && apiKey.trim()) {
          settings.upload = { ...(settings.upload || {}), urusaiToken: apiKey.trim() };
        }
        const chain = buildProviderChain(settings, process.env);

        // 使用 Electron net.fetch（走 Chromium 網路層 + 系統憑證庫），
        // 才能穿過某些環境（防毒／企業代理）的 TLS 攔截，避免 "fetch failed"。
        const result = await uploadWithFallback(chain, {
          bytes: buffer,
          filename: filename || "screenshot.png",
          contentType: contentType || "image/png",
          fetch: (url, init) => net.fetch(url, init),
          version: app.getVersion?.() || "1.0",
        });
        if (result.attempts.some((a) => a.error)) {
          console.warn("[upload] 前面的圖床失敗，已改用", result.provider, result.attempts);
        }
        return {
          success: true,
          url: result.url,
          deleteUrl: result.deleteUrl,
          provider: result.provider,
          providerLabel: result.label,
          raw: result.raw,
        };
      } catch (e) {
        return { success: false, error: e.message, attempts: e.attempts || [] };
      }
    });

    // 由主進程寫入剪貼簿（不需視窗焦點，避免 "Document is not focused" 錯誤）
    ipcMain.handle("clipboard-write-text", (_event, text) => {
      try {
        clipboard.writeText(String(text == null ? "" : text));
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // 鴨鴨家族：姊妹 app（RePic / ReVid）偵測已安裝、一鍵下載安裝（family-kit）
    try {
      this.family = createFamily({
        selfId: "duckshot",
        cacheDir: path.join(app.getPath("userData"), "family-kit"),
        shell,
        fetch: (url, init) => net.fetch(url, init),
        userAgent: `DuckShot/${app.getVersion?.() || "1.0"}`,
        log: (...a) => console.warn("[family]", ...a),
      });
      this.family.registerIpc(ipcMain, {
        prefix: "family",
        isTrusted: (sender) =>
          [this.mainWindow, this.settingsWindow].some(
            (w) => w && !w.isDestroyed() && w.webContents === sender
          ),
      });
    } catch (e) {
      console.warn("[family] init failed:", e.message);
    }

    ipcMain.handle("clipboard-write-image", (_event, image) => {
      try {
        if (!image) return { success: false, error: "缺少影像資料" };
        const img =
          typeof image === "string"
            ? electron.nativeImage.createFromDataURL(image)
            : electron.nativeImage.createFromBuffer(toImageBuffer(image));
        if (img.isEmpty()) return { success: false, error: "影像為空" };
        clipboard.writeImage(img);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
  }

  // 快取各螢幕的擷取來源 ID（display_id → sourceId），啟動與螢幕配置變更時呼叫。
  // 多螢幕：按下快捷鍵時依游標所在螢幕挑對應來源。
  async refreshScreenSourceId() {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      });
      const round = (this.screenSourceRound = (this.screenSourceRound || 0) + 1);
      const plain = sources.map((s) => ({ id: s.id, display_id: s.display_id }));
      const displays = electron.screen.getAllDisplays().map((d) => ({
        id: d.id,
        origin:
          typeof electron.screen.dipToScreenPoint === "function"
            ? electron.screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y })
            : { x: d.bounds.x, y: d.bounds.y },
      }));
      let built = buildSourceMap({ sources: plain, displays, devices: null });
      this.cachedScreenSources = built.map;
      this.cachedFirstSourceId = sources.length > 0 ? sources[0].id : null;
      // 來源沒帶 display_id（DirectX 擷取器不可用時 Electron 不填）而且不只一台螢幕：
      // 先照順序頂著用，再向 Windows 問裝置座標把對應修正確
      if (built.method !== "display_id" && sources.length > 1) {
        const devices = await queryDisplayDevices();
        if (round !== this.screenSourceRound) return this.cachedScreenSources;
        built = buildSourceMap({ sources: plain, displays, devices });
        this.cachedScreenSources = built.map;
      }
      console.log("[perf] screen sources cached:", sources.length, "displays, matched by", built.method);
      return built.map;
    } catch (e) {
      console.warn("refreshScreenSourceId failed:", e.message);
      this.cachedScreenSources = new Map();
      this.cachedFirstSourceId = null;
      return null;
    }
  }

  // 依螢幕 id 取得擷取來源 ID（找不到對應 → 退回第一個來源）
  getSourceIdForDisplay(displayId) {
    const key = String(displayId);
    if (this.cachedScreenSources && this.cachedScreenSources.has(key)) {
      return this.cachedScreenSources.get(key);
    }
    return this.cachedFirstSourceId || null;
  }

  // 從一批剛抓回來的來源（含縮圖）裡挑出某個螢幕的那一個
  pickScreenSource(sources, display) {
    const direct = sources.find((s) => s.display_id && String(s.display_id) === String(display.id));
    if (direct) return direct;
    const wanted = this.getSourceIdForDisplay(display.id);
    return sources.find((s) => s.id === wanted) || sources[0];
  }

  async startRegionCapture() {
    const tStart = Date.now();
    if (this.captureActive) {
      return { success: false, error: "截圖視窗已開啟" };
    }
    this.captureActive = true;

    try {
      // 多螢幕：目標螢幕 = 按下快捷鍵當下游標所在的螢幕
      const { cursorPt, display: targetDisplay } = displayUnderCursor();

      // 截圖 overlay 的數字鍵優先，收回 toast 的 1~9 全域快捷鍵
      this.unregisterToastShortcuts();

      // 常駐覆蓋層：通常已經載好，這裡只是搬到目標螢幕；第一次（或 renderer 掛掉後）才會真的建視窗
      const ready = this.ensureCaptureWindow(targetDisplay);

      // 只有當主視窗「實際可見」時才需要隱身並等待合成器；
      // 已最小化／在托盤時直接擷取，介面瞬間出現且事後不會把視窗彈出來。
      const mw = this.mainWindow;
      const mainVisible = !!(mw && !mw.isDestroyed() && mw.isVisible() && !mw.isMinimized());
      this.didHideMainForCapture = false;

      if (mainVisible) {
        this.originalMainWindowBounds = mw.getBounds();
        this.originalMainWindowState = {
          bounds: this.originalMainWindowBounds,
          wasMaximized: mw.isMaximized(),
          wasMinimized: mw.isMinimized(),
        };
        // 雙重隱身：透明 + 最小化 + 移到螢幕外
        mw.setOpacity(0);
        mw.minimize();
        mw.setBounds(HIDE_OFFSCREEN_POS, false);
        this.didHideMainForCapture = true;
        await sleep(COMPOSITOR_WAIT_MS);
      }

      await ready;
      await this.presentCapture(targetDisplay, cursorPt);
      console.log(`[perf] region capture overlay shown: ${Date.now() - tStart}ms`);

      return { success: true, message: "區域截圖界面已開啟", type: "region" };
    } catch (error) {
      console.error("Error starting region capture:", error);
      this.hideCaptureWindow(); // 會還原主視窗
      return { success: false, error: error.message };
    }
  }

  // 組 screen-data 並把常駐覆蓋層以「完全透明」狀態顯示；renderer 畫好凍結幀回報 capture-drawn
  // 才把不透明度調回 1。這樣視訊流抓桌面時覆蓋層絕不會被截進去，重用視窗也不會閃出上一次的殘影。
  async presentCapture(targetDisplay, cursorPt) {
    let sourceId = this.getSourceIdForDisplay(targetDisplay.id);
    if (!sourceId) {
      await this.refreshScreenSourceId();
      sourceId = this.getSourceIdForDisplay(targetDisplay.id);
    }
    if (!sourceId) throw new Error("無法獲取螢幕源");

    const size = displayPhysicalSize(targetDisplay);
    const screenData = {
      sourceId,
      width: size.width,            // 擷取幀物理像素
      height: size.height,
      boundsWidth: targetDisplay.bounds.width,   // 目標螢幕 DIP（renderer 用 width/boundsWidth 算縮放，
      boundsHeight: targetDisplay.bounds.height, // 不依賴可能還沒更新的 devicePixelRatio / innerWidth）
      scaleFactor: targetDisplay.scaleFactor || 1,
      hideCursor: store.get("hideCursor") !== false,
      cursorX: cursorPt.x - targetDisplay.bounds.x,
      cursorY: cursorPt.y - targetDisplay.bounds.y,
    };

    const cw = this.captureWindow;
    if (!cw || cw.isDestroyed()) throw new Error("截圖視窗建立失敗");
    // 跨螢幕（不同 DPI）搬移時 Electron 偶爾一次 setBounds 尺寸會錯，差了就再設一次
    cw.setBounds(targetDisplay.bounds, false);
    const got = cw.getBounds();
    if (got.width !== targetDisplay.bounds.width || got.height !== targetDisplay.bounds.height) {
      cw.setBounds(targetDisplay.bounds, false);
    }

    this.captureDrawnSeq = (this.captureDrawnSeq || 0) + 1;
    const seq = this.captureDrawnSeq;
    try { cw.setOpacity(CAPTURE_HIDDEN_OPACITY); } catch {}
    cw.webContents.send("screen-data", screenData);
    cw.setAlwaysOnTop(true, "screen-saver", 1);
    try { cw.setVisibleOnAllWorkspaces(true); } catch {}
    cw.show();
    cw.focus();
    // 保險：renderer 沒回報（串流與後備都失敗）也在 4 秒後現身，使用者至少看得到提示並能按 Esc
    clearTimeout(this.captureRevealTimer);
    this.captureRevealTimer = setTimeout(() => this.revealCaptureWindow(seq), 4000);
  }

  revealCaptureWindow(seq) {
    if (seq !== undefined && seq !== this.captureDrawnSeq) return;
    clearTimeout(this.captureRevealTimer);
    const cw = this.captureWindow;
    if (cw && !cw.isDestroyed() && this.captureActive) {
      try { cw.setOpacity(1); } catch {}
    }
  }

  // 常駐覆蓋層：啟動後預建一個隱藏的截圖視窗，之後每次截圖只做 setBounds + show，
  // 省掉老機器上每次 200~500ms 的 BrowserWindow 建立與 capture.html 載入。
  ensureCaptureWindow(targetDisplay) {
    const display = targetDisplay || electron.screen.getPrimaryDisplay();
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      this.captureWindow.setBounds(display.bounds, false);
      return this.captureWindowReady || Promise.resolve();
    }

    const b = display.bounds;
    // 不用 fullscreen:true：Windows 會對全螢幕視窗播放系統縮放動畫，
    // 改用手動鋪滿螢幕 + screen-saver 置頂（蓋過工作列），出現時零動畫。
    const cw = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      thickFrame: false,
      alwaysOnTop: true,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: true,
      skipTaskbar: true,
      focusable: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
        backgroundThrottling: false, // 隱藏常駐時也別節流，show 出來第一幀才不會拖
      },
    });
    this.captureWindow = cw;
    this.captureWindowReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("overlay load timeout")), 15000);
      cw.webContents.once("did-finish-load", () => { clearTimeout(timer); resolve(); });
      cw.webContents.once("did-fail-load", (_e, code, desc) => {
        clearTimeout(timer);
        reject(new Error(`overlay load failed: ${code} ${desc}`));
      });
    });
    // 載入失敗就銷毀，下次 ensureCaptureWindow 重建；呼叫端 await 會拿到 reject
    this.captureWindowReady.catch((e) => {
      console.warn("[capture]", e.message);
      try { if (!cw.isDestroyed()) cw.destroy(); } catch {}
    });
    cw.loadFile(path.join(__dirname, "../renderer/capture.html"));

    // renderer 掛掉（老機器記憶體不足）：銷毀，下次 ensureCaptureWindow 重建
    cw.webContents.on("render-process-gone", (_e, details) => {
      console.warn("[capture] overlay renderer gone:", details && details.reason);
      try { cw.destroy(); } catch {}
    });

    cw.on("closed", () => {
      const wasActive = this.captureActive;
      this.captureWindow = null;
      this.captureWindowReady = null;
      this.captureActive = false;
      if (wasActive) this.onCaptureDismissed();
    });

    if (this.isDebug && store.get("openDevTools") === true) {
      cw.webContents.openDevTools({ mode: "detach" });
    }
    return this.captureWindowReady;
  }

  prewarmCaptureWindow() {
    if (this.isQuitting || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      this.ensureCaptureWindow(displayUnderCursor().display);
    } catch (e) {
      console.warn("[capture] prewarm failed:", e.message);
    }
  }

  // 覆蓋層結束（Esc/右鍵/存檔後/錯誤）：只隱藏不銷毀，renderer 收到 capture-reset 清狀態與畫面
  hideCaptureWindow() {
    if (!this.captureActive) return;
    this.captureActive = false;
    clearTimeout(this.captureRevealTimer);
    const cw = this.captureWindow;
    if (cw && !cw.isDestroyed()) {
      try { cw.setOpacity(0); } catch {} // 到下次畫好新幀前都保持透明，殘影不可能被看到
      try { cw.hide(); } catch {}
      try { cw.webContents.send("capture-reset"); } catch {}
    }
    // 覆蓋層開著時 toast 的數字鍵 1~9 被壓住（避免搶 overlay 的數字鍵）；收掉後註冊回去
    if (this.toastWindow && !this.toastWindow.isDestroyed() && this.toastLatestPayload) {
      this.registerToastShortcuts(this.toastLatestPayload.tabs);
    }
    this.onCaptureDismissed();
  }

  onCaptureDismissed() {
    // OCR 流程：主視窗先不還原，等 OCR 結果視窗關閉再還原（避免大視窗搶畫面）
    if (this.skipNextMainRestore) {
      this.skipNextMainRestore = false;
      this.pendingMainRestoreAfterOcr = true;
      return;
    }
    this.restoreMainWindow();
  }

  // 連續截圖 / 視訊流後備：抓「覆蓋層所在螢幕」整張畫面（依該螢幕物理尺寸，不放大）
  async grabScreenDataUrlForCaptureWindow() {
    const cw = this.captureWindow;
    const display =
      cw && !cw.isDestroyed()
        ? electron.screen.getDisplayMatching(cw.getBounds())
        : displayUnderCursor().display;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: displayPhysicalSize(display),
    });
    if (!sources.length) throw new Error("無法獲取螢幕源");
    const target = this.pickScreenSource(sources, display);
    // 縮圖擷取失敗時拿到的是空圖；當成失敗處理，不要送一張畫不出來的圖過去
    if (target.thumbnail.isEmpty()) throw new Error("螢幕縮圖是空的");
    return target.thumbnail.toDataURL();
  }

  async startFullScreenCapture() {
    try {
      // 多螢幕：抓游標所在的螢幕；縮圖尺寸 = 該螢幕物理像素
      const { display } = displayUnderCursor();
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: displayPhysicalSize(display),
      });
      if (sources.length === 0) throw new Error("無法找到螢幕源");
      const target = this.pickScreenSource(sources, display);

      // 直接拿 PNG 位元組寫檔，不經 base64 來回
      const entry = await this.writeScreenshotFile(target.thumbnail.toPNG(), "png");
      return { success: true, type: "fullscreen", source: target.name, saved: true, path: entry.path };
    } catch (error) {
      console.error("Error in fullscreen capture:", error);
      return { success: false, error: error.message };
    }
  }

  async startActiveWindowCapture() {
    try {
      // desktopCapturer 只能一次抓所有視窗的縮圖；尺寸壓在游標所在螢幕的物理像素，不放大
      const { display } = displayUnderCursor();
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: displayPhysicalSize(display),
        fetchWindowIcons: false,
      });
      if (sources.length === 0) throw new Error("無法找到視窗源");

      const skip = ["Dukshot", "DuckShot", "Electron", "DevTools", "Task Manager", "System Settings", "Windows PowerShell", "Command Prompt"];
      const filteredSources = sources.filter(
        (source) =>
          source.name.trim().length > 0 &&
          source.name !== "Desktop" &&
          source.name !== "Screen" &&
          !skip.some((s) => source.name.includes(s))
      );
      if (filteredSources.length === 0) {
        console.log("No suitable windows found, using screen capture instead");
        return await this.startFullScreenCapture();
      }

      const targetWindow = filteredSources[0];
      const entry = await this.writeScreenshotFile(targetWindow.thumbnail.toPNG(), "png");
      console.log(`Window capture completed: ${targetWindow.name}`);
      return { success: true, type: "window", source: targetWindow.name, saved: true, path: entry.path };
    } catch (error) {
      console.error("Error in window capture:", error);
      return { success: false, error: error.message };
    }
  }

  // 寫檔 + 通知主視窗 + 分類 toast：所有截圖路徑共用。回傳與 list-screenshots 同形狀的 entry
  // （id = path|mtime），renderer 直接插入清單，之後 fs.watch 重列時 id 一致不閃爍。
  async writeScreenshotFile(buffer, format = "png", label = "") {
    const targetDir = await this.getValidSaveDir();
    await fs.mkdir(targetDir, { recursive: true }).catch((err) => {
      console.warn(`[writeScreenshotFile] 建立目錄失敗，嘗試繼續: ${err.message}`);
    });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = String(label || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
    const filename = safeLabel
      ? `Dukshot-${timestamp}-${safeLabel}.${format}`
      : `Dukshot-${timestamp}.${format}`;
    const filePath = path.join(targetDir, filename);

    await fs.writeFile(filePath, buffer);
    const st = await fs.stat(filePath).catch(() => null);
    const mtimeMs = st ? st.mtimeMs : Date.now();
    const entry = {
      id: imageEntryId(filePath, mtimeMs),
      name: filename,
      path: filePath,
      size: st ? st.size : buffer.length,
      mtimeMs,
      type: `image/${format}`,
    };

    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("capture-completed", { success: true, ...entry });
      }
    } catch (notifyError) {
      console.error("Error notifying renderer about capture completion:", notifyError);
    }
    this.showSortToast(filePath); // fire-and-forget
    return entry;
  }

  // 只有自家視窗（主視窗 / 覆蓋層 / OCR 結果）送來的 IPC 才能寫檔
  isTrustedSender(sender) {
    return [this.mainWindow, this.captureWindow, this.ocrResultWindow].some(
      (w) => w && !w.isDestroyed() && w.webContents === sender
    );
  }

  // 圖庫允許監看的資料夾：預設儲存資料夾或 galleryTabs 內的分頁
  async isGalleryFolder(dir) {
    if (typeof dir !== "string" || !dir.trim()) return false;
    const target = path.resolve(dir);
    if (path.resolve(await this.getValidSaveDir()) === target) return true;
    const tabs = store.get("galleryTabs");
    return (
      Array.isArray(tabs) &&
      tabs.some((t) => t && typeof t.path === "string" && path.resolve(t.path) === target)
    );
  }

  // 監看圖庫目前瀏覽的資料夾；同時只監看一個。debounce 300ms 合併連發事件。
  watchFolder(dir) {
    this.closeFolderWatcher();
    if (typeof dir !== "string" || !dir.trim()) return false;
    try {
      const watcher = require("fs").watch(dir, { persistent: false }, () => {
        clearTimeout(this.folderWatchDebounce);
        this.folderWatchDebounce = setTimeout(() => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send("folder-changed", dir);
          }
        }, 300);
      });
      watcher.on("error", (e) => {
        console.warn("[watch-folder] watcher error:", e.message);
        this.closeFolderWatcher();
        // 告訴主視窗監看失效，讓它退回 focus 刷新
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send("folder-watch-lost", dir);
        }
      });
      this.folderWatcher = watcher;
      return true;
    } catch (e) {
      console.warn("[watch-folder] failed:", e.message);
      return false;
    }
  }

  closeFolderWatcher() {
    clearTimeout(this.folderWatchDebounce);
    this.folderWatchDebounce = null;
    if (this.folderWatcher) {
      try { this.folderWatcher.close(); } catch {}
      this.folderWatcher = null;
    }
  }

  // 直接保存截圖（相容舊呼叫；實作統一在 writeScreenshotFile）
  async saveScreenshotDirect(imageData, format = "png") {
    try {
      const entry = await this.writeScreenshotFile(toImageBuffer(imageData), format);
      return { success: true, path: entry.path };
    } catch (error) {
      console.error("Error saving screenshot:", error);
      return { success: false, error: error.message };
    }
  }

  // 開啟（或重用）OCR 結果視窗並開始辨識。
  // requestId 防止並發辨識互相覆寫（後發請求為準）；
  // sendToOcrWindow 的緩衝防止 renderer 尚未註冊監聽就 send（與 toast 相同的競態修法）。
  async openOcrResultWindow(imageData, screenBounds) {
    this.ocrRequestId += 1;
    const requestId = this.ocrRequestId;
    try {
      if (!this.ocrResultWindow || this.ocrResultWindow.isDestroyed()) {
        this.ocrWindowReady = false;
        this.ocrPendingMessages = [];
        this.ocrResultWindow = new BrowserWindow({
          width: 420,
          height: 390,
          minWidth: 360,
          minHeight: 320,
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
          this.ocrWindowReady = false;
          this.ocrPendingMessages = [];
          // OCR 流程結束，把先前被壓住的主視窗還原回來
          if (this.pendingMainRestoreAfterOcr) {
            this.pendingMainRestoreAfterOcr = false;
            this.restoreMainWindow();
          }
        });
        try {
          await this.ocrResultWindow.loadFile(
            path.join(__dirname, "../renderer/ocrResult.html")
          );
        } catch (loadError) {
          // 載入失敗：銷毀並重置單例，避免之後送進壞掉的視窗
          try { this.ocrResultWindow.destroy(); } catch {}
          this.ocrResultWindow = null;
          throw loadError;
        }
      }
      this.ocrResultWindow.show();
      this.sendToOcrWindow("ocr-start", { image: imageData });

      const { extractText, formatConfidence } = require("./ocr/textExtractor");
      const result = await extractText({ imageData, screenBounds });
      if (requestId !== this.ocrRequestId) return; // 已有更新的辨識請求，丟棄本次結果
      if (result.text) {
        this.sendToOcrWindow("ocr-result", {
          image: imageData,
          text: result.text,
          method: result.method,
          confidence: result.confidence,
          methodDisplay: formatConfidence(result.method, result.confidence),
        });
      } else {
        this.sendToOcrWindow("ocr-error", { message: "辨識不到文字" });
      }
    } catch (error) {
      console.error("OCR failed:", error);
      if (requestId === this.ocrRequestId) {
        this.sendToOcrWindow("ocr-error", {
          message: error.message || "OCR failed",
        });
      }
    }
  }

  // renderer 註冊好監聽（送來 ocr-ready）前先緩衝訊息，ready 後依序 flush
  sendToOcrWindow(channel, payload) {
    if (!this.ocrResultWindow || this.ocrResultWindow.isDestroyed()) return;
    if (!this.ocrWindowReady) {
      this.ocrPendingMessages.push([channel, payload]);
      return;
    }
    this.ocrResultWindow.webContents.send(channel, payload);
  }

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

      // 記住最新 payload：視窗載入完成前若又存了新圖，以最新者為準（最後送達）
      this.toastLatestPayload = {
        filePath: savedPath,
        defaultName: path.basename(saveDir),
        tabs,
      };

      // 單例重用：連續截圖時更新內容、不堆疊。
      // 視窗還在載入中時不直接 send（renderer 尚未註冊監聽），
      // 載入完成的 callback 會送出 toastLatestPayload。
      if (this.toastWindow && !this.toastWindow.isDestroyed()) {
        if (this.toastWindowLoaded) {
          this.toastWindow.webContents.send("toast-data", this.toastLatestPayload);
        }
        this.registerToastShortcuts(tabs);
        return;
      }
      this.toastWindowLoaded = false;

      const workArea = electron.screen.getPrimaryDisplay().workArea;
      const TOAST_H = 100; // 初始高度，載入後由 toast-resize 依內容調整
      const isDarkTheme = store.get("theme") === "dark";
      this.toastWindow = new BrowserWindow({
        width: TOAST_WIDTH,
        height: TOAST_H,
        x: workArea.x + workArea.width - TOAST_WIDTH - TOAST_MARGIN,
        y: workArea.y + workArea.height - TOAST_H - TOAST_MARGIN,
        frame: false,
        // 不用 transparent：Windows 上透明視窗以 showInactive 顯示時可能整片不渲染；
        // Win11 對無邊框視窗會自動套圓角，實色背景即可。背景色跟主題走避免閃色。
        backgroundColor: isDarkTheme ? "#141414" : "#ffffff",
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
      // 比一般 alwaysOnTop 更高的層級，確保蓋過還沒完全關閉的截圖覆蓋層
      this.toastWindow.setAlwaysOnTop(true, "screen-saver");
      this.toastWindow.on("closed", () => {
        this.toastWindow = null;
        this.toastWindowLoaded = false;
        this.unregisterToastShortcuts();
      });
      try {
        await this.toastWindow.loadFile(
          path.join(__dirname, "../renderer/toast.html")
        );
      } catch (loadError) {
        // 載入失敗：銷毀並重置單例，避免之後每次存檔都送進壞掉的視窗
        try { this.toastWindow.destroy(); } catch {}
        this.toastWindow = null;
        throw loadError;
      }
      this.toastWindowLoaded = true;
      if (this.toastWindow && !this.toastWindow.isDestroyed()) {
        this.toastWindow.webContents.send("toast-data", this.toastLatestPayload);
        this.toastWindow.showInactive(); // 顯示但不奪焦點
        this.registerToastShortcuts(tabs);
      }
    } catch (e) {
      console.error("showSortToast failed:", e);
    }
  }

  // toast 顯示期間註冊數字鍵 1~9 對應分類資料夾（全鍵盤流程）。
  // 截圖 overlay 開著時（連續截圖）跳過，避免搶走 overlay 自己的數字鍵。
  registerToastShortcuts(tabs) {
    this.unregisterToastShortcuts();
    if (this.captureActive) return;
    const count = Math.min(tabs.length, 9);
    this.toastShortcutKeys = [];
    for (let i = 0; i < count; i++) {
      const key = String(i + 1);
      const tab = tabs[i];
      try {
        const ok = globalShortcut.register(key, () => this.moveLatestToTab(i, tab));
        if (ok) this.toastShortcutKeys.push(key);
      } catch (e) {
        console.warn(`[toast] 註冊快捷鍵 ${key} 失敗:`, e.message);
      }
    }
  }

  unregisterToastShortcuts() {
    (this.toastShortcutKeys || []).forEach((key) => {
      try { globalShortcut.unregister(key); } catch {}
    });
    this.toastShortcutKeys = [];
  }

  // 數字鍵觸發：把最新存的截圖移到第 index 個分類資料夾
  async moveLatestToTab(index, tab) {
    this.unregisterToastShortcuts(); // 防止連按重複搬移
    const payload = this.toastLatestPayload;
    if (!payload) return;
    const notify = (data) => {
      if (this.toastWindow && !this.toastWindow.isDestroyed() && this.toastWindowLoaded) {
        this.toastWindow.webContents.send("toast-moved", data);
      }
    };
    try {
      await moveFile(payload.filePath, tab.path);
      notify({ success: true, index, name: tab.name });
    } catch (error) {
      console.error("moveLatestToTab failed:", error);
      notify({ success: false, error: error.message });
    }
  }

  // 取得有效的儲存目錄：設定值存在就用；否則問一次系統「圖片」路徑（結果快取，不重複 spawn）
  async getValidSaveDir() {
    const configured = store.get("saveDirectory");
    const dir = await this.saveDirResolver.getValidSaveDir(configured);
    if (configured && dir !== configured) {
      console.warn(`[getValidSaveDir] Configured path not accessible: ${configured}`);
    }
    return dir;
  }

  // 取得預設截圖儲存資料夾（同步版本，向下相容）
  getDefaultSaveDir() {
    const configured = store.get("saveDirectory");
    if (
      configured &&
      typeof configured === "string" &&
      configured.trim().length > 0
    ) {
      return configured;
    }
    // 預設使用「圖片」資料夾下的 DuckShot 子目錄
    return path.join(os.homedir(), "Pictures", "DuckShot");
  }

  // 新增主視窗還原方法
  openSettingsWindow() {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.focus();
      return;
    }

    this.settingsWindow = new BrowserWindow({
      width: 900,
      height: 700,
      parent: this.mainWindow,
      modal: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        // 設定頁面需要直接存取 ipcRenderer
      },
      icon: path.join(__dirname, "../assets/icons/logo-imgup.png"),
      title: "設定 - Dukshot",
    });

    this.settingsWindow.loadFile(path.join(__dirname, "../renderer/settings.html"));

    this.settingsWindow.on("closed", () => {
      this.settingsWindow = null;
    });

    // 開發模式下開啟開發者工具
    if (this.isDebug && store.get("openDevTools") === true) {
      this.settingsWindow.webContents.openDevTools();
    }
  }

  restoreMainWindow() {
    // 若這次截圖並未隱藏主視窗（原本就在托盤／最小化），就不要把它彈出來，
    // 維持原狀即可。這對應使用者用全域快捷鍵、習慣用貼上的工作流程。
    if (!this.didHideMainForCapture) {
      console.debug("[區域截圖] 本次未隱藏主視窗，維持原狀不彈出");
      this.originalMainWindowBounds = null;
      this.originalMainWindowState = null;
      return;
    }
    this.didHideMainForCapture = false;

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      console.debug("[區域截圖] 開始還原主視窗");

      // 還原透明度
      this.mainWindow.setOpacity(1);
      console.debug("[區域截圖] - 還原透明度為 1");

      // 還原位置（如果有記錄）
      if (this.originalMainWindowBounds) {
        this.mainWindow.setBounds(this.originalMainWindowBounds, false);
        console.debug("[區域截圖] - 還原視窗位置:", this.originalMainWindowBounds);
      }

      // 根據原始狀態還原視窗
      if (this.originalMainWindowState) {
        if (this.originalMainWindowState.wasMaximized) {
          this.mainWindow.maximize();
          console.debug("[區域截圖] - 還原最大化狀態");
        } else if (this.originalMainWindowState.wasMinimized) {
          // 如果原本就是最小化，保持最小化
          console.debug("[區域截圖] - 保持最小化狀態");
        } else {
          // 正常狀態，還原顯示
          this.mainWindow.restore();
          console.debug("[區域截圖] - 還原正常狀態");
        }
      } else {
        // 沒有狀態記錄時，預設還原
        this.mainWindow.restore();
      }

      // 同步置頂狀態（強制為 normal 層級，並取消全工作區可見）
      const aot = store.get("alwaysOnTop") === true;
      this.mainWindow.setAlwaysOnTop(aot, 'normal');
      try { this.mainWindow.setVisibleOnAllWorkspaces(false); } catch {}
      console.debug("[區域截圖] - 同步置頂狀態:", aot);

      // 顯示視窗
      this.mainWindow.show();
      console.debug("[區域截圖] 主視窗還原完成");

      // 清理狀態記錄
      this.originalMainWindowBounds = null;
      this.originalMainWindowState = null;
    }
  }
}

// 單一實例：再點一次捷徑不會多開一份（多份並存會互搶全域快捷鍵與常駐覆蓋層），
// 只把已經在跑的那份主視窗叫出來。`--dev` 例外，方便開發版與安裝版並存。
const isDevRun = process.argv.includes("--dev");
const hasInstanceLock = isDevRun || app.requestSingleInstanceLock();

let captureApp = null;
if (!hasInstanceLock) {
  app.quit();
} else {
  // 創建應用實例並初始化
  captureApp = new DukshotApp();
  if (!isDevRun) {
    app.on("second-instance", () => captureApp.focusMainWindow());
  }
  captureApp.initialize().catch(console.error);
}

// 匯出應用實例供測試使用
module.exports = captureApp;