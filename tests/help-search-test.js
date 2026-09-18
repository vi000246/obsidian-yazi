/* 說明頁的 / 搜尋：過濾規則、highlight 的分段、以及退出的層次 */
const Module = require("module");
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal, HELP } = require(require("./_probe.js").probePath()).__test;

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want))); };

/* 極簡假 DOM：只記錄結構，足夠驗證「畫了什麼」 */
function mkEl() {
  const el = {
    children: [], cls: "", text: "",
    empty() { el.children.length = 0; },
    createDiv(o) { const c = mkEl(); c.cls = (o && o.cls) || ""; c.text = (o && o.text) || ""; el.children.push(c); return c; },
    createSpan(o) { const c = mkEl(); c.cls = (o && o.cls) || ""; c.text = (o && o.text) || ""; el.children.push(c); return c; },
    createEl(tag, o) { const c = mkEl(); c.tag = tag; c.cls = (o && o.cls) || ""; c.text = (o && o.text) || ""; el.children.push(c); return c; },
    setText(t) { el.text = t; },
  };
  return el;
}

const mk = (over) => Object.assign(Object.create(YaziModal.prototype), {
  parentEl: mkEl(), mainEl: mkEl(), previewEl: mkEl(),
  showHelp: true, helpFilter: "", mode: "nav", view: "files", pending: null, plugin: null,
  render() {}, swallow() {},
  inputEl: { value: "", focus() {}, select() {} },
  inputWrapEl: { show() {}, hide() {} },
  inputLabelEl: { setText() {} },
}, over);

/* 畫出來的所有說明列（[鍵位, 說明]），把 highlight 的分段接回完整字串 */
const flat = (el, out) => {
  out = out || [];
  for (const c of el.children) {
    if (c.cls === "yazi-help-row") {
      const [k, d] = c.children;
      const join = (x) => (x.children.length ? x.children.map((y) => y.text).join("") : x.text);
      out.push([join(k), join(d)]);
    } else flat(c, out);
  }
  return out;
};
const marks = (el, out) => {
  out = out || [];
  for (const c of el.children) {
    if (c.tag === "mark") out.push(c.text);
    marks(c, out);
  }
  return out;
};
const rowsOf = (m) => flat(m.parentEl).concat(flat(m.mainEl)).concat(flat(m.previewEl));
const marksOf = (m) => marks(m.parentEl).concat(marks(m.mainEl)).concat(marks(m.previewEl));

/* ── 1. 沒有搜尋就是全部 ── */
const all = mk();
all.renderHelp();
const total = HELP.filter((r) => r.length > 1).length;
eq("沒搜尋時列出全部說明列", rowsOf(all).length, total);
eq("沒搜尋時不 highlight 任何東西", marksOf(all), []);

/*
 * ── 2. 搜尋會收斂，且命中的字被 highlight ──
 * 關鍵字刻意挑一個**不是段落標題**的字：命中標題會整段保留（那是設計，見第 3 組），
 * 用 "bookmark" 之類的字測「每一列都命中」會與那個行為打架。
 */
const f = mk({ helpFilter: "wheel" });
f.renderHelp();
const rows = rowsOf(f);
eq("搜尋之後比全部少", rows.length < total && rows.length > 0, true);
eq("留下來的每一列都真的命中（鍵位或說明）",
   rows.every(([k, d]) => (k + " " + d).toLowerCase().includes("wheel")), true);
eq("highlight 的片段都是關鍵字本身",
   marksOf(f).every((t) => t.toLowerCase() === "wheel"), true);

/* 大小寫不敏感 */
const up = mk({ helpFilter: "WHEEL" });
up.renderHelp();
eq("大小寫不敏感", rowsOf(up).length, rows.length);

/* 用鍵位搜尋也找得到 */
const bykey = mk({ helpFilter: "PageDown" });
bykey.renderHelp();
eq("用鍵位找得到", rowsOf(bykey).length > 0, true);

/* ── 3. 命中段落標題就整段留著 ── */
const sec = mk({ helpFilter: "Preview" });
sec.renderHelp();
const prevRows = rowsOf(sec);
eq("命中段落標題時，段落裡不含關鍵字的列也留著",
   prevRows.some(([k, d]) => !(k + " " + d).toLowerCase().includes("preview")), true);

/* ── 4. 找不到就明講 ── */
const none = mk({ helpFilter: "zzzznope" });
none.renderHelp();
eq("找不到時不留空欄，畫一行說明", rowsOf(none).length, 0);
const empties = [];
const findEmpty = (el) => { for (const c of el.children) { if (c.cls === "yazi-empty") empties.push(c.text); findEmpty(c); } };
findEmpty(none.parentEl);
eq("那行說明帶著關鍵字", empties.length === 1 && empties[0].includes("zzzznope"), true);

/* ── 5. highlight 的分段：同一列出現兩次也要各自包起來 ── */
const el = mkEl();
const h = mk();
h.hilite(el, "aXbXc", "x");
eq("兩次命中各包一個 mark", el.children.map((c) => (c.tag === "mark" ? "[" + c.text + "]" : c.text)).join(""),
   "a[X]b[X]c");
const el2 = mkEl();
h.hilite(el2, "<Space>", "");
eq("沒有關鍵字時整串直接寫入（不經過分段）", [el2.text, el2.children.length], ["<Space>", 0]);
const el3 = mkEl();
h.hilite(el3, "abc", "abc");
eq("整串命中", el3.children.map((c) => c.tag + ":" + c.text), ["mark:abc"]);

/* ── 6. / 進入搜尋、Esc 一次退一層 ── */
const ev = (key) => ({ key, type: "keydown", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
const k = mk({ scope: { keys: [] } });
k.handleKey(ev("/"));
eq("說明頁按 / 進入搜尋模式（不是篩選檔案）", k.mode, "helpfilter");

const esc = mk({ mode: "helpfilter", helpFilter: "book", endInput() { this.mode = "nav"; } });
esc.escapeBack();
eq("第一次 Esc 只清掉搜尋，說明頁還在", [esc.showHelp, esc.helpFilter, esc.mode], [true, "", "nav"]);
esc.escapeBack();
eq("第二次 Esc 才關掉說明頁", esc.showHelp, false);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
