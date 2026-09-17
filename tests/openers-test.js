/*
 * O 選單在 modal 裡的完整行為：選單內容、四種動作的派工、絕對路徑、複製路徑。
 * 開啟方式全部來自設定 —— 這支就是在驗「設定真的決定了行為」。
 */
const Module = require("module");

const spawns = [];
const reveals = [];
const opens = [];
const commands = [];
const notices = [];

const PLAT = { isWin: true, isMacOS: false, isDesktopApp: true };
const setPlat = (o) => Object.assign(PLAT, { isWin: false, isMacOS: false, isDesktopApp: true }, o);

const stub = {
  obsidian: {
    Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } },
    PluginSettingTab: class { constructor(a, p) { this.app = a; this.plugin = p; } },
    Setting: class { constructor() { return new Proxy(this, { get: () => () => this }); } },
    Modal: class {},
    Notice: class { constructor(m) { notices.push(String(m)); } },
    Component: class { load() {} unload() {} },
    MarkdownRenderer: { render: () => Promise.resolve() },
    Platform: PLAT,
    prepareFuzzySearch: null,
  },
  child_process: { spawn: (c, a) => { spawns.push([c].concat(a)); return { unref() {} }; } },
  electron: {
    shell: {
      showItemInFolder: (p) => reveals.push(p),
      openPath: (p) => { opens.push(p); return Promise.resolve(""); },
    },
  },
};
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const { YaziModal, absPath } = require(require("./_probe.js").probePath()).__test;

const BS = String.fromCharCode(92);
const W = (p) => p.split("/").join(BS);
const BASE = W("C:/Vault");

const folder = { path: "notes", name: "notes", children: [] };
const md = { path: "notes/a.md", name: "a.md", basename: "a", extension: "md" };
const png = { path: "notes/b.png", name: "b.png", basename: "b", extension: "png" };
const root = { path: "/", name: "", children: [] };
const files = { notes: folder, "notes/a.md": md, "notes/b.png": png, "/": root };

const OPENERS = [
  { id: "sys", label: "Default app", key: "d", appliesTo: "file", extensions: [], platform: "all", kind: "system", enabled: true },
  { id: "dir", label: "Open folder", key: "f", appliesTo: "folder", extensions: [], platform: "all", kind: "system", enabled: true },
  { id: "rev", label: "Show in file manager", key: "r", appliesTo: "both", extensions: [], platform: "all", kind: "reveal", enabled: true },
  { id: "edit", label: "Editor", key: "e", appliesTo: "file", extensions: ["md"], platform: "all", kind: "command", enabled: true,
    command: "code", args: ["--reuse-window", "{{path}}"] },
  { id: "term", label: "Terminal", key: "t", appliesTo: "both", extensions: [], platform: "all", kind: "command", enabled: true,
    command: "wt.exe", args: ["-d", "{{dir}}"] },
  { id: "obs", label: "Split", key: "s", appliesTo: "file", extensions: [], platform: "all", kind: "obsidian-command", enabled: true,
    commandId: "workspace:split-vertical" },
];

const app = {
  vault: {
    adapter: Object.assign(new stub.obsidian.FileSystemAdapter(), { getBasePath: () => BASE }),
    getName: () => "Vault",
    getAbstractFileByPath: (p) => files[p] || null,
  },
  commands: { executeCommandById: (id) => commands.push(id) },
  workspace: { getLeaf: () => ({ openFile: () => Promise.resolve() }) },
};

const plugin = { settings: { openers: OPENERS }, t: (k, f) => f || k };
const modal = (cur) => Object.assign(Object.create(YaziModal.prototype), {
  app, plugin, view: "files", cwd: root, current: () => cur, render() {}, close() {},
});

let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};
const keys = (m) => m.openActions().map((a) => a.key);

/* ── 絕對路徑（跨平台）── */
eq("absPath 檔案(win)", absPath(app, "notes/a.md"), BASE + BS + "notes" + BS + "a.md");
eq("absPath vault 根", absPath(app, "/"), BASE);
eq("absPath 沒有 basePath（行動版）", absPath({ vault: { adapter: {} } }, "a.md"), null);
setPlat({ isMacOS: true });
eq("absPath(mac) 維持斜線", absPath({ vault: { adapter: Object.assign(new stub.obsidian.FileSystemAdapter(), { getBasePath: () => "/Users/me/Vault" }) } }, "a/b.md"), "/Users/me/Vault/a/b.md");
setPlat({ isWin: true });

/* ── 選單內容由設定決定 ── */
eq("檔案(.md)：副檔名限定的 editor 有出現", keys(modal(md)), ["d", "r", "e", "t", "s"]);
eq("檔案(.png)：editor 被副檔名擋掉", keys(modal(png)), ["d", "r", "t", "s"]);
eq("資料夾：只有適用資料夾的", keys(modal(folder)), ["f", "r", "t"]);
eq("空資料夾退回 cwd", modal(null).openTarget().path, "/");

setPlat({ isDesktopApp: false, isWin: true });
eq("行動版：command 類全消失，其餘照常", keys(modal(md)), ["d", "r", "s"]);
setPlat({ isWin: true });

plugin.settings.openers = [{ id: "m", label: "mac only", key: "m", appliesTo: "both", platform: "mac", kind: "system", enabled: true }].concat(OPENERS);
setPlat({ isMacOS: true });
eq("平台限定：mac 的在 mac 出現", keys(modal(md)).includes("m"), true);
setPlat({ isWin: true });
eq("平台限定：mac 的在 win 不出現", keys(modal(md)).includes("m"), false);
plugin.settings.openers = OPENERS;

/* ── 四種動作的派工 ── */
const ABS_MD = BASE + BS + "notes" + BS + "a.md";
const ABS_DIR = BASE + BS + "notes";

modal(md).runOpenAction("e");
eq("command：參數逐一展開", spawns.pop(), ["code", "--reuse-window", ABS_MD]);
modal(md).runOpenAction("t");
eq("{{dir}} 是檔案所在資料夾", spawns.pop(), ["wt.exe", "-d", ABS_DIR]);
modal(folder).runOpenAction("t");
eq("資料夾的 {{dir}} 是它自己", spawns.pop(), ["wt.exe", "-d", ABS_DIR]);
modal(md).runOpenAction("r");
eq("reveal 走 shell.showItemInFolder", reveals.pop(), ABS_MD);
modal(md).runOpenAction("d");
eq("system 走 shell.openPath", opens.pop(), ABS_MD);
modal(folder).runOpenAction("f");
eq("資料夾的 system ＝開那個資料夾", opens.pop(), ABS_DIR);
notices.length = 0; spawns.length = 0;
modal(png).runOpenAction("e");
eq("不適用的鍵＝當成取消，什麼都不做", [spawns.length, notices.length], [0, 0]);

/* ── 複製路徑 ── */
const clip = [];
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: (t) => { clip.push(t); return Promise.resolve(); } } },
  configurable: true,
});
const m = modal(md);
m.copyPath("c"); eq("cc 絕對路徑", clip.pop(), ABS_MD);
m.copyPath("d"); eq("cd 絕對資料夾", clip.pop(), ABS_DIR);
m.copyPath("r"); eq("cr vault 相對路徑", clip.pop(), "notes/a.md");
m.copyPath("f"); eq("cf 檔名", clip.pop(), "a.md");
m.copyPath("n"); eq("cn 主檔名", clip.pop(), "a");

/* obsidian-command 會**先開檔再執行命令**，所以要等一輪 microtask —— 這個順序是
   刻意的：命令多半作用在「目前開啟的檔案」上，先開才有意義。 */
(async () => {
  modal(md).runOpenAction("s");
  await Promise.resolve();
  await Promise.resolve();
  eq("obsidian-command：先開檔，再執行命令", commands.pop(), "workspace:split-vertical");

  console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
  process.exit(fail ? 1 : 0);
})();
