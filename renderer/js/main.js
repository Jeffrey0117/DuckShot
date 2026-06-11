/* ===========================================
   主程序 - 應用程序入口點
   =========================================== */

class DukshotApp {
  constructor() {
    this.initialized = false;
    this.currentTheme = "light";
    this.eventEmitter = Utils.createEventEmitter();

    // 組件實例
    this.settings = null;
    this.fileManager = null;
    this.capture = null;
    this.ui = null;

    // 狀態
    this.selectedImages = new Set();
    this.currentFolder = null;   // 目前瀏覽的資料夾「絕對路徑」（分頁）
    this.galleryTabs = [];       // 圖庫分頁：[{ name, path }]
    this.saveDir = "";           // 預設截圖儲存資料夾
    this.isFullscreen = false;
    this.skipNextRefresh = false; // 截圖後避免立即 refresh 把新圖覆蓋掉
    this.lastSelectedIndex = undefined; // 用於 Shift 多選
    this.lastRefreshTime = 0; // 記錄上次刷新時間，避免頻繁刷新
    this.lastFilesLoadTime = 0; // 記錄最後檔案載入通知時間，避免重複通知
    this.pendingThumbnailUpdate = false; // 縮圖批次更新標記
  }

  async init() {
    if (this.initialized) return;

    try {
      console.log("Initializing Dukshot...");

      // 初始化圖示
      this.initIcons();

      // 初始化組件
      await this.initComponents();

      // 設置事件監聽器
      this.setupEventListeners();

      // 載入設定
      await this.loadSettings();

      // 初始化 UI (包含載入檔案)
      await this.initUI();

      // 標記為已初始化
      this.initialized = true;

      console.log("Dukshot initialized successfully");

      // 顯示歡迎通知
      this.ui.showNotification("歡迎使用 Dukshot！", "success");
    } catch (error) {
      console.error("Failed to initialize app:", error);
      this.ui?.showNotification("應用程序初始化失敗", "error");
    }
  }

  initIcons() {
    // 初始化 Lucide 圖示
    if (typeof lucide !== "undefined") {
      lucide.createIcons();
    }
  }

  async initComponents() {
    // 初始化設定管理器
    this.settings = new SettingsManager();

    // 初始化檔案管理器
    this.fileManager = new FileManager();

    // 初始化截圖功能
    this.capture = new CaptureManager();

    // 初始化 UI 管理器
    this.ui = new UIManager();

    // 設置組件間的通訊
    this.setupComponentCommunication();
  }

  setupComponentCommunication() {
    // 檔案管理器事件
    this.fileManager.on("filesLoaded", (files) => {
      this.ui.updateImageGrid(files);
      this.ui.updateStatusBar(files.length, files);
      try {
        console.log("[App] filesLoaded count:", files?.length ?? -1);
        // 只在主要載入時顯示通知，避免批次載入時重複通知
        if (Array.isArray(files) && files.length > 0 && !this.skipNextRefresh) {
          // 防抖：避免短時間內重複顯示（增加到5秒避免重複）
          if (!this.lastFilesLoadTime || Date.now() - this.lastFilesLoadTime > 5000) {
            // 檢查是否還在載入中
            const isStillLoading = window.electronAPI?.on && this.fileManager.thumbnailQueue?.length > 0;
            const message = isStillLoading
              ? `正在載入 ${files.length} 張圖片...`
              : `已載入 ${files.length} 張圖片`;
            this.ui.showNotification(message, "success", 1500);
            this.lastFilesLoadTime = Date.now();
          }
        }
      } catch {}
    });

    this.fileManager.on("fileSelected", (file) => {
      this.selectedImages.add(file.id);
      this.ui.updateSelectionUI(this.selectedImages);
    });

    this.fileManager.on("fileDeselected", (file) => {
      this.selectedImages.delete(file.id);
      this.ui.updateSelectionUI(this.selectedImages);
    });

    // 縮圖載入完成時，局部更新單個縮圖（避免整個網格重新渲染）
    this.fileManager.on("thumbnailLoaded", (file) => {
      // 只更新單個縮圖，不重新渲染整個網格
      const item = document.querySelector(`[data-image-id="${file.id}"]`);
      if (item && file.thumbnail) {
        const img = item.querySelector("img");
        const thumbnail = item.querySelector(".file-thumbnail");
        if (img && thumbnail) {
          img.src = file.thumbnail;
          img.style.display = "block";
          thumbnail.classList.remove("loading");
        }
      }
    });

    // 截圖功能事件
    this.capture.on("captureStarted", () => {
      this.ui.showLoading("準備截圖中...");
    });

    this.capture.on("captureCompleted", async (result) => {
      this.ui.hideLoading();
      if (result.success) {
        try {
          // 若主程序回傳了影像資料，直接加入清單以即時顯示
          if (result.data) {
            const filename = this.capture.generateFilename("png");
            await this.fileManager.addScreenshot(result.data, filename, null, result.path);
            this.ui.showNotification("截圖完成，已加入清單！", "success");
          } else {
            // 沒有影像資料則退而求其次刷新清單（可能使用實體掃描/模擬資料）
            this.ui.showNotification("截圖完成！", "success");
            this.fileManager.refresh();
          }
          // 確保列表立即同步（補一刀刷新）
          setTimeout(() => {
            try { this.fileManager.refresh(); } catch {}
          }, 300);
        } catch (e) {
          console.error("Failed to update UI after capture:", e);
          this.ui.showNotification("截圖完成，但更新清單失敗", "warning");
        }
      } else {
        this.ui.showNotification("截圖失敗", "error");
      }
    });

    this.capture.on("captureCancelled", () => {
      this.ui.hideLoading();
      this.ui.showNotification("截圖已取消", "info");
    });

    // 監聽主程序轉送的截圖完成事件（例如區域截圖從 capture.html 儲存後）
    if (window.electronAPI?.on) {
      window.electronAPI.on("capture-completed", (_event, payload) => {
        try {
          const imageData = payload?.data || payload?.imageData;
          const savedPath = payload?.path;
          if (imageData) {
            // 避免 focus 後 refresh 蓋掉剛新增的截圖
            this.skipNextRefresh = true;
            const filename = this.capture.generateFilename("png");
            // 傳入主行程儲存後的實體路徑，讓檔案物件帶有 fsPath
            this.fileManager.addScreenshot(imageData, filename, null, savedPath);
            this.ui.showNotification("區域截圖完成，已加入清單！", "success");
          } else {
            this.ui.showNotification("區域截圖完成", "success");
          }
          // 保險刷新一次，確保列表立即反映
          setTimeout(() => {
            try { this.fileManager.refresh(); } catch {}
          }, 300);
        } catch (e) {
          console.error("Failed to handle capture-completed event:", e);
          this.ui.showNotification("無法更新清單（區域截圖）", "warning");
        }
      });
    }

    // 重複的事件監聽器已移除，避免通知顯示兩次

    // 設定變更事件
    this.settings.on("themeChanged", (theme) => {
      this.setTheme(theme);
    });

    this.settings.on("settingsChanged", (settings) => {
      this.applySettings(settings);
    });

    // 處理單張圖片的刪除（來自右鍵選單）
    this.ui.on("deleteImage", async (file) => {
      try {
        if (!file?.id) return;
        // 右鍵刪除預設丟到資源回收桶
        const result = await this.fileManager.deleteFiles([file], { toTrash: true });

        // 更新選取狀態
        this.selectedImages.delete(file.id);
        this.ui.updateSelectionUI(this.selectedImages);

        // 顯示結果（加入解析路徑數診斷）
        const ok = result?.deleted?.length || 0;
        const bad = result?.failed?.length || 0;
        const resolved = result?.resolvedCount ?? 0;
        const sample = result?.debugSamplePath;

        if (ok > 0 && bad === 0) {
          this.ui.showNotification(`已刪除 ${file.name}`, "success");
        } else if (ok > 0 && bad > 0) {
          this.ui.showNotification(`成功 ${ok}、失敗 ${bad}，部分檔案無法刪除`, "warning");
        } else {
          const reason = result?.failed?.[0]?.error || `沒有任何檔案被刪除（解析路徑=${resolved}，樣本=${sample || '無'}）`;
          this.ui.showNotification(`刪除失敗：${reason}`, "error");
        }
      } catch (err) {
        console.error("Delete image failed:", err);
        this.ui.showNotification("刪除失敗", "error");
      }
    });
  }

  setupEventListeners() {
    // 工具列按鈕
    this.setupToolbarEvents();

    // 分頁事件
    this.setupTabEvents();

    // 視窗控制事件
    this.setupWindowEvents();

    // 鍵盤快捷鍵
    this.setupKeyboardShortcuts();

    // 拖拽事件
    this.setupDragAndDrop();
  }

  setupToolbarEvents() {
    // 截圖按鈕
    document.getElementById("btn-screenshot")?.addEventListener("click", () => {
      this.capture.startRegionCapture();
    });

    document.getElementById("btn-fullscreen")?.addEventListener("click", () => {
      this.capture.startFullscreenCapture();
    });

    document.getElementById("btn-window")?.addEventListener("click", () => {
      this.capture.startWindowCapture();
    });

    // 檔案操作按鈕
    document
      .getElementById("btn-folder")
      ?.addEventListener("click", async () => {
        const folderPath = this.fileManager.getCurrentFolderPath();
        await electronAPI.files.openFolder(folderPath);
      });

    document.getElementById("btn-refresh")?.addEventListener("click", () => {
      this.fileManager.refresh();
    });

    document.getElementById("btn-delete")?.addEventListener("click", () => {
      this.deleteSelectedFiles({ toTrash: true });
    });

    // 設定按鈕
    document.getElementById("btn-settings")?.addEventListener("click", () => {
      this.openSettings();
    });

    // 主題切換按鈕
    document.getElementById("btn-theme")?.addEventListener("click", () => {
      this.toggleTheme();
    });

    // 置頂按鈕
    document.getElementById("btn-pin")?.addEventListener("click", () => {
      this.toggleAlwaysOnTop();
    });

    // 搜尋功能
    const searchInput = document.getElementById("search-input");
    if (searchInput) {
      const debouncedSearch = Utils.debounce((query) => {
        this.fileManager.search(query);
      }, 300);

      searchInput.addEventListener("input", (e) => {
        debouncedSearch(e.target.value);
      });
    }
  }

  setupTabEvents() {
    const tabsContainer = document.getElementById("tabs-container");
    const addTabButton = document.getElementById("btn-add-tab");

    // 分頁點擊事件
    tabsContainer?.addEventListener("click", (e) => {
      const tab = e.target.closest(".tab");
      const closeButton = e.target.closest(".tab-close");

      if (closeButton && tab) {
        e.stopPropagation();
        this.closeTab(tab.dataset.folder);
      } else if (tab) {
        this.switchTab(tab.dataset.folder);
      }
    });

    // 新增分頁按鈕
    addTabButton?.addEventListener("click", () => {
      this.openAddTabModal();
    });
  }

  setupWindowEvents() {
    // 視窗控制按鈕
    document
      .querySelector(".window-control.minimize")
      ?.addEventListener("click", () => {
        if (window.windowControls) {
          window.windowControls.minimize();
        }
      });

    const maximizeBtn = document.querySelector(".window-control.maximize");
    if (maximizeBtn) {
      maximizeBtn.addEventListener("click", () => {
        if (window.windowControls) {
          window.windowControls.maximize();
        }
      });
      
      // 監聽視窗狀態變化
      if (window.windowControls) {
        window.windowControls.onMaximized(() => {
          maximizeBtn.classList.add('maximized');
          const icon = maximizeBtn.querySelector('[data-lucide]');
          if (icon) {
            icon.setAttribute('data-lucide', 'minimize-2');
            window.lucide.createIcons();
          }
          maximizeBtn.title = '還原';
        });

        window.windowControls.onUnmaximized(() => {
          maximizeBtn.classList.remove('maximized');
          const icon = maximizeBtn.querySelector('[data-lucide]');
          if (icon) {
            icon.setAttribute('data-lucide', 'square');
            window.lucide.createIcons();
          }
          maximizeBtn.title = '最大化';
        });
      }
    }

    document
      .querySelector(".window-control.close")
      ?.addEventListener("click", () => {
        if (window.windowControls) {
          window.windowControls.close();
        }
      });

    // 視窗大小變更事件
    window.addEventListener(
      "resize",
      Utils.debounce(() => {
        this.ui.handleWindowResize();
      }, 100)
    );

    // 視窗焦點事件 - 使用防抖避免頻繁重新載入
    const debouncedRefresh = Utils.debounce(() => {
      // 只在真的需要時才重新載入（例如：截圖後跳過一次）
      if (this.skipNextRefresh) {
        this.skipNextRefresh = false;
        console.log("Skipped refresh after screenshot");
        return;
      }
      // 檢查是否真的需要刷新
      const timeSinceLastRefresh = Date.now() - (this.lastRefreshTime || 0);
      if (timeSinceLastRefresh > 5000) { // 至少間隔5秒
        this.fileManager.refresh();
        this.lastRefreshTime = Date.now();
      }
    }, 1000); // 1秒防抖

    window.addEventListener("focus", debouncedRefresh);
  }

  setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      // Ctrl/Cmd + N - 新增分頁
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        this.openAddTabModal();
      }

      // Ctrl/Cmd + W - 關閉當前分頁
      if ((e.ctrlKey || e.metaKey) && e.key === "w") {
        e.preventDefault();
        this.closeTab(this.currentFolder);
      }

      // 僅 F5 - 重新整理（移除 Ctrl+Shift+R 以避免與全域快捷鍵衝突）
      if (e.key === "F5") {
        e.preventDefault();
        this.fileManager.refresh();
      }

      // Ctrl/Cmd + A - 全選
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        this.selectAllImages();
      }

      // Delete - 刪除選取的檔案（Shift+Delete 永久刪除）
      if (e.key === "Delete" && this.selectedImages.size > 0) {
        e.preventDefault();
        const toTrash = !e.shiftKey; // 按住 Shift 時改為永久刪除
        this.deleteSelectedFiles({ toTrash });
      }

      // Escape - 取消選取
      if (e.key === "Escape") {
        this.clearSelection();
      }

      // F11 - 全螢幕切換
      if (e.key === "F11") {
        e.preventDefault();
        this.toggleFullscreen();
      }
    });
  }

  setupDragAndDrop() {
    const contentArea = document.querySelector(".content-area");
    if (!contentArea) return;

    contentArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      contentArea.classList.add("drag-over");
    });

    contentArea.addEventListener("dragleave", () => {
      contentArea.classList.remove("drag-over");
    });

    contentArea.addEventListener("drop", (e) => {
      e.preventDefault();
      contentArea.classList.remove("drag-over");

      const files = Array.from(e.dataTransfer.files);
      const imageFiles = files.filter((file) => Utils.isImageFile(file.name));

      if (imageFiles.length > 0) {
        this.handleDroppedImages(imageFiles);
      }
    });
  }

  async loadSettings() {
    try {
      const settings = await this.settings.load();
      this.applySettings(settings);
    } catch (error) {
      console.error("Failed to load settings:", error);
    }
  }

  applySettings(settings) {
    // 應用主題
    if (settings.theme) {
      this.setTheme(settings.theme);
    }

    // 其他設定...
  }

  async initUI() {
    // 初始化空狀態
    this.ui.showEmptyState();

    // 載入圖庫分頁（可瀏覽的資料夾）並設定目前分頁
    await this.initGalleryTabs();

    // 載入檔案（讓 FileManager 處理所有邏輯）
    try {
      await this.fileManager.loadFolder(this.currentFolder);
    } catch (error) {
      console.error("Failed to load folder:", error);
      this.ui.showNotification("無法載入檔案", "error");
    }

    // 更新 UI 狀態
    this.updateUIState();
  }

  // 載入並渲染圖庫分頁
  async initGalleryTabs() {
    try {
      const res = await window.electronAPI.files.getGalleryTabs();
      const tabs = (res && res.success && Array.isArray(res.tabs) && res.tabs.length)
        ? res.tabs
        : [{ name: "DuckShot", path: (res && res.defaultPath) || "" }];
      this.galleryTabs = tabs;
      this.saveDir = (res && res.defaultPath) || (tabs[0] && tabs[0].path) || "";
      this.currentFolder = tabs[0]?.path || this.saveDir || "";
      this.renderTabs();
      this.setActiveTabUI(this.currentFolder);
    } catch (e) {
      console.error("載入圖庫分頁失敗:", e);
      this.galleryTabs = [];
      this.currentFolder = "";
    }
  }

  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  renderTabs() {
    const container = document.getElementById("tabs-container");
    if (!container) return;
    container.innerHTML = "";
    this.galleryTabs.forEach((t) => {
      const tab = document.createElement("div");
      tab.className = "tab" + (t.path === this.currentFolder ? " active" : "");
      tab.dataset.folder = t.path;
      tab.title = t.path;
      tab.innerHTML = `
        <i data-lucide="folder" class="icon-sm"></i>
        <span>${this.escapeHtml(t.name)}</span>
        <button class="tab-close" title="關閉分頁">
          <i data-lucide="x" class="icon-xs"></i>
        </button>`;
      container.appendChild(tab);
    });
    if (window.lucide) lucide.createIcons();
  }

  setActiveTabUI(folderPath) {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.folder === folderPath);
    });
  }

  async persistGalleryTabs() {
    try { await window.electronAPI.files.saveGalleryTabs(this.galleryTabs); } catch (e) {}
  }

  setTheme(theme) {
    this.currentTheme = theme;
    document.documentElement.setAttribute("data-theme", theme);

    // 更新主題按鈕圖示
    const themeButton = document.getElementById("btn-theme");
    const icon = themeButton?.querySelector("i");
    if (icon) {
      icon.setAttribute("data-lucide", theme === "light" ? "moon" : "sun");
      lucide.createIcons();
    }
  }

  toggleTheme() {
    const newTheme = this.currentTheme === "light" ? "dark" : "light";
    this.setTheme(newTheme);
    this.settings.update({ theme: newTheme });
  }

  switchTab(folderPath) {
    if (!folderPath) return;
    this.currentFolder = folderPath;
    this.setActiveTabUI(folderPath);

    // 載入該資料夾內容
    this.fileManager.loadFolder(folderPath);

    // 清除選取狀態
    this.clearSelection();
  }

  async closeTab(folderPath) {
    if (this.galleryTabs.length <= 1) {
      this.ui.showNotification("至少需要保留一個分頁", "warning");
      return;
    }
    const idx = this.galleryTabs.findIndex((t) => t.path === folderPath);
    if (idx === -1) return;

    this.galleryTabs.splice(idx, 1);
    await this.persistGalleryTabs();
    this.renderTabs();

    // 如果關閉的是當前分頁，切換到第一個分頁
    if (folderPath === this.currentFolder) {
      this.switchTab(this.galleryTabs[0].path);
    } else {
      this.setActiveTabUI(this.currentFolder);
    }
  }

  // 新增分頁 = 選一個資料夾來瀏覽
  async openAddTabModal() {
    try {
      const res = await window.electronAPI.files.pickDirectory();
      if (!res || !res.success || !res.path) return;
      const path = res.path;

      // 已存在則直接切換
      if (this.galleryTabs.some((t) => t.path === path)) {
        this.switchTab(path);
        return;
      }

      const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
      this.galleryTabs.push({ name, path });
      await this.persistGalleryTabs();
      this.renderTabs();
      this.switchTab(path);
    } catch (e) {
      console.error("新增分頁失敗:", e);
      this.ui.showNotification("新增分頁失敗", "error");
    }
  }

  selectAllImages() {
    const items = document.querySelectorAll(".file-item");
    items.forEach((item) => {
      const imageId = item.dataset.imageId;
      if (imageId) {
        this.selectedImages.add(imageId);
        item.classList.add("selected");
      }
    });
    this.ui.updateSelectionUI(this.selectedImages);
  }

  clearSelection() {
    this.selectedImages.clear();
    document.querySelectorAll(".file-item.selected").forEach((item) => {
      item.classList.remove("selected");
    });
    this.ui.updateSelectionUI(this.selectedImages);
  }

  async deleteSelectedFiles(options = { toTrash: true }) {
    if (this.selectedImages.size === 0) return;

    const isPermanent = options?.toTrash === false;
    const title = isPermanent ? "永久刪除" : "確認刪除";
    const msg = isPermanent
      ? `確定要「永久刪除」${this.selectedImages.size} 個檔案嗎？這將不經資源回收桶，無法復原。`
      : `確定要刪除 ${this.selectedImages.size} 個檔案嗎？`;

    const confirmed = await this.ui.showConfirmDialog(title, msg, isPermanent ? "永久刪除" : "刪除");

    if (!confirmed) return;

    try {
      const result = await this.fileManager.deleteFiles(Array.from(this.selectedImages), options);
      this.clearSelection();

      const ok = result?.deleted?.length || 0;
      const bad = result?.failed?.length || 0;
      const resolved = result?.resolvedCount ?? 0;
      const sample = result?.debugSamplePath;

      if (ok > 0 && bad === 0) {
        this.ui.showNotification(`${ok} 個檔案已${isPermanent ? "永久刪除" : "移至資源回收桶"}`, "success");
      } else if (ok > 0 && bad > 0) {
        this.ui.showNotification(`成功 ${ok}、失敗 ${bad}，部分檔案無法刪除`, "warning");
      } else {
        const reason = result?.failed?.[0]?.error || `沒有任何檔案被刪除（解析路徑=${resolved}，樣本=${sample || '無'}）`;
        this.ui.showNotification(`刪除失敗：${reason}`, "error");
      }
    } catch (error) {
      console.error("Delete failed:", error);
      this.ui.showNotification("刪除失敗", "error");
    }
  }

  async handleDroppedImages(files) {
    try {
      this.ui.showLoading("處理圖片中...");
      await this.fileManager.importImages(files, this.currentFolder);
      this.ui.hideLoading();
      this.ui.showNotification(`成功匯入 ${files.length} 張圖片`, "success");
    } catch (error) {
      this.ui.hideLoading();
      console.error("Import failed:", error);
      this.ui.showNotification("匯入失敗", "error");
    }
  }

  toggleMaximize() {
    // 由主程序處理最大化/還原
  }

  toggleAlwaysOnTop() {
    // 切換置頂狀態
    const pinButton = document.getElementById("btn-pin");
    const isActive = pinButton?.classList.contains("active");

    if (isActive) {
      pinButton.classList.remove("active");
    } else {
      pinButton?.classList.add("active");
    }

    // 通知主程序
    electronAPI.send("toggle-always-on-top", !isActive);
  }

  toggleFullscreen() {
    this.isFullscreen = !this.isFullscreen;
    const body = document.body;
    if (this.isFullscreen) {
      body.classList.add("fullscreen-view");
    } else {
      body.classList.remove("fullscreen-view");
    }
    this.ui?.handleWindowResize?.();
  }

  openSettings() {
    this.settings.openDialog();
  }

  updateUIState() {
    // 更新各種 UI 狀態
    this.ui.updateThemeIcon(this.currentTheme);
    // 其他狀態更新...
  }

  // 公共 API
  getCurrentFolder() {
    return this.currentFolder;
  }

  getSelectedImages() {
    return Array.from(this.selectedImages);
  }

  // 錯誤處理
  handleError(error, context = "") {
    console.error(`Error in ${context}:`, error);
    this.ui?.showNotification(`發生錯誤: ${error.message}`, "error");
  }
}

// 創建應用實例
const app = new DukshotApp();

// 當 DOM 載入完成時初始化應用
document.addEventListener("DOMContentLoaded", () => {
  app.init().catch((error) => {
    console.error("Failed to start app:", error);
    alert("應用程序啟動失敗，請重新啟動。");
  });
});

// 全域錯誤處理
window.addEventListener("error", (event) => {
  app.handleError(event.error, "Global error handler");
});

window.addEventListener("unhandledrejection", (event) => {
  app.handleError(event.reason, "Unhandled promise rejection");
});

// 匯出應用實例供其他模組使用
window.DukshotApp = app;