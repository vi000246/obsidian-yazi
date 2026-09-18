/*
 * 清單檢視的多選與批次拿掉（書籤 / 檢視 / 分頁 / 常去的地方）。
 *
 * 這支守的是三件容易無聲壞掉的事：
 *   1. 選取的身分要撐過 buildList()（每刪一筆就重建整份清單）
 *   2. 選取不能在不同種類的清單之間外洩（書籤與「常去的地方」都用路徑當身分）
 *   3. 批次一定經過一次確認，而單筆維持原本的行為（分頁不問、書籤問）
 */
const Module = require("module");
const notices = [];
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class { constructor(m) { notices.push(String(m)); } }, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal } = require(require("./_probe.js").probePath()).__test;

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want))); };

const ev = (key, over) => Object.assign({ key, type: "keydown", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} }, over);
/* 批次是 async（一筆一筆 await），所以確認之後要讓 microtask 跑完才驗結果 */
const settle = () => new Promise((r) => setImmediate(r));

const F = (p) => ({ path: p, name: p.split("/").pop(), basename: p.split("/").pop().replace(/\.md$/, ""), extension: "md" });

function fakePlugin() {
  const data = {
    bookmarks: [
      { path: "a.md", name: "甲", key: "1" },
      { path: "b.md", name: "乙", key: "2" },
      { path: "c.md", name: "丙", key: "3" },
    ],
    views: [
      { id: "v1", name: "檢視一", key: null, facets: [] },
      { id: "v2", name: "檢視二", key: null, facets: [] },
      { id: "v3", name: "檢視三", key: null, facets: [] },
    ],
    frecency: { "a.md": { n: 3, t: 1 }, "b.md": { n: 2, t: 2 } },
  };
  return {
    settings: data, data,
    bookmarks: () => data.bookmarks,
    bookmarkByKey: (k) => data.bookmarks.find((b) => b.key === k) || null,
    views: () => data.views,
    viewByKey: (k) => data.views.find((v) => v.key === k) || null,
    async removeBookmark(p) { data.bookmarks = data.bookmarks.filter((b) => b.path !== p); },
    async removeView(id) { data.views = data.views.filter((v) => v.id !== id); },
    async forgetFrecency(p) { delete data.frecency[p]; },
    frecencyRanked: () => Object.keys(data.frecency).map((p) => ({ path: p, n: data.frecency[p].n })),
  };
}

const leaves = [];
const mk = (over) => {
  const m = Object.assign(Object.create(YaziModal.prototype), {
    view: "files", mode: "nav", pending: null, showHelp: false,
    sel: new Set(), listSel: new Set(), visual: 0, visualAnchor: -1,
    listItems: [], listIndex: 0, listFilter: "", layers: [], opening: false,
    plugin: fakePlugin(), swallow() {}, render() {}, scope: { keys: [] },
    sortCfg: () => ({ field: "natural", reverse: false, foldersFirst: true }),
    buildList() { this.buildListRaw(); },
    app: {
      vault: { getAbstractFileByPath: (p) => (String(p).endsWith(".md") ? F(p) : null) },
      workspace: {
        activeLeaf: null,
        iterateRootLeaves(fn) { for (const l of leaves) fn(l); },
      },
    },
  }, over);
  return m;
};

/* 分頁清單的替身：每個 leaf 記自己有沒有被 detach 掉 */
const resetLeaves = () => {
  leaves.length = 0;
  for (const name of ["T1", "T2", "T3"]) {
    const leaf = { closed: false, getDisplayText: () => name, view: { file: F(name + ".md") } };
    leaf.detach = () => { leaf.closed = true; leaves.splice(leaves.indexOf(leaf), 1); };
    leaves.push(leaf);
  }
};

/* ── 1. Space：選起來並下移，✓ 的身分撐得過清單重建 ── */
const b = mk({ view: "bookmarks" });
b.buildList();
b.handleKey(ev(" "));
eq("Space 選了第一列並把游標移到第二列", [[...b.listSel], b.listIndex], [["a.md"], 1]);
b.handleKey(ev(" "));
eq("再一次：兩列都在選取裡", [[...b.listSel], b.listIndex], [["a.md", "b.md"], 2]);
b.buildList();
eq("清單重建之後選取還在（身分是路徑，不是索引）", [...b.listSel], ["a.md", "b.md"]);
b.handleKey(ev(" "));
b.listIndex = 0;
b.handleKey(ev(" "));
eq("同一列再按一次 Space ＝取消選取", [...b.listSel].sort(), ["b.md", "c.md"]);

/* ── 2. v：成段選取；V：成段取消 ── */
const v = mk({ view: "views" });
v.buildList();
v.handleKey(ev("v"));
eq("v 進 visual 並把起點那一列選起來", [v.visual, [...v.listSel]], [1, ["v1"]]);
v.handleKey(ev("j"));
eq("移動就是在拉範圍", [...v.listSel], ["v1", "v2"]);
v.handleKey(ev("k"));
eq("往回拉會還原（每次重算整段）", [...v.listSel], ["v1"]);
v.handleKey(ev("v"));
eq("再按 v ＝離開 visual，選取留著", [v.visual, [...v.listSel]], [0, ["v1"]]);
v.handleKey(ev("G"));
v.handleKey(ev("V"));
v.handleKey(ev("k"));
eq("V 是成段取消（v1 不在範圍內所以還在）", [...v.listSel], ["v1"]);

/*
 * ── 2b. 檔案檢視的 v 也要會還原 ──
 * 同一個 applyVisual，之前只往範圍內加不減，症狀是「v 之後 j j k 還是選了三列」。
 */
const files = mk({
  view: "files", cursorPath: "1.md", filter: "",
  cwd: { path: "/", children: ["1.md", "2.md", "3.md"].map(F) },
  memo: new Map(),
});
files.handleKey(ev("v"));
files.handleKey(ev("j"));
files.handleKey(ev("j"));
eq("檔案檢視：v 之後往下拉兩列＝三列", [...files.sel], ["1.md", "2.md", "3.md"]);
files.handleKey(ev("k"));
eq("往回拉一列就還原一列", [...files.sel], ["1.md", "2.md"]);

/* ── 3. ^a 全選 / ^r 反選，只在支援的清單上有效 ── */
const all = mk({ view: "bookmarks" });
all.buildList();
all.handleKey(ev("a", { ctrlKey: true }));
eq("^a 全選這份清單", [...all.listSel], ["a.md", "b.md", "c.md"]);
all.handleKey(ev("r", { ctrlKey: true }));
eq("^r 反選 ＝ 清空", [...all.listSel], []);

const ro = mk({ view: "recent", listItems: [{ path: "x.md", label: "x" }] });
eq("最近開啟不支援多選", ro.listSelectable(), false);
ro.handleKey(ev(" "));
eq("在不支援的清單按 Space 什麼都不會發生", [[...ro.listSel], ro.listIndex], [[], 0]);
const rel = mk({ view: "relations", listItems: [{ path: "x.md", label: "x" }] });
eq("關聯清單也不支援", rel.listSelectable(), false);

/* ── 4. 選取不會在清單之間外洩（書籤與常去的地方都用路徑當身分）── */
const leak = mk({ view: "bookmarks" });
leak.buildList();
leak.handleKey(ev("a", { ctrlKey: true }));
leak.openList("frecency");
eq("換一份清單就把選取清掉", [leak.view, [...leak.listSel]], ["frecency", []]);

/* ── 5. 批次刪書籤：一次確認，y 才動手 ── */
(async () => {
  const del = mk({ view: "bookmarks" });
  del.buildList();
  del.handleKey(ev(" "));   // a.md
  del.handleKey(ev(" "));   // b.md
  del.handleKey(ev("x"));
  eq("多筆 x 先問一聲，還沒刪", [del.mode, del.plugin.bookmarks().length], ["confirm", 3]);
  del.handleKey(ev("n"));
  await settle();
  eq("按 n 取消：三筆都在", [del.mode, del.plugin.bookmarks().length], ["nav", 3]);
  del.handleKey(ev("x"));
  del.handleKey(ev("y"));
  await settle();
  eq("按 y 才把選取的兩筆一起刪掉", del.plugin.bookmarks().map((x) => x.path), ["c.md"]);
  eq("刪完把選取清掉、清單重建", [[...del.listSel], del.listItems.length], [[], 1]);

  /* 單筆維持原本的行為：也是問一聲（書籤是使用者一筆一筆存的） */
  const one = mk({ view: "bookmarks" });
  one.buildList();
  one.handleKey(ev("x"));
  eq("沒有選取時 x ＝游標那一列，照樣先問", one.mode, "confirm");
  one.handleKey(ev("y"));
  await settle();
  eq("刪掉游標那一列", one.plugin.bookmarks().map((x) => x.path), ["b.md", "c.md"]);

  /* ── 6. 批次刪檢視 ── */
  const dv = mk({ view: "views" });
  dv.buildList();
  dv.handleKey(ev("a", { ctrlKey: true }));
  dv.handleKey(ev("x"));
  dv.handleKey(ev("y"));
  await settle();
  eq("三個檢視一次刪完", dv.plugin.views().length, 0);

  /* ── 7. 分頁：單筆照舊直接關（不問），多筆要問 ── */
  resetLeaves();
  const t1 = mk({ view: "tabs" });
  t1.buildList();
  eq("分頁清單收到三個 leaf", t1.listItems.length, 3);
  t1.handleKey(ev("x"));
  await settle();
  eq("單筆關分頁不問 y/n（照原本的行為）", [t1.mode, leaves.length], ["nav", 2]);

  resetLeaves();
  const t2 = mk({ view: "tabs" });
  t2.buildList();
  t2.handleKey(ev(" "));
  t2.handleKey(ev(" "));
  eq("分頁的身分是 leaf 物件（同一個檔開兩個分頁也分得開）", t2.listSel.size, 2);
  t2.handleKey(ev("x"));
  eq("多個分頁要問一聲 —— X 只還原得回最後一個", [t2.mode, leaves.length], ["confirm", 3]);
  t2.handleKey(ev("y"));
  await settle();
  eq("確認之後兩個一起關掉", leaves.map((l) => l.getDisplayText()), ["T3"]);

  /* ── 8. 常去的地方：單筆不問、多筆問 ── */
  const fr = mk({ view: "frecency" });
  fr.buildList();
  fr.handleKey(ev("a", { ctrlKey: true }));
  fr.handleKey(ev("x"));
  eq("多筆要問", fr.mode, "confirm");
  fr.handleKey(ev("y"));
  await settle();
  eq("兩筆紀錄都移除了", Object.keys(fr.plugin.data.frecency), []);

  /* ── 9. Esc 先收選取，再退層（同檔案檢視）── */
  const esc = mk({ view: "bookmarks", layers: [{ view: "files", listItems: [], listIndex: 0 }] });
  esc.buildList();
  esc.handleKey(ev(" "));
  esc.escapeBack();
  eq("Esc 第一下清掉選取，還留在書籤清單", [esc.view, [...esc.listSel]], ["bookmarks", []]);
  esc.escapeBack();
  eq("第二下才退回上一層", esc.view, "files");

  /* ── 10. 檔案檢視的選取不被清單的 Esc 波及（跨資料夾保留是 yazi 的語意）── */
  const keep = mk({ view: "bookmarks", layers: [{ view: "files", listItems: [], listIndex: 0 }] });
  keep.sel = new Set(["kept.md"]);
  keep.buildList();
  keep.handleKey(ev(" "));
  keep.escapeBack();
  eq("清掉的只有清單那一份", [[...keep.listSel], [...keep.sel]], [[], ["kept.md"]]);

  console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
  process.exit(fail ? 1 : 0);
})();
