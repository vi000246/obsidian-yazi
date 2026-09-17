/* diaryInfo 改吃 frontmatter 之後：用**真的遷移過的檔案**當資料來源測一遍，
   frontmatter 由簡易 YAML parser 產生（模擬 Obsidian 的 metadataCache）。 */
const Module = require("module");
const fs = require("fs"), path = require("path");
const stub = { obsidian: { Plugin: class {}, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
  Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null } };
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { diaryInfo, setFmApp, YaziModal } = require(require("./_probe.js").probePath()).__test;

// 夠用的 YAML：key: value 與 [a, b] 陣列
const parseFm = (raw) => {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const fm = {};
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(l);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    else if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"');
    fm[m[1]] = v;
  }
  return fm;
};

const ROOT = "C:/Users/logan_lin/Projects/Obsidian/MainRepo/200 Personal/001 日記";
const cache = new Map();
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) files.push(p);
  }
})(ROOT);
for (const p of files) cache.set(p.replace(/\\/g, "/"), { frontmatter: parseFm(fs.readFileSync(p, "utf8")) });

setFmApp({ metadataCache: { getFileCache: (f) => cache.get(f.path) || {} } });
const F = (abs) => ({ path: abs.replace(/\\/g, "/"), name: path.basename(abs) });

let fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "  want " + JSON.stringify(want))); };

eq("有標題的日記", diaryInfo(F(ROOT + "/2022/2022-11-20.md")), { mood: "😄", title: "生日吃教父牛排&約出洪靜 (長文 廢話多)" });
eq("沒填標題的日記（只有 emoji）", diaryInfo(F(ROOT + "/2025/2025-11-06.md")), { mood: "😄", title: "" });
eq("目錄頁不是日記", diaryInfo(F(ROOT + "/目錄v0.6.md")), null);
eq("資料夾", diaryInfo({ path: ROOT + "/2026", children: [] }), null);

// 全 vault 掃一遍：每一篇都要認得出來
let ok = 0, bad = [];
for (const p of files) {
  const rel = p.replace(/\\/g, "/").slice(ROOT.length + 1);
  const info = diaryInfo(F(p));
  const isIndex = /目錄v|assets/.test(rel);
  const isBroken = rel.includes("2025-09-07");
  if (isIndex || isBroken) { if (info === null) ok++; else bad.push(rel + "（不該被當成日記）"); }
  else if (info && info.mood) ok++;
  else bad.push(rel + " → " + JSON.stringify(info));
}
eq("全部 " + files.length + " 個檔都判斷正確", bad.length ? bad.slice(0, 5) : 0, 0);

// 畫成列
const el = () => ({ cls: "", text: "", children: [],
  createDiv(o) { const c = el(); c.cls = (o && o.cls) || ""; this.children.push(c); return c; },
  createSpan(o) { const c = el(); c.cls = (o && o.cls) || ""; if (o && o.text != null) c.text = String(o.text); this.children.push(c); return c; },
  addClass(x) { this.cls += " " + x; }, empty() { this.children = []; }, addEventListener() {}, scrollIntoView() {} });
const box = el();
const m = Object.assign(Object.create(YaziModal.prototype), { sel: new Set(), clip: () => null });
const f1 = Object.assign(F(ROOT + "/2022/2022-11-20.md"), { basename: "2022-11-20", extension: "md" });
m.renderColumn(box, [f1], f1.path, true);
eq("列：emoji ＋ 標題 ＋ 右邊日期", box.children[0].children.map((c) => c.cls.trim() + ":" + c.text),
   ["yazi-icon:😄", "yazi-name:生日吃教父牛排&約出洪靜 (長文 廢話多)", "yazi-sub is-date:2022-11-20"]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
