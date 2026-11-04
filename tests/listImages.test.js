const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { listImages, imageEntryId } = require("../src/lib/listImages");

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "duckshot-list-test-"));
}

test("只列出圖片副檔名，忽略子資料夾與其他檔案", async () => {
  const dir = await makeTmpDir();
  await fs.writeFile(path.join(dir, "a.png"), "x");
  await fs.writeFile(path.join(dir, "b.JPG"), "x");
  await fs.writeFile(path.join(dir, "notes.txt"), "x");
  await fs.mkdir(path.join(dir, "sub.png"));

  const result = await listImages(dir);

  assert.deepEqual(
    result.map((f) => f.name).sort(),
    ["a.png", "b.JPG"]
  );
});

test("回傳真實 size 與 mtimeMs，並依 mtime 由新到舊排序", async () => {
  const dir = await makeTmpDir();
  const older = path.join(dir, "older.png");
  const newer = path.join(dir, "newer.png");
  await fs.writeFile(older, "12345");
  await fs.writeFile(newer, "1234567890");
  const t0 = new Date(2020, 0, 1);
  const t1 = new Date(2021, 0, 1);
  await fs.utimes(older, t0, t0);
  await fs.utimes(newer, t1, t1);

  const result = await listImages(dir);

  assert.equal(result[0].name, "newer.png");
  assert.equal(result[0].size, 10);
  assert.equal(result[0].mtimeMs, t1.getTime());
  assert.equal(result[1].name, "older.png");
  assert.equal(result[1].size, 5);
  assert.equal(result[0].path, newer);
});

test("id 在檔案未變動時保持穩定，變動後才改變", async () => {
  const dir = await makeTmpDir();
  const file = path.join(dir, "shot.png");
  await fs.writeFile(file, "x");
  const t0 = new Date(2020, 0, 1);
  await fs.utimes(file, t0, t0);

  const first = (await listImages(dir))[0];
  const second = (await listImages(dir))[0];
  assert.equal(first.id, second.id);
  assert.equal(first.id, imageEntryId(file, t0.getTime()));

  const t1 = new Date(2022, 0, 1);
  await fs.utimes(file, t1, t1);
  const third = (await listImages(dir))[0];
  assert.notEqual(third.id, first.id);
});

test("資料夾不存在時回傳空陣列而非拋錯", async () => {
  const dir = await makeTmpDir();
  const result = await listImages(path.join(dir, "missing"));
  assert.deepEqual(result, []);
});

test("stat 失敗的檔案被略過，其餘照常回傳", async () => {
  const dir = await makeTmpDir();
  await fs.writeFile(path.join(dir, "ok.png"), "x");
  const result = await listImages(dir, {
    stat: async (p) => {
      if (p.endsWith("ok.png")) return { size: 1, mtimeMs: 5, isFile: () => true };
      throw new Error("boom");
    },
    readdir: async () => [
      { name: "ok.png", isFile: () => true },
      { name: "gone.png", isFile: () => true },
    ],
  });
  assert.deepEqual(result.map((f) => f.name), ["ok.png"]);
});
