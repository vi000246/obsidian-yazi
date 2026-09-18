/* 關聯（gr）在 modal 裡的接線：按鍵派工、走訪堆疊、Enter 跳游標而不開檔、裸 id 的退路 */
const Module = require("module");
const notices = [];
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class { constructor(m) { notices.push(String(m)); } }, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal } = require(require("./_probe.js").probePath()).__test;
const { DEFAULT_RELATIONS } = require("../src/settings/defaults.js");

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "  want " + JSON.stringify(want))); };

const ev = (key) => ({ key, type: "keydown", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });

/* 假 vault：a ─parent→ b，d ─parent→ a，a ─related→ c，OB-21 用裸 id 指 OB-19 */
const F = (path) => ({ path, basename: path.replace(/\.md$/, "").split("/").pop(), name: path.split("/").pop(), extension: "md", children: undefined });
const a = F("a.md"), b = F("b.md"), c = F("c.md"), d = F("d.md");
const ob19 = F("t/OB-19 9 17開會討論內容.md"), ob21 = F("t/OB-21 給Liz回傳格式.md");
const ALL = [a, b, c, d, ob19, ob21];
const FM = {
  "a.md": { parent: "[[b]]", related: "[[c]]" },
  "d.md": { parent: "[[a]]" },
  "t/OB-21 給Liz回傳格式.md": { parent: "OB-19" },   // 裸 id，不是合法 wikilink
};
const app = {
  vault: {
    getMarkdownFiles: () => ALL,
    getAbstractFileByPath: (p) => ALL.find((f) => f.path === p) || null,
  },
  metadataCache: {
    getFileCache: (f) => ({ frontmatter: FM[f.path] || null }),
    getFirstLinkpathDest: (p) => ALL.find((f) => f.basename === p) || null,
    resolvedLinks: {},
  },
};
const mk = (view, over) => Object.assign(Object.create(YaziModal.prototype), {
  view, mode: "nav", pending: null, showHelp: false, visual: 0, visualAnchor: -1,
  sel: new Set(), listSel: new Set(), listItems: [], listIndex: 0,
  listFilter: "", relFile: null, layers: [], composing: false, relExpanded: new Set(), relCache: null,
  app, plugin: { settings: { relations: DEFAULT_RELATIONS } },
  sortCfg: () => ({ field: "natural", reverse: false, foldersFirst: true }),
  swallow() {}, render() {}, scope: { keys: [] },
}, over);

/* ── 1. gr 派工 ── */
for (const view of ["files", "search"]) {
  const log = [];
  const m = mk(view, { openRelations: () => log.push("rel") });
  m.handleKey(ev("g"));
  m.handleKey(ev("r"));
  eq(view + "：gr → 關聯", log, ["rel"]);
}

/* ── 2. 分組內容 ── */
const m = mk("files", { current: () => a });
m.openRelations();
eq("進到關聯檢視", m.view, "relations");
eq("分組：Parent / Children / Related", m.listItems.map((i) => [i.group, i.label]),
   [["Parent", "b"], ["Children", "d"], ["Related", "c"]]);
eq("每一列都帶得到檔案（預覽要用）", m.listItems.every((i) => !!i.file), true);

/* 規則可關掉 */
const off = mk("files", { current: () => a, plugin: { settings: { relations: [{ field: "parent", label: "P", inverse: "C", enabled: false }] } } });
off.openRelations();
eq("關掉所有規則 → 空清單", off.listItems, []);

/* 裸 id 的退路：parent: OB-19 要找得到 `OB-19 …` 那個檔 */
const bare = mk("files", { current: () => ob21 });
bare.openRelations();
eq("裸 id 也解析得到（檔名前綴比對）", bare.listItems.map((i) => [i.group, i.label]),
   [["Parent", "OB-19 9 17開會討論內容"]]);

/* ── 3. 沿關聯走：gr 再 gr，h 退一步（走的是通用的層堆疊） ── */
const walk = mk("files", { current: () => a });
walk.openRelations();
eq("第一層中心是 a，堆疊裡是進來前的檔案檢視",
   [walk.relFile.path, walk.layers.map((l) => l.view)], ["a.md", ["files"]]);
walk.listIndex = 1;                       // Children → d
walk.openRelations();
eq("再按 gr：中心換成 d，a 那層進堆疊",
   [walk.relFile.path, walk.layers.map((l) => l.view + ":" + (l.relFile ? l.relFile.path : "-"))],
   ["d.md", ["files:-", "relations:a.md"]]);
eq("d 的關聯：Parent a", walk.listItems.map((i) => [i.group, i.label]), [["Parent", "a"]]);
walk.goBackLayer();
eq("h 退一步：回到 a，還在關聯檢視",
   [walk.view, walk.relFile.path, walk.layers.length], ["relations", "a.md", 1]);
walk.goBackLayer();
eq("再按 h：退回檔案檢視", walk.view, "files");

/* 切到別的清單：那也是一層，堆疊變深 */
const t = mk("files", { current: () => a });
t.openRelations();
t.listIndex = 1; t.openRelations();
t.collectTabs = () => []; t.openList("tabs");
eq("從關聯切到分頁清單：關聯那兩層都還在堆疊裡",
   t.layers.map((l) => l.view), ["files", "relations", "relations"]);

/* ── 4. Enter / l 跳游標；o / t 才開檔 ── */
const acts = [];
const j = mk("relations", {
  listItems: [{ path: "b.md", file: b }], listIndex: 0, relFile: a, layers: [],
  revealPath: (p) => acts.push("reveal:" + p),
  openFile: (f, mode) => acts.push("open:" + f.path + ":" + mode),
  buildList() {}, clearSelection: () => false,
});
j.handleKey(ev("Enter"));
eq("Enter ＝進去：中心換成 b、不開檔、不跳游標", [acts, j.view, j.relFile.path], [[], "relations", "b.md"]);
eq("原本那層（中心 a）推進堆疊，h 退得回去",
   j.layers.map((l) => l.view + ":" + (l.relFile ? l.relFile.path : "-")), ["relations:a.md"]);

/* ── 4b. 一般連結預設收合成一列，l 展開；展開狀態跟著中心走 ── */
const e = F("e.md");
const app2 = Object.assign({}, app, {
  vault: { getMarkdownFiles: () => ALL.concat([e]), getAbstractFileByPath: (p) => (p === "e.md" ? e : app.vault.getAbstractFileByPath(p)) },
  metadataCache: Object.assign({}, app.metadataCache, { resolvedLinks: { "a.md": { "e.md": 1 } } }),
});
const c2 = mk("files", { current: () => a, app: app2 });
c2.openRelations();
const last = c2.listItems[c2.listItems.length - 1];
eq("Links 收合成一列：▸ 圖示、帶筆數、沒有分組標題", [last.icon, last.label, last.collapsed, last.group], ["▸", "1 Links", "Links", undefined]);
eq("有型別的三組照常攤開", c2.listItems.slice(0, 3).map((i) => i.group), ["Parent", "Children", "Related"]);
c2.listIndex = c2.listItems.length - 1;
c2.enterRelation();
eq("l 展開：e 出現在 Links 組底下、堆疊沒動（展開不是進去）",
   [c2.listItems.filter((i) => i.group === "Links").map((i) => i.label), c2.layers.length], [["e"], 1]);
c2.listIndex = 1;   // Children → d
c2.enterRelation();
eq("走到 d：那邊的 Links（若有）是收合的、a 的展開狀態留著",
   [c2.relFile.path, c2.relExpanded.has("a.md\nLinks")], ["d.md", true]);

/* 分組有快取：同一個檔第二次拿到同一份 */
eq("relationGroupsFor 一次開啟期間每個檔只算一次", c2.relationGroupsFor(a) === c2.relationGroupsFor(a), true);

acts.length = 0;
const o = mk("relations", { listItems: [{ path: "b.md", file: b }], listIndex: 0, relFile: a,
  openFile: (f, mode) => acts.push("open:" + f.path + ":" + mode) });
o.handleKey(ev("o"));
o.handleKey(ev("t"));
eq("o / t：開檔（不帶行號）", acts, ["open:b.md:current", "open:b.md:tab"]);

/* x 在關聯檢視裡不做事（沒有「刪掉這一列」的意思） */
notices.length = 0;
const x = mk("relations", { listItems: [{ path: "b.md", file: b }], listIndex: 0, relFile: a });
x.removeListItem();
eq("x 安靜跳過、也不冒出提示", notices.length, 0);

/* ── 5. 非 md 不進去 ── */
notices.length = 0;
const png = mk("files", { current: () => ({ path: "x.png", name: "x.png", extension: "png" }) });
png.openRelations();
eq("非 md：留在原檢視並提示", [png.view, notices.length], ["files", 1]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
