// 英文黏字斷詞：把 OCR 漏掉空格而黏在一起的英文單字拆開
// （remakewas → remake was、christianityingeneral → christianity in general）。
// 用頻率排序的字典 + 動態規劃，偏好常見字、避免亂拆；只在「整段不是單字、且能全拆成字典字」時才拆。
const fs = require("fs");
const path = require("path");

let RANK = null; // Map<word, rank>（rank 越小＝越常見）；lazy 載入

function loadDict() {
  if (RANK) return RANK;
  RANK = new Map();
  try {
    const file = path.join(__dirname, "en-words.txt");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const w = lines[i].trim();
      if (w) RANK.set(w, i + 1);
    }
  } catch (e) {
    console.warn("[wordsplit] 字典載入失敗:", e.message);
  }
  return RANK;
}

// 單字成本：越常見越便宜（log(rank)）；未知字回傳 Infinity
function wordCost(rank) {
  return Math.log(rank + 1);
}

// 把一串純小寫字母拆成字典字陣列；無法全拆成已知字則回傳 null。
// 回傳各段「長度」，方便外層用原始字串切片以保留大小寫。
function segment(lower) {
  const dict = loadDict();
  const n = lower.length;
  // dp[i] = 拆 lower[0..i) 的最小成本；back[i] = 上一個切點
  const dp = new Array(n + 1).fill(Infinity);
  const back = new Array(n + 1).fill(-1);
  dp[0] = 0;
  // 單一片段最長長度（避免 O(n^2) 過頭；最長英文字約 20 餘）
  const MAX_WORD = 22;
  for (let i = 1; i <= n; i++) {
    const start = Math.max(0, i - MAX_WORD);
    for (let j = start; j < i; j++) {
      if (dp[j] === Infinity) continue;
      const piece = lower.slice(j, i);
      const rank = dict.get(piece);
      if (rank === undefined) continue;
      const cost = dp[j] + wordCost(rank);
      if (cost < dp[i]) {
        dp[i] = cost;
        back[i] = j;
      }
    }
  }
  if (dp[n] === Infinity) return null; // 無法全拆成已知字

  const lengths = [];
  let i = n;
  while (i > 0) {
    const j = back[i];
    lengths.unshift(i - j);
    i = j;
  }
  return lengths;
}

// 對單一字母串嘗試斷詞，保留原始大小寫；不該拆則回傳原字串。
function splitRun(run) {
  if (run.length < 4) return run; // 太短不冒險
  const lower = run.toLowerCase();
  const dict = loadDict();
  // 整段本身是字典字 → 一律不拆（保護 into、input、income… 等真詞；
  // 代價是少數與人名相同的黏字如 andi 會保留，但絕不破壞真詞，這個取捨較安全）
  if (dict.has(lower)) return run;
  const lengths = segment(lower);
  if (!lengths || lengths.length < 2) return run; // 拆不開或只有一段
  // 還原大小寫並以空白接回
  const parts = [];
  let pos = 0;
  for (const len of lengths) {
    parts.push(run.slice(pos, pos + len));
    pos += len;
  }
  return parts.join(" ");
}

// 修正一段 OCR 文字的空格問題（僅針對拉丁文字）：
// 1) 標點後缺空格（me,i → me, i；be.i → be. i）
// 2) 黏在一起的英文單字斷詞
function fixSpacing(text) {
  if (!text) return text;
  // 標點後直接接小寫字母 → 補一個空格（小寫幾乎都是漏空格；數字/大寫如 3.14、U.S.A 不動）
  let out = text.replace(/([.,;:!?])([a-z])/g, "$1 $2");
  // 逐 token 處理字母串斷詞
  out = out.replace(/[A-Za-z]+/g, (run) => splitRun(run));
  return out;
}

module.exports = { fixSpacing, splitRun };
