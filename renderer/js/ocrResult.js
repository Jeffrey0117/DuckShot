// OCR 結果視窗（行為移植自 Screenshot-OCR ResultPopup.tsx，純 JS 重寫）
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    imageWrap: $("imageWrap"), image: $("resultImage"),
    cropOverlay: $("cropOverlay"), cropRect: $("cropRect"), cropCanvas: $("cropCanvas"),
    loading: $("loading"), errorBox: $("errorBox"),
    textWrap: $("textWrap"), text: $("resultText"), confidence: $("confidence"),
    copy: $("btnCopy"), crop: $("btnCrop"), ai: $("btnAI"),
    search: $("btnSearch"), ig: $("btnIG"),
    capture: $("btnCapture"), pin: $("btnPin"), settings: $("btnSettings"), close: $("btnClose"),
  };

  let currentImage = null;
  let isEditingCrop = false;
  let cropStart = null;
  let cropEnd = null;
  let isDragging = false;

  // 套用 DuckShot 主題（main.css 的設計變數依 data-theme 切換）
  (async () => {
    let theme = "light";
    try {
      const settings = await window.electronAPI.settings.get();
      if (settings && settings.theme) theme = settings.theme;
    } catch {}
    document.documentElement.dataset.theme = theme;
  })();

  function setActionsEnabled(enabled) {
    [els.copy, els.crop, els.search, els.ig].forEach((b) => (b.disabled = !enabled));
    window.electronAPI.ocr.isGeminiAvailable().then((ok) => {
      els.ai.disabled = !enabled || !ok;
    });
  }

  function showLoading(image) {
    currentImage = image || currentImage;
    if (currentImage) {
      els.image.src = currentImage;
      els.imageWrap.style.display = "";
    }
    els.loading.style.display = "";
    els.errorBox.style.display = "none";
    els.textWrap.style.display = "none";
    els.confidence.textContent = "";
    setActionsEnabled(false);
  }

  function showResult(payload) {
    currentImage = payload.image || currentImage;
    if (currentImage) {
      els.image.src = currentImage;
      els.imageWrap.style.display = "";
    }
    els.loading.style.display = "none";
    els.errorBox.style.display = "none";
    els.textWrap.style.display = "";
    els.text.textContent = payload.text || "";
    els.confidence.textContent = payload.methodDisplay || "";
    setActionsEnabled(true);
  }

  function showError(message) {
    els.loading.style.display = "none";
    els.errorBox.style.display = "";
    els.errorBox.textContent = message;
    els.textWrap.style.display = "none";
    setActionsEnabled(false);
    // 有圖時仍可用 AI 重試（無 key 時 setActionsEnabled 的查詢會把它關回去）
    if (currentImage) {
      window.electronAPI.ocr.isGeminiAvailable().then((ok) => {
        els.ai.disabled = !ok;
      });
    }
  }

  function getCurrentText() {
    const sel = window.getSelection();
    const selected = sel && sel.toString().trim();
    return selected || els.text.textContent || "";
  }

  // --- 動作列 ---
  els.copy.addEventListener("click", async () => {
    const text = getCurrentText();
    if (!text) return;
    await window.electronAPI.clipboard.writeText(text);
    els.copy.textContent = "已複製 ✓";
    els.copy.classList.add("copied");
    setTimeout(() => {
      els.copy.textContent = "複製";
      els.copy.classList.remove("copied");
    }, 2000);
  });

  els.search.addEventListener("click", () => {
    const text = getCurrentText();
    if (text) window.electronAPI.ocr.openExternal(
      "https://www.google.com/search?q=" + encodeURIComponent(text));
  });

  els.ig.addEventListener("click", () => {
    const text = getCurrentText();
    if (text) window.electronAPI.ocr.openExternal(
      "https://www.instagram.com/explore/search/keyword/?q=" + encodeURIComponent(text));
  });

  els.ai.addEventListener("click", async () => {
    if (!currentImage) return;
    showLoading(currentImage);
    const result = await window.electronAPI.ocr.gemini(currentImage);
    if (result.success) {
      showResult({ image: currentImage, text: result.text, methodDisplay: result.methodDisplay });
    } else {
      showError(result.error || "Gemini 辨識失敗");
    }
  });

  // --- 裁切重辨識（同原 app：在預覽圖上拖選 → 放開 → 對子圖重新 OCR）---
  els.crop.addEventListener("click", () => {
    if (isEditingCrop) {
      exitCropMode();
      return;
    }
    isEditingCrop = true;
    els.imageWrap.classList.add("editing");
    els.crop.textContent = "取消裁切";
  });

  els.imageWrap.addEventListener("mousedown", (e) => {
    if (!isEditingCrop) return;
    const rect = els.imageWrap.getBoundingClientRect();
    cropStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    cropEnd = { ...cropStart };
    isDragging = true;
    els.cropOverlay.style.display = "";
    els.cropRect.style.display = "";
    updateCropRect();
  });
  els.imageWrap.addEventListener("mousemove", (e) => {
    if (!isDragging || !isEditingCrop) return;
    const rect = els.imageWrap.getBoundingClientRect();
    cropEnd = {
      x: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(e.clientY - rect.top, rect.height)),
    };
    updateCropRect();
  });
  els.imageWrap.addEventListener("mouseup", () => {
    if (!isEditingCrop || !isDragging) return;
    isDragging = false;
    applyCrop();
  });

  function updateCropRect() {
    if (!cropStart || !cropEnd) return;
    const left = Math.min(cropStart.x, cropEnd.x);
    const top = Math.min(cropStart.y, cropEnd.y);
    Object.assign(els.cropRect.style, {
      left: left + "px", top: top + "px",
      width: Math.abs(cropEnd.x - cropStart.x) + "px",
      height: Math.abs(cropEnd.y - cropStart.y) + "px",
    });
  }

  function exitCropMode() {
    isEditingCrop = false;
    isDragging = false;
    cropStart = cropEnd = null;
    els.imageWrap.classList.remove("editing");
    els.cropOverlay.style.display = "none";
    els.cropRect.style.display = "none";
    els.crop.textContent = "裁切";
  }

  function applyCrop() {
    const img = els.image;
    if (!cropStart || !cropEnd || !img.naturalWidth) return exitCropMode();
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;
    const x1 = Math.min(cropStart.x, cropEnd.x) * scaleX;
    const y1 = Math.min(cropStart.y, cropEnd.y) * scaleY;
    const w = Math.abs(cropEnd.x - cropStart.x) * scaleX;
    const h = Math.abs(cropEnd.y - cropStart.y) * scaleY;
    if (w < 10 || h < 10) return exitCropMode();

    const canvas = els.cropCanvas;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, x1, y1, w, h, 0, 0, w, h);
    const cropped = canvas.toDataURL("image/png");
    exitCropMode();
    window.electronAPI.ocr.recognizeRegion(cropped);
  }

  // --- 標題列 ---
  els.capture.addEventListener("click", () => window.electronAPI.capture.startRegionCapture());
  els.pin.addEventListener("click", async () => {
    const pinned = await window.electronAPI.ocr.togglePin();
    els.pin.classList.toggle("active", pinned);
  });
  els.settings.addEventListener("click", () => window.electronAPI.settings.openWindow());
  els.close.addEventListener("click", () => window.close());

  // --- 鍵盤（同原 app：Esc 關閉、Ctrl+C 無選取時複製全文、Ctrl+P 釘選）---
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.close();
    else if ((e.ctrlKey || e.metaKey) && e.key === "p") { e.preventDefault(); els.pin.click(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      const sel = window.getSelection();
      if (!sel || !sel.toString().trim()) { e.preventDefault(); els.copy.click(); }
    }
  });

  // --- 主進程事件 ---
  window.electronAPI.on("ocr-start", (_e, payload) => showLoading(payload.image));
  window.electronAPI.on("ocr-result", (_e, payload) => showResult(payload));
  window.electronAPI.on("ocr-error", (_e, payload) => showError(payload.message));

  // 監聽都註冊好了，通知主進程可以開始送（避免 loadFile 完成但 script 未跑完的競態）
  window.electronAPI.send("ocr-ready");
})();
