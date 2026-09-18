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
const { YaziModal, OVERLAYS } = require(require("./_probe.js").probePath()).__test;

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
  sel: new Set(), visual: 0, visualAnchor: -1,
  setCursor() {}, cursorIndex() { return 0; },
  buildList() { acts.push("build:" + this.view); },
  buildSearchList() { acts.push("build:search"); },
  endInput() { this.mode = "nav"; }, render() {}, swallow() {}, scope: { keys: [] },
}, over);
const esc = (m) => { acts.length = 0; m.escapeBack(); return acts.slice(); };

/* ── 1. 沒有上一層 → 關視窗 ── */
eq("檔案檢視、堆疊空：Esc 關視窗", esc(mk()), ["close"]);
for (const v of ["bookmarks", "tabs", "recent", "frecency", "views", "outline", "relations"]) {
  eq("用命令直接開進 " + v + "（堆疊空）：Esc 關視窗", esc(mk({ view: v })), ["close"]);
}

/*
 * ── 1b. 搜尋結果的 Esc ＝退層，不回組合卡 ──
 * ,gt 打完關鍵字、Enter 看到結果、Esc → 離開（最底層就關窗）。
 * 要改條件是 i / Tab；拿掉條件是組合卡裡的 Backspace，所以 Esc 不逐一拆條件。
 */
eq("直接開的搜尋結果：Esc 關窗", esc(mk({ view: "search", searchKind: "file" })), ["close"]);
eq("資料夾搜尋也一樣", esc(mk({ view: "search", searchKind: "dir" })), ["close"]);
eq("組合卡裡（輸入列有焦點）按 Esc：離開搜尋",
   esc(mk({ view: "search", searchKind: "file", mode: "search", composing: true })), ["close"]);

const keep = mk({ view: "search", searchKind: "file", facets: [{ id: "a" }, { id: "b" }] });
eq("有條件時 Esc 仍是退層，條件不被逐一拆掉", [esc(keep), keep.facets.length], [["close"], 2]);

const fromView = mk({ view: "search", searchKind: "file",
  layers: [{ view: "views", listItems: [{}], listIndex: 0 }] });
eq("從檢視清單跑出來的結果：Esc 退回檢視清單", esc(fromView), ["build:views"]);
eq("回到檢視清單", fromView.view, "views");

const fromFiles = mk({ view: "search", searchKind: "text",
  layers: [{ view: "files", listItems: [] }] });
eq("從檔案檢視按 gt 進來的結果：Esc 退回檔案檢視", [esc(fromFiles), fromFiles.view], [[], "files"]);

/* ── 2. 有上一層 → 退回去，不關 ── */
const back = mk({ view: "bookmarks", layers: [{ view: "files", listItems: [], listIndex: 0 }] });
eq("從檔案檢視走進書籤：Esc 退回去而不是關", esc(back), []);
eq("退回檔案檢視、堆疊空了", [back.view, back.layers.length], ["files", 0]);
eq("再按一次才關", esc(back), ["close"]);

/* 退回清單時要重建（離開期間檔案可能被刪、書籤可能被移除） */
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

const sug = mk({ view: "search", mode: "search", composing: true, sug: { items: [] } });
eq("組合卡裡建議列開著：先收建議，不離開", esc(sug), []);
eq("只收掉建議，組合卡還在", [sug.sug, sug.mode], [null, "search"]);
eq("送出後殘留的 sug 不算覆蓋層（結果畫面 Esc 直接退層）",
   esc(mk({ view: "search", mode: "nav", sug: { items: [] } })), ["close"]);

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

/*
 * ── 6b. 從清單跳進資料夾之後的 h ──
 * 落地點（landing）按 h ＝退回那份清單；鑽進子資料夾之後 h 是上一層資料夾，
 * 走回落地點再按 h 才退層。vault 根目錄有上一層時也退層而不是喊「已在根目錄」。
 */
const folder = (p, parent) => ({ path: p, parent: parent || null, children: [] });
const root = folder("/");
const work = folder("100 工作", root);
const sub = folder("100 工作/projects", work);
const filesMk = (cwd, landing, layers) => mk({
  view: "files", cwd, landing, layers, memo: new Map(), cursorPath: null, filter: "",
  mainList: () => [], cursorIndex: () => -1, plugin: null,
});
const atLanding = filesMk(work, "100 工作", [{ view: "bookmarks", listItems: [{}], listIndex: 0 }]);
eq("站在落地點按 h：退回書籤清單", key(atLanding, "h"), ["build:bookmarks"]);
eq("回到書籤", atLanding.view, "bookmarks");

const deeper = filesMk(sub, "100 工作", [{ view: "bookmarks", listItems: [{}], listIndex: 0 }]);
eq("鑽進子資料夾後按 h：上一層資料夾，不退層", [key(deeper, "h"), deeper.cwd.path, deeper.layers.length],
   [[], "100 工作", 1]);
eq("走回落地點再按 h：這次退回書籤", [key(deeper, "h"), deeper.view], [["build:bookmarks"], "bookmarks"]);

const atRoot = filesMk(root, null, [{ view: "search", listItems: [{}], listIndex: 0 }]);
eq("vault 根目錄且有上一層：h 退層（不是「已在根目錄」）", key(atRoot, "h"), ["build:search"]);

const plain = filesMk(sub, null, []);
eq("一般瀏覽（沒有落地點、沒有上一層）：h 就是上一層資料夾", [key(plain, "h"), plain.cwd.path], [[], "100 工作"]);

/*
 * ── 6c. OVERLAYS 表本身：每一種覆蓋層，一下 Esc 收掉、地方不動 ──
 * 這組是「加新功能忘了接 Esc」的安全網：表裡每一列都被逐一驗證，
 * 而且用堆疊非空的清單當底，證明收覆蓋層時**沒有**順手退層。
 */
const openState = {
  pending:    { view: "bookmarks", pending: "g" },
  suggest:    { view: "search", mode: "search", composing: true, sug: { items: [] } },
  helpfilter: { view: "bookmarks", showHelp: true, helpFilter: "x" },
  help:       { view: "bookmarks", showHelp: true },
  input:      { view: "bookmarks", mode: "listfilter", listFilter: "x" },
  confirm:    { view: "bookmarks", mode: "confirm", confirmAsk: { message: "?", onYes() {} } },
  selection:  { view: "files", sel: new Set(["a.md"]) },
};
for (const o of OVERLAYS) {
  if (o.leaves) continue;   // 組合卡：收掉＝離開，另有測試（1b）
  const setup = openState[o.id];
  eq("OVERLAYS 表裡的 " + o.id + " 在測試裡有對應狀態", !!setup, true);
  if (!setup) continue;
  const m = mk(Object.assign({ layers: [{ view: "files", listItems: [] }] }, setup));
  eq(o.id + "：Esc 之前是開著的", o.open(m), true);
  const before = m.view;
  const got = esc(m);
  // 退層會改 view 或減少 layers；收覆蓋層兩者都不動（listfilter 收掉會重建清單，那不是退層）
  eq(o.id + "：一下 Esc 收掉、沒有退層也沒關窗", [o.open(m), got.includes("close"), m.view, m.layers.length],
     [false, false, before, 1]);
}
eq("表裡每一列都有 id / open / close", OVERLAYS.every((o) => o.id && typeof o.open === "function" && typeof o.close === "function"), true);

/* 進到新的地方時，臨時覆蓋層要被收掉、不能存進快照 */
const carry = mk({ view: "bookmarks", pending: "g", showHelp: true, plugin: null });
carry.pushLayer();
eq("pushLayer 收掉臨時覆蓋層", [carry.pending, carry.showHelp], [null, false]);
eq("快照裡也沒有它們", [carry.layers[0].pending, carry.layers[0].showHelp], [undefined, undefined]);

/* ── 7. 開場的初始檢視不算一層 ── */
const opening = mk({ opening: true });
opening.pushLayer();
eq("opening 期間 push 不做事（初始檢視就是最底層）", opening.layers.length, 0);
opening.opening = false;
opening.pushLayer();
eq("開場結束後照常 push", opening.layers.length, 1);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
