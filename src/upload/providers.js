// 圖床上傳供應商鏈（純 Node，可單元測試）。
// 順序：第三方 URUSAI! 優先（免費、匿名）→ 自家 duk.tw 只當備援，而且要有 API 金鑰才會啟用。
// 任一家失敗（逾時、HTTP 錯、回應格式不符）自動換下一家；全部失敗才回錯。

const URUSAI_ENDPOINT = "https://api.urusai.cc/v1/upload";
const DUK_ENDPOINT = "https://duk.tw/api/upload";
const DEFAULT_TIMEOUT_MS = 60000;

const USER_AGENT = (version) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36 DuckShot/${version || "1.0"}`;

function createUrusaiProvider(cfg = {}) {
  const token = String(cfg.token || "").trim();
  return {
    name: "urusai",
    label: "URUSAI!",
    available: true,
    async upload({ bytes, filename, contentType, fetch, version }) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: contentType || "image/png" }), filename || "screenshot.png");
      form.append("r18", "0");
      if (token) form.append("token", token);
      const res = await fetch(URUSAI_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json", "User-Agent": USER_AGENT(version) },
        body: form,
        signal: AbortSignal.timeout(cfg.timeoutMs || DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => ({}));
      const url = json?.data?.url_direct;
      if (json?.status !== "success" || !url) throw new Error(json?.message || "回應格式不符");
      return { url, deleteUrl: json?.data?.url_delete || null, raw: json };
    },
  };
}

// duk.tw（upimg）：multipart 欄位名 image，非本站來源必須帶 x-api-key；回 { result, extension, shortUrl, mappingId }
function createDukProvider(cfg = {}) {
  const apiKey = String(cfg.apiKey || "").trim();
  const enabled = cfg.enabled !== false;
  return {
    name: "duk",
    label: "duk.tw",
    available: enabled && apiKey.length > 0,
    async upload({ bytes, filename, contentType, fetch, version }) {
      const form = new FormData();
      form.append("image", new Blob([bytes], { type: contentType || "image/png" }), filename || "screenshot.png");
      const res = await fetch(cfg.endpoint || DUK_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json", "x-api-key": apiKey, "User-Agent": USER_AGENT(version) },
        body: form,
        signal: AbortSignal.timeout(cfg.timeoutMs || DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => ({}));
      const url = json?.shortUrl || json?.url;
      if (!url) throw new Error(json?.message || "回應格式不符");
      return { url, deleteUrl: null, raw: json };
    },
  };
}

// 從設定（相容舊鍵名）與環境變數組出供應商鏈。順序固定：urusai → duk
function buildProviderChain(settings = {}, env = {}) {
  const upload = settings.upload || {};
  const urusaiToken =
    upload.urusaiToken || settings.urusaiToken || env.URUSAI_TOKEN || "";
  const dukApiKey =
    upload.dukApiKey || settings.dukApiKey || env.DUK_API_KEY || env.UPIMG_UPLOAD_KEY || "";
  return [
    createUrusaiProvider({ token: urusaiToken }),
    createDukProvider({ apiKey: dukApiKey, enabled: upload.dukEnabled !== false }),
  ];
}

// 依序嘗試；回傳第一個成功的 { provider, label, url, deleteUrl, raw, attempts }
async function uploadWithFallback(providers, ctx) {
  const attempts = [];
  for (const provider of providers) {
    if (!provider.available) {
      attempts.push({ provider: provider.name, skipped: true });
      continue;
    }
    try {
      const result = await provider.upload(ctx);
      return { provider: provider.name, label: provider.label, ...result, attempts };
    } catch (error) {
      const isTimeout = error && (error.name === "TimeoutError" || error.name === "AbortError");
      attempts.push({ provider: provider.name, error: isTimeout ? "逾時" : error.message || String(error) });
    }
  }
  const tried = attempts.filter((a) => !a.skipped);
  const summary = tried.length
    ? tried.map((a) => `${a.provider}: ${a.error}`).join("；")
    : "沒有可用的圖床";
  const err = new Error(`上傳失敗（${summary}）`);
  err.attempts = attempts;
  throw err;
}

module.exports = {
  createUrusaiProvider,
  createDukProvider,
  buildProviderChain,
  uploadWithFallback,
  URUSAI_ENDPOINT,
  DUK_ENDPOINT,
};
