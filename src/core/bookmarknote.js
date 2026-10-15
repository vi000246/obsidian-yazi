/*
 * 書籤筆記：把書籤存成 vault 裡的一份 markdown 筆記，一行一個。
 *
 * ── 為什麼要有這條路 ──
 * 書籤原本只存在 plugin 自己的 data.json。那份檔案是**整份覆寫**的：兩台機器用同一個
 * vault 同步時，一台用記憶體裡的舊狀態存檔，就會把另一台剛加的書籤整份蓋掉，而且
 * 不會有任何衝突訊息（git 看到的只是一次正常的修改）。存成筆記之後：
 *   - 每次改書籤都**先讀磁碟上的現況、只改動到的那一行**再寫回，不會用舊狀態蓋新狀態
 *   - git 逐行合併：兩台各改一個書籤不會衝突
 *   - 檔案用 [[wikilink]]：改名或搬移時 Obsidian 會自己更新連結，書籤不會失效
 *   - 手機上、或直接打開筆記都能改
 *
 * ── 格式（一行一個）──
 *     - d · [[日記/目錄]] · 日記目錄          檔案：wikilink
 *     - p · `100 工作/projects` · 工作專案     資料夾：反引號包住的 vault 相對路徑
 *     - [[讀書清單]]                          快捷字母與名稱都可以省略
 * 快捷字母是一個英文字母或數字；名稱是目標後面剩下的整段文字。手寫時分隔符可以用
 * `·`、`:`、`|`、`-`，或只用空白。看不懂的行（標題、說明、空行、git 衝突標記）
 * **一律原樣保留** —— 這支只會改寫它認得、而且這次動到的那一行。
 * frontmatter 與 ``` 圍起來的程式碼區塊裡的東西不算書籤（說明裡可以放範例）。
 *
 * 這支是純函式：不碰 Obsidian。「這一行指向 vault 裡的哪個路徑」要靠 metadataCache
 * 解析 wikilink，所以由呼叫端傳 pathOf(entry) 進來；新增時要寫成什麼樣的目標字串
 * （wikilink 還是路徑）也由呼叫端的 targetFor(path) 決定。
 */

/* 一行書籤去掉清單符號之後的樣子：[字母 分隔] 目標 [分隔 名稱] */
const BULLET_RE = /^(\s*[-*+]\s+)(.*)$/;
const ENTRY_RE = /^(?:([A-Za-z0-9])(?:\s*[·:|]\s*|\s+))?(\[\[([^\[\]]+)\]\]|`([^`]+)`)(.*)$/;
/* 名稱前面的分隔符。`-` 與 `:` 後面要有空白才算分隔，免得吃掉名稱開頭的字 */
const NAME_SEP_RE = /^\s*(?:[·|—–]|[-:](?=\s|$))?\s*/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** 去掉 wikilink 的別名與標題／區塊參照，只留連結路徑 */
function splitLink(inner) {
  const bar = inner.indexOf("|");
  const link = bar >= 0 ? inner.slice(0, bar) : inner;
  const alias = bar >= 0 ? inner.slice(bar + 1).trim() : "";
  const hash = link.search(/[#^]/);
  return { ref: (hash >= 0 ? link.slice(0, hash) : link).trim(), alias };
}

/** 資料夾路徑的正規化：去掉頭尾斜線；空的＝ vault 根目錄 "/" */
function cleanPath(p) {
  const s = String(p || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  return s || "/";
}

/** 解析一行。不是書籤就回 null。 */
function parseLine(line) {
  const b = BULLET_RE.exec(line);
  if (!b) return null;
  const m = ENTRY_RE.exec(b[2]);
  if (!m) return null;
  const isLink = m[3] !== undefined;
  const link = isLink ? splitLink(m[3]) : null;
  if (isLink && !link.ref) return null;          // [[#標題]] 這種指向自己的連結不算
  const rest = m[5].replace(NAME_SEP_RE, "").trim();
  return {
    prefix: b[1],
    key: m[1] || null,
    target: m[2],
    kind: isLink ? "link" : "path",
    ref: isLink ? link.ref : cleanPath(m[4]),
    name: rest || (isLink && link.alias) || null,
    // 名稱是寫在目標後面的那段（不是別名）；改寫這一行時才知道要不要補回去
    trailing: rest || null,
  };
}

/**
 * 整份筆記 → { lines, ends, eol, entries }。
 * 每一行的換行字元分開存（ends），沒動到的行寫回去時一個位元組都不變 ——
 * 混用 CRLF／LF 的檔案也一樣。
 */
function parseNote(text) {
  const src = String(text == null ? "" : text);
  const parts = src ? src.split(/(?<=\n)/) : [];
  const lines = [];
  const ends = [];
  for (const p of parts) {
    const end = p.endsWith("\r\n") ? "\r\n" : p.endsWith("\n") ? "\n" : "";
    lines.push(p.slice(0, p.length - end.length));
    ends.push(end);
  }
  const doc = { lines, ends, eol: src.includes("\r\n") ? "\r\n" : "\n", entries: [] };
  scanEntries(doc);
  return doc;
}

/* 重新找出哪些行是書籤（插入或刪除行之後索引會位移，直接重掃最不容易錯） */
function scanEntries(doc) {
  const { lines } = doc;
  const entries = [];
  let i = 0;
  /* frontmatter：第一行是 --- 而且有收尾才算；沒收尾的話整份當內文 */
  if (lines[0] === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === "---" || lines[j] === "...") { i = j + 1; break; }
    }
  }
  let fence = null;
  for (; i < lines.length; i++) {
    const f = FENCE_RE.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const e = parseLine(lines[i]);
    if (e) {
      e.index = i;
      entries.push(e);
    }
  }
  doc.entries = entries;
  return doc;
}

function noteText(doc) {
  let out = "";
  for (let i = 0; i < doc.lines.length; i++) out += doc.lines[i] + doc.ends[i];
  return out;
}

/** 名稱只能是一行字 */
function cleanName(name) {
  const s = String(name == null ? "" : name).replace(/[\r\n]+/g, " ").trim();
  return s || null;
}

/** 書籤 → 一行文字。目標字串原樣保留（別名、#標題都還在） */
function formatEntry(e) {
  const name = cleanName(e.name);
  return (e.prefix || "- ") + (e.key ? e.key + " · " : "") + e.target + (name ? " · " + name : "");
}

/** 只改這一行：其他行的內容與換行字元都不動 */
function setEntry(doc, entry, patch) {
  const next = Object.assign({}, entry, patch);
  /* 名稱沒改、原本也沒寫在後面（用的是 wikilink 的別名）→ 不要把別名抄一份到後面 */
  if (!("name" in patch) && !entry.trailing) next.name = null;
  doc.lines[entry.index] = formatEntry(next);
  scanEntries(doc);
}

/**
 * 新增一行：接在最後一個書籤後面；還沒有任何書籤就接在檔尾（跟上面的內容隔一個空行）。
 * 原本檔尾沒有換行的話，新的那一行接手「沒有結尾換行」，前一行補上換行。
 */
function insertLine(doc, at, text) {
  const { lines, ends, eol } = doc;
  if (at >= lines.length) {
    if (lines.length && !ends[lines.length - 1]) {
      ends[lines.length - 1] = eol;
      lines.push(text);
      ends.push("");
    } else {
      lines.push(text);
      ends.push(eol);
    }
  } else {
    lines.splice(at, 0, text);
    ends.splice(at, 0, eol);
  }
}

function appendEntry(doc, fields) {
  const line = formatEntry({ prefix: "- ", key: fields.key || null, target: fields.target, name: fields.name });
  const last = doc.entries[doc.entries.length - 1];
  if (last) {
    insertLine(doc, last.index + 1, line);
  } else {
    let n = doc.lines.length;
    while (n > 0 && doc.lines[n - 1].trim() === "") n--;      // 檔尾的空行不算內容
    if (n > 0 && n < doc.lines.length) {
      insertLine(doc, n + 1, line);                            // 內容後面本來就有空行：接在它後面
    } else if (n > 0) {
      insertLine(doc, n, "");
      insertLine(doc, n + 1, line);
    } else {
      insertLine(doc, doc.lines.length, line);
    }
  }
  scanEntries(doc);
}

function removeLines(doc, indices) {
  for (const i of indices.slice().sort((a, b) => b - a)) {
    doc.lines.splice(i, 1);
    doc.ends.splice(i, 1);
  }
  scanEntries(doc);
}

/* ── 書籤層級的操作（pathOf(entry) → 這一行指向的 vault 路徑）── */

function entriesFor(doc, path, pathOf) {
  return doc.entries.filter((e) => pathOf(e) === path);
}

/**
 * 筆記 → plugin 用的書籤清單。同一個路徑出現兩次（例如兩台各加了一次、git 合併後）
 * 取第一行。`added` 用行號：新的書籤接在後面，所以「新到舊」＝行號大到小。
 */
function noteBookmarks(doc, pathOf) {
  const seen = new Set();
  const out = [];
  for (const e of doc.entries) {
    const path = pathOf(e);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, name: e.name, key: e.key, added: e.index, kind: e.kind, line: e.index });
  }
  return out;
}

/** 新增；已經有這個路徑就改名。回傳 true ＝新增 */
function upsertEntry(doc, path, name, targetFor, pathOf) {
  const hit = entriesFor(doc, path, pathOf)[0];
  const title = cleanName(name);
  if (hit) {
    if (title && title !== hit.name) setEntry(doc, hit, { name: title });
    return false;
  }
  appendEntry(doc, { target: targetFor(path), name: title, key: null });
  return true;
}

/** 刪掉指向這個路徑的每一行（重複的也一起），回傳刪了幾行 */
function removeEntry(doc, path, pathOf) {
  const idx = entriesFor(doc, path, pathOf).map((e) => e.index);
  if (idx.length) removeLines(doc, idx);
  return idx.length;
}

/**
 * 指定快捷字母（null ＝清除）。同一個字母只能屬於一個書籤：先從別人身上拿掉，
 * 回傳被搶走的那個路徑。只改動到的那幾行。
 */
function assignEntryKey(doc, path, key, pathOf) {
  let stolenFrom = null;
  for (const e of doc.entries.slice()) {
    const cur = doc.entries.find((x) => x.index === e.index);
    if (key && cur.key === key && pathOf(cur) !== path) {
      stolenFrom = pathOf(cur);
      setEntry(doc, cur, { key: null });
    }
  }
  const hit = entriesFor(doc, path, pathOf)[0];
  if (hit && (hit.key || null) !== (key || null)) setEntry(doc, hit, { key: key || null });
  return stolenFrom;
}

/** oldPath 被改名成 newPath 之後，p 的新路徑（p 是它本身或在它底下）；不受影響回 null */
function movedPath(p, oldPath, newPath) {
  if (!p || !oldPath) return null;
  if (p === oldPath) return newPath;
  if (p.startsWith(oldPath + "/")) return newPath + p.slice(oldPath.length);
  return null;
}

/**
 * 資料夾（或手寫成路徑的檔案）被改名或搬移：把反引號裡的路徑改成新的。
 * wikilink 不在這裡處理 —— Obsidian 自己會更新連結，兩邊都改會互相踩到。
 * 回傳改了幾行。
 */
function retargetEntries(doc, oldPath, newPath) {
  let n = 0;
  for (const e of doc.entries.slice()) {
    if (e.kind !== "path") continue;
    const cur = doc.entries.find((x) => x.index === e.index);
    const next = movedPath(cur.ref, oldPath, newPath);
    if (next === null || next === cur.ref) continue;
    setEntry(doc, cur, { target: "`" + next + "`" });
    n++;
  }
  return n;
}

/**
 * 把一批書籤併進筆記（搬家用）：筆記裡已經有的路徑**不動**（筆記是正本，不覆蓋），
 * 沒有的照加入時間舊到新接在後面。可以重複執行 —— 第二次什麼都不會加。
 * 回傳加了幾筆。
 */
function mergeEntries(doc, bookmarks, targetFor, pathOf) {
  const have = new Set(doc.entries.map((e) => pathOf(e)));
  const todo = (bookmarks || [])
    .filter((b) => b && b.path && !have.has(b.path))
    .slice()
    .sort((a, b) => (a.added || 0) - (b.added || 0));
  let n = 0;
  for (const b of todo) {
    if (have.has(b.path)) continue;                        // 同一批裡重複的
    appendEntry(doc, { target: targetFor(b.path), name: b.name, key: b.key || null });
    have.add(b.path);
    n++;
  }
  return n;
}

/**
 * 設定頁填進來的筆記路徑。空字串＝不用筆記（存 data.json）。
 * 不是 .md 結尾就補上 .md —— 書籤筆記一定要是 markdown，而檔名裡本來就可能有點
 * （`v0.6`），猜「這是不是別的副檔名」只會猜錯。補完的路徑會顯示回設定欄，看得到。
 */
function normalizeNotePath(input) {
  const p = String(input == null ? "" : input).trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!p) return "";
  return /\.md$/i.test(p) ? p : p + ".md";
}

module.exports = {
  parseLine,
  parseNote,
  noteText,
  formatEntry,
  noteBookmarks,
  upsertEntry,
  removeEntry,
  assignEntryKey,
  retargetEntries,
  mergeEntries,
  movedPath,
  cleanPath,
  normalizeNotePath,
};
