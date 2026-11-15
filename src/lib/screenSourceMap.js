// 把 Electron 的螢幕（screen.getAllDisplays）對應到擷取來源（desktopCapturer.getSources）。
//
// 正常情況來源會帶 display_id，直接對就好。但 Windows 上 Electron 只有在 DirectX 擷取器可用時
// 才填 display_id；顯示卡的 D3D11 裝置建不起來時每個來源的 display_id 都是空字串。
// 以前對不上就一律拿第一個來源，結果在主螢幕截圖卻拿到另一台螢幕的畫面。
//
// 後備對法：來源 id 是 "screen:<N>:0"，N 是 Windows 顯示裝置的列舉順序（\\.\DISPLAY1、2…）。
// 向 Windows 問每個裝置的實體座標，再用座標認出它是 Electron 的哪一個螢幕。
const { execFile } = require("child_process");

const ORIGIN_TOLERANCE_PX = 16;
const QUERY_TIMEOUT_MS = 8000;

// 註解只用 ASCII：PowerShell 5.1 對非 ASCII 的指令內容不可靠
const DEVICE_QUERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // per-monitor DPI aware, otherwise the bounds come back scaled on mixed-DPI setups
  "Add-Type -Namespace DuckShot -Name Dpi -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v);'",
  "[void][DuckShot.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4))",
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.DeviceName, $_.Bounds.X, $_.Bounds.Y, $_.Bounds.Width, $_.Bounds.Height }",
].join("; ");

// PowerShell 的輸出 → [{ deviceNumber: 2, x: 0, y: 0, width: 1920, height: 1080 }, …]
function parseDeviceList(text) {
  const devices = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    // 每行：裝置名|x|y|寬|高（實體像素）
    const m = /DISPLAY(\d+)\|(-?\d+)\|(-?\d+)\|(\d+)\|(\d+)\s*$/.exec(line.trim());
    if (m) {
      devices.push({
        deviceNumber: Number(m[1]), x: Number(m[2]), y: Number(m[3]),
        width: Number(m[4]), height: Number(m[5]),
      });
    }
  }
  return devices;
}

function sourceIndex(sourceId) {
  const m = /^screen:(\d+):/.exec(String(sourceId));
  return m ? Number(m[1]) : null;
}

function byDisplayId(sources, displays) {
  if (!sources.length || !sources.every((s) => s.display_id)) return null;
  const known = new Set(displays.map((d) => String(d.id)));
  const map = new Map();
  for (const s of sources) {
    if (known.has(String(s.display_id))) map.set(String(s.display_id), s.id);
  }
  return map.size === displays.length ? map : null;
}

// 用實體座標認出每個螢幕是哪個 Windows 顯示裝置。
// 回傳 Map<螢幕 id 字串, 裝置>；有任何一台認不出來就回 null（不亂配）。
function matchDevicesToDisplays(displays, devices) {
  if (!devices || !devices.length) return null;
  const map = new Map();
  const used = new Set();
  for (const d of displays) {
    let best = -1;
    let bestDist = Infinity;
    devices.forEach((dev, i) => {
      const dist = Math.max(Math.abs(dev.x - d.origin.x), Math.abs(dev.y - d.origin.y));
      if (!used.has(i) && dist < bestDist) { best = i; bestDist = dist; }
    });
    if (best < 0 || bestDist > ORIGIN_TOLERANCE_PX) return null;
    used.add(best);
    map.set(String(d.id), devices[best]);
  }
  return map;
}

function byDevicePosition(sources, displays, devices) {
  if (!devices || devices.length !== sources.length) return null;
  if (sources.some((s) => sourceIndex(s.id) === null)) return null;
  const matched = matchDevicesToDisplays(displays, devices);
  if (!matched) return null;
  const sortedSources = [...sources].sort((a, b) => sourceIndex(a.id) - sourceIndex(b.id));
  const rank = devices.map((dev) => dev.deviceNumber).sort((a, b) => a - b);
  const map = new Map();
  for (const [displayId, dev] of matched) {
    map.set(displayId, sortedSources[rank.indexOf(dev.deviceNumber)].id);
  }
  return map;
}

// 擷取畫面要用的像素尺寸。Electron 只給 DIP 尺寸與縮放倍率，117% 這類非整數縮放下
// 1642 × 1.17 會算成 1921，實際螢幕是 1920——差一個像素整張畫面就要重新取樣、變糊。
// 所以優先用 Windows 回報的真實解析度（nativeSize），問不到才用乘出來的近似值。
function framePixelSize({ dipSize, scaleFactor, nativeSize, hiDpi }) {
  if (!hiDpi) return { width: Math.max(1, dipSize.width), height: Math.max(1, dipSize.height) };
  if (nativeSize && nativeSize.width > 0 && nativeSize.height > 0) {
    return { width: nativeSize.width, height: nativeSize.height };
  }
  const scale = scaleFactor || 1;
  return {
    width: Math.max(1, Math.round(dipSize.width * scale)),
    height: Math.max(1, Math.round(dipSize.height * scale)),
  };
}

function byOrder(sources, displays) {
  const map = new Map();
  displays.forEach((d, i) => {
    if (sources[i]) map.set(String(d.id), sources[i].id);
  });
  return map;
}

// sources: [{ id, display_id }]；displays: [{ id, origin: {x, y} }]（origin 是實體像素座標）；
// devices: parseDeviceList 的結果，沒有就傳 null。
// 回傳 { map: Map<螢幕 id 字串, 來源 id>, method }。
function buildSourceMap({ sources, displays, devices }) {
  const direct = byDisplayId(sources, displays);
  if (direct) return { map: direct, method: "display_id" };
  const positioned = byDevicePosition(sources, displays, devices);
  if (positioned) return { map: positioned, method: "device-position" };
  // 最後手段：照兩邊的排列順序配。不保證對，但比「全部拿第一個」好。
  return { map: byOrder(sources, displays), method: "order" };
}

// 問 Windows 每個顯示裝置的實體座標。失敗或非 Windows 回 null（呼叫端退回照順序配）。
function queryDisplayDevices() {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    const encoded = Buffer.from(DEVICE_QUERY_SCRIPT, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { timeout: QUERY_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const devices = parseDeviceList(stdout);
        resolve(devices.length ? devices : null);
      }
    );
  });
}

module.exports = {
  parseDeviceList,
  buildSourceMap,
  matchDevicesToDisplays,
  framePixelSize,
  queryDisplayDevices,
};
