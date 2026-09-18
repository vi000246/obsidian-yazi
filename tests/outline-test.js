/* 大綱（go）在 modal 裡的接線：按鍵派工、預覽對位、返回點、gf 的別名命中 */
const Module = require("module");
const notices = [];
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class { constructor(m) { notices.push(String(m)); } }, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal } = require(require("./_probe.js").probePath()).__test;

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "  want " + JSON.stringify(want))); };

const ev = (key) => ({ key, type: "keydown", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
const base = (view) => Object.assign(Object.create(YaziModal.prototype), {
  view, mode: "nav", pending: null, showHelp: false, visual: 0, visualAnchor: -1,
  sel: new Set(), listSel: new Set(), listItems: [{}, {}], listIndex: 0, layers: [],
  swallow() {}, render() {}, scope: { keys: [] }, plugin: null,
});

/* ── 1. g 然後 o → openOutline，檔案檢視與清單檢視都要接到 ── */
for (const view of ["files", "search"]) {
  const log = [];
  const m = Object.assign(base(view), { openOutline: () => log.push("outline") });
  m.handleKey(ev("g"));
  m.handleKey(ev("o"));
  eq(view + "：go → 大綱", log, ["outline"]);
}

/* ── 2. followOutline：預覽欄捲到第幾個標題 ── */
global.window = { getComputedStyle: () => ({ lineHeight: "20px" }) };
/*
 * 假 DOM：欄頂固定在視窗 y=100；內容元素的 getBoundingClientRect 要**跟著欄的 scrollTop 走**
 * （真 DOM 就是這樣 —— 捲了 50，所有東西的視窗座標就少 50），否則「已經捲過」那條測不到東西。
 * top 參數是元素在**內容座標系**的位置。
 */
const mkPreview = () => {
  const el = {
    scrollTop: 0, scrollHeight: 5000,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelector: (sel) => (sel === ".yazi-preview-md" ? el.md : sel === ".yazi-preview-text" ? el.pre : null),
    md: null, pre: null,
  };
  el.child = (top, extra) => Object.assign({ getBoundingClientRect: () => ({ top: 100 + top - el.scrollTop }), closest: () => null }, extra);
  return el;
};
const follow = (setup, idx, scrollTop) => {
  const el = mkPreview();
  setup(el);
  el.scrollTop = scrollTop || 0;
  const m = Object.assign(base("outline"), { previewEl: el, listItems: [{ idx: 0 }, { idx: 1 }, { idx: 2 }], listIndex: idx });
  m.followOutline();
  return el.scrollTop;
};
// 三個 <h>，第二個在 blockquote 裡（closest 回非 null）要跳過
const withMd = (el) => { el.md = { querySelectorAll: () => [el.child(200), el.child(400, { closest: () => ({}) }), el.child(600)] }; };
eq("渲染版：第 0 個標題在內容 y=200 → 200-6", follow(withMd, 0), 194);
eq("渲染版：跳過引言裡的標題，第 1 個是 y=600", follow(withMd, 1), 594);
eq("渲染版：已經捲了 50，算出來的目標一樣（視窗座標會少 50，基準也少 50）", follow(withMd, 1, 50), 594);
eq("渲染版：標題在截斷點之後 → 捲到底", follow(withMd, 2), 5000);
const TEXT = "# A\n\ntext\n## B\n```bash\n# not\n```\n### C";
const withPre = (text) => (el) => { el.pre = el.child(20, { textContent: text }); };
eq("純文字版：<pre> 在 y=20，第 1 個標題在第 3 行 → 20+3*20-6", follow(withPre(TEXT), 1), 74);
eq("純文字版：截斷 → 捲到底", follow(withPre("# only"), 1), 5000);
eq("渲染中（md 盒子還空著）先用純文字對位", follow((el) => { withPre(TEXT)(el); el.md = { querySelectorAll: () => [] }; }, 0), 14);
eq("沒有預覽欄不能爆", (() => { const m = Object.assign(base("outline"), { previewEl: null }); m.followOutline(); return true; })(), true);

/* ── 3. openOutline / backToFiles：從清單進來要退回那份清單 ── */
const mdFile = { path: "notes/a.md", name: "a.md", basename: "a", extension: "md" };
const app = { metadataCache: { getFileCache: (f) => f === mdFile
  ? { headings: [{ level: 2, heading: "Intro", position: { start: { line: 4 } } }, { level: 3, heading: "More", position: { start: { line: 9 } } }] }
  : null } };
const mkList = () => Object.assign(base("search"), {
  app, listItems: [{ file: mdFile, label: "a.md" }], listIndex: 0, listFilter: "kept", layers: [],
  sortCfg: () => ({ field: "natural", reverse: false, foldersFirst: true }),
  composing: false,
});
const s = mkList();
const before = s.listItems;
s.openOutline();
eq("進到大綱檢視", s.view, "outline");
eq("標題變成清單項目（標籤／層級／行號）", s.listItems.map((i) => [i.label, i.sub, i.line, i.depth]), [["Intro", "H2", 4, 0], ["More", "H3", 9, 1]]);
eq("把來的那一層推進堆疊", s.layers.map((l) => l.view), ["search"]);
eq("清單內過濾在大綱裡是乾淨的", s.listFilter, "");
s.buildSearchList = function () { this.listItems = before; };
s.goBackLayer();
eq("h 退回搜尋結果，不是檔案檢視", s.view, "search");
eq("原來的項目與過濾字都還在", [s.listItems === before, s.listFilter], [true, "kept"]);
eq("退回去之後堆疊空了", s.layers.length, 0);

/* 排序設定不能打亂大綱順序 */
const sorted = mkList();
sorted.sortCfg = () => ({ field: "name", reverse: true, foldersFirst: true });
sorted.openOutline();
eq("有全域排序時大綱仍照文章順序", sorted.listItems.map((i) => i.label), ["Intro", "More"]);

/* 檔案檢視進來：退回檔案檢視 */
const f = Object.assign(base("files"), { app, current: () => mdFile, sortCfg: () => ({ field: "natural" }) });
f.openOutline();
eq("檔案檢視進來，推的是檔案檢視那一層", [f.view, f.layers.map((l) => l.view)], ["outline", ["files"]]);
f.goBackLayer();
eq("h 回檔案檢視", f.view, "files");

/* 不是 md 就不進去 */
notices.length = 0;
const png = Object.assign(base("files"), { app, current: () => ({ path: "x.png", name: "x.png", extension: "png" }) });
png.openOutline();
eq("非 md：留在原檢視並提示", [png.view, notices.length], ["files", 1]);

/* 換到別的清單：那也是一層，所以堆疊變深而不是被清掉 */
const t = mkList(); t.openOutline();
t.collectTabs = () => []; t.openList("tabs");
eq("從大綱切到分頁清單：大綱那層也留在堆疊裡", t.layers.map((l) => l.view), ["search", "outline"]);

/* ── 4. Enter 開檔要帶行號 ── */
const opened = [];
const o = Object.assign(base("outline"), { listItems: [{ file: mdFile, line: 9 }], listIndex: 0, openFile: (file, mode, line) => opened.push([file.path, mode, line]) });
o.activateListItem("current");
o.activateListItem("tab");
eq("Enter / t 都帶著標題的行號", opened, [["notes/a.md", "current", 9], ["notes/a.md", "tab", 9]]);

/* ── 5. gf：別名命中 ── */
const f1 = { path: "notes/projects.md", name: "projects.md", extension: "md" };
const f2 = { path: "notes/2024-01-01.md", name: "2024-01-01.md", extension: "md" };
const f3 = { path: "notes/other.md", name: "other.md", extension: "md" };
const g = Object.assign(base("search"), {
  searchKind: "file", searchQuery: "proj", facets: [], scopePath: "",
  app: { vault: { getFiles: () => [f1, f2, f3] },
         metadataCache: { getFileCache: (x) => (x === f2 ? { frontmatter: { aliases: ["Project Alpha"] } } : x === f3 ? { frontmatter: {} } : null) } },
});
g.buildSearchListRaw();
eq("別名命中的列別名、路徑放小字；路徑命中的照舊", g.listItems.map((i) => [i.label, i.sub]),
   [["Project Alpha", "notes/2024-01-01.md"], ["projects.md", "notes/projects.md"]]);
eq("沒命中的不出現", g.listItems.some((i) => i.path === "notes/other.md"), false);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
