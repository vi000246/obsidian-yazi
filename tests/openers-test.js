const Module = require("module");
const BS = String.fromCharCode(92);              // 反斜線：避免寫進原始碼被層層轉義
const W = (p) => p.split("/").join(BS);          // posix 寫法 → Windows 原生寫法
const notices = [], spawns = [], reveals = [], opens = [];
const PLAT = { isWin: true, isMacOS: false, isDesktopApp: true };   // 就地改，不能換物件
const setPlat = (o) => Object.assign(PLAT, { isWin: false, isMacOS: false, isDesktopApp: true }, o);
const stub = {
  obsidian: {
    Plugin: class {}, Modal: class {},
    Notice: class { constructor(m) { notices.push(String(m)); } },
    Platform: PLAT, prepareFuzzySearch: null,
  },
  child_process: { spawn: (c, a) => { spawns.push([c].concat(a)); return { unref() {} }; } },
  electron: { shell: { showItemInFolder: (p) => reveals.push(p), openPath: (p) => { opens.push(p); return Promise.resolve(""); } } },
};
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };

const { absPath, myconfigScript, YaziModal } = require(require("./_probe.js").probePath()).__test;

const BASE = W("C:/Users/logan_lin/Projects/Obsidian/MainRepo");
const folder = { path: "100 工作", children: [] };
const md     = { path: "100 工作/筆記.md", name: "筆記.md", extension: "md" };
const png    = { path: "圖/a.png", name: "a.png", extension: "png" };
const root   = { path: "/", children: [] };
const files = { "100 工作": folder, "100 工作/筆記.md": md, "圖/a.png": png, "/": root };
const app = { vault: { adapter: { getBasePath: () => BASE }, getName: () => "MainRepo",
                       getAbstractFileByPath: (p) => files[p] || null } };
const modal = (cur, a) => Object.assign(Object.create(YaziModal.prototype),
  { app: a || app, view: "files", cwd: root, current: () => cur, render() {}, plugin: null });

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "  → " + JSON.stringify(got)
    : "\n      got  " + JSON.stringify(got) + "\n      want " + JSON.stringify(want)));
};
const keys = (m) => m.openActions().map((a) => a.k + ":" + m.openLabel(a));

/* 1. 絕對路徑 */
eq("absPath 檔案(win)", absPath(app, "100 工作/筆記.md"), BASE + BS + "100 工作" + BS + "筆記.md");
eq("absPath vault 根",  absPath(app, "/"), BASE);
eq("absPath 無 basePath", absPath({ vault: { adapter: {} } }, "a.md"), null);
eq("myconfigScript(win)", myconfigScript("scripts/yazi/open-in-terminal.ps1"),
   W("C:/Users/logan_lin/Projects/MyConfig/scripts/yazi/open-in-terminal.ps1"));

setPlat({ isMacOS: true });
eq("absPath 檔案(mac)", absPath({ vault: { adapter: { getBasePath: () => "/Users/logan/v" } } }, "a/b.md"), "/Users/logan/v/a/b.md");
eq("myconfigScript(mac)", myconfigScript("scripts/yazi/open-in-terminal.sh"), "/Users/logan/projects/MyConfig/scripts/yazi/open-in-terminal.sh");
eq("reveal 標籤(mac)", keys(modal(md)).pop(), "r:在 Finder 顯示");
setPlat({ isWin: true });

/* 2. 選單跟著游標變 */
eq("選單 .md",    keys(modal(md)),     ["e:Neovim","w:瀏覽器預覽","d:系統預設程式","c:Claude Code","g:lazygit","t:終端機","r:在總管顯示"]);
eq("選單 .png",   keys(modal(png)),    ["d:系統預設程式","c:Claude Code","g:lazygit","t:終端機","r:在總管顯示"]);
eq("選單 資料夾", keys(modal(folder)), ["f:開資料夾","c:Claude Code","g:lazygit","t:終端機","r:在總管顯示"]);
eq("空資料夾退回 cwd", modal(null).openTarget().path, "/");
/* which-key 卡的內容 */
const menu = (cur, pending) => { const m = modal(cur); m.pending = pending; return m.pendingMenu(); };
eq("O 卡：標題", menu(folder, "open").key, "O");
eq("O 卡：資料夾項目", menu(folder, "open").items.map((x) => x.join(" ")), ["f 開資料夾","c Claude Code","g lazygit","t 終端機","r 在總管顯示"]);
eq("O 卡：說明含路徑", menu(folder, "open").desc.endsWith("100 工作"), true);
eq("c 卡", menu(md, "c").items.map((x) => x[0]), ["c","d","f","n","r"]);
eq("g 卡", menu(md, "g").items.map((x) => x[0]), ["g","t","f","d","b"]);
eq("m 卡＝只有說明", [menu(md, "assign").key, menu(md, "assign").items.length, menu(md, "assign").note], ["m", 0, "按一個字母指定；Backspace 清除"]);
eq("S 卡：標出目前排序", menu(md, "sort").items.filter((x) => x[1].includes("←")).map((x) => x[0]), ["n"]);
eq("S 卡：最後兩項", menu(md, "sort").items.slice(-2).map((x) => x.join(" ")), ["S 正序 ⇄ 逆序","d 取消「資料夾優先」"]);
eq("沒有 pending ＝不畫卡", modal(md).pendingMenu(), null);

/* 3. 實際派工 */
const PS = ["powershell.exe","-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File"];
const TERM = W("C:/Users/logan_lin/Projects/MyConfig/scripts/yazi/open-in-terminal.ps1");
const MDV  = W("C:/Users/logan_lin/Projects/MyConfig/scripts/markdown/md-preview.ps1");
const ABS_F = BASE + BS + "100 工作", ABS_MD = BASE + BS + "100 工作" + BS + "筆記.md";
modal(folder).runOpenAction("t"); eq("資料夾→終端機", spawns.pop(), PS.concat([TERM, "terminal", ABS_F]));
modal(md).runOpenAction("c");     eq("檔案→Claude",   spawns.pop(), PS.concat([TERM, "claude", ABS_MD]));
modal(md).runOpenAction("e");     eq("檔案→nvim",     spawns.pop(), PS.concat([TERM, "nvim", ABS_MD]));
modal(md).runOpenAction("w");     eq("md→瀏覽器預覽", spawns.pop(), PS.concat([MDV, ABS_MD]));
modal(md).runOpenAction("r");     eq("在總管顯示",    reveals.pop(), ABS_MD);
modal(folder).runOpenAction("f"); eq("開資料夾",      opens.pop(), ABS_F);
notices.length = 0; spawns.length = 0;
modal(png).runOpenAction("w");    eq("不存在的鍵＝取消", [spawns.length, notices.length], [0, 0]);
modal(folder).runOpenAction("e"); eq("資料夾沒有 nvim",  [spawns.length, notices.length], [0, 0]);

/* 4. cc / cd / cf / cn / cr */
const clip = [];
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: (t) => { clip.push(t); return Promise.resolve(); } } }, configurable: true });
const m = modal(md);
m.copyPath("c"); eq("cc 絕對路徑",   clip.pop(), ABS_MD);
m.copyPath("d"); eq("cd 絕對資料夾", clip.pop(), ABS_F);
m.copyPath("r"); eq("cr 相對路徑",   clip.pop(), "100 工作/筆記.md");
m.copyPath("f"); eq("cf 檔名",       clip.pop(), "筆記.md");
m.copyPath("n"); eq("cn 主檔名",     clip.pop(), "筆記");
const noBase = { vault: { adapter: {}, getName: () => "v", getAbstractFileByPath: (p) => files[p] || null } };
modal(md, noBase).copyPath("c"); eq("手機版 cc 退回相對", clip.pop(), "100 工作/筆記.md");

/* 5. 手機版擋下 O */
setPlat({ isDesktopApp: false });
notices.length = 0;
const mob = modal(md); mob.openMenu();
eq("手機版擋下 O", [mob.pending === "open", notices.slice()], [false, ["外部開啟只有桌面版能用"]]);


/* 6. e 只留文字檔（新增） */
setPlat({ isWin: true });   // 第 5 段把平台切成手機了，切回來
const mk = (p, ext) => ({ path: p, name: p.split("/").pop(), extension: ext });
const REST = ["d:系統預設程式","c:Claude Code","g:lazygit","t:終端機","r:在總管顯示"];
const cases = [
  ["圖/a.png",   "png",  REST],
  ["文/a.pdf",   "pdf",  REST],
  ["封存/a.zip", "zip",  REST],
  ["雜/Makefile", "",    REST],
  ["設定/a.JSON", "JSON", ["e:Neovim"].concat(REST)],
  ["程式/a.ts",  "ts",   ["e:Neovim"].concat(REST)],
  ["筆/n.md",    "md",   ["e:Neovim","w:瀏覽器預覽"].concat(REST)],
];
for (const [p, ext, want] of cases) {
  const f = mk(p, ext);
  files[p] = f;
  eq("選單 " + p.split("/").pop(), keys(modal(f)), want);
}
notices.length = 0; spawns.length = 0; opens.length = 0;
modal(files["圖/a.png"]).runOpenAction("e");
eq("png 按 e ＝當成取消", [spawns.length, notices.length], [0, 0]);
modal(files["圖/a.png"]).runOpenAction("d");
eq("png 按 d ＝系統預設程式", opens.pop(), BASE + BS + "圖" + BS + "a.png");

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
