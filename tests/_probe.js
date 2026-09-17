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
const os = require("os");
const path = require("path");
const Module = require("module");

const SRC = path.join(__dirname, "..", "src", "main.js");

/* 想從 main.js 裡挖出來測的東西。加新的測試對象就加在這裡。 */
const EXPOSED = [
  "absPath", "myconfigScript", "wheelPx", "moodOf",
  "OPEN_ACTIONS", "PENDING_MENUS", "PREVIEW_SCROLL_KEYS", "HALF_PAGE", "HELP", "SORTS",
  "stripPluginNoise", "stripForRender", "diaryInfo", "fmInfo",
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
  const tail = "\nmodule.exports.__test = { " + names.join(", ") +
    ", setFmApp: (a) => { FM_APP = a; } };\n";
  cached = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yazi-test-")), "probe.js");
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
      Plugin: class {},
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
