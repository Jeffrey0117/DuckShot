const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ICON_NAMES, buildIconsSource } = require("../scripts/build-icons");

function loadIconsModule(source) {
  const sandbox = { window: {}, document: undefined };
  vm.runInNewContext(source, sandbox);
  return sandbox.window.DuckIcons;
}

test("產出的 icons.js 包含所有需要的 icon 且為 SVG 內容", () => {
  const source = buildIconsSource();
  const icons = loadIconsModule(source);
  for (const name of ICON_NAMES) {
    assert.ok(typeof icons.ICONS[name] === "string", `missing icon ${name}`);
    assert.match(icons.ICONS[name], /<(path|circle|rect|line|polyline|polygon)/);
    assert.doesNotMatch(icons.ICONS[name], /<svg/);
  }
});

test("repo 內已提交的 renderer/js/icons.js 與目前產出一致", () => {
  const committed = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "js", "icons.js"),
    "utf8"
  );
  assert.equal(committed, buildIconsSource());
});

test("renderer 用到的每個 data-lucide 名稱都在 ICON_NAMES 內", () => {
  const rendererDir = path.join(__dirname, "..", "renderer");
  const used = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|js)$/.test(entry.name) && entry.name !== "icons.js") {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(/data-lucide=["']([a-z0-9-]+)["']/g)) used.add(m[1]);
        for (const m of text.matchAll(/data-lucide["'],\s*["']([a-z0-9-]+)["']/g)) used.add(m[1]);
      }
    }
  };
  walk(rendererDir);
  for (const name of used) {
    assert.ok(ICON_NAMES.includes(name), `icon "${name}" used but not in ICON_NAMES`);
  }
});
