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
