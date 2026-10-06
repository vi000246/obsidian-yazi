/*
 * gf 的 task id 捷徑：輸入「看起來像 task id」時，用 frontmatter 的 `id` 找筆記。
 *
 * task 筆記長這樣：frontmatter 有 `type: task` 與 `id: OB-84`（前綴＋連字號＋數字）。
 * 不同前綴是各自獨立的流水號，所以同一個數字可能兩邊都有（OB-84 與 SP-84）。
 *
 * 認得的輸入形狀（整串，前後空白不算）：
 *   84        純數字 → 比對所有前綴的數字部分
 *   ob84      前綴＋數字，大小寫不拘
 *   OB-84     連字號可有可無
 * 其他形狀（多個字、混了別的字元）一律不算 id，gf 照原本的模糊搜尋走。
 *
 * 為什麼靠 frontmatter 而不是檔名：檔名雖然慣例上以 id 開頭，但那是慣例，
 * 改名、手打錯字都會讓它跟 id 脫鉤；id 欄位才是單號的單一來源。
 */

// 數字比的是「值」：084 跟 84 是同一號
const ID_QUERY = /^([a-z]+)?-?(\d+)$/i;
const ID_VALUE = /^([a-z]+)-(\d+)$/i;

/** 輸入像 id 就回 { prefix, num }（prefix 是大寫或 null），不像就回 null */
function parseTaskIdQuery(q) {
  const s = String(q == null ? "" : q).trim();
  const m = ID_QUERY.exec(s);
  if (!m) return null;
  // 只有連字號沒有前綴（"-84"）不是人會打的 id 形狀
  if (!m[1] && s.startsWith("-")) return null;
  return { prefix: m[1] ? m[1].toUpperCase() : null, num: parseInt(m[2], 10) };
}

/** frontmatter 是 task 且有合法 id 就回 { prefix, num, id }，否則 null */
function taskIdOf(fm) {
  if (!fm || typeof fm !== "object") return null;
  if (String(fm.type == null ? "" : fm.type).trim().toLowerCase() !== "task") return null;
  const id = String(fm.id == null ? "" : fm.id).trim();
  const m = ID_VALUE.exec(id);
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), num: parseInt(m[2], 10), id: id };
}

/** 這份 frontmatter 是不是查詢要的那張單 */
function matchesTaskId(fm, query) {
  if (!query) return false;
  const t = taskIdOf(fm);
  if (!t || t.num !== query.num) return false;
  return !query.prefix || t.prefix === query.prefix;
}

module.exports = { parseTaskIdQuery, taskIdOf, matchesTaskId };
