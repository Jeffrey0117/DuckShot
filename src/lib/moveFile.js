// 搬移截圖到分類資料夾的核心邏輯（純 Node，不依賴 Electron，可單元測試）
const fs = require("fs").promises;
const path = require("path");

// 回傳 targetDir 下不與既有檔案衝突的完整路徑：shot.png → shot (1).png → shot (2).png
async function uniqueTargetPath(targetDir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(targetDir, filename);
  let i = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(targetDir, `${base} (${i})${ext}`);
      i += 1;
    } catch {
      return candidate;
    }
  }
}

// 移動檔案；跨磁碟（EXDEV）時 fallback 為 copy + delete。回傳實際落地的新路徑。
async function moveFile(srcPath, targetDir) {
  const targetPath = await uniqueTargetPath(targetDir, path.basename(srcPath));
  try {
    await fs.rename(srcPath, targetPath);
  } catch (error) {
    if (error.code === "EXDEV") {
      await fs.copyFile(srcPath, targetPath);
      await fs.unlink(srcPath);
    } else {
      throw error;
    }
  }
  return targetPath;
}

module.exports = { moveFile, uniqueTargetPath };
