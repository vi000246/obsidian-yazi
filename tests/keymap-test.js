/*
 * 鍵位覆寫：解析（core/keymap.js）＋ 在 handleKey 裡真的生效。
 * 重點在**不能生效的地方**：打字時、書籤字母、無限迴圈。
 */
const Module = require("module");
const { parseKeymap, keysOf } = require("../src/core/keymap.js");

const PLAT = { isWin: true, isMacOS: false, isDesktopApp: true };
const stub = {
  obsidian: {
    Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } },
    PluginSettingTab: class { constructor(a, p) { this.app = a; this.plugin = p; } },
    Setting: class { constructor() { return new Proxy(this, { get: () => () => this }); } },
    Modal: class {}, Notice: class {}, Component: class { load() {} unload() {} },
    MarkdownRenderer: { render: () => Promise.resolve() }, Platform: PLAT, prepareFuzzySearch: null,
  },
};
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal, HALF_PAGE } = require(require("./_probe.js").probePath()).__test;

let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};

/* ── 解析 ── */
eq("單鍵 → 單鍵", parseKeymap("map w O").map, { w: ["O"] });
eq("單鍵 → 序列", parseKeymap("map J gt").map, { J: ["g", "t"] });
eq("unmap", parseKeymap("unmap S").unmap, { S: true });
eq("註解與空行忽略", parseKeymap("# hi\n\n  \nmap a b").map, { a: ["b"] });
eq("角括號鍵名", parseKeymap("map z <Space>").map, { z: [" "] });
eq("多個角括號", keysOf("<PageDown><Esc>"), ["PageDown", "Escape"]);
eq("混合", keysOf("g<Enter>"), ["g", "Enter"]);
eq("後寫的覆蓋先寫的", parseKeymap("map a b\nmap a c").map, { a: ["c"] });
eq("unmap 會清掉同一顆的 map", parseKeymap("map a b\nunmap a"), { map: {}, unmap: { a: true }, errors: [] });
eq("map 會清掉同一顆的 unmap", parseKeymap("unmap a\nmap a b").unmap, {});

/* 寫壞的那幾行要指得出來，而不是靜靜不生效 */
const bad = parseKeymap("map\nmap a\nmap ab c\nunmap a b\nmap a a\nfoo a b\nmap a <Nope>");
eq("錯誤行數與原因", bad.errors.map((e) => e.line + ":" + e.reason), [
  "1:map needs two arguments: map <key> <target>",
  "2:map needs two arguments: map <key> <target>",
  "3:the key on the left must be a single key",
  "4:unmap needs exactly one key",
  "5:mapping a key to itself does nothing",
  "6:unknown command (expected map or unmap)",
  "7:unknown key <Nope>",
]);
eq("壞行不影響好行", parseKeymap("map a\nmap w O").map, { w: ["O"] });

/* ── 在 modal 裡真的生效 ── */
const log = [];
const mk = (keymapText, over) => Object.assign(Object.create(YaziModal.prototype), {
  view: "files", mode: "nav", pending: null, showHelp: false, visual: 0,
  listItems: [{}, {}, {}], listIndex: 0,
  plugin: { settings: { keymap: keymapText } },
  move: (n) => log.push("move:" + n),
  seekPreview: (u, d) => log.push("seek:" + u + ":" + d),
  openMenu: () => log.push("openMenu"),
  openSearch: (k) => log.push("search:" + k),
  goEdge: (e) => log.push("edge:" + e),
  swallow: () => {}, render: () => {},
}, over);
const press = (m, key) => {
  log.length = 0;
  m.handleKey({ key, type: "keydown", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  return log.slice();
};

eq("沒有設定時完全照原本", press(mk(""), "j"), ["move:1"]);
eq("map w O：按 w 等於按 O", press(mk("map w O"), "w"), ["openMenu"]);
eq("被映走的鍵本身仍照原本（O 還是 O）", press(mk("map w O"), "O"), ["openMenu"]);
eq("map J gt：序列會被重播，前綴照常運作", press(mk("map J gt"), "J"), ["search:text"]);
eq("unmap：那顆鍵什麼都不做", press(mk("unmap j"), "j"), []);
eq("沒被 unmap 的鍵不受影響", press(mk("unmap j"), "k"), ["move:-1"]);
eq("map 到本來就有的鍵：兩顆都能用", press(mk("map n j"), "n"), ["move:1"]);

/* 互相指定不能變成無限迴圈 */
const swap = mk("map j k\nmap k j");
eq("j → k", press(swap, "j"), ["move:-1"]);
eq("k → j（不會無限遞迴）", press(swap, "k"), ["move:1"]);

/* ── 不能生效的地方 ── */
const typing = mk("map j k", { mode: "filter", inputEl: { value: "", focus() {} }, inputWrapEl: { show() {}, hide() {} } });
eq("打字時不 remap（篩選輸入中）", press(typing, "j"), []);

const assigning = mk("map a b", { pending: "assign", assignBookmarkKey: (k) => log.push("assign:" + k) });
eq("指定書籤字母時不 remap（不然那幾個字母就沒辦法當捷徑）", press(assigning, "a"), ["assign:a"]);

const jumping = mk("map a b", { pending: "'", jumpToBookmark: (k) => log.push("jump:" + k) });
eq("跳書籤時不 remap", press(jumping, "a"), ["jump:a"]);

/* 平鍵 d 仍是游標半頁（確認沒有誤傷既有行為） */
eq("沒設定時 d 還是游標半頁", press(mk(""), "d"), ["move:" + HALF_PAGE]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
