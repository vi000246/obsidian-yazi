/* 預覽捲動：算出來的距離對不對、會不會誤動到別的狀態 */
const Module = require("module");
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal, PREVIEW_SCROLL_KEYS } = require(require("./_probe.js").probePath()).__test;

global.window = { getComputedStyle: () => ({ lineHeight: "20px" }) };
const preview = { scrollTop: 0, clientHeight: 400 };
const m = Object.assign(Object.create(YaziModal.prototype), { previewEl: preview });

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "  want " + JSON.stringify(want))); };

eq("行高讀得到", m.previewLinePx(), 20);
preview.scrollTop = 0; m.seekPreview("seek", 1);
eq("J ＝ 5 行 ＝ 100px", preview.scrollTop, 100);
m.seekPreview("seek", -1);
eq("K 捲回來", preview.scrollTop, 0);
m.seekPreview("line", 1);
eq("^e ＝ 1 行", preview.scrollTop, 20);
preview.scrollTop = 0; m.seekPreview("page", 1);
eq("^f ＝ 一頁留兩行重疊（400-40）", preview.scrollTop, 360);
preview.scrollTop = 0; m.seekPreview("half", 1);
eq("^d ＝ 半頁", preview.scrollTop, 180);
preview.scrollTop = 500; m.seekPreview("page", -1);
eq("^b 往回一頁", preview.scrollTop, 140);

/* 極端情況：欄很矮的時候不能算出負的或 0 距離 */
const tiny = { scrollTop: 0, clientHeight: 10 };
const m2 = Object.assign(Object.create(YaziModal.prototype), { previewEl: tiny });
m2.seekPreview("page", 1);
eq("欄比兩行還矮時至少捲一行", tiny.scrollTop, 20);

/* 拿不到 previewEl 不能爆 */
const m3 = Object.assign(Object.create(YaziModal.prototype), { previewEl: null });
m3.seekPreview("seek", 1);
eq("沒有預覽欄時安靜跳過", true, true);

/* getComputedStyle 壞掉時的 fallback */
global.window = { getComputedStyle: () => { throw new Error("no style"); } };
eq("拿不到行高就用估的 20px", m.previewLinePx(), 20);

eq("Ctrl 鍵表", Object.entries(PREVIEW_SCROLL_KEYS).map(([k, v]) => k + ":" + v.join("")),
   ["e:line1", "y:line-1", "d:half1", "u:half-1", "f:page1", "b:page-1"]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
