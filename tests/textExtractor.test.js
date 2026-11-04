const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// 以 require cache 注入假引擎，驗證「Paddle 冷啟動不與 UIA 並行」的排程邏輯
const paddlePath = require.resolve("../src/ocr/paddle");
const uiaPath = require.resolve("../src/ocr/uiAutomation");
const extractorPath = require.resolve("../src/ocr/textExtractor");

function install(mocks) {
  for (const p of [paddlePath, uiaPath, extractorPath]) delete require.cache[p];
  require.cache[paddlePath] = { id: paddlePath, filename: paddlePath, loaded: true, exports: mocks.paddle };
  require.cache[uiaPath] = { id: uiaPath, filename: uiaPath, loaded: true, exports: mocks.uia };
  return require(extractorPath);
}

const originalPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
});

test("Paddle 冷的時候：UIA 成功就完全不碰 Paddle", async () => {
  let paddleCalls = 0;
  const { extractText } = install({
    paddle: {
      isWarm: () => false,
      recognizeWithPaddleOcr: async () => { paddleCalls += 1; return { success: true, text: "paddle", lines: [] }; },
    },
    uia: { getTextFromRect: async () => ({ success: true, text: "from window" }) },
  });

  const result = await extractText({ imageData: "data:image/png;base64,AAAA", screenBounds: { x: 0, y: 0, width: 10, height: 10 } });

  assert.equal(result.method, "ui-automation");
  assert.equal(result.text, "from window");
  assert.equal(paddleCalls, 0);
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

test("Paddle 冷的時候：UIA 失敗才啟動 Paddle，且只啟動一次", async () => {
  let paddleCalls = 0;
  const { extractText } = install({
    paddle: {
      isWarm: () => false,
      recognizeWithPaddleOcr: async () => { paddleCalls += 1; return { success: true, text: "中文結果", lines: [{ confidence: 0.9 }] }; },
    },
    uia: { getTextFromRect: async () => ({ success: false, text: "" }) },
  });

  const result = await extractText({ imageData: "data:image/png;base64,AAAA", screenBounds: { x: 0, y: 0, width: 10, height: 10 } });

  assert.equal(result.method, "paddle-ocr");
  assert.equal(result.text, "中文結果");
  assert.equal(paddleCalls, 1);
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

test("Paddle 已暖：與 UIA 並行（UIA 還沒回來 Paddle 就已經在跑）", async () => {
  let paddleStartedBeforeUia = false;
  let paddleStarted = false;
  const { extractText } = install({
    paddle: {
      isWarm: () => true,
      recognizeWithPaddleOcr: async () => { paddleStarted = true; return { success: true, text: "paddle", lines: [] }; },
    },
    uia: { getTextFromRect: async () => { paddleStartedBeforeUia = paddleStarted; return { success: true, text: "win" }; } },
  });

  const result = await extractText({ imageData: "data:image/png;base64,AAAA", screenBounds: { x: 0, y: 0, width: 10, height: 10 } });

  assert.equal(result.method, "ui-automation");
  assert.equal(paddleStartedBeforeUia, true);
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

test("沒有螢幕座標（結果視窗重框選）：不跑 UIA，直接 Paddle", async () => {
  let uiaCalls = 0;
  let paddleCalls = 0;
  const { extractText } = install({
    paddle: {
      isWarm: () => false,
      recognizeWithPaddleOcr: async () => { paddleCalls += 1; return { success: true, text: "中文", lines: [] }; },
    },
    uia: { getTextFromRect: async () => { uiaCalls += 1; return { success: true, text: "x" }; } },
  });

  const result = await extractText({ imageData: "data:image/png;base64,AAAA", screenBounds: null });

  assert.equal(result.method, "paddle-ocr");
  assert.equal(uiaCalls, 0);
  assert.equal(paddleCalls, 1);
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

test("Paddle 冷的時候：UIA 拖太久（超過 paddleDelayMs）Paddle 會提前並行開跑", async () => {
  let paddleStartedAt = 0;
  const t0 = Date.now();
  const { extractText } = install({
    paddle: {
      isWarm: () => false,
      recognizeWithPaddleOcr: async () => { paddleStartedAt = Date.now(); return { success: true, text: "中文", lines: [] }; },
    },
    uia: { getTextFromRect: () => new Promise((resolve) => setTimeout(() => resolve({ success: false, text: "" }), 200)) },
  });

  const result = await extractText({ imageData: "data:image/png;base64,AAAA", screenBounds: { x: 0, y: 0, width: 10, height: 10 }, paddleDelayMs: 30 });

  assert.equal(result.method, "paddle-ocr");
  assert.ok(paddleStartedAt - t0 < 150, `Paddle 應在 UIA 回來前就開跑，實際 ${paddleStartedAt - t0}ms`);
  Object.defineProperty(process, "platform", { value: originalPlatform });
});
