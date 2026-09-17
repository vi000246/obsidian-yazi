/* 「只渲染純 markdown」的核心保證：餵給 renderer 的字串裡不能有任何 plugin 機關。 */
const Module = require("module");
const stub = {
  obsidian: { Plugin: class {}, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } }, Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
              Platform: { isWin: true, isMacOS: false, isDesktopApp: true }, prepareFuzzySearch: null },
};
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { stripPluginNoise, stripForRender } = require(require("./_probe.js").probePath()).__test;

const clean = (s) => stripForRender(stripPluginNoise(s));
let fail = 0;
const ok = (name, cond, got) => { if (!cond) fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "\n      got: " + JSON.stringify(got))); };

const NOTE = [
  "# 專案筆記",
  "",
  "狀態 `INPUT[inlineSelect:status]` ｜ 優先級 `INPUT[inlineSelect:priority]`",
  "`BUTTON[archive]`",
  "",
  "| 欄位 | 說明 | 值 |",
  "|---|---|---|",
  "| id | 單號 | OB-20 |",
  "| kind | 類型 | 功能 |",
  "",
  "```dataviewjs",
  "const x = dv.pages('\"100 工作\"');",
  "await app.fileManager.processFrontMatter(f, fm => fm.touched = true);",
  "```",
  "",
  "```tasks",
  "not done",
  "```",
  "",
  "檔名是 `= this.file.name`，統計 `$= dv.pages().length`",
  "",
  "![[🏠 dashboard]]",
  "![[架構圖.png]]",
  "![[規格書.pdf]]",
  "",
  "```js",
  "const keep = '這段是我記在筆記裡的程式碼，要留著';",
  "```",
].join("\n");

const out = clean(NOTE);
console.log("───── 洗過之後餵給 renderer 的內容 ─────\n" + out + "\n────────────────────────────────────");

ok("表格整張留著", /\| id \| 單號 \| OB-20 \|/.test(out) && /\|---\|---\|---\|/.test(out), out);
ok("標題留著", out.includes("# 專案筆記"), out);
ok("dataviewjs 整段不見", !out.includes("dataviewjs") && !out.includes("processFrontMatter"), out);
ok("tasks 區塊不見", !out.includes("```tasks") && !out.includes("not done"), out);
ok("meta-bind 控制列整行不見", !/INPUT\[|BUTTON\[|VIEW\[/.test(out), out);
ok("行內 dataview 查詢被換掉", !out.includes("this.file.name") && !out.includes("dv.pages().length") && out.includes("[inline query]"), out);
ok("筆記內嵌被換成佔位字", !out.includes("![[🏠 dashboard]]") && out.includes("[embedded note: 🏠 dashboard]"), out);
ok("圖片內嵌保留", out.includes("![[架構圖.png]]"), out);
ok("PDF 內嵌保留", out.includes("![[規格書.pdf]]"), out);
ok("一般 ```js 區塊保留", out.includes("```js") && out.includes("要留著"), out);

/* 內嵌的各種寫法 */
const cases = [
  ["![[note#段落]]", "[embedded note: note]", "帶 heading 的內嵌"],
  ["![[note|別名]]", "[embedded note: note]", "帶別名的內嵌"],
  ["![[資料夾/筆記.md]]", "[embedded note: 資料夾/筆記.md]", ".md 副檔名也算筆記"],
  ["![[clip.mp4]]", "![[clip.mp4]]", "影片保留"],
  ["[[一般連結]]", "[[一般連結]]", "非內嵌的連結不動"],
];
for (const [src, want, name] of cases) {
  const got = stripForRender(src);
  ok(name, got.includes(want), got);
}

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
