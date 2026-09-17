const Module = require("module");
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal, wheelPx } = require(require("./_probe.js").probePath()).__test;

global.window = { getComputedStyle: () => ({ lineHeight: "20px" }) };

// 三欄 + 底部狀態列的最小替身：contains() 就是「是不是我的子孫」
const node = (name, kids = []) => ({ name, kids,
  contains(t) { return t === this || this.kids.some((k) => k.contains(t)); } });
const inPreview = node("預覽裡的一段文字");
const preview = Object.assign(node("preview", [inPreview]), { scrollTop: 0, clientHeight: 400 });
const fileRow = node("中間欄的一列");
const barChild = node("底部狀態列的輸入框");
const bar = node("bar", [barChild]);

const mk = (over) => Object.assign(Object.create(YaziModal.prototype),
  { previewEl: preview, barEl: bar, showHelp: false, composing: false }, over);
const wheel = (target, delta = 120, extra = {}) => {
  let prevented = false;
  const ev = Object.assign({ target, deltaY: delta, deltaMode: 0, preventDefault: () => { prevented = true; } }, extra);
  return { ev, prevented: () => prevented };
};

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "  want " + JSON.stringify(want))); };

let m = mk(); preview.scrollTop = 0;
let w = wheel(fileRow);
m.handleWheel(w.ev);
eq("滑鼠在檔案清單上 → 捲預覽", [preview.scrollTop, w.prevented()], [120, true]);

w = wheel(fileRow, -120); m.handleWheel(w.ev);
eq("往回滾", preview.scrollTop, 0);

preview.scrollTop = 50;
w = wheel(inPreview); m.handleWheel(w.ev);
eq("已經停在預覽欄上 → 不攔（走原生）", [preview.scrollTop, w.prevented()], [50, false]);

w = wheel(barChild); m.handleWheel(w.ev);
eq("底部狀態列 → 不攔", [preview.scrollTop, w.prevented()], [50, false]);

m = mk({ showHelp: true }); w = wheel(fileRow); m.handleWheel(w.ev);
eq("說明頁 → 不攔（三欄都是說明內文）", [preview.scrollTop, w.prevented()], [50, false]);

m = mk({ composing: true }); w = wheel(fileRow); m.handleWheel(w.ev);
eq("搜尋組合卡 → 不攔", [preview.scrollTop, w.prevented()], [50, false]);

m = mk(); w = wheel(fileRow, 120, { ctrlKey: true }); m.handleWheel(w.ev);
eq("Ctrl+滾輪 → 放行給 Obsidian 縮放", [preview.scrollTop, w.prevented()], [50, false]);

preview.scrollTop = 0;
w = wheel(fileRow, 3, { deltaMode: 1 }); m.handleWheel(w.ev);
eq("deltaMode=1（行）要換算成 px", preview.scrollTop, 60);
preview.scrollTop = 0;
w = wheel(fileRow, 1, { deltaMode: 2 }); m.handleWheel(w.ev);
eq("deltaMode=2（頁）換算", preview.scrollTop, 400);

w = wheel(fileRow, 0); m.handleWheel(w.ev);
eq("水平滾動（deltaY=0）不攔", w.prevented(), false);

eq("wheelPx 預設是像素", wheelPx({ deltaY: 100, deltaMode: 0 }, 20, 400), 100);
m = mk({ previewEl: null }); w = wheel(fileRow); m.handleWheel(w.ev);
eq("沒有預覽欄不會炸", w.prevented(), false);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
