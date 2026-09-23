/* 按鍵派工：捲預覽的那幾顆有沒有接到、有沒有誤傷移游標的鍵 */
const Module = require("module");
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal, HALF_PAGE } = require(require("./_probe.js").probePath()).__test;

const log = [];
const mk = (view) => Object.assign(Object.create(YaziModal.prototype), {
  view: view || "files", mode: "nav", pending: null, showHelp: false, visual: 0,
  listItems: [{}, {}, {}], listIndex: 0,
  seekPreview: (u, d) => log.push("seek:" + u + ":" + d),
  move: (n) => log.push("move:" + n),
  swallow: () => log.push("swallow"),
  render: () => {},
  scope: { keys: [] },
});
const press = (m, key, mods) => {
  log.length = 0;
  const ev = Object.assign({ key, type: "keydown", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} }, mods);
  m.handleKey(ev);
  return log.filter((x) => x !== "swallow");
};

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "  want " + JSON.stringify(want))); };

const f = mk("files");
eq("J → 捲預覽 5 行", press(f, "J"), ["seek:seek:1"]);
eq("K → 往回", press(f, "K"), ["seek:seek:-1"]);
eq("PageDown → 捲預覽一頁", press(f, "PageDown"), ["seek:page:1"]);
eq("PageUp → 往回一頁", press(f, "PageUp"), ["seek:page:-1"]);
eq("^e → 捲一行", press(f, "e", { ctrlKey: true }), ["seek:line:1"]);
eq("^y → 往回一行", press(f, "y", { ctrlKey: true }), ["seek:line:-1"]);
eq("^d → 捲半頁", press(f, "d", { ctrlKey: true }), ["seek:half:1"]);
eq("^f → 捲一頁", press(f, "f", { ctrlKey: true }), ["seek:page:1"]);
eq("^b → 往回一頁", press(f, "b", { ctrlKey: true }), ["seek:page:-1"]);

/* 沒被誤傷的：平鍵 d/u 仍然是移游標 */
eq("d（不按 Ctrl）→ 游標半頁", press(f, "d"), ["move:" + HALF_PAGE]);
eq("u（不按 Ctrl）→ 游標半頁往上", press(f, "u"), ["move:" + -HALF_PAGE]);
eq("j → 下一個檔案", press(f, "j"), ["move:1"]);
eq("方向鍵下 → 下一個檔案", press(f, "ArrowDown"), ["move:1"]);

/* 清單檢視也要能捲 */
const l = mk("search");
eq("清單：J", press(l, "J"), ["seek:seek:1"]);
eq("清單：PageDown", press(l, "PageDown"), ["seek:page:1"]);
eq("清單：j 仍是移動", press(l, "j"), ["move:1"]);

/* 輸入中不能被搶走：mode 不是 nav 時走別條路 */
const typing = mk("files"); typing.mode = "filter";
typing.inputEl = { value: "", focus() {} };
typing.inputWrapEl = { show() {}, hide() {} };
eq("篩選輸入中：PageDown 不捲預覽", press(typing, "PageDown"), []);

/*
 * gb ＝背景開新分頁。開的必須是「現在這個檢視的游標」那一筆：
 * 清單檢視（搜尋結果、書籤、大綱…）走 activateListItem，跟同一份清單裡的 o / t 一致；
 * 走 enter() 的話讀到的是底下檔案檢視的游標，等於在搜尋結果按 gb 開錯檔。
 */
const spy = (view) => {
  const m = mk(view);
  m.enter = (mode) => log.push("enter:" + mode);
  m.activateListItem = (mode) => log.push("list:" + mode);
  return m;
};
const sb = spy("search");
press(sb, "g");
eq("搜尋結果：gb → 開清單游標那一筆", press(sb, "b"), ["list:tab-bg"]);
const bb = spy("bookmarks");
press(bb, "g");
eq("書籤清單：gb → 開清單游標那一筆", press(bb, "b"), ["list:tab-bg"]);
const fb = spy("files");
press(fb, "g");
eq("檔案檢視：gb → 開檔案游標那一筆", press(fb, "b"), ["enter:tab-bg"]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
