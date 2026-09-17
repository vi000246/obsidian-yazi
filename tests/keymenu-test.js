/* renderKeyMenu() 的 DOM 路徑：用最小的 Obsidian DOM helper shim 真的跑一次，
   打錯的屬性名、拼錯的 class、少建的元素都會在這裡現形。 */
const Module = require("module");
const PLAT = { isWin: true, isMacOS: false, isDesktopApp: true };
const stub = {
  obsidian: { Plugin: class {}, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Platform: PLAT, prepareFuzzySearch: null },
  child_process: { spawn: () => ({ unref() {} }) },
  electron: { shell: {} },
};
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal } = require(require("./_probe.js").probePath()).__test;

// 最小 DOM：只做 yazi-explorer 真的會用到的那幾支
const el = (tag, cls) => {
  const n = {
    tag, cls: cls || "", text: "", children: [], hidden: false,
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    createDiv(o) { const c = el("div", (o && o.cls) || ""); if (o && o.text) c.text = o.text; this.children.push(c); return c; },
    createSpan(o) { const c = el("span", (o && o.cls) || ""); if (o && o.text) c.text = o.text; this.children.push(c); return c; },
    empty() { this.children = []; },
    setText(t) { this.text = String(t); },
    show() { this.hidden = false; }, hide() { this.hidden = true; },
  };
  return n;
};
const dump = (n) => n.children.map((c) => c.cls + (c.text ? ":" + c.text : "") + (c.children.length ? "[" + dump(c).join(",") + "]" : ""));

const folder = { path: "100 工作", children: [] };
const app = { vault: { adapter: { getBasePath: () => "C:" }, getName: () => "MainRepo",
                       getAbstractFileByPath: (p) => (p === "100 工作" ? folder : null) } };
/* 用真的英文語言檔當 t()：漏掉的 key 會以「畫面上出現 key 名稱」的形狀現形 */
const EN = require("../src/i18n/en.js");
const plugin = { t: (k, f) => EN[k] || f || k, settings: { openers: [
  { id: "dir", label: "開資料夾", key: "f", appliesTo: "folder", kind: "system", enabled: true },
  { id: "c", label: "Claude Code", key: "c", appliesTo: "both", kind: "command", enabled: true, command: "claude" },
  { id: "g", label: "lazygit", key: "g", appliesTo: "both", kind: "command", enabled: true, command: "lazygit" },
  { id: "t", label: "終端機", key: "t", appliesTo: "both", kind: "command", enabled: true, command: "wt" },
  { id: "r", label: "在總管顯示", key: "r", appliesTo: "both", kind: "reveal", enabled: true },
] } };
const m = Object.assign(Object.create(YaziModal.prototype), {
  app, view: "files", cwd: folder, current: () => folder, plugin,
  menuEl: el("div", "yazi-keymenu"), kmTitleEl: el("div"), kmItemsEl: el("div"), kmHintEl: el("div"),
});

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + name + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};

m.pending = null; m.renderKeyMenu();
eq("沒有 pending：卡片收起來", m.menuEl.hidden, true);

m.pending = "open"; m.renderKeyMenu();
eq("O：卡片打開", m.menuEl.hidden, false);
eq("O：標題列", dump(m.kmTitleEl), ["yazi-km-prefix:O", "yazi-km-desc:" + EN["menu.open.desc"] + "　·　100 工作"]);
eq("O：項目列", dump(m.kmItemsEl), [
  "yazi-km-row[yazi-km-key:f,yazi-km-label:開資料夾]",
  "yazi-km-row[yazi-km-key:c,yazi-km-label:Claude Code]",
  "yazi-km-row[yazi-km-key:g,yazi-km-label:lazygit]",
  "yazi-km-row[yazi-km-key:t,yazi-km-label:終端機]",
  "yazi-km-row[yazi-km-key:r,yazi-km-label:在總管顯示]",
]);
eq("O：5 項＝一欄 5 列", m.kmItemsEl.style.props["--km-rows"], "5");
eq("O：底下那行", m.kmHintEl.text, "Esc to cancel");

m.pending = "sort"; m.renderKeyMenu();
eq("S：11 項＝兩欄 6 列", m.kmItemsEl.style.props["--km-rows"], "6");
eq("S：項目數", m.kmItemsEl.children.length, 11);

m.pending = "assign"; m.renderKeyMenu();
eq("m：沒有項目、只有說明", [m.kmItemsEl.children.length, m.kmHintEl.text],
   [0, EN["menu.assign.note"] + "　·　Esc to cancel"]);

m.pending = null; m.renderKeyMenu();
eq("按完之後又收起來", m.menuEl.hidden, true);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
