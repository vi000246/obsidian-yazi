/*
 * frontmatter 面板與標籤正規化。
 *
 * 這支的由來：renderFmPanel 呼叫了一個**不存在的** userTags()，而它跑在
 * cachedRead().then() 裡沒有人接 —— 於是整個預覽（含 markdown 渲染）從那一行
 * 之後全部沒發生，畫面上只看得到「有些筆記不渲染」。JS 對「函式不存在」是到
 * 呼叫當下才爆的，所以這種錯誤只能靠實際跑一次抓出來。
 */
const Module = require("module");
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const probe = require(require("./_probe.js").probePath()).__test;
const { YaziModal, userTags, setFmRules } = probe;

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want))); };

/* ── userTags：YAML 那一欄的各種寫法 ── */
eq("清單", userTags(["a", "b"]), ["a", "b"]);
eq("單一字串", userTags("a"), ["a"]);
eq("空白分隔的字串", userTags("a b"), ["a", "b"]);
eq("逗號分隔的字串", userTags("a, b"), ["a", "b"]);
eq("# 前綴切掉", userTags(["#a", "b"]), ["a", "b"]);
eq("去重", userTags(["a", "#a"]), ["a"]);
eq("空值", [userTags(undefined), userTags(null), userTags("")], [[], [], []]);
eq("自動掛的 work/ 標籤濾掉", userTags(["work/task", "平台"]), ["平台"]);
eq("只有自動標籤時回空陣列（面板那一列就不會出現）", userTags(["work/doc"]), []);
eq("物件不猜", userTags({ a: 1 }), []);
eq("數字標籤", userTags([2026]), ["2026"]);

/* ── renderFmPanel：實際跑一次，確定沒有呼叫到不存在的東西 ── */
function mkEl() {
  const el = {
    children: [], cls: "", text: "",
    createDiv(o) { const c = mkEl(); c.cls = (o && o.cls) || ""; c.text = (o && o.text) || ""; el.children.push(c); return c; },
    createSpan(o) { const c = mkEl(); c.cls = (o && o.cls) || ""; c.text = (o && o.text) || ""; el.children.push(c); return c; },
    createEl(t, o) { const c = mkEl(); c.tag = t; c.cls = (o && o.cls) || ""; c.text = (o && o.text) || ""; el.children.push(c); return c; },
    setText(t) { el.text = t; },
  };
  return el;
}
const rowsOf = (el, out) => {
  out = out || [];
  for (const c of el.children) {
    if (c.cls === "yazi-help-row") out.push(c.children.map((x) => x.text));
    else rowsOf(c, out);
  }
  return out;
};

const m = Object.assign(Object.create(YaziModal.prototype), { plugin: null });
const info = (over) => Object.assign({
  icon: "📌", title: "", subtitle: "", status: "", prio: "", overdue: false, dim: false,
  fm: { type: "task", kind: "功能", tags: ["work/task", "平台"] },
}, over);

const el1 = mkEl();
m.renderFmPanel(el1, info());
const rows1 = rowsOf(el1);
eq("沒有 panel 設定時列出每個 frontmatter 欄位",
   rows1.filter((r) => r[0] === "type" || r[0] === "kind").map((r) => r.join("=")), ["type=task", "kind=功能"]);
eq("標籤那一列濾掉自動標籤", rows1.filter((r) => r[0] === "tags").map((r) => r[1]), ["平台"]);
eq("position 不列出來（Obsidian 內部欄位）", rows1.some((r) => r[0] === "position"), false);

/* panel 設定：規則靠 info.ruleId 去 FM_RULES 裡查，只列指定欄位，tags 永遠排最後 */
setFmRules([{ id: "task", panel: ["kind", { field: "type", label: "類型" }] }]);
const el2 = mkEl();
m.renderFmPanel(el2, info({ ruleId: "task" }));
eq("有 panel 設定時只列指定的欄位（tags 另外補在最後）",
   rowsOf(el2).map((r) => r[0]), ["kind", "類型", "tags"]);
setFmRules([]);

/* 過期標記 */
const el3 = mkEl();
m.renderFmPanel(el3, info({ overdue: true }));
eq("overdue 會多一列", rowsOf(el3).some((r) => r[0] === "⏰"), true);

/* 沒有 tags 欄位也不能爆 */
const el4 = mkEl();
m.renderFmPanel(el4, info({ fm: { type: "note" } }));
eq("沒有 tags 時不畫那一列", rowsOf(el4).some((r) => r[0] === "tags"), false);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
