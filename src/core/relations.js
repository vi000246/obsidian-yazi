/*
 * 關聯（gr）：把 frontmatter 裡的連結欄位變成分組清單。
 *
 * 設計上的三個決定：
 *
 * 1. **只讀一個方向，反向用推導的。** 規則寫 `parent`，"Children" 是掃全 vault 找出
 *    「誰的 parent 指著我」算出來的，不是另一個欄位。兩邊都存一定會漂 —— 有人只改
 *    一邊，之後就再也分不出哪邊才對。推導的成本是一次 metadataCache 走訪。
 * 2. **對稱關係（related）兩邊都算。** A 寫了 related: B，在 B 那邊也要看得到 A，
 *    否則「對稱」只是名字上的對稱。
 * 3. **有型別的連結與一般連結分開。** 一篇筆記可能有幾十條內文連結，混在一起的話
 *    `parent` 那一筆就被淹掉了 —— 而那筆正是你按 gr 想找的東西。
 *
 * 這支不碰 Obsidian API：vault 的部分由呼叫端用 ctx 餵進來（見 collectRelations）。
 */

/*
 * 一個欄位值裡的所有連結目標。
 *   - `[[path|alias]]` → path（別名與 #標題、^區塊 都切掉）
 *   - 清單 / 單一字串 / 一個字串裡好幾個 [[ ]] 都吃
 *   - 完全沒有 [[ ]] 的純字串，整串當成連結目標（有人就是寫 `parent: OB-19`）
 * 回傳的是「連結路徑」字串，還沒解析成檔案。
 */
function parseLinks(value) {
  const out = [];
  const add = (s) => {
    const v = String(s).split("|")[0].split("#")[0].split("^")[0].trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const one = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const x of v) one(x);
      return;
    }
    if (typeof v === "object") return;   // 不認得的結構，寧可不猜
    const s = String(v);
    const m = s.match(/\[\[([^\]]+)\]\]/g);
    if (m) {
      for (const link of m) add(link.slice(2, -2));
      return;
    }
    if (s.trim()) add(s);
  };
  one(value);
  return out;
}

/*
 * 規則 → 分組清單。
 *
 * rules: [{ field, label, inverse, symmetric }]
 *   field      要讀的 frontmatter 欄位
 *   label      正向那組的標題（例如 parent → "Parent"）
 *   inverse    反向那組的標題（例如 "Children"）；沒填就不算反向
 *   symmetric  true = 正反合成一組（related）
 *
 * ctx:
 *   fmOf(file)               該檔的 frontmatter（沒有就回 null）
 *   resolve(linkpath, from)  連結路徑 → 檔案（解析不到回 null）
 *   mdFiles()                要掃的檔案（推導反向用）
 *   linksTo(file)            指向這個檔的所有檔（一般反向連結）
 *   linksFrom(file)          這個檔指出去的所有檔（一般連結）
 *   labels                   { links, backlinks } 兩組一般連結的標題
 *
 * 回傳 [{ label, items: [file] }]，空的組不回。
 */
function collectRelations(file, rules, ctx) {
  const groups = [];
  const typed = new Set();          // 已經有型別的，就不要再出現在「一般連結」裡
  // untyped ＝一般連結那兩組（沒有型別）。呼叫端靠這個旗標決定要不要預設收合。
  const push = (label, files, untyped) => {
    const seen = new Set();
    const items = [];
    for (const f of files) {
      if (!f || f.path === file.path || seen.has(f.path)) continue;   // 指向自己的不列
      seen.add(f.path);
      typed.add(f.path);
      items.push(f);
    }
    if (items.length) groups.push({ label, items, untyped: !!untyped });
  };

  const fm = ctx.fmOf(file) || {};
  const forwardOf = (src, field) => {
    const sfm = ctx.fmOf(src);
    if (!sfm) return [];
    return parseLinks(sfm[field]).map((p) => ctx.resolve(p, src.path)).filter(Boolean);
  };

  for (const rule of rules || []) {
    if (!rule || !rule.field || rule.enabled === false) continue;
    const forward = parseLinks(fm[rule.field]).map((p) => ctx.resolve(p, file.path)).filter(Boolean);

    // 反向：誰的這個欄位指著我。symmetric 不需要 inverse 標題也要掃。
    let back = [];
    if (rule.symmetric || rule.inverse) {
      for (const other of ctx.mdFiles()) {
        if (other.path === file.path) continue;
        if (forwardOf(other, rule.field).some((f) => f.path === file.path)) back.push(other);
      }
    }

    if (rule.symmetric) push(rule.label || rule.field, forward.concat(back));
    else {
      push(rule.label || rule.field, forward);
      if (rule.inverse) push(rule.inverse, back);
    }
  }

  // 一般連結擺最後：有型別的已經被挑走，剩下的是內文連結
  const labels = ctx.labels || {};
  if (labels.backlinks) push(labels.backlinks, ctx.linksTo(file).filter((f) => !typed.has(f.path)), true);
  if (labels.links) push(labels.links, ctx.linksFrom(file).filter((f) => !typed.has(f.path)), true);

  return groups;
}

module.exports = { parseLinks, collectRelations };
