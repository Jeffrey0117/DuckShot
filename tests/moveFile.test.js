const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { moveFile, uniqueTargetPath } = require("../src/lib/moveFile");

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "duckshot-move-test-"));
}

test("moveFile 把檔案移到目標資料夾並回傳新路徑", async () => {
  const srcDir = await makeTmpDir();
  const destDir = await makeTmpDir();
  const srcPath = path.join(srcDir, "shot.png");
  await fs.writeFile(srcPath, "fake-image");

  const newPath = await moveFile(srcPath, destDir);

  assert.equal(newPath, path.join(destDir, "shot.png"));
  assert.equal(await fs.readFile(newPath, "utf8"), "fake-image");
  await assert.rejects(fs.access(srcPath)); // 原檔已不在
});

test("目標已有同名檔時自動加序號 (1)、(2)", async () => {
  const srcDir = await makeTmpDir();
  const destDir = await makeTmpDir();
  await fs.writeFile(path.join(destDir, "shot.png"), "old");
  await fs.writeFile(path.join(destDir, "shot (1).png"), "old1");

  const srcPath = path.join(srcDir, "shot.png");
  await fs.writeFile(srcPath, "new");

  const newPath = await moveFile(srcPath, destDir);

  assert.equal(newPath, path.join(destDir, "shot (2).png"));
  assert.equal(await fs.readFile(newPath, "utf8"), "new");
  // 既有檔案不被覆蓋
  assert.equal(await fs.readFile(path.join(destDir, "shot.png"), "utf8"), "old");
});

test("目標資料夾不存在時拋錯且原檔保留", async () => {
  const srcDir = await makeTmpDir();
  const srcPath = path.join(srcDir, "shot.png");
  await fs.writeFile(srcPath, "fake-image");
  const missingDir = path.join(srcDir, "does-not-exist");

  await assert.rejects(moveFile(srcPath, missingDir));
  await fs.access(srcPath); // 原檔還在（不拋錯即通過）
});

test("uniqueTargetPath 無衝突時回傳原名", async () => {
  const destDir = await makeTmpDir();
  const result = await uniqueTargetPath(destDir, "shot.png");
  assert.equal(result, path.join(destDir, "shot.png"));
});
