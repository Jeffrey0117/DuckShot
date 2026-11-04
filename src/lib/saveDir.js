// 截圖儲存資料夾解析（純 Node，可單元測試）。
// Windows 的「圖片」路徑要問系統（OneDrive 重新導向），但 spawn PowerShell 要 300ms+
// 且會閃黑窗 → 只問一次並快取（成功失敗都快取），之後零成本。
const path = require("path");

function createSaveDirResolver(deps = {}) {
  const homedir = deps.homedir;
  const platform = deps.platform || process.platform;
  const fs = deps.fs || require("fs").promises;
  const queryPicturesDir = deps.queryPicturesDir || defaultQueryPicturesDir;

  let picturesPromise = null; // 系統圖片路徑查詢（含失敗）只做一次

  function systemPicturesDir() {
    if (platform !== "win32") return Promise.resolve("");
    if (!picturesPromise) {
      picturesPromise = queryPicturesDir()
        .then((p) => (typeof p === "string" ? p.trim() : ""))
        .catch(() => "");
    }
    return picturesPromise;
  }

  async function exists(p) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async function getValidSaveDir(configured) {
    if (typeof configured === "string" && configured.trim().length > 0) {
      if (await exists(configured)) return configured;
    }

    const picturesBase = await systemPicturesDir();
    const candidates = [
      picturesBase,
      path.join(homedir, "Pictures"),
      path.join(homedir, "圖片"),
      path.join(homedir, "OneDrive", "Pictures"),
      path.join(homedir, "OneDrive", "圖片"),
      path.join(homedir, "Documents"),
    ].filter(Boolean);

    for (const base of candidates) {
      if (await exists(base)) return path.join(base, "DuckShot");
    }
    return path.join(picturesBase || path.join(homedir, "Pictures"), "DuckShot");
  }

  return { getValidSaveDir };
}

// 問 Windows 真正的「圖片」資料夾。windowsHide 必加：Electron 主進程沒有 console，
// 不加會每次閃一個黑色 PowerShell 視窗。
function defaultQueryPicturesDir() {
  const { execFile } = require("child_process");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('MyPictures')"],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || "")))
    );
  });
}

module.exports = { createSaveDirResolver };
