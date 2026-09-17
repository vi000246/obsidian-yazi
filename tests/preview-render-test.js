(async () => {
const Module = require("module");
let loaded = 0, unloaded = 0, rendered = [];
class FakeComponent { load() { loaded++; } unload() { unloaded++; } }
let resolveRender = null;
const MarkdownRenderer = {
  render: (app, md, box, path, comp) => {
    rendered.push({ md, path, comp });
    box.createEl("table");                       // 假裝畫出一張表
    return new Promise((r) => { resolveRender = r; });
  },
};
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class { constructor(m) { NOTICES.push(String(m)); } },
  Component: FakeComponent, MarkdownRenderer, Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const NOTICES = [];
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal } = require(require("./_probe.js").probePath()).__test;

const mkEl = (tag, cls) => ({ tag, cls: cls || "", children: [], removed: false,
  createEl(t, o) { const c = mkEl(t, o && o.cls); this.children.push(c); c.parent = this; return c; },
  createDiv(o) { return this.createEl("div", o); },
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); },
  empty() { this.children = []; } });

const plugin = {
  settings: { preview: { renderMarkdown: true } },
  setRenderPreview(on) { this.settings.preview.renderMarkdown = !!on; },
  t: (k, f) => f || k,
};
const m = Object.assign(Object.create(YaziModal.prototype), { app: {}, plugin, render() {}, previewToken: 1 });

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want))); };

eq("預設就是渲染", m.renderMd(), true);

const el1 = mkEl("div"); const pre1 = el1.createEl("pre");
m.renderMarkdownInto(el1, pre1, "| a | b |", { path: "a.md" });
eq("建了 markdown-rendered 容器", el1.children.map((c) => c.cls).filter(Boolean), ["yazi-preview-md markdown-rendered"]);
eq("Component 已 load", [loaded, unloaded], [1, 0]);
eq("渲染中純文字還在（不留空窗）", pre1.removed, false);
resolveRender();
await Promise.resolve(); await Promise.resolve();
eq("渲染完才拿掉純文字", pre1.removed, true);
eq("餵進 renderer 的是洗過的字串", rendered[0].md, "| a | b |");

/* 游標移走 → 舊的 Component 要被回收，過期的 render 不能再動 DOM */
const el2 = mkEl("div"); const pre2 = el2.createEl("pre");
m.renderMarkdownInto(el2, pre2, "# 第二篇", { path: "b.md" });
eq("新渲染前先 unload 舊的", [loaded, unloaded], [2, 1]);
const stale = resolveRender;                       // 第二篇的 resolve
const el3 = mkEl("div"); const pre3 = el3.createEl("pre");
m.renderMarkdownInto(el3, pre3, "# 第三篇", { path: "c.md" });
stale();                                            // 第二篇這時才回來（已經過期）
await Promise.resolve(); await Promise.resolve();
eq("過期的渲染不動 DOM", pre2.removed, false);
eq("最新那次仍在等自己的結果", pre3.removed, false);

m.disposePreviewMd();
eq("全部收掉", [loaded, unloaded], [3, 3]);

/* ,p 切換 */
NOTICES.length = 0;
m.toggleRenderMd();
eq("關掉 → 存進 settings", [plugin.settings.preview.renderMarkdown, m.renderMd(), NOTICES.slice()], [false, false, ["Preview: plain text"]]);
m.toggleRenderMd();
eq("再按一次 → 開回來", [plugin.settings.preview.renderMarkdown, m.renderMd()], [true, true]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);

})();
