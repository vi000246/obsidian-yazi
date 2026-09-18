/* 儲存的檢視（,v / ,s）：存什麼、跑起來會不會把搜尋狀態灌對、快捷字母、編輯 */
const Module = require("module");
const notices = [];
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class { constructor(m) { notices.push(String(m)); } }, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const probe = require(require("./_probe.js").probePath()).__test;
const { YaziModal, setFacets } = probe;

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want))); };

const ev = (key) => ({ key, type: "keydown", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });

/* 條件定義要先灌進模組層，runView 才認得那些 id（認不得的會被丟掉，見 runView） */
setFacets([
  { id: "status", key: "s", kind: "fm", field: "status", label: "status", enabled: true },
  { id: "prio", key: "p", kind: "fm", field: "priority", label: "priority", enabled: true },
]);

/* 假 plugin：views 存在記憶體，介面與真的那份一致 */
function fakePlugin() {
  const data = { views: [] };
  return {
    settings: data, data,
    views: () => data.views,
    viewByKey: (k) => data.views.find((v) => v.key === k) || null,
    async saveView(v) {
      const at = data.views.findIndex((x) => x.name === v.name);
      if (at >= 0) { v.key = data.views[at].key; data.views[at] = v; return true; }
      data.views.push(v);
      return false;
    },
    async removeView(id) { data.views = data.views.filter((v) => v.id !== id); this.data.views = data.views; },
    async assignViewKey(id, key) {
      let stolen = null;
      for (const v of data.views) {
        if (key && v.key === key && v.id !== id) { v.key = null; stolen = v.name; }
        if (v.id === id) v.key = key || null;
      }
      return stolen;
    },
  };
}

const mk = (over) => Object.assign(Object.create(YaziModal.prototype), {
  view: "files", mode: "nav", pending: null, showHelp: false, visual: 0,
  listItems: [], listIndex: 0, listFilter: "", layers: [], facets: [], scopePath: "",
  searchKind: "file", searchQuery: "", composing: false, indexing: false,
  plugin: fakePlugin(), swallow() {}, render() {}, scope: { keys: [] },
  sortCfg: () => ({ field: "natural", reverse: false, foldersFirst: true }),
  buildSearchList() { this.built = (this.built || 0) + 1; },
  buildList() { if (this.view === "views") this.listItems = this.collectViews(); },
  endInput() {}, ensureIndex: () => false,
  inputEl: { value: "", focus() {} }, inputWrapEl: { show() {}, hide() {} },
  refreshSuggest() {},
  facetLabel: (f) => f.id + ":" + f.value,
  collectTabs: () => [],
}, over);

/* ── 1. gv 開清單（檔案檢視）、s 存檔（只在搜尋結果） ── */
const log = [];
const k = mk({ openList: (v) => log.push("list:" + v) });
k.handleKey(ev("g")); k.handleKey(ev("v"));
eq("gv 開檢視清單", log, ["list:views"]);

log.length = 0;
const sv = mk({ view: "search", saveCurrentView: () => log.push("save") });
sv.handleKey(ev("s"));
eq("搜尋結果裡 s ＝儲存", log, ["save"]);

log.length = 0;
const sb = mk({ view: "bookmarks", saveCurrentView: () => log.push("save") });
sb.handleKey(ev("s"));
eq("其他清單的 s 不做事（沒有條件可存）", log, []);

/* , 前綴在清單檢視裡要接得到（原本整個沒接，,p 在搜尋結果按了沒反應） */
log.length = 0;
const cm = mk({ view: "search", toggleRenderMd: () => log.push("togglemd") });
cm.handleKey(ev(",")); cm.handleKey(ev("p"));
eq("搜尋結果裡 ,p 切換渲染預覽", log, ["togglemd"]);

/* ── 2. s 存下來的內容（先過 y/n 確認，再問名字） ── */
let prompted = null;
const s = mk({
  view: "search", searchKind: "text", searchQuery: "報表",
  facets: [{ id: "status", value: "3 In Progress" }, { id: "prio", value: "P0 Urgent" }],
  scopePath: "100 工作",
  promptFor: (label, initial, cb) => { prompted = { label, initial }; return cb("進行中的 P0"); },
});
// s 直接問名字，不另外問 y/n —— 要打字並按 Enter 才會存，誤按本來就存不到東西
s.saveCurrentView();
const saved = s.plugin.views()[0];
eq("預設名稱用關鍵字帶出來", prompted.initial, "報表");
eq("存下種類、關鍵字、條件、範圍",
   [saved.name, saved.kind, saved.query, saved.facets, saved.scopePath],
   ["進行中的 P0", "text", "報表", [{ id: "status", value: "3 In Progress" }, { id: "prio", value: "P0 Urgent" }], "100 工作"]);
eq("條件是複製過去的，之後改搜尋不會動到已存的檢視",
   (() => { s.facets.push({ id: "status", value: "x" }); return s.plugin.views()[0].facets.length; })(), 2);

/* 不在搜尋畫面就不給存 */
notices.length = 0;
const nf = mk({ view: "files", promptFor: () => { throw new Error("不該問"); } });
nf.saveCurrentView();
eq("檔案檢視按 ,s：提示而不是存下空的檢視", [nf.plugin.views().length, notices.length], [0, 1]);

/* 同名＝覆寫，並保留原本的快捷字母 */
const ov = mk({ view: "search", searchQuery: "新的", facets: [], promptFor: (l, i, cb) => cb("我的檢視") });
ov.saveCurrentView();
ov.plugin.views()[0].key = "q";
ov.searchQuery = "改過的";
ov.saveCurrentView();
eq("同名覆寫，不會變成兩筆", ov.plugin.views().length, 1);
eq("覆寫後關鍵字更新、快捷字母留著", [ov.plugin.views()[0].query, ov.plugin.views()[0].key], ["改過的", "q"]);

/* ── 3. 清單顯示 ── */
const l = mk({ view: "views" });
l.plugin.data.views = [
  { id: "v1", name: "進行中", key: "w", kind: "file", query: "", facets: [{ id: "status", value: "3" }], scopePath: "100 工作" },
  { id: "v2", name: "全文找報表", key: null, kind: "text", query: "報表", facets: [], scopePath: "" },
];
l.buildList();
eq("名稱獨佔第一行（快捷字母移到 icon 欄）", l.listItems.map((i) => [i.icon, i.label]),
   [["w", "進行中"], ["·", "全文找報表"]]);
eq("摘要說得出種類與條件", l.listItems.map((i) => i.sub),
   ["file names　·　status:3　in 100 工作", "full text　·　\"報表\""]);

/* ── 4. 執行一個檢視 ── */
const r = mk({ view: "views" });
r.runView({ id: "v1", name: "x", kind: "text", query: "報表", facets: [{ id: "status", value: "3" }], scopePath: "100 工作" });
eq("灌回搜尋狀態並直接跳結果（不進組合卡）",
   [r.view, r.searchKind, r.searchQuery, r.facets, r.scopePath, r.composing],
   ["search", "text", "報表", [{ id: "status", value: "3" }], "100 工作", false]);
eq("有重算一次結果", r.built, 1);

/* 認不得的條件靜靜丟掉，不要讓整個檢視打不開 */
const bad = mk({ view: "views" });
bad.runView({ kind: "file", facets: [{ id: "status", value: "3" }, { id: "已刪掉的欄位", value: "x" }] });
eq("欄位被刪掉之後只留認得的條件", bad.facets, [{ id: "status", value: "3" }]);

/* ── 5. 快捷字母 ── */
const key = mk({ view: "views" });
key.plugin.data.views = [{ id: "v1", name: "A", key: null }, { id: "v2", name: "B", key: "w" }];
key.buildList();
key.listIndex = 0;
key.assignViewKey("w");
eq("搶字母：新的拿到，舊的被清掉", key.plugin.views().map((v) => [v.name, v.key]), [["A", "w"], ["B", null]]);
key.assignViewKey("Backspace");
eq("Backspace 清除", key.plugin.views()[0].key, null);

notices.length = 0;
const nokey = mk({ view: "views", runView: () => { throw new Error("不該跑"); } });
nokey.runViewByKey("z");
eq("沒有指定給該字母時提示、不執行", notices.length, 1);

/* ── 6. e 編輯：載回組合卡 ── */
const e = mk({ view: "views" });
e.plugin.data.views = [{ id: "v1", name: "進行中", kind: "file", query: "報表", facets: [{ id: "status", value: "3" }], scopePath: "" }];
e.buildList();
e.handleKey(ev("e"));
eq("e：回到組合卡，條件與關鍵字都在",
   [e.view, e.composing, e.mode, e.searchQuery, e.facets.length],
   ["search", true, "search", "報表", 1]);

/* gd 沒有組合卡（見 openSearch），編輯它只回到輸入列 */
const ed = mk({ view: "views" });
ed.plugin.data.views = [{ id: "v1", name: "資料夾", kind: "dir", query: "日記", facets: [], scopePath: "" }];
ed.buildList();
ed.handleKey(ev("e"));
eq("資料夾搜尋沒有組合卡", [ed.view, ed.composing], ["search", false]);

/* ── 7. x 刪除：先問 y/n，y 才刪 ── */
const d = mk({ view: "views" });
d.plugin.data.views = [{ id: "v1", name: "A" }, { id: "v2", name: "B" }];
d.buildList();
d.listIndex = 0;
d.removeListItem();
eq("x 先問，還沒刪", [d.mode, d.plugin.views().length], ["confirm", 2]);
d.handleKey(ev("n"));
eq("按 n 取消：兩筆都在、回到 nav", [d.mode, d.plugin.views().map((v) => v.name)], ["nav", ["A", "B"]]);
d.removeListItem();
d.handleKey(ev("y"));
eq("按 y 才刪掉游標那一筆", d.plugin.views().map((v) => v.name), ["B"]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
