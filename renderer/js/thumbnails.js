/* ===========================================
   縮圖載入器 - 只替「進入視口」的卡片產縮圖，在 renderer 內用
   createImageBitmap 縮放（Chromium 內部解碼，不佔主進程、不保留全圖）。
   老機器重點：同時最多 2 張在解碼、縮圖以 object URL 存 LRU、驅逐就釋放。
   =========================================== */

class ThumbnailLoader {
  constructor(options = {}) {
    this.height = options.height || 240;       // 短邊目標；卡片 100px，DPR 2 綽綽有餘
    this.concurrency = options.concurrency || 2;
    this.cacheSize = options.cacheSize || 400;
    this.cache = new Map();                    // id -> objectURL（LRU：越後面越新）
    this.queue = [];                           // 待處理 { id, file, img }
    this.active = 0;
    this.pending = new Map();                  // element -> { file, img }
    this.observer = new IntersectionObserver(
      (entries) => this.onIntersect(entries),
      { rootMargin: "200px 0px" }
    );
  }

  observe(el, file, img) {
    this.pending.set(el, { file, img });
    const cached = this.cacheGet(file.id);
    if (cached) {
      this.apply(img, cached);
      this.pending.delete(el);
      return;
    }
    this.observer.observe(el);
  }

  unobserve(el) {
    this.observer.unobserve(el);
    const entry = this.pending.get(el);
    if (entry) {
      this.pending.delete(el);
      this.queue = this.queue.filter((q) => q.img !== entry.img);
    }
  }

  reset() {
    this.observer.disconnect();
    this.pending.clear();
    this.queue = [];
  }

  onIntersect(entries) {
    for (const entry of entries) {
      const item = this.pending.get(entry.target);
      if (!item) continue;
      if (entry.isIntersecting) {
        if (!this.queue.some((q) => q.img === item.img)) {
          this.queue.push({ id: item.file.id, file: item.file, img: item.img, el: entry.target });
        }
      } else {
        this.queue = this.queue.filter((q) => q.img !== item.img);
      }
    }
    this.pump();
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active += 1;
      this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  async run(job) {
    const { file, img, el } = job;
    try {
      const cached = this.cacheGet(file.id) || (await this.generate(file));
      if (cached) {
        this.cacheSet(file.id, cached);
        this.apply(img, cached);
      } else {
        this.markError(img, el, file);
      }
    } catch (error) {
      this.markError(img, el, file);
    } finally {
      this.observer.unobserve(el);
      this.pending.delete(el);
    }
  }

  apply(img, url) {
    img.src = url;
    img.style.display = "block";
    const box = img.parentElement;
    if (box) box.classList.remove("loading");
  }

  markError(img, el, file) {
    const box = img.parentElement;
    if (!box) return;
    box.classList.remove("loading");
    box.classList.add("error");
    img.style.display = "none";
    // 檔案可能正在被寫入 / 雲端同步中：2 秒後再試一次（只試一次）
    if (el && file && !el.dataset.thumbRetried) {
      el.dataset.thumbRetried = "1";
      setTimeout(() => {
        if (!el.isConnected) return;
        box.classList.remove("error");
        box.classList.add("loading");
        this.observe(el, file, img);
      }, 2000);
    }
  }

  // 產生縮圖：fetch file:/// → Blob → createImageBitmap(resize) → 小 canvas → JPEG object URL
  async generate(file) {
    const src = file.path;
    if (!src) return null;
    const blob = await this.readBlob(src);
    if (!blob) return null;

    let bitmap;
    try {
      bitmap = await createImageBitmap(blob, {
        resizeHeight: this.height,
        resizeQuality: "medium",
      });
    } catch {
      return null;
    }

    try {
      // 超寬長條圖（8000×200）只用高度縮會變成 9600×240：再把寬度壓到 2×高度內
      const maxW = this.height * 2;
      const scale = bitmap.width > maxW ? maxW / bitmap.width : 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; // JPEG 沒有 alpha：透明 PNG 鋪白底而不是黑底
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const out = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.82)
      );
      return out ? URL.createObjectURL(out) : null;
    } finally {
      bitmap.close();
    }
  }

  async readBlob(src) {
    try {
      const res = await fetch(src);
      if (res.ok) return await res.blob();
    } catch {
      // webSecurity / 檔案被移走等情況，交給下方 Image 路徑
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const scale = Math.min(1, this.height / Math.max(1, img.naturalHeight));
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  cacheGet(id) {
    const url = this.cache.get(id);
    if (!url) return null;
    this.cache.delete(id);
    this.cache.set(id, url);
    return url;
  }

  cacheSet(id, url) {
    if (this.cache.has(id)) {
      if (this.cache.get(id) !== url) URL.revokeObjectURL(this.cache.get(id));
      this.cache.delete(id);
    }
    this.cache.set(id, url);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      URL.revokeObjectURL(this.cache.get(oldest));
      this.cache.delete(oldest);
      this.releaseCard(oldest);
    }
  }

  // 卡片仍在 DOM 時，<img> 會把已載入的圖留在記憶體；清掉 src 並重新觀察，捲回來再產
  releaseCard(id) {
    let card = null;
    try {
      card = document.querySelector(`.file-item[data-image-id="${CSS.escape(id)}"]`);
    } catch {
      return;
    }
    if (!card || !card._fileData) return;
    const img = card.querySelector("img");
    const box = card.querySelector(".file-thumbnail");
    if (!img || !box) return;
    img.removeAttribute("src");
    img.style.display = "none";
    box.classList.add("loading");
    this.observe(card, card._fileData, img);
  }

  // 檔案被刪除/搬走時釋放對應縮圖
  forget(id) {
    const url = this.cache.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      this.cache.delete(id);
    }
  }
}

window.ThumbnailLoader = ThumbnailLoader;
