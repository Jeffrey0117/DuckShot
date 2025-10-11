/* ===========================================
   UI 管理器 - 負責所有 UI 相關的操作
   =========================================== */

class UIManager {
  constructor() {
    this.eventEmitter = Utils.createEventEmitter();
    this.currentModal = null;
    this.notifications = new Set();
    this.isLoading = false;
  }

  // 顯示通知
  showNotification(message, type = "info", duration = 3000) {
    const container = document.getElementById("notification-container");
    if (!container) return;

    const notification = document.createElement("div");
    notification.className = `notification ${type}`;
    notification.innerHTML = `
      <div class="notification-icon">
        <i data-lucide="${this.getNotificationIcon(type)}" class="icon"></i>
      </div>
      <div class="notification-content">
        <div class="notification-message">${message}</div>
      </div>
      <button class="notification-close">
        <i data-lucide="x" class="icon-xs"></i>
      </button>
    `;

    // 關閉按鈕事件
    notification
      .querySelector(".notification-close")
      .addEventListener("click", () => {
        this.removeNotification(notification);
      });

    container.appendChild(notification);
    this.notifications.add(notification);

    // 初始化圖示
    lucide.createIcons();

    // 自動移除
    if (duration > 0) {
      setTimeout(() => {
        this.removeNotification(notification);
      }, duration);
    }

    return notification;
  }

  removeNotification(notification) {
    if (!this.notifications.has(notification)) return;

    notification.classList.add("slide-out-down");
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
      this.notifications.delete(notification);
    }, 200);
  }

  getNotificationIcon(type) {
    const icons = {
      success: "check-circle",
      error: "alert-circle",
      warning: "alert-triangle",
      info: "info",
    };
    return icons[type] || icons.info;
  }

  // 顯示載入指示器（支援自訂圖示）
  showLoading(message = "載入中...", options = {}) {
    if (this.isLoading) return;

    const overlay = document.getElementById("loading-overlay");
    if (!overlay) return;

    // 設定訊息
    const spinner = overlay.querySelector(".loading-spinner");
    const messageEl = spinner?.querySelector("span");
    if (messageEl) {
      messageEl.textContent = message;
    }

    // 如果提供 iconSrc，插入或更新圖示
    if (spinner && options.iconSrc) {
      let logo = spinner.querySelector(".loading-logo");
      if (!logo) {
        logo = document.createElement("img");
        logo.className = "loading-logo";
        spinner.insertBefore(logo, spinner.firstChild);
      }
      logo.src = options.iconSrc;
      logo.alt = "loading";
      logo.style.display = "block";
    }

    overlay.style.display = "flex";
    this.isLoading = true;
  }

  hideLoading() {
    const overlay = document.getElementById("loading-overlay");
    if (overlay) {
      // 清理自訂圖示，恢復預設狀態
      const spinner = overlay.querySelector(".loading-spinner");
      const logo = spinner?.querySelector(".loading-logo");
      if (logo) {
        logo.remove();
      }
      overlay.style.display = "none";
    }
    this.isLoading = false;
  }

  // 創建模態對話框
  createModal(title, content, buttons = []) {
    this.closeModal(); // 先關閉現有的模態

    const overlay = document.getElementById("modal-overlay");
    if (!overlay) return null;

    const modal = document.createElement("div");
    modal.className = "modal animate-scale-in";

    modal.innerHTML = `
      <div class="modal-header">
        <h3 class="modal-title">${title}</h3>
        <button class="modal-close">
          <i data-lucide="x" class="icon-sm"></i>
        </button>
      </div>
      <div class="modal-body">
        ${content}
      </div>
      ${
        buttons.length > 0
          ? `
        <div class="modal-footer">
          ${buttons
            .map(
              (btn) => `
            <button class="btn ${btn.class || "btn-secondary"}" data-action="${
                btn.action || ""
              }">
              ${btn.text}
            </button>
          `
            )
            .join("")}
        </div>
      `
          : ""
      }
    `;

    // 設置事件監聽器
    modal.querySelector(".modal-close").addEventListener("click", () => {
      this.closeModal();
    });

    // 按鈕事件
    modal.querySelectorAll(".modal-footer .btn").forEach((btn, index) => {
      btn.addEventListener("click", () => {
        if (buttons[index] && typeof buttons[index].action === "function") {
          buttons[index].action();
        }
      });
    });

    overlay.appendChild(modal);
    overlay.style.display = "flex";

    // 初始化圖示
    lucide.createIcons();

    // 點擊背景關閉
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        this.closeModal();
      }
    });

    this.currentModal = modal;
    return modal;
  }

  closeModal() {
    const overlay = document.getElementById("modal-overlay");
    if (overlay && this.currentModal) {
      overlay.style.display = "none";
      overlay.innerHTML = "";
      this.currentModal = null;
    }
  }

  // 顯示確認對話框
  showConfirmDialog(title, message, confirmText = "確認", cancelText = "取消") {
    return new Promise((resolve) => {
      this.createModal(title, `<p>${message}</p>`, [
        {
          text: cancelText,
          class: "btn-secondary",
          action: () => {
            this.closeModal();
            resolve(false);
          },
        },
        {
          text: confirmText,
          class: "btn-danger",
          action: () => {
            this.closeModal();
            resolve(true);
          },
        },
      ]);
    });
  }

  // 更新單個縮圖（避免整個網格重新渲染）
  updateSingleThumbnail(file) {
    if (!file || !file.id) return;
    
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
  }

  // 更新圖片網格 - 同步新增與刪除
  updateImageGrid(files) {

    const grid = document.getElementById("image-grid");
    const emptyState = document.getElementById("empty-state");

    if (!grid || !emptyState) return;

    if (files.length === 0) {
      this.showEmptyState();
      return;
    }

    emptyState.style.display = "none";
    
    // 目標清單 ID 集合
    const desiredIds = new Set(files.map(f => f.id));

    // 收集現有的卡片 ID
    const existingCards = new Map();
    grid.querySelectorAll(".file-item").forEach(card => {
      const id = card.dataset.imageId;
      if (id) {
        existingCards.set(id, card);
      }
    });
    
    // 移除已不存在的卡片
    let removedCount = 0;
    existingCards.forEach((card, id) => {
      if (!desiredIds.has(id)) {
        card.remove();
        removedCount++;
      }
    });

    // 使用 DocumentFragment 提高效能
    const fragment = document.createDocumentFragment();
    let newCardsAdded = 0;
    
    // 只添加新的卡片
    files.forEach((file) => {
      if (!existingCards.has(file.id)) {
        const card = this.createImageCard(file);
        fragment.appendChild(card);
        newCardsAdded++;
      }
    });

    // 一次性添加所有新卡片
    if (newCardsAdded > 0) {
      grid.appendChild(fragment);
      
      // 初始化圖示
      lucide.createIcons();
    }

    // 記錄同步結果
    console.log(`[UI] 同步完成：新增 ${newCardsAdded}、移除 ${removedCount}，現在共 ${files.length} 張`);

    // 同步狀態列
    try {
      this.updateStatusBar(files.length, files);
      setTimeout(() => this.updateStatusBar(files.length, files), 150);
    } catch {}
  }

  createImageCard(file) {
    const item = document.createElement("div");
    item.className = "file-item";
    item.dataset.imageId = file.id;

    item.innerHTML = `
      <div class="file-thumbnail${file.thumbnail ? '' : ' loading'}">
        <img src="" alt="${file.name}" loading="lazy" ${file.thumbnail ? '' : 'style="display: none;"'}>
      </div>
      <div class="file-name" title="${file.name}">${this.formatFileName(file.name)}</div>
    `;
    // 正規化圖片來源，確保本機路徑轉為 file:/// 並編碼 - 修正：正確處理中文路徑
    try {
      const raw = file.thumbnail || file.path || "";
      let finalSrc = "";
      
      if (typeof raw === "string" && raw.length > 0) {
        if (raw.startsWith("data:") || raw.startsWith("file://")) {
          // 已經是 data URL 或 file URL，直接使用
          finalSrc = raw;
        } else {
          // 需要轉換為 file:/// URL
          const normalized = raw.replace(/\\/g, "/");
          // 正確編碼每個路徑段
          const segments = normalized.split("/");
          const encoded = segments.map(seg => encodeURIComponent(seg)).join("/");
          finalSrc = "file:///" + encoded;
        }
      }
      
      const imgEl = item.querySelector("img");
      if (imgEl && finalSrc) {
        imgEl.src = finalSrc;
      }
    } catch (err) {
      console.warn("[UI] Failed to set image src:", err, "for file:", file.name);
    }

    // 設置事件監聽器
    this.setupFileItemEvents(item, file);

    // 將檔案資料附加到元素上以便之後存取
    item._fileData = file;

    return item;
  }

  formatFileName(filename) {
    // 從完整路徑提取檔名
    const parts = filename.split(/[/\\]/);
    return parts[parts.length - 1];
  }

  setupFileItemEvents(item, file) {
    // Windows 風格的多選邏輯
    item.addEventListener("click", (e) => {
      this.handleItemSelection(item, file, e);
    });

    // 雙擊開啟圖片
    item.addEventListener("dblclick", () => {
      this.openImageViewer(file);
    });

    // 右鍵選單
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showImageContextMenu(e.clientX, e.clientY, file);
    });

    // 圖片載入完成處理
    const img = item.querySelector("img");
    if (img) {
      img.addEventListener("load", () => {
        const thumbnail = item.querySelector(".file-thumbnail");
        if (thumbnail) {
          thumbnail.classList.remove("loading");
          img.style.display = "block";
        }
      });

      img.addEventListener("error", () => {
        const thumbnail = item.querySelector(".file-thumbnail");
        if (thumbnail) {
          thumbnail.classList.remove("loading");
          thumbnail.innerHTML = `
            <div style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-tertiary);">
              <i data-lucide="image" class="icon"></i>
            </div>
          `;
          lucide.createIcons();
        }
      });
    }
  }

  // Windows 風格的多選處理
  handleItemSelection(item, file, e) {
    const app = window.DukshotApp;
    if (!app) return;

    const isSelected = item.classList.contains("selected");
    const imageId = file.id;

    // Ctrl + 點擊：多選/取消選取
    if (e.ctrlKey || e.metaKey) {
      if (isSelected) {
        item.classList.remove("selected");
        app.selectedImages.delete(imageId);
        this.eventEmitter.emit("imageDeselected", file);
      } else {
        item.classList.add("selected");
        app.selectedImages.add(imageId);
        this.eventEmitter.emit("imageSelected", file);
      }
    }
    // Shift + 點擊：範圍選取
    else if (e.shiftKey && app.lastSelectedIndex !== undefined) {
      const allItems = Array.from(document.querySelectorAll('.file-item'));
      const currentIndex = allItems.indexOf(item);
      const startIndex = Math.min(app.lastSelectedIndex, currentIndex);
      const endIndex = Math.max(app.lastSelectedIndex, currentIndex);

      // 清除現有選取
      document.querySelectorAll('.file-item.selected').forEach(card => {
        card.classList.remove('selected');
      });
      app.selectedImages.clear();

      // 選取範圍內的項目
      for (let i = startIndex; i <= endIndex; i++) {
        const itemToSelect = allItems[i];
        const itemId = itemToSelect.dataset.imageId;
        if (itemId) {
          itemToSelect.classList.add('selected');
          app.selectedImages.add(itemId);
          // 發送選取事件
          const fileData = { id: itemId, ...itemToSelect._fileData };
          this.eventEmitter.emit("imageSelected", fileData);
        }
      }
    }
    // 單純點擊：清除其他選取並選取當前項目
    else {
      // 清除其他選取
      document.querySelectorAll('.file-item.selected').forEach(card => {
        if (card !== item) {
          card.classList.remove('selected');
          const cardId = card.dataset.imageId;
          if (cardId) {
            app.selectedImages.delete(cardId);
            const fileData = { id: cardId, ...card._fileData };
            this.eventEmitter.emit("imageDeselected", fileData);
          }
        }
      });

      // 選取當前項目
      if (!isSelected) {
        item.classList.add("selected");
        app.selectedImages.add(imageId);
        this.eventEmitter.emit("imageSelected", file);
      }

      // 更新最後選取的索引
      const allItems = Array.from(document.querySelectorAll('.file-item'));
      app.lastSelectedIndex = allItems.indexOf(item);
    }

    // 更新選取狀態 UI
    this.updateSelectionUI(app.selectedImages);
  }

  handleImageAction(action, file) {
    switch (action) {
      case "edit":
        this.editImage(file);
        break;
      case "copy":
        this.copyImage(file);
        break;
      case "upload":
        this.uploadImage(file);
        break;
      case "delete":
        this.deleteImage(file);
        break;
    }
  }

  async editImage(file) {
    // 開啟圖片編輯器
    this.showNotification("圖片編輯功能開發中...", "info");
  }

  async copyImage(file) {
    try {
      // 複製圖片到剪貼簿
      await navigator.clipboard.writeText(file.path);
      this.showNotification("已複製圖片路徑", "success");
    } catch (error) {
      this.showNotification("複製失敗", "error");
    }
  }

  async uploadImage(file) {
    try {
      this.showLoading("上傳中...", { iconSrc: "../assets/icons/logo-imgup2.png" });
      // 取得來源（優先使用原圖來源，其次縮圖/路徑）
      let src = "";
      if (typeof file?.path === "string" && file.path.length > 0) {
        src = file.path;
      } else if (typeof file?.thumbnail === "string" && file.thumbnail.length > 0) {
        src = file.thumbnail;
      } else {
        throw new Error("無可用圖片來源");
      }

      // 將來源轉為 Blob（支援 data: 或 file:///）
      const blob = await Utils.imageSourceToBlob(src);

      // 推得檔名
      const filename = this.formatFileName(file?.name || "screenshot.png");

      // 透過主進程代理上傳，避免 CORS/403
      const bytes = await blob.arrayBuffer();
      // 讀取設定中的 API Key（若無則為 undefined）
      let apiKey;
      try {
        const s = await window.electronAPI.settings.get();
        apiKey = s?.dukApiKey || s?.upload?.dukApiKey;
      } catch {}
      const result = await window.electronAPI.uploadToDuk({
        bytes,
        filename,
        contentType: blob.type || "image/png",
        apiKey
      });
      if (!result?.success || !result.url) {
        throw new Error(result?.error || "上傳失敗");
      }

      // 一律使用 duk.tw 完整連結
      const finalUrl = result.url;

      await Utils.copyToClipboard(finalUrl);
      this.showNotification(`已上傳並複製連結：${finalUrl}`, "success", 4000);
    } catch (err) {
      console.error("Upload failed:", err);
      this.showNotification("上傳失敗", "error");
    } finally {
      this.hideLoading();
    }
  }

  async deleteImage(file) {
    const confirmed = await this.showConfirmDialog(
      "確認刪除",
      `確定要刪除 "${file.name}" 嗎？`
    );

    if (confirmed) {
      this.eventEmitter.emit("deleteImage", file);
    }
  }

  openImageViewer(file) {
    // 創建圖片檢視器
    const modal = this.createModal(
      "圖片檢視",
      `
      <div style="text-align: center;">
        <img src="${file.path}" alt="${
        file.name
      }" style="max-width: 100%; max-height: 60vh; object-fit: contain;">
        <div style="margin-top: 1rem; color: var(--text-secondary);">
          <strong>${file.name}</strong><br>
          ${file.size ? Utils.formatFileSize(file.size) : ""} • 
          ${file.createdAt ? Utils.formatDate(file.createdAt) : ""}
        </div>
      </div>
    `,
      [
        {
          text: "關閉",
          class: "btn-secondary",
          action: () => this.closeModal(),
        },
      ]
    );
  }

  showImageContextMenu(x, y, file) {
    const menu = document.createElement("div");
    menu.className = "context-menu animate-scale-in";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    menu.innerHTML = `
      <div class="context-menu-item" data-action="open">
        <i data-lucide="eye" class="icon-sm"></i>
        檢視
      </div>
      <div class="context-menu-item" data-action="edit">
        <i data-lucide="edit" class="icon-sm"></i>
        編輯
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="copy">
        <i data-lucide="copy" class="icon-sm"></i>
        複製
      </div>
      <div class="context-menu-item" data-action="upload">
        <i data-lucide="upload-cloud" class="icon-sm"></i>
        上傳並複製連結
      </div>
      <div class="context-menu-item" data-action="rename">
        <i data-lucide="type" class="icon-sm"></i>
        重新命名
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item danger" data-action="delete">
        <i data-lucide="trash-2" class="icon-sm"></i>
        刪除
      </div>
    `;

    // 事件監聽器
    menu.addEventListener("click", (e) => {
      const item = e.target.closest(".context-menu-item");
      if (item) {
        const action = item.dataset.action;
        this.handleImageAction(action, file);
        this.removeContextMenu(menu);
      }
    });

    document.body.appendChild(menu);
    lucide.createIcons();

    // 點擊其他地方關閉選單
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        this.removeContextMenu(menu);
        document.removeEventListener("click", closeMenu);
      }
    };
    setTimeout(() => document.addEventListener("click", closeMenu), 0);
  }

  removeContextMenu(menu) {
    if (menu.parentNode) {
      menu.parentNode.removeChild(menu);
    }
  }

  // 顯示空狀態
  showEmptyState() {
    const grid = document.getElementById("image-grid");
    const emptyState = document.getElementById("empty-state");

    if (grid) grid.innerHTML = "";
    if (emptyState) emptyState.style.display = "flex";
  }

  // 更新狀態列
  updateStatusBar(fileCount, files) {
    const statusInfo = document.getElementById("status-info");
    const storageInfo = document.getElementById("storage-info");

    if (statusInfo) {
      statusInfo.textContent = `共 ${fileCount} 張圖片`;
    }

    if (storageInfo && files) {
      const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
      storageInfo.textContent = `總大小 ${Utils.formatFileSize(totalSize)}`;
    }
  }

  // 更新選取狀態 UI
  updateSelectionUI(selectedIds) {
    const selectionInfo = document.getElementById("selection-info");
    if (selectionInfo) {
      if (selectedIds.size > 0) {
        selectionInfo.textContent = `已選擇 ${selectedIds.size} 張`;
      } else {
        selectionInfo.textContent = "";
      }
    }

    // 更新工具列按鈕狀態
    const deleteButton = document.getElementById("btn-delete");
    if (deleteButton) {
      deleteButton.disabled = selectedIds.size === 0;
    }
  }

  // 處理視窗大小變更
  handleWindowResize() {
    // 如果有模態對話框，調整位置
    if (this.currentModal) {
      // 確保模態對話框在視窗中央
    }

    // 重新計算圖片網格布局
    this.eventEmitter.emit("windowResized");
  }

  // 更新主題圖示
  updateThemeIcon(theme) {
    const themeButton = document.getElementById("btn-theme");
    if (themeButton) {
      const icon = themeButton.querySelector("i");
      if (icon) {
        icon.setAttribute("data-lucide", theme === "light" ? "moon" : "sun");
        lucide.createIcons();
      }
    }
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
window.UIManager = UIManager;
