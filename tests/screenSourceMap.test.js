const { test } = require("node:test");
const assert = require("node:assert");
const {
  parseDeviceList,
  buildSourceMap,
  matchDevicesToDisplays,
  framePixelSize,
} = require("../src/lib/screenSourceMap");

test("117% 縮放：擷取尺寸用 Windows 回報的 1920×1080，不是 1642×1.17 乘出來的 1921×1081", () => {
  const dipSize = { width: 1642, height: 924 };
  const scaleFactor = 1.1699999570846558;
  const nativeSize = matchDevicesToDisplays(DISPLAYS, DEVICES).get("143940598");
  assert.deepStrictEqual(
    framePixelSize({ dipSize, scaleFactor, nativeSize, hiDpi: true }),
    { width: 1920, height: 1080 }
  );
});

test("問不到真實解析度時退回乘出來的近似值；關閉高解析擷取時用 DIP 尺寸", () => {
  const dipSize = { width: 1642, height: 924 };
  const nativeSize = { width: 1920, height: 1080 };
  assert.deepStrictEqual(
    framePixelSize({ dipSize, scaleFactor: 1.17, nativeSize: null, hiDpi: true }),
    { width: 1921, height: 1081 }
  );
  assert.deepStrictEqual(
    framePixelSize({ dipSize, scaleFactor: 1.17, nativeSize, hiDpi: false }),
    { width: 1642, height: 924 }
  );
});

test("matchDevicesToDisplays：座標對不上就整個放棄，不亂配", () => {
  assert.strictEqual(matchDevicesToDisplays(DISPLAYS, null), null);
  assert.strictEqual(
    matchDevicesToDisplays(DISPLAYS, [{ deviceNumber: 1, x: 7000, y: 0, width: 1, height: 1 }]),
    null
  );
});

// 實測這台機器的狀況：兩台螢幕、來源都沒帶 display_id、
// 第一個來源（screen:0:0 = \\.\DISPLAY1）是右邊那台「非主螢幕」。
const DISPLAYS = [
  { id: 3678990569, origin: { x: 1920, y: 0 } }, // 右邊，非主螢幕
  { id: 143940598, origin: { x: 0, y: 0 } },     // 主螢幕
];
const SOURCES_NO_ID = [
  { id: "screen:0:0", display_id: "" },
  { id: "screen:1:0", display_id: "" },
];
const DEVICES = [
  { deviceNumber: 1, x: 1920, y: 0, width: 1920, height: 1080 },
  { deviceNumber: 2, x: 0, y: 0, width: 1920, height: 1080 },
];

test("parseDeviceList 解析 PowerShell 的輸出", () => {
  const out = "\\\\.\\DISPLAY1|1920|0|1920|1080\r\n\\\\.\\DISPLAY2|0|0|1920|1080\r\n";
  assert.deepStrictEqual(parseDeviceList(out), DEVICES);
  assert.deepStrictEqual(parseDeviceList("\\\\.\\DISPLAY3|-1920|-200|2560|1440"), [
    { deviceNumber: 3, x: -1920, y: -200, width: 2560, height: 1440 },
  ]);
  assert.deepStrictEqual(parseDeviceList("garbage\n"), []);
  assert.deepStrictEqual(parseDeviceList(null), []);
});

test("來源有帶 display_id 時直接照它對", () => {
  const sources = [
    { id: "screen:0:0", display_id: "143940598" },
    { id: "screen:1:0", display_id: "3678990569" },
  ];
  const { map, method } = buildSourceMap({ sources, displays: DISPLAYS, devices: null });
  assert.strictEqual(method, "display_id");
  assert.strictEqual(map.get("143940598"), "screen:0:0");
  assert.strictEqual(map.get("3678990569"), "screen:1:0");
});

test("display_id 是空的：主螢幕不能拿到第一個來源（那是另一台螢幕）", () => {
  const { map, method } = buildSourceMap({ sources: SOURCES_NO_ID, displays: DISPLAYS, devices: DEVICES });
  assert.strictEqual(method, "device-position");
  assert.strictEqual(map.get("143940598"), "screen:1:0");
  assert.strictEqual(map.get("3678990569"), "screen:0:0");
});

test("display_id 是空的：螢幕列舉順序跟裝置順序相反也對得上", () => {
  const displays = [DISPLAYS[1], DISPLAYS[0]];
  const { map } = buildSourceMap({ sources: SOURCES_NO_ID, displays, devices: DEVICES });
  assert.strictEqual(map.get("143940598"), "screen:1:0");
  assert.strictEqual(map.get("3678990569"), "screen:0:0");
});

test("裝置編號有缺號時照名次配（DISPLAY1、DISPLAY5 → 第 0、第 1 個來源）", () => {
  const sources = [
    { id: "screen:4:0", display_id: "" },
    { id: "screen:0:0", display_id: "" },
  ];
  const devices = [
    { deviceNumber: 5, x: 0, y: 0 },
    { deviceNumber: 1, x: 1920, y: 0 },
  ];
  const { map, method } = buildSourceMap({ sources, displays: DISPLAYS, devices });
  assert.strictEqual(method, "device-position");
  assert.strictEqual(map.get("143940598"), "screen:4:0");
  assert.strictEqual(map.get("3678990569"), "screen:0:0");
});

test("問不到裝置座標、或座標對不上：退回照順序配，每台螢幕各拿一個來源", () => {
  const noDevices = buildSourceMap({ sources: SOURCES_NO_ID, displays: DISPLAYS, devices: null });
  assert.strictEqual(noDevices.method, "order");
  assert.strictEqual(noDevices.map.get("3678990569"), "screen:0:0");
  assert.strictEqual(noDevices.map.get("143940598"), "screen:1:0");

  const farOff = [
    { deviceNumber: 1, x: 5000, y: 0 },
    { deviceNumber: 2, x: 9000, y: 0 },
  ];
  assert.strictEqual(buildSourceMap({ sources: SOURCES_NO_ID, displays: DISPLAYS, devices: farOff }).method, "order");
});
