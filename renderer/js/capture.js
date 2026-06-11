/* ===========================================
   截圖管理器 - 負責所有截圖相關的功能
   =========================================== */

class CaptureManager {
  constructor() {
    this.eventEmitter = Utils.createEventEmitter();
    this.isCapturing = false;
    this.captureWindow = null;
    this.settings = null;
  }

  async startRegionCapture() {
    if (this.isCapturing) return;

    try {
      this.isCapturing = true;
      this.eventEmitter.emit("captureStarted", "region");

      // 調用主程序的截圖功能
      const result = await electronAPI.capture.startRegionCapture();

      if (result.success) {
        this.eventEmitter.emit("captureCompleted", {
          success: true,
          type: "region",
          data: result.data,
        });
      } else {
        throw new Error(result.error || "區域截圖失敗");
      }
    } catch (error) {
      console.error("Region capture failed:", error);
      this.eventEmitter.emit("captureCompleted", {
        success: false,
        error: error.message,
      });
    } finally {
      this.isCapturing = false;
    }
  }

  async startFullscreenCapture() {
    if (this.isCapturing) return;

    try {
      this.isCapturing = true;
      this.eventEmitter.emit("captureStarted", "fullscreen");

      // 調用主程序的全螢幕截圖功能
      const result = await electronAPI.capture.startFullscreenCapture();

      if (result.success) {
        this.eventEmitter.emit("captureCompleted", {
          success: true,
          type: "fullscreen",
          data: result.data,
        });
      } else {
        throw new Error(result.error || "全螢幕截圖失敗");
      }
    } catch (error) {
      console.error("Fullscreen capture failed:", error);
      this.eventEmitter.emit("captureCompleted", {
        success: false,
        error: error.message,
      });
    } finally {
      this.isCapturing = false;
    }
  }

  async startWindowCapture() {
    if (this.isCapturing) return;

    try {
      this.isCapturing = true;
      this.eventEmitter.emit("captureStarted", "window");

      // 調用主程序的視窗截圖功能
      const result = await electronAPI.capture.startWindowCapture();

      if (result.success) {
        this.eventEmitter.emit("captureCompleted", {
          success: true,
          type: "window",
          data: result.data,
          source: result.source,
        });
      } else {
        throw new Error(result.error || "視窗截圖失敗");
      }
    } catch (error) {
      console.error("Window capture failed:", error);
      this.eventEmitter.emit("captureCompleted", {
        success: false,
        error: error.message,
      });
    } finally {
      this.isCapturing = false;
    }
  }

  generateMockCapture(label) {
    // 生成模擬的截圖資料
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;

    const ctx = canvas.getContext("2d");

    // 繪製漸層背景
    const gradient = ctx.createLinearGradient(
      0,
      0,
      canvas.width,
      canvas.height
    );
    gradient.addColorStop(0, "#4A90E2");
    gradient.addColorStop(1, "#6BA3E8");

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 繪製文字
    ctx.fillStyle = "white";
    ctx.font = "bold 48px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, canvas.width / 2, canvas.height / 2);

    // 繪製時間戳
    ctx.font = "24px Arial";
    const timestamp = new Date().toLocaleString("zh-TW");
    ctx.fillText(timestamp, canvas.width / 2, canvas.height / 2 + 60);

    return canvas.toDataURL("image/png");
  }

  async saveCapture(imageData, format = "png", customPath = null) {
    try {
      const filename = this.generateFilename(format);

      let result;
      if (customPath) {
        // 儲存到自訂路徑
        result = await electronAPI.capture.saveScreenshot(
          imageData,
          format,
          customPath
        );
      } else {
        // 儲存到預設路徑並加入檔案管理器
        result = await electronAPI.capture.saveScreenshot(imageData, format);

        if (result.success) {
          // 通知檔案管理器有新檔案
          const fileManager = window.DukshotApp?.fileManager;
          if (fileManager) {
            await fileManager.addScreenshot(imageData, filename);
          }
        }
      }

      // 自動複製到剪貼簿 (如果啟用)
      const settings = window.DukshotApp?.settings;
      if (settings?.get("autoSaveToClipboard")) {
        await this.copyToClipboard(imageData);
      }

      this.eventEmitter.emit("captureSaved", {
        success: result.success,
        path: result.path,
        filename: filename,
      });

      return result;
    } catch (error) {
      console.error("Failed to save capture:", error);
      throw error;
    }
  }

  async copyToClipboard(imageData) {
    try {
      // 優先用主進程剪貼簿寫入影像（不需視窗焦點）
      if (window.electronAPI?.clipboard?.writeImage) {
        const r = await window.electronAPI.clipboard.writeImage(imageData);
        if (r?.success) return true;
      }

      // 降級：瀏覽器剪貼簿
      const response = await fetch(imageData);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type]: blob,
        }),
      ]);

      return true;
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
      return false;
    }
  }

  generateFilename(format = "png") {
    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\..+/, "")
      .replace("T", "_");

    return `截圖_${timestamp}.${format}`;
  }

  cancelCapture() {
    if (!this.isCapturing) return;

    this.isCapturing = false;
    this.eventEmitter.emit("captureCancelled");
  }

  // 設定相關方法
  updateSettings(settings) {
    this.settings = settings;

    // 根據設定更新行為
    if (settings) {
      // 更新快捷鍵
      this.updateShortcuts(settings.shortcuts);

      // 更新預設格式
      this.defaultFormat = settings.defaultImageFormat || "png";

      // 更新品質設定
      this.imageQuality = settings.imageQuality || 90;
    }
  }

  updateShortcuts(shortcuts) {
    // 實際實作中會更新全域快捷鍵
    console.log("Updating shortcuts:", shortcuts);
  }

  // 獲取螢幕資訊
  async getScreenInfo() {
    try {
      const sources = await electronAPI.capture.getDesktopSources();
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail,
      }));
    } catch (error) {
      console.error("Failed to get screen info:", error);
      return [];
    }
  }

  // 圖片處理方法 - 優化版本，使用 requestAnimationFrame 確保在適當時機處理
  async processImage(imageData, options = {}) {
    try {
      const {
        format = "png",
        quality = 90,
        resize = null,
        watermark = null,
      } = options;

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const img = new Image();

      return new Promise((resolve, reject) => {
        img.onload = () => {
          // 使用 requestAnimationFrame 確保在下一幀處理，優化時機
          requestAnimationFrame(() => {
            try {
              let { width, height } = img;

              // 調整尺寸
              if (resize) {
                if (resize.width && resize.height) {
                  width = resize.width;
                  height = resize.height;
                } else if (resize.scale) {
                  width *= resize.scale;
                  height *= resize.scale;
                }
              }

              canvas.width = width;
              canvas.height = height;

              // 繪製圖片
              ctx.drawImage(img, 0, 0, width, height);

              // 添加浮水印
              if (watermark) {
                this.addWatermark(ctx, width, height, watermark);
              }

              // 轉換格式
              const outputFormat =
                format === "jpg" ? "image/jpeg" : `image/${format}`;
              const outputQuality = format === "png" ? undefined : quality / 100;

              // 再次使用 requestAnimationFrame 確保輸出在適當時機
              requestAnimationFrame(() => {
                try {
                  const result = canvas.toDataURL(outputFormat, outputQuality);
                  resolve(result);
                } catch (error) {
                  reject(error);
                }
              });
            } catch (error) {
              reject(error);
            }
          });
        };

        img.onerror = (error) => {
          console.error("圖片載入失敗:", error);
          reject(new Error("圖片載入失敗"));
        };
        img.src = imageData;
      });
    } catch (error) {
      console.error("Failed to process image:", error);
      throw error;
    }
  }

  addWatermark(ctx, width, height, watermark) {
    const {
      text = "Dukshot",
      position = "bottom-right",
      opacity = 0.5,
      fontSize = 16,
      color = "#ffffff",
    } = watermark;

    ctx.save();

    // 設定樣式
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.font = `${fontSize}px Arial`;
    ctx.textBaseline = "bottom";

    // 計算位置
    const padding = 20;
    let x, y;

    switch (position) {
      case "top-left":
        x = padding;
        y = fontSize + padding;
        ctx.textAlign = "left";
        break;
      case "top-right":
        x = width - padding;
        y = fontSize + padding;
        ctx.textAlign = "right";
        break;
      case "bottom-left":
        x = padding;
        y = height - padding;
        ctx.textAlign = "left";
        break;
      case "bottom-right":
      default:
        x = width - padding;
        y = height - padding;
        ctx.textAlign = "right";
        break;
    }

    // 繪製文字背景
    const textMetrics = ctx.measureText(text);
    const textWidth = textMetrics.width;
    const textHeight = fontSize;

    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.fillRect(
      x - (ctx.textAlign === "right" ? textWidth + 10 : -5),
      y - textHeight - 5,
      textWidth + 10,
      textHeight + 10
    );

    // 繪製文字
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);

    ctx.restore();
  }

  // 批次截圖功能
  async startBatchCapture(options = {}) {
    const { count = 5, interval = 1000, type = "fullscreen" } = options;

    const results = [];

    for (let i = 0; i < count; i++) {
      try {
        if (i > 0) {
          await Utils.delay(interval);
        }

        let result;
        switch (type) {
          case "fullscreen":
            result = await this.startFullscreenCapture();
            break;
          case "window":
            result = await this.startWindowCapture();
            break;
          default:
            throw new Error("Unsupported batch capture type");
        }

        results.push(result);

        this.eventEmitter.emit("batchProgress", {
          current: i + 1,
          total: count,
          result: result,
        });
      } catch (error) {
        console.error(`Batch capture ${i + 1} failed:`, error);
        results.push({ success: false, error: error.message });
      }
    }

    this.eventEmitter.emit("batchCompleted", results);
    return results;
  }

  // 定時截圖功能
  startTimedCapture(options = {}) {
    const {
      interval = 5000, // 5秒間隔
      maxCount = null,
      type = "fullscreen",
    } = options;

    let count = 0;
    const timer = setInterval(async () => {
      try {
        count++;

        // 檢查最大次數
        if (maxCount && count > maxCount) {
          this.stopTimedCapture();
          return;
        }

        // 執行截圖
        switch (type) {
          case "fullscreen":
            await this.startFullscreenCapture();
            break;
          case "window":
            await this.startWindowCapture();
            break;
        }

        this.eventEmitter.emit("timedCaptureProgress", { count, type });
      } catch (error) {
        console.error("Timed capture failed:", error);
      }
    }, interval);

    this.timedCaptureTimer = timer;
    this.eventEmitter.emit("timedCaptureStarted", { interval, maxCount, type });

    return timer;
  }

  stopTimedCapture() {
    if (this.timedCaptureTimer) {
      clearInterval(this.timedCaptureTimer);
      this.timedCaptureTimer = null;
      this.eventEmitter.emit("timedCaptureStopped");
    }
  }

  // 狀態查詢
  isCurrentlyCapturing() {
    return this.isCapturing;
  }

  getCapabilities() {
    return {
      regionCapture: true,
      fullscreenCapture: true,
      windowCapture: true,
      batchCapture: true,
      timedCapture: true,
      formats: ["png", "jpg", "webp"],
      features: {
        watermark: true,
        resize: true,
        clipboard: true,
        hotkeys: true,
      },
    };
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
window.CaptureManager = CaptureManager;
