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

// 修復快取問題：禁用GPU快取以避免建立失敗
app.commandLine.appendSwitch('--disable-gpu-sandbox');
app.commandLine.appendSwitch('--disable-software-rasterizer');
app.commandLine.appendSwitch('--disable-background-timer-throttling');
app.commandLine.appendSwitch('--disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('--disable-renderer-backgrounding');
app.commandLine.appendSwitch('--disable-features', 'VizDisplayCompositor');

// 在應用程式初始化前設定快取路徑至用戶目錄
const userDataPath = path.join(os.homedir(), 'AppData', 'Local', 'Dukshot');
app.setPath('userData', userDataPath);

// 依顯示器 scaleFactor 動態計算最適縮圖尺寸（DPR 感知）
function getOptimalThumbnailSize() {
  try {
    const useHiDpi = typeof store?.get === "function" ? store.get("highDpiCapture") !== false : true;
    const displays = electron.screen.getAllDisplays();
    let maxW = 0, maxH = 0;
    for (const d of displays) {
      const scale = (d.scaleFactor || 1);
      // 直接使用物理像素，確保最高品質
      const w = Math.round(d.size.width  * scale);
      const h = Math.round(d.size.height * scale);
      if (w * h > maxW * maxH) {
        maxW = w;
        maxH = h;
      }
    }
    if (maxW > 0 && maxH > 0) {
      // 確保尺寸不會太小，至少使用實際螢幕解析度
      return { width: Math.max(maxW, 1920), height: Math.max(maxH, 1080) };
    }
  } catch (e) {
    console.warn("getOptimalThumbnailSize error:", e.message);
  }
  // 後備：使用更高的預設值以確保品質
  return { width: 7680, height: 4320 }; // 8K 解析度
}

// 工具函式：用於控制等待時機
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 動態等待時間配置
const COMPOSITOR_WAIT_CONFIG = {
  minWait: 16,     // 最小等待時間 (ms)
  maxWait: 48,     // 最大等待時間 (ms)
  baseWait: 32,    // 基準等待時間 (ms)
  loadThreshold: 0.7, // CPU負載閾值 (0-1)
};

// 系統負載檢測和動態等待時間計算
function getDynamicWaitTime(targetWaitMs = 32) {
  try {
    // 獲取系統負載 (1分鐘平均負載)
    const loadAvg = os.loadavg()[0];
    const numCpus = os.cpus().length;

    // 計算相對負載 (0-1)
    const relativeLoad = Math.min(loadAvg / numCpus, 1);

    console.debug(`[動態等待] 系統負載: ${loadAvg.toFixed(2)}, CPU數: ${numCpus}, 相對負載: ${(relativeLoad * 100).toFixed(1)}%`);

    let waitTime;

    if (relativeLoad > COMPOSITOR_WAIT_CONFIG.loadThreshold) {
      // 高負載時使用較長等待時間
      waitTime = Math.min(targetWaitMs + 8, COMPOSITOR_WAIT_CONFIG.maxWait);
      console.debug(`[動態等待] 高負載模式: ${waitTime}ms`);
    } else if (relativeLoad < 0.3) {
      // 低負載時使用較短等待時間
      waitTime = Math.max(targetWaitMs - 8, COMPOSITOR_WAIT_CONFIG.minWait);
      console.debug(`[動態等待] 低負載模式: ${waitTime}ms`);
    } else {
      // 中等負載使用基準等待時間
      waitTime = targetWaitMs;
      console.debug(`[動態等待] 標準模式: ${waitTime}ms`);
    }

    return Math.round(waitTime);
  } catch (error) {
    console.warn("[動態等待] 負載檢測失敗，使用基準等待時間:", error.message);
    return targetWaitMs;
  }
}

// 優化等待函數 - 整合動態調整和錯誤處理
async function optimizedSleep(targetMs = 32, description = "等待") {
  const dynamicMs = getDynamicWaitTime(targetMs);
  console.debug(`[${description}] ${description} ${dynamicMs}ms (目標: ${targetMs}ms)`);

  try {
    await sleep(dynamicMs);
    console.debug(`[${description}] ${description}完成`);
  } catch (error) {
    console.error(`[${description}] ${description}失敗:`, error);
    // 錯誤時仍嘗試等待基準時間
    try {
      await sleep(targetMs);
    } catch (fallbackError) {
      console.error(`[${description}] 後備等待也失敗:`, fallbackError);
    }
  }
}

// 向下相容的舊常數 (將逐步淘汰)
const COMPOSITOR_WAIT_TIME = 32; // 初始值 32ms，若仍有殘影可調整為 48-64ms
const COMPOSITOR_WAIT_TIME_1 = 32; // 單幀等待時間
const COMPOSITOR_WAIT_TIME_2 = 64; // 雙幀等待時間（更保守）

// 隱藏視窗時的螢幕外座標
const HIDE_OFFSCREEN_POS = { x: -10000, y: -10000 };

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
    this.isDebug = process.argv.includes("--dev");
    this.originalMainWindowBounds = null; // 記錄主視窗原始位置，供還原使用
    this.originalMainWindowState = null; // 記錄主視窗原始狀態
    this.shortcutManager = new ShortcutManager();
    this.tray = null;
    this.isQuitting = false;
  }

  async initialize() {
    // 等待 Electron 準備完成
    await electron.app.whenReady();

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

    // 視窗關閉事件
    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
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
        
        const thumbnailSize = getOptimalThumbnailSize();
        console.log("Using thumbnail size:", thumbnailSize);

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

    // 開始全螢幕截圖
    ipcMain.handle("start-fullscreen-capture", () => {
      return this.startFullScreenCapture();
    });

    // 開始視窗截圖
    ipcMain.handle("start-window-capture", () => {
      return this.startActiveWindowCapture();
    });

    // 繼續截圖：沿用同一個覆蓋層視窗，重新擷取桌面送回去（用於連續截圖）
    ipcMain.handle("continue-region-capture", async () => {
      try {
        const cw = this.captureWindow;
        if (!cw || cw.isDestroyed()) {
          return { success: false, error: "截圖視窗不存在" };
        }
        // 先把覆蓋層藏起來，避免它被擷取進下一張畫面
        cw.hide();
        await optimizedSleep(COMPOSITOR_WAIT_TIME_2, "繼續截圖-合成器等待");

        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: getOptimalThumbnailSize(),
        });
        if (!sources.length) {
          if (!cw.isDestroyed()) cw.show();
          return { success: false, error: "無法獲取螢幕源" };
        }
        const screenData = sources[0].thumbnail.toDataURL();
        if (this.captureWindow && !this.captureWindow.isDestroyed()) {
          this.captureWindow.webContents.send("screen-data", screenData);
          this.captureWindow.setAlwaysOnTop(true, "screen-saver", 1);
          this.captureWindow.show();
          this.captureWindow.focus();
        }
        return { success: true };
      } catch (e) {
        try {
          if (this.captureWindow && !this.captureWindow.isDestroyed()) this.captureWindow.show();
        } catch {}
        return { success: false, error: e.message };
      }
    });

    // 儲存截圖（支援可選 label 以利 A/B 命名）
    ipcMain.handle("save-screenshot", async (event, imageData, format, label) => {
      try {
        console.log("Starting screenshot save process...");

        const fsp = require("fs").promises;
        const pathMod = require("path");

        // 使用預設儲存目錄（可由設定覆蓋，預設為桌面）
        const targetDir = await this.getValidSaveDir();
        await fsp.mkdir(targetDir, { recursive: true }).catch(err => {
          console.warn(`[save-screenshot] 建立目錄失敗，嘗試繼續: ${err.message}`);
        });

        console.log(`Save path: ${targetDir}`);

        // 生成檔案名稱（可選 label）
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        let safeLabel = (typeof label === "string" && label.trim().length > 0) ? label.trim() : "";
        // 基本清理：移除不安全字元
        safeLabel = safeLabel.replace(/[^a-zA-Z0-9._-]+/g, "_");
        const filename = safeLabel ? `Dukshot-${timestamp}-${safeLabel}.${format}` : `Dukshot-${timestamp}.${format}`;
        const filePath = pathMod.join(targetDir, filename);

        console.log(`Full file path: ${filePath}`);

        // 檢查 imageData 格式
        if (!imageData || typeof imageData !== "string") {
          throw new Error("Invalid image data format");
        }

        // 確保 imageData 是正確的 base64 格式
        const base64Data = imageData.includes(",")
          ? imageData.split(",")[1]
          : imageData;

        if (!base64Data) {
          throw new Error("No base64 data found");
        }

        // 儲存檔案
        const buffer = Buffer.from(base64Data, "base64");
        console.log(`Buffer size: ${buffer.length} bytes`);

        await fsp.writeFile(filePath, buffer);

        console.log("Screenshot saved successfully!");

        // 通知主視窗更新清單（特別是區域截圖從 capture.html 呼叫本 IPC 時）
        try {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send("capture-completed", {
              success: true,
              path: filePath,
              data: imageData, // 傳回 base64 以便立即顯示縮圖
              type: "region",
            });
          }
        } catch (notifyError) {
          console.error(
            "Error notifying renderer about capture completion:",
            notifyError
          );
        }

        this.showSortToast(filePath); // fire-and-forget，不阻塞存檔回應
        return { success: true, path: filePath };
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

    // 列出預設截圖資料夾中的圖片（用於前端顯示）- 分批載入版本
    ipcMain.handle("list-screenshots", async (_event, folderPath) => {
      try {
        // 可指定要瀏覽的資料夾（分頁），未指定則用預設儲存資料夾
        const dir = (folderPath && typeof folderPath === "string" && folderPath.trim())
          ? folderPath
          : await this.getValidSaveDir();
        console.log(`[list-screenshots] Target directory: ${dir}`);
        
        // 確保目錄存在
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch (err) {
          console.warn(`[list-screenshots] Failed to create directory: ${err.message}`);
        }

        const fsp = require("fs").promises;
        const pathMod = require("path");
        
        // 檢查目錄是否可讀取
        try {
          await fsp.access(dir, fsp.constants.R_OK);
        } catch (accessError) {
          console.error(`[list-screenshots] Cannot read directory: ${dir}`, accessError);
          // 嘗試返回空結果而非錯誤
          return { success: true, files: [], directory: dir, hasMore: false, totalCount: 0 };
        }
        
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        console.log(`[list-screenshots] Found ${entries.length} items`);

        // 以資料夾名產生顯示用分頁標籤（Desktop → 桌面）
        const dirName = pathMod.basename(dir);
        const folderLabel =
          dirName.toLowerCase() === "desktop" ? "桌面" : dirName;

        // 只取常見圖片副檔名
        const exts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
        
        // 過濾出圖片檔案
        const filteredEntries = entries.filter(entry => {
          if (!entry.isFile()) return false;
          const ext = pathMod.extname(entry.name).toLowerCase();
          return exts.has(ext);
        });

        // 處理所有檔案，不再限制批次大小
        const totalCount = filteredEntries.length;
        console.log(`[list-screenshots] Total ${totalCount} files, loading all at once`);
        
        // 處理所有檔案（一次性載入）
        const allFiles = filteredEntries.map((entry) => {
          const full = pathMod.join(dir, entry.name);
          const ext = pathMod.extname(entry.name).replace(".", "");
          
          return {
            id: `${full}:${Date.now()}`,
            name: entry.name,
            path: full, // 實體路徑，前端會轉 file:///
            thumbnail: null, // 延遲載入
            size: 0, // 跳過檔案大小查詢以加快速度
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
            type: `image/${ext}`,
            folder: folderLabel,
            dimensions: null,
            needsStat: true // 標記需要延後載入 stat
          };
        });

        // 背景載入所有檔案的 stat 資訊（稍後執行以免阻塞）
        if (allFiles.length > 0) {
          setTimeout(async () => {
            for (const file of allFiles) {
              if (file.needsStat) {
                try {
                  const stat = await fsp.stat(file.path);
                  file.size = stat.size;
                  file.modifiedAt = stat.mtime?.toISOString?.() || new Date().toISOString();
                  file.createdAt = stat.birthtime?.toISOString?.() || new Date().toISOString();
                  file.id = `${file.path}:${stat.mtimeMs}`;
                  delete file.needsStat;
                } catch (e) {
                  // 忽略 stat 錯誤
                }
              }
            }
          }, 500);
        }
        
        return {
          success: true,
          files: allFiles,
          directory: dir,
          hasMore: false,
          totalCount: totalCount
        };
      } catch (error) {
        console.error("[list-screenshots] 錯誤:", error);
        console.error("[list-screenshots] 錯誤堆疊:", error.stack);
        return { success: false, error: error.message, files: [] };
      }
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
        console.log("[get-thumbnail] Request for:", filePath, "width:", width);

        if (!filePath || typeof filePath !== "string") {
          console.warn("[get-thumbnail] Invalid filePath:", filePath);
          return null;
        }

        // 檢查檔案是否存在
        let stat;
        try {
          stat = await fs.stat(filePath);
          console.log("[get-thumbnail] File exists, size:", stat.size);
        } catch (statError) {
          console.warn("[get-thumbnail] File not found:", filePath, statError.message);
          return null;
        }

        const key = thumbKey(filePath, stat.mtimeMs, width);

        // 記憶體快取命中
        const cached = thumbCacheGet(key);
        if (cached) {
          console.log("[get-thumbnail] Cache hit for:", filePath);
          return cached;
        }

        // 產生縮圖
        console.log("[get-thumbnail] Generating thumbnail for:", filePath);
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
        console.log("[get-thumbnail] Generated dataUrl length:", dataUrl.length);

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
    // TODO（未來）：將上傳改為「多供應商備援鏈」——依序嘗試多個圖床，
    //   任一家失敗就自動換下一家，避免單一服務中斷時無法取得分享連結。
    //   （截圖本身一律已存本機，故此功能不影響資料安全，只影響分享連結。）
    ipcMain.handle("upload-duk", async (_event, payload) => {
      try {
        const { bytes, filename, contentType, apiKey } = payload || {};
        if (!bytes) {
          return { success: false, error: "缺少圖片位元組" };
        }
        // Node 18+ 原生支援 Blob/FormData/fetch
        const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        const blob = new Blob([buffer], { type: contentType || "image/png" });

        // URUSAI! 圖床 API：multipart/form-data，欄位名為 file，token 選填（無則匿名上傳）
        const form = new FormData();
        form.append("file", blob, filename || "screenshot.png");
        form.append("r18", "0");

        // token 選填（優先序：渲染端傳入 > 環境變數 > 設定檔）；沒有就匿名上傳
        const storedToken =
          (typeof store?.get === "function" &&
            (store.get("urusaiToken") || (store.get("upload") && store.get("upload").urusaiToken))) ||
          null;
        const token =
          (apiKey && typeof apiKey === "string" && apiKey.trim()) ||
          (process.env.URUSAI_TOKEN && String(process.env.URUSAI_TOKEN).trim()) ||
          storedToken ||
          "";
        if (token) form.append("token", token);

        const headers = {
          Accept: "application/json",
          "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36 DuckShot/${app.getVersion?.() || "1.0"}`,
        };

        // 使用 Electron net.fetch（走 Chromium 網路層 + 系統憑證庫），
        // 才能穿過某些環境（防毒／企業代理）的 TLS 攔截，避免 "fetch failed"。
        // 加 60 秒逾時，避免網路異常時無限轉圈。
        let res;
        try {
          res = await net.fetch("https://api.urusai.cc/v1/upload", {
            method: "POST",
            headers,
            body: form,
            signal: AbortSignal.timeout(60000),
          });
        } catch (fe) {
          if (fe && (fe.name === "TimeoutError" || fe.name === "AbortError")) {
            return { success: false, error: "上傳逾時（網路太慢或檔案過大），請再試一次" };
          }
          throw fe;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return { success: false, status: res.status, error: `HTTP ${res.status}`, body: body.slice(0, 500) };
        }

        const json = await res.json().catch(() => ({}));
        const url = json?.data?.url_direct;
        if (json?.status !== "success" || !url) {
          return { success: false, error: json?.message || "上傳失敗（回應格式不符）", raw: json };
        }
        return { success: true, url, deleteUrl: json?.data?.url_delete, raw: json };
      } catch (e) {
        return { success: false, error: e.message };
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

    ipcMain.handle("clipboard-write-image", (_event, dataUrl) => {
      try {
        if (!dataUrl || typeof dataUrl !== "string") {
          return { success: false, error: "缺少影像資料" };
        }
        const img = electron.nativeImage.createFromDataURL(dataUrl);
        if (img.isEmpty()) return { success: false, error: "影像為空" };
        clipboard.writeImage(img);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
  }

  async startRegionCapture() {
    console.log("Starting region capture...");
    console.debug("[區域截圖] 開始執行 startRegionCapture()");

    if (this.captureWindow) {
      return { success: false, error: "截圖視窗已開啟" };
    }

    try {
      // 並行：立刻開始建立並載入截圖覆蓋層（先不顯示），
      // 與下面的隱身等待 + desktopCapturer 擷取同時進行，縮短覆蓋層出現時間。
      this.createCaptureWindow();

      // 只有當主視窗「實際可見」時才需要隱身並等待合成器；
      // 若主視窗已最小化／在托盤（使用者用全域快捷鍵的常見情況），
      // 直接擷取即可，省去隱身與等待 → 截圖介面瞬間出現，且事後不會把視窗彈出來。
      const mw = this.mainWindow;
      const mainVisible = !!(mw && !mw.isDestroyed() && mw.isVisible() && !mw.isMinimized());
      this.didHideMainForCapture = false;

      if (mainVisible) {
        console.debug("[區域截圖] 主視窗可見 - 執行隱身");

        // 記錄主視窗原始狀態（供後續還原）
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

        // 等待合成器更新，確保主視窗完全從桌面消失
        await optimizedSleep(COMPOSITOR_WAIT_TIME_2, "區域截圖-合成器等待");
      } else {
        console.debug("[區域截圖] 主視窗不可見 - 跳過隱身與等待，直接擷取");
      }

      // 步驟 3: 擷取桌面畫面（此時主視窗應已完全消失）
      console.debug("[區域截圖] 步驟4 - 開始擷取桌面畫面");
      const thumbnailSize = getOptimalThumbnailSize();
      console.debug("[區域截圖] 使用擷取尺寸:", thumbnailSize);
      
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: thumbnailSize,
      });

      if (sources.length === 0) {
        throw new Error("無法獲取螢幕源");
      }

      const screenData = sources[0].thumbnail.toDataURL();
      console.debug("[區域截圖] 步驟5 - 桌面畫面擷取完成");

      // 步驟 4: 覆蓋層已並行載入，這裡只需送資料並顯示
      console.debug("[區域截圖] 步驟6 - 顯示截圖視窗");
      await this.showCaptureWindow(screenData);
      console.debug("[區域截圖] 截圖視窗已顯示");

      return {
        success: true,
        message: "區域截圖界面已開啟",
        type: "region",
      };
    } catch (error) {
      console.error("Error starting region capture:", error);
      // 發生錯誤時清掉並行建立中的覆蓋層（其 closed 事件會還原主視窗）
      if (this.captureWindow && !this.captureWindow.isDestroyed()) {
        this.captureWindow.close();
      } else {
        this.restoreMainWindow();
      }
      return { success: false, error: error.message };
    }
  }

  async startFullScreenCapture() {
    console.log("Starting fullscreen capture...");

    try {
      // 獲取主螢幕
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: getOptimalThumbnailSize(),
      });

      if (sources.length === 0) {
        throw new Error("無法找到螢幕源");
      }

      // 使用第一個螢幕源
      const primaryScreen = sources[0];
      
      // 直接使用高解析度縮圖，PNG 格式不需要品質參數
      const imageData = primaryScreen.thumbnail.toDataURL("image/png");

      // 直接保存截圖
      const saveResult = await this.saveScreenshotDirect(imageData, "png");

      console.log("Fullscreen capture completed successfully");
      return {
        success: saveResult.success,
        data: imageData,
        type: "fullscreen",
        source: primaryScreen.name,
        saved: saveResult.success,
        path: saveResult.path,
      };
    } catch (error) {
      console.error("Error in fullscreen capture:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async startActiveWindowCapture() {
    console.log("Starting active window capture...");

    try {
      // 獲取視窗源
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: getOptimalThumbnailSize(),
      });

      if (sources.length === 0) {
        throw new Error("無法找到視窗源");
      }

      // 過濾掉我們自己的應用視窗和系統視窗
      const filteredSources = sources.filter(
        (source) =>
          !source.name.includes("Dukshot") &&
          !source.name.includes("Electron") &&
          !source.name.includes("DevTools") &&
          !source.name.includes("Task Manager") &&
          !source.name.includes("System Settings") &&
          source.name.trim().length > 0 &&
          source.name !== "Desktop" &&
          source.name !== "Screen" &&
          !source.name.includes("Windows PowerShell") &&
          !source.name.includes("Command Prompt")
      );

      if (filteredSources.length === 0) {
        // 如果沒有其他視窗，就用主螢幕
        console.log("No suitable windows found, using screen capture instead");
        return await this.startFullScreenCapture();
      }

      // 使用第一個可用的視窗
      const targetWindow = filteredSources[0];
      const imageData = targetWindow.thumbnail.toDataURL();

      // 直接保存截圖
      const saveResult = await this.saveScreenshotDirect(imageData, "png");

      console.log(`Window capture completed: ${targetWindow.name}`);
      return {
        success: saveResult.success,
        data: imageData,
        type: "window",
        source: targetWindow.name,
        saved: saveResult.success,
        path: saveResult.path,
      };
    } catch (error) {
      console.error("Error in window capture:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // 直接保存截圖的輔助方法
  async saveScreenshotDirect(imageData, format = "png") {
    try {
      console.log("Saving screenshot directly...");

      const targetDir = await this.getValidSaveDir();
      await fs.mkdir(targetDir, { recursive: true }).catch(err => {
        console.warn(`[saveScreenshotDirect] 建立目錄失敗，嘗試繼續: ${err.message}`);
      });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `Dukshot-${timestamp}.${format}`;
      const filePath = path.join(targetDir, filename);

      // 確保 imageData 是正確的 base64 格式
      const base64Data = imageData.includes(",")
        ? imageData.split(",")[1]
        : imageData;

      if (!base64Data) {
        throw new Error("No base64 data found");
      }

      // 儲存檔案
      const buffer = Buffer.from(base64Data, "base64");
      await fs.writeFile(filePath, buffer);

      console.log(`Screenshot saved to: ${filePath}`);
      this.showSortToast(filePath);
      return { success: true, path: filePath };
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
          this.ocrWindowReady = false;
          this.ocrPendingMessages = [];
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
        return;
      }
      this.toastWindowLoaded = false;

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
        this.toastWindowLoaded = false;
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
      }
    } catch (e) {
      console.error("showSortToast failed:", e);
    }
  }

  // 新增：取得有效的儲存目錄（非同步版本）
  async getValidSaveDir() {
    const configured = store.get("saveDirectory");
    if (configured && typeof configured === "string" && configured.trim().length > 0) {
      try {
        await fs.access(configured);
        return configured;
      } catch (e) {
        console.warn(`[getValidSaveDir] Configured path not accessible: ${configured}`);
      }
    }
    
    // 預設使用「圖片」資料夾下的 DuckShot 子目錄
    const homedir = os.homedir();
    let picturesBase = path.join(homedir, "Pictures");

    // Windows 系統特殊處理：用 shell API 取得實際「圖片」路徑（含 OneDrive 重新導向）
    if (process.platform === 'win32') {
      try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);

        const { stdout } = await execPromise('powershell -command "[Environment]::GetFolderPath(\'MyPictures\')"');
        if (stdout && stdout.trim()) {
          picturesBase = stdout.trim();
        }
      } catch (err) {
        console.log('[getValidSaveDir] PowerShell pictures path failed, using default');
      }
    }

    // 候選「圖片」基底路徑（含中文與 OneDrive 版本），存在就用其下的 DuckShot 子目錄
    const baseCandidates = [
      picturesBase,
      path.join(homedir, "Pictures"),
      path.join(homedir, "圖片"), // 中文 Windows 顯示名
      path.join(homedir, "OneDrive", "Pictures"),
      path.join(homedir, "OneDrive", "圖片"),
      path.join(homedir, "Documents"), // 最後備用
    ];

    for (const base of baseCandidates) {
      try {
        await fs.access(base);
        return path.join(base, "DuckShot");
      } catch (err) {
        continue;
      }
    }

    // 都無法存取時，返回預設 圖片/DuckShot（讓系統嘗試建立）
    return path.join(picturesBase, "DuckShot");
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

  createCaptureWindow(screenData = null) {
    console.debug("[區域截圖] createCaptureWindow() 開始執行");
    
    // 建立截圖視窗但先不顯示
    this.captureWindow = new BrowserWindow({
      fullscreen: true,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      show: false, // 先不顯示，等載入完成後再顯示
      resizable: false, // 防止視窗被調整大小
      movable: false, // 防止視窗被移動
      minimizable: false, // 防止最小化
      maximizable: false, // 防止最大化
      closable: true, // 允許關閉
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
      },
      skipTaskbar: true,
      focusable: true, // 確保可以獲得焦點
    });

    console.debug("[區域截圖] 載入 capture.html");
    // 載入截圖界面，並以 promise 記錄「載入完成」時機，
    // 讓 startRegionCapture 能與 desktopCapturer 擷取「並行」進行（加速覆蓋層出現）。
    this.captureWindowReady = new Promise((resolve) => {
      this.captureWindow.webContents.once("did-finish-load", () => {
        console.debug("[區域截圖] capture.html 載入完成");
        resolve();
      });
    });
    this.captureWindow.loadFile(
      path.join(__dirname, "../renderer/capture.html")
    );

    // 截圖視窗關閉事件 - 在此還原主視窗
    this.captureWindow.on("closed", () => {
      console.debug("[區域截圖] 截圖視窗已關閉，開始還原主視窗");
      this.captureWindow = null;
      this.captureWindowReady = null;
      // 完整還原主視窗狀態
      this.restoreMainWindow();
    });

    // 開發模式且設定允許時才開啟開發者工具
    if (this.isDebug && store.get("openDevTools") === true) {
      this.captureWindow.webContents.openDevTools();
    }

    return this.captureWindowReady;
  }

  // 等覆蓋層載入完成後，送入螢幕資料並顯示（與 createCaptureWindow 拆分以支援並行載入）
  async showCaptureWindow(screenData) {
    if (this.captureWindowReady) {
      await this.captureWindowReady;
    }
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    console.debug("[區域截圖] 傳送螢幕資料並顯示覆蓋層");
    if (screenData) {
      this.captureWindow.webContents.send("screen-data", screenData);
    }
    this.captureWindow.setAlwaysOnTop(true, "screen-saver", 1);
    try { this.captureWindow.setVisibleOnAllWorkspaces(true); } catch {}
    this.captureWindow.show();
    this.captureWindow.focus();
    console.debug("[區域截圖] 覆蓋層已顯示並聚焦");
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

// 創建應用實例並初始化
const captureApp = new DukshotApp();
captureApp.initialize().catch(console.error);

// 匯出應用實例供測試使用
module.exports = captureApp;