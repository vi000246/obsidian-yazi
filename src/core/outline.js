/*
 * 大綱（go）：把 metadataCache 的 headings 變成清單項目，以及在預覽欄裡找到「第 n 個標題」。
 *
 * 兩邊都用**順序**對位，不用文字比對：渲染後 <h2> 的 textContent 少掉了 `**` 與 `[[ ]]`，
 * 跟 cache 裡的 heading 字串對不起來；但順序不會變 —— 預覓的截斷只砍尾巴，前面的
 * 標題還是第 0、1、2 個。找不到第 n 個就代表它在截斷點之後。
 */

/**
 * headings（metadataCache.getFileCache(file).headings）→ 清單項目。
 * depth 是相對這篇最淺那層的縮排量：從 H2 開始的筆記不該整份先空一格。
 */
function outlineItems(headings, untitled) {
  const hs = Array.isArray(headings) ? headings : [];
  if (!hs.length) return [];
  let min = 6;
  for (const h of hs) if (h.level < min) min = h.level;
  return hs.map((h, idx) => ({
    label: String(h.heading || "").trim() || untitled || "(untitled)",
    level: h.level,
    depth: Math.max(0, Math.min(5, h.level - min)),
    line: h.position && h.position.start ? h.position.start.line : 0,
    idx,
  }));
}

/**
 * 純文字預覽裡每個標題在第幾行（順序與 metadataCache 一致）。
 *   - 開頭的 frontmatter 整塊跳過（YAML 的 `# 註解` 不是標題）
 *   - fenced code 整塊跳過（```bash 裡的 `# 註解` 也不是）
 *   - 認 ATX（`# …`）與 setext（下一行全是 = 或 -；清單／引言／表格列不算）
 *   - `#tag` 不算：# 後面要有空白
 */
function headingLines(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let i = 0;
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    i = 1;
    while (i < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[i])) i++;
    i++;
  }
  let fence = null;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    const f = ln.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^\s{0,3}#{1,6}(\s|$)/.test(ln)) {
      out.push(i);
      continue;
    }
    const next = lines[i + 1];
    if (
      next !== undefined &&
      /^\s{0,3}(=+|-+)\s*$/.test(next) &&
      ln.trim() &&
      !/^\s{0,3}([-*+>|]|\d+[.)])(\s|$)/.test(ln)
    ) {
      out.push(i);
      i++;   // 底線那行不再看，否則 `---` 會被下一輪當成別的東西
    }
  }
  return out;
}

module.exports = { outlineItems, headingLines };
