/*
 * i18n。
 *
 * ── 規則 ──
 * 1. **英文是預設也是唯一的必需語言**。翻譯檔可以缺字，缺的就退回英文；英文缺的
 *    才退回 key 本身（那是給開發時看的訊號，不是給使用者看的）。
 * 2. 每個 t() 呼叫都帶 fallback 字串：`t("notice.openFailed", "Open failed")`。
 *    這樣就算翻譯檔整個載入失敗，介面仍然是完整的英文，而不是一堆 key。
 *    也讓「這個 key 是什麼意思」在呼叫端就讀得到，不必翻到語言檔去對。
 * 3. 語言碼跟著 Obsidian 走（window.localStorage.language），不自己做偵測。
 */
const en = require("./en.js");
const zhTW = require("./zh-tw.js");

const CATALOGS = {
  en,
  "zh-TW": zhTW,
  /* Obsidian 的繁中語言碼是 zh-TW，簡中是 zh。簡中先指到繁中總比英文近一點，
     真的要簡中再開一份 —— 用機翻塞一份反而更難維護。 */
  "zh-tw": zhTW,
};

/** Obsidian 目前的語言（en / zh / zh-TW / ja …）。拿不到就當英文。 */
function obsidianLocale() {
  try {
    return window.localStorage.getItem("language") || "en";
  } catch (e) {
    return "en";
  }
}

/**
 * @param {string} setting  設定裡的 locale："auto" 或明確的語言碼
 * @returns {(key: string, fallback?: string, vars?: object) => string}
 */
function createTranslator(setting) {
  const code = !setting || setting === "auto" ? obsidianLocale() : setting;
  const table = CATALOGS[code] || CATALOGS[String(code).split("-")[0]] || null;

  return function t(key, fallback, vars) {
    let s = (table && table[key]) || en[key] || fallback || key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, (whole, k) =>
        Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : whole);
    }
    return s;
  };
}

/** 設定頁的語言下拉用。 */
const LOCALES = [
  { id: "auto", label: "Follow Obsidian" },
  { id: "en", label: "English" },
  { id: "zh-TW", label: "繁體中文" },
];

module.exports = { createTranslator, obsidianLocale, LOCALES, CATALOGS };
