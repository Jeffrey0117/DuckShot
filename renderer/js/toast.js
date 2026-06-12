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
        markMoved(btn, tab.name);
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
    payload.tabs.forEach((tab, index) => {
      const btn = document.createElement("button");
      btn.className = "tab-btn";
      if (index < 9) {
        const key = document.createElement("span");
        key.className = "key";
        key.textContent = String(index + 1);
        btn.appendChild(key);
      }
      btn.appendChild(document.createTextNode(tab.name));
      btn.addEventListener("click", () => onTabClick(tab, btn));
      tabButtonsEl.appendChild(btn);
    });

    // 依內容實際高度請主進程縮放視窗（砍掉多餘空白）
    requestAnimationFrame(() => {
      const height = Math.ceil(toastEl.getBoundingClientRect().height);
      if (height > 0) window.electronAPI.send("toast-resize", height);
    });

    startCloseTimer();
  }

  function markMoved(btn, name) {
    stopCloseTimer();
    tabButtonsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
    btn.textContent = `✓ ${name}`;
    btn.classList.add("done");
    setTimeout(() => window.close(), CLOSE_AFTER_MOVE_MS);
  }

  // 主進程在視窗載入後（與連續截圖每次存檔後）送 toast-data
  window.electronAPI.on("toast-data", (_event, payload) => render(payload));

  // 數字快捷鍵由主進程直接搬檔，這裡只負責顯示結果
  window.electronAPI.on("toast-moved", (_event, result) => {
    if (result && result.success) {
      const btn = tabButtonsEl.children[result.index];
      if (btn) {
        markMoved(btn, result.name);
      } else {
        setTimeout(() => window.close(), CLOSE_AFTER_MOVE_MS);
      }
    } else {
      messageEl.textContent = `移動失敗：${(result && result.error) || "未知錯誤"}`;
      messageEl.classList.add("error");
      startCloseTimer();
    }
  });
})();
