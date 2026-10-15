/*
 * core/bookmarknote.js：書籤筆記的格式、只改動到的那一行、合併與搬家。
 *
 * 這支最在意的是「沒動到的行一個位元組都不變」—— 那是兩台機器各改一個書籤時
 * git 能逐行合併的前提。所以除了比對解析結果，也直接比對前後文字的逐行差異，
 * 最後再用真的 `git merge-file` 做一次三方合併。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const N = require("../src/core/bookmarknote.js");

let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};

/* 假的解析器：wikilink 補 .md 當路徑，反引號就是路徑本身 */
const pathOf = (e) => (e.kind === "path" ? e.ref : /\.\w+$/.test(e.ref) ? e.ref : e.ref + ".md");
const FOLDERS = new Set(["100 工作/projects", "100 工作", "/"]);
const targetFor = (p) => (FOLDERS.has(p) ? "`" + p + "`" : "[[" + p.replace(/\.md$/, "") + "]]");
const pick = (e) => e && { key: e.key, kind: e.kind, ref: e.ref, name: e.name };

/* 兩份文字的逐行差異：回傳 [被拿掉的行, 新增的行]（不含沒動到的） */
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const removed = A.filter((l) => !B.includes(l));
  const added = B.filter((l) => !A.includes(l));
  return [removed, added];
}

/* ── 1. 一行怎麼讀 ── */
eq("完整寫法：字母 · wikilink · 名稱", pick(N.parseLine("- d · [[200 Personal/日記/目錄]] · 日記目錄")),
   { key: "d", kind: "link", ref: "200 Personal/日記/目錄", name: "日記目錄" });
eq("資料夾用反引號路徑", pick(N.parseLine("- p · `100 工作/projects` · 工作專案")),
   { key: "p", kind: "path", ref: "100 工作/projects", name: "工作專案" });
eq("字母與名稱都可以省略", pick(N.parseLine("- [[讀書清單]]")), { key: null, kind: "link", ref: "讀書清單", name: null });
eq("手寫只用空白分隔也認得", pick(N.parseLine("- d [[x]] 我的筆記")), { key: "d", kind: "link", ref: "x", name: "我的筆記" });
eq("冒號與連字號當分隔", pick(N.parseLine("* 7: [[x]] - 名稱")), { key: "7", kind: "link", ref: "x", name: "名稱" });
eq("沒有空白的 · 也認得", pick(N.parseLine("- d·[[x]]·名稱")), { key: "d", kind: "link", ref: "x", name: "名稱" });
eq("wikilink 的別名當名稱", pick(N.parseLine("- [[a/b|別名]]")), { key: null, kind: "link", ref: "a/b", name: "別名" });
eq("後面寫的名稱比別名優先", pick(N.parseLine("- [[a/b|別名]] · 名稱")).name, "名稱");
eq("#標題與 ^區塊不算路徑", [N.parseLine("- [[a#標題]]").ref, N.parseLine("- [[b^abc]]").ref], ["a", "b"]);
eq("名稱開頭的連字號不被吃掉（後面沒空白就不是分隔）", N.parseLine("- [[x]] -5 度").name, "-5 度");
eq("資料夾路徑去掉頭尾斜線", N.parseLine("- `/100 工作/`").ref, "100 工作");
eq("vault 根目錄", N.parseLine("- r · `/` · 根").ref, "/");
eq("縮排的清單項也算", N.parseLine("    - [[x]]").ref, "x");
for (const [label, line] of [
  ["標題", "# Bookmarks"],
  ["一般文字", "這是說明 [[x]]"],
  ["待辦", "- [ ] 待辦 [[x]]"],
  ["清單項開頭是數字串", "- 2026 [[x]]"],
  ["指向自己的連結", "- [[#標題]]"],
  ["git 衝突標記", "<<<<<<< HEAD"],
  ["嵌入", "- ![[圖.png]]"],
  ["空行", ""],
]) eq("不是書籤：" + label, N.parseLine(line), null);

/* ── 2. 整份筆記：frontmatter 與程式碼區塊裡的不算 ── */
const withNoise = [
  "---",
  "tags: [x]",
  "- [[在 frontmatter 裡]]",
  "---",
  "# 書籤",
  "",
  "格式範例：",
  "```",
  "- d · [[範例]] · 不是真的書籤",
  "```",
  "- d · [[真的]] · 一號",
  "",
].join("\n");
eq("frontmatter 與 ``` 裡的不算書籤", N.parseNote(withNoise).entries.map((e) => e.ref), ["真的"]);
eq("沒收尾的 --- 不當 frontmatter", N.parseNote("---\n- [[a]]\n").entries.map((e) => e.ref), ["a"]);

/* ── 3. 原樣寫回：換行字元、檔尾有沒有換行都不變 ── */
for (const [label, s] of [
  ["LF", "# B\n\n- [[a]]\n"],
  ["CRLF", "# B\r\n\r\n- [[a]]\r\n"],
  ["混用", "# B\r\n- [[a]]\n- [[b]]\r\n"],
  ["檔尾沒有換行", "- [[a]]"],
  ["空檔", ""],
]) eq("原樣寫回：" + label, N.noteText(N.parseNote(s)), s);

/* ── 4. 新增：接在最後一個書籤後面，其他行不動 ── */
const base = [
  "# Bookmarks",
  "說明文字，外掛不該動它。",
  "",
  "- d · [[200 Personal/日記/目錄]] · 日記",
  "看不懂的一行 ✱",
  "- t · [[650 Projects/越野跑/🏠 dashboard]] · 越野跑",
  "- `100 工作/projects` · 工作專案",
  "",
  "結尾的說明。",
  "",
].join("\n");

let doc = N.parseNote(base);
eq("讀出三個書籤", N.noteBookmarks(doc, pathOf).map((b) => [b.key, b.path, b.name]), [
  ["d", "200 Personal/日記/目錄.md", "日記"],
  ["t", "650 Projects/越野跑/🏠 dashboard.md", "越野跑"],
  [null, "100 工作/projects", "工作專案"],
]);

doc = N.parseNote(base);
eq("新增回傳 true", N.upsertEntry(doc, "300 Sport/訓練.md", "訓練", targetFor, pathOf), true);
let after = N.noteText(doc);
eq("新增：只多一行、沒有行被改掉", lineDiff(base, after), [[], ["- [[300 Sport/訓練]] · 訓練"]]);
eq("新增：接在最後一個書籤後面", after.split("\n")[7], "- [[300 Sport/訓練]] · 訓練");

/* ── 5. 改名：只改那一行 ── */
doc = N.parseNote(base);
eq("同路徑再加一次＝改名，回傳 false", N.upsertEntry(doc, "200 Personal/日記/目錄.md", "日記目錄", targetFor, pathOf), false);
after = N.noteText(doc);
eq("改名：只換掉那一行", lineDiff(base, after),
   [["- d · [[200 Personal/日記/目錄]] · 日記"], ["- d · [[200 Personal/日記/目錄]] · 日記目錄"]]);

/* ── 6. 刪除：只拿掉那一行；重複的一起拿 ── */
doc = N.parseNote(base);
eq("刪掉一行", N.removeEntry(doc, "650 Projects/越野跑/🏠 dashboard.md", pathOf), 1);
eq("刪除：其他行原樣保留（含看不懂的那行）", lineDiff(base, N.noteText(doc)),
   [["- t · [[650 Projects/越野跑/🏠 dashboard]] · 越野跑"], []]);
doc = N.parseNote("- [[a]] · 一\n- [[b]]\n- [[a]] · 合併後重複的\n");
eq("同一個路徑出現兩次：清單只算一筆（取第一行）", N.noteBookmarks(doc, pathOf).map((b) => b.name), ["一", null]);
N.removeEntry(doc, "a.md", pathOf);
eq("刪除時重複的那幾行一起拿掉", N.noteText(doc), "- [[b]]\n");

/* ── 7. 快捷字母：指定、搶、清除 ── */
doc = N.parseNote(base);
eq("搶走別人的字母：回傳原主", N.assignEntryKey(doc, "100 工作/projects", "d", pathOf), "200 Personal/日記/目錄.md");
eq("搶字母：只改到兩個書籤那兩行", lineDiff(base, N.noteText(doc)), [
  ["- d · [[200 Personal/日記/目錄]] · 日記", "- `100 工作/projects` · 工作專案"],
  ["- [[200 Personal/日記/目錄]] · 日記", "- d · `100 工作/projects` · 工作專案"],
]);
N.assignEntryKey(doc, "100 工作/projects", null, pathOf);
eq("清除字母", N.noteBookmarks(doc, pathOf).find((b) => b.path === "100 工作/projects").key, null);
doc = N.parseNote("- [[a|別名]]\n");
N.assignEntryKey(doc, "a.md", "q", pathOf);
eq("改字母時別名留在 wikilink 裡，不另外抄一份到後面", N.noteText(doc), "- q · [[a|別名]]\n");

/* ── 8. 沒有書籤的筆記：跟上面的內容隔一個空行 ── */
for (const [label, s, want] of [
  ["空檔", "", "- [[a]] · A\n"],
  ["只有標題", "# B\n", "# B\n\n- [[a]] · A\n"],
  ["標題後面已經有空行", "# B\n\n", "# B\n\n- [[a]] · A\n"],
  ["檔尾沒有換行", "# B", "# B\n\n- [[a]] · A"],
]) {
  doc = N.parseNote(s);
  N.upsertEntry(doc, "a.md", "A", targetFor, pathOf);
  eq("第一個書籤：" + label, N.noteText(doc), want);
}
doc = N.parseNote("- [[a]]");
N.upsertEntry(doc, "b.md", null, targetFor, pathOf);
eq("最後一行沒有換行時，新行接在後面、前一行補上換行", N.noteText(doc), "- [[a]]\n- [[b]]");

/* ── 9. 搬家：合併、不覆蓋、可以重跑 ── */
const fromJson = [
  { path: "100 工作/projects", name: "data.json 裡的名字", key: "w", added: 30 },
  { path: "新的.md", name: "後加的", key: "n", added: 20 },
  { path: "最舊.md", name: null, key: null, added: 10 },
];
doc = N.parseNote(base);
eq("筆記沒有的才加（3 筆裡有 1 筆筆記已經有）", N.mergeEntries(doc, fromJson, targetFor, pathOf), 2);
const merged = N.noteBookmarks(doc, pathOf);
eq("筆記已有的那筆不被 data.json 覆蓋（名稱、字母都照筆記）",
   pick(N.parseNote(N.noteText(doc)).entries.find((e) => e.ref === "100 工作/projects")),
   { key: null, kind: "path", ref: "100 工作/projects", name: "工作專案" });
eq("新加的照加入時間舊到新排、帶著字母與名稱", merged.slice(3).map((b) => [b.key, b.path, b.name]),
   [[null, "最舊.md", null], ["n", "新的.md", "後加的"]]);
const once = N.noteText(doc);
eq("再跑一次：一筆都不加", N.mergeEntries(doc, fromJson, targetFor, pathOf), 0);
eq("再跑一次：文字完全不變", N.noteText(doc), once);
eq("搬家：原本的行一行都沒被改", lineDiff(base, once)[0], []);

/* ── 10. 資料夾改名：反引號路徑跟著改，wikilink 不動（交給 Obsidian） ── */
doc = N.parseNote(base + "- `100 工作/projects/sub` · 子資料夾\n");
eq("改了兩行（本身＋底下的）", N.retargetEntries(doc, "100 工作", "100 Work"), 2);
eq("新路徑", N.noteBookmarks(doc, pathOf).filter((b) => b.kind === "path").map((b) => b.path),
   ["100 Work/projects", "100 Work/projects/sub"]);
eq("wikilink 那幾行沒動", N.noteText(doc).includes("- d · [[200 Personal/日記/目錄]] · 日記"), true);
eq("名字只是開頭相同的資料夾不受影響", N.movedPath("100 工作室/x", "100 工作", "100 Work"), null);

/* ── 11. git 合併後留下衝突標記：兩邊的書籤都讀得到，標記行原樣留著 ── */
const conflicted = "- [[a]]\n<<<<<<< HEAD\n- x · [[b]]\n=======\n- y · [[c]]\n>>>>>>> origin/main\n";
doc = N.parseNote(conflicted);
eq("衝突的兩邊都算書籤", N.noteBookmarks(doc, pathOf).map((b) => b.path), ["a.md", "b.md", "c.md"]);
N.assignEntryKey(doc, "a.md", "z", pathOf);
eq("改別行時衝突標記不動", N.noteText(doc), conflicted.replace("- [[a]]", "- z · [[a]]"));

/* ── 12. 兩台各改一個書籤：真的用 git 三方合併 ── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yazi-bm-"));
try {
  const docA = N.parseNote(base);
  N.upsertEntry(docA, "200 Personal/日記/目錄.md", "A 機改的名字", targetFor, pathOf);
  const docB = N.parseNote(base);
  N.assignEntryKey(docB, "100 工作/projects", "w", pathOf);
  const [fa, fo, fb] = ["a.md", "o.md", "b.md"].map((f) => path.join(tmp, f));
  fs.writeFileSync(fa, N.noteText(docA));
  fs.writeFileSync(fo, base);
  fs.writeFileSync(fb, N.noteText(docB));
  const r = spawnSync("git", ["merge-file", "-p", fa, fo, fb], { encoding: "utf8" });
  eq("git merge-file 跑得起來", r.error ? String(r.error) : "ok", "ok");
  eq("兩台各改一個書籤：git 合併沒有衝突", r.status, 0);
  const res = N.noteBookmarks(N.parseNote(r.stdout || ""), pathOf);
  eq("合併結果兩邊的修改都在", [res[0].name, res[2].key], ["A 機改的名字", "w"]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── 13. 設定頁填的路徑 ── */
eq("空白＝存 data.json", N.normalizeNotePath("   "), "");
eq("沒有 .md 就補上", N.normalizeNotePath("600 Utility/yazi-bookmarks"), "600 Utility/yazi-bookmarks.md");
eq("檔名裡有點也照樣補", N.normalizeNotePath("書籤 v0.6"), "書籤 v0.6.md");
eq("反斜線、頭尾斜線、重複斜線", N.normalizeNotePath("\\600 Utility//書籤.md/"), "600 Utility/書籤.md");

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
