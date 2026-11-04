// 列出資料夾內的圖片（純 Node，可單元測試）。
// 一次 readdir + 並行 stat，回傳穩定 id（path|mtimeMs）：檔案沒變 id 就不變，
// 讓前端 grid 能真正做增量更新，而不是每次 refresh 全刪全建。
const fsp = require("fs").promises;
const path = require("path");

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function imageEntryId(filePath, mtimeMs) {
  return `${filePath}|${Math.round(mtimeMs)}`;
}

function isImageName(name) {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

async function listImages(dir, deps = {}) {
  const readdir = deps.readdir || ((d) => fsp.readdir(d, { withFileTypes: true }));
  const stat = deps.stat || ((p) => fsp.stat(p));

  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const candidates = entries.filter((e) => e.isFile() && isImageName(e.name));

  const stats = await Promise.all(
    candidates.map(async (entry) => {
      const full = path.join(dir, entry.name);
      try {
        const st = await stat(full);
        return {
          id: imageEntryId(full, st.mtimeMs),
          name: entry.name,
          path: full,
          size: st.size,
          mtimeMs: st.mtimeMs,
          type: `image/${path.extname(entry.name).slice(1).toLowerCase()}`,
        };
      } catch {
        return null;
      }
    })
  );

  return stats
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

module.exports = { listImages, imageEntryId, isImageName, IMAGE_EXTS };
