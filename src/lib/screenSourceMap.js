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
  "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{0}|{1}|{2}' -f $_.DeviceName, $_.Bounds.X, $_.Bounds.Y }",
].join("; ");

// "\\.\DISPLAY2|0|0" 每行一個裝置 → [{ deviceNumber: 2, x: 0, y: 0 }]
function parseDeviceList(text) {
  const devices = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /DISPLAY(\d+)\|(-?\d+)\|(-?\d+)\s*$/.exec(line.trim());
    if (m) devices.push({ deviceNumber: Number(m[1]), x: Number(m[2]), y: Number(m[3]) });
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

function byDevicePosition(sources, displays, devices) {
  if (!devices || !devices.length || devices.length !== sources.length) return null;
  if (sources.some((s) => sourceIndex(s.id) === null)) return null;
  const sortedSources = [...sources].sort((a, b) => sourceIndex(a.id) - sourceIndex(b.id));
  const sortedDevices = [...devices].sort((a, b) => a.deviceNumber - b.deviceNumber);
  const map = new Map();
  const used = new Set();
  for (const d of displays) {
    let best = -1;
    let bestDist = Infinity;
    sortedDevices.forEach((dev, i) => {
      const dist = Math.max(Math.abs(dev.x - d.origin.x), Math.abs(dev.y - d.origin.y));
      if (!used.has(i) && dist < bestDist) { best = i; bestDist = dist; }
    });
    if (best < 0 || bestDist > ORIGIN_TOLERANCE_PX) return null;
    used.add(best);
    map.set(String(d.id), sortedSources[best].id);
  }
  return map;
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

module.exports = { parseDeviceList, buildSourceMap, queryDisplayDevices };
