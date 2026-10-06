/*
 * gf 的 task id 捷徑：
 *   1. core/taskid.js —— 哪些輸入算 id、哪些 frontmatter 算 task
 *   2. buildSearchListRaw —— id 命中的 task 釘在最前面，不像 id 時結果完全不變
 *   3. Enter —— 只命中一張就直接開檔、不進結果頁；多張照常進結果頁
 *
 * stub 把 prepareFuzzySearch 設成 null，走小寫子字串的退路比對器（同 search-rank-test）。
 */
const Module = require("module");
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } },
  PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } },
  Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } },
  Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal } = require(require("./_probe.js").probePath()).__test;
const { parseTaskIdQuery, taskIdOf, matchesTaskId } = require("../src/core/taskid.js");

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want))); };

/* ── 1. 輸入形狀 ── */
eq("純數字", parseTaskIdQuery("84"), { prefix: null, num: 84 });
eq("前綴＋數字（小寫、無連字號）", parseTaskIdQuery("ob84"), { prefix: "OB", num: 84 });
eq("前綴＋連字號＋數字", parseTaskIdQuery("OB-84"), { prefix: "OB", num: 84 });
eq("大小寫混用", parseTaskIdQuery("sP-209"), { prefix: "SP", num: 209 });
eq("前後空白不算", parseTaskIdQuery("  84 "), { prefix: null, num: 84 });
eq("前導零照數值比", parseTaskIdQuery("084"), { prefix: null, num: 84 });
eq("多個字不算 id", parseTaskIdQuery("OB 84"), null);
eq("一般關鍵字不算 id", parseTaskIdQuery("api 整合"), null);
eq("數字在前不算 id", parseTaskIdQuery("84ob"), null);
eq("只有連字號＋數字不算 id", parseTaskIdQuery("-84"), null);
eq("空字串不算 id", parseTaskIdQuery(""), null);

/* ── frontmatter ── */
eq("task 有 id", taskIdOf({ type: "task", id: "OB-84" }), { prefix: "OB", num: 84, id: "OB-84" });
eq("不是 task 不算", taskIdOf({ type: "project", id: "OB-84" }), null);
eq("沒有 id 不算", taskIdOf({ type: "task" }), null);
eq("id 形狀不對不算", taskIdOf({ type: "task", id: "mark-done-btn" }), null);
eq("純數字查詢比所有前綴", [matchesTaskId({ type: "task", id: "OB-84" }, parseTaskIdQuery("84")),
  matchesTaskId({ type: "task", id: "SP-84" }, parseTaskIdQuery("84"))], [true, true]);
eq("有前綴就只比那個前綴", matchesTaskId({ type: "task", id: "SP-84" }, parseTaskIdQuery("ob84")), false);
eq("數字要完全相等（84 ≠ 184）", matchesTaskId({ type: "task", id: "OB-184" }, parseTaskIdQuery("84")), false);

/* ── 2. 假 vault ── */
const file = (path) => { const name = path.split("/").pop();
  return { path, name, basename: name.replace(/\.md$/, ""), extension: "md" }; };
const FM = {
  "work/OB-84 連 DB 的 API 整合測試 PoC.md": { type: "task", id: "OB-84" },
  "side/SP-84 跑步課表.md": { type: "task", id: "SP-84" },
  "side/SP-209 某件事.md": { type: "task", id: "SP-209" },
  "work/OB-184 別的單.md": { type: "task", id: "OB-184" },
  "notes/第 84 次會議.md": null,
  // 檔名看起來像單號、frontmatter 卻不是：不能靠檔名猜
  "notes/OB-209 草稿.md": { type: "note", id: "OB-209" },
};
const FILES = Object.keys(FM).map(file);

const mk = (q, kind, scope) => {
  const opened = [];
  const m = Object.assign(Object.create(YaziModal.prototype), {
    view: "search", searchKind: kind || "file", searchQuery: q, facets: [],
    // 範圍：預設全 vault；id 查找跟一般 gf 一樣只在範圍內找
    scopePath: scope || "",
    listItems: [], listIndex: 0, listFilter: "", layers: [], mode: "search",
    t: (k, d, v) => (d || k).replace(/\{(\w+)\}/g, (_, x) => (v && v[x] != null ? v[x] : "")),
    plugin: { data: { sortSearch: { field: "natural", reverse: false, foldersFirst: true } } },
    app: {
      vault: {
        getFiles: () => FILES, getMarkdownFiles: () => FILES, getAllLoadedFiles: () => FILES,
        getAbstractFileByPath: (p) => FILES.find((x) => x.path === p) || null,
      },
      metadataCache: { getFileCache: (f) => ({ frontmatter: FM[f.path] }) },
    },
    inputWrapEl: { hide() {} }, inputEl: { blur() {}, value: q }, filter: "",
    openFile(f, mode) { opened.push([f.path, mode]); },
    showResults() { opened.push(["<results>"]); },
    closeOverlays() {}, swallow() {}, render() {},
  });
  m.buildSearchList();
  m.opened = opened;
  return m;
};
const paths = (m) => m.listItems.map((it) => it.path);

const two = mk("84");
eq("純數字 84：OB-84、SP-84 釘在最前（前綴字母序），其他模糊命中（含 OB-184）照舊排在後面",
  paths(two), ["work/OB-84 連 DB 的 API 整合測試 PoC.md", "side/SP-84 跑步課表.md", "notes/第 84 次會議.md", "work/OB-184 別的單.md"]);
eq("純數字 84：184 不算 id 命中", two.taskHits.map((f) => f.path).includes("work/OB-184 別的單.md"), false);

const one = mk("sp-209");
eq("sp-209：只命中一張", one.taskHits.map((f) => f.path), ["side/SP-209 某件事.md"]);
eq("sp-209：結果清單第一筆就是它", paths(one)[0], "side/SP-209 某件事.md");

eq("ob209：檔名像單號但 frontmatter 不是 task → 不算命中", mk("ob209").taskHits, []);
eq("不像 id 的輸入：沒有 id 命中", mk("會議").taskHits, []);
eq("不像 id 的輸入：結果跟原本一樣（只照範圍＋模糊比對）", paths(mk("會議", "file", "notes")), ["notes/第 84 次會議.md"]);

/* 範圍：id 查找跟一般 gf 一樣只看範圍內 */
eq("範圍 side/ 打 84：只剩 SP-84 一張", mk("84", "file", "side").taskHits.map((f) => f.path), ["side/SP-84 跑步課表.md"]);
eq("範圍 notes/ 打 84：範圍內沒有 task → 沒有 id 命中", mk("84", "file", "notes").taskHits, []);
eq("範圍 notes/ 打 84：結果就是原本的 gf", paths(mk("84", "file", "notes")), ["notes/第 84 次會議.md"]);
eq("範圍 work/ 打 sp-209：範圍外的單找不到", mk("sp-209", "file", "work").taskHits, []);
eq("沒對到任何 task 的 id 形狀（999）：照原本的 gf", paths(mk("999")), []);
eq("gd 不做 id 查找", mk("84", "dir").taskHits, []);

/* ── 3. Enter（走真正的 handleKey）── */
const enter = (m, ctrlKey) => {
  m.handleKey({ key: "Enter", type: "keydown", ctrlKey: !!ctrlKey,
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  return m.opened;
};
const ob84 = mk("OB-84");
eq("只命中一張：Enter 直接開那份筆記（current），不進結果頁",
  enter(ob84), [["work/OB-84 連 DB 的 API 整合測試 PoC.md", "current"]]);
eq("只命中一張：開完回到檔案檢視、輸入列收起", [ob84.view, ob84.mode], ["files", "nav"]);
eq("ob84（小寫無連字號）一樣直接開", enter(mk("ob84")), [["work/OB-84 連 DB 的 API 整合測試 PoC.md", "current"]]);
eq("命中兩張：Enter 照常進結果頁", enter(mk("84")), [["<results>"]]);
eq("範圍 side/ 打 84：範圍內只剩一張 → Enter 直接開", enter(mk("84", "file", "side")), [["side/SP-84 跑步課表.md", "current"]]);
eq("範圍 notes/ 打 84：範圍內沒有 task → Enter 照常進結果頁", enter(mk("84", "file", "notes")), [["<results>"]]);
eq("範圍 work/ 打 sp-209：沒命中也沒結果 → Enter 什麼都不做", enter(mk("sp-209", "file", "work")), []);
eq("不像 id：Enter 照常進結果頁", enter(mk("會議")), [["<results>"]]);
const ed = mk("OB-84");
ed.editingView = { name: "v" };
ed.saveEditedView = function () { this.opened.push(["<saved>"]); };
eq("編輯檢視中：Enter 仍是存回，不被 id 捷徑搶走", enter(ed), [["<saved>"]]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
