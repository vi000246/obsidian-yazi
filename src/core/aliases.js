/*
 * frontmatter 的別名。Obsidian 認 `aliases`（正式）與 `alias`（舊寫法）；值可以是清單、
 * 單一字串，或逗號分隔的一個字串（舊版 Obsidian 會這樣存）。
 * 只有「整個值是一個字串」才照逗號切 —— 清單裡的元素本來就是完整的一個，
 * `["Foo, Inc"]` 不該被切成兩個。
 */
function aliasesOf(fm) {
  if (!fm || typeof fm !== "object") return [];
  const out = [];
  const add = (s) => {
    const v = String(s).trim();
    if (v && !out.includes(v)) out.push(v);
  };
  for (const key of ["aliases", "alias"]) {
    const v = fm[key];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      for (const x of v) if (x !== null && x !== undefined) add(x);
    } else {
      for (const part of String(v).split(",")) add(part);
    }
  }
  return out;
}

module.exports = { aliasesOf };
