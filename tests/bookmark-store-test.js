/*
 * 書籤與本機狀態存在哪：plugin 本體對著一個假的 vault 跑。
 *
 * 要守住的事（SP-591）：
 *   - 「書籤存檔位置」留空＝跟 0.3 一樣存 data.json
 *   - 改成筆記時一筆不少搬進去、跟筆記原有的合併、可以重跑
 *   - 改書籤只動到那一行；別台改了筆記，不用重開就看得到，下次存檔也不會蓋回去
 *   - 舊版往 data.json 寫的書籤在筆記模式下不算數（但看得到、可以匯入）
 *   - frecency 與排序搬到 local.json，升級後不歸零
 *   - data.json 被外部改掉時重新載入，下次存檔不會蓋回舊值
 *   - 檔案與資料夾改名後書籤還指得到
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");

global.window = global.window || { setTimeout, clearTimeout, localStorage: { getItem: () => "en" } };

/* 錯誤路徑會 console.error：收起來，最後核對「只有預期的那幾條」，輸出也保持乾淨 */
const logged = [];
console.error = (...a) => logged.push(String(a[0]));

const stub = {
  obsidian: {
    Plugin: class {}, FileSystemAdapter: class FileSystemAdapter { getBasePath() { return ""; } },
    PluginSettingTab: class { constructor(a, p) { this.app = a; this.plugin = p; } },
    Setting: class { constructor() { return new Proxy(this, { get: () => () => this }); } },
    Modal: class {}, Notice: class {}, Component: class {}, MarkdownRenderer: {},
    Platform: { isWin: true, isDesktopApp: true }, prepareFuzzySearch: null,
  },
};
const orig = Module._load;
Module._load = function (req) { return stub[req] || orig.apply(this, arguments); };
const YaziExplorer = require(require("./_probe.js").probePath());
Module._load = orig;

let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

/* 兩份文字的逐行差異：[被拿掉的行, 新增的行] */
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  return [A.filter((l) => !B.includes(l)), B.filter((l) => !A.includes(l))];
}

/* ── 假的 vault：檔案、資料夾、事件、metadataCache、plugin 資料夾 ── */
function makeApp(seed) {
  const files = new Map();       // path → { file, content }
  const folders = new Set();
  const disk = new Map();        // adapter 層（.obsidian 底下）的檔
  const handlers = {};
  const log = { process: 0, create: 0 };
  const split = (p) => {
    const name = p.split("/").pop();
    const dot = name.lastIndexOf(".");
    return { name, basename: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot + 1) : "" };
  };
  const addFolders = (p) => {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  };
  const addFile = (p, content) => {
    const file = Object.assign({ path: p, stat: { mtime: 0, size: 0 } }, split(p));
    files.set(p, { file, content });
    if (p.includes("/")) addFolders(p.slice(0, p.lastIndexOf("/")));
    return file;
  };
  for (const [p, c] of Object.entries(seed || {})) {
    if (c === null) addFolders(p);
    else addFile(p, c);
  }
  const emit = (evt, ...a) => { for (const cb of handlers[evt] || []) cb(...a); };
  const vault = {
    on(evt, cb) { (handlers[evt] = handlers[evt] || []).push(cb); return { evt, cb }; },
    offref() {},
    getAbstractFileByPath(p) {
      if (files.has(p)) return files.get(p).file;
      if (folders.has(p)) return { path: p, name: p.split("/").pop(), children: [] };
      return null;
    },
    async read(f) { return files.get(f.path).content; },
    async cachedRead(f) { return files.get(f.path).content; },
    async process(f, fn) {
      const rec = files.get(f.path);
      rec.content = fn(rec.content);
      log.process++;
      emit("modify", rec.file);
      return rec.content;
    },
    async create(p, text) {
      if (files.has(p)) throw new Error("exists");
      const file = addFile(p, text);
      log.create++;
      emit("create", file);
      return file;
    },
    async createFolder(p) { addFolders(p); },
    getMarkdownFiles() { return [...files.values()].map((r) => r.file).filter((f) => f.extension === "md"); },
    getFiles() { return [...files.values()].map((r) => r.file); },
    adapter: {
      async exists(p) { return disk.has(p); },
      async read(p) { return disk.get(p); },
      async write(p, s) { disk.set(p, s); },
      async remove(p) { disk.delete(p); },
    },
  };
  const metadataCache = {
    /* 完整路徑或檔名（不含 .md）都解析得到 —— 跟 Obsidian 的最短路徑規則同一個意思 */
    getFirstLinkpathDest(linkpath) {
      for (const [p, r] of files) {
        if (p === linkpath || p === linkpath + ".md") return r.file;
      }
      for (const [, r] of files) {
        if (r.file.basename === linkpath || r.file.name === linkpath) return r.file;
      }
      return null;
    },
    fileToLinktext(file, source, omitMd) { return omitMd ? file.path.replace(/\.md$/, "") : file.path; },
  };
  const workspace = { on: () => ({}), onLayoutReady: (cb) => cb(), getActiveFile: () => null };
  return {
    vault, metadataCache, workspace, files, folders, disk, log,
    text: (p) => (files.has(p) ? files.get(p).content : null),
    /* 外部修改（另一台 pull 進來、或在編輯器裡改）：改內容並發 modify */
    edit(p, content) { const r = files.get(p); r.content = content; emit("modify", r.file); },
    /* Obsidian 裡改名：TFile 物件不變、路徑換掉，發 rename(file, oldPath) */
    rename(oldPath, newPath) {
      if (files.has(oldPath)) {
        const r = files.get(oldPath);
        files.delete(oldPath);
        Object.assign(r.file, { path: newPath }, split(newPath));
        files.set(newPath, r);
        emit("rename", r.file, oldPath);
      } else {
        for (const f of [...folders]) {
          if (f === oldPath || f.startsWith(oldPath + "/")) { folders.delete(f); folders.add(newPath + f.slice(oldPath.length)); }
        }
        for (const [p, r] of [...files]) {
          if (!p.startsWith(oldPath + "/")) continue;
          files.delete(p);
          const np = newPath + p.slice(oldPath.length);
          Object.assign(r.file, { path: np }, split(np));
          files.set(np, r);
        }
        emit("rename", { path: newPath, name: newPath.split("/").pop(), children: [] }, oldPath);
      }
    },
  };
}

const DIR = ".obsidian/plugins/yazi-explorer";
const LOCAL = DIR + "/local.json";

/* 開一個 plugin：data.json 的內容由 store 提供（saveData 寫回 store.data） */
async function boot(app, data) {
  const store = { data: data === undefined ? null : JSON.parse(JSON.stringify(data)), saves: 0 };
  const p = new YaziExplorer();
  p.app = app;
  p.manifest = { dir: DIR };
  p.loadData = async () => {
    if (store.broken) throw new SyntaxError("Unexpected token < in JSON");
    return store.data === null ? null : JSON.parse(JSON.stringify(store.data));
  };
  p.saveData = async (d) => { store.data = JSON.parse(JSON.stringify(d)); store.saves++; };
  p.addSettingTab = () => {};
  p.addCommand = () => {};
  p.registerEvent = () => {};
  await p.onload();
  await flush();
  return { p, store };
}

/* 這個 vault 實際的四個書籤（0.3.1 的 data.json），外加一個資料夾 */
const OLD_BOOKMARKS = [
  { path: "200 Personal/001 日記/目錄v0.6.md", key: "d", added: 1789549108545 },
  { path: "650 Projects/越野跑教練/🏠 dashboard.md", name: "越野跑教練 dashboard", key: "t", added: 1791082484098 },
  { path: "100 工作/projects/200 客製平台/🏠 dashboard.md", name: "客製平台 dashboard", key: "p", added: 1791164045125 },
  { path: "100 工作/projects/100 SDLC研究/🏠 dashboard.md", name: "sdlc研究🏠 dashboard", key: "s", added: 1791164172389 },
  { path: "100 工作/projects", name: "專案", key: null, added: 1791164172390 },
];
const VAULT = {
  "200 Personal/001 日記/目錄v0.6.md": "# 目錄",
  "650 Projects/越野跑教練/🏠 dashboard.md": "",
  "100 工作/projects/200 客製平台/🏠 dashboard.md": "",
  "100 工作/projects/100 SDLC研究/🏠 dashboard.md": "",
  "300 Sport/訓練.md": "",
  "600 Utility": null,
};
const NOTE = "600 Utility/yazi-bookmarks.md";
const view = (p) => p.bookmarks().map((b) => [b.key || null, b.path, b.name || null]);

(async () => {
  /* ══ 1. 留空＝跟以前一樣存在 data.json ══ */
  {
    const app = makeApp(VAULT);
    const { p, store } = await boot(app, { bookmarks: OLD_BOOKMARKS, locale: "en" });
    eq("預設「書籤存檔位置」是空的", p.settings.bookmarksNote, "");
    eq("書籤照舊從 data.json 讀", p.bookmarks().length, 5);
    await p.addBookmark("300 Sport/訓練.md", "訓練");
    eq("新增寫回 data.json 的 bookmarks", store.data.bookmarks.map((b) => b.path).pop(), "300 Sport/訓練.md");
    eq("沒有在 vault 裡建任何筆記", app.log.create, 0);
    eq("data.json 不再帶 frecency／排序的預設值", ["frecency", "sort", "sortSearch"].filter((k) => k in store.data), []);

    const legacy = await boot(makeApp(VAULT), { bookmarks: { a: "x.md", b: "y.md" } });
    eq("0.1 的 {字母: 路徑} 舊格式照樣讀得進來", legacy.p.bookmarks().map((b) => [b.key, b.path]), [["a", "x.md"], ["b", "y.md"]]);
  }

  /* ══ 2. frecency 與排序搬到 local.json ══ */
  {
    const app = makeApp(VAULT);
    const frec = { "a.md": { n: 5, t: 1 }, "b.md": { n: 2, t: 2 }, "100 工作": { n: 9, t: 3 } };
    const { p, store } = await boot(app, { frecency: frec, sort: { field: "ctime", reverse: true, foldersFirst: false } });
    eq("升級後常用清單不歸零（從 data.json 搬過來）", Object.keys(p.data.frecency).sort(), ["100 工作", "a.md", "b.md"]);
    eq("排序也搬過來", p.data.sort.field, "ctime");
    const saved = JSON.parse(app.disk.get(LOCAL));
    eq("搬家後立刻寫出 local.json", [saved.version, Object.keys(saved.frecency).length, saved.sort.field], [1, 3, "ctime"]);
    eq("搬家不改 data.json（舊欄位留給還沒升級的另一台）", [store.saves, Object.keys(store.data.frecency).length], [0, 3]);

    await p.forgetFrecency("a.md");
    p.setSort({ field: "mtime", reverse: false, foldersFirst: true }, false);
    await flush();
    eq("忘掉一筆常用、改排序：寫 local.json、不碰 data.json", [store.saves, Object.keys(JSON.parse(app.disk.get(LOCAL)).frecency).length, JSON.parse(app.disk.get(LOCAL)).sort.field], [0, 2, "mtime"]);

    /* 重跑：local.json 已經有了，data.json 裡的舊資料（例如另一台舊版剛寫的）不會再搬一次 */
    const again = await boot(app, { frecency: { "z.md": { n: 99, t: 9 } } });
    eq("再開一次：只認 local.json，不重複搬", Object.keys(again.p.data.frecency).sort(), ["100 工作", "b.md"]);

    /* local.json 壞掉：退回 data.json 的舊資料，總比歸零好 */
    app.disk.set(LOCAL, "{ not json");
    const broken = await boot(app, { frecency: frec });
    eq("local.json 壞掉時從 data.json 重建", Object.keys(broken.p.data.frecency).length, 3);
  }

  /* ══ 3. 改成存筆記：一筆不少搬進去 ══ */
  {
    const app = makeApp(VAULT);
    const { p, store } = await boot(app, { bookmarks: OLD_BOOKMARKS });
    const before = view(p);
    const r = await p.setBookmarksNote("600 Utility/yazi-bookmarks");
    eq("沒寫 .md 自動補上", r.path, NOTE);
    eq("五筆全部搬進去", r.added, 5);
    eq("切換後清單內容一模一樣（路徑、字母、名稱）", view(p).slice().sort(), before.slice().sort());
    const lines = app.text(NOTE).split("\n");
    eq("筆記：檔案寫成 wikilink、資料夾寫成反引號路徑，照加入時間排", lines.filter((l) => l.startsWith("- ")), [
      "- d · [[200 Personal/001 日記/目錄v0.6]]",
      "- t · [[650 Projects/越野跑教練/🏠 dashboard]] · 越野跑教練 dashboard",
      "- p · [[100 工作/projects/200 客製平台/🏠 dashboard]] · 客製平台 dashboard",
      "- s · [[100 工作/projects/100 SDLC研究/🏠 dashboard]] · sdlc研究🏠 dashboard",
      "- `100 工作/projects` · 專案",
    ]);
    eq("筆記開頭有一段格式說明", lines[0].startsWith("Bookmarks for Yazi Explorer"), true);
    eq("data.json 記下存檔位置、bookmarks 清空（已經搬走了）", [store.data.bookmarksNote, store.data.bookmarks], [NOTE, []]);

    /* 重跑：清空再設回同一份筆記 → 不會多出重複的行 */
    await p.setBookmarksNote("");
    eq("清空＝搬回 data.json，一筆不少", store.data.bookmarks.map((b) => [b.key, b.path]).sort(), before.map((b) => [b[0], b[1]]).sort());
    eq("搬回去時筆記本身不動", app.text(NOTE).split("\n").filter((l) => l.startsWith("- ")).length, 5);
    const again = await p.setBookmarksNote(NOTE);
    eq("再設回同一份筆記：一筆都不重複加", [again.added, app.text(NOTE).split("\n").filter((l) => l.startsWith("- ")).length], [0, 5]);
  }

  /* ══ 4. 筆記本來就有書籤：合併、不覆蓋 ══ */
  {
    const existing = "# 我的書籤\n\n- x · [[300 Sport/訓練]] · 訓練\n- [[650 Projects/越野跑教練/🏠 dashboard]] · 筆記裡的名字\n亂寫的一行\n";
    const app = makeApp(Object.assign({}, VAULT, { [NOTE]: existing }));
    const { p } = await boot(app, { bookmarks: OLD_BOOKMARKS });
    const r = await p.setBookmarksNote(NOTE);
    eq("筆記已有的那筆不重複加（5 筆只加 4 筆）", r.added, 4);
    const after = app.text(NOTE);
    eq("原有的行一行都沒被改（含讀不懂的那行）", lineDiff(existing, after)[0], []);
    eq("同一個檔：名稱與字母照筆記（不被 data.json 覆蓋）",
       p.findBookmark("650 Projects/越野跑教練/🏠 dashboard.md").name, "筆記裡的名字");
    eq("合併後共 6 筆", p.bookmarks().length, 6);
  }

  /* ══ 5. 筆記模式下的新增／改名／改字母／刪除：只動那一行、不碰 data.json ══ */
  {
    const app = makeApp(VAULT);
    const { p, store } = await boot(app, { bookmarks: OLD_BOOKMARKS });
    await p.setBookmarksNote(NOTE);
    const saves = store.saves;
    let prev = app.text(NOTE);
    const step = async (label, fn, want) => {
      await fn();
      const cur = app.text(NOTE);
      eq(label, lineDiff(prev, cur), want);
      prev = cur;
    };
    await step("新增：只多一行", () => p.addBookmark("300 Sport/訓練.md", "訓練"),
      [[], ["- [[300 Sport/訓練]] · 訓練"]]);
    await step("改名：只換那一行", () => p.addBookmark("300 Sport/訓練.md", "跑步訓練"),
      [["- [[300 Sport/訓練]] · 訓練"], ["- [[300 Sport/訓練]] · 跑步訓練"]]);
    await step("指定字母：只換那一行", () => p.assignBookmarkKey("300 Sport/訓練.md", "r"),
      [["- [[300 Sport/訓練]] · 跑步訓練"], ["- r · [[300 Sport/訓練]] · 跑步訓練"]]);
    let stolen;
    await step("搶別人的字母：只換那兩行", async () => { stolen = await p.assignBookmarkKey("300 Sport/訓練.md", "d"); },
      [["- d · [[200 Personal/001 日記/目錄v0.6]]", "- r · [[300 Sport/訓練]] · 跑步訓練"],
       ["- [[200 Personal/001 日記/目錄v0.6]]", "- d · [[300 Sport/訓練]] · 跑步訓練"]]);
    eq("回報字母是從誰身上搶來的", stolen, "200 Personal/001 日記/目錄v0.6.md");
    await step("刪除：只拿掉那一行", () => p.removeBookmark("100 工作/projects"),
      [["- `100 工作/projects` · 專案"], []]);
    eq("書籤操作完全沒寫 data.json", store.saves, saves);
    eq("'d 跳到新的主人", p.bookmarkByKey("d").path, "300 Sport/訓練.md");
  }

  /* ══ 6. 筆記被外部改掉：不用重開就看到，下次存檔不會蓋回舊的 ══ */
  {
    const app = makeApp(VAULT);
    const { p } = await boot(app, { bookmarks: OLD_BOOKMARKS });
    await p.setBookmarksNote(NOTE);
    let rebuilt = 0;
    p.activeModal = { view: "bookmarks", buildList() { rebuilt++; }, render() {} };

    /* 另一台刪掉 SDLC、新增訓練，pull 進來 */
    const pulled = app.text(NOTE)
      .replace("- s · [[100 工作/projects/100 SDLC研究/🏠 dashboard]] · sdlc研究🏠 dashboard\n", "")
      .replace("- `100 工作/projects` · 專案\n", "- `100 工作/projects` · 專案\n- w · [[300 Sport/訓練]] · 另一台加的\n");
    app.edit(NOTE, pulled);
    await flush();
    eq("外部修改後清單馬上更新", p.bookmarks().map((b) => b.key).filter(Boolean), ["d", "t", "p", "w"]);
    eq("開著的書籤清單跟著重畫", rebuilt > 0, true);

    /* 這台接著加一個書籤：寫進去的是「新的現況 + 這一行」，不是記憶體裡的舊清單 */
    await p.addBookmark("100 工作/projects/100 SDLC研究/🏠 dashboard.md", "這台重加的");
    const now = app.text(NOTE);
    eq("下次存檔不會把另一台的修改蓋回去", now.includes("- w · [[300 Sport/訓練]] · 另一台加的"), true);
    eq("另一台刪掉的那行沒有被寫回來（重加的是新的一行，沒有字母）",
       [now.includes("- s · [[100 工作/projects/100 SDLC研究"), now.includes("· 這台重加的")], [false, true]);

    /* 自己寫入引發的 modify：內容一樣，不會再觸發重畫或寫檔（沒有迴圈） */
    const writes = app.log.process;
    rebuilt = 0;
    app.edit(NOTE, app.text(NOTE));
    await flush();
    eq("內容沒變的 modify：不重畫、不寫檔", [rebuilt, app.log.process], [0, writes]);

    /* 直接在筆記裡手寫（只用空白分隔），外掛讀得懂 */
    app.edit(NOTE, app.text(NOTE) + "- k `600 Utility` 手寫的\n- [[200 Personal/001 日記/目錄v0.6]] · 重複的一行\n");
    await flush();
    const k = p.bookmarkByKey("k");
    eq("手寫的行（只用空白分隔）讀得懂", k && [k.path, k.name], ["600 Utility", "手寫的"]);
    eq("同一個檔寫了兩行：清單取第一行", p.findBookmark("200 Personal/001 日記/目錄v0.6.md").key, "d");
    await p.assignBookmarkKey("600 Utility", "u");
    eq("改手寫的那行之後，重複的那行原樣留著", app.text(NOTE).includes("- [[200 Personal/001 日記/目錄v0.6]] · 重複的一行"), true);
  }

  /* ══ 7. 舊版往 data.json 寫書籤：筆記模式下不算數，但看得到、可以匯入 ══ */
  {
    const app = makeApp(VAULT);
    const { p, store } = await boot(app, { bookmarks: OLD_BOOKMARKS });
    await p.setBookmarksNote(NOTE);
    const inNote = view(p);
    /* 另一台的舊版用記憶體裡的舊清單整份寫回 data.json（多了一筆它自己加的） */
    store.data = Object.assign({}, store.data, {
      bookmarks: OLD_BOOKMARKS.slice(0, 2).concat([{ path: "300 Sport/訓練.md", name: "舊版加的", key: "d", added: 1 }]),
    });
    await p.onExternalSettingsChange();
    eq("書籤照舊只讀筆記（舊版寫的那份不會蓋掉筆記）", view(p), inNote);
    eq("列出 data.json 裡有、筆記裡沒有的", p.strayBookmarks().map((b) => b.path), ["300 Sport/訓練.md"]);
    const n = await p.importStrayBookmarks();
    eq("匯入：只加筆記沒有的那一筆", [n, p.findBookmark("300 Sport/訓練.md").name], [1, "舊版加的"]);
    eq("匯入後 data.json 的收件匣清空", store.data.bookmarks, []);

    /* 收件匣裡還有東西時改回存 data.json：筆記的加上收件匣的，一筆不少 */
    store.data = Object.assign({}, store.data, { bookmarks: [{ path: "x/舊版又加的.md", name: "又一筆", key: null, added: 5 }] });
    await p.onExternalSettingsChange();
    const total = p.bookmarks().length;
    await p.setBookmarksNote("");
    eq("改回 data.json：筆記的與收件匣的都留下", [store.data.bookmarks.length, store.data.bookmarks.some((b) => b.path === "x/舊版又加的.md")], [total + 1, true]);
  }

  /* ══ 8. data.json 被外部改掉：重新載入，下次存檔不會蓋回舊值 ══ */
  {
    const app = makeApp(VAULT);
    const { p, store } = await boot(app, { locale: "en", views: [{ id: "v1", name: "A" }], index: { enabled: true } });
    const settingsRef = p.settings;
    let rebuilt = 0;
    p.activeModal = { view: "views", buildList() { rebuilt++; }, render() {} };
    /* 另一台加了一個檢視、關掉全文索引 */
    store.data = Object.assign({}, store.data, { views: [{ id: "v1", name: "A" }, { id: "v2", name: "另一台的" }], index: { enabled: false } });
    await p.onExternalSettingsChange();
    eq("重新載入儲存的檢視", p.views().map((v) => v.name), ["A", "另一台的"]);
    eq("重新載入設定", p.settings.index.enabled, false);
    eq("就地更新同一個 settings 物件（設定頁手上的參照還有效）", p.settings === settingsRef, true);
    eq("開著的檢視清單跟著重畫", rebuilt, 1);
    /* 這台接著存一個檢視：另一台的那筆不會被蓋掉 */
    await p.saveView({ id: "v3", name: "這台的" });
    eq("下次存檔不會蓋回舊值", store.data.views.map((v) => v.name), ["A", "另一台的", "這台的"]);
    eq("另一台改的設定也還在", store.data.index.enabled, false);

    /* 自己剛寫出去的內容又被通知一次：內容一樣就跳過 */
    rebuilt = 0;
    await p.onExternalSettingsChange();
    eq("自己寫的內容回來：不重新載入", rebuilt, 0);

    /* 寫到一半或留著衝突標記：讀不了就保留記憶體裡的 */
    store.broken = true;
    await p.onExternalSettingsChange();
    store.broken = false;
    eq("data.json 讀不了時保留已載入的設定", p.views().length, 3);

    /* 另一台把書籤改存筆記了：這台跟著切過去 */
    app.files.set(NOTE, { file: { path: NOTE, name: "yazi-bookmarks.md", basename: "yazi-bookmarks", extension: "md", stat: {} }, content: "- q · [[300 Sport/訓練]] · 從筆記來\n" });
    store.data = Object.assign({}, store.data, { bookmarksNote: NOTE });
    await p.onExternalSettingsChange();
    eq("別台改了存檔位置：這台改讀那份筆記", view(p), [["q", "300 Sport/訓練.md", "從筆記來"]]);
  }

  /* ══ 9. 改名與搬移 ══ */
  {
    const app = makeApp(Object.assign({}, VAULT, { "100 工作/projects/sub": null }));
    const { p, store } = await boot(app, { bookmarks: OLD_BOOKMARKS.concat([{ path: "100 工作/projects/sub", name: "子", key: null, added: 2e12 }]) });
    await p.setBookmarksNote(NOTE);

    /* 檔案改名：Obsidian 改名 → 自己更新筆記裡的 wikilink（這裡模擬它）→ 書籤跟著走 */
    const writes = app.log.process;
    app.rename("300 Sport/訓練.md", "300 Sport/訓練紀錄.md");
    await flush();
    eq("檔案改名時外掛自己不改 wikilink（交給 Obsidian，免得兩邊互相踩）", app.log.process, writes);
    app.rename("650 Projects/越野跑教練/🏠 dashboard.md", "650 Projects/越野跑教練/首頁.md");
    app.edit(NOTE, app.text(NOTE).replace("[[650 Projects/越野跑教練/🏠 dashboard]]", "[[650 Projects/越野跑教練/首頁]]"));
    await flush();
    eq("Obsidian 更新連結之後，書籤指到新路徑", p.bookmarkByKey("t").path, "650 Projects/越野跑教練/首頁.md");

    /* 最短寫法的 wikilink：搬到別的資料夾，連結文字不用改也還指得到 */
    app.edit(NOTE, app.text(NOTE).replace("[[200 Personal/001 日記/目錄v0.6]]", "[[目錄v0.6]]"));
    await flush();
    app.rename("200 Personal/001 日記/目錄v0.6.md", "200 Personal/目錄v0.6.md");
    await flush();
    eq("最短寫法的 wikilink：搬檔後照樣解析到新位置", p.bookmarkByKey("d").path, "200 Personal/目錄v0.6.md");

    /* 資料夾改名：反引號路徑由外掛改，本身與底下的都跟著，只改那幾行 */
    const before = app.text(NOTE);
    app.rename("100 工作", "100 Work");
    await flush();
    const after = app.text(NOTE);
    eq("資料夾改名：書籤跟著（本身與底下的資料夾）",
       p.bookmarks().filter((b) => b.kind === "path").map((b) => b.path), ["100 Work/projects", "100 Work/projects/sub"]);
    eq("資料夾改名：只改了那兩行", lineDiff(before, after), [
      ["- `100 工作/projects` · 專案", "- `100 工作/projects/sub` · 子"],
      ["- `100 Work/projects` · 專案", "- `100 Work/projects/sub` · 子"],
    ]);

    /* 書籤筆記本身被搬走：存檔位置跟著改 */
    app.rename(NOTE, "Bookmarks.md");
    await flush();
    eq("書籤筆記被改名：存檔位置跟著改並存檔", [p.settings.bookmarksNote, store.data.bookmarksNote], ["Bookmarks.md", "Bookmarks.md"]);
    eq("改名後清單照舊", p.bookmarks().length, 6);

    /* data.json 模式：沒有連結可更新，路徑直接改 */
    const app2 = makeApp(VAULT);
    const two = await boot(app2, { bookmarks: OLD_BOOKMARKS });
    app2.rename("100 工作", "工作");
    await flush();
    eq("data.json 模式：資料夾改名後書籤路徑跟著改並存檔",
       two.store.data.bookmarks.map((b) => b.path).filter((x) => x.startsWith("工作")),
       ["工作/projects/200 客製平台/🏠 dashboard.md", "工作/projects/100 SDLC研究/🏠 dashboard.md", "工作/projects"]);
  }

  /* ══ 10. 存檔位置設成一個資料夾：失敗，而且維持原狀 ══ */
  {
    const app = makeApp(Object.assign({}, VAULT, { "600 Utility/x.md": null }));
    const { p, store } = await boot(app, { bookmarks: OLD_BOOKMARKS });
    let err = null;
    try { await p.setBookmarksNote("600 Utility/x.md"); } catch (e) { err = e.message; }
    eq("路徑是資料夾：丟出錯誤", !!err, true);
    eq("失敗時維持存在 data.json、書籤一筆不少", [p.settings.bookmarksNote, p.bookmarks().length, store.saves], ["", 5, 0]);
  }

  /* ══ 11. onExternalSettingsChange 要 Obsidian 1.5.7 ══ */
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const ver = (s) => s.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0);
  eq("manifest 的 minAppVersion 至少 1.5.7（onExternalSettingsChange 從這版才有）", ver(manifest.minAppVersion) >= ver("1.5.7"), true);

  eq("只記下預期的錯誤（local.json 壞掉、data.json 讀不了），沒有別的例外", logged, [
    "[yazi-explorer] local.json is unreadable; rebuilding it from data.json",
    "[yazi-explorer] data.json changed on disk but could not be read; keeping the loaded settings",
  ]);

  console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("FAIL 測試本身丟出例外：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
