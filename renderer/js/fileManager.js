/* ===========================================
   檔案管理器 - 負責圖片檔案的管理和操作
   =========================================== */

class FileManager {
  constructor() {
    this.eventEmitter = Utils.createEventEmitter();
    this.currentFolder = "今日";
    this.files = new Map();
    this.searchQuery = "";
    this.isLoading = false;
    this.lastDirectory = null; // 記錄實際儲存目錄供「開啟資料夾」使用
    this.thumbnailQueue = []; // 縮圖載入隊列
    this.isProcessingThumbnails = false;
  }

  // 新增：分批載入剩餘檔案
  async loadRemainingBatches(batches, folderLabel) {
    for (const batch of batches) {
      const batchFiles = batch.map((f) => {
        const fileUrl =
          typeof f.path === "string"
            ? (f.path.startsWith("file://")
                ? f.path
                : "file:///" + f.path.replace(/\\/g, "/"))
            : "";

        return {
          id: f.id || Utils.generateId(),
          name: f.name,
          path: fileUrl || f.path || "",
          thumbnail: f.thumbnail || fileUrl,
          size: f.size || 0,
          createdAt: f.createdAt || new Date().toISOString(),
          modifiedAt: f.modifiedAt || new Date().toISOString(),
          type: f.type || "image/png",
          folder: folderLabel,
          dimensions: f.dimensions || { width: 0, height: 0 },
          needsThumbnail: !f.thumbnail
        };
      });

      // 添加到檔案列表
      batchFiles.forEach(file => {
        this.files.set(file.id, file);
      });

      // 通知 UI 更新
      this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());
      
      // 給 UI 時間更新
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  // 新增：延遲載入縮圖（限制並行度 + 使用 fsPath，降低阻塞）
  async loadThumbnailsLazy(maxConcurrency = 3, thumbWidth = 150) {
    if (this.isProcessingThumbnails) return;
    this.isProcessingThumbnails = true;

    const initialQueueSize = this.thumbnailQueue.length;
    console.log(`[縮圖載入] 開始處理 ${initialQueueSize} 個縮圖`);

    const worker = async () => {
      while (true) {
        const fileId = this.thumbnailQueue.shift();
        if (!fileId) break;

        const file = this.files.get(fileId);
        if (!file || !file.needsThumbnail) continue;

        if (window.electronAPI?.files?.getThumbnail) {
          try {
            // 優先使用真實檔案系統路徑（fsPath），避免傳入 file:/// 導致 nativeImage 失敗
            let fsPath = file.fsPath;
            if (!fsPath && typeof file.path === "string") {
              // 從 file:/// 轉回系統路徑 - 修正：正確解碼中文路徑
              const withoutScheme = file.path.replace(/^file:\/\/\//, "");
              // 先解碼URI編碼的路徑
              const decoded = decodeURIComponent(withoutScheme);
              // Windows系統需要將正斜線轉回反斜線
              fsPath = decoded.replace(/\//g, "\\");
            }
            if (fsPath) {
              const thumbnail = await window.electronAPI.files.getThumbnail(fsPath, thumbWidth);
              if (thumbnail) {
                file.thumbnail = thumbnail;
                file.needsThumbnail = false;
                // 通知 UI 更新單個檔案
                this.eventEmitter.emit("thumbnailLoaded", file);
              }
            }
          } catch (error) {
            // 靜默失敗，避免過多console輸出
            file.needsThumbnail = false; // 避免重試
          }
        }
      }
    };

    // 使用固定高並行度，確保快速處理
    const n = Math.min(maxConcurrency, 10);
    const tasks = Array.from({ length: n }, () => worker());
    await Promise.all(tasks);

    this.isProcessingThumbnails = false;
    
    // 如果還有剩餘的縮圖需要載入，立即繼續
    if (this.thumbnailQueue.length > 0) {
      console.log(`[縮圖載入] 繼續處理剩餘 ${this.thumbnailQueue.length} 個縮圖`);
      // 立即繼續，不延遲
      setImmediate(() => {
        this.loadThumbnailsLazy(maxConcurrency, thumbWidth);
      });
    } else {
      console.log(`[縮圖載入] 全部完成`);
    }
  }

  async loadFolder(folderName) {
    if (this.isLoading) return;

    this.isLoading = true;
    this.currentFolder = folderName;

    try {
      // 從檔案系統讀取
      const files = await this.getFilesFromFolder(folderName);

      this.files.clear();
      files.forEach((file) => {
        this.files.set(file.id, file);
      });

      // 診斷：記錄載入的檔案數量與目前分頁
      console.log("[FileManager] files loaded:", {
        folder: this.currentFolder,
        count: this.files.size
      });

      // 觸發事件給外部
      this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());

      // 啟動縮圖載入 - 使用 getFilteredFiles() 來保持與 UI 顯示順序一致
      try {
        this.thumbnailQueue = [];
        
        // 使用 getFilteredFiles() 來獲取已排序的檔案（與 UI 顯示順序一致）
        const files = this.getFilteredFiles();
        
        // 按照顯示順序加入隊列
        files.forEach((f) => {
          if (!f.thumbnail && f.path && f.fsPath) {
            f.needsThumbnail = true;
            this.thumbnailQueue.push(f.id);
          }
        });
        
        console.log(`[縮圖隊列] 準備載入 ${this.thumbnailQueue.length} 個縮圖（按顯示順序）`);
        
        if (this.thumbnailQueue.length > 0) {
          // 立即啟動高並行載入
          setImmediate(() => {
            this.loadThumbnailsLazy(10, 150);
          });
        }
      } catch (e) {
        console.warn("thumbnail preload queue failed:", e);
      }
    } catch (error) {
      console.error("Failed to load folder:", error);
      this.eventEmitter.emit("loadError", error);
    } finally {
      this.isLoading = false;
    }
  }

  async getFilesFromFolder(folderName) {
    // 優先從主進程列出真實截圖檔案
    try {
      if (window?.electronAPI?.files?.listScreenshots) {
        const res = await window.electronAPI.files.listScreenshots();
        if (res?.success && Array.isArray(res.files)) {
          // 記錄實際儲存目錄供「開啟資料夾」使用
          this.lastDirectory = res.directory || this.lastDirectory;

          // 推導分頁顯示名稱：Desktop -> 桌面，否則使用資料夾名稱或傳入的 folderName
          const dirName = (res.directory || "").split(/[\\/]/).pop() || "";
          const folderLabel =
            dirName.toLowerCase() === "desktop" ? "桌面" : (dirName || folderName);

          // 極速載入：立即返回初始批次（防止重複通知）
          if (!window.DukshotApp?.lastFilesLoadTime ||
              Date.now() - window.DukshotApp.lastFilesLoadTime > 5000) {
            console.log(`快速載入前 ${res.files.length} 個檔案，總共 ${res.totalCount || res.files.length} 個`);
          }
          
          // 對齊系統內部檔案結構，讓 UI 可以直接顯示
          // 診斷：列出主程序回傳的檔案數與目錄
          try {
            console.log("[FileManager] listScreenshots result:", {
              success: res?.success,
              received: Array.isArray(res.files) ? res.files.length : 0,
              directory: res.directory,
              hasMore: res.hasMore,
              totalCount: res.totalCount
            });
          } catch {}

          const realFiles = res.files.map((f) => {
            // 真實檔案系統路徑（供縮圖 IPC 使用）
            const fsPath = typeof f.path === "string" ? f.path : "";
            // UI 顯示使用 file:/// URL - 修正：正確處理中文路徑
            let fileUrl = "";
            if (typeof fsPath === "string" && fsPath.length > 0) {
              if (fsPath.startsWith("file://")) {
                fileUrl = fsPath;
              } else {
                // 將反斜線轉為正斜線
                const normalized = fsPath.replace(/\\/g, "/");
                // 只編碼需要編碼的字符，保留路徑分隔符
                const segments = normalized.split("/");
                const encoded = segments.map(segment => {
                  // 如果是磁碟機代號（如 C:），不編碼
                  if (segment.match(/^[A-Za-z]:$/)) {
                    return segment;
                  }
                  // 對每個路徑段進行 URI 編碼，但保留已編碼的字符
                  return encodeURIComponent(decodeURIComponent(segment));
                }).join("/");
                fileUrl = "file:///" + encoded;
              }
            }

            return {
              id: f.id || Utils.generateId(),
              name: f.name,
              // 保存兩種路徑：UI 用 path（file:///），IPC 用 fsPath（實體路徑）
              path: fileUrl || fsPath || "",
              fsPath: fsPath || "",
              thumbnail: f.thumbnail || fileUrl,
              size: f.size || 0,
              createdAt: f.createdAt || new Date().toISOString(),
              modifiedAt: f.modifiedAt || new Date().toISOString(),
              type: f.type || "image/png",
              folder: folderLabel,
              dimensions: f.dimensions || { width: 0, height: 0 },
            };
          });

          // 如果有更多檔案，監聽批次載入
          if (res.hasMore && window.electronAPI?.on) {
            // 移除舊的監聽器避免重複
            window.electronAPI.off?.("batch-files-loaded");
            
            // 監聽批次載入的檔案
            window.electronAPI.on("batch-files-loaded", (_event, payload) => {
              if (payload?.files && Array.isArray(payload.files)) {
                console.log(`[批次 ${payload.batchNumber}] 載入 ${payload.files.length} 個檔案`);
                
                // 處理批次載入的檔案
                const batchFiles = [];
                payload.files.forEach(f => {
                  const fsPath = typeof f.path === "string" ? f.path : "";
                  // 修正：正確處理中文路徑編碼
                  let fileUrl = "";
                  if (fsPath) {
                    const normalized = fsPath.replace(/\\/g, "/");
                    const segments = normalized.split("/");
                    const encoded = segments.map(segment => {
                      if (segment.match(/^[A-Za-z]:$/)) {
                        return segment;
                      }
                      return encodeURIComponent(decodeURIComponent(segment));
                    }).join("/");
                    fileUrl = "file:///" + encoded;
                  }
                    
                  const file = {
                    id: f.id || Utils.generateId(),
                    name: f.name,
                    path: fileUrl || fsPath || "",
                    fsPath: fsPath || "",
                    thumbnail: f.thumbnail || null,
                    size: f.size || 0,
                    createdAt: f.createdAt || new Date().toISOString(),
                    modifiedAt: f.modifiedAt || new Date().toISOString(),
                    type: f.type || "image/png",
                    folder: folderLabel,
                    dimensions: f.dimensions || { width: 0, height: 0 },
                    needsThumbnail: !f.thumbnail
                  };
                  
                  // 加入到檔案列表
                  this.files.set(file.id, file);
                  // 排入縮圖隊列
                  if (file.needsThumbnail) {
                    this.thumbnailQueue.push(file.id);
                  }
                  batchFiles.push(file);
                });
                
                // 通知 UI 更新
                this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());
                
                // 批次載入縮圖（提高並行度）
                if (this.thumbnailQueue.length > 0 && !this.isProcessingThumbnails) {
                  // 依批次調整並行度
                  const concurrency = payload.batchNumber === 2 ? 5 : 3;
                  this.loadThumbnailsLazy(concurrency, 150);
                }
                
                // 顯示載入進度（非最後一批才顯示）
                if (payload.hasMore) {
                  const totalLoaded = this.files.size;
                  console.log(`[批次載入] 已載入 ${totalLoaded} 個檔案，還有更多...`);
                } else {
                  console.log(`[批次載入] 全部載入完成，共 ${this.files.size} 個檔案`);
                }
              }
            });
          }

          return realFiles;
        }
      }
    } catch (e) {
      console.warn("listScreenshots failed, fallback to mock:", e);
    }

    // Fallback：停用模擬資料，但避免清空已載入內容 → 回傳現有清單
    console.warn("[FileManager] listScreenshots 不可用或失敗，保留現有清單（停用 mock）");
    return Array.from(this.files.values());
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

    // 搜尋過濾
    if (this.searchQuery) {
      const query = this.searchQuery.toLowerCase();
      files = files.filter((file) => file.name.toLowerCase().includes(query));
    }

    // 排序 (按建立時間倒序)
    files.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

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

      // 保險刷新一次（避免快取與實體不同步）
      setTimeout(() => {
        try { this.refresh(); } catch {}
      }, 150);

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

  async addScreenshot(imageData, filename, folder = null, filePath = null) {
    try {
      const targetFolder = folder || this.currentFolder;

      // 決定顯示與路徑
      // - 優先使用主程序回傳的實際檔案路徑（轉為 file:/// URL 供 <img> 使用）
      // - 若沒有檔案路徑，則使用 DataURL 立即顯示
      let resolvedPath = filePath || `./screenshots/${targetFolder}/${filename}`;
      let displaySrc = imageData;

      if (!displaySrc && resolvedPath) {
        const isFileUrl =
          typeof resolvedPath === "string" && resolvedPath.startsWith("file://");
        displaySrc = isFileUrl
          ? resolvedPath
          : encodeURI("file:///" + String(resolvedPath).replace(/\\/g, "/"));
      }

      // 若拿到主行程的實體路徑，更新 lastDirectory 以支援後續「開啟資料夾」與刪除解析
      try {
        const rawPath = String(filePath || resolvedPath);
        const idx = Math.max(rawPath.lastIndexOf("\\"), rawPath.lastIndexOf("/"));
        if (idx > 0) {
          this.lastDirectory = rawPath.slice(0, idx);
        }
      } catch {}

      const file = {
        id: Utils.generateId(),
        name: filename,
        // UI 用 file:///，縮圖/刪除 IPC 用 fsPath
        path: displaySrc || encodeURI("file:///" + String(resolvedPath).replace(/\\/g, "/")),
        fsPath: String(filePath || resolvedPath),
        thumbnail: displaySrc, // 讓 <img> 可以立即顯示（DataURL 或 file:///）
        size: imageData ? this.estimateImageSize(imageData) : 0,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        type: "image/png",
        folder: targetFolder,
        dimensions: this.extractImageDimensions(imageData),
      };

      if (targetFolder === this.currentFolder) {
        this.files.set(file.id, file);
        this.eventEmitter.emit("filesLoaded", this.getFilteredFiles());
      }

      this.eventEmitter.emit("screenshotAdded", file);

      return file;
    } catch (error) {
      console.error("Failed to add screenshot:", error);
      throw error;
    }
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