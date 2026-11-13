/* ===========================================
   桌面視訊流「等第一張真的幀」的邏輯
   capture.html 用 <script> 載入；tests/firstFrame.test.js 用 require 載入
   =========================================== */
(function (root) {
  // 等新幀最多多久。擷取正常時幾十毫秒內就到；
  // 擷取端壞掉時（例如系統建不出 D3D11 裝置）一幀都不會來，等再久也沒用。
  const FRESH_FRAME_WAIT_MS = 400;
  // 視訊流壞掉之後，隔多久才再試一次（期間直接走主進程縮圖後備路徑，不必每次白等）
  const STREAM_RETRY_AFTER_MS = 5 * 60 * 1000;

  function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // 等 video 送來一張新的幀。
  // 不能只看 readyState：擷取端壞掉時 readyState 一樣是 4，但那一幀是全黑的。
  // 以前這裡沒有逾時，幀不來就永遠等下去 —— 覆蓋層卡在「沒暗幕、沒選取框、游標又被藏起來」。
  // 現在逾時就 reject，呼叫端改走主進程縮圖後備路徑。
  function waitForFreshFrame(video, opts) {
    const waitMs = (opts && opts.waitMs) || FRESH_FRAME_WAIT_MS;
    if (typeof video.requestVideoFrameCallback !== "function") {
      return Promise.reject(new Error("requestVideoFrameCallback unsupported"));
    }
    return withTimeout(
      new Promise((resolve) => video.requestVideoFrameCallback(() => resolve())),
      waitMs,
      "first video frame"
    );
  }

  // 視訊流最近失敗過 → 這段時間內直接走後備路徑
  function shouldSkipStream(lastFailureAt, now, retryAfterMs) {
    if (typeof lastFailureAt !== "number") return false;
    const retry = typeof retryAfterMs === "number" ? retryAfterMs : STREAM_RETRY_AFTER_MS;
    return now - lastFailureAt < retry;
  }

  const api = { waitForFreshFrame, withTimeout, shouldSkipStream, FRESH_FRAME_WAIT_MS, STREAM_RETRY_AFTER_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FirstFrame = api;
})(typeof window !== "undefined" ? window : globalThis);
