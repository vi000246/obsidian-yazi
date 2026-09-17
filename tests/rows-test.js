/* 日記列真的畫出來長怎樣（renderColumn 的 DOM 路徑）。
   2026-09-17：資料來源從 dataview inline field 改成 frontmatter，stub 跟著改。 */
const Module = require("module");
const stub = { obsidian: { Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } }, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal, setFmApp, setFmRules } = require(require("./_probe.js").probePath()).__test;

const el = (cls) => ({ cls: cls || "", text: "", children: [],
  createDiv(o) { const c = el((o && o.cls) || ""); if (o && o.text) c.text = o.text; this.children.push(c); return c; },
  createSpan(o) { const c = el((o && o.cls) || ""); if (o && o.text != null) c.text = String(o.text); this.children.push(c); return c; },
  addClass(c) { this.cls += " " + c; }, empty() { this.children = []; },
  addEventListener() {}, scrollIntoView() {} });

const file = (p) => ({ path: p, name: p.split("/").pop(),
  basename: p.split("/").pop().replace(/\.md$/, ""), extension: "md" });

const fmOf = new Map();
setFmApp({ metadataCache: { getFileCache: (f) => ({ frontmatter: fmOf.get(f.path) || null }) } });

/* 裝飾規則現在是設定裡的資料 —— 這一條就是「日記」那條 */
setFmRules([{
  id: "diary", enabled: true, when: { field: "type", equals: "diary" },
  icon: { from: "field", field: "mood" },
  title: { from: "field", field: "title", fallback: "filename" },
  subtitle: { from: "basename" },
}]);

const mk = () => Object.assign(Object.create(YaziModal.prototype), { sel: new Set(), clip: () => null, cwd: { path: "/" } });
const dump = (row) => row.children.map((c) => (c.cls.trim() || "?") + ":" + c.text);

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "\n   → " + JSON.stringify(got) + (ok ? "" : "\n   want " + JSON.stringify(want))); };

const D1 = file("200 Personal/001 日記/2026/2026-09-13.md");
const D2 = file("200 Personal/001 日記/2026/2026-09-10.md");
const OTHER = file("100 工作/一般筆記.md");
fmOf.set(D1.path, { type: "diary", date: "2026-09-13", title: "九份二日遊", mood: "🤩", category: "旅行" });
fmOf.set(D2.path, { type: "diary", date: "2026-09-10", mood: "😩" });        // 沒填標題

const box = el();
mk().renderColumn(box, [D1, D2], D1.path, true);
eq("有標題：emoji ＋ 標題當主文字 ＋ 日期在右邊小字", dump(box.children[0]),
   ["yazi-icon:🤩", "yazi-name:九份二日遊", "yazi-sub is-date:2026-09-13"]);
eq("沒填標題：退回檔名，不留空白列", dump(box.children[1]),
   ["yazi-icon:😩", "yazi-name:2026-09-10.md"]);

const box2 = el();
mk().renderColumn(box2, [D1], D1.path, false);
eq("父層欄不換標題（只有 emoji）", dump(box2.children[0]), ["yazi-icon:🤩", "yazi-name:2026-09-13.md"]);

const box3 = el();
mk().renderColumn(box3, [OTHER], OTHER.path, true);
eq("一般筆記照舊", dump(box3.children[0]), ["yazi-icon:·", "yazi-name:一般筆記.md"]);

const box4 = el();
const m4 = mk(); m4.sel.add(D1.path);
m4.renderColumn(box4, [D1], D1.path, true);
eq("選取時 ✓ 優先於心情 emoji", dump(box4.children[0])[0], "yazi-icon:✓");

// type 不是 diary 的筆記就算有 mood 也不裝飾（避免別處的欄位撞名）
const FAKE = file("500 Programing/筆記.md");
fmOf.set(FAKE.path, { type: "note", mood: "🤩", title: "不該被當成日記" });
const box5 = el();
mk().renderColumn(box5, [FAKE], FAKE.path, true);
eq("type 不是 diary 就不裝飾", dump(box5.children[0]), ["yazi-icon:·", "yazi-name:筆記.md"]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
