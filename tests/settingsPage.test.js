// 設定頁的兩個靜態保證。設定頁沒有打包器也沒有 DOM 測試環境，所以直接檢查原始檔。
// SETTINGS_HTML 可以指到別的檔案（用來確認這些檢查對舊版真的會失敗）。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const htmlPath = process.env.SETTINGS_HTML || path.join(__dirname, "../renderer/settings.html");
const html = fs.readFileSync(htmlPath, "utf8");

test("設定頁的 <html> 有 data-theme（main.css 的顏色變數都定義在它底下）", () => {
  assert.match(html, /<html[^>]*\sdata-theme="(light|dark)"/);
});

test("套用快捷鍵按鈕樣式的按鈕都有 data-shortcut（否則會被綁上快捷鍵的編輯／重設）", () => {
  const buttons = html.match(/<button[^>]*class="[^"]*\b(edit-key-btn|reset-key-btn)\b[^"]*"[^>]*>/g) || [];
  assert.ok(buttons.length >= 6, `應該找到 6 個快捷鍵按鈕，實際 ${buttons.length}`);
  const missing = buttons.filter((b) => !/data-shortcut="(region|fullscreen|window)"/.test(b));
  assert.deepEqual(missing, []);
});
