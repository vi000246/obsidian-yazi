/*
 * gf / gd 的關鍵字語意：
 *   1. 空格 = AND（每個 token 都要命中），跟全文搜尋 gt 一致
 *   2. 名稱（檔名 / 資料夾名 / 別名）命中的排在「只有路徑命中」的前面
 *
 * 第 2 條是 gd 的關鍵：父資料夾的名字必然出現在所有後代的 path 裡，
 * 只比 path 的話搜 "projects" 會被 Projects/ 底下每一層淹掉。
 *
 * stub 把 prepareFuzzySearch 設成 null，所以走的是小寫子字串的退路比對器 ——
 * 分數可預測（score = -命中位置），排序才驗得動。
 */
const Module = require("module");
const PLAT = { isWin: true, isDesktopApp: true };
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } },
  PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } },
  Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } },
  Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: PLAT, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const probe = require(require("./_probe.js").probePath()).__test;
const { YaziModal, queryTokens, allOf } = probe;

/* 產品程式碼就是這樣組比對器的（見 buildSearchListRaw），測試走同一條路 */
const mm = (q) => allOf(queryTokens(q));

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want))); };

/* ── 假 vault ── */
const dir = (path) => ({ path, name: path.split("/").pop(), children: [] });
const file = (path) => ({ path, name: path.split("/").pop(), extension: path.split(".").pop() });

const FOLDERS = ["Projects", "Projects/notes", "Projects/notes/sub", "Projects/alpha", "Other/notes", "Archive/Old Projects"].map(dir);
const FILES = ["Projects/a.md", "Daily/2024-01-01.md", "回顧/x.md"].map(file);
const ALIASES = { "Daily/2024-01-01.md": ["專案回顧"] };

/*
 * 全域排序刻意設成 ctime 倒序 —— 那正是使用者實際的設定，也是「相關度被蓋掉」
 * 那個 bug 的來源。搜尋有自己的 sortSearch（預設 natural）之後，它就不該再影響結果。
 */
const fakePlugin = (over) => ({ data: Object.assign({
  sort: { field: "ctime", reverse: true, foldersFirst: true },
  sortSearch: { field: "natural", reverse: false, foldersFirst: true },
}, over) });

const ALL = FOLDERS.concat(FILES);

const mk = (kind, q, over) => {
  const m = Object.assign(Object.create(YaziModal.prototype), {
    view: "search", searchKind: kind, searchQuery: q, facets: [], scopePath: "",
    listItems: [], listIndex: 0, listFilter: "",
    t: (k, d) => d,
    plugin: fakePlugin(over),
    app: {
      vault: {
        getAllLoadedFiles: () => ALL,
        getFiles: () => FILES,
        getAbstractFileByPath: (p) => ALL.find((x) => x.path === p) || null,
      },
      metadataCache: { getFileCache: (f) => ({ frontmatter: ALIASES[f.path] ? { aliases: ALIASES[f.path] } : null }) },
    },
  });
  // 走完整條路（含 refineList）—— 相關度就是在那一步被全域排序蓋掉的
  m.buildSearchList();
  return m;
};
const paths = (m) => m.listItems.map((it) => it.path);

/* ── 1. gd 搜單一關鍵字：叫這個名字的排最前，底下的後代排後面 ── */
eq("gd 'projects'：名稱命中的兩筆在前，Projects/ 底下的後代在後",
  paths(mk("dir", "projects")),
  ["Projects", "Archive/Old Projects", "Projects/notes", "Projects/notes/sub", "Projects/alpha"]);

/* ── 2. gd 空格 = AND，而且名稱命中優先 ── */
eq("gd 'projects notes'：兩個 token 都要命中（Other/notes 被排除）",
  paths(mk("dir", "projects notes")),
  ["Projects/notes", "Projects/notes/sub"]);

/* ── 3. gf：別名命中算名稱命中 ── */
const g = mk("file", "回顧");
eq("gf '回顧'：靠別名命中的排在只有路徑命中的前面", paths(g), ["Daily/2024-01-01.md", "回顧/x.md"]);
eq("gf：靠別名命中的那筆顯示別名", g.listItems[0].label, "專案回顧");

/* ── 4. 單一 token 的行為要跟切 token 之前一模一樣 ── */
eq("gf 單字：沒有名稱命中時純照分數（命中位置越前面越高）",
  paths(mk("file", "a.md")), ["Projects/a.md"]);

/* ── 5. 比對器本身 ── */
eq("空查詢：全部命中、分數 0", mm("")("whatever"), { score: 0, matches: [] });
const one = queryTokens("ab");
eq("單 token 直通：直接回那個比對器，不多包一層", allOf(one) === one[0], true);
eq("單 token：命中位置決定分數", mm("ab")("xxab").score, -2);
eq("單 token：沒命中回 null", mm("ab")("zzz"), null);
eq("兩個 token 都要命中", mm("a b")("xaybz") ? "hit" : "miss", "hit");
eq("少一個 token 就不算命中", mm("a q")("xaybz"), null);
eq("兩個 token 的分數是相加", mm("a b")("xaybz").score, -1 + -3);
eq("前後多餘空白不會變成空 token", queryTokens("  a  b  ").length, 2);

/* ── 6. 搜尋結果有自己的排序，不被全域排序蓋掉 ── */
const files = Object.assign(Object.create(YaziModal.prototype), { view: "files", plugin: fakePlugin() });
const search = Object.assign(Object.create(YaziModal.prototype), { view: "search", plugin: fakePlugin() });
eq("檔案瀏覽讀 data.sort", files.sortCfg().field, "ctime");
eq("搜尋檢視讀 data.sortSearch", search.sortCfg().field, "natural");

/* 上面 1~5 的排序斷言本身就是這條的證據：全域是 ctime 倒序，結果仍照相關度排 */
eq("全域 ctime 倒序時，gd 結果仍照相關度（名稱命中優先）",
  paths(mk("dir", "projects"))[0], "Projects");

/* 在搜尋結果裡改排序：只動 sortSearch，檔案瀏覽那份不受影響 */
const sv = Object.assign(Object.create(YaziModal.prototype), {
  view: "search", plugin: fakePlugin(), listItems: [], listIndex: 0, listFilter: "",
  t: (k, d) => d, render() {}, buildSearchList() {},
});
sv.plugin.setSort = function (cfg, forSearch) { if (forSearch) this.data.sortSearch = cfg; else this.data.sort = cfg; };
sv.saveSort({ field: "name", reverse: false, foldersFirst: true });
eq("在搜尋結果裡改排序只寫 sortSearch", sv.plugin.data.sortSearch.field, "name");
eq("在搜尋結果裡改排序不動檔案瀏覽的那份", sv.plugin.data.sort.field, "ctime");

/* 但「在搜尋結果裡重新排序」這個功能要還在（saveSort 會特地重建搜尋清單） */
const named = mk("dir", "projects", { sortSearch: { field: "name", reverse: false, foldersFirst: true } });
eq("搜尋排序明確選了就照樣重排（筆數不變）", named.listItems.length, 5);
eq("搜尋排序明確選了就照樣重排（順序跟相關度不同）",
  JSON.stringify(paths(named)) !== JSON.stringify(paths(mk("dir", "projects"))), true);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
