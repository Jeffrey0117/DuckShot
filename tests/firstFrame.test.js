const { test } = require("node:test");
const assert = require("node:assert/strict");
const { waitForFreshFrame, withTimeout, shouldSkipStream } = require("../renderer/js/firstFrame");

// 假 video：requestVideoFrameCallback 依設定「會來 / 永遠不來」
function fakeVideo({ frameAfterMs } = {}) {
  return {
    readyState: 4, // 擷取端壞掉時 readyState 也是 4（但幀是黑的），所以不能拿它當依據
    requestVideoFrameCallback(cb) {
      if (typeof frameAfterMs === "number") setTimeout(cb, frameAfterMs);
    },
  };
}

// 測試本身的保險：被測函式若卡住，這裡會先判失敗而不是讓整個測試掛著
function mustSettleWithin(promise, ms) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超過 ${ms}ms 仍未結束（卡住了）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

test("擷取端一幀都不送（readyState 仍是 4）→ 逾時失敗讓呼叫端走後備路徑，不是永遠卡住", async () => {
  const t0 = Date.now();
  await assert.rejects(
    mustSettleWithin(waitForFreshFrame(fakeVideo(), { waitMs: 40 }), 1000),
    /first video frame timeout/
  );
  assert.ok(Date.now() - t0 < 500, "不該等很久");
});

test("新幀很快就來 → 正常完成", async () => {
  await mustSettleWithin(waitForFreshFrame(fakeVideo({ frameAfterMs: 5 }), { waitMs: 300 }), 1000);
});

test("不支援 requestVideoFrameCallback → 直接失敗走後備路徑", async () => {
  await assert.rejects(mustSettleWithin(waitForFreshFrame({ readyState: 4 }), 1000), /unsupported/);
});

test("withTimeout：逾時就失敗，並帶上標籤", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 30, "getUserMedia"), /getUserMedia timeout/);
});

test("withTimeout：及時完成就回傳原本的值", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 200, "x"), "ok");
});

test("shouldSkipStream：沒失敗過不跳過；剛失敗跳過；過了重試時間再試", () => {
  assert.equal(shouldSkipStream(null, 1000, 500), false);
  assert.equal(shouldSkipStream(1000, 1200, 500), true);
  assert.equal(shouldSkipStream(1000, 1500, 500), false);
});
