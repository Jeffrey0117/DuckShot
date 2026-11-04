/* ===========================================
   檔案管理器 - 負責圖片檔案的管理和操作
   =========================================== */

class FileManager {
  constructor() {
    this.eventEmitter = Utils.createEventEmitter();
    this.currentFolder = null; // 目前瀏覽資料夾的絕對路徑（由 loadFolder 設定）
    this.files = new Map();
    this.searchQuery = "";
    this.isLoading = false;
    this.lastDirectory = null; // 記錄實際儲存目錄供「開啟資料夾」使用
    this.watchActive = false;     // 主進程 fs.watch 是否生效（生效就不需要保險 refresh）
    this.reloadRequested = false; // 載入中又收到變更 → 這輪載完再跑一次，不丟事件
  }

  async loadFolder(folderName) {
    this.pendingFolder = folderName; // 載入中又被要求（切分頁 / fs.watch）：記最後一個，這輪結束再載它
    if (this.isLoading) {
      this.reloadRequested = true;
      return;
    }
    this.isLoading = true;
    this.currentFolder = folderName;

    try {
      const files = await this.getFilesFromFolder(folderName);
      this.files.clear();
      for (const file of files) this.files.set(file.id, file);
      this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());
    } catch (error) {
      console.error("Failed to load folder:", error);
      this.eventEmitter.emit("loadError", error);
    } finally {
      this.isLoading = false;
      if (this.reloadRequested) {
        this.reloadRequested = false;
        this.loadFolder(this.pendingFolder);
      }
    }
  }

  // 主進程回傳 { id, name, path(實體), size, mtimeMs, type }，id 穩定（檔案沒變就不變），
  // 這裡只補 UI 需要的 file:/// 與資料夾標籤；縮圖交給 ThumbnailLoader 進視口才產。
  async getFilesFromFolder(folderName) {
    const browsePath =
      typeof folderName === "string" && /[\\/]/.test(folderName) ? folderName : undefined;
    const api = window.electronAPI?.files;
    if (!api?.listScreenshots) return Array.from(this.files.values());

    const res = await api.listScreenshots(browsePath);
    if (!res?.success || !Array.isArray(res.files)) {
      console.warn("[FileManager] listScreenshots 失敗，保留現有清單:", res?.error);
      return Array.from(this.files.values());
    }
    this.lastDirectory = res.directory || this.lastDirectory;
    const folderLabel = FileManager.folderLabel(res.directory || folderName);
    return res.files.map((f) => FileManager.toFileEntry(f, folderLabel));
  }

  static folderLabel(dir) {
    const name = String(dir || "").split(/[\\/]/).filter(Boolean).pop() || "";
    return name.toLowerCase() === "desktop" ? "桌面" : name;
  }

  // 實體路徑 → file:///（逐段編碼，磁碟機代號不編碼；中文路徑才能被 <img>/fetch 讀到）
  static toFileUrl(fsPath) {
    if (!fsPath) return "";
    if (fsPath.startsWith("file://")) return fsPath;
    return (
      "file:///" +
      fsPath
        .replace(/\\/g, "/")
        .split("/")
        .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
        .join("/")
    );
  }

  static toFileEntry(f, folderLabel) {
    const fsPath = typeof f.path === "string" ? f.path : "";
    const mtimeMs = Number.isFinite(f.mtimeMs) ? f.mtimeMs : Date.now();
    const iso = new Date(mtimeMs).toISOString();
    return {
      id: f.id || `${fsPath}|${Math.round(mtimeMs)}`,
      name: f.name,
      path: FileManager.toFileUrl(fsPath), // UI / fetch 用
      fsPath,                              // IPC（刪除、搬移）用
      thumbnail: null,
      size: f.size || 0,
      mtimeMs,
      createdAt: iso,
      modifiedAt: iso,
      type: f.type || "image/png",
      folder: folderLabel,
      dimensions: null,
    };
  }

  generatePlaceholderSVG(width, height, text) {
    return `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f0f0f0"/>
        <rect x="10" y="10" width="${width - 20}" height="${
      height - 20
    }" fill="none" stroke="#ddd" stroke-width="2"/>
        <text x="50%" y="50%" text-anchor="middle" dy=".3em" font-family="Arial, sans-serif" font-size="14" fill="#999">
          ${text}
        </text>
      </svg>
    `;
  }

  getFilteredFiles() {
    let files = Array.from(this.files.values());

    if (this.searchQuery) {
      const query = this.searchQuery.toLowerCase();
      files = files.filter((file) => file.name.toLowerCase().includes(query));
    }

    // 以數字 mtime 排序（新到舊），不再每次比較都 parse Date 字串
    files.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0) || a.name.localeCompare(b.name));
    return files;
  }

  search(query) {
    this.searchQuery = query.trim();
    this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());
  }

  refresh() {
    this.loadFolder(this.currentFolder);
  }

  getCurrentFolderPath() {
    // 儲存目錄（來自主進程）優先，其次回退到示意目錄
    if (this.lastDirectory) {
      return this.lastDirectory;
    }
    return `./screenshots/${this.currentFolder}`;
  }

  selectFile(fileId) {
    const file = this.files.get(fileId);
    if (file) {
      this.eventEmitter.emit("fileSelected", file);
    }
  }

  deselectFile(fileId) {
    const file = this.files.get(fileId);
    if (file) {
      this.eventEmitter.emit("fileDeselected", file);
    }
  }

  async deleteFiles(items, options = { toTrash: true }) {
    try {
      if (!Array.isArray(items) || items.length === 0) {
        return { success: true, deleted: [], failed: [], resolvedCount: 0, debugSamplePath: null };
      }

      // 支援傳入「id 字串」或「檔案物件」
      const toFileObject = (it) => {
        if (!it) return null;
        if (typeof it === "string") {
          return this.files.get(it) || null;
        }
        if (typeof it === "object") {
          // 若是直接傳進來的檔案物件，直接回傳；若能在 map 找到同名/同路徑，優先用 map 內的
          if (it.id && this.files.has(it.id)) return this.files.get(it.id);
          // 嘗試以 fsPath 或 name 匹配 map
          for (const f of this.files.values()) {
            if ((it.fsPath && f.fsPath === it.fsPath) || (it.name && f.name === it.name)) {
              return f;
            }
          }
          return it; // 退回使用傳入的物件
        }
        return null;
      };

      // 解析實體檔案路徑（優先 fsPath，否則從 file:/// 轉回；最後用 lastDirectory + name 推導）
      const resolveFsPath = (file) => {
        if (!file) return null;
        if (file.fsPath && typeof file.fsPath === "string") return file.fsPath;

        const p = file.path;
        if (typeof p === "string" && p.length > 0) {
          if (p.startsWith("file:///")) {
            try {
              const withoutScheme = p.replace(/^file:\/\/\//, "");
              const decoded = decodeURIComponent(withoutScheme);
              return decoded.replace(/\//g, "\\"); // Windows
            } catch {}
          }
          if (!p.startsWith("data:")) return p;
        }

        try {
          const base = this.getCurrentFolderPath();
          if (base && file.name) {
            const sep = base.includes("\\") ? "\\" : "/";
            return base.endsWith(sep) ? (base + file.name) : (base + sep + file.name);
          }
        } catch {}

        return null;
      };

      const targetFiles = [];
      const paths = [];

      for (const it of items) {
        const f = toFileObject(it);
        const p = resolveFsPath(f);
        if (f && p) {
          targetFiles.push({ id: f.id, file: f, path: p });
          paths.push(p);
        }
      }

      const resolvedCount = paths.length;
      const debugSamplePath = paths[0] || null;

      if (paths.length === 0) {
        console.warn("[deleteFiles] 無法解析實體路徑，items=", items);
        return {
          success: false,
          deleted: [],
          failed: [{ path: "(unknown)", error: "無法解析實體路徑" }],
          resolvedCount,
          debugSamplePath
        };
      }

      // 透過主進程執行刪除（預設丟到資源回收桶）
      const ipcFiles = window.electronAPI?.files;
      const remover = ipcFiles?.remove || ipcFiles?.delete;
      const res = await (remover
        ? remover(paths, { toTrash: options?.toTrash !== false })
        : Promise.resolve({
            success: false,
            error: "IPC not available",
            deleted: [],
            failed: paths.map(p => ({ path: p, error: "IPC not available" }))
          }));

      const deletedSet = new Set((res?.deleted || []).map(d => d.path));
      const actuallyDeleted = [];
      const failedList = res?.failed || [];

      for (const t of targetFiles) {
        if (deletedSet.has(t.path) || res?.success === true) {
          // 從內部清單移除
          if (t.id && this.files.has(t.id)) {
            this.files.delete(t.id);
          } else {
            // 若沒有 id（例如直接傳物件），以 fsPath 或 name 嘗試刪除
            for (const [id, f] of this.files.entries()) {
              if ((t.file.fsPath && f.fsPath === t.file.fsPath) || f.name === t.file.name) {
                this.files.delete(id);
              }
            }
          }
          actuallyDeleted.push(t.file);
        }
      }

      // 通知 UI
      this.eventEmitter.emit("filesDeleted", actuallyDeleted);
      this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());

      // 主進程 fs.watch 生效時會自己通知；沒生效才補一次 refresh
      if (!this.watchActive) this.refresh();

      try {
        console.log("[deleteFiles] 解析路徑:", resolvedCount, "實際刪除:", actuallyDeleted.length, "失敗:", failedList.length, "樣本路徑:", debugSamplePath);
      } catch {}

      return {
        success: actuallyDeleted.length > 0 && failedList.length === 0,
        deleted: actuallyDeleted,
        failed: failedList,
        resolvedCount,
        debugSamplePath
      };
    } catch (error) {
      console.error("Failed to delete files:", error);
      return {
        success: false,
        deleted: [],
        failed: [{ path: "unknown", error: error?.message || String(error) }],
        resolvedCount: 0,
        debugSamplePath: null
      };
    }
  }

  async renameFile(fileId, newName) {
    try {
      const file = this.files.get(fileId);
      if (!file) {
        throw new Error("File not found");
      }

      // 驗證檔名
      if (!this.validateFileName(newName)) {
        throw new Error("Invalid file name");
      }

      // 實際實作中會重新命名檔案
      const oldName = file.name;
      file.name = newName;
      file.modifiedAt = new Date().toISOString();

      this.eventEmitter.emit("fileRenamed", file, oldName);
      this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());

      return true;
    } catch (error) {
      console.error("Failed to rename file:", error);
      throw error;
    }
  }

  validateFileName(name) {
    // 檢查檔名是否有效
    if (!name || typeof name !== "string") return false;
    if (name.length === 0 || name.length > 255) return false;

    // 檢查非法字元
    const invalidChars = /[<>:"/\\|?*]/;
    if (invalidChars.test(name)) return false;

    // 檢查保留名稱 (Windows)
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    const nameWithoutExtension = name.split(".")[0];
    if (reservedNames.test(nameWithoutExtension)) return false;

    return true;
  }

  async copyFiles(fileIds, targetFolder) {
    try {
      const copiedFiles = [];

      for (const fileId of fileIds) {
        const file = this.files.get(fileId);
        if (file) {
          // 實際實作中會複製檔案
          const copiedFile = {
            ...Utils.deepClone(file),
            id: Utils.generateId(),
            folder: targetFolder,
            name: this.generateCopyName(file.name),
          };

          copiedFiles.push(copiedFile);
        }
      }

      this.eventEmitter.emit("filesCopied", copiedFiles, targetFolder);

      return copiedFiles;
    } catch (error) {
      console.error("Failed to copy files:", error);
      throw error;
    }
  }

  generateCopyName(originalName) {
    const parts = originalName.split(".");
    const extension = parts.pop();
    const baseName = parts.join(".");

    let counter = 1;
    let newName = `${baseName}_副本${extension ? "." + extension : ""}`;

    // 檢查是否已存在相同名稱
    while (this.isFileNameExists(newName)) {
      counter++;
      newName = `${baseName}_副本${counter}${extension ? "." + extension : ""}`;
    }

    return newName;
  }

  isFileNameExists(name) {
    return Array.from(this.files.values()).some((file) => file.name === name);
  }

  async moveFiles(fileIds, targetFolder) {
    try {
      const movedFiles = [];

      for (const fileId of fileIds) {
        const file = this.files.get(fileId);
        if (file) {
          // 實際實作中會移動檔案
          const oldFolder = file.folder;
          file.folder = targetFolder;
          file.modifiedAt = new Date().toISOString();

          movedFiles.push({ file, oldFolder });
        }
      }

      this.eventEmitter.emit("filesMoved", movedFiles, targetFolder);

      // 如果移動的檔案不在當前資料夾，從當前列表中移除
      if (targetFolder !== this.currentFolder) {
        fileIds.forEach((id) => this.files.delete(id));
        this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());
      }

      return movedFiles;
    } catch (error) {
      console.error("Failed to move files:", error);
      throw error;
    }
  }

  async importImages(imageFiles, targetFolder) {
    try {
      const importedFiles = [];

      for (const file of imageFiles) {
        // 驗證檔案類型
        if (!Utils.isImageFile(file.name)) {
          console.warn(`Skipping non-image file: ${file.name}`);
          continue;
        }

        // 實際實作中會複製檔案到目標資料夾
        const importedFile = {
          id: Utils.generateId(),
          name: file.name,
          path: `./screenshots/${targetFolder}/${file.name}`,
          thumbnail: await this.createThumbnail(file),
          size: file.size,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          type: file.type,
          folder: targetFolder,
          dimensions: await Utils.getImageDimensions(file),
        };

        // 檢查檔名衝突
        if (this.isFileNameExists(importedFile.name)) {
          importedFile.name = this.generateCopyName(importedFile.name);
        }

        importedFiles.push(importedFile);

        // 如果是當前資料夾，加入到列表中
        if (targetFolder === this.currentFolder) {
          this.files.set(importedFile.id, importedFile);
        }
      }

      this.eventEmitter.emit("filesImported", importedFiles, targetFolder);

      if (targetFolder === this.currentFolder) {
        this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());
      }

      return importedFiles;
    } catch (error) {
      console.error("Failed to import images:", error);
      throw error;
    }
  }

  async createThumbnail(file, maxWidth = 300, maxHeight = 200) {
    try {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const img = new Image();

      return new Promise((resolve) => {
        img.onload = () => {
          // 計算縮圖尺寸
          let { width, height } = img;
          const ratio = Math.min(maxWidth / width, maxHeight / height);

          width *= ratio;
          height *= ratio;

          canvas.width = width;
          canvas.height = height;

          // 繪製縮圖
          ctx.drawImage(img, 0, 0, width, height);

          // 轉換為 Data URL
          resolve(canvas.toDataURL("image/jpeg", 0.8));
        };

        img.onerror = () => {
          // 如果載入失敗，使用佔位圖
          resolve(this.generatePlaceholderSVG(maxWidth, maxHeight, "圖片"));
        };

        img.src = URL.createObjectURL(file);
      });
    } catch (error) {
      console.error("Failed to create thumbnail:", error);
      return this.generatePlaceholderSVG(maxWidth, maxHeight, "圖片");
    }
  }

  // 主進程存檔後通知：{ path, id, mtimeMs, size, name }（id 與 list-screenshots 一致，
  // 之後 fs.watch 觸發重新列出時卡片不會閃爍）。只有正在看存檔資料夾時才即時插入。
  // 相容舊呼叫 addScreenshot(imageData, filename, folder, filePath)。
  async addScreenshot(entry, legacyName, _legacyFolder, legacyPath) {
    const info =
      entry && typeof entry === "object" ? entry : { path: legacyPath, name: legacyName };
    const fsPath = String(info.path || "");
    if (!fsPath) return null;

    const idx = Math.max(fsPath.lastIndexOf("\\"), fsPath.lastIndexOf("/"));
    const savedDir = idx > 0 ? fsPath.slice(0, idx) : "";
    if (savedDir) this.lastDirectory = savedDir;

    const file = FileManager.toFileEntry(
      {
        id: info.id,
        name: info.name || fsPath.slice(idx + 1),
        path: fsPath,
        size: info.size || 0,
        mtimeMs: info.mtimeMs || Date.now(),
        type: "image/png",
      },
      FileManager.folderLabel(savedDir)
    );

    const normPath = (p) =>
      String(p || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
    const viewingSavedFolder =
      !this.currentFolder ||
      !/[\\/]/.test(String(this.currentFolder)) ||
      normPath(savedDir) === normPath(this.currentFolder);

    if (viewingSavedFolder && !this.files.has(file.id)) {
      this.files.set(file.id, file);
      this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());
    }
    this.eventEmitter.emit("screenshotAdded", file);
    return file;
  }

  estimateImageSize(dataUrl) {
    // 估算 Data URL 的檔案大小
    const base64 = dataUrl.split(",")[1] || "";
    return Math.floor(base64.length * 0.75); // Base64 解碼後大約是原大小的 75%
  }

  extractImageDimensions(dataUrl) {
    // 從 Data URL 提取圖片尺寸 (實際實作中可能需要更複雜的方法)
    return {
      width: 1920,
      height: 1080,
    };
  }

  getFileById(fileId) {
    return this.files.get(fileId);
  }

  getFilesByFolder(folderName) {
    return Array.from(this.files.values()).filter(
      (file) => file.folder === folderName
    );
  }

  getAllFiles() {
    return Array.from(this.files.values());
  }

  getFileCount() {
    return this.files.size;
  }

  getTotalSize() {
    return Array.from(this.files.values()).reduce(
      (total, file) => total + (file.size || 0),
      0
    );
  }

  // 事件監聽
  on(event, callback) {
    this.eventEmitter.on(event, callback);
  }

  off(event, callback) {
    this.eventEmitter.off(event, callback);
  }

  emit(event, ...args) {
    this.eventEmitter.emit(event, ...args);
  }
}

// 全域可用
window.FileManager = FileManager;