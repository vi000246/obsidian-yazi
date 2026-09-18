/*
 * Esc 的層次。
 *
 * 規則只有一條：**進新的一層就 push，Esc 就 pop，pop 不動就關視窗。**
 * 這支測的是那條規則涵蓋到的每一種轉場 —— 之前三套各自為政的返回機制
 * （outlineFrom / relStack / 什麼都沒有）每多一種轉場就多一個「Esc 退錯地方」的 bug。
 */
const Module = require("module");
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal } = require(require("./_probe.js").probePath()).__test;

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want))); };

const acts = [];
const mk = (over) => Object.assign(Object.create(YaziModal.prototype), {
  view: "files", mode: "nav", pending: null, showHelp: false, helpFilter: "",
  sug: null, sugField: null, facets: [], listItems: [], listIndex: 0, listFilter: "",
  layers: [], opening: false, composing: false, relFile: null, outlineFile: null,
  searchKind: "file", searchQuery: "", scopePath: "", cwd: null, cursorPath: null, filter: "",
  forceClose: () => acts.push("close"),
  clearSelection: () => false,
  buildList() { acts.push("build:" + this.view); },
  buildSearchList() { acts.push("build:search"); },
  endInput() {}, render() {}, swallow() {}, scope: { keys: [] },
  reopenComposer() { acts.push("composer"); this.composing = true; },
}, over);
const esc = (m) => { acts.length = 0; m.escapeBack(); return acts.slice(); };

/* ── 1. 沒有上一層 → 關視窗 ── */
eq("檔案檢視、堆疊空：Esc 關視窗", esc(mk()), ["close"]);
for (const v of ["bookmarks", "tabs", "recent", "frecency", "views", "outline", "relations"]) {
  eq("用命令直接開進 " + v + "（堆疊空）：Esc 關視窗", esc(mk({ view: v })), ["close"]);
}

/*
 * ── 1b. 搜尋結果比較特別：組合卡與結果是同一層的兩個階段 ──
 * Esc 先退回組合卡（條件留著可以改），再按才是離開整個搜尋。
 */
const res = mk({ view: "search", searchKind: "file" });
eq("搜尋結果：Esc 先退回組合卡", esc(res), ["composer"]);
eq("這時人在組合卡", res.composing, true);
eq("組合卡再按 Esc 才離開（堆疊空 → 關視窗）", esc(res), ["close"]);

eq("資料夾搜尋沒有組合卡，直接離開",
   esc(mk({ view: "search", searchKind: "dir" })), ["close"]);
eq("還在組合卡裡時不會又叫一次組合卡",
   esc(mk({ view: "search", searchKind: "file", composing: true })), ["close"]);
eq("輸入列有焦點時走 mode === search 那條，不是回組合卡",
   esc(mk({ view: "search", searchKind: "file", mode: "search" })), ["close"]);

/* 條件是用 Backspace 退的，Esc 不逐一拆掉（否則要按很多下才離得開） */
const keep = mk({ view: "search", searchKind: "file", facets: [{ id: "a" }, { id: "b" }] });
eq("有條件時 Esc 仍然是退回組合卡", esc(keep), ["composer"]);
eq("條件原封不動", keep.facets.length, 2);

/* ── 2. 有上一層 → 退回去，不關 ── */
const back = mk({ view: "bookmarks", layers: [{ view: "files", listItems: [], listIndex: 0 }] });
eq("從檔案檢視走進書籤：Esc 退回去而不是關", esc(back), []);
eq("退回檔案檢視、堆疊空了", [back.view, back.layers.length], ["files", 0]);
eq("再按一次才關", esc(back), ["close"]);

/* 退回清單時要重建（離開期間檔案可能被刪、書籤可能被移除） */
// 起點刻意不用 search：那個檢視的 Esc 會先退回組合卡（見 1b），測不到 pop
const rebuilt = mk({ view: "outline", layers: [{ view: "bookmarks", listItems: [{}, {}, {}], listIndex: 2, listFilter: "x" }] });
eq("退回清單檢視會重建那份清單", esc(rebuilt), ["build:bookmarks"]);
eq("過濾字也一起還原", [rebuilt.view, rebuilt.listFilter], ["bookmarks", "x"]);

const backToSearch = mk({ view: "outline", layers: [{ view: "search", listItems: [{}], listIndex: 0 }] });
eq("退回搜尋結果會重跑搜尋", esc(backToSearch), ["build:search"]);

/* 游標位置還原，但清單縮短時要夾回範圍內 */
const shrunk = mk({ view: "outline", layers: [{ view: "bookmarks", listItems: [], listIndex: 7 }],
  buildList() { this.listItems = [{}, {}]; } });
esc(shrunk);
eq("清單變短時游標夾回最後一筆", shrunk.listIndex, 1);

/* ── 3. 多層：一次退一層 ── */
const deep = mk({ view: "relations", layers: [
  { view: "files", listItems: [] },
  { view: "bookmarks", listItems: [] },
  { view: "relations", listItems: [], relFile: { path: "a.md" } },
] });
esc(deep);
eq("第一次退到關聯的上一個中心", [deep.view, deep.relFile.path, deep.layers.length], ["relations", "a.md", 2]);
esc(deep);
eq("第二次退到書籤", [deep.view, deep.layers.length], ["bookmarks", 1]);
esc(deep);
eq("第三次退到檔案檢視", [deep.view, deep.layers.length], ["files", 0]);
eq("第四次才關視窗", esc(deep), ["close"]);

/* ── 4. 從清單跳進 vault：view 是 files，但堆疊非空 → Esc 退回那份清單 ── */
const jumped = mk({ view: "files", layers: [{ view: "bookmarks", listItems: [{}] }] });
eq("在檔案檢視但有上一層：Esc 退回去而不是關", esc(jumped), ["build:bookmarks"]);
eq("回到書籤清單", jumped.view, "bookmarks");

/* ── 5. 更內層的東西優先 ── */
const help = mk({ view: "bookmarks", showHelp: true });
eq("說明頁開著時先關說明", esc(help), []);
eq("說明頁關了、視窗還在", [help.showHelp, help.view], [false, "bookmarks"]);
eq("再按一次才關視窗", esc(help), ["close"]);

const helpSearch = mk({ view: "files", showHelp: true, helpFilter: "book" });
eq("說明頁的搜尋比說明頁本身更內層", esc(helpSearch), []);
eq("先清掉搜尋，說明頁還在", [helpSearch.helpFilter, helpSearch.showHelp], ["", true]);

const pend = mk({ view: "bookmarks", pending: "g" });
eq("待接的多鍵前綴最內層", esc(pend), []);
eq("只取消前綴", [pend.pending, pend.view], [null, "bookmarks"]);

const sug = mk({ view: "search", sug: { items: [] } });
eq("建議列開著時先收建議", esc(sug), []);
eq("只收掉建議", [sug.sug, sug.view], [null, "search"]);

/*
 * ── 6. 三顆鍵三種語意 ──
 *   h    退回上一個地方；最底層就留在原地（絕不憑空變出檔案檢視）
 *   Esc  先收狀態、再退地方、最底層才關窗（上面各組測的就是這個）
 *   q    一律關窗
 */
const ev = (key) => ({ key, type: "keydown", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
const key = (m, k) => { acts.length = 0; m.handleKey(ev(k)); return acts.slice(); };
const bottom = () => mk({ view: "bookmarks", plugin: null });
const hasLayer = () => mk({ view: "bookmarks", plugin: null, layers: [{ view: "files", listItems: [] }] });

const hb = bottom();
eq("最底層按 h：不動、不關、不跳檔案檢視", [key(hb, "h"), hb.view], [[], "bookmarks"]);
const hl = hasLayer();
eq("有上一層時 h 退回去", [key(hl, "h"), hl.view, hl.layers.length], [[], "files", 0]);

eq("最底層按 q ＝關視窗", key(bottom(), "q"), ["close"]);
eq("有上一層時 q 也直接關（q 是 quit，不是退層）", key(hasLayer(), "q"), ["close"]);

/* ── 7. 開場的初始檢視不算一層 ── */
const opening = mk({ opening: true });
opening.pushLayer();
eq("opening 期間 push 不做事（初始檢視就是最底層）", opening.layers.length, 0);
opening.opening = false;
opening.pushLayer();
eq("開場結束後照常 push", opening.layers.length, 1);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
