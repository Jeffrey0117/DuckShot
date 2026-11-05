const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildProviderChain, uploadWithFallback, URUSAI_ENDPOINT, DUK_ENDPOINT } = require("../src/upload/providers");

const bytes = Buffer.from("fake-png");
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });

function fakeFetch(handlers, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const h = handlers[url];
    if (!h) throw new Error("unexpected url " + url);
    return typeof h === "function" ? h(init) : h;
  };
}

test("順序固定：URUSAI 優先，成功就不碰 duk.tw", async () => {
  const calls = [];
  const fetch = fakeFetch({
    [URUSAI_ENDPOINT]: ok({ status: "success", data: { url_direct: "https://urusai.cc/x.png", url_delete: "https://urusai.cc/d/x" } }),
    [DUK_ENDPOINT]: ok({ shortUrl: "https://duk.tw/abc.png" }),
  }, calls);
  const chain = buildProviderChain({ upload: { dukApiKey: "k" } });

  const result = await uploadWithFallback(chain, { bytes, filename: "a.png", contentType: "image/png", fetch });

  assert.equal(result.provider, "urusai");
  assert.equal(result.url, "https://urusai.cc/x.png");
  assert.equal(result.deleteUrl, "https://urusai.cc/d/x");
  assert.deepEqual(calls.map((c) => c.url), [URUSAI_ENDPOINT]);
});

test("URUSAI 失敗（HTTP 5xx）→ 自動換 duk.tw，帶 x-api-key 與 image 欄位", async () => {
  const calls = [];
  const fetch = fakeFetch({
    [URUSAI_ENDPOINT]: fail(502),
    [DUK_ENDPOINT]: ok({ result: "ok", extension: "png", shortUrl: "https://duk.tw/abc.png", mappingId: 1 }),
  }, calls);
  const chain = buildProviderChain({ upload: { dukApiKey: "secret-key" } });

  const result = await uploadWithFallback(chain, { bytes, filename: "a.png", contentType: "image/png", fetch });

  assert.equal(result.provider, "duk");
  assert.equal(result.url, "https://duk.tw/abc.png");
  assert.equal(result.attempts[0].provider, "urusai");
  assert.equal(result.attempts[0].error, "HTTP 502");
  const dukCall = calls.find((c) => c.url === DUK_ENDPOINT);
  assert.equal(dukCall.init.headers["x-api-key"], "secret-key");
  assert.ok(dukCall.init.body.get("image"), "duk.tw 要用 image 欄位");
});

test("沒填 duk.tw 金鑰 → duk.tw 不啟用，URUSAI 失敗就整體失敗並說明原因", async () => {
  const calls = [];
  const fetch = fakeFetch({ [URUSAI_ENDPOINT]: ok({ status: "error", message: "quota" }) }, calls);
  const chain = buildProviderChain({});

  await assert.rejects(
    uploadWithFallback(chain, { bytes, filename: "a.png", contentType: "image/png", fetch }),
    (e) => /urusai: quota/.test(e.message) && e.attempts.some((a) => a.provider === "duk" && a.skipped)
  );
  assert.deepEqual(calls.map((c) => c.url), [URUSAI_ENDPOINT]);
});

test("duk.tw 備援可用設定關閉時，即使有金鑰也不用", async () => {
  const calls = [];
  const fetch = fakeFetch({ [URUSAI_ENDPOINT]: fail(500) }, calls);
  const chain = buildProviderChain({ upload: { dukApiKey: "k", dukEnabled: false } });

  await assert.rejects(uploadWithFallback(chain, { bytes, fetch }));
  assert.deepEqual(calls.map((c) => c.url), [URUSAI_ENDPOINT]);
});

test("逾時（TimeoutError）換下一家，錯誤訊息顯示逾時", async () => {
  const calls = [];
  const timeoutErr = Object.assign(new Error("timeout"), { name: "TimeoutError" });
  const fetch = fakeFetch({
    [URUSAI_ENDPOINT]: () => { throw timeoutErr; },
    [DUK_ENDPOINT]: ok({ shortUrl: "https://duk.tw/z.png" }),
  }, calls);
  const chain = buildProviderChain({}, { UPIMG_UPLOAD_KEY: "env-key" });

  const result = await uploadWithFallback(chain, { bytes, fetch });

  assert.equal(result.provider, "duk");
  assert.equal(result.attempts[0].error, "逾時");
});

test("相容舊設定鍵名：頂層 urusaiToken / dukApiKey 也讀得到", async () => {
  const calls = [];
  const fetch = fakeFetch({
    [URUSAI_ENDPOINT]: (init) => { assert.equal(init.body.get("token"), "old-token"); return fail(500); },
    [DUK_ENDPOINT]: ok({ shortUrl: "https://duk.tw/legacy.png" }),
  }, calls);
  const chain = buildProviderChain({ urusaiToken: "old-token", dukApiKey: "old-key" });

  const result = await uploadWithFallback(chain, { bytes, fetch });
  assert.equal(result.provider, "duk");
});
