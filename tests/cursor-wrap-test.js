const Module = require("module");
const stub = { obsidian: { Plugin: class {}, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal, HALF_PAGE } = require(require("./_probe.js").probePath()).__test;

const m = Object.assign(Object.create(YaziModal.prototype), { visual: 0 });
let fail = 0;
const eq = (n, got, want) => { const ok = got === want; if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + got + (ok ? "" : "  want " + want)); };

// 10 個項目
eq("中間往下", m.nextIndex(3, 1, 10), 4);
eq("中間往上", m.nextIndex(3, -1, 10), 2);
eq("最後一個按 j → 回到第一個", m.nextIndex(9, 1, 10), 0);
eq("第一個按 k → 跳到最後一個", m.nextIndex(0, -1, 10), 9);
eq("半頁往下撞底就停（不循環）", m.nextIndex(9, HALF_PAGE, 10), 9);
eq("半頁往上撞頂就停", m.nextIndex(0, -HALF_PAGE, 10), 0);
eq("半頁正常情況", m.nextIndex(0, HALF_PAGE, 100), HALF_PAGE);
eq("只有一個項目時不繞", m.nextIndex(0, 1, 1), 0);
eq("空清單不會炸", m.nextIndex(0, 1, 0), 0);

m.visual = 1;
eq("visual 模式下不循環（下）", m.nextIndex(9, 1, 10), 9);
eq("visual 模式下不循環（上）", m.nextIndex(0, -1, 10), 0);
m.visual = 0;
eq("離開 visual 後又會循環", m.nextIndex(9, 1, 10), 0);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
