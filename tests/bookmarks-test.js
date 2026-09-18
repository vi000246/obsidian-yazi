/* 書籤：自訂名稱、改名（R）、清單顯示成兩行 */
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

const ev = (key) => ({ key, type: "keydown", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });

/* 假 plugin：介面與真的那份一致（回傳 true=新增、false=既有的改名） */
function fakePlugin() {
  const data = { bookmarks: [] };
  return {
    settings: data, data,
    bookmarks: () => data.bookmarks,
    findBookmark: (p) => data.bookmarks.find((b) => b.path === p) || null,
    bookmarkByKey: (k) => data.bookmarks.find((b) => b.key === k) || null,
    async removeBookmark(path) { data.bookmarks = data.bookmarks.filter((b) => b.path !== path); },
    async addBookmark(path, name) {
      const e = this.findBookmark(path);
      if (e) { if (name) e.name = name; return false; }
      data.bookmarks.push({ path, name: name || null, key: null, added: Date.now() });
      return true;
    },
  };
}

const F = (path, ext) => ({ path, name: path.split("/").pop(), basename: path.split("/").pop().replace(/\.md$/, ""), extension: ext || "md" });
const diary = F("200 Personal/001 日記/2026/2026-09-18.md");
const folder = Object.assign({ path: "100 工作", name: "100 工作", children: [] });

const mk = (over) => Object.assign(Object.create(YaziModal.prototype), {
  view: "files", mode: "nav", pending: null, showHelp: false, visual: 0, visualAnchor: -1,
  sel: new Set(), listSel: new Set(),
  listItems: [], listIndex: 0, listFilter: "",
  plugin: fakePlugin(), swallow() {}, render() {}, scope: { keys: [] },
  sortCfg: () => ({ field: "natural", reverse: false, foldersFirst: true }),
  buildList() { if (this.view === "bookmarks") this.listItems = this.collectBookmarks(); },
  app: { vault: { getAbstractFileByPath: (p) => (p === diary.path ? diary : p === folder.path ? folder : null) } },
}, over);

/* ── 1. 加書籤會先問名字，預設是不含副檔名的檔名 ── */
let asked = null;
const a = mk({ current: () => diary, promptFor: (label, initial, cb) => { asked = { label, initial }; return cb(initial); } });
a.addBookmark(diary);
eq("預設名稱＝檔名不含副檔名", asked.initial, "2026-09-18");
eq("按 Enter 直接收下預設值", a.plugin.bookmarks().map((b) => [b.path, b.name]),
   [["200 Personal/001 日記/2026/2026-09-18.md", "2026-09-18"]]);

/* 自己取名字 */
const b = mk({ promptFor: (l, i, cb) => cb("今天的日記") });
b.addBookmark(diary);
eq("可以取成想要的名稱", b.plugin.bookmarks()[0].name, "今天的日記");

/* 空白＝取消，什麼都不存 */
const c = mk({ promptFor: (l, i, cb) => cb("   ") });
c.addBookmark(diary);
eq("名稱留空＝取消", c.plugin.bookmarks().length, 0);

/* 資料夾用資料夾名當預設 */
let folderInit = null;
const d = mk({ promptFor: (l, i, cb) => { folderInit = i; return cb(i); } });
d.addBookmark(folder);
eq("資料夾的預設名稱＝資料夾名", folderInit, "100 工作");

/* ── 2. 同一個路徑再加一次＝改名，不會變成兩筆 ── */
const e = mk({ promptFor: (l, i, cb) => cb("第一次") });
e.addBookmark(diary);
e.promptFor = (l, i, cb) => cb("第二次");
e.addBookmark(diary);
eq("同路徑不重複，改成新名字", e.plugin.bookmarks().map((x) => x.name), ["第二次"]);

/* ── 3. 清單：名稱一行、路徑一行，快捷字母在 icon 欄 ── */
const l = mk({ view: "bookmarks" });
l.plugin.data.bookmarks = [
  { path: diary.path, name: "今天的日記", key: "d" },
  { path: folder.path, name: null, key: null },
  { path: "已刪除/x.md", name: "沒了", key: null },
];
l.buildList();
eq("名稱獨佔 label、快捷字母在 icon 欄",
   l.listItems.map((i) => [i.icon, i.label]), [["d", "今天的日記"], ["·", "100 工作"], ["·", "沒了"]]);
eq("路徑放在第二行（sub）", l.listItems[0].sub, diary.path);
eq("沒取名字的舊書籤照樣顯示檔名", l.listItems[1].label, "100 工作");
eq("路徑不存在時標出來", l.listItems[2].missing && l.listItems[2].sub.includes("已刪除/x.md"), true);

/* ── 4. R 改名 ── */
let renameInit = null;
const r = mk({ view: "bookmarks", promptFor: (label, initial, cb) => { renameInit = initial; return cb("改過的名字"); } });
r.plugin.data.bookmarks = [{ path: diary.path, name: "舊名字", key: null }];
r.buildList();
r.handleKey(ev("R"));
eq("R 帶出目前的名稱當預設值", renameInit, "舊名字");
eq("改完存回去（路徑不動）", r.plugin.bookmarks().map((x) => [x.path, x.name]), [[diary.path, "改過的名字"]]);

/* 其他清單的 R 不做事 */
const nr = mk({ view: "views", renameBookmark: () => { throw new Error("不該叫"); } });
nr.handleKey(ev("R"));
eq("檢視清單按 R 不會誤觸書籤改名", true, true);

/* ── 5. x 刪除：先問 y/n，y 才刪 ── */
const x = mk({ view: "bookmarks" });
x.plugin.data.bookmarks = [{ path: diary.path, name: "今天的日記", key: null }, { path: folder.path, name: null, key: null }];
x.buildList();
x.listIndex = 0;
x.handleKey(ev("x"));
eq("x 先問，還沒刪", [x.mode, x.plugin.bookmarks().length], ["confirm", 2]);
x.handleKey(ev("n"));
eq("按 n 取消：兩筆都在、回到 nav", [x.mode, x.plugin.bookmarks().length], ["nav", 2]);
x.handleKey(ev("x"));
x.handleKey(ev("y"));
eq("按 y 才刪掉游標那一筆", x.plugin.bookmarks().map((b) => b.path), [folder.path]);
eq("Esc 也能取消（confirm 是 OVERLAYS 的一列）",
   (() => { x.buildList(); x.listIndex = 0; x.handleKey(ev("x")); x.escapeBack(); return [x.mode, x.plugin.bookmarks().length]; })(),
   ["nav", 1]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
