/*
 * i18n 的三個不變式。這支的價值在於：這類錯誤在執行期是**無聲的**
 * （介面上冒出一個 key 名稱，或某個語言少一句話），不會有人回報。
 */
const fs = require("fs");
const path = require("path");
const en = require("../src/i18n/en.js");
const zhTW = require("../src/i18n/zh-tw.js");
const { createTranslator } = require("../src/i18n/index.js");

let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};

/* 1. 英文是參考語言：其他語言不能有英文沒有的 key（那代表打錯字或已經被刪掉） */
const orphans = Object.keys(zhTW).filter((k) => !(k in en));
eq("zh-TW 沒有孤兒 key", orphans, []);

/* 2. 佔位字要對得起來：同一個 key 的 {var} 在各語言必須一致，
      不然換語言就會出現「有變數沒被代換」的字串 */
const vars = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();
const mismatched = Object.keys(zhTW)
  .filter((k) => k in en)
  .filter((k) => JSON.stringify(vars(en[k])) !== JSON.stringify(vars(zhTW[k])));
eq("各語言的佔位字一致", mismatched, []);

/* 3. 程式碼裡用到的 key 都要存在於英文檔 —— 漏一個就會在介面上印出 key 名稱。
      設定頁也要掃：它的 t() 呼叫跟 main.js 一樣多，漏掉同樣會印出 key。 */
const src = ["main.js", "settings/tab.js"]
  .map((f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8"))
  .join("\n");
const used = new Set();
for (const m of src.matchAll(/\bt\(\s*"([\w.]+)"/g)) used.add(m[1]);
for (const m of src.matchAll(/\["(help\.[\w.]+)"\]/g)) used.add(m[1]);
for (const m of src.matchAll(/(?:descKey|noteKey|labelKey):\s*"([\w.]+)"/g)) used.add(m[1]);
for (const m of src.matchAll(/\[\s*"[^"]*",\s*"((?:help|menu)\.[\w.]+)"\s*\]/g)) used.add(m[1]);
const undefinedKeys = [...used].filter((k) => !(k in en)).sort();
eq("main.js 用到的 key 都在 en.js 裡（共 " + used.size + " 個）", undefinedKeys, []);

/* 4. 翻譯器本身 */
const t = createTranslator("en");
eq("英文直接命中", t("notice.openFailed"), en["notice.openFailed"]);
eq("代換變數", t("notice.copied", null, { text: "a.md" }), "Copied: a.md");
eq("沒有的 key 退回 fallback", t("nope.nope", "fallback text"), "fallback text");
eq("連 fallback 都沒有就回 key 本身（開發時看得見）", t("nope.nope"), "nope.nope");

/* zh-TW 走翻譯、缺的退回英文 */
global.window = { localStorage: { getItem: () => "zh-TW" } };
const tz = createTranslator("auto");
eq("跟著 Obsidian 的語言", tz("notice.openFailed"), zhTW["notice.openFailed"]);
const onlyEn = Object.keys(en).find((k) => !(k in zhTW));
if (onlyEn) eq("缺翻譯時退回英文", tz(onlyEn), en[onlyEn]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
