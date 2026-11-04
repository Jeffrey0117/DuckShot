const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { createSaveDirResolver } = require("../src/lib/saveDir");

function makeFs(existing) {
  return {
    access: async (p) => {
      if (!existing.has(p)) throw new Error("ENOENT " + p);
    },
  };
}

test("設定的資料夾存在時直接回傳，不查詢系統圖片路徑", async () => {
  let queried = 0;
  const resolver = createSaveDirResolver({
    homedir: "C:\\Users\\u",
    platform: "win32",
    fs: makeFs(new Set(["D:\\shots"])),
    queryPicturesDir: async () => { queried += 1; return "C:\\Users\\u\\Pictures"; },
  });

  const dir = await resolver.getValidSaveDir("D:\\shots");

  assert.equal(dir, "D:\\shots");
  assert.equal(queried, 0);
});

test("系統圖片路徑只查一次並快取", async () => {
  let queried = 0;
  const pictures = "C:\\Users\\u\\OneDrive\\Pictures";
  const resolver = createSaveDirResolver({
    homedir: "C:\\Users\\u",
    platform: "win32",
    fs: makeFs(new Set([pictures])),
    queryPicturesDir: async () => { queried += 1; return pictures; },
  });

  const first = await resolver.getValidSaveDir("");
  const second = await resolver.getValidSaveDir(undefined);

  assert.equal(first, path.join(pictures, "DuckShot"));
  assert.equal(second, first);
  assert.equal(queried, 1);
});

test("查詢失敗時退回候選路徑，且失敗結果也會快取（不重複 spawn）", async () => {
  let queried = 0;
  const home = "C:\\Users\\u";
  const resolver = createSaveDirResolver({
    homedir: home,
    platform: "win32",
    fs: makeFs(new Set([path.join(home, "圖片")])),
    queryPicturesDir: async () => { queried += 1; throw new Error("no powershell"); },
  });

  const first = await resolver.getValidSaveDir("");
  const second = await resolver.getValidSaveDir("");

  assert.equal(first, path.join(home, "圖片", "DuckShot"));
  assert.equal(second, first);
  assert.equal(queried, 1);
});

test("非 Windows 不呼叫系統查詢", async () => {
  let queried = 0;
  const home = "/home/u";
  const resolver = createSaveDirResolver({
    homedir: home,
    platform: "linux",
    fs: makeFs(new Set([path.join(home, "Pictures")])),
    queryPicturesDir: async () => { queried += 1; return "/x"; },
  });

  const dir = await resolver.getValidSaveDir("");

  assert.equal(dir, path.join(home, "Pictures", "DuckShot"));
  assert.equal(queried, 0);
});

test("所有候選都不存在時回傳 Pictures/DuckShot 讓系統建立", async () => {
  const home = "C:\\Users\\u";
  const resolver = createSaveDirResolver({
    homedir: home,
    platform: "win32",
    fs: makeFs(new Set()),
    queryPicturesDir: async () => "",
  });

  const dir = await resolver.getValidSaveDir("");

  assert.equal(dir, path.join(home, "Pictures", "DuckShot"));
});
