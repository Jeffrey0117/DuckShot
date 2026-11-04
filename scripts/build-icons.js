// 從 lucide-static 抽出專案實際用到的 icon，產出零依賴的 renderer/js/icons.js。
// 用法：node scripts/build-icons.js（產出已 commit，使用者端不需執行）。
// 為什麼不直接載 lucide：CDN 載入在離線/老機器上是啟動瓶頸，且 createIcons() 每次掃整份文件；
// 這裡只帶 ~30 個 icon 的 path 內容，並提供只掃指定根節點的 createIcons。
const fs = require("fs");
const path = require("path");

const ICON_NAMES = [
  "alert-circle",
  "alert-triangle",
  "camera",
  "check-circle",
  "copy",
  "cpu",
  "edit",
  "eye",
  "folder",
  "folder-open",
  "hard-drive",
  "image",
  "info",
  "minimize-2",
  "minus",
  "monitor",
  "moon",
  "panel-left",
  "pin",
  "plus",
  "refresh-cw",
  "search",
  "settings",
  "square",
  "sun",
  "trash-2",
  "type",
  "upload-cloud",
  "x",
];

function extractInner(svgText) {
  const open = svgText.indexOf(">", svgText.indexOf("<svg"));
  const close = svgText.lastIndexOf("</svg>");
  return svgText
    .slice(open + 1, close)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("");
}

function buildIconsSource() {
  const iconsDir = path.join(__dirname, "..", "node_modules", "lucide-static", "icons");
  const icons = {};
  for (const name of ICON_NAMES) {
    const svg = fs.readFileSync(path.join(iconsDir, `${name}.svg`), "utf8");
    icons[name] = extractInner(svg);
  }
  const json = JSON.stringify(icons, null, 2);
  return `// 自動產生：node scripts/build-icons.js（lucide-static 子集，ISC 授權）。請勿手改。
(function () {
  const ICONS = ${json};

  const SVG_NS = "http://www.w3.org/2000/svg";

  function render(el, name) {
    const inner = ICONS[name];
    if (!inner) return null;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("xmlns", SVG_NS);
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = inner;
    // 保留原 <i> 的 class 與 data-lucide，行為與 lucide 相同（之後可再次 createIcons 換圖）
    const keep = (el.getAttribute("class") || "")
      .split(/\\s+/)
      .filter((c) => c && !c.startsWith("lucide"))
      .join(" ");
    svg.setAttribute("class", ("lucide lucide-" + name + " " + keep).trim());
    svg.setAttribute("data-lucide", name);
    for (const attr of el.attributes) {
      if (attr.name !== "class" && attr.name !== "data-lucide") svg.setAttribute(attr.name, attr.value);
    }
    el.replaceWith(svg);
    return svg;
  }

  // 只掃 root（預設整份文件）底下的 [data-lucide]；已是 <svg> 且名稱相同就跳過
  function createIcons(options) {
    const root = (options && options.root) || document;
    const nodes = root.querySelectorAll ? root.querySelectorAll("[data-lucide]") : [];
    const targets = [];
    if (root !== document && root.matches && root.matches("[data-lucide]")) targets.push(root);
    nodes.forEach((n) => targets.push(n));
    for (const el of targets) {
      const name = el.getAttribute("data-lucide");
      if (el.tagName === "svg") {
        if (el.getAttribute("class") && el.getAttribute("class").includes("lucide-" + name)) continue;
      }
      render(el, name);
    }
  }

  window.DuckIcons = { ICONS, createIcons, render };
  window.lucide = { createIcons };
})();
`;
}

if (require.main === module) {
  const out = path.join(__dirname, "..", "renderer", "js", "icons.js");
  fs.writeFileSync(out, buildIconsSource());
  console.log(`wrote ${out} (${ICON_NAMES.length} icons)`);
}

module.exports = { ICON_NAMES, buildIconsSource, extractInner };
