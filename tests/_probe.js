/*
 * 測試用的載入器。
 *
 * src/main.js 目前還是一整支 CommonJS（module.exports = Plugin 類別），內部的函式
 * 沒有匯出 —— 但要測的正是那些（路徑處理、預覽清洗、按鍵派工…）。這支就做一件事：
 * 讀 src/main.js、在尾巴補一行 `module.exports.__test = {...}`、寫到暫存檔再 require。
 * 好處是**產品程式碼裡不必留測試用的匯出**。
 *
 * 之後把 src/ 拆成模組時，測試改成直接 import 那些模組，這支就可以刪掉。
 *
 * 用法：
 *   const { load } = require("./_probe.js");
 *   const { YaziModal, stripForRender } = load({ Platform: { isWin: true } });
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const SRC = path.join(__dirname, "..", "src", "main.js");

/* 想從 main.js 裡挖出來測的東西。加新的測試對象就加在這裡。 */
const EXPOSED = [
  "absPath", "wheelPx",
  "PENDING_MENUS", "PREVIEW_SCROLL_KEYS", "HALF_PAGE", "HELP", "SORTS",
  "stripPluginNoise", "stripForRender", "fmInfo",
  "YaziModal", "isFolder", "sortFiles",
];

let cached = null;

/** 產生（並快取）一份「尾巴補上 __test 匯出」的 src/main.js，回傳它的路徑。 */
function probePath() {
  if (cached) return cached;
  const src = fs.readFileSync(SRC, "utf8");
  /* 只匯出**真的存在**的名字：main.js 改動時不該因為某個內部函式改名，
     就讓所有測試一起變成 ReferenceError（那會蓋掉真正的失敗訊息）。 */
  const names = EXPOSED.filter((n) =>
    new RegExp("(^|\\n)\\s*(const|let|function|class)\\s+" + n + "\\b").test(src));
  /* 模組層的兩個狀態（app 與裝飾規則）要能從測試裡設定 —— 平常是 onload 灌進去的 */
  const tail = "\nmodule.exports.__test = { " + names.join(", ") +
    ", setFmApp: (a) => { FM_APP = a; }, setFmRules: (r) => { FM_RULES = r || []; } };\n";
  /* ⚠️ 一定要產在 src/ 旁邊，不能丟到暫存目錄：main.js 裡的 require("./settings/…")
     是相對路徑，探針放在別的資料夾時那些 require 會全部解析不到。
     檔名以 . 開頭並列進 .gitignore。 */
  cached = path.join(path.dirname(SRC), ".probe.generated.js");
  fs.writeFileSync(cached, src + tail, "utf8");
  return cached;
}

/**
 * 直接把 main.js 載進來（obsidian 等模組用替身攔掉）。
 * @param {object} platform    Platform 的替身（isWin / isMacOS / isDesktopApp）
 * @param {object} extraStubs  其他要攔截的 require（child_process / electron…）
 */
function load(platform, extraStubs) {
  const p = probePath();
  const plat = Object.assign(
    { isWin: process.platform === "win32", isMacOS: process.platform === "darwin", isDesktopApp: true },
    platform
  );
  const notices = [];
  const stubs = Object.assign({
    obsidian: {
      Plugin: class {}, PluginSettingTab: class { constructor(a,p){ this.app=a; this.plugin=p; } }, Setting: class { constructor(){ return new Proxy(this,{get:()=>()=>this}); } },
      Modal: class {},
      Notice: class { constructor(m) { notices.push(String(m)); } },
      Component: class { load() {} unload() {} },
      MarkdownRenderer: { render: () => Promise.resolve() },
      Platform: plat,
      prepareFuzzySearch: null,
    },
  }, extraStubs);

  const orig = Module._load;
  Module._load = function (req) { return stubs[req] || orig.apply(this, arguments); };
  delete require.cache[p];
  const mod = require(p);
  Module._load = orig;

  return Object.assign({}, mod.__test, { __platform: plat, __notices: notices });
}

module.exports = { load, probePath, SRC };
