/*
 * Esc 的層次。
 *
 * 規則：Esc 關掉**最上面那一層**。所以「下面還有什麼」決定了它做什麼 ——
 * 從檔案檢視走進書籤，下面是檔案檢視，Esc 退回去；用 ,b 直接開書籤，那層就是
 * 最底層，Esc 該關掉整個視窗而不是丟一個沒人要求過的檔案清單出來。
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
  sug: null, sugField: null, facets: [], listItems: [], listIndex: 0,
  relStack: [], outlineFrom: null, entryView: "files",
  forceClose: () => acts.push("close"),
  backToFiles: () => acts.push("toFiles"),
  clearSelection: () => false,
  endInput() {}, render() {}, swallow() {}, scope: { keys: [] },
}, over);
const esc = (m) => { acts.length = 0; m.escapeBack(); return acts.slice(); };

/* ── 從檔案檢視走進去的：Esc 退回檔案檢視 ── */
eq("檔案檢視 → 書籤，Esc 退回檔案檢視",
   esc(mk({ view: "bookmarks", entryView: "files" })), ["toFiles"]);
eq("檔案檢視 → 搜尋結果，Esc 退回檔案檢視",
   esc(mk({ view: "search", entryView: "files" })), ["toFiles"]);
eq("在檔案檢視按 Esc 才是關閉", esc(mk({ view: "files", entryView: "files" })), ["close"]);

/* ── 用命令直接開進來的：那層就是最底層，Esc 關掉整個視窗 ── */
for (const v of ["bookmarks", "tabs", "recent", "frecency", "views", "outline", "relations"]) {
  eq("直接開 " + v + "，Esc 關閉整個視窗", esc(mk({ view: v, entryView: v })), ["close"]);
}

/* 三種搜尋在 view 上都是 "search"，entryView 已經收斂過 */
eq("直接開搜尋（結果階段），Esc 關閉",
   esc(mk({ view: "search", entryView: "search" })), ["close"]);
eq("直接開搜尋（輸入還開著），Esc 也關閉",
   esc(mk({ view: "search", entryView: "search", mode: "search" })), ["close"]);

/* ── 但「上面又疊了一層」時要先退那一層 ── */
eq("直接開關聯又用 gr 走了一步：先退那一步，不關視窗",
   esc(mk({ view: "relations", entryView: "relations", relStack: [{}] })), ["toFiles"]);
eq("直接開搜尋後從結果進大綱：先退回搜尋結果",
   esc(mk({ view: "outline", entryView: "search", outlineFrom: { view: "search" } })), ["toFiles"]);
eq("直接開書籤後切到分頁清單：不是原本那層了，照一般規則",
   esc(mk({ view: "tabs", entryView: "bookmarks" })), ["toFiles"]);

/* ── 搜尋自己的層次仍然優先：條件要一個一個退掉 ── */
const withFacets = mk({ view: "search", entryView: "search", facets: [{ id: "a" }, { id: "b" }],
  listIndex: 3, buildSearchList() {} });
eq("有條件時 Esc 先退條件，不關視窗", esc(withFacets), []);
eq("退掉一個條件", withFacets.facets.length, 1);

/* 說明頁疊在最上層，先收它 */
const help = mk({ view: "bookmarks", entryView: "bookmarks", showHelp: true });
eq("說明頁開著時 Esc 先關說明，不關視窗", esc(help), []);
eq("說明頁關掉了", help.showHelp, false);
eq("再按一次才關視窗", esc(help), ["close"]);

/* 待接的多鍵序列最內層 */
const pend = mk({ view: "bookmarks", entryView: "bookmarks", pending: "g" });
eq("有待接的前綴時 Esc 只取消它", esc(pend), []);
eq("前綴清掉了", pend.pending, null);

/* ── q 跟 Esc 同一個語意；h 永遠是「退回檔案檢視」 ── */
const ev = (key) => ({ key, type: "keydown", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
const key = (m, k) => { acts.length = 0; m.handleKey(ev(k)); return acts.slice(); };
const direct = () => mk({ view: "bookmarks", entryView: "bookmarks", plugin: null });
eq("直接開的那層按 q ＝關閉整個視窗", key(direct(), "q"), ["close"]);
eq("直接開的那層按 h ＝退回檔案檢視（導航）", key(direct(), "h"), ["toFiles"]);
const nested = () => mk({ view: "bookmarks", entryView: "files", plugin: null });
eq("走進來的那層按 q ＝退回檔案檢視", key(nested(), "q"), ["toFiles"]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
