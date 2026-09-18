"use strict";

/*
 * Yazi Explorer
 * -------------
 * yazi 風格的浮動檔案瀏覽器（miller 三欄：父層 / 當前層 / 預覽），另外內建三種
 * 清單檢視：分頁、書籤、最近開啟。開啟時直接定位到當前編輯的檔案，全鍵盤操作。
 *
 * ── 鍵位遵循 Surfingkeys ──
 * 所以 d/u 是半頁捲動（不是刪除）、T 是分頁清單（不是開新分頁）、x 關分頁、
 * b 書籤清單、gg/G 頭尾、yy 複製。檔案管理相關的鍵（a/A/R/D）Surfingkeys 沒有
 * 對應概念（瀏覽器不管檔案），那幾顆沿用 vim / 檔案管理器的慣例。
 * 完整對照見下面的 HELP，或在瀏覽器裡按 ?。
 *
 * ── 出 vault 的那條路：大寫 O ──
 * o ＝在 Obsidian 裡開（同 l / Enter），O ＝丟給 vault 外面的程式開：nvim、檔案
 * 總管、終端機、Claude Code……選單與 dot_config/yazi/yazi.toml 的 [opener] 逐條
 * 對齊，而且呼叫的就是 yazi 在用的同一批腳本（見 OPEN_ACTIONS）。
 * 只有這一塊需要 Electron / Node，其餘功能純 Obsidian API，手機版照常能用。
 *
 * ── 為什麼不沿用 Obsidian 原生的 file-explorer view ──
 * 想省下重繪樹就得去動 WorkspaceLeaf 的內部結構，Obsidian 一升版就可能壞。
 * 這裡只用公開 API（vault / workspace / fileManager），自己畫樹。
 *
 * ── 為什麼自己掛 document capture listener，而不是用 Modal 的 Scope ──
 * 這個 vault 裡有三個外掛在 document 層攔鍵：
 *   leader-hotkeys              capture，攔 ',' 開頭的序列
 *   sidebar-keyboard-navigation bubble，active leaf 是 file-explorer / search 時 armed
 *   vimium-local                capture，只在 markers 顯示時
 * Modal 的 Scope 排在這些之後，搶不到鍵。改成自己在 capture 階段收，處理掉的鍵
 * 一律 stopPropagation —— 傳播一停，bubble 階段也不會再回到 document。
 * 另外開 modal 前會先把 active leaf 拉回主編輯區（見 openExplorer）。
 *
 * ── 踩過的地雷 ──
 * 欄位名不能叫 doc / win：Obsidian 的 Modal 有同名唯讀 getter，指派會丟
 * "Cannot set property doc of #<e> which has only a getter"，而且症狀是整個
 * modal 空白（例外發生在欄位建好之後、render() 之前）。onOpen 和 render 都包了
 * try/catch，就是為了不要再出現「空白畫面、零線索」。
 */

const {
  Plugin, Modal, Notice, Platform, Component, MarkdownRenderer, FileSystemAdapter, prepareFuzzySearch,
} = require("obsidian");
const { defaultSettings } = require("./settings/defaults.js");
const { YaziSettingTab } = require("./settings/tab.js");
const { createTranslator } = require("./i18n/index.js");
const { resolveOpeners, platformId, opnerVars, buildCommand } = require("./core/openers.js");
const { decorate } = require("./core/decorate.js");
const { parseKeymap } = require("./core/keymap.js");
const { outlineItems, headingLines } = require("./core/outline.js");
const { collectRelations } = require("./core/relations.js");
const { aliasesOf } = require("./core/aliases.js");

/*
 * 存檔進來的設定 ＋ 預設值。
 * 逐層 merge 而不是 Object.assign 一層：preview / behavior / index 是巢狀物件，
 * 淺層合併會讓「舊版存的設定少一個新欄位」整組變成 undefined —— 那種壞法是無聲的。
 * 陣列（openers / decorations / facets）刻意**整組取代**：使用者刪掉某條內建 opener，
 * 不該因為它還在預設值裡就自己長回來。
 */
function mergeSettings(base, saved) {
  if (!saved || typeof saved !== "object") return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = mergeSettings(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/*
 * 模糊比對器。用 Obsidian 公開的 prepareFuzzySearch，排序手感才會跟 Quick Switcher
 * 一致（它回傳 (text) => {score, matches} | null，score 愈大愈相關）。
 * 拿不到就退回「小寫子字串」比對 —— 寧可弱一點，也不要整個搜尋功能壞掉。
 */
function makeMatcher(query) {
  if (typeof prepareFuzzySearch === "function") {
    try {
      return prepareFuzzySearch(query);
    } catch (e) {}
  }
  const q = query.toLowerCase();
  return (text) => {
    const i = text.toLowerCase().indexOf(q);
    return i < 0 ? null : { score: -i, matches: [] };
  };
}

/*
 * 判斷是不是資料夾，用 duck typing 而不是 `instanceof TFolder`。
 * instanceof 依賴「拿到的 TFolder 建構式和 Obsidian 實際建物件用的是同一個」，
 * 這個假設不成立時整個 render 會在第一筆資料就炸。TFolder 有 children 陣列、
 * TFile 沒有，判斷這個就夠，也不依賴任何類別身分。
 */
function isFolder(f) {
  return !!f && Array.isArray(f.children);
}

/* ───────────────────────────── 設定常數 ───────────────────────────── */

// 預覽欄會嘗試用純文字顯示的副檔名。刻意不用 MarkdownRenderer 渲染 md：預覽欄
// 要的是「快速辨認這是不是我要的檔」，純文字既快、也不會觸發 dataviewjs /
// meta-bind 之類 widget 的副作用。
const TEXT_EXT = new Set([
  "md", "txt", "json", "yaml", "yml", "csv", "tsv", "log", "xml", "toml", "ini",
  "js", "mjs", "cjs", "ts", "jsx", "tsx", "css", "scss", "html", "svg",
  "sh", "bash", "ps1", "py", "rb", "go", "rs", "java", "cs", "sql", "c", "cpp", "h",
]);

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);

/*
 * 預覽內文的上限。2026-09-17 從 4000 字 / 80 行放寬到 20000 / 400：
 * 預覽欄本來只能看到「開頭那一屏」，截在 80 行完全夠用；現在 J/K 與滾輪可以往下捲，
 * 80 行變成「捲兩下就沒了」的那個限制。渲染是 debounce 過的（停下來才渲染一次），
 * 20000 字對 Obsidian 的 renderer 只是一篇普通長筆記。
 */
const PREVIEW_MAX_CHARS = 20000;
const PREVIEW_MAX_LINES = 400;
const PREVIEW_SEEK_LINES = 5;   // J / K 一次捲幾行（＝ yazi 的 seek 5 / seek -5）
const OUTLINE_PAD = 6;          // 大綱跳到標題時，標題上緣留幾 px，不要貼死在欄頂

/*
 * 層堆疊最多留幾層（見 YaziModal.pushLayer）。
 * 有上限是因為 gr 可以沿著連結一直走下去，而每一層都握著一份清單的參照；
 * 超過就丟掉最舊的那層 —— 退了二十幾次還在退的人，要的是關掉視窗，不是繼續退。
 */
const LAYER_MAX = 24;

/*
 * 兩個檢視的「條件」是否一樣（不看名字、id、字母）。
 * 條件 chip 的順序不重要（A 再加 B 與 B 再加 A 是同一件事），所以先排序再比。
 */
function sameViewDef(a, b) {
  if (!a || !b) return false;
  if ((a.kind || "file") !== (b.kind || "file")) return false;
  if (String(a.query || "").trim() !== String(b.query || "").trim()) return false;
  if ((a.scopePath || "") !== (b.scopePath || "")) return false;
  const key = (fs) => (fs || []).map((f) => f.id + "=" + f.value).sort().join("|");
  return key(a.facets) === key(b.facets);
}

/*
 * 覆蓋層（overlay）：疊在「目前這個地方」上面的暫時狀態，Esc 一次收一層。
 *
 * 這張表是 Esc 行為的**唯一**定義，順序＝由內到外（前面的先收）。每一列只回答兩件事：
 * 它現在開著嗎（open）、怎麼收（close）。
 *
 * 新功能要是會在畫面上疊東西（選單、輸入列、面板…），**加一列在這裡，不要去改
 * escapeBack()**。過去每加一個旗標就在 escapeBack 多寫一個 if，結果是每個新功能都
 * 帶來一個「Esc 退錯地方」的 bug；現在漏掉一列的後果只是 Esc 少收一層，不會把人丟去
 * 沒要求過的地方。
 *
 *   ephemeral  進到新的地方（pushLayer）時順手收掉 —— 那是這個地方的臨時狀態，
 *              不該被帶進下一個地方、也不該存進快照
 *   leaves     收掉它等於離開這個地方（組合卡：還沒送出就 Esc，沒有結果可以留下來看）
 */
const OVERLAYS = [
  { id: "pending", ephemeral: true,
    open: (m) => !!m.pending,
    close: (m) => { m.pending = null; } },
  // 建議列只在組合卡（mode search）裡才算開著：送出之後殘留的 sug 既不算開、也不會被畫
  { id: "suggest", ephemeral: true,
    open: (m) => m.mode === "search" && !!(m.sug || m.sugField),
    close: (m) => { m.sug = null; m.sugField = null; } },
  { id: "helpfilter", ephemeral: true,
    open: (m) => !!m.showHelp && (m.mode === "helpfilter" || !!m.helpFilter),
    close: (m) => { m.helpFilter = ""; if (m.mode === "helpfilter") m.endInput(); } },
  { id: "help", ephemeral: true,
    open: (m) => !!m.showHelp,
    close: (m) => { m.showHelp = false; } },
  { id: "composer", leaves: true,
    open: (m) => m.mode === "search",
    close: (m) => { m.endInput(); m.leaveSubView(); } },
  { id: "input",
    open: (m) => m.mode === "listfilter" || m.mode === "filter" || m.mode === "prompt",
    close: (m) => m.cancelInput() },
  { id: "confirm", ephemeral: true,
    open: (m) => m.mode === "confirm",
    close: (m) => { m.mode = "nav"; m.confirmTarget = null; m.confirmTargets = null; m.confirmAsk = null; } },
  { id: "selection",
    open: (m) => m.hasSelection(),
    close: (m) => m.clearSelection() },
];

/*
 * 清單檢視裡「x ＝拿掉這一列」怎麼做。一列一張表，而不是四段 if：
 * 多選批次刪只要照這張表跑一圈，單筆與批次就不會各長出一套行為
 * （跟 OVERLAYS 那次重構同一個理由 —— if 階梯每加一種清單就漏一個分支）。
 *
 *   remove       真的拿掉一列，回傳 Promise
 *   confirmOne   單筆要不要先問 y/n。使用者一筆一筆存下來的東西（書籤、檢視）才問；
 *                分頁與「常去的地方」是隨手產生的紀錄，問了只是多一顆鍵
 *   label        確認訊息與錯誤訊息裡怎麼稱呼這一列
 *   ask / done   單筆的確認訊息與完成通知；askMany / doneMany 是多筆版
 *
 * 在這張表裡＝可以多選（見 listSelectable）。大綱、關聯、搜尋結果不在：那些清單的
 * 每一列都是某個檔案的投影，「拿掉一列」沒有對應的動作（要刪檔案是回檔案檢視按 D）。
 * 最近開啟也不在：那份清單由 Obsidian 維護，沒有公開 API 可以刪。
 */
const LIST_REMOVE = {
  bookmarks: {
    confirmOne: true,
    ask: "confirm.deleteBookmark", askMany: "confirm.deleteBookmarks",
    done: "notice.bookmarkRemoved", doneMany: "notice.bookmarksRemoved",
    label: (it) => it.title || it.label || it.path,
    remove: (m, it) => m.plugin.removeBookmark(it.path),
  },
  views: {
    confirmOne: true,
    ask: "confirm.deleteView", askMany: "confirm.deleteViews",
    done: "notice.viewRemoved", doneMany: "notice.viewsRemoved",
    label: (it) => (it.viewDef ? it.viewDef.name : it.label),
    remove: (m, it) => m.plugin.removeView(it.viewDef.id),
  },
  tabs: {
    confirmOne: false,
    askMany: "confirm.closeTabs",
    doneMany: "notice.tabsClosed",
    label: (it) => it.label,
    // detach() 就是關分頁。關掉之後重建清單，游標留在同一個索引 = 下一個分頁。
    remove: (m, it) => Promise.resolve(it.leaf.detach()),
  },
  frecency: {
    confirmOne: false,
    askMany: "confirm.forgetFrecency",
    done: "notice.frecencyRemoved", doneMany: "notice.frecencyRemovedN",
    label: (it) => it.path,
    remove: (m, it) => m.plugin.forgetFrecency(it.path),
  },
};

/*
 * 這些前綴的標籤在 UI 裡一律濾掉（搜尋候選、預覽面板都是）。
 *
 * 它們是**筆記系統自動掛上去的**分類標籤，不是人手選的。留著的話它們靠數量穩坐
 * 候選清單前幾名，把真正有意義的自由標籤擠到看不見的地方 —— 標籤是照使用量排序的，
 * 所以雜訊越多筆、傷害越大。它們表達的那條軸通常已經有 frontmatter 欄位可以篩了。
 */
const AUTO_TAG_PREFIXES = ["work/"];

/*
 * 捲預覽欄的 Ctrl 組合：vim 捲 buffer 的那一套原封照搬。
 * 平鍵的 d / u 是「游標半頁」（Surfingkeys），不衝突——要捲預覽就是加 Ctrl 的那個。
 */
const PREVIEW_SCROLL_KEYS = {
  e: ["line", 1], y: ["line", -1],
  d: ["half", 1], u: ["half", -1],
  f: ["page", 1], b: ["page", -1],
};
const HALF_PAGE = 10;          // d / u 一次跳幾列
const RECENT_LIMIT = 40;       // 最近開啟最多列幾筆
const FRECENCY_LIMIT = 60;     // z（常用）清單最多列幾筆
const FRECENCY_KEEP = 800;     // 常用紀錄最多留幾筆，超過就丟分數最低的
const SEARCH_LIMIT = 60;       // 全域模糊搜尋最多列幾筆候選
const INDEX_MAX_CHARS = 200000; // 全文索引每個檔最多記幾個字（擋住異常大的檔）
const INDEX_BATCH = 64;         // 建索引時一次併發讀幾個檔
/*
 * 超過這個大小的檔完全不索引。實測這個 vault：4 個檔（三份 *.atlas.html 各 3.5 MB
 * ＋ Leetcode.csv 1.4 MB）就佔了全部 23.6 MB 的 50%，而且都是生成物。
 * 原本是「整個讀進來再截成 20 萬字」—— I/O 全付了卻只留下一小段，純浪費。
 */
const INDEX_SKIP_ABOVE = 1048576;
const INDEX_FILE = "text-index.json";
const INDEX_VERSION = 1;
const INDEX_SAVE_DELAY = 30000; // 索引變動後隔多久才寫檔（避免每次存檔都寫十幾 MB）
const CTX_MAX_LINES = 3;        // 中欄每個結果最多顯示幾行上下文
const CTX_BEFORE = 28;          // 長行截斷：命中位置前保留幾個字
const CTX_AFTER = 90;           //           命中位置後保留幾個字
const PREVIEW_FULL_CHARS = 60000; // 右欄內文最多渲染幾個字

/*
 * 排序方式。key 是按下 o 之後要按的那一顆鍵，field 是實際比較的欄位。
 * "natural" ＝ 該檢視的原生順序（搜尋結果＝相關度、最近開啟＝時間、書籤＝字母），
 * 這個選項是必要的：排序一旦套上去就蓋掉相關度，沒有退路的話會很煩。
 */
const SORTS = [
  { k: "0", field: "natural", labelKey: "sort.natural" },
  { k: "n", field: "name", labelKey: "sort.name" },
  { k: "m", field: "mtime", labelKey: "sort.mtime" },
  { k: "c", field: "ctime", labelKey: "sort.ctime" },
  { k: "s", field: "size", labelKey: "sort.size" },
  { k: "e", field: "ext", labelKey: "sort.ext" },
  // 以下三個吃工作專案的 frontmatter（見下方常數區）。沒有該欄位的檔案與資料夾
  // 一律沉底，所以用這幾個排序時 foldersFirst 最好維持開著。
  { k: "p", field: "priority", labelKey: "sort.priority" },
  { k: "k", field: "category", labelKey: "sort.category" },
  { k: "t", field: "state", labelKey: "sort.status" },
];
/* field → i18n key。翻譯在顯示的當下才解析：模組層沒有 this，也還沒讀到設定的語言 */
const SORT_LABEL = {};
for (const s of SORTS) SORT_LABEL[s.field] = s.labelKey;

/* ─────────────────────── 外部開啟（大寫 O）───────────────────────
 *
 * yazi 的 `open --interactive` 搬過來：把游標這一項丟給 vault 外面的程式開。
 *
 * **選單內容完全來自設定**（settings.openers），這支檔案裡沒有任何寫死的程式名稱或
 * 路徑 —— 那是這個 plugin 能公開發佈的前提，也讓「我想多一種開法」不必等作者發版。
 * 過濾與指令展開的邏輯在 core/openers.js（純函式，有測試）。
 *
 * ⚠️ kind = "command" 需要 child_process，只有桌面版有；resolveOpeners() 會在
 *    行動版自動把那類過濾掉，其餘（系統預設程式、檔案管理器、Obsidian 命令）照常。
 */

// vault 相對路徑 → 作業系統的絕對路徑。手機版沒有 basePath 可問，回 null，
// 呼叫端自己決定要不要退回相對路徑（cc）或直接拒絕（O）。
function absPath(app, rel) {
  /* getBasePath 只存在於 FileSystemAdapter（桌面版）。行動版是別的 adapter，
     那裡沒有「作業系統路徑」這種東西 —— 回 null 讓呼叫端自己決定退路。 */
  const ad = app.vault.adapter;
  const base = ad instanceof FileSystemAdapter ? ad.getBasePath() : "";
  if (!base) return null;
  const joined = rel && rel !== "/" ? base + "/" + rel : base;
  // Windows 統一成反斜線（貼進 PowerShell / 檔案總管才是原生形狀）；
  // unix 原樣返回 —— 檔名裡的反斜線在那邊是合法字元，不能亂換。
  return Platform.isWin ? joined.replace(/\//g, "\\") : joined;
}

/*
 * 開一支外部程式並且**完全脫離** Obsidian：detached + unref，關掉 Obsidian 也不會
 * 連帶收掉那個視窗（等同 yazi opener 的 block = false + orphan = true）。
 *
 * 參數是**一個一個**傳的（不是把整串指令交給 shell 去切），所以含空白的路徑不必跳脫，
 * 也不會有人在檔名裡藏分號就變成執行任意指令。
 * child_process 在行動版不存在 —— 呼叫端（resolveOpeners）已經先把這類 opener 濾掉，
 * 這裡的 require 只會在桌面版執行到。
 */
function runCommand(cmd, args) {
  if (!Platform.isDesktopApp) throw new Error("external commands are desktop only");
  const cp = require("child_process");
  const proc = cp.spawn(cmd, args || [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  proc.unref();
}

/* ─────────────────────── 工作專案 frontmatter ───────────────────────
 *
 * 讓 `100 工作/projects/` 底下的 task／文件在清單裡一眼分得出「這是什麼、到哪了、
 * 急不急」。規格是 `600 Utility/AI Docs/專案管理系統操作手冊.md` §3。
 *
 * ⚠️ 判斷「要不要裝飾這一列」的依據是 **frontmatter 有沒有認得的 `type`**，
 *    不是路徑。綁路徑的話 archive/、雜項/、將來新開的領域都要回來改 code，
 *    而且 `200 Personal`、`700 Day Planners` 那些沒有 type 的筆記自動完全不受影響。
 *
 * 每列只加兩個位置，這是刻意的上限：
 *   1. 最前面那顆圖示（**取代**原本的 `·`，不佔新欄位）＝ 分類
 *   2. 貼右一小段 ＝ 狀態 ＋ P0/P1 ＋ 逾期
 * `id` 不顯示（檔名開頭已經是 `OB-13`）；`description` 不顯示（太長，去預覽欄看）；
 * priority 只顯示 P0/P1（P2 是預設值，全顯示等於每列都掛一塊噪音）。
 */

/*
 * task 的 kind / status / priority —— 單一來源是 vault 裡的
 * `600 Utility/Scripts/taskVocab.js`（2026-09-17 抽出），與 Tasks 看板、建檔骨架、
 * 套用範本按鈕吃的是同一份。下面這幾份是 **fallback**，只在讀不到時頂著，
 * **不要在這裡加值** —— 這個 plugin 住在 vault 外，正是最容易漂掉的那一個。
 *
 * 抽出來的起因就是這裡：2026-09-17 在這支隨手寫的 Bug 圖示是 🐞、看板是 🐛，
 * 同一套詞彙在兩個畫面長不一樣。
 */
// 排序時「沒有這個欄位」一律沉底（含資料夾）。用一個比任何真值都大的數。
const FM_LAST = 9999;

// SORTS 的 field → fmInfo() 上對應的排序權重欄位
const FM_SORT_KEY = { priority: "prioOrder", category: "groupOrder", state: "statusOrder" };

/*
 * 「有填、但這份表不認得」的值一律畫成這個。
 *
 * 這是**漂移的偵測機制**，不是裝飾。單一來源檔只能減少要改的地方，減不掉「改了 A
 * 忘了 B」—— 真正會讓你發現漏掉的，是漏掉的當下畫面上就看得出來。
 * 靜靜退回一個長得很正常的預設圖示，等於把錯誤藏起來（那正是 category 合併前
 * 「同一種文體被拆進兩類」能撐半年沒人發現的原因）。
 * 空值不算未知 —— 手冊明講「填不出來時留空白」，空白是合法狀態。
 */
const UNKNOWN_ICON = "❓";

/* ─────────────────────────── 搜尋條件（facet）───────────────────────────
 *
 * 目標只有一個：**永遠不必先知道語法**。
 *
 * Obsidian 原生搜尋難用不是因為功能少，是因為語法是一種隱形的第二語言 ——
 * UI 從來不告訴你有 `path:` / `tag:` / `[property:value]`，打錯又是無聲的
 * （`path:客制平台` 少一個字不會報錯，只是默默變成一個普通關鍵字）。
 *
 * 這裡的作法：打字就是關鍵字，**條件用建議選出來**。你打 `p0`，建議列會直接冒出
 * 「🔴 優先度 = P0 Urgent」；打 `#` 會列出 vault 真正存在的標籤＋份數。
 * 選中的條件變成一顆看得見、可刪的 chip，不會藏在字串裡。
 *
 * 每個欄位同時有一顆直接鍵（Tab 開的選單上會標出來），所以熟了之後可以跳過翻找，
 * 但**不需要先背**——選單本身就是教學。
 *
 * `values` 一律從 vault 現況掃出來（而不是寫死清單），所以你永遠只會看到真的存在
 * 的值，而且帶份數 —— 錯字會以「某個值只有 1 筆」的形狀現形（同 dashboard 標籤軸）。
 */
/*
 * 直接鍵一律是 Ctrl+字母，而且**避開 j / k**（那兩顆在搜尋中是上下移動）。
 * 用 Ctrl 而不是 Alt：Windows 的 Alt 會啟動視窗選單列，而且 AHK 已經把 Alt+A
 * 拿去切輸入法了（見 MyConfig 的 autohotkey.ahk）。
 */
/*
 * 目前生效的搜尋條件（settings.facets 的快照），與 id → spec 的索引。
 * 跟裝飾規則一樣住在模組層、onload 與每次 openExplorer 同步一次。
 * 預設值只有「每個 vault 都成立」的那幾個（資料夾／標籤／副檔名／排除／正則）；
 * 綁 frontmatter 欄位的條件（優先度、狀態…）必然因人而異，由設定提供。
 */
let FACETS = [];
let FACET_BY_ID = {};
function setFacets(list) {
  FACETS = (list || []).filter((f) => f && f.enabled !== false);
  FACET_BY_ID = {};
  for (const f of FACETS) FACET_BY_ID[f.id] = f;
}

// 建議列最多顯示幾筆。再多就不是「掃一眼」而是「再搜尋一次」了
const SUGGEST_LIMIT = 12;

/*
 * 組合卡底下的結果預覽筆數。
 * 原本只給「2378 → 4」這個數字當回饋，但數字只答得出「有幾筆」，答不出
 * 「是不是我要的那幾筆」—— 條件組錯（例如挑到同名但不同專案的標籤）時數字看起來
 * 完全正常。所以列出前幾筆，讓人用眼睛確認，而不是送出之後才發現。
 * 5 筆是刻意的上限：再多就變成「結果清單」，那是送出之後才該佔版面的東西。
 */
const COMPOSER_PREVIEW = 5;

/*
 * 打字時重算搜尋的節流間隔（ms）。
 *
 * 真正貴的不是預覽那五列，是**搜尋本身**：全文要掃整份索引（兩千多筆 × 內容比對），
 * gf/gd 要對全 vault 跑一次模糊比對。這個成本在加預覽之前就已經逐鍵付了。
 *
 * 140ms 的取法：比一般連續打字的鍵間隔長（所以打字中只會算最後一次），
 * 比人「停手去看結果」的反應時間短（所以停手幾乎立刻就有結果）。
 * 送出前一定先 flush，不會拿到過期的清單。
 */
const SEARCH_DEBOUNCE = 140;

/*
 * 「這次重算算便宜」的門檻（ms）。上一次低於這個值就**不節流、逐鍵即時重算**，
 * 超過才排隊。所以小 vault、檔名搜尋、條件已經把範圍縮得很小的時候，打字是即時的；
 * 只有真的會頓的情境（全 vault 全文搜尋）才付節流的代價。
 *
 * 12ms 的取法：一格 60fps 的預算是 16.7ms，留一點給 render 與瀏覽器自己的工作。
 * 低於它就算逐鍵重算也不會掉格，使用者感覺不到差別。
 */
const SEARCH_SYNC_BUDGET = 12;

/*
 * 說明頁（?）的內容。
 *
 * 只放**跟操作有關**的東西：左邊是一顆鍵（或滑鼠動作），右邊是它做什麼。
 * 解說性的段落一律不進來 —— 說明頁是拿來查鍵位的，不是拿來讀文件的（那是 README）。
 *
 * 每一列是 [鍵位, i18n key]；只有一個元素的是區塊標題。
 * 文字住在 i18n/ 底下，英文是預設，缺翻譯就退回英文。
 */
const HELP = [
  ["help.sec.move"],
  ["j / k", "help.move.jk"],
  ["h", "help.move.h"],
  ["l / Enter / o", "help.move.l"],
  ["gg / G", "help.move.gg"],
  ["d / u", "help.move.du"],
  ["help.sec.open"],
  ["t", "help.open.t"],
  ["gb", "help.open.gb"],
  ["s / i", "help.open.si"],
  ["help.sec.external"],
  ["O", "help.ext.O"],
  ["O then d / f / r", "help.ext.builtin"],
  ["O then …", "help.ext.custom"],
  ["help.sec.search"],
  ["gt", "help.search.gt"],
  ["gf", "help.search.gf"],
  ["gd", "help.search.gd"],
  ["(while typing) ↑↓ / ^j ^k", "help.search.move"],
  ["(full text) space", "help.search.and"],
  ["(while typing) Enter", "help.search.enter"],
  ["(while typing) ^Enter", "help.search.ctrlEnter"],
  ["(results) i", "help.search.back"],
  ["(results) /", "help.search.refine"],
  ["help.sec.conditions"],
  ["(condition card) Tab", "help.cond.tab"],
  ["^f / ^t / ^e", "help.cond.keys"],
  ["^ + your keys", "help.cond.custom"],
  ["^x / ^r", "help.cond.exclude"],
  ["Backspace", "help.cond.backspace"],
  ["(results) i / Tab", "help.cond.reopen"],
  ["help.sec.scope"],
  ["^f", "help.scope.change"],
  ["✕ on the scope chip", "help.scope.clear"],
  ["help.sec.preview"],
  ["J / K", "help.prev.JK"],
  ["^e / ^y", "help.prev.line"],
  ["^d / ^u", "help.prev.half"],
  ["^f / ^b", "help.prev.page"],
  ["PageDown / PageUp", "help.prev.pgkeys"],
  ["(wheel)", "help.prev.wheel"],
  [",p", "help.prev.toggle"],
  ["help.sec.lists"],
  ["T", "help.list.T"],
  ["b", "help.list.b"],
  ["rf", "help.list.rf"],
  ["z", "help.list.z"],
  ["go", "help.list.go"],
  ["gr", "help.list.gr"],
  ["(relations) Enter / l", "help.list.grJump"],
  ["gv", "help.list.gv"],
  ["(search results) s", "help.list.vsave"],
  ["(views) e", "help.list.vedit"],
  ["(views) R", "help.list.vrename"],
  ["(views) m + letter", "help.list.vassign"],
  ["(in a list) x", "help.list.x"],
  ["(in a list) q / Esc", "help.list.back"],
  ["help.sec.bookmarks"],
  ["m", "help.bm.m"],
  ["M", "help.bm.M"],
  ["(bookmark list) R", "help.bm.rename"],
  ["' + letter", "help.bm.jump"],
  ["(bookmark list) m + letter", "help.bm.assign"],
  ["help.sec.tabs"],
  [",x", "help.tab.close"],
  [",X", "help.tab.undo"],
  ["help.sec.select"],
  ["<Space>", "help.sel.space"],
  ["v / V", "help.sel.v"],
  ["^a / ^r", "help.sel.all"],
  ["Esc", "help.sel.esc"],
  ["(selection survives folders)", "help.sel.across"],
  ["(in a list) <Space> / v / ^a", "help.sel.list"],
  ["help.sec.clipboard"],
  ["y", "help.clip.y"],
  ["x", "help.clip.x"],
  ["p", "help.clip.p"],
  ["P", "help.clip.P"],
  ["Y / X", "help.clip.Y"],
  ["(cut then paste = move)", "help.clip.links"],
  ["help.sec.files"],
  ["a / A", "help.file.a"],
  ["R", "help.file.R"],
  ["D", "help.file.D"],
  ["cc / cd", "help.file.cc"],
  ["cf / cn", "help.file.cf"],
  ["cr", "help.file.cr"],
  ["help.sec.sort"],
  ["S", "help.sort.S"],
  ["S then 0/n/m/c/s/e", "help.sort.builtin"],
  ["S then p/k/t", "help.sort.fm"],
  ["S then S", "help.sort.reverse"],
  ["S then d", "help.sort.folders"],
  ["help.sec.other"],
  ["/", "help.other.filter"],
  ["?", "help.other.help"],
  ["Esc", "help.other.esc"],
  ["q", "help.other.q"],
];

/*
 * 按下多鍵序列的第一顆之後，which-key 卡裡要列什麼。
 * 只有「選項固定」的前綴寫在這裡；sort / open 的內容得看當下狀態算（目前的排序、
 * 游標是檔案還是資料夾），在 pendingMenu() 裡組。assign / ' 收的是任意字母，
 * 沒有清單可列，只給一行說明（note）。
 * key ＝卡片左上角要顯示的那顆鍵（pending 存的是內部名稱，兩者不一定一樣）。
 */
const PENDING_MENUS = {
  g: {
    descKey: "menu.g.desc",
    items: [["g", "menu.g.g"], ["t", "menu.g.t"], ["f", "menu.g.f"], ["d", "menu.g.d"],
            ["o", "menu.g.o"], ["r", "menu.g.r"], ["v", "menu.g.v"], ["b", "menu.g.b"]],
  },
  c: {
    descKey: "menu.c.desc",
    items: [["c", "menu.c.c"], ["d", "menu.c.d"], ["f", "menu.c.f"], ["n", "menu.c.n"], ["r", "menu.c.r"]],
  },
  ",": {
    descKey: "menu.comma.desc",
    items: [["x", "menu.comma.x"], ["X", "menu.comma.X"], ["p", "menu.comma.p"]],
  },
  r: { descKey: "menu.r.desc", items: [["f", "menu.r.f"]] },
  assign: { key: "m", descKey: "menu.assign.desc", noteKey: "menu.assign.note" },
  vassign: { key: "m", descKey: "menu.vassign.desc", noteKey: "menu.assign.note" },
  "'": { descKey: "menu.quote.desc", noteKey: "menu.quote.note" },
};

const KEYMENU_MAX_ROWS = 6;   // 一欄最多幾列，超過就多開一欄（最多三欄）

/* ───────────────────────────── Modal ───────────────────────────── */

class YaziModal extends Modal {
  constructor(app, startFile, plugin) {
    super(app);
    this.plugin = plugin;
    this.startFile = startFile;
    this.initialView = "files";
    // 每層資料夾上次停在哪 —— yazi 的行為：h 回上層再 l 進來，游標會回到原位
    this.memo = new Map();
    this.filter = "";
    this.mode = "nav";        // nav | filter | prompt | confirm | search
    this.view = "files";      // files | tabs | bookmarks | recent | search
    this.searchKind = "file"; // search 檢視要搜檔案還是資料夾
    this.pending = null;      // 多鍵序列的前綴：g / y / r / ' / assign
    this.listItems = [];
    this.listIndex = 0;
    this.searchQuery = "";   // 搜尋關鍵字（Enter 收起輸入列後還要留著）
    this.listFilter = "";    // 在搜尋結果裡再過濾一層
    this.outlineFile = null; // 大綱檢視（go）在看哪個檔
    this.opening = false;    // 開場的初始檢視期間為 true，那期間不推層（見 pushLayer）
    this.relFile = null;     // 關聯檢視（gr）以哪個檔為中心
    this.relExpanded = new Set(); // 哪些「一般連結」組被展開了（key ＝ 中心路徑 + 組名）
    this.relCache = null;    // 每個檔的關聯分組，一次開啟期間各算一次（見 relationGroupsFor）
    /*
     * 從某份清單（書籤、搜尋結果、關聯）跳進 vault 時落地的資料夾路徑。
     * 在檔案檢視裡，站在落地點按 h ＝退回那份清單（那才是「我從哪來」）；
     * 往下鑽了之後 h 照舊是上一層資料夾，走回落地點再按 h 才退層。
     */
    this.landing = null;
    this.editingView = null; // 組合卡正在編輯哪一筆儲存的檢視（e 進來的）；null ＝一般搜尋
    /*
     * 層堆疊。Esc／q／h 是「退回上一層」，而「上一層」有很多種：從檔案檢視按 b 進書籤、
     * 從書籤跳進某個資料夾、從檢視清單執行一個搜尋、從搜尋結果按 go 看大綱、
     * 用 gr 沿著關聯一路走 —— 全部都是同一件事。
     *
     * 一開始這裡是三個各自為政的欄位（outlineFrom / relStack / 什麼都沒有），
     * 結果每多一種轉場就多一個「Esc 退錯地方」的 bug。改成一個堆疊之後，
     * 規則只剩一條：**進新的一層就 push，退就 pop，pop 不動就關視窗。**
     */
    this.layers = [];
    this.previewPath = null; // 右欄目前畫的是哪個檔（大綱檢視靠它決定「只捲不重畫」）
    this.facets = [];        // 搜尋條件 chip（見 FACETS 常數的長註解）
    this.sug = null;         // 建議清單 {items, index}
    this.sugField = null;    // 正在挑哪個欄位的值（null = 還沒指定欄位）
    this.fvCache = null;     // 欄位值統計快取（一次開啟算一次）
    this.searchTotal = 0;    // 套條件前的筆數，給「2378 → 4」那個計數用
    this.searchTimer = null; // 打字節流的 timer（見 SEARCH_DEBOUNCE）
    this.searchPending = false; // 有一次重算排隊中 → 畫面上的筆數與預覽是舊的
    this.searchCost = 0;     // 上一次重算實測花了幾 ms，決定要不要節流
    /*
     * 搜尋分兩段：組合（composing）→ 結果。
     * 第一版把輸入列放右下、說明放左欄、條件 chip 放左下，三個角落各一塊 ——
     * 組一個查詢要同時盯三個地方，實際用起來很累。
     * 所以組合時改成一張**置中的卡**，輸入／條件／建議／提示全部收在同一個視線範圍；
     * 送出之後卡才收起來，版面讓給結果。條件隨時按 i 或 Tab 回來改。
     */
    this.composing = false;
    /*
     * 搜尋範圍。與其他條件分開存，因為它的地位不一樣：
     *   - **一律顯示**（包含「全 vault」），所以「我在哪裡搜」永遠不必用猜的
     *   - 預設＝觸發搜尋時所在的資料夾。悄悄改變行為是不行的，但範圍一直看得見，
     *     就不算悄悄 —— 這兩件事要一起做才成立
     *   - 它會收窄**其他條件的候選值**：範圍外的標籤選下去必定 0 筆，
     *     建議一個保證失敗的操作是 bug，不只是雜訊
     */
    this.scopePath = "";     // "" = 全 vault
    this.searchOrigin = "";  // 觸發搜尋時所在的資料夾（範圍階梯的中心，不隨 scopePath 變）
    this.showHelp = false;
    this.previewToken = 0;
    this.indexing = false;
    this.sel = new Set();     // 多選：選取的路徑（跨資料夾保留，對齊 yazi）
    /*
     * 清單檢視的多選。刻意跟 sel 分開存：
     *   1. 清單的項目不一定有路徑（分頁只有 leaf，檢視只有 id），見 listSelKey
     *   2. 兩者不是同一件事 —— 選了三個書籤之後退回檔案檢視，那三筆不是
     *      「選了三個檔案」，它們是書籤那份清單上的三列
     * 換一份清單就清掉（見 resetListSelection）。
     */
    this.listSel = new Set();
    this.visual = 0;          // 0=關 / 1=v（選取） / -1=V（取消選取）
    this.visualAnchor = -1;   // visual 起點在目前這份清單的索引（見 selIndex）
    this.visualBase = null;   // 進 visual 之前的選取長相（見 applyVisual）
  }

  /* ── 生命週期 ── */

  /*
   * onOpen 包 try/catch：這裡丟例外的話，欄位已經建好、render() 還沒跑，畫面就是
   * 「三欄框在、內容全空」，看不出任何線索。第一版就是這樣（this.doc 撞到 Modal
   * 的唯讀 getter），debug 花了一輪，不要再來一次。
   */
  onOpen() {
    try {
      this.build();
    } catch (e) {
      console.error("[yazi-explorer] onOpen failed", e);
      new Notice(this.t("notice.openFailedModal", "Yazi Explorer failed to open: {error}", { error: msg(e) }));
      try {
        this.contentEl.createDiv({ cls: "yazi-empty", text: this.t("ui.openFailed", "Failed to open: {error}", { error: msg(e) }) });
      } catch (e2) {}
    }
  }

  build() {
    this.modalEl.addClass("yazi-modal");
    this.contentEl.addClass("yazi-root");

    const cols = this.contentEl.createDiv({ cls: "yazi-cols" });
    this.colsEl = cols;
    this.parentEl = cols.createDiv({ cls: "yazi-col yazi-col-parent" });
    this.mainEl = cols.createDiv({ cls: "yazi-col yazi-col-main" });
    this.previewEl = cols.createDiv({ cls: "yazi-col yazi-col-preview" });

    /*
     * 組合搜尋用的置中卡。**骨架只建一次**，重繪時只換裡面的文字與清單 ——
     * 整張重建的話，被搬進來的 input 每敲一個字就會被拔起來重插一次，焦點與
     * 中文組字狀態都會掉（renderDocs.js 的 ensureSearch() 踩過同一個坑）。
     */
    this.composerEl = this.contentEl.createDiv({ cls: "yazi-composer" });
    const card = this.composerEl.createDiv({ cls: "yazi-cs-card" });
    this.csTitleEl = card.createDiv({ cls: "yazi-cs-title" });
    // 查詢盒：條件 chip 在上、輸入列在下，**同一個框裡** —— 它們是同一件事的兩半
    this.csBoxEl = card.createDiv({ cls: "yazi-cs-box" });
    this.csChipsEl = this.csBoxEl.createDiv({ cls: "yazi-cs-chips" });
    this.csMetaEl = card.createDiv({ cls: "yazi-cs-meta" });
    this.csSugEl = card.createDiv({ cls: "yazi-cs-sug" });
    this.csPreviewEl = card.createDiv({ cls: "yazi-cs-preview" });
    this.csHintEl = card.createDiv({ cls: "yazi-cs-hint" });
    this.composerEl.hide();

    /*
     * 多鍵序列（g / c / r / , / S / O / 書籤字母）按下第一顆之後的 which-key 提示：
     * 置中浮在三欄上面，不搶版面也不需要挪視線。
     *
     * 為什麼不留在底部那一列：那裡字小、在視線最外圍，而按下前綴之後「現在可以按
     * 什麼」是**當下唯一要做的決定** —— 它必須出現在眼睛正在看的地方。Surfingkeys
     * 與 nvim 的 which-key 都是這個位置，肌肉記憶也對得上。
     * 骨架建一次、內容每次重填（同 composer 的理由，見上面那段註解）。
     */
    this.menuEl = this.contentEl.createDiv({ cls: "yazi-keymenu" });
    const kmCard = this.menuEl.createDiv({ cls: "yazi-km-card" });
    this.kmTitleEl = kmCard.createDiv({ cls: "yazi-km-title" });
    this.kmItemsEl = kmCard.createDiv({ cls: "yazi-km-items" });
    this.kmHintEl = kmCard.createDiv({ cls: "yazi-km-hint" });
    this.menuEl.hide();

    const bar = this.contentEl.createDiv({ cls: "yazi-bar" });
    this.barEl = bar;
    /*
     * 搜尋條件 chip 自己佔一列，不跟路徑／輸入列擠。擠在一起的話路徑一長，
     * chip 就會被推出畫面 —— 而「我現在套了哪些條件」是絕對不能看不見的東西
     * （那正是原生搜尋最讓人迷路的地方：條件藏在一串文字裡）。
     */
    this.facetEl = bar.createDiv({ cls: "yazi-chips" });
    this.facetEl.hide();
    const row = bar.createDiv({ cls: "yazi-bar-row" });
    this.barRowEl = row;
    this.pathEl = row.createDiv({ cls: "yazi-path" });
    // 輸入列是常駐元素，不跟著 render() 重建 —— 重建會弄丟焦點和輸入中的內容
    this.inputWrapEl = row.createDiv({ cls: "yazi-input-wrap" });
    this.inputLabelEl = this.inputWrapEl.createSpan({ cls: "yazi-input-label" });
    this.inputEl = this.inputWrapEl.createEl("input", { type: "text", cls: "yazi-input" });
    this.hintEl = row.createDiv({ cls: "yazi-hint", text: this.t("ui.help", "? help") });
    this.inputWrapEl.hide();

    this.inputEl.addEventListener("input", () => {
      if (this.mode === "filter") {
        this.filter = this.inputEl.value;
        this.setCursor(0);
        this.render();
      } else if (this.mode === "listfilter") {
        this.listFilter = this.inputEl.value;
        this.listIndex = 0;
        if (this.view === "search") this.buildSearchList();
        else this.buildList();
        this.render();
      } else if (this.mode === "helpfilter") {
        this.helpFilter = this.inputEl.value;
        this.render();
      } else if (this.mode === "search") {
        this.searchQuery = this.inputEl.value;
        this.listIndex = 0;
        // 建議一律即時更新（候選值有快取，很便宜）；重算搜尋才走節流
        this.refreshSuggest(false);
        this.scheduleSearch();
        this.render();
      }
    });

    // 起點：當前檔案所在的資料夾，游標停在該檔案上
    const f = this.startFile;
    this.cwd = f && f.parent ? f.parent : this.app.vault.getRoot();
    this.cursorPath = f ? f.path : null;

    /*
     * Escape 在子檢視（分頁 / 書籤 / 最近 / 搜尋 / 篩選 / prompt）要「退回上一層」，
     * 不是關掉整個視窗。
     *
     * ⚠️ 這裡的 scope 註冊**不是**保證正確的那一條，只是把 Esc 導向同一個入口。
     *    真正讓它可靠的是 close() 的攔截（見那支的長註解）—— 因為誰先拿到 Escape
     *    取決於 listener 註冊順序，而那不是我們能控制或觀測的，賭了兩輪都輸。
     */
    try {
      /*
       * Modal 建構時自己就註冊了 Escape → close()。先把 scope 裡既有的 Escape 拔掉
       * 再放自己的 —— keys 是內部欄位，屬性名一旦改掉這段就靜默失效，所以只當保險，
       * 不當主力（主力是 close() 的攔截）。
       */
      if (Array.isArray(this.scope.keys)) {
        this.scope.keys = this.scope.keys.filter((k) => !k || k.key !== "Escape");
      }
      this.scope.register([], "Escape", (evt) => {
        this.onEscape(evt);
        return false;
      });
    } catch (e) {
      console.error("[yazi-explorer] could not register the Escape scope (the capture listener still covers it)", e);
    }

    // 欄位名不能叫 doc / win —— Modal 有同名唯讀 getter（見檔頭）
    this.hostDoc = this.containerEl.ownerDocument;
    this.hostWin = this.hostDoc.defaultView || window;
    this.onKey = (ev) => this.handleKey(ev);
    /*
    /*
     * 掛 **window** 的 capture 而不是 document：capture 階段是 window → document → …，
     * 掛在最外層就一定早於任何 document listener，其他插件（如
     * sidebar-keyboard-navigation）比較不容易先把鍵吃掉。
     *
     * ⚠️ 但**不要**再指望這條順序能解決 Esc。2026-09-16 試過「搶先收到 Escape」
     *    兩種版本（scope 後註冊者優先、listener 從 document 搬到 window），都沒修好，
     *    因為 Obsidian 自己的 keymap 掛在哪、什麼時候註冊，我們既不能控制也看不到。
     *    Esc 的正解在 close() 的攔截，見那支的註解。
     *
     * 順帶一提這不影響輸入列打字：stopPropagation 只擋事件傳遞，不取消預設動作，
     * 字照樣進得了 input（要擋那個得 preventDefault，而那些分支刻意沒呼叫）。
     */
    this.hostWin.addEventListener("keydown", this.onKey, true);

    /*
     * 滾輪轉給預覽欄（見 handleWheel）。掛在 contentEl 而不是 window：modal 以外
     * 的地方（背後的編輯區）不該被影響。passive:false 是必要的 —— 要 preventDefault
     * 擋掉原生的「捲游標底下那一欄」，瀏覽器預設會把 wheel 當 passive。
     */
    this.onWheel = (ev) => this.handleWheel(ev);
    this.contentEl.addEventListener("wheel", this.onWheel, { passive: false });

    // vault 一變動就重畫：涵蓋自己做的新增/更名/刪除，也涵蓋 obsidian-git
    // 在背景同步進來的變動 —— 不然畫面會停在舊的樹上。
    this.vaultRefs = ["create", "delete", "rename"].map((evt) =>
      this.app.vault.on(evt, () => this.render())
    );

    /*
     * 開場停的那一層是**最底層**：用 ,b / ,gv 直接開進書籤或檢視清單時，下面沒有
     * 東西可退，Esc 就該關掉整個視窗。所以這段期間不推層（見 pushLayer）。
     */
    this.opening = true;
    try {
      this.openInitialView();
    } finally {
      this.opening = false;
    }
  }

  openInitialView() {
    if (this.initialView === "search-text") this.openSearch("text");
    else if (this.initialView === "search-file") this.openSearch("file");
    else if (this.initialView === "search-dir") this.openSearch("dir");
    // 大綱與關聯要有「游標所指的檔」才成立 —— 從命令進來時那就是目前開著的檔。
    // 開不成（沒開檔、開的不是 md）就留在檔案檢視，openOutline 自己會說明原因。
    else if (this.initialView === "outline") this.openOutline();
    else if (this.initialView === "relations") this.openRelations();
    else if (this.initialView && this.initialView !== "files") this.openList(this.initialView);
    else this.render();
  }

  onClose() {
    try {
      (this.hostWin || window).removeEventListener("keydown", this.onKey, true);
    } catch (e) {}
    try {
      if (this.onWheel) this.contentEl.removeEventListener("wheel", this.onWheel);
    } catch (e) {}
    if (this.vaultRefs) {
      for (const ref of this.vaultRefs) this.app.vault.offref(ref);
      this.vaultRefs = null;
    }
    // 節流中的重算要取消：視窗都關了還觸發 render()，畫的是已經拆掉的 DOM
    if (this.searchTimer) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.previewTimer) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    // 渲染預覽掛著的 Component 一定要 unload，否則圖片／內嵌的 post-processor
    // 會跟著整個 modal 一起留在記憶體裡
    this.disposePreviewMd();
    this.contentEl.empty();
  }

  /* ── 檔案樹資料 ── */

  // 資料夾在前、再按名稱排。用 zh-Hant 的 collator，中文檔名才不是照 code point 排。
  // 排序設定放在 plugin 上並寫進 data.json —— 每次開瀏覽器都要重選會很煩
  sortCfg() {
    const d = this.plugin && this.plugin.data;
    return (d && d.sort) || { field: "name", reverse: false, foldersFirst: true };
  }

  entries(folder) {
    if (!folder || !folder.children) return [];
    const cfg = this.sortCfg();
    // 檔案樹的「自然順序」就是名稱序 —— 資料夾本身沒有別的天然排法
    const eff = cfg.field === "natural" ? { field: "name", reverse: cfg.reverse, foldersFirst: cfg.foldersFirst } : cfg;
    return sortFiles(folder.children, eff);
  }

  // 篩選只作用在「當前這一層」，父層欄不受影響
  mainList() {
    const list = this.entries(this.cwd);
    if (!this.filter) return list;
    const q = this.filter.toLowerCase();
    return list.filter((f) => f.name.toLowerCase().includes(q));
  }

  cursorIndex() {
    const list = this.mainList();
    if (!list.length) return -1;
    const i = list.findIndex((f) => f.path === this.cursorPath);
    return i < 0 ? 0 : i;
  }

  current() {
    const list = this.mainList();
    const i = this.cursorIndex();
    return i < 0 ? null : list[i];
  }

  setCursor(i) {
    const list = this.mainList();
    if (!list.length) {
      this.cursorPath = null;
      return;
    }
    this.cursorPath = list[Math.max(0, Math.min(i, list.length - 1))].path;
  }

  /* ── 移動 ── */

  /*
   * 游標要移到第幾個。**單步（j/k、方向鍵）會循環**：最後一個按 j 回到第一個、
   * 第一個按 k 跳到最後一個 —— 短清單裡「回到開頭」比按 gg 快，長清單裡則是
   * 「我要看最後那幾個」最快的路。
   *
   * 兩個刻意不循環的情況：
   *   1. d / u 的半頁：那是「往這個方向掃過去」，從另一頭接回來只會讓人不知道
   *      自己捲到哪裡了（vim 的 ^D/^U 也是撞到邊就停）。
   *   2. visual 模式：選取是「從錨點到游標」的一段，一旦繞過頭，那一段會整個
   *      翻到另一邊 —— 看起來就像選取突然全反了（vim 的 visual 同樣不繞）。
   */
  nextIndex(i, delta, n) {
    const clamp = Math.max(0, Math.min(i + delta, n - 1));
    if (Math.abs(delta) !== 1 || this.visual || n < 2) return clamp;
    return (i + delta + n) % n;
  }

  move(delta) {
    if (this.view !== "files") {
      if (!this.listItems.length) return;
      this.listIndex = this.nextIndex(this.listIndex, delta, this.listItems.length);
      this.applyVisual();   // v / V 進行中：移動就是在拉選取範圍（同檔案檢視）
      this.render();
      return;
    }
    const i = this.cursorIndex();
    if (i < 0) return;
    this.setCursor(this.nextIndex(i, delta, this.mainList().length));
    this.applyVisual();   // visual 模式：移到哪就選（或取消選）到哪
    this.render();
  }

  goEdge(toEnd) {
    if (this.view !== "files") {
      this.listIndex = toEnd ? Math.max(0, this.listItems.length - 1) : 0;
      this.applyVisual();
    } else {
      this.setCursor(toEnd ? this.mainList().length - 1 : 0);
      this.applyVisual();
    }
    this.render();
  }

  goParent() {
    /*
     * 從清單跳進來的那個資料夾是這趟的起點：站在起點按 h 是退回那份清單，
     * 不是上一層資料夾。從書籤跳進「100 工作」再按 h，要回書籤，不是回 vault 根。
     * 走回 vault 根也一樣 —— 有上一層就退層，沒有才說「已經在根目錄」。
     */
    if (this.layers.length && this.landing && this.cwd && this.cwd.path === this.landing) {
      this.popLayer();
      return;
    }
    const parent = this.cwd.parent;
    if (!parent) {
      if (this.layers.length) {
        this.popLayer();
        return;
      }
      new Notice(this.t("notice.atVaultRoot", "Already at the vault root"));
      return;
    }
    this.memo.set(this.cwd.path, this.cursorPath);
    const from = this.cwd;
    this.cwd = parent;
    this.filter = "";
    this.cursorPath = from.path;   // 游標停在剛離開的那個資料夾上
    this.render();
  }

  // 切換到某個資料夾，游標優先回到上次停的位置
  gotoFolder(folder) {
    this.memo.set(this.cwd.path, this.cursorPath);
    if (this.plugin) this.plugin.bumpFrecency(folder.path);   // z 的資料來源
    this.cwd = folder;
    this.filter = "";
    const remembered = this.memo.get(folder.path);
    const list = this.mainList();
    this.cursorPath =
      remembered && list.some((f) => f.path === remembered)
        ? remembered
        : (list[0] ? list[0].path : null);
  }

  // 把游標定位到某個路徑（資料夾 → 進去；檔案 → 進它的資料夾並選中它）
  revealPath(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f) {
      new Notice(this.t("notice.pathGone", "Path no longer exists: {path}", { path }));
      return false;
    }
    if (isFolder(f)) {
      this.gotoFolder(f);
    } else {
      this.memo.set(this.cwd.path, this.cursorPath);
      this.cwd = f.parent || this.app.vault.getRoot();
      this.filter = "";
      this.cursorPath = f.path;
    }
    this.view = "files";
    this.render();
    return true;
  }

  enter(mode) {
    const cur = this.current();
    if (!cur) return;
    if (isFolder(cur)) {
      this.gotoFolder(cur);
      this.render();
      return;
    }
    this.openFile(cur, mode);
  }

  /*
   * line：開檔後把編輯器定位到那一行（大綱檢視的 Enter）。走 OpenViewState 的 eState，
   * 跟 Obsidian 自己的大綱面板／搜尋結果跳行用的是同一條路。
   */
  openFile(file, mode, line) {
    const ws = this.app.workspace;
    const state = typeof line === "number" ? { eState: { line } } : {};

    // gf：背景開新分頁。不搶焦點、也不關 modal —— 這顆鍵的用途就是「先把幾個檔
    // 開起來待會看」，關掉 modal 反而毀了這個流程。
    if (mode === "tab-bg") {
      const prev = ws.getMostRecentLeaf(ws.rootSplit);
      const leaf = ws.getLeaf("tab");
      leaf.openFile(file, Object.assign({ active: false }, state)).then(() => {
        // 把「最近使用的分頁」還原回原本那個。不還原的話，接下來按 o 會開在剛剛
        // 背景開的那個分頁上，等於把它蓋掉 —— 連開多個檔就失效了。
        if (prev) ws.setActiveLeaf(prev, { focus: false });
      });
      new Notice(this.t("notice.openedBackground", "Opened in a background tab: {name}", { name: file.name }));
      return;
    }

    let leaf;
    if (mode === "tab") leaf = ws.getLeaf("tab");
    else if (mode === "vsplit") leaf = ws.getLeaf("split", "vertical");
    else if (mode === "hsplit") leaf = ws.getLeaf("split", "horizontal");
    else leaf = ws.getLeaf(false);
    this.close();
    leaf.openFile(file, state).then(() => ws.setActiveLeaf(leaf, { focus: true }));
  }

  /* ── 清單檢視（分頁 / 書籤 / 最近）── */

  /*
   * 開一份清單檢視。預設會把目前這一層推進堆疊（Esc 退得回來）。
   * opts.skipPush ＝呼叫端自己 push 過了（openOutline / openRelations 要在改狀態
   * **之前**就 push，否則快照裡的 outlineFile / relFile 已經是新的了）。
   */
  openList(view, opts) {
    if (!(opts && opts.skipPush)) this.pushLayer();
    // 清單檢視沒有組合卡與建議列 —— 留著會蓋掉左欄的按鍵圖例（看起來像跑版）
    this.composing = false;
    this.sug = null;
    this.sugField = null;
    this.view = view;
    this.listIndex = 0;
    this.showHelp = false;
    this.resetListSelection();
    this.buildList();
    this.render();
  }

  /* ── 全域模糊搜尋（gt 檔案 / gd 資料夾）── */

  openSearch(kind) {
    this.pushLayer();          // Esc 從搜尋退回原本在看的東西
    this.view = "search";
    this.searchKind = kind;
    this.mode = "search";
    this.listIndex = 0;
    this.showHelp = false;
    this.indexing = false;
    /*
     * 三種搜尋都用組合卡。gd（找資料夾）的差別只在「有哪些條件可用」——
     * 資料夾沒有 frontmatter 也沒有標籤，所以它的條件選單只剩「範圍」一項
     * （見 buildSuggest）。**範圍對 gd 一樣有意義**，所以不該為此做成兩套 UI。
     */
    this.composing = true;
    /*
     * 範圍預設＝現在人在哪個資料夾。vault 根目錄視同全 vault。
     *
     * ⚠️ gd 例外：它**完全不用**條件系統，連範圍都不要。
     *    在「找資料夾」的畫面上叫你「加一個資料夾條件」是自相矛盾的 ——
     *    資料夾就是搜尋目標本身，不是用來限定目標的軸。
     *    而且 gd 的比對本來就吃整個路徑（見 buildSearchListRaw 的註解），
     *    打 `Personal 日記` 就縮得到範圍，再疊一層範圍只是多一個要操作的東西。
     */
    const dir = kind === "dir";
    this.searchOrigin = !dir && this.cwd && this.cwd.path && this.cwd.path !== "/" ? this.cwd.path : "";
    this.scopePath = this.searchOrigin;
    // 每次重新開搜尋都是乾淨的一次：條件不跨 gt/gf/gd 留著（留著只會變成看不見的過濾）
    this.facets = [];
    this.sug = null;
    this.sugField = null;
    this.fvCache = null;
    this.folderCountCache = null;
    const label = kind === "dir" ? this.t("ui.searchFolder", "Folder: ")
      : kind === "text" ? this.t("ui.searchText", "Full text: ")
      : this.t("ui.searchFile", "File name: ");
    this.inputLabelEl.setText(label);
    this.inputEl.value = "";
    this.inputWrapEl.show();
    this.inputEl.focus();

    // 全文索引第一次用到才建；建的期間畫面已經切過去並標示進度（見 ensureIndex）
    if (this.ensureIndex(kind)) return;

    this.buildSearchList();
    this.render();
  }

  /*
   * 全文索引第一次用到才建。建的時候先把畫面切過去並標示進度，不要讓人對著空白等
   * —— 幾千個檔第一次讀進來要一兩秒。
   *
   * 回傳 true ＝「已經接手了」：畫面畫過了、結果會在索引好之後補上，呼叫端不要再畫一次。
   * openSearch 與 runView（儲存的檢視）共用這條路，否則從檢視開全文搜尋會是一片空白。
   */
  ensureIndex(kind) {
    if (kind !== "text" || !this.plugin || this.plugin.textIndex) return false;
    this.indexing = true;
    this.render();
    this.plugin.ensureTextIndex().then(
      () => {
        const st = this.plugin.textIndexStats;
        if (st) {
          const how = st.fromCache
            ? this.t("notice.indexCached", "loaded {loaded} from cache, re-read {reread}", { loaded: st.loaded, reread: st.reread })
            : this.t("notice.indexFirst", "built {files} entries", { files: st.files });
          new Notice(
            this.t("notice.indexDone", "Full-text index: {how} · {files} files, {sec}s",
          { how, files: st.files, sec: (st.ms / 1000).toFixed(1) })
          );
        }
        if (this.view !== "search" || this.searchKind !== "text") return;
        this.indexing = false;
        this.buildSearchList();
        this.render();
      },
      (e) => {
        this.indexing = false;
        new Notice(this.t("notice.indexFailed", "Could not build the full-text index: {error}", { error: msg(e) }));
        this.render();
      }
    );
    return true;
  }

  /*
   * 全文搜尋（gt）。在 plugin 上維護一份「路徑 → 內容」的記憶體索引，所以敲鍵時
   * 是純字串比對，不必每次都重讀幾千個檔。索引第一次用到才建，之後靠 vault 事件
   * 維持新鮮（見 plugin 的 registerIndexEvents）。
   *
   * 多個字以空白分隔，全部命中才算（AND）。檔名也命中的排前面 —— 標題含關鍵字
   * 的通常就是要找的那篇。
   */
  // 全文索引裡有幾個檔在目前範圍內（給「全部 → 現在」的分母用）
  textScopeTotal() {
    const idx = this.plugin && this.plugin.textIndex;
    if (!idx) return 0;
    if (!this.scopePath) return idx.size;
    const pre = this.scopePath + "/";
    let n = 0;
    for (const path of idx.keys()) if (path === this.scopePath || path.startsWith(pre)) n++;
    return n;
  }

  searchTextList(q) {
    const idx = this.plugin && this.plugin.textIndex;
    if (!idx) return [];
    this.searchTotal = this.textScopeTotal();
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    // 沒有關鍵字但有範圍或條件時照樣要給結果（例：只掛「🔴 P0」想看所有 P0）
    if (!tokens.length && !this.facets.length && !this.scopePath) return [];
    const hits = [];
    const pre = this.scopePath ? this.scopePath + "/" : "";
    for (const [path, content] of idx) {
      // 範圍先篩：字串前綴比對比內容掃描便宜得多
      if (pre && path !== this.scopePath && !path.startsWith(pre)) continue;
      const lower = content.toLowerCase();
      let ok = true;
      let first = Infinity;
      for (const t of tokens) {
        const i = lower.indexOf(t);
        if (i < 0) { ok = false; break; }
        if (i < first) first = i;
      }
      if (!ok) continue;
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!f) continue;
      // 條件在評分之前先濾掉，這樣 SEARCH_LIMIT 不會被不合條件的結果佔滿
      if (this.facets.length && !this.passFacets(f, content)) continue;
      if (!tokens.length) { hits.push({ f, content, lower, tokens, first: 0, score: 0 }); continue; }
      const nameHit = tokens.every((t) => f.name.toLowerCase().includes(t));
      hits.push({ f, content, lower, tokens, first, score: (nameHit ? 1e9 : 0) - first });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, SEARCH_LIMIT).map((h) => ({
      label: h.f.name,
      sub: h.f.path,
      path: h.f.path,
      file: h.f,
      content: h.content,
      tokens: h.tokens,
      ctx: contextLines(h.content, h.lower, h.tokens),
    }));
  }

  buildSearchListRaw() {
    const q = (this.searchQuery || "").trim();
    const hasFacets = this.facets.length > 0;

    if (this.searchKind === "text") {
      // 索引還沒建好時不要給空清單，那會看起來像「搜不到」
      if (!this.plugin || !this.plugin.textIndex) {
        this.listItems = [];
        this.searchTotal = 0;
        return;
      }
      // 沒進 searchTextList 的路徑也要有總數，否則計數會顯示上一次的殘值
      this.searchTotal = this.textScopeTotal();
      this.listItems = q || hasFacets || this.scopePath ? this.searchTextList(q) : [];
      return;
    }

    const dirs = this.searchKind === "dir";
    // getFiles() 只回 TFile；資料夾要從 getAllLoadedFiles() 濾
    const all = dirs
      ? this.app.vault.getAllLoadedFiles().filter(isFolder)
      : this.app.vault.getFiles();
    // 範圍先篩（路徑比對最便宜），再套條件，最後才做關鍵字比對 ——
    // 反過來的話 SEARCH_LIMIT 會被不合條件的結果佔滿
    const scoped = this.scopePath ? all.filter((f) => this.inScope(f)) : all;
    // 「全部」＝範圍內的全部，這樣 2378 → 4 那個比例才是在講條件做了什麼
    this.searchTotal = scoped.length;
    const pool = hasFacets ? scoped.filter((f) => this.passFacets(f)) : scoped;

    const byPath = (list) =>
      list
        .slice()
        .sort((a, b) => COLLATOR.compare(a.path, b.path))
        .slice(0, SEARCH_LIMIT)
        .map((f) => this.searchItem(f));

    if (!q) {
      /*
       * 空關鍵字的預設值：
       *   有範圍或條件 → 直接列出通過的（「限定這個資料夾就看到底下全部」要成立）
       *   都沒有 → 檔案給最近開啟過的、資料夾給全部；空畫面沒有任何用處
       */
      this.listItems = hasFacets || dirs || this.scopePath ? byPath(pool) : this.collectRecent();
      return;
    }

    // 比對整個 path 而不是只有檔名 —— 這樣才能用資料夾片段縮小範圍
    // （例如打 "客製 analysis 盲區"），跟 Quick Switcher 的行為一致。
    const match = makeMatcher(q);
    const scored = [];
    for (const f of pool) {
      let best = match(f.path);
      let via = null;
      /*
       * frontmatter 的 aliases 也算命中，取最高分那個當代表。日記檔名是日期、靠標題
       * 才記得的那種筆記，別名往往才是人腦裡的名字 —— 只比路徑會找不到。
       */
      for (const a of this.fileAliases(f)) {
        const r = match(a);
        if (r && (!best || r.score > best.score)) {
          best = r;
          via = a;
        }
      }
      if (best) scored.push({ f, score: best.score, via });
    }
    scored.sort((a, b) => b.score - a.score);
    this.listItems = scored.slice(0, SEARCH_LIMIT).map(({ f, via }) => this.searchItem(f, via));
  }

  // 靠別名命中的列別名、路徑放小字 —— 跟 Quick Switcher 一樣，看得出「這筆為什麼會出現」
  searchItem(f, via) {
    return {
      label: via || f.name || this.t("ui.vaultRoot", "(vault root)"),
      sub: f.path,
      path: f.path,
      file: isFolder(f) ? null : f,
    };
  }

  fileAliases(f) {
    if (!f || isFolder(f) || (f.extension || "").toLowerCase() !== "md") return [];
    const c = this.app.metadataCache.getFileCache(f);
    return aliasesOf(c && c.frontmatter);
  }

  /* ── 搜尋條件（facet）—— 設計說明見上方 FACETS 常數 ────────────────── */

  /*
   * 某個欄位在 vault 裡實際出現過哪些值，各幾筆。
   * 一次開啟期間只算一次（modal 是短命的，中途 vault 不太會變）——不快取的話
   * 每敲一個字要掃全 vault 七次，打字就會卡。
   */
  // 這個檔案／資料夾在目前的搜尋範圍裡嗎
  inScope(f) {
    if (!this.scopePath) return true;
    return f.path === this.scopePath || f.path.startsWith(this.scopePath + "/");
  }

  // 每個資料夾底下（含子孫）有幾個檔案。一次開啟算一次
  folderCounts() {
    if (this.folderCountCache) return this.folderCountCache;
    const m = new Map();
    for (const f of this.app.vault.getFiles()) {
      let p = f.parent;
      while (p && p.path && p.path !== "/") {
        m.set(p.path, (m.get(p.path) || 0) + 1);
        p = p.parent;
      }
    }
    this.folderCountCache = m;
    return m;
  }

  /*
   * 範圍的候選，順序就是人實際在想的順序：
   *   🌐 全 vault → 往上的每一層 → 搜尋起點 → 起點底下的每一層 → 其他資料夾
   * 前四段是一條「由寬到窄」的階梯，不必打字就整條看得完，要放寬或收窄都在同一個清單裡。
   * 「其他資料夾」墊在最後，保留「跳去完全別的地方」這條路，但不佔前排。
   */
  scopeChoices() {
    const counts = this.folderCounts();
    const out = [{ value: "", count: this.app.vault.getFiles().length, note: this.t("ui.wholeVault", "whole vault") }];
    const seen = new Set([""]);
    const origin = this.searchOrigin;

    if (origin) {
      const parts = origin.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        if (seen.has(p)) continue;
        seen.add(p);
        out.push({ value: p, count: counts.get(p) || 0, note: this.t(p === origin ? "ui.searchOrigin" : "ui.above") });
      }
      const root = this.app.vault.getAbstractFileByPath(origin);
      // 廣度優先：深度優先會把第一個子資料夾的整棵子樹排在它的同層兄弟前面
      const queue = root && root.children ? root.children.filter(isFolder) : [];
      while (queue.length) {
        const d = queue.shift();
        if (!seen.has(d.path)) {
          seen.add(d.path);
          out.push({ value: d.path, count: counts.get(d.path) || 0, note: this.t("ui.below", "below") });
        }
        for (const c of d.children.filter(isFolder)) queue.push(c);
      }
    }

    const rest = [];
    for (const [p, n] of counts) if (!seen.has(p)) rest.push({ value: p, count: n, note: "" });
    rest.sort((a, b) => b.count - a.count || COLLATOR.compare(a.value, b.value));
    return out.concat(rest);
  }

  facetValues(id) {
    const spec = FACET_BY_ID[id];
    if (spec.kind === "path") return this.scopeChoices();

    /*
     * 快取的 key 一定要帶範圍：換了範圍就是另一組候選值。
     * 而候選值跟著範圍收窄不只是少點噪音 —— 範圍外的標籤選下去必定 0 筆，
     * 建議一個保證失敗的操作是 bug。順帶的好處是份數真的能預測結果筆數。
     */
    const key = id + "|" + this.scopePath;
    if (!this.fvCache) this.fvCache = {};
    if (this.fvCache[key]) return this.fvCache[key];

    const counts = new Map();
    const bump = (v) => {
      if (v == null) return;
      const s = String(v).trim();
      if (s) counts.set(s, (counts.get(s) || 0) + 1);
    };

    if (spec.kind === "ext") {
      for (const f of this.app.vault.getFiles()) if (this.inScope(f)) bump(f.extension);
    } else if (spec.kind === "tag") {
      for (const f of this.app.vault.getMarkdownFiles()) {
        if (this.inScope(f)) for (const t of fileTags(this.app, f)) bump(t);
      }
    } else if (spec.kind === "fm") {
      for (const f of this.app.vault.getMarkdownFiles()) {
        if (!this.inScope(f)) continue;
        const c = this.app.metadataCache.getFileCache(f);
        if (c && c.frontmatter) bump(c.frontmatter[spec.field]);
      }
    }

    const out = [];
    for (const [value, count] of counts) out.push({ value: value, count: count });
    out.sort((a, b) => b.count - a.count || COLLATOR.compare(a.value, b.value));
    this.fvCache[key] = out;
    return out;
  }

  // 輸入列游標前的最後一個詞 —— 建議是針對「正在打的這個詞」，不是整串
  currentToken() {
    const v = this.inputEl ? this.inputEl.value : "";
    const m = /(\S*)$/.exec(v);
    return m ? m[1] : "";
  }

  // 把正在打的那個詞換掉（選中建議之後要把它從輸入列拿走）
  replaceToken(text) {
    if (!this.inputEl) return;
    this.inputEl.value = this.inputEl.value.replace(/(\S*)$/, text);
    this.searchQuery = this.inputEl.value;
  }

  /*
   * 建議清單。兩種狀態：
   *   sugField 有值 → 正在挑那個欄位的值
   *   sugField 沒值 → 同時建議「欄位」與「值」
   * 後者是這套 UI 的核心：你打 `p0` 不必先知道有「優先度」這個欄位，
   * 建議會直接給你「🔴 優先度 = P0 Urgent」。
   */
  buildSuggest(token) {
    // gd 沒有任何條件（理由見 openSearch）——連建議列都不該出現
    if (this.searchKind === "dir") return [];
    const q = (token || "").toLowerCase();
    const out = [];

    if (this.sugField) {
      const spec = FACET_BY_ID[this.sugField];
      if (spec.kind === "free") {
        // 排除／正則沒有候選值，打什麼就是什麼；正則另外當場驗語法
        const bad = spec.id === "regex" && token ? regexError(token) : "";
        return [{
          type: "value",
          spec: spec,
          value: token,
          note: bad ? "⚠️ " + bad : token ? "" : this.t("ui.typeToFilter", "(type, then Enter)"),
          bad: !!bad,
        }];
      }
      for (const v of this.facetValues(this.sugField)) {
        // note 也拿來比對，這樣打「全」或「vault」找得到「🌐 全 vault」（它的 value 是空字串）
        if (q && !(v.value + " " + (v.note || "")).toLowerCase().includes(q)) continue;
        out.push({ type: "value", spec: spec, value: v.value, count: v.count, note: v.note });
        if (out.length >= SUGGEST_LIMIT) break;
      }
      return out;
    }

    /*
     * 欄位：沒打字時全列（Tab 叫出來的就是這個），打了字就用名稱／直接鍵比對。
     * gd 是在找資料夾 —— 資料夾沒有 frontmatter 也沒有標籤，只有「範圍」講得通，
     * 所以它的選單只剩那一項（而不是為 gd 另做一套 UI）。
     */
    const fields = this.searchKind === "dir" ? FACETS.filter((s) => s.kind === "path") : FACETS;
    for (const spec of fields) {
      if (q && !(spec.label.toLowerCase().includes(q) || spec.id.startsWith(q) || spec.key === q)) continue;
      /*
       * 目前範圍底下根本沒有這個欄位的值就不要列 —— 選進去只會看到空清單。
       * 例：在 `200 Personal` 底下搜尋時，優先度／狀態／分類全部不該出現。
       * 範圍與自由輸入（排除／正則）永遠有意義，不受此限。
       */
      if (spec.kind !== "path" && spec.kind !== "free" && !this.facetValues(spec.id).length) continue;
      out.push({ type: "field", spec: spec });
    }

    // 值：跨所有欄位找「打的這個詞剛好是某個值」——這一段才是「不必先知道欄位」
    if (q) {
      if (this.searchKind !== "dir") {
        for (const spec of FACETS) {
          if (spec.kind === "free" || spec.kind === "path") continue;
          for (const v of this.facetValues(spec.id)) {
            if (!v.value.toLowerCase().includes(q)) continue;
            out.push({ type: "value", spec: spec, value: v.value, count: v.count });
          }
        }
      }
      /*
       * 資料夾另外處理：它是最常用的條件，但候選有幾百個，跟其他欄位一起無上限倒出來
       * 會把建議列洗掉。所以要求至少兩個字，而且只給前三名 —— scopeChoices() 是
       * 由寬到窄排好的，所以前三名天然會是「全 vault / 上層 / 搜尋起點」那一段。
       */
      if (q.length >= 2) {
        const spec = FACET_BY_ID.scope;
        let n = 0;
        for (const v of this.scopeChoices()) {
          if (!(v.value + " " + (v.note || "")).toLowerCase().includes(q)) continue;
          out.push({ type: "value", spec: spec, value: v.value, count: v.count, note: v.note });
          if (++n >= 3) break;
        }
      }
      // 命中越前面的排越前（打 `p0` 時 `P0 Urgent` 要贏過 `...p0...`）
      out.sort((a, b) => {
        if (a.type !== b.type) return a.type === "value" ? -1 : 1;
        if (a.type === "field") return 0;
        const ai = a.value.toLowerCase().indexOf(q);
        const bi = b.value.toLowerCase().indexOf(q);
        return ai - bi || b.count - a.count;
      });
    }
    return out.slice(0, SUGGEST_LIMIT);
  }

  /*
   * open = 使用者「主動」叫出來的（Tab 或 ^鍵），不是打字順便冒出來的。
   *
   * ⚠️ 這個分別就是 active 這個旗標的全部意義，而它修的是一個真的發生過的 bug：
   * 第一版只要 this.sug 存在，Enter 就先拿去收建議 —— 但建議在你每打一個字時
   * 都會自動冒出來，所以「打完字按 Enter 送出」會**被建議吃掉**，變成收下一個
   * 你沒要的條件（在 gd 就表現成「清單突然變成某個資料夾底下的東西」），
   * 要按第二次 Enter 才真的送出。
   *
   * 正確的模型是瀏覽器網址列那套：自動冒出來的建議**不搶鍵**，
   * 除非你用 ↑↓ 選進去、或用 Tab 明講。挑值模式（sugField）例外 ——
   * 那是你自己按 ^p 進來的，清單本來就該接管方向鍵與 Enter。
   */
  refreshSuggest(open) {
    const token = this.currentToken();
    // 沒在打字又沒主動叫出來時不要一直冒建議
    if (!open && !token && !this.sugField) {
      this.sug = null;
      return;
    }
    const items = this.buildSuggest(token);
    this.sug = items.length ? { items: items, index: 0, active: !!open || !!this.sugField } : null;
  }

  moveSuggest(d) {
    if (!this.sug) return;
    const n = this.sug.items.length;
    if (!this.sug.active) {
      // 還沒選進去：第一次按方向鍵＝選中第一個（↑ 則是最後一個），不要跳過它
      this.sug.active = true;
      this.sug.index = d > 0 ? 0 : n - 1;
    } else {
      this.sug.index = (this.sug.index + d + n) % n;
    }
    this.render();
  }

  /* Tab / Enter 選中建議：欄位 → 進入挑值；值 → 變成一顆 chip */
  acceptSuggest() {
    if (!this.sug) return false;
    const it = this.sug.items[this.sug.index];
    if (!it) return false;
    if (it.type === "field") {
      this.sugField = it.spec.id;
      this.replaceToken("");
      this.refreshSuggest(true);
      this.render();
      return true;
    }
    if (it.bad) return true; // 正則寫壞了：留在原地讓人改，不要默默收下
    /*
     * ⚠️ 空字串對「範圍」是合法值（＝全 vault），對其他欄位才是「沒東西可收」。
     * 一律用 !it.value 擋的話，🌐 全 vault 會變成按 Enter 沒反應。
     */
    if (!it.value && it.spec.kind !== "path") return true;
    this.addFacet(it.spec.id, it.value);
    return true;
  }

  addFacet(id, value) {
    if (id === "scope") {
      /*
       * 範圍是「換」不是「加」：同時限定兩個資料夾等於什麼都搜不到。
       * 換完要把候選值快取清掉 —— 新範圍底下有哪些標籤／狀態是另一組答案。
       */
      this.scopePath = value;
      this.fvCache = null;
    } else if (!this.facets.some((f) => f.id === id && f.value === value)) {
      // 其他條件：同欄位同值不重複加；不同值則是再收窄一層（AND）
      this.facets.push({ id: id, value: value });
    }
    this.sugField = null;
    this.replaceToken("");
    this.sug = null;
    this.listIndex = 0;
    this.buildSearchList();
    this.render();
  }

  removeLastFacet() {
    if (this.sugField) {
      // 先退出「正在挑值」，再退 chip —— 一層一層來
      this.sugField = null;
      this.refreshSuggest(false);
      this.render();
      return true;
    }
    if (!this.facets.length) return false;
    this.facets.pop();
    this.listIndex = 0;
    this.buildSearchList();
    this.render();
    return true;
  }

  /*
   * 這個檔案／資料夾通過所有條件嗎。content 有給的話，排除與正則改比對內文
   * （全文搜尋時人想排除的是內文裡的字，不是路徑裡的）。
   */
  passFacets(f, content) {
    for (const fc of this.facets) {
      const spec = FACET_BY_ID[fc.id];
      if (!spec) continue;
      // 範圍不走這裡 —— 它存在 this.scopePath，在取 pool 的時候就先篩掉了（inScope）
      if (spec.kind === "ext") {
        if ((f.extension || "") !== fc.value) return false;
      } else if (spec.kind === "tag") {
        if (fileTags(this.app, f).indexOf(fc.value) < 0) return false;
      } else if (spec.kind === "fm") {
        const c = this.app.metadataCache.getFileCache(f);
        const fm = c && c.frontmatter;
        if (!fm || String(fm[spec.field] == null ? "" : fm[spec.field]).trim() !== fc.value) return false;
      } else if (fc.id === "exclude") {
        const hay = (content == null ? f.path : content).toLowerCase();
        if (hay.indexOf(fc.value.toLowerCase()) >= 0) return false;
      } else if (fc.id === "regex") {
        const re = safeRegex(fc.value);
        if (!re) continue; // 寫壞的正則當作沒這條，不要讓整個清單變空
        if (!re.test(content == null ? f.path : content)) return false;
      }
    }
    return true;
  }

  facetLabel(fc) {
    const spec = FACET_BY_ID[fc.id] || { icon: "?", label: fc.id };
    const v = spec.kind === "path" ? shortPath(fc.value) : fc.value;
    return spec.icon + " " + v;
  }

  /*
   * Enter：預設是「跳過去」而不是「開啟」—— yazi 的 fzf 也是移游標。
   * 跳完之後人就回到一般檔案檢視，o / t / gf / m 這些鍵全都還能用，
   * 比直接開檔留下更多選擇。Ctrl+Enter 才是直接開。
   */
  commitSearch(openDirectly) {
    const item = this.listCurrent();
    if (!item) return;
    const f = this.app.vault.getAbstractFileByPath(item.path);
    if (!f) {
      new Notice(this.t("notice.pathGone", "Path no longer exists: {path}", { path: item.path }));
      return;
    }
    this.endInput();
    // 從搜尋結果跳進 vault ＝又一層：Esc 要退得回這份結果，不是一路關掉
    this.pushLayer();
    this.listItems = [];
    if (isFolder(f)) {
      this.gotoFolder(f);
      this.toFilesView();
      return;
    }
    if (openDirectly) {
      this.view = "files";
      this.openFile(f, "current");
      return;
    }
    this.revealPath(f.path);
    this.toFilesView();
  }

  /* ── 層堆疊 ──
   *
   * 規則只有一條：進新的一層之前 pushLayer()，要退就 popLayer()。
   * 「哪一層」包含整個可見狀態（檢視、清單、游標、搜尋條件、所在資料夾），
   * 所以退回去看到的就是離開時的樣子，不是重新算一份近似的。
   */
  snapshot() {
    return {
      view: this.view, listItems: this.listItems, listIndex: this.listIndex, listFilter: this.listFilter,
      relFile: this.relFile, outlineFile: this.outlineFile,
      searchKind: this.searchKind, searchQuery: this.searchQuery,
      facets: (this.facets || []).slice(), scopePath: this.scopePath, searchOrigin: this.searchOrigin,
      composing: this.composing, landing: this.landing,
      cwd: this.cwd, cursorPath: this.cursorPath, filter: this.filter,
    };
  }

  pushLayer() {
    // 開場的初始檢視（,b / ,gv 之類）不算「疊上去的一層」—— 它就是最底層
    if (this.opening) return;
    // 臨時覆蓋層（前綴、建議列、說明頁、確認）屬於離開的這個地方，不帶進下一個、也不存進快照
    this.closeOverlays();
    this.layers.push(this.snapshot());
    if (this.layers.length > LAYER_MAX) this.layers.shift();
  }

  /** 退回上一層。回傳 false ＝沒有上一層了。 */
  popLayer() {
    const s = this.layers.pop();
    if (!s) return false;
    this.editingView = null;   // 離開組合卡（不管是存了還是 Esc）就不再是編輯模式
    this.resetListSelection();  // 快照不帶選取：退回去看到的是那份清單，不是當時選了哪幾列
    const idx = s.listIndex;
    Object.assign(this, s);
    /*
     * 清單重建而不是直接用快照裡那份：離開的這段期間檔案可能被刪、書籤可能被移除。
     * 游標位置在重建之後才還原 —— buildList 會把超出範圍的索引夾回去。
     */
    if (this.view === "search") this.buildSearchList();
    else if (this.view !== "files") this.buildList();
    if (this.listItems.length) this.listIndex = Math.min(idx, this.listItems.length - 1);
    this.render();
    return true;
  }

  /* 切回檔案檢視本身（不動堆疊）。h 在沒有上一層時用這個。 */
  toFilesView() {
    this.resetListSelection();   // 清單的選取屬於那份清單，不跟著人走進 vault
    this.view = "files";
    this.listItems = [];
    // 這裡是「從清單跳進 vault」唯一的落地點：記住站在哪個資料夾（見 landing）
    this.landing = this.cwd ? this.cwd.path : null;
    // 組合卡是搜尋專屬的，回檔案檢視一定要關掉，否則會蓋住整個版面
    this.composing = false;
    this.sug = null;
    this.sugField = null;
    this.render();
  }

  /*
   * h：退回上一個地方。已經是最底層就**留在原地** —— 用 ,b / ,gv 直接開進清單的人
   * 從沒去過檔案檢視，h 憑空變出一個給他等於把他丟到沒要求過的地方。
   * h 是空間導航（往左），不是關窗；要關是 Esc / q 的事。
   */
  goBackLayer() {
    if (this.popLayer()) return;
    new Notice(this.t("notice.atFirstLayer", "Already at the first layer — Esc or q closes"));
  }

  /*
   * Escape 的單一出口：一次退一層，退到最外層才關視窗。
   * 順序就是「最內層先退」——待接的多鍵序列 → 輸入列 → 確認 → 子檢視 → 關閉。
   */
  /*
   * Esc 的全部邏輯就這三步：收最上面的覆蓋層 → 沒有覆蓋層就退一個地方 → 沒有地方就關窗。
   * 哪些東西算覆蓋層、怎麼收，全在 OVERLAYS 那張表；這裡不認識任何一個旗標。
   *
   * 搜尋結果的 Esc 因此就是退層（回到來的地方，或關窗）。要改條件是 i / Tab 回組合卡；
   * 拿掉條件是組合卡裡的 Backspace。曾經試過「結果按 Esc 先回組合卡」，實際用起來是
   * 多一層沒人要求的東西：從 ,gt 打完關鍵字看到結果，Esc 就該離開。
   *
   * 「退一個地方」對檔案檢視也成立 —— 從書籤跳進某個資料夾之後人在檔案檢視，
   * 但下面那層是書籤清單，Esc 該退回那份清單而不是直接關窗。
   */
  escapeBack() {
    const top = OVERLAYS.find((o) => o.open(this));
    if (top) {
      top.close(this);
      if (!top.leaves) this.render();   // leaves 的那種自己會畫（退層或關窗）
      return;
    }
    if (this.popLayer()) return;
    this.forceClose();
  }

  /* 進到新的地方之前收掉臨時覆蓋層（見 OVERLAYS 的 ephemeral） */
  closeOverlays() {
    for (const o of OVERLAYS) if (o.ephemeral && o.open(this)) o.close(this);
  }

  // 「目前這個檢視有沒有選取狀態」——Esc 靠它決定這一下是收狀態還是退一層
  hasSelection() {
    if (this.visual) return true;
    if (this.view !== "files") return !!(this.listSel && this.listSel.size);
    return !!(this.sel && this.sel.size);
  }

  /*
   * 離開一個子檢視（書籤、搜尋結果、大綱…）。
   *   從檔案檢視走進來的 → 退回檔案檢視（那是它下面那一層）
   *   用命令／熱鍵直接開進來的 → 這層就是最底層，直接關掉整個視窗
   * 後者是 ,b / ,gt / ,gv 這種用法的重點：那時候人根本沒打算逛檔案，
   * 退回一個沒要求過的檔案清單等於多按一次 Esc 才走得掉。
   */
  leaveSubView() {
    if (this.popLayer()) return;
    this.forceClose();
  }

  /*
   * Esc 的唯一入口。escapeBack() 不要直接呼叫 —— 一定走這裡。
   *
   * 為什麼要有這層：Esc 可能從**兩條路**同時進來（keydown listener／Modal 內建的
   * scope），而誰先誰後不可控（見 close() 的註解）。把「這次 keydown 已經退過一層了」
   * 記在事件物件本身，兩條路就自動去重 —— 不管誰先跑，同一下 Esc 只退一層。
   * 記在事件上而不是 this 上，是因為事件物件天生就是「這一次按鍵」的唯一身分，
   * 不必自己想 debounce 時間，也不會在連按時誤判。
   */
  onEscape(ev) {
    if (ev) {
      if (ev.__yaziEsc) return;
      ev.__yaziEsc = true;
    }
    this.escapeBack();
  }

  // 真的關閉（繞過下面 close() 的 Esc 攔截）
  forceClose() {
    this.escForce = true;
    try {
      this.close();
    } finally {
      // 萬一 super.close() 沒真的關成（視窗還在），旗標不能留著 ——
      // 留著的話下一次 Esc 就會繞過整個攔截，退化成「一按就關」
      this.escForce = false;
    }
  }

  /*
   * ⚠️ Esc 一律關掉整個瀏覽器的真正解法（2026-09-16 第二輪）。
   *
   * 第一輪的想法是「搶在 Obsidian 之前收到 Escape」：先試 scope 後註冊者優先、
   * 再試把 listener 從 document capture 搬到 window capture。兩次都沒修好 ——
   * 因為 Obsidian 自己的 keymap 掛在哪個節點、哪個階段、什麼時候註冊，全都不是
   * 我們能控制或觀測的，這條路本質上是在賭。
   *
   * 所以改成不賭順序：**攔 close() 本身**。不管 Escape 是先到我們這裡、還是先被
   * Obsidian 翻譯成 close()，只要這一下 close 是 Escape 觸發的、而且還有內層可退，
   * 就改成退一層並且不關視窗。真正要關的時候走 forceClose()。
   *
   * currentEvent() 讀的是 window.event（Chromium 在事件派送期間會設好它）——
   * 拿得到就知道「這個 close 是誰觸發的」，拿不到就退化成原本的行為（照關），
   * 不會比現在更糟。
   */
  close() {
    if (this.escForce) {
      super.close();
      return;
    }
    const ev = this.currentEvent();
    if (ev && ev.type === "keydown" && ev.key === "Escape") {
      if (ev.__yaziEsc) return;   // 這一下已經被內層消化掉了，不要再關
      this.onEscape(ev);
      return;
    }
    super.close();
  }

  currentEvent() {
    try {
      return (this.hostWin || window).event || null;
    } catch (e) {
      return null;
    }
  }

  buildList() {
    this.buildListRaw();
    this.refineList();
  }

  buildSearchList() {
    this.buildSearchListRaw();
    this.refineList();
  }

  /* 實際跑一次重算，順便量成本（下一次靠它決定要不要節流） */
  runSearch() {
    const t0 = Date.now();
    this.buildSearchList();
    this.searchCost = Date.now() - t0;
    this.searchPending = false;
  }

  /*
   * 打字時的重算入口。便宜就當場算（逐鍵即時），貴才排隊。
   * 排隊期間畫面上的筆數與預覽是舊的，所以標成 pending，讓 UI 說實話
   * ——「看起來正常但其實是上一個字的結果」比「明說還在算」糟得多。
   */
  scheduleSearch() {
    if (this.searchTimer) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.searchCost <= SEARCH_SYNC_BUDGET) {
      this.runSearch();
      return;
    }
    this.searchPending = true;
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      this.runSearch();
      this.render();
    }, SEARCH_DEBOUNCE);
  }

  // 送出前一定要先把排隊中的那次算完，否則會拿到上一個字的結果
  flushSearch() {
    if (!this.searchTimer) return;
    window.clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.runSearch();
  }

  /*
   * 清單的二次加工：先套 / 的結果內過濾，再套排序設定。
   * 排序只有在使用者明確選過（field !== "natural"）時才介入 —— 否則搜尋結果的
   * 相關度、最近開啟的時間序、書籤的字母序都會被蓋掉。
   */
  refineList() {
    let arr = this.listItems;
    if (this.listFilter) {
      const q = this.listFilter.toLowerCase();
      arr = arr.filter((it) => ((it.label || "") + " " + (it.sub || "")).toLowerCase().includes(q));
    }
    const cfg = this.sortCfg();
    /*
     * 常用（z）不受全域排序影響。其他清單被排序蓋掉還說得過去（最近開啟改用
     * 名稱排，至少還是同一批檔的另一種看法），但「常用」整個價值就在那個名次 ——
     * 照名稱排之後跟隨機挑 60 筆沒有分別，等於這個檢視消失。
     * 要換角度看就用 / 過濾。
     * 大綱同理：標題的順序就是文章的順序，照名稱排等於把文章打散。
     * 關聯也是：那份清單的順序**就是分組**（Parent、Children、Related…），
     * 重排會讓同一組的項目散開，畫出來就變成同一個組標題重複出現好幾次。
     */
    const ordered = this.view === "frecency" || this.view === "outline" || this.view === "relations";
    if (cfg.field !== "natural" && !ordered) {
      const pairs = arr.map((it) => ({
        it,
        f: it.file || (it.path ? this.app.vault.getAbstractFileByPath(it.path) : null),
      }));
      // 有任何一筆對不到實體檔（例如分頁是非檔案 view）就整份不排，
      // 半套的排序比不排更難理解
      if (pairs.length && pairs.every((p) => p.f)) {
        const byPath = new Map(pairs.map((p) => [p.f.path, p.it]));
        arr = sortFiles(pairs.map((p) => p.f), cfg).map((f) => byPath.get(f.path)).filter(Boolean);
      }
    }
    this.listItems = arr;
    if (this.listIndex >= arr.length) this.listIndex = Math.max(0, arr.length - 1);
  }

  buildListRaw() {
    if (this.view === "tabs") this.listItems = this.collectTabs();
    else if (this.view === "bookmarks") this.listItems = this.collectBookmarks();
    else if (this.view === "recent") this.listItems = this.collectRecent();
    else if (this.view === "frecency") this.listItems = this.collectFrecency();
    else if (this.view === "outline") this.listItems = this.collectOutline();
    else if (this.view === "relations") this.listItems = this.collectRelationItems();
    else if (this.view === "views") this.listItems = this.collectViews();
    else this.listItems = [];
    if (this.listIndex >= this.listItems.length) {
      this.listIndex = Math.max(0, this.listItems.length - 1);
    }
  }

  // 只收主編輯區的分頁（iterateRootLeaves 不含側邊欄），這正是「分頁」的直覺範圍
  collectTabs() {
    const ws = this.app.workspace;
    const active = ws.activeLeaf;
    const out = [];
    ws.iterateRootLeaves((leaf) => {
      const file = leaf.view && leaf.view.file ? leaf.view.file : null;
      out.push({
        label: leaf.getDisplayText ? leaf.getDisplayText() : this.t("ui.untitled", "(untitled)"),
        sub: file ? file.path : (leaf.view ? leaf.view.getViewType() : ""),
        file,
        leaf,
        active: leaf === active,
      });
    });
    return out;
  }

  /*
   * 有指定快捷字母的排前面（依字母），其餘依加入時間新到舊。
   * 這個順序讓「常用的」穩定待在上面，新加的也立刻看得到。
   */
  collectBookmarks() {
    const marks = this.plugin ? this.plugin.bookmarks().slice() : [];
    marks.sort((a, b) => {
      if (!!a.key !== !!b.key) return a.key ? -1 : 1;
      if (a.key && b.key) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      return (b.added || 0) - (a.added || 0);
    });
    return marks.map((m) => {
      const f = this.app.vault.getAbstractFileByPath(m.path);
      // 自己取的名字優先；沒取過的（舊書籤）照原本顯示檔名
      const title = m.name || (f ? f.name || this.t("ui.vaultRoot", "(vault root)") : m.path.split("/").pop());
      return {
        // 快捷字母放 icon 欄、名稱獨佔第一行、路徑放第二行 —— 擠成一行時
        // 自己取的名字會先被截掉，而那正是用來認它的東西
        icon: m.key || "·",
        label: title,
        sub: m.path + (f ? "" : "　" + this.t("ui.gone", "(gone)")),
        file: f && !isFolder(f) ? f : null,
        path: m.path,
        key: m.key,
        title,
        missing: !f,
      };
    });
  }

  // getLastOpenFiles() 是公開 API，回傳最近開啟過的路徑（新到舊）。
  // 已刪除的檔案也會留在裡面，所以要過濾。
  collectRecent() {
    const ws = this.app.workspace;
    const paths = typeof ws.getLastOpenFiles === "function" ? ws.getLastOpenFiles() : [];
    const out = [];
    for (const p of paths) {
      if (out.length >= RECENT_LIMIT) break;
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!f || isFolder(f)) continue;
      out.push({ label: f.name, sub: f.path, file: f, path: f.path });
    }
    return out;
  }

  /*
   * 常用（z）。資料夾與檔案混在一起排 ——「我常去的地方」本來就兩種都有，
   * 分開列反而要多按一顆鍵決定看哪邊。紀錄由 plugin 維護：
   * 檔案來自 workspace 的 file-open 事件（所以從 quick switcher、點連結、
   * 側邊欄開的也算），資料夾來自這個瀏覽器的 gotoFolder。
   */
  collectFrecency() {
    const rows = this.plugin ? this.plugin.frecencyRanked() : [];
    const out = [];
    for (const r of rows) {
      if (out.length >= FRECENCY_LIMIT) break;
      const f = this.app.vault.getAbstractFileByPath(r.path);
      if (!f) continue; // 已刪除的自然淘汰，不特地去清
      out.push({
        label: (isFolder(f) ? "▸ " : "") + (f.name || this.t("ui.vaultRoot", "(vault root)")),
        sub: r.path + "　×" + r.n,
        path: r.path,
        file: isFolder(f) ? null : f,
      });
    }
    return out;
  }

  /* ── 大綱（go）──
   *
   * 游標所指筆記的標題清單，開在清單檢視裡（j/k/Enter/過濾都跟書籤、搜尋結果同一套）。
   * 跟其他清單的差別在右欄：**同一個檔不重畫，只捲到游標所指的標題**（見 renderPreview），
   * 所以 j/k 掃過標題時預覽是即時跟著走的 —— 這是 Quick Switcher 那類「選了才知道跳對沒」
   * 做不到的事。Enter 開檔並定位到那一行。
   */
  openOutline() {
    const f = this.focusFile();
    if (!f || (f.extension || "").toLowerCase() !== "md") {
      new Notice(this.t("notice.outlineOnlyMd", "Outline needs a markdown note under the cursor"));
      this.render();
      return;
    }
    this.pushLayer();          // 退回來時看到的是原本那份清單／資料夾
    this.outlineFile = f;
    this.listFilter = "";
    this.openList("outline", { skipPush: true });
  }

  // 游標現在指著哪個檔案：檔案檢視看游標列，清單檢視看清單項目
  focusFile() {
    if (this.view === "files") {
      const c = this.current();
      return c && !isFolder(c) ? c : null;
    }
    const it = this.listCurrent();
    return it && it.file ? it.file : null;
  }

  collectOutline() {
    const f = this.outlineFile;
    if (!f) return [];
    const c = this.app.metadataCache.getFileCache(f);
    return outlineItems(c && c.headings, this.t("ui.untitled", "(untitled)")).map((h) =>
      Object.assign(h, { file: f, path: f.path, sub: "H" + h.level })
    );
  }

  /*
   * 預覽欄捲到游標所指的標題。用「第幾個標題」對位（理由見 core/outline.js）。
   * 渲染版找 <h1>–<h6>，跳過 blockquote / callout 裡的（metadataCache 的 headings 不含
   * 那些）；純文字版掃 <pre> 內文算行。找不到＝那個標題在截斷點之後 → 捲到底，至少
   * 讓人知道「在更後面」。渲染是分兩段完成的（先純文字、停下來才換渲染版），所以
   * renderFilePreview 兩段都會再呼叫一次這裡。
   */
  followOutline() {
    const el = this.previewEl;
    const item = this.listCurrent();
    if (!el || !item) return;
    const base = el.getBoundingClientRect().top - el.scrollTop;   // 內容座標系的原點
    const md = el.querySelector(".yazi-preview-md");
    const hs = md
      ? Array.from(md.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter((h) => !h.closest("blockquote, .callout"))
      : [];
    if (hs.length) {
      const h = hs[item.idx];
      el.scrollTop = h ? Math.max(0, h.getBoundingClientRect().top - base - OUTLINE_PAD) : el.scrollHeight;
      return;
    }
    const pre = el.querySelector(".yazi-preview-text");
    if (!pre) {
      if (md) el.scrollTop = el.scrollHeight;
      return;
    }
    const line = headingLines(pre.textContent)[item.idx];
    el.scrollTop =
      line === undefined
        ? el.scrollHeight
        : Math.max(0, pre.getBoundingClientRect().top - base + line * this.previewLinePx() - OUTLINE_PAD);
  }

  /* ── 關聯（gr）──
   *
   * 以游標所指的筆記為中心，把 frontmatter 的連結欄位攤成分組清單：
   * Parent / Children、Up / Down、Related，最後是沒有型別的一般連結與反向連結。
   * 讀哪些欄位是設定（settings.relations），反向那一組永遠是推導的 —— 理由見
   * core/relations.js。
   *
   * Enter / l ＝**游標跳到那個檔，人留在 yazi**（不是開檔）。這是整個檢視的重點：
   * 資料夾用 h/l 走，連結用 gr 走，兩者手感一樣，都可以一路走下去再用 h 退回來。
   * 真的要開檔是 o / t。
   */
  openRelations() {
    const f = this.focusFile();
    if (!f || (f.extension || "").toLowerCase() !== "md") {
      new Notice(this.t("notice.relOnlyMd", "Relations need a markdown note under the cursor"));
      this.render();
      return;
    }
    // 已經在關聯檢視裡再按 gr ＝以這一筆為新中心，舊的那層推進堆疊（h 退回去）
    this.pushLayer();
    this.relFile = f;
    this.listFilter = "";
    this.openList("relations", { skipPush: true });
  }

  collectRelationItems() {
    const file = this.relFile;
    if (!file) return [];
    const out = [];
    for (const g of this.relationGroupsFor(file)) {
      /*
       * 一般連結（Links / Backlinks）預設收合成一列：它們常有幾十筆，攤開會把
       * parent / related 淹掉。畫成資料夾那樣的 ▸，l / Enter 展開 —— 跟其他節點的
       * 「進去」是同一顆鍵，不必另外記。展開狀態跟著「哪個中心的哪一組」走，
       * 走到下一則筆記又是收合的，退回來則維持展開。
       */
      if (g.untyped && !this.relExpanded.has(file.path + "\n" + g.label)) {
        out.push({
          icon: "▸",
          label: this.t("ui.relCollapsed", "{n} {label}", { n: g.items.length, label: g.label }),
          sub: "", collapsed: g.label, path: null, file: null,
        });
        continue;
      }
      for (const f of g.items) out.push({ label: f.basename, sub: f.path, path: f.path, file: f, group: g.label });
    }
    return out;
  }

  /*
   * 一則筆記的關聯分組（含推導出來的反向）。
   * 一次開啟期間每個檔只算一次：右欄的摘要條在每次 j/k 都要問一次游標所指那則的分組，
   * 而反向推導要掃整個 vault 的 frontmatter，不快取的話長按 j 會卡。
   */
  relationGroupsFor(file) {
    if (!file) return [];
    if (!this.relCache) this.relCache = new Map();
    if (this.relCache.has(file.path)) return this.relCache.get(file.path);
    const app = this.app;
    const mc = app.metadataCache;
    const rules = (this.plugin && this.plugin.settings && this.plugin.settings.relations) || [];
    const isMd = (f) => f && !isFolder(f) && (f.extension || "").toLowerCase() === "md";
    // resolvedLinks 是 { 來源路徑: { 目標路徑: 次數 } }，兩個方向都從這裡算
    const resolved = mc.resolvedLinks || {};
    const byPath = (p) => app.vault.getAbstractFileByPath(p);

    const groups = collectRelations(file, rules, {
      fmOf: (f) => {
        const c = mc.getFileCache(f);
        return (c && c.frontmatter) || null;
      },
      /*
       * 連結路徑 → 檔案。先走 Obsidian 自己的解析（相對路徑、別名、短寫都靠它），
       * 解析不到再退一步用「檔名開頭」比對 —— 有人的 frontmatter 寫的是純 id
       * （`parent: OB-19`，檔名是 `OB-19 某某標題.md`），那不是合法的連結，
       * 但看得出來要指哪裡，沒道理當作沒填。
       */
      resolve: (linkpath, from) => {
        const hit = mc.getFirstLinkpathDest ? mc.getFirstLinkpathDest(linkpath, from) : null;
        if (hit) return hit;
        const key = linkpath.toLowerCase();
        return app.vault.getMarkdownFiles().find((f) => {
          const b = f.basename.toLowerCase();
          return b === key || b.startsWith(key + " ");
        }) || null;
      },
      mdFiles: () => app.vault.getMarkdownFiles(),
      linksFrom: (f) => Object.keys(resolved[f.path] || {}).map(byPath).filter(isMd),
      linksTo: (f) =>
        Object.keys(resolved)
          .filter((src) => src !== f.path && resolved[src] && resolved[src][f.path])
          .map(byPath)
          .filter(isMd),
      labels: {
        links: this.t("ui.relLinks", "Links"),
        backlinks: this.t("ui.relBacklinks", "Backlinks"),
      },
    });

    this.relCache.set(file.path, groups);
    return groups;
  }

  /* ── 儲存的檢視（gv / ,v）──
   *
   * 存的是「一張組好的搜尋卡」：種類、關鍵字、條件、範圍。**存條件不存結果** ——
   * 「我的未完成 P0」要的就是每次打開都重算。
   *
   * 入口刻意只在**搜尋結果**畫面：先組一次、看到結果是對的，才決定要不要留下來。
   * 叫人去設定頁憑空填一張表單，等於要他在沒有回饋的情況下猜條件寫對了沒。
   */
  saveCurrentView() {
    if (this.view !== "search") {
      new Notice(this.t("notice.viewNeedsSearch", "Run a search first, then save it as a view"));
      return;
    }
    /*
     * 同樣的條件已經存過 → 不要默默存成第二份（兩個名字、一樣的結果，之後分不出哪個是哪個）。
     * 問一聲「已存在，要改名嗎」，y 才跳改名欄位，而且改的是**那一筆**（id 不變、字母留著）。
     * 只比條件不比名字：同名不同條件是「覆寫」，那是另一回事，說明頁與設定頁都寫了。
     */
    const def = this.currentViewDef();
    const dup = this.plugin ? this.plugin.views().find((v) => sameViewDef(v, def)) : null;
    if (dup) {
      this.askConfirm(
        this.t("confirm.viewExists", "A view with exactly these conditions exists: “{name}”. Rename it?", { name: dup.name }),
        () => this.promptViewName(dup)
      );
      return;
    }
    // 不另外問 y/n：接下來要打名字並按 Enter，那本身就擋掉了誤按 s 的情況
    this.promptViewName();
  }

  /* 目前這場搜尋的條件（沒有名字）—— 存檢視、比對重複都用這一份 */
  currentViewDef() {
    return {
      kind: this.searchKind,
      query: (this.searchQuery || "").trim(),
      facets: this.facets.map((f) => ({ id: f.id, value: f.value })),
      scopePath: this.scopePath || "",
    };
  }

  /* existing：改名既有那一筆（id、字母不動）；沒給就是存新的 */
  promptViewName(existing) {
    const suggested = existing
      ? existing.name
      : this.searchQuery || (this.facets[0] ? this.facetLabel(this.facets[0]) : "");
    const label0 = existing
      ? this.t("prompt.renameView", "Rename view to: ")
      : this.t("prompt.saveView", "Save this search as: ");
    this.promptFor(label0, suggested, async (name) => {
      const label = (name || "").trim();
      if (!label) return;
      if (!this.plugin) return;
      // 改名既有那一筆時以它為底（條件照舊）——從清單按 R 進來時，搜尋狀態根本不是它的。
      // id 不能只靠 Date.now()：同一毫秒存兩份會撞號，第二份會被當成「覆寫第一份」
      const base = existing ? Object.assign({}, existing) : this.currentViewDef();
      const view = Object.assign(base, {
        id: existing ? existing.id : "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: label,
        key: existing ? existing.key : null,
      });
      const replaced = await this.plugin.saveView(view);
      new Notice(existing
        ? this.t("notice.viewRenamed", "View renamed: {name}", { name: label })
        : replaced
        ? this.t("notice.viewReplaced", "View updated: {name}", { name: label })
        : this.t("notice.viewSaved", "View saved: {name}　(gv to open it)", { name: label }));
      this.render();
    });
  }

  collectViews() {
    const rows = this.plugin ? this.plugin.views() : [];
    return rows.map((v) => {
      const bits = [];
      if (v.query) bits.push('"' + v.query + '"');
      for (const f of v.facets || []) bits.push(this.facetLabel(f));
      if (v.scopePath) bits.push(this.t("ui.inFolder", "in {path}", { path: v.scopePath }));
      const kind = { text: this.t("ui.kindText", "full text"), dir: this.t("ui.kindDir", "folders") }[v.kind]
        || this.t("ui.kindFile", "file names");
      return {
        // 快捷字母放在 icon 欄（跟其他清單對齊），名稱獨佔第一行，條件放第二行
        icon: v.key || "·",
        label: v.name,
        sub: kind + (bits.length ? "　·　" + bits.join("　") : ""),
        viewDef: v,
      };
    });
  }

  /* 執行一個檢視：把條件灌回搜尋狀態，直接跳結果（不經過組合卡）。 */
  runView(v) {
    if (!v) return;
    // 從檢視清單執行一個檢視 ＝又一層：Esc 要退得回那份清單
    this.pushLayer();
    this.view = "search";
    this.searchKind = v.kind || "file";
    this.searchQuery = v.query || "";
    // 設定檔可能是手改的，或欄位已經被刪掉 —— 認不得的條件靜靜丟掉，
    // 不要讓整個檢視變成一個打不開的東西
    this.facets = (v.facets || []).filter((f) => f && f.id && FACET_BY_ID[f.id]);
    this.scopePath = v.scopePath || "";
    this.searchOrigin = this.scopePath;
    this.composing = false;
    this.listFilter = "";
    this.listIndex = 0;
    this.fvCache = null;
    this.mode = "nav";
    this.endInput();
    if (this.ensureIndex(this.searchKind)) return;
    this.buildSearchList();
    this.render();
  }

  /*
   * 編輯一個檢視：把它的條件灌回**組合卡**（不是結果），人可以按 Tab 加條件、
   * Backspace 退條件，改完按 Enter 看結果、再用 s 存回同一個名字（同名＝覆寫）。
   *
   * 為什麼編輯是「回到組合卡」而不是一張表單：條件的候選值是從 vault 讀出來的
   * （帶筆數），在表單裡手打欄位名與值，等於在沒有回饋的情況下猜有沒有拼對。
   */
  editView(v) {
    if (!v) return;
    this.runView(v);                        // 推一層（檢視清單）、把條件灌回搜尋狀態
    if (this.view !== "search") return;     // 索引還在建，runView 已經接手畫面了
    /*
     * 進入「編輯這一筆」模式：組合卡標題會寫明在編輯誰，Enter ＝把條件寫回那一筆並退回
     * 清單、Esc ＝放棄。不進結果頁 —— 組合卡本來就有即時筆數與前幾筆預覽，改完就存
     * 才符合「編輯」的用途；之前那條「改完 Enter 看結果、再 s 存」會存成另一筆。
     */
    this.editingView = v;
    this.reopenComposer();
  }

  /* 編輯模式的 Enter：條件寫回原本那一筆（名字、id、字母都不動），退回檢視清單 */
  saveEditedView() {
    const v = this.editingView;
    this.editingView = null;
    if (!v) return;
    const view = Object.assign({}, v, this.currentViewDef());
    this.endInput();
    // saveView 的清單更動是同步的，await 只等落地；這裡不等，畫面先退回去
    if (this.plugin) this.plugin.saveView(view);
    new Notice(this.t("notice.viewReplaced", "View updated: {name}", { name: v.name }));
    if (this.popLayer()) return;
    // 沒有上一層（不該發生）：至少別卡在組合卡裡
    this.composing = false;
    this.buildSearchList();
    this.render();
  }

  // 檢視清單裡按 R：改名（條件、id、字母都不動）
  renameView() {
    const item = this.listCurrent();
    if (!item || !item.viewDef) return;
    this.promptViewName(item.viewDef);
  }

  /*
   * 從搜尋結果回到組合卡。關鍵字與條件都原封留著 —— 「結果出來了但想再收窄一點」
   * 是搜尋最常見的下一步，不該逼人從頭打一次。
   * gd（找資料夾）沒有組合卡（見 openSearch），那就只是回到底部的輸入列。
   */
  /*
   * 送出組合卡：卡收起來，版面讓給結果。條件與關鍵字都留著，i/Tab 可以回來改。
   * 建議列是組合卡的一部分，一起收 —— 留著的話左欄會變成「加條件」而不是圖例。
   */
  showResults() {
    this.sug = null;
    this.sugField = null;
    this.composing = false;
    this.endInput();
    this.render();
  }

  reopenComposer() {
    this.mode = "search";
    this.composing = this.searchKind !== "dir";
    this.inputEl.value = this.searchQuery || "";
    this.inputWrapEl.show();
    this.refreshSuggest(false);
    this.inputEl.focus();
    this.render();
  }

  runViewByKey(key) {
    const v = this.plugin ? this.plugin.viewByKey(key) : null;
    if (!v) {
      new Notice(this.t("notice.noViewFor", "No view assigned to {key}", { key }));
      return;
    }
    this.runView(v);
  }

  // 檢視清單裡按 m 之後的第二顆鍵：字母/數字＝指定，Backspace/Delete＝清除
  assignViewKey(key) {
    const item = this.listCurrent();
    if (!item || !item.viewDef || !this.plugin) return;
    const clear = key === "Backspace" || key === "Delete";
    if (!clear && !/^[a-zA-Z0-9]$/.test(key)) {
      this.render();
      return;
    }
    this.plugin.assignViewKey(item.viewDef.id, clear ? null : key).then((stolen) => {
      this.buildList();
      this.render();
      if (clear) new Notice(this.t("notice.viewKeyCleared", "Shortcut cleared"));
      else if (stolen) new Notice(this.t("notice.viewKeyStolen", "{key} now opens {name} (taken from {from})", { key, name: item.viewDef.name, from: stolen }));
      else new Notice(this.t("notice.viewKeySet", "{key} now opens {name}", { key, name: item.viewDef.name }));
    });
  }

  listCurrent() {
    return this.listItems[this.listIndex] || null;
  }

  /*
   * 按 S 之後的第二顆鍵。再按一次同一個排序鍵＝反轉（yazi 的行為），
   * 這樣「換方向」不用記另一顆鍵。
   * 反轉本身收 S（前綴再按一次）、Space，以及舊的 o —— o 現在是開啟，
   * 但只在**選單裡**還認得它，肌肉記憶不必一次改乾淨。
   */
  applySort(key) {
    const cfg = this.sortCfg();
    if (key === "S" || key === "o" || key === " ") {
      this.saveSort({ field: cfg.field, reverse: !cfg.reverse, foldersFirst: cfg.foldersFirst });
      return;
    }
    if (key === "d") {
      this.saveSort({ field: cfg.field, reverse: cfg.reverse, foldersFirst: !cfg.foldersFirst });
      return;
    }
    const s = SORTS.find((x) => x.k === key);
    if (!s) {
      this.render();
      return;
    }
    const reverse = cfg.field === s.field ? !cfg.reverse : false;
    this.saveSort({ field: s.field, reverse, foldersFirst: cfg.foldersFirst });
  }

  saveSort(cfg) {
    if (this.plugin) this.plugin.setSort(cfg);
    if (this.view === "search") this.buildSearchList();
    else if (this.view !== "files") this.buildList();
    new Notice(this.t("notice.sort", "Sort: {value}", { value: this.sortText() }));
    this.render();
  }

  sortText() {
    const cfg = this.sortCfg();
    const dir = cfg.field === "natural" ? "" : cfg.reverse ? " ↓" : " ↑";
    const name = SORT_LABEL[cfg.field] ? this.t(SORT_LABEL[cfg.field]) : cfg.field;
    return name + dir + (cfg.foldersFirst ? "　" + this.t("ui.foldersFirst", "folders first") : "");
  }

  // 清單裡按 Enter / l / o
  activateListItem(openMode) {
    const item = this.listCurrent();
    if (!item) return;

    if (this.view === "tabs") {
      const ws = this.app.workspace;
      this.forceClose();   // 切分頁＝離開瀏覽器，不走 close() 的 Esc 攔截路徑
      ws.setActiveLeaf(item.leaf, { focus: true });
      return;
    }

    // 關聯：o / t ＝真的開檔（Enter / l 是跳游標，走 revealRelation）
    if (this.view === "relations") {
      if (item.file) this.openFile(item.file, openMode || "current");
      return;
    }

    // 大綱：開那個檔，並定位到這個標題那一行
    if (this.view === "outline") {
      if (item.file) this.openFile(item.file, openMode || "current", item.line);
      return;
    }

    // 書籤與最近檔案：資料夾就跳過去，檔案就開啟
    if (item.missing) {
      new Notice(this.t("notice.pathGone", "Path no longer exists: {path}", { path: item.path }));
      return;
    }
    const f = this.app.vault.getAbstractFileByPath(item.path);
    if (!f) {
      new Notice(this.t("notice.pathGone", "Path no longer exists: {path}", { path: item.path }));
      return;
    }
    if (isFolder(f)) {
      // 從清單跳進 vault ＝又一層：Esc 要退得回這份清單（書籤存的常常就是資料夾）
      this.pushLayer();
      this.gotoFolder(f);
      this.toFilesView();
      return;
    }
    this.openFile(f, openMode || "current");
  }

  /*
   * 關聯檢視的 Enter / l ＝「進去」：把關聯當資料夾走。
   * 游標所指那則筆記變成新的中心，中欄換成它的關聯，左欄變成剛才那份（上一跳），
   * h 退回去 —— 跟 h/l 走資料夾一模一樣。收合的一組（▸ 12 Backlinks）按 l 是展開，
   * 同一顆鍵、同一個意思：進到裡面看。真的要開檔是 o / t。
   */
  enterRelation() {
    const item = this.listCurrent();
    if (!item) return;
    if (item.collapsed) {
      this.relExpanded.add(this.relFile.path + "\n" + item.collapsed);
      this.buildList();
      this.render();
      return;
    }
    if (!item.file) return;
    this.pushLayer();
    this.relFile = item.file;
    this.listFilter = "";
    this.openList("relations", { skipPush: true });
  }

  /*
   * 清單裡按 x：有選取就處理選取的那幾列，沒有就是游標那一列（同檔案檢視的 y / x / D）。
   *
   * 問不問 y/n 的界線刻意不是「單筆 vs 多筆」，而是兩條疊起來：
   *   - 使用者一筆一筆存下來的東西（書籤、檢視）一律問，因為 x 就在 j/k 旁邊
   *   - **只要是多筆就一律問**，連分頁也問 —— 一次收掉 12 個分頁跟關掉一個不是同一件事，
   *     而 X（還原剛關掉的）只救得回最後一個
   */
  removeListItem() {
    if (this.view === "outline" || this.view === "relations") return;   // 這兩種清單沒有「拿掉一列」的意思
    const spec = LIST_REMOVE[this.view];
    if (!spec) {
      // 最近開啟：那份清單由 Obsidian 維護，沒有公開 API 可以刪單筆
      if (this.view === "recent") new Notice(this.t("notice.recentNoDelete", "Recent files cannot be deleted from here"));
      return;
    }
    if (!this.plugin) return;
    const items = this.listTargets();
    if (!items.length) return;

    if (items.length === 1 && !spec.confirmOne) {
      this.removeListItems(items);
      return;
    }
    const message =
      items.length === 1
        ? this.t(spec.ask, "Remove “{name}”?", { name: spec.label(items[0]) })
        : this.t(spec.askMany, "Remove the {count} selected items?", { count: items.length });
    this.askConfirm(message, () => this.removeListItems(items));
  }

  /*
   * 真的動手拿掉那幾列。一筆一筆等（不 Promise.all）：書籤與檢視的移除各自會寫一次
   * data.json，併發寫同一個檔會互相蓋掉彼此的結果。
   * 中途失敗的不擋住其他筆 —— 收集起來一次報，跟檔案刪除（doDelete）同一個處理方式。
   */
  async removeListItems(items) {
    const spec = LIST_REMOVE[this.view];
    if (!spec) return;
    const errs = [];
    for (const it of items) {
      try {
        await spec.remove(this, it);
      } catch (e) {
        errs.push(spec.label(it) + "：" + msg(e));
      }
    }
    this.resetListSelection();
    this.buildList();
    this.render();
    if (errs.length) {
      new Notice(this.t("notice.removeFailed", "Failed to remove {count} items:\n{errors}",
        { count: errs.length, errors: errs.join("\n") }), 10000);
      return;
    }
    if (items.length === 1) {
      // 單筆維持原本那句（「已刪除書籤：某某」）；分頁沒有單筆通知，本來也沒有。
      // path 與 name 都帶：這幾句訊息的佔位字本來就不一樣（書籤用 {path}、檢視用 {name}），
      // 在這裡統一成一種反而會讓其中一句印出沒被代換的 {name}
      if (spec.done) {
        const label = spec.label(items[0]);
        new Notice(this.t(spec.done, "Removed: {path}", { path: label, name: label }));
      }
      return;
    }
    new Notice(this.t(spec.doneMany, "Removed {count} items", { count: items.length }));
  }

  /* ── 書籤 ── */

  /*
   * 直接加書籤，不問快捷字母 —— 建立當下往往還不知道會不會常用，逼人選字母只會
   * 選出一堆記不住、又互相撞號的字母。字母是之後在書籤清單（b）裡按 m 再指定的，
   * 那時候整份清單攤在眼前，哪些字母被佔用一目了然。
   */
  addBookmark(target) {
    if (!this.plugin) return;
    if (!target) {
      new Notice(this.t("notice.nothingToBookmark", "Nothing to bookmark"));
      return;
    }
    /*
     * 先問名字再存。兩個作用：
     *   1. 書籤是拿來認的東西，而檔名往往不是你腦中叫它的名字（日記檔名是日期、
     *      task 檔名帶著 OB-19 前綴）
     *   2. m / M 就在 j/k 旁邊很容易誤按，要打字並按 Enter 才會寫進去，
     *      誤按自然就存不到東西 —— 不必再多問一次 y/n
     * 預設值＝檔名（不含副檔名），直接 Enter 就是原本的行為。
     */
    const suggested =
      target.path === "/"
        ? this.t("ui.vaultRoot", "(vault root)")
        : target.basename || target.name || target.path;
    this.promptFor(this.t("prompt.bookmarkName", "Bookmark as: "), suggested, async (name) => {
      const title = (name || "").trim();
      if (!title) return;   // 空白＝取消
      this.doAddBookmark(target.path, title);
    });
  }

  doAddBookmark(path, title) {
    this.plugin.addBookmark(path, title).then((added) => {
      new Notice(added
      ? this.t("notice.bookmarkAdded", "Bookmarked: {name}", { name: title })
      // 已經有這個路徑的書籤：改成換名字，比丟一句「已經加過了」有用
      : this.t("notice.bookmarkRenamed", "Bookmark renamed: {name}", { name: title }));
      if (this.view === "bookmarks") {
        this.buildList();
        this.render();
      }
    });
  }

  // 書籤清單裡按 e：改名字（路徑不動）
  renameBookmark() {
    const item = this.listCurrent();
    if (!item || !this.plugin) return;
    this.promptFor(this.t("prompt.bookmarkName", "Bookmark as: "), item.title || "", async (name) => {
      const title = (name || "").trim();
      if (!title) return;
      await this.plugin.addBookmark(item.path, title);   // 已存在＝改名
      this.buildList();
      this.render();
      new Notice(this.t("notice.bookmarkRenamed", "Bookmark renamed: {name}", { name: title }));
    });
  }

  jumpToBookmark(key) {
    const b = this.plugin ? this.plugin.bookmarkByKey(key) : null;
    if (!b) {
      new Notice(this.t("notice.noBookmarkFor", "No bookmark assigned to {key}", { key }));
      return;
    }
    this.revealPath(b.path);
  }

  // 在書籤清單裡按 m 之後的第二顆鍵：字母/數字＝指定，Backspace/Delete＝清除
  assignBookmarkKey(key) {
    const item = this.listCurrent();
    if (!item || !this.plugin) return;
    const clearing = key === "Backspace" || key === "Delete";
    const next = clearing ? null : key;
    if (!clearing && !/^[a-zA-Z0-9]$/.test(key)) {
      new Notice(this.t("notice.letterOnly", "The shortcut must be a letter or a digit"));
      this.render();
      return;
    }
    this.plugin.assignBookmarkKey(item.path, next).then((stolenFrom) => {
      if (clearing) new Notice(this.t("notice.letterCleared", "Shortcut cleared"));
      else if (stolenFrom) new Notice(this.t("notice.letterStolen", "{key} belonged to {from}; it now points here", { key: next, from: stolenFrom }));
      else new Notice(this.t("notice.letterSet", "{key} → {path}", { key: next, path: item.path }));
      this.buildList();
      // 指定完之後游標跟著那筆走（排序會變，有字母的會浮到上面）
      const idx = this.listItems.findIndex((x) => x.path === item.path);
      if (idx >= 0) this.listIndex = idx;
      this.render();
    });
  }

  /* ── 分頁 ── */

  closeActiveTab() {
    const ws = this.app.workspace;
    const leaf = ws.getMostRecentLeaf(ws.rootSplit);
    if (!leaf) {
      new Notice(this.t("notice.noTabToClose", "No tab to close"));
      return;
    }
    const name = leaf.getDisplayText ? leaf.getDisplayText() : "";
    leaf.detach();
    new Notice(this.t("notice.tabClosed", "Closed: {name}", { name }));
    if (this.view === "tabs") {
      this.buildList();
      this.render();
    }
  }

  undoCloseTab() {
    const ok = this.app.commands.executeCommandById("workspace:undo-close-pane");
    if (!ok) new Notice(this.t("notice.noTabToReopen", "No closed tab to reopen"));
    if (this.view === "tabs") {
      this.buildList();
      this.render();
    }
  }

  /* ── 檔案操作 ── */

  childPath(name) {
    return this.cwd.path === "/" ? name : this.cwd.path + "/" + name;
  }

  promptFor(label, value, onSubmit) {
    this.mode = "prompt";
    this.promptCtx = { onSubmit };
    this.inputLabelEl.setText(label);
    this.inputEl.value = value || "";
    this.inputWrapEl.show();
    this.inputEl.focus();
    // 只選檔名主體，副檔名留著 —— 改名時最常改的就是主體
    const dot = this.inputEl.value.lastIndexOf(".");
    if (dot > 0) this.inputEl.setSelectionRange(0, dot);
    else this.inputEl.select();
    this.render();
  }

  endInput() {
    this.mode = "nav";
    this.promptCtx = null;
    this.inputWrapEl.hide();
    this.inputEl.blur();
    this.inputEl.value = this.filter;
  }

  /* Esc 在輸入列上：丟掉這次的輸入、回到 nav。三種輸入各有自己要復原的東西。 */
  cancelInput() {
    if (this.mode === "listfilter") {
      this.listFilter = "";
      this.endInput();
      if (this.view === "search") this.buildSearchList();
      else this.buildList();
      return;
    }
    if (this.mode === "filter") {
      this.filter = "";
      this.endInput();
      this.setCursor(this.cursorIndex());
      return;
    }
    this.endInput();   // prompt：放棄輸入
  }

  newNote() {
    this.promptFor(this.t("prompt.newNote", "New note: "), "", async (name) => {
      if (!name) return;
      const path = this.childPath(name.endsWith(".md") ? name : name + ".md");
      try {
        const file = await this.app.vault.create(path, "");
        this.cursorPath = file.path;
        this.render();
      } catch (e) {
        new Notice(this.t("notice.createFailed", "Could not create it: {error}", { error: msg(e) }));
      }
    });
  }

  newFolder() {
    this.promptFor(this.t("prompt.newFolder", "New folder: "), "", async (name) => {
      if (!name) return;
      try {
        await this.app.vault.createFolder(this.childPath(name));
        this.cursorPath = this.childPath(name);
        this.render();
      } catch (e) {
        new Notice(this.t("notice.createFailed", "Could not create it: {error}", { error: msg(e) }));
      }
    });
  }

  rename() {
    const cur = this.current();
    if (!cur) return;
    this.promptFor(this.t("prompt.rename", "Rename: "), cur.name, async (name) => {
      if (!name || name === cur.name) return;
      const parent = cur.parent;
      const base = !parent || parent.path === "/" ? "" : parent.path + "/";
      try {
        await this.app.fileManager.renameFile(cur, base + name);
        this.cursorPath = base + name;
        this.render();
      } catch (e) {
        new Notice(this.t("notice.renameFailed", "Rename failed: {error}", { error: msg(e) }));
      }
    });
  }

  /*
   * 通用的 y/n 確認，走跟刪除同一個 confirm 模式（底部狀態列變紅、y 才執行）。
   * 用底部那一列而不是另開一個 Modal：另開視窗會把焦點搶走，回來之後鍵盤狀態
   * 要重新接一次；而這個介面的每一次確認都只是一顆鍵的事。
   */
  askConfirm(message, onYes) {
    this.mode = "confirm";
    this.confirmAsk = { message, onYes };
    this.render();
  }

  askDelete() {
    const list = this.targets();
    if (!list.length) return;
    this.mode = "confirm";
    this.confirmTargets = list;
    this.confirmTarget = list[0];   // renderBar 顯示用（單筆時就是它本人）
    this.render();
  }

  async doDelete() {
    const list = this.confirmTargets || (this.confirmTarget ? [this.confirmTarget] : []);
    this.mode = "nav";
    this.confirmTarget = null;
    this.confirmTargets = null;
    if (!list.length) return;
    const i = this.cursorIndex();
    const errs = [];
    for (const target of list) {
      try {
        await this.app.fileManager.trashFile(target);
        this.sel.delete(target.path);
      } catch (e) {
        errs.push(target.name + "：" + msg(e));
      }
    }
    if (errs.length) new Notice(this.t("notice.deleteFailed", "Failed to delete {count} items:\n{errors}", { count: errs.length, errors: errs.join("\n") }), 10000);
    else if (list.length > 1) new Notice(this.t("notice.deleted", "Deleted {count} items", { count: list.length }));
    this.setCursor(i);   // 刪掉之後游標落在同一個索引，也就是下一個項目
    this.render();
  }

  /*
   * cc / cd / cf / cn / cr —— 鍵位對齊 yazi keymap 的 c 前綴。
   * 原本掛在 yy，但 y 讓給「複製檔案」了（yazi 的 y 本來也是 yank 檔案，
   * 複製路徑在它那邊同樣是 c 開頭，所以搬過來反而更一致）。
   *
   * cc / cd 給的是**作業系統的絕對路徑**，跟 yazi 的 copy path / copy dirname 一樣：
   * 這兩顆鍵的用途就是「貼到 vault 外面去用」（終端機、檔案總管、給 AI 看的路徑）。
   * vault 內部才用得到的相對路徑改放 cr —— 兩種都要，只是絕對的那個比較常用。
   * 手機版算不出絕對路徑（沒有 basePath），cc / cd 自動退回相對路徑。
   */
  copyPath(kind) {
    const item = this.view === "files" ? this.current() : this.listCurrent();
    const path = item ? (item.path || (item.file && item.file.path)) : null;
    if (!path) {
      new Notice(this.t("notice.nothingToCopy", "Nothing to copy"));
      return;
    }
    const name = path.split("/").pop();
    const dot = name.lastIndexOf(".");
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
    let text = path;
    if (kind === "c") text = absPath(this.app, path) || path;
    else if (kind === "d") text = absPath(this.app, dir) || dir;
    else if (kind === "f") text = name;
    else if (kind === "n") text = dot > 0 ? name.slice(0, dot) : name;
    navigator.clipboard.writeText(text).then(
      () => new Notice(this.t("notice.copied", "Copied: {text}", { text })),
      (e) => new Notice(this.t("notice.copyFailed", "Copy failed: {error}", { error: e }))
    );
  }

  /* ── 外部開啟（大寫 O，見檔頭 OPEN_ACTIONS）── */

  /*
   * 這次要丟出去的那一項：檔案檢視用游標那一個（空資料夾則是當前資料夾本身），
   * 清單檢視用清單游標那一筆。分頁清單裡「不是檔案」的分頁沒有路徑 → 回 null。
   */
  openTarget() {
    const item = this.view === "files" ? this.current() || this.cwd : this.listCurrent();
    if (!item) return null;
    const path = item.path || (item.file && item.file.path) || null;
    if (!path) return null;
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!af) return null; // 已經不存在（書籤／最近開啟裡的殘骸）
    const folder = isFolder(af);
    const name = af.name || "";
    const dot = name.lastIndexOf(".");
    return {
      path,
      relPath: path,
      folder,
      name,
      basename: af.basename || (dot > 0 ? name.slice(0, dot) : name),
      ext: folder ? "" : String(af.extension || "").toLowerCase(),
      abs: absPath(this.app, path),
    };
  }

  /* 選單內容全部來自設定（settings.openers），跟著游標那一項是檔案還是資料夾變。 */
  openActions() {
    const t = this.openTarget();
    if (!t) return [];
    const list = (this.plugin && this.plugin.settings && this.plugin.settings.openers) || [];
    return resolveOpeners(list, t, platformId(Platform), !!Platform.isDesktopApp);
  }

  openLabel(a) {
    return a.label || a.id || "";
  }

  openMenu() {
    if (!this.openTarget()) {
      new Notice(this.t("notice.noPath", "This item has no file path"));
      return;
    }
    if (!this.openActions().length) {
      new Notice(this.t("notice.noOpeners", "No openers apply to this item"));
      return;
    }
    this.pending = "open";
    this.render();
  }

  runOpenAction(key) {
    const t = this.openTarget();
    const a = this.openActions().find((x) => x.key === key);
    // 沒定義的鍵就當成取消（跟 g / c / , 那幾個前綴一致）
    if (!t || !a) {
      this.render();
      return;
    }
    try {
      this.execOpener(a, t);
      new Notice(this.openLabel(a) + "：" + (t.path === "/" ? this.app.vault.getName() : t.path));
    } catch (e) {
      new Notice(this.t("notice.openFailed", "Open failed") + "（" + this.openLabel(a) + "）：" + msg(e));
    }
    this.render();
  }

  /*
   * 一條 opener 的實際執行。四種 kind：
   *   system / reveal        交給作業系統（需要絕對路徑）
   *   command                生一個外部行程（桌面限定）
   *   obsidian-command       先開檔再執行 Obsidian 的命令 —— 這條不需要絕對路徑，
   *                          所以行動版也能用，是給不碰 shell 的人的擴充點
   */
  execOpener(a, t) {
    if (a.kind === "obsidian-command") {
      if (!a.commandId) throw new Error("no command id");
      const af = this.app.vault.getAbstractFileByPath(t.path);
      const after = () => this.app.commands.executeCommandById(a.commandId);
      if (af && !t.folder) {
        this.close();
        this.app.workspace.getLeaf(false).openFile(af).then(after, after);
      } else {
        after();
      }
      return;
    }

    if (!t.abs) throw new Error(this.t("notice.noAbsPath", "Cannot resolve an absolute path here"));

    if (a.kind === "reveal") { this.systemOpen(t.abs, true); return; }
    if (a.kind === "system") { this.systemOpen(t.abs, false); return; }

    if (a.kind === "command") {
      const vars = opnerVars(
        Object.assign({}, t, { path: t.abs }),
        { path: absPath(this.app, "/"), name: this.app.vault.getName() }
      );
      const [cmd, args] = buildCommand(a, vars);
      if (!cmd) throw new Error("no executable");
      runCommand(cmd, args);
      return;
    }

    throw new Error("unknown opener kind: " + a.kind);
  }

  /*
   * reveal ＝在檔案管理器裡選中它；否則＝用系統預設的方式開它本身（資料夾就開那個
   * 資料夾、檔案就交給預設程式）。
   *
   * 走 Electron 的 shell。Obsidian 沒有對應的公開 API —— app.showInFolder /
   * openWithDefaultApp 雖然存在，但不在 obsidian.d.ts 裡，是未公開的內部 API，
   * 不該依賴。行動版沒有 shell，呼叫端（resolveOpeners）已經先擋掉這類 opener。
   */
  systemOpen(abs, reveal) {
    if (!Platform.isDesktopApp) {
      throw new Error(this.t("notice.noOpenMethod", "No way to open things on this platform"));
    }
    let shell = null;
    try {
      shell = require("electron").shell;
    } catch (e) {
      shell = null;
    }
    if (!shell) throw new Error(this.t("notice.noOpenMethod", "No way to open things on this platform"));
    if (reveal) {
      shell.showItemInFolder(abs);
      return;
    }
    // openPath 回的是 Promise<string>：空字串＝成功，其餘是錯誤訊息
    const r = shell.openPath(abs);
    if (r && typeof r.then === "function") {
      r.then((err) => {
        if (err) new Notice(this.t("notice.openFailed", "Open failed") + "：" + err);
      });
    }
    fn.call(app, abs);
  }

  /* ── 多選 ── */

  /*
   * 選取用一個「路徑的集合」，而且**跨資料夾保留**（yazi 也是這個語意）——
   * 才能「這裡選幾個、走去別層再選幾個」然後一次搬走。Esc 清掉。
   */
  toggleSelect(f) {
    if (!f) return;
    if (this.sel.has(f.path)) this.sel.delete(f.path);
    else this.sel.add(f.path);
  }

  /* ── 清單檢視的多選 ──
   *
   * 鍵位與檔案檢視完全一樣（Space / v / V / ^a / ^r ＋ Esc 清掉），因為它回答的是
   * 同一個問題：「這幾列，一起處理」。差別只在選取存在 listSel、而且身分不是路徑。
   */

  // 這份清單支援多選嗎（＝x 對它有意義嗎，見 LIST_REMOVE）
  listSelectable() {
    return this.view !== "files" && !!LIST_REMOVE[this.view];
  }

  /*
   * 一列的身分。要能撐過 buildList()（刪一筆、指定一個字母都會重建整份清單），
   * 所以不能用索引。
   *   書籤 / 常去的地方 → 路徑
   *   檢視            → viewDef.id
   *   分頁            → leaf 物件本身。兩個分頁可以開同一個檔，路徑不是身分；
   *                     而 leaf 在重建之間是同一個物件（collectTabs 重讀的就是它們）
   */
  listSelKey(item) {
    if (!item) return null;
    if (this.view === "views") return item.viewDef ? item.viewDef.id : null;
    if (this.view === "tabs") return item.leaf || null;
    return item.path || null;
  }

  toggleListSelect(item) {
    const k = this.listSelKey(item);
    if (k == null) return;
    if (this.listSel.has(k)) this.listSel.delete(k);
    else this.listSel.add(k);
  }

  /*
   * 這次 x 要處理哪幾列：有選取就是選取的那些，沒有就是游標這一列。
   * 順序照**清單目前的順序**而不是選取順序 —— 確認訊息與實際刪除的順序都該
   * 跟眼睛看到的一致。
   */
  listTargets() {
    if (this.listSelectable() && this.listSel.size) {
      const out = this.listItems.filter((it) => this.listSel.has(this.listSelKey(it)));
      if (out.length) return out;
      this.listSel.clear();   // 選的那幾列已經不在清單上了（別處刪掉）：當作沒選
    }
    const cur = this.listCurrent();
    return cur ? [cur] : [];
  }

  /* 換一份清單就把選取清掉：不同種類的清單之間「選了哪幾列」沒有意義可以延續 */
  resetListSelection() {
    this.listSel.clear();
    this.visual = 0;
    this.visualAnchor = -1;
    this.visualBase = null;
  }

  /*
   * 「這次動作的對象」：有選取就用選取的，沒有就用游標這一個。
   * y / x / D 全都走這裡，批次與單筆不必各寫一份。
   */
  targets() {
    if (this.sel.size) {
      const out = [];
      for (const p of this.sel) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f) out.push(f);
      }
      if (out.length) return out;
      this.sel.clear(); // 選的全都不存在了（被別處刪掉）：當作沒選
    }
    const cur = this.current();
    return cur ? [cur] : [];
  }

  /*
   * 回傳「有沒有真的清掉東西」，讓 Esc 知道這一下是不是已經消化掉了。
   * 只清**目前這個檢視**的選取：在書籤清單按 Esc 不該順手把進來之前選好的那幾個
   * 檔案也清掉（檔案的選取跨資料夾保留，那是 yazi 的語意）。
   */
  clearSelection() {
    const listView = this.view !== "files";
    const had = this.visual || (listView ? this.listSel.size : this.sel.size);
    if (listView) this.listSel.clear();
    else this.sel.clear();
    this.visual = 0;
    this.visualAnchor = -1;
    this.visualBase = null;
    return !!had;
  }

  selectAll(state) {
    if (this.view !== "files") {
      if (!this.listSelectable()) return;
      for (const it of this.listItems) {
        const k = this.listSelKey(it);
        if (k == null) continue;
        if (state) this.listSel.add(k);
        else this.listSel.delete(k);
      }
      return;
    }
    for (const f of this.mainList()) {
      if (state) this.sel.add(f.path);
      else this.sel.delete(f.path);
    }
  }

  invertSelection() {
    if (this.view !== "files") {
      if (!this.listSelectable()) return;
      for (const it of this.listItems) {
        const k = this.listSelKey(it);
        if (k == null) continue;
        if (this.listSel.has(k)) this.listSel.delete(k);
        else this.listSel.add(k);
      }
      return;
    }
    for (const f of this.mainList()) {
      if (this.sel.has(f.path)) this.sel.delete(f.path);
      else this.sel.add(f.path);
    }
  }

  /*
   * visual 模式：v 進「選取」、V 進「取消選取」，之後每次移動游標都把
   * anchor → 現在位置整段重新套一次。再按同一顆（或 Esc）結束。
   * 為什麼每次都重算整段、而不是只處理剛經過的那一列：往回拉的時候會自動還原，
   * 不必記「剛剛是從哪個方向過來的」。
   */
  toggleVisual(mode) {
    if (this.visual === mode) {
      this.visual = 0;
      this.visualAnchor = -1;
      this.visualBase = null;   // 選取本身留著，只是不再跟著游標動
      this.render();
      return;
    }
    if (this.view !== "files" && !this.listSelectable()) return;
    this.visual = mode;
    this.visualAnchor = this.selIndex();
    this.visualBase = new Set(this.view === "files" ? this.sel : this.listSel);
    this.applyVisual();
    this.render();
  }

  /* visual 的錨點與範圍都用「目前這份清單」的索引：檔案檢視是 mainList()，清單檢視是 listItems */
  selIndex() {
    return this.view === "files" ? this.cursorIndex() : this.listIndex;
  }

  /*
   * 把 anchor → 現在位置整段重新套一次。
   *
   * ⚠️ 關鍵是**先還原成進 visual 之前的樣子**（visualBase）再套。只往範圍內加／減的話，
   * 往回拉時剛剛掃過、現在已經離開範圍的那幾列會留在選取裡 —— 症狀是「v 之後 j j j k k
   * 還是選了四列」。有了 base 就不必記住「剛剛是從哪個方向過來的」，而且 V（成段取消）
   * 拉回來時本來被取消掉的那幾列也會回來。
   */
  applyVisual() {
    if (!this.visual || this.visualAnchor < 0) return;
    const i = this.selIndex();
    if (i < 0) return;
    const listView = this.view !== "files";
    if (listView && !this.listSelectable()) return;
    const set = listView ? this.listSel : this.sel;
    if (this.visualBase) {
      set.clear();
      for (const k of this.visualBase) set.add(k);
    }
    const from = Math.min(this.visualAnchor, i);
    const to = Math.max(this.visualAnchor, i);
    // 清單先取出來：mainList() 每次都要重排一遍，放在迴圈裡等於長清單拉一段就排幾百次
    const rows = listView ? this.listItems : this.mainList();
    for (let k = from; k <= to; k++) {
      const row = rows[k];
      const key = listView ? this.listSelKey(row) : row && row.path;
      if (key == null) continue;
      if (this.visual > 0) set.add(key);
      else set.delete(key);
    }
  }

  /* ── 剪貼簿（y / x / p / P）── */

  // 剪貼簿掛在 plugin 上而不是 modal 上：關掉瀏覽器再開，剪下的東西還在
  clip() {
    return this.plugin ? this.plugin.clip : null;
  }

  yank(cut) {
    const list = this.targets();
    if (!list.length) {
      new Notice(cut ? this.t("notice.nothingToCut", "Nothing to cut") : this.t("notice.nothingToCopyItems", "Nothing to copy"));
      return;
    }
    if (this.plugin) this.plugin.clip = { cut: !!cut, paths: list.map((f) => f.path) };
    new Notice(this.t(cut ? "notice.cutCount" : "notice.copiedCount",
      cut ? "Cut {count} items" : "Copied {count} items", { count: list.length }));
    this.clearSelection();
    this.render();
  }

  unyank() {
    if (this.plugin) this.plugin.clip = null;
    new Notice(this.t("notice.clipCleared", "Clipboard cleared"));
    this.render();
  }

  /*
   * 貼上。
   *
   * 剪下走 app.fileManager.renameFile —— 這是唯一會**連帶更新 vault 內連結**的 API
   * （vault.rename 不會）。搬 .md 檔時 [[wikilink]] 會自動改掉，這正是「在 Obsidian
   * 裡搬檔」跟「在檔案總管裡搬檔」的差別，也是這個功能非做在插件裡不可的原因。
   * 複製走 vault.copy；資料夾沒有現成 API，自己遞迴。
   *
   * 同名處理：P（force）＝先把目標丟垃圾桶再貼；p ＝自動加序號（「筆記 1.md」），
   * 跟 Obsidian 自己的「製作副本」一致。刻意不逐一跳對話框問 —— 批次貼上會問到瘋。
   */
  async paste(force) {
    const clip = this.clip();
    if (!clip || !clip.paths || !clip.paths.length) {
      new Notice(this.t("notice.clipEmpty", "The clipboard is empty (press y to copy or x to cut first)"));
      return;
    }
    const dest = this.cwd;
    const errs = [];
    let ok = 0;
    let lastPath = null;

    for (const src of clip.paths) {
      const f = this.app.vault.getAbstractFileByPath(src);
      if (!f) {
        errs.push(this.t("err.gone", "{name}: no longer exists", { name: src }));
        continue;
      }
      // 把資料夾搬進自己或自己的子孫：一定失敗，而且會留下半截結果，先擋掉
      if (isFolder(f) && (dest.path + "/").startsWith(f.path + "/")) {
        errs.push(this.t("err.intoItself", "{name}: cannot move a folder into itself", { name: f.name }));
        continue;
      }
      if (clip.cut && f.parent && f.parent.path === dest.path) {
        errs.push(this.t("err.alreadyHere", "{name}: already in this folder", { name: f.name }));
        continue;
      }

      let target = this.childPath(f.name);
      try {
        const existing = this.app.vault.getAbstractFileByPath(target);
        if (existing) {
          if (force) await this.app.fileManager.trashFile(existing);
          else target = this.uniquePath(f.name);
        }
        if (clip.cut) await this.app.fileManager.renameFile(f, target);
        else await this.copyInto(f, target);
        lastPath = target;
        ok++;
      } catch (e) {
        errs.push(f.name + "：" + msg(e));
      }
    }

    // 剪下是一次性的；複製留著，可以連續貼到好幾個地方
    if (clip.cut && this.plugin) this.plugin.clip = null;
    if (lastPath) this.cursorPath = lastPath;
    const where = dest.path === "/" ? this.t("ui.vaultRoot", "(vault root)") : dest.path;
    if (ok) {
      new Notice(this.t(clip.cut ? "notice.movedTo" : "notice.copiedTo",
        clip.cut ? "Moved {count} items to {where}" : "Copied {count} items to {where}", { count: ok, where }));
    }
    if (errs.length) {
      new Notice(this.t(clip.cut ? "notice.moveFailed" : "notice.copyFailedCount",
        clip.cut ? "Failed to move {count} items:\n{errors}" : "Failed to copy {count} items:\n{errors}",
        { count: errs.length, errors: errs.join("\n") }), 10000);
    }
    this.render();
  }

  // 目標同名時找一個沒被佔用的名字：「筆記.md」→「筆記 1.md」→「筆記 2.md」…
  uniquePath(name) {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 1; i < 1000; i++) {
      const p = this.childPath(stem + " " + i + ext);
      if (!this.app.vault.getAbstractFileByPath(p)) return p;
    }
    return this.childPath(stem + " " + Date.now() + ext);
  }

  // 複製一個檔，或一整棵資料夾
  async copyInto(f, target) {
    if (!isFolder(f)) {
      await this.app.vault.copy(f, target);
      return;
    }
    await this.app.vault.createFolder(target);
    for (const child of f.children.slice()) {
      await this.copyInto(child, target + "/" + child.name);
    }
  }

  /* ── 按鍵 ── */

  handleKey(ev) {
    // 中文輸入法組字中：整串放行，否則選字視窗會被吃掉
    if (ev.isComposing || ev.keyCode === 229) return;

    const key = ev.key;

    /*
     * Escape 一律走 onEscape()，不分 mode —— escapeBack() 的階梯本來就涵蓋全部情況
     * （pending → 說明 → 搜尋 → 結果內過濾 → 篩選 → prompt → 確認 → 選取 → 子檢視
     * → 關閉），各分支不必也不該再各判一次。
     * 下面幾個 mode 分支裡原本的 `key === "Escape"` 因此變成走不到的防禦性程式碼，
     * 刻意留著：它們的行為跟這裡一致，哪天這條被拿掉也不會破功。
     */
    if (key === "Escape") {
      this.swallow(ev);
      this.onEscape(ev);
      return;
    }

    /*
     * 全域模糊搜尋：輸入列有焦點，所以可見字元照常打字，但方向鍵與 Ctrl+j/k 要拿來
     * 移動候選（跟 Quick Switcher 同一套手感）。
     */
    if (this.mode === "search") {
      /*
       * Tab：有建議就收下它，沒有就把欄位選單叫出來。
       * 這一顆是整套條件功能的唯一入口 —— 什麼都不知道的人按 Tab 就看得到全部選項，
       * 所以不存在「有功能但沒人知道」的狀態（那正是原生搜尋的病）。
       */
      // Tab 一律是「收下現在反白的那個建議」；沒有建議時才是叫出欄位選單
      if (key === "Tab") {
        this.swallow(ev);
        if (this.sug) { this.acceptSuggest(); return; }
        this.refreshSuggest(true);
        this.render();
        return;
      }
      /*
       * Ctrl+<字母>：直接跳到某個欄位。選單上每一列都標著自己的鍵，
       * 所以這組是「用久了自然會記得」的加速器，不是「要先背起來」的前提。
       */
      if (ev.ctrlKey && !ev.altKey && key !== "j" && key !== "k" && this.searchKind !== "dir") {
        const spec = FACETS.find((f) => f.key === key);
        if (spec) {
          this.swallow(ev);
          this.sugField = spec.id;
          this.replaceToken("");
          this.refreshSuggest(true);
          this.render();
          return;
        }
      }
      if (key === "ArrowDown" || (ev.ctrlKey && key === "j")) {
        this.swallow(ev);
        if (this.sug) this.moveSuggest(1); else this.move(1);
        return;
      }
      if (key === "ArrowUp" || (ev.ctrlKey && key === "k")) {
        this.swallow(ev);
        if (this.sug) this.moveSuggest(-1); else this.move(-1);
        return;
      }
      // 輸入列已經空了還按 Backspace ＝ 拿掉最後一顆 chip（Gmail 收件者那套手感）
      if (key === "Backspace" && !this.inputEl.value && this.removeLastFacet()) {
        this.swallow(ev);
        return;
      }
      if (key === "Enter") {
        this.swallow(ev);
        /*
         * 只有「使用者選進去的」建議才吃 Enter（active，見 refreshSuggest）。
         * 打字順便冒出來的建議不搶 Enter —— 搶了的話「打完字按 Enter 送出」
         * 會變成收下一個沒要的條件，要按兩次 Enter 才送得出去。
         */
        if (this.sug && this.sug.active) { this.acceptSuggest(); return; }
        // 節流中的那次重算要先算完，否則送出的是上一個字的結果
        this.flushSearch();
        // Ctrl+Enter 才是「直接開」。單純 Enter 是確定搜尋字串：收起輸入列、
        // 結果留著，焦點交給清單，接著就能用 j/k 移動、l/o 開啟、/ 再過濾。
        /*
         * 編輯檢視中：Enter ＝存回去、Ctrl+Enter ＝先看完整結果（不存、仍在編輯）。
         * 組合卡上的筆數與前幾筆是快速確認；要逐筆看才需要進結果頁，那裡 s 存回、
         * i 回卡片、Esc 放棄。一般搜尋的 Ctrl+Enter 是「直接開第一筆」，編輯時沒有這個需求。
         */
        if (this.editingView) {
          if (ev.ctrlKey) this.showResults();
          else this.saveEditedView();
          return;
        }
        if (ev.ctrlKey) {
          this.commitSearch(true);
          return;
        }
        if (!this.listItems.length) return;
        this.showResults();
        return;
      }
      if (key === "Escape") { this.swallow(ev); this.escapeBack(); return; }
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      return;
    }

    /* 在搜尋結果中再過濾 */
    /* 說明頁的 / 搜尋：輸入列有焦點，Enter 收起輸入列但**留著**過濾結果 */
    if (this.mode === "helpfilter") {
      if (key === "Enter") { this.swallow(ev); this.endInput(); this.render(); return; }
      if (key === "Escape") { this.swallow(ev); this.escapeBack(); return; }
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      return;
    }

    if (this.mode === "listfilter") {
      if (key === "ArrowDown" || (ev.ctrlKey && key === "j")) { this.swallow(ev); this.move(1); return; }
      if (key === "ArrowUp" || (ev.ctrlKey && key === "k")) { this.swallow(ev); this.move(-1); return; }
      if (key === "Enter") { this.swallow(ev); this.endInput(); this.render(); return; }
      if (key === "Escape") { this.swallow(ev); this.escapeBack(); return; }
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      return;
    }

    /* 輸入列（篩選 / prompt）有焦點時只攔 Enter 與 Esc */
    if (this.mode === "filter" || this.mode === "prompt") {
      if (key === "Enter") {
        this.swallow(ev);
        if (this.mode === "prompt") {
          const cb = this.promptCtx && this.promptCtx.onSubmit;
          const value = this.inputEl.value.trim();
          this.endInput();
          if (cb) cb(value);
        } else {
          this.endInput();   // 篩選：收起輸入列但保留條件
          this.render();
        }
        return;
      }
      if (key === "Escape") {
        this.swallow(ev);
        this.escapeBack();
        return;
      }
      // 其他鍵：只擋傳播、不擋預設動作 —— 字照樣打進 input，但 document 上的其他
      // listener 看不到。（leader-hotkeys 註冊得比這裡早，攔不住它，所以 ',' 打不進來。）
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      return;
    }

    /* 刪除確認 */
    if (this.mode === "confirm") {
      this.swallow(ev);
      const yes = key === "y" || key === "Y";
      // 通用確認（askConfirm）優先；沒有的話就是刪除那條老路
      if (this.confirmAsk) {
        const ask = this.confirmAsk;
        this.confirmAsk = null;
        this.mode = "nav";
        if (yes) ask.onYes();
        // onYes 可能自己換了模式（例如接著問名字），重畫一次把狀態列上的問句換掉
        this.render();
        return;
      }
      if (yes) {
        this.doDelete();
      } else {
        this.mode = "nav";
        this.confirmTarget = null;
        this.confirmTargets = null;
        this.render();
      }
      return;
    }

    /*
     * 使用者的鍵位覆寫（設定裡的 map / unmap，解析在 core/keymap.js）。
     *
     * 放在這個位置而不是更前面：輸入模式（搜尋、篩選、重新命名）在上面就 return 了，
     * 所以**打字永遠不會被 remap 影響** —— 那是這個功能最容易出事的地方。
     *
     * 兩個前綴不 remap：assign 與 ' 收的是**字面上的那個字母**（指定／跳到書籤的
     * 快捷字母），換掉的話那幾個字母就沒辦法拿來當書籤快捷鍵了。
     */
    if (!ev.__yaziRemapped && this.pending !== "assign" && this.pending !== "'") {
      const km = this.keymap();
      if (km.unmap[key]) {
        this.swallow(ev);
        return;
      }
      const target = km.map[key];
      if (target) {
        this.swallow(ev);
        /* 重播目標鍵：走同一支 handleKey，所以前綴、pending、which-key 卡全部照常。
           __yaziRemapped 擋掉二次 remap，也就擋掉了 `map a b` ＋ `map b a` 的無限迴圈。 */
        for (const ch of target) {
          this.handleKey({
            key: ch,
            type: "keydown",
            __yaziRemapped: true,
            preventDefault() {},
            stopPropagation() {},
            stopImmediatePropagation() {},
          });
        }
        return;
      }
    }

    /* 多鍵序列的第二顆（gg / gf / cc / ,x / m+字母 / M+字母 / '+字母） */
    if (this.pending) {
      this.swallow(ev);
      const p = this.pending;
      this.pending = null;
      // assign 要吃 Backspace / Delete（清除快捷字母），其餘前綴只收單一字元
      const allowed = key.length === 1 || (p === "assign" && (key === "Backspace" || key === "Delete"));
      if (key === "Escape" || !allowed) {
        this.render();
        return;
      }
      this.resolvePending(p, key);
      return;
    }

    /*
     * 只有這兩個 Ctrl 組合自己處理（對齊 yazi 的 <C-a> 全選 / <C-r> 反選）。
     * 其餘組合鍵一律放行 —— modal 開著時 Ctrl+P 之類還是要能用。
     */
    if ((this.view === "files" || this.listSelectable()) &&
        ev.ctrlKey && !ev.altKey && !ev.metaKey && (key === "a" || key === "r")) {
      this.swallow(ev);
      if (key === "a") this.selectAll(true);
      else this.invertSelection();
      this.render();
      return;
    }

    /* 預覽捲動的 vim 組（見 seekPreview）。不重畫——只動 scrollTop，重畫會把捲動位置歸零 */
    if (ev.ctrlKey && !ev.altKey && !ev.metaKey && PREVIEW_SCROLL_KEYS[key]) {
      this.swallow(ev);
      const [unit, dir] = PREVIEW_SCROLL_KEYS[key];
      this.seekPreview(unit, dir);
      return;
    }

    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;   // 組合鍵放行給 Obsidian

    /*
     * 說明頁開著時，/ 是「在說明裡找」而不是「篩選檔案」—— 說明頁蓋住整個版面，
     * 底下那份檔案清單此刻根本看不到，篩選它沒有意義。
     * 其他鍵照原本的路走（? 關閉、Esc 退一層），所以這裡只攔這一顆。
     */
    if (this.showHelp && key === "/") {
      this.swallow(ev);
      this.mode = "helpfilter";
      this.inputLabelEl.setText(this.t("ui.helpFilterLabel", "Find in help: "));
      this.inputEl.value = this.helpFilter || "";
      this.inputWrapEl.show();
      this.inputEl.focus();
      this.inputEl.select();
      this.render();
      return;
    }

    /* 清單檢視（分頁 / 書籤 / 最近） */
    if (this.view !== "files") {
      this.swallow(ev);
      switch (key) {
        case "j": case "ArrowDown": this.move(1); break;
        case "k": case "ArrowUp": this.move(-1); break;
        case "G": this.goEdge(true); break;
        case "d": this.move(HALF_PAGE); break;
        case "u": this.move(-HALF_PAGE); break;
        // 清單檢視的右欄一樣是預覽（全文搜尋結果尤其長），捲動鍵比照檔案檢視
        case "J": this.seekPreview("seek", 1); break;
        case "K": this.seekPreview("seek", -1); break;
        case "PageDown": this.seekPreview("page", 1); break;
        case "PageUp": this.seekPreview("page", -1); break;
        // 關聯檢視的 Enter / l 是「游標跳過去，人留在 yazi」（見 openRelations）；
        // o 在哪裡都是「在 Obsidian 開啟」，所以這裡兩者要分開
        case "l": case "Enter":
          if (this.view === "relations") this.enterRelation();
          else if (this.view === "views") this.runView((this.listCurrent() || {}).viewDef);
          else this.activateListItem("current");
          break;
        case "o": this.activateListItem("current"); break;
        case "O": this.openMenu(); break;
        case "S": this.pending = "sort"; this.render(); break;
        case "i":
        case "Tab":
          /*
           * 回去改查詢。關鍵字與條件都原封留著 —— 「結果出來了但想再收窄一點」
           * 是搜尋最常見的下一步，不該逼人從頭打一次。
           * gd 沒有組合卡（見 openSearch 的說明），就只是回到底部輸入列。
           */
          if (this.view === "search") this.reopenComposer();
          break;
        case "/":
          // 在現有結果裡再過濾一層
          this.mode = "listfilter";
          this.inputLabelEl.setText(this.t("ui.filterInResults", "Filter in results: "));
          this.inputEl.value = this.listFilter || "";
          this.inputWrapEl.show();
          this.inputEl.focus();
          this.render();
          break;
        case "t": this.activateListItem("tab"); break;
        case "x": this.removeListItem(); break;
        case "X": this.undoCloseTab(); break;
        /*
         * 多選：跟檔案檢視同一套鍵（Space 切換並下移、v / V 成段選取／取消）。
         * 只在 x 有意義的那幾種清單收 —— 其他清單選起來也沒有能對它們做的事，
         * 給了只會讓人以為接下來有東西可按。
         *
         * ⚠️ v / V 因此會蓋掉「按該筆的快捷字母直接開」（下面的 default）對字母
         * v / V 的支援 —— 這條規則本來就是這樣：switch 接過的字母一律優先
         * （d / u / x / t / R… 早就是了），要從任何地方跳書籤請用 ' + 字母。
         */
        case " ":
          if (this.listSelectable()) {
            this.toggleListSelect(this.listCurrent());
            this.move(1);
          }
          break;
        case "v": if (this.listSelectable()) this.toggleVisual(1); break;
        case "V": if (this.listSelectable()) this.toggleVisual(-1); break;
        case "g": this.pending = "g"; this.render(); break;
        case "y": this.pending = "y"; this.render(); break;
        case "T": this.openList("tabs"); break;
        case "b": this.openList("bookmarks"); break;
        case "m":
          // 書籤／檢視清單裡的 m ＝「指定快捷字母」，下一顆鍵就是那個字母
          if (this.view === "bookmarks") { this.pending = "assign"; this.render(); }
          else if (this.view === "views") { this.pending = "vassign"; this.render(); }
          break;
        case "e":
          // 檢視清單裡的 e ＝把這個檢視載回組合卡去改條件（改完 s 用同名存回去）
          if (this.view === "views") this.editView((this.listCurrent() || {}).viewDef);
          break;
        // R ＝改名，跟檔案檢視的 R 同一顆（那邊改檔名，這邊改書籤自己的名字）
        case "R":
          if (this.view === "bookmarks") this.renameBookmark();
          else if (this.view === "views") this.renameView();
          break;
        // 搜尋結果裡的 s ＝把這次搜尋存成檢視。只在搜尋結果有意義，
        // 其他清單（分頁、書籤…）沒有「條件」可存
        case "s":
          // 編輯檢視中從結果頁按 s ＝存回原本那一筆，不是存新的
          if (this.view === "search") {
            if (this.editingView) this.saveEditedView();
            else this.saveCurrentView();
          }
          break;
        /*
         * , 前綴在清單檢視裡原本整個沒接 —— 於是 ,p（切換渲染預覽）在搜尋結果裡
         * 按了完全沒反應，而那正是最需要它的地方（全文搜尋結果又長又是純文字）。
         */
        case ",": this.pending = ","; this.render(); break;
        case "r": this.pending = "r"; this.render(); break;
        case "?": this.showHelp = !this.showHelp; this.render(); break;
        // h ＝退回上一個地方（最底層就不動）；q ＝一律關掉視窗（yazi 的 quit）；
        // Esc 走 escapeBack 的階梯（先收狀態、再退地方、最後關窗）
        case "h": this.goBackLayer(); break;
        case "q": this.forceClose(); break;
        case "Escape": this.escapeBack(); break;
        default:
          // 書籤／檢視清單裡直接按該筆的字母也能開
          if (this.view === "bookmarks" && key.length === 1 && this.plugin) {
            if (this.plugin.bookmarkByKey(key)) this.jumpToBookmark(key);
          } else if (this.view === "views" && key.length === 1 && this.plugin) {
            if (this.plugin.viewByKey(key)) this.runViewByKey(key);
          }
          break;
      }
      return;
    }

    /* 檔案檢視 */
    switch (key) {
      case "j": case "ArrowDown":  this.swallow(ev); this.move(1); break;
      case "k": case "ArrowUp":    this.swallow(ev); this.move(-1); break;
      case "h": case "ArrowLeft":  this.swallow(ev); this.goParent(); break;
      case "l": case "ArrowRight":
      case "Enter":                this.swallow(ev); this.enter("current"); break;
      // o / O 對齊 yazi：小寫＝用預設方式開（在 Obsidian 裡開，同 l / Enter），
      // 大寫＝選單，選單裡的東西全在 vault 外面（見 OPEN_ACTIONS）。
      // 排序選單因此讓位到 S。
      case "o":                    this.swallow(ev); this.enter("current"); break;
      case "O":                    this.swallow(ev); this.openMenu(); break;
      case "S":                    this.swallow(ev); this.pending = "sort"; this.render(); break;
      case "G":                    this.swallow(ev); this.goEdge(true); break;
      case "d":                    this.swallow(ev); this.move(HALF_PAGE); break;
      case "u":                    this.swallow(ev); this.move(-HALF_PAGE); break;
      // J / K：捲右邊的預覽欄（yazi 的 seek 5 / seek -5），游標不動
      case "J":                    this.swallow(ev); this.seekPreview("seek", 1); break;
      case "K":                    this.swallow(ev); this.seekPreview("seek", -1); break;
      /*
       * PageUp / PageDown 也捲預覽，不是移游標 —— 這台鍵盤上它們就在方向鍵旁邊，
       * 而「看右邊那篇長文」才是會想用到整頁捲動的情境；游標要翻頁有 d / u。
       * ⚠️ 跟 yazi 本身不同（那邊 PageUp 是 arrow -100%，移游標）。
       */
      case "PageDown":             this.swallow(ev); this.seekPreview("page", 1); break;
      case "PageUp":               this.swallow(ev); this.seekPreview("page", -1); break;
      case "t":                    this.swallow(ev); this.enter("tab"); break;
      case "s":                    this.swallow(ev); this.enter("vsplit"); break;
      case "i":                    this.swallow(ev); this.enter("hsplit"); break;
      case "T":                    this.swallow(ev); this.openList("tabs"); break;
      case "b":                    this.swallow(ev); this.openList("bookmarks"); break;
      // z：常用（frecency）。對齊 yazi 的 z（zoxide）—— 那邊列的是「常去的資料夾」，
      // 這裡多列常開的檔案，因為在 vault 裡「常回去的地方」很多時候就是某一篇筆記。
      case "z":                    this.swallow(ev); this.openList("frecency"); break;
      // 多選（對齊 yazi）：Space 切換並下移、v/V 成段選取／取消
      case " ":                    this.swallow(ev); this.toggleSelect(this.current()); this.move(1); break;
      case "v":                    this.swallow(ev); this.toggleVisual(1); break;
      case "V":                    this.swallow(ev); this.toggleVisual(-1); break;
      // 搬移／複製（對齊 yazi 的 y / x / p / P / Y / X）。
      // x / X 原本是「關閉 / 還原 Obsidian 分頁」，已搬到 ,x / ,X。
      case "y":                    this.swallow(ev); this.yank(false); break;
      case "x":                    this.swallow(ev); this.yank(true); break;
      case "p":                    this.swallow(ev); this.paste(false); break;
      case "P":                    this.swallow(ev); this.paste(true); break;
      case "Y": case "X":          this.swallow(ev); this.unyank(); break;
      case "a":                    this.swallow(ev); this.newNote(); break;
      case "A":                    this.swallow(ev); this.newFolder(); break;
      // r 讓給前綴（rf ＝ 最近開啟的檔案），重新命名改用 R。
      // 兩者不能共存：r 一旦要等第二顆鍵，就沒辦法同時是一個立即動作。
      case "R":                    this.swallow(ev); this.rename(); break;
      case "D":                    this.swallow(ev); this.askDelete(); break;
      // m / M 直接加書籤，不再是等第二顆鍵的前綴（快捷字母到清單裡再指定）
      case "m":                    this.swallow(ev); this.addBookmark(this.current() || this.cwd); break;
      case "M":                    this.swallow(ev); this.addBookmark(this.cwd); break;
      case "g": case "r": case "c": case ",":
      case "'":                    this.swallow(ev); this.pending = key; this.render(); break;
      case "?":                    this.swallow(ev); this.showHelp = !this.showHelp; this.render(); break;
      case "/":
        this.swallow(ev);
        this.mode = "filter";
        this.inputLabelEl.setText(this.t("ui.filterLabel", "Filter: "));
        this.inputEl.value = this.filter;
        this.inputWrapEl.show();
        this.inputEl.focus();
        this.render();
        break;
      // q ＝一律關窗。走 forceClose 而不是 close()：close() 會被攔去退層（見 close 的註解），
      // 從書籤跳進某個資料夾之後按 q 會變成「退回書籤」而不是關掉
      case "q":                    this.swallow(ev); this.forceClose(); break;
      case "Escape":                this.swallow(ev); this.escapeBack(); break;
      default:
        // 沒對應動作的可見字元也一律吃掉。不吃的話會漏回 document，例如 ',' 會被
        // leader-hotkeys 當成序列開頭，在瀏覽器裡按錯鍵就可能誤觸背景的命令。
        if (key.length === 1) this.swallow(ev);
        break;
    }
  }

  resolvePending(prefix, key) {
    if (prefix === "g") {
      if (key === "g") this.goEdge(false);
      else if (key === "t") this.openSearch("text");
      else if (key === "f") this.openSearch("file");
      else if (key === "d") this.openSearch("dir");
      else if (key === "o") this.openOutline();
      else if (key === "r") this.openRelations();
      else if (key === "v") this.openList("views");
      // 背景開新分頁原本是 gf（Surfingkeys 的 gf），gf 讓給「搜檔名」之後搬到 gb
      else if (key === "b") this.enter("tab-bg");
      else this.render();
      return;
    }
    if (prefix === "c") {
      if (key === "c" || key === "d" || key === "f" || key === "n" || key === "r") this.copyPath(key);
      else this.render();
      return;
    }
    if (prefix === "open") { this.runOpenAction(key); return; }
    if (prefix === ",") {
      if (key === "x") this.closeActiveTab();
      else if (key === "X") this.undoCloseTab();
      else if (key === "p") this.toggleRenderMd();
      else this.render();
      return;
    }
    if (prefix === "r") {
      if (key === "f") this.openList("recent");
      else this.render();
      return;
    }
    if (prefix === "sort") { this.applySort(key); return; }
    if (prefix === "assign") { this.assignBookmarkKey(key); return; }
    if (prefix === "vassign") { this.assignViewKey(key); return; }
    if (prefix === "'") { this.jumpToBookmark(key); return; }
    this.render();
  }

  // 攔到底：stopPropagation 之後連 bubble 階段都不會再回到 document，
  // sidebar-keyboard-navigation 那個 bubble listener 就吃不到這顆鍵。
  swallow(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
  }

  /* ── 繪製 ── */

  /*
   * render() 包 try/catch 的理由跟 onOpen 一樣：三個欄位的 div 是先建好的，
   * 所以 render() 裡任何例外的外顯症狀都是「三個空欄」，完全看不出哪裡壞了。
   * 這裡把錯誤直接畫進主欄並寫進 console。
   */
  render() {
    try {
      const textMode = this.view === "search" && this.searchKind === "text";
      this.contentEl.toggleClass("is-help", !!this.showHelp);
      this.contentEl.toggleClass("is-text-search", !this.showHelp && textMode);
      // which-key 卡是浮在最上層的獨立元素，所以在分支之前畫 —— 說明頁、
      // 組合搜尋那幾條路都會 return，寫在後面就會有漏畫的分支
      this.renderKeyMenu();

      // 說明頁直接吃掉三欄 —— 按鍵那麼多，擠在一欄要捲很久才找得到
      if (this.showHelp) {
        this.colsEl.show();
        // 搜尋說明時輸入列要搬回底部那一列（組合卡可能把它借走了）
        if (this.inputWrapEl.parentElement !== this.barRowEl) {
          this.barRowEl.insertBefore(this.inputWrapEl, this.hintEl);
        }
        this.composerEl.hide();
        this.barEl.show();
        this.renderHelp();
        this.renderBar();
        return;
      }
      /*
       * 組合搜尋：三欄與底部狀態列整個讓位給置中的卡。
       * 「還沒送出就不顯示結果」是刻意的 —— 結果一直在旁邊跳動會搶走注意力，
       * 而你此刻要做的事是把條件組對。筆數（2378 → 4）已經足夠當回饋。
       */
      if (this.view === "search" && this.composing) {
        this.renderComposer();
        return;
      }
      this.composerEl.hide();
      this.colsEl.show();
      this.barEl.show();
      // 離開組合模式時把輸入列搬回底部那一列（它是常駐元素，只搬不重建）
      if (this.inputWrapEl.parentElement !== this.barRowEl) {
        this.barRowEl.insertBefore(this.inputWrapEl, this.hintEl);
      }
      if (this.view === "files") this.renderFiles();
      else this.renderList();
      this.renderPreview();
      this.renderBar();
    } catch (e) {
      console.error("[yazi-explorer] render failed", e);
      try {
        this.mainEl.empty();
        this.mainEl.createDiv({ cls: "yazi-empty", text: this.t("ui.renderFailed", "Render failed: {error}", { error: msg(e) }) });
      } catch (e2) {}
    }
  }

  renderFiles() {
    this.renderColumn(this.parentEl, this.entries(this.cwd.parent), this.cwd.path, false);
    this.renderColumn(this.mainEl, this.mainList(), this.cursorPath, true);
  }

  renderColumn(el, list, activePath, isMain) {
    el.empty();
    if (!list.length) {
      // 在 vault 根目錄時父層欄本來就該是空白，不要顯示「（空）」
      const atRoot = !isMain && !this.cwd.parent;
      if (!atRoot) el.createDiv({ cls: "yazi-empty", text: this.t("ui.empty", "(empty)") });
      return;
    }
    let activeEl = null;
    for (const f of list) {
      const folder = isFolder(f);
      const row = el.createDiv({ cls: "yazi-row" + (folder ? " is-folder" : "") });
      const picked = isMain && this.sel.has(f.path);
      if (picked) row.addClass("is-selected");
      /*
       * 工作專案的 frontmatter 裝飾。分類圖示**取代**原本那顆 `·`，不另開欄位 ——
       * 主欄寬度就這麼多，多一格就是少一格檔名。選取中時 ✓ 優先：選取是暫時狀態，
       * 而「哪幾個被我選起來了」比「它是什麼類型」更急著要看見。
       */
      const info = fmInfo(f);
      /*
       * 日記的心情與標題（inline field，見 diaryInfo）。工作專案的 frontmatter
       * 裝飾優先：同一個檔不會兩套都有，真的都有時 type 是比較明確的那個。
       * 心情 emoji 跟分類圖示一樣**佔原本那顆 `·`**，不另開欄位。
       */
      /*
       * 規則可以把主文字換成某個 frontmatter 欄位，並把檔名縮到右邊的小字 ——
       * 日記就是這樣用的：檔名只是日期，真正要認的是那天寫了什麼。
       * 只在主欄換：父層欄只有 1fr 寬，它是拿來定位「我在哪一層」的，不是拿來讀的。
       */
      const title = isMain && info && info.title ? info.title : "";
      // 右邊的小字只在「標題真的換成某個欄位」時才畫（見 decorate 的 titleFromField）
      const sub = isMain && info && info.titleFromField ? info.subtitle : "";
      if (info && info.dim) row.addClass("is-fm-dim");
      row.createSpan({
        cls: "yazi-icon",
        text: picked ? "✓" : folder ? "▸" : (info && info.icon) || "·",
      });
      row.createSpan({ cls: "yazi-name", text: title || f.name });
      if (title && sub) row.createSpan({ cls: "yazi-sub is-date", text: sub });
      if (info) this.renderFmTail(row, info);
      // 在剪貼簿裡的項目標一下：貼上前看得出「等一下要搬的是哪幾個」
      const clip = isMain ? this.clip() : null;
      if (clip && clip.paths.indexOf(f.path) >= 0) {
        row.addClass(clip.cut ? "is-cut" : "is-yanked");
        row.createSpan({ cls: "yazi-mark", text: clip.cut ? "✂" : "⧉" });
      }
      if (!folder && f.extension && f.extension !== "md") {
        row.createSpan({ cls: "yazi-ext", text: f.extension });
      }
      if (f.path === activePath) {
        row.addClass(isMain ? "is-cursor" : "is-active");
        activeEl = row;
      }
      row.addEventListener("click", () => {
        // 父層欄的項目不在 mainList() 裡，直接設 cursorPath 會讓 current() 找不到
        // 而退回第一項、進錯目標。所以先把當前層切成該項目所在的資料夾。
        if (!isMain) {
          this.memo.set(this.cwd.path, this.cursorPath);
          this.cwd = f.parent || this.app.vault.getRoot();
          this.filter = "";
        }
        this.cursorPath = f.path;
        this.enter("current");
      });
    }
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  /*
   * 貼右的那一小段：📌 釘選 ／ ⏰ 逾期 ／ 狀態 ／ P0-P1。
   * 順序是固定的，這樣眼睛掃右緣時每一列的同一個位置都是同一種資訊。
   */
  renderFmTail(row, info) {
    if (!info.status && !info.prio && !info.overdue && !info.pinned) return;
    const tail = row.createSpan({ cls: "yazi-fm" });
    if (info.pinned) tail.createSpan({ cls: "yazi-fm-pin", text: "📌" });
    if (info.overdue) tail.createSpan({ cls: "yazi-fm-due", text: "⏰" });
    if (info.status) tail.createSpan({ cls: "yazi-fm-status", text: info.status });
    if (info.prio) {
      tail.createSpan({ cls: "yazi-fm-prio is-" + info.prio.toLowerCase(), text: info.prio });
    }
  }

  /*
   * 建議列（取代左欄的圖例）。每一列長這樣：
   *     ^p   🔴 優先度                     ← 欄位：右邊那顆就是它的直接鍵
   *     🔴   優先度 = P0 Urgent      3     ← 值：右邊是 vault 裡實際有幾筆
   * 直接鍵印在選單上，是刻意的：這樣「快的那條路」不需要另外去背，用久了自然記得。
   */
  renderSuggest(el) {
    const box = el.createDiv({ cls: "yazi-help yazi-sug" });
    const spec = this.sugField ? FACET_BY_ID[this.sugField] : null;
    box.createDiv({
      cls: "yazi-help-title",
      text: spec
        ? spec.icon + " " + this.t("ui.pickValue", "{field}: pick a value", { field: spec.label })
        : this.t("ui.addCondition", "Add a condition · Enter/Tab accepts · Esc cancels"),
    });
    if (!this.sug || !this.sug.items.length) {
      box.createDiv({ cls: "yazi-empty", text: spec ? this.t("ui.noValues", "no matching values") : this.t("ui.noFields", "no matching fields") });
      return;
    }
    this.sug.items.forEach((it, i) => {
      /*
       * ⚠️ 只有「已經選進去」（active）才反白。
       * 自動冒出來的建議如果也反白第一列，看起來就像焦點已經在建議上，
       * 人會以為 Enter 會收下它 —— 而實際上 Enter 是送出。畫面與行為不一致
       * 比兩者都笨拙更糟，所以沒選進去就一列都不反白。
       */
      const on = this.sug.active && i === this.sug.index;
      const row = box.createDiv({ cls: "yazi-sug-row" + (on ? " is-cursor" : "") });
      if (it.type === "field") {
        row.createSpan({ cls: "yazi-sug-key", text: "^" + it.spec.key });
        row.createSpan({ cls: "yazi-sug-text", text: it.spec.icon + " " + it.spec.label });
      } else {
        row.createSpan({ cls: "yazi-sug-key", text: it.spec.icon });
        /*
         * 範圍自己就讀得懂（📁 路徑 / 🌐 全 vault），不必再加「範圍 = 」前綴；
         * 路徑只印最後兩層，否則一列就把整欄吃掉。
         */
        const text =
          it.spec.kind === "path"
            ? it.value
              ? "📁 " + shortPath(it.value)
              : this.t("ui.allVault", "🌐 whole vault")
            : it.spec.label + " = " + (it.value || "…");
        row.createSpan({ cls: "yazi-sug-text" + (it.bad ? " is-bad" : ""), text: text });
        if (it.count != null) row.createSpan({ cls: "yazi-sug-count", text: String(it.count) });
        if (it.note) {
          row.createSpan({ cls: "yazi-sug-note" + (it.bad ? " is-bad" : ""), text: it.note });
        }
      }
      row.addEventListener("click", () => {
        this.sug.index = i;
        this.acceptSuggest();
      });
    });
  }

  /*
   * 組合搜尋的置中卡。一張卡裡由上到下：標題 → 查詢盒（條件 chip ＋ 輸入列）
   * → 筆數 → 建議 → 提示。全部在同一個視線範圍內，這是這次改版的全部重點。
   */
  renderComposer() {
    this.colsEl.hide();
    this.barEl.hide();
    this.composerEl.show();

    const what = this.searchKind === "text" ? this.t("ui.searchTextTitle", "Full-text search")
      : this.searchKind === "dir" ? this.t("ui.searchDirTitle", "Folder search")
      : this.t("ui.searchFileTitle", "File name search");
    // 編輯檢視時標題換成「正在編輯 X」＋三顆鍵的去向 —— 同一張卡兩種用途，不標清楚就會按錯 Enter
    const title = this.editingView
      ? "✏️ " + this.t("ui.editingView", "Editing view “{name}” — Enter saves · Ctrl+Enter previews the results · Esc discards", { name: this.editingView.name })
      : "🔍 " + what;
    this.csTitleEl.setText(title + (this.indexing ? "　·　" + this.t("ui.indexing", "indexing…") : ""));

    // 輸入列搬進查詢盒。**只在還沒搬進來時動** —— 每次重繪都搬的話，
    // 元素被拔起來重插，焦點與中文組字狀態都會掉
    if (this.inputWrapEl.parentElement !== this.csBoxEl) {
      this.csBoxEl.appendChild(this.inputWrapEl);
      this.inputWrapEl.show();
      this.inputEl.focus();
    }

    // 範圍一律顯示，所以這一列永遠有東西，不再需要 show/hide
    this.csChipsEl.empty();
    this.csChipsEl.show();
    this.renderScopeChip(this.csChipsEl);
    this.facets.forEach((fc, i) => {
      const chip = this.csChipsEl.createSpan({ cls: "yazi-chip" });
      chip.createSpan({ text: this.facetLabel(fc) });
      const x = chip.createSpan({ cls: "yazi-chip-x", text: "✕" });
      x.addEventListener("click", () => {
        this.facets.splice(i, 1);
        this.listIndex = 0;
        this.buildSearchList();
        this.render();
      });
    });

    /*
     * 筆數 ＋ 前幾筆預覽。只給數字是不夠的 —— 條件挑錯（例如撞到同名但不同專案的
     * 標籤）時數字看起來完全正常，要看到「是哪幾筆」才知道組對了沒。
     * 重算在節流中時明說「計算中」，不要讓上一個字的結果假裝成現在的結果。
     */
    const n = this.listItems.length;
    const head = this.searchTotal ? this.searchTotal + " → " : "";
    this.csMetaEl.setText(head + (this.searchPending
      ? this.t("ui.counting", "counting…")
      : this.t("ui.nResults", "{count} results", { count: n })));
    this.csMetaEl.toggleClass("is-stale", !!this.searchPending);

    this.csSugEl.empty();
    if (this.sug || this.sugField) this.renderSuggest(this.csSugEl);
    this.renderComposerPreview();

    /*
     * 提示只留最關鍵的幾顆。其餘（^p ^s ^f…）刻意不列在這裡 ——
     * 它們全都印在 Tab 選單的每一列上，在那裡看到才學得起來；
     * 列在這邊只會變成又一塊要掃的文字，正是上一版難用的原因。
     */
    const bits = [];
    if (this.sug && this.sug.active) {
      // 已經選進建議裡：這時 Enter 的意思變了，就要當場說清楚
      bits.push(this.t("ui.hintAcceptSug", "Enter accepts this condition"), this.t("ui.hintDropSug", "Esc drops the suggestion"));
    } else {
      bits.push(this.sug ? this.t("ui.hintTabTop", "Tab accepts the top one · ↑↓ to choose") : this.t("ui.hintTabAdd", "Tab adds a condition"));
      if (this.facets.length) bits.push(this.t("ui.hintBackspace", "Backspace removes a condition"));
      bits.push(n ? this.t("ui.hintSubmit", "Enter runs it ({count})", { count: n }) : this.t("ui.noMatch", "(nothing matches)"), this.t("ui.cancel", "Esc to cancel"));
    }
    this.csHintEl.setText(bits.join("　·　"));
  }

  /*
   * 組合卡底部的結果預覽：只列前 COMPOSER_PREVIEW 筆。
   * 目的是「確認條件組對了沒」，不是「瀏覽結果」—— 所以刻意不可捲、不可選，
   * 列多了就變成結果清單，那是送出之後才該佔版面的東西。
   */
  renderComposerPreview() {
    const el = this.csPreviewEl;
    el.empty();
    el.toggleClass("is-stale", !!this.searchPending);
    if (this.indexing) {
      el.createDiv({ cls: "yazi-empty", text: this.t("ui.buildingIndex", "Building the full-text index…") });
      return;
    }
    const items = this.listItems.slice(0, COMPOSER_PREVIEW);
    if (!items.length) {
      el.createDiv({ cls: "yazi-empty", text: this.t("ui.noMatch", "(nothing matches)") });
      return;
    }
    for (const item of items) {
      const row = el.createDiv({ cls: "yazi-row is-preview" });
      const info = item.file ? fmInfo(item.file) : null;
      if (info && info.dim) row.addClass("is-fm-dim");
      row.createSpan({ cls: "yazi-icon", text: info ? info.icon : "·" });
      row.createSpan({ cls: "yazi-name", text: item.label });
      if (item.sub) row.createSpan({ cls: "yazi-sub", text: shortPath(item.sub) });
      if (info) this.renderFmTail(row, info);
    }
    const more = this.listItems.length - items.length;
    if (more > 0) el.createDiv({ cls: "yazi-cs-more", text: this.t("ui.andMore", "⋯ {count} more", { count: more }) });
  }

  /*
   * 範圍 chip。**一律顯示**（包含「🌐 全 vault」）——「我在哪裡搜」不該用猜的，
   * 而且正因為它一直看得見，預設值才可以是「觸發搜尋時所在的資料夾」而不算偷改行為。
   * ✕ ＝ 放寬成全 vault（不是「刪掉這個條件」，範圍永遠存在，只是可寬可窄）。
   */
  renderScopeChip(el) {
    const chip = el.createSpan({ cls: "yazi-chip is-scope" });
    chip.createSpan({ text: this.scopePath ? "📁 " + shortPath(this.scopePath) : this.t("ui.allVault", "🌐 whole vault") });
    if (!this.scopePath) return;
    const x = chip.createSpan({ cls: "yazi-chip-x", text: "✕" });
    x.addEventListener("click", () => {
      this.scopePath = "";
      this.fvCache = null;
      this.listIndex = 0;
      this.buildSearchList();
      this.render();
    });
  }

  /* 結果階段的摘要列：關鍵字＋範圍＋條件＋筆數＋「i 改條件」，永遠看得見 */
  renderChips() {
    if (!this.facetEl) return;
    this.facetEl.empty();
    // 組合中的話卡片自己會畫，這一列不重複
    if (this.view !== "search" || this.composing) {
      this.facetEl.hide();
      return;
    }
    this.facetEl.show();
    const q = (this.searchQuery || "").trim();
    if (q) this.facetEl.createSpan({ cls: "yazi-chip is-query", text: "🔍 " + q });
    this.renderScopeChip(this.facetEl);
    this.facets.forEach((fc, i) => {
      const chip = this.facetEl.createSpan({ cls: "yazi-chip" });
      chip.createSpan({ text: this.facetLabel(fc) });
      const x = chip.createSpan({ cls: "yazi-chip-x", text: "✕" });
      x.addEventListener("click", () => {
        this.facets.splice(i, 1);
        this.listIndex = 0;
        this.buildSearchList();
        this.render();
      });
    });
    // 回去改條件的路要一直看得見，否則「結果出來了但我想改」會變成重打一次
    if (this.searchKind !== "dir") {
      this.facetEl.createSpan({ cls: "yazi-chip-hint", text: this.t("ui.changeConditions", "i / Tab to change conditions") });
    }
    /* 「全部 → 現在」。加條件之前就看得到會剩幾筆，不必送出了才後悔 */
    this.facetEl.createSpan({
      cls: "yazi-count",
      text: this.searchTotal ? this.searchTotal + " → " + this.listItems.length : String(this.listItems.length),
    });
  }

  renderList() {
    const searchTitle =
      this.searchKind === "dir" ? this.t("ui.titleSearchDir", "Search: folders")
        : this.searchKind === "text" ? this.t("ui.titleSearchText", "Search: full text")
        : this.t("ui.titleSearchFile", "Search: file names");
    const title =
      this.view === "search"
        ? searchTitle
        : this.view === "outline"
        ? this.t("ui.titleOutline", "Outline: {name}", { name: this.outlineFile ? this.outlineFile.basename : "" })
        : this.view === "relations"
        ? this.t("ui.titleRelations", "Relations: {name}", { name: this.relFile ? this.relFile.basename : "" })
        : this.view === "views"
        ? this.t("ui.titleViews", "Saved views")
        : { tabs: this.t("ui.titleTabs", "Tabs"), bookmarks: this.t("ui.titleBookmarks", "Bookmarks"),
            recent: this.t("ui.titleRecent", "Recent"), frecency: this.t("ui.titleFrecency", "Most visited") }[
            this.view
          ] || "";
    this.parentEl.empty();
    /*
     * 左欄平常是按鍵圖例。建議列開著時由建議取代它 —— 兩者都在回答「我現在能做什麼」，
     * 但建議是此刻正在進行的動作，優先。圖例常駐這件事本身就是功能的發現機制：
     * 什麼都不按就看得到「Tab 加條件」，所以不會有「有功能但沒人知道」的狀態。
     */
    // 建議列只屬於組合卡（mode search）；送出之後就算 sug 還沒清，也不該畫出來蓋掉圖例
    if (this.view === "search" && this.mode === "search" && (this.sug || this.sugField)) {
      this.renderSuggest(this.parentEl);
      this.renderListMain();
      return;
    }
    // 關聯檢視：左欄是「上一跳」—— 跟檔案檢視的父層資料夾欄同一個意思（我從哪來）。
    // 沒有上一跳（用命令直接開進來）才放圖例。
    if (this.view === "relations" && this.renderPrevHop(this.parentEl)) {
      this.renderListMain();
      return;
    }
    const legend = this.parentEl.createDiv({ cls: "yazi-help" });
    legend.createDiv({ cls: "yazi-help-title", text: title });
    const keys =
      this.view === "search"
        ? [
            // 這裡是**結果**階段的圖例。加條件那組 ^ 鍵只在組合卡裡有效，
            // 列在這邊會變成「按了沒反應」的誤導，所以只給回去改條件的路。
            ["j / k", this.t("legend.move", "move")],
            ["Enter / l / o", this.t(this.searchKind === "dir" ? "legend.enterDir" : "legend.jumpFile")],
            ["t", this.t("legend.newTab", "open in a new tab")],
            ["/", this.t("legend.refine", "filter within these results")],
            ["i / Tab", this.t(this.searchKind === "dir" ? "legend.editQuery" : "legend.editQueryCond")],
            // 存成檢視就在這裡揭露 —— 這是唯一能存的畫面，圖例沒寫等於沒人找得到
            ["s", this.t("legend.saveView", "save this search as a view (gv lists them)")],
            ["S", this.t("legend.sort", "sort")],
          ]
        : this.view === "tabs"
        ? [["Enter / l / o", this.t("legend.switchTab", "switch to it")],
         ["x", this.t("legend.closeTab", "close this tab")],
         ["X", this.t("legend.reopenTab", "reopen the last closed one")]]
        : this.view === "bookmarks"
        ? [
            ["Enter / l / o", this.t("legend.jump", "jump there")],
            ["R", this.t("legend.renameBookmark", "rename this bookmark")],
            ["m + " + this.t("ui.letter", "letter"), this.t("legend.assignLetter", "assign a letter (m + Backspace clears it)")],
            [this.t("ui.letter", "letter"), this.t("legend.letterJump", "jump straight to that bookmark")],
            ["x", this.t("legend.deleteBookmark", "delete the bookmark")],
          ]
        : this.view === "frecency"
        ? [
            ["Enter / l / o", this.t("legend.enterOrOpen", "folder → go there; file → open")],
            ["t", this.t("legend.newTab", "open in a new tab")],
            ["x", this.t("legend.removeFrecency", "remove it from most visited")],
            ["/", this.t("legend.refineShort", "filter within the results")],
            ["（×N）", this.t("legend.frecencyCount", "how often you opened it; ranking is count × time decay")],
          ]
        : this.view === "views"
        ? [
            ["Enter / l / o", this.t("legend.viewRun", "run this search again")],
            ["e", this.t("legend.viewEdit", "edit its conditions in the search card; Enter saves back to this view")],
            ["R", this.t("legend.viewRename", "rename it")],
            ["m + " + this.t("ui.letter", "letter"), this.t("legend.assignLetter", "assign a letter (m + Backspace clears it)")],
            [this.t("ui.letter", "letter"), this.t("legend.viewLetter", "run that view straight away")],
            // 這裡刻意不列 s：那顆鍵只在搜尋結果裡有效，列在這邊會變成「按了沒反應」。
            // 怎麼新增寫在空清單的提示裡（ui.noViews）。
            ["x", this.t("legend.viewDelete", "delete the view")],
          ]
        : this.view === "relations"
        ? [
            ["Enter / l", this.t("legend.relEnter", "enter: its relations become the list (h steps back)")],
            ["o / t", this.t("legend.relOpen", "open it / in a new tab")],
            ["/", this.t("legend.refineShort", "filter within the results")],
          ]
        : this.view === "outline"
        ? [
            ["j / k", this.t("legend.outlineFollow", "move; the preview scrolls to that heading")],
            ["Enter / l / o", this.t("legend.outlineOpen", "open the note at this heading")],
            ["t", this.t("legend.newTab", "open in a new tab")],
            ["/", this.t("legend.outlineFilter", "filter the headings")],
          ]
        : [["Enter / l / o", this.t("legend.open", "open")], ["t", this.t("legend.newTab", "open in a new tab")]];
    /*
     * 退出那幾列照「地方 vs 狀態」兩個軸寫：h 退地方、Esc 先收狀態再退地方最後關窗、
     * q 一律關窗。最底層時 h 沒地方去，就不列它。
     */
    const back =
      this.view === "search"
        ? [["Esc", this.t("legend.escLayers", "back to the search card (conditions kept); Esc again leaves. Backspace drops a condition")],
           ["h", this.t("legend.backLayer", "back to where you came from")],
           ["q", this.t("legend.closeExplorer", "close the explorer")]]
        : this.layers.length
        ? [["h / Esc", this.t("legend.backLayer", "back to where you came from")],
           ["q", this.t("legend.closeExplorer", "close the explorer")]]
        : [["Esc / q", this.t("legend.closeExplorer", "close the explorer")]];
    /*
     * 多選那一列只在支援的清單上出現（見 LIST_REMOVE）。位置在各清單自己的圖例之後、
     * 退出那幾列之前 —— 它講的是「x 之前可以先做的事」，緊貼著 x 才讀得通。
     */
    const pick = this.listSelectable()
      ? [["<Space> / v", this.t("legend.pick", "select this row / a range — x then acts on all of them")]]
      : [];
    for (const [k, desc] of keys.concat(pick, back)) {
      const row = legend.createDiv({ cls: "yazi-help-row" });
      row.createSpan({ cls: "yazi-help-key", text: k });
      row.createSpan({ cls: "yazi-help-desc", text: desc });
    }
    this.renderListMain();
  }

  /*
   * 關聯檢視的左欄：上一跳。畫法照父層資料夾欄 —— 淡的一列列，目前的中心反白，
   * 讓人一眼看出「我是從哪一筆走進來的」。
   * 上一跳可能是檔案檢視（第一次 gr）或另一份關聯清單（走了不只一步）；
   * 其他種類的清單（書籤、搜尋結果）就照它們的項目畫。回傳 false ＝沒有上一跳。
   */
  renderPrevHop(el) {
    const prev = this.layers[this.layers.length - 1];
    if (!prev) return false;
    el.empty();
    const here = this.relFile ? this.relFile.path : null;
    if (prev.view === "files" && prev.cwd) {
      this.renderColumn(el, this.entries(prev.cwd), here, false);
      return true;
    }
    if (!Array.isArray(prev.listItems)) return false;
    let group = null;
    prev.listItems.forEach((it, idx) => {
      if (it.group && it.group !== group) {
        group = it.group;
        el.createDiv({ cls: "yazi-group", text: group });
      }
      const active = (it.path && it.path === here) || (!here && idx === prev.listIndex);
      const row = el.createDiv({ cls: "yazi-row is-preview" + (active ? " is-cursor" : "") });
      row.createSpan({ cls: "yazi-icon", text: it.icon || "·" });
      row.createSpan({ cls: "yazi-name", text: it.label });
    });
    return true;
  }

  /*
   * 右欄最上面那一條：游標所指那則筆記有哪幾組關聯、各幾筆。
   * 它回答的是「按 l 進去有沒有路」—— 沒有這條的話，要進去才知道是空的。
   */
  renderRelStrip(el, file) {
    const groups = this.relationGroupsFor(file);
    const strip = el.createDiv({ cls: "yazi-rel-strip" });
    if (!groups.length) {
      strip.createSpan({ cls: "yazi-rel-none", text: this.t("ui.relNone", "no relations — l leads nowhere") });
      return;
    }
    for (const g of groups) {
      const chip = strip.createSpan({ cls: "yazi-rel-chip" + (g.untyped ? " is-untyped" : "") });
      chip.createSpan({ cls: "yazi-rel-chip-label", text: g.label });
      chip.createSpan({ cls: "yazi-rel-chip-n", text: String(g.items.length) });
    }
  }

  // 清單檢視的中欄（從 renderList 拆出來，因為左欄有兩種畫法但中欄只有一種）
  renderListMain() {
    const textMode = this.view === "search" && this.searchKind === "text";

    this.mainEl.empty();
    if (textMode && this.listItems.length) {
      this.renderTextCards();
      return;
    }
    if (!this.listItems.length) {
      const hint = this.indexing
        ? this.t("ui.buildingIndex", "Building the full-text index…")
        : this.view === "search" && this.searchKind === "text" && !this.inputEl.value.trim()
        ? this.t("ui.typeToSearch", "Type to search the full text (space-separated words must all match)")
        : this.view === "outline"
        ? this.t("ui.noHeadings", "(no headings)")
        : this.view === "relations"
        ? this.t("ui.noRelations", "(nothing links to or from this note)")
        : this.view === "views"
        ? this.t("ui.noViews", "(no saved views yet — run a search with gt / gf / gd, then press s in the results to save it)")
        : this.t("ui.noItems", "(no items)");
      this.mainEl.createDiv({ cls: "yazi-empty", text: hint });
      return;
    }
    let activeEl = null;
    const outline = this.view === "outline";
    let group = null;
    this.listItems.forEach((item, idx) => {
      // 分組標題（目前只有關聯檢視會設 group）。標題本身不是清單項目 —— j/k 不會停在
      // 上面，/ 過濾掉整組時它也跟著不見，因為它是跟著第一筆畫出來的。
      if (item.group && item.group !== group) {
        group = item.group;
        this.mainEl.createDiv({ cls: "yazi-group", text: group });
      }
      const row = this.mainEl.createDiv({ cls: "yazi-row" });
      // 搜尋／清單結果也吃 frontmatter 裝飾：找 task 的時候「哪張是 P0、哪張已完成」
      // 跟檔名一樣重要，沒理由只有檔案檢視看得到。
      // 大綱例外：每列是同一個檔的標題，把那個檔的裝飾重複畫在每一列只是噪音。
      const info = item.file && !outline ? fmInfo(item.file) : null;
      // ⚠️ 一次一個 class：addClass 走 DOMTokenList.add()，帶空白的字串會直接丟例外
      if (outline) {
        row.addClass("is-outline");
        row.addClass("yazi-outline-d" + (item.depth || 0));
      }
      if (item.collapsed) row.addClass("is-folder");   // 收合的一組：畫成資料夾，l 進去＝展開
      if (info && info.dim) row.addClass("is-fm-dim");
      /*
       * 檢視與書籤是兩行的：名稱一行、說明（搜尋條件／路徑）一行。
       * 這兩種清單的名稱是**使用者自己取的**，擠成一行時先被截掉的就是它，
       * 而那正是用來認出「這是什麼」的東西。
       */
      if (this.view === "views" || this.view === "bookmarks") row.addClass("is-twoline");
      /*
       * 選取中的那幾列：✓ 佔掉 icon 欄（書籤／檢視平常放的是快捷字母）。
       * 跟檔案檢視同一個判斷 —— 選取是暫時狀態，而「哪幾列被我選起來了」比
       * 「它的快捷字母是什麼」更急著要看見。
       */
      const picked = this.listSelectable() && this.listSel.has(this.listSelKey(item));
      if (picked) row.addClass("is-selected");
      row.createSpan({ cls: "yazi-icon", text: picked ? "✓" : item.icon || (item.active ? "●" : info ? info.icon : "·") });
      const nameEl = row.createSpan({ cls: "yazi-name", text: item.label });
      if (item.missing) nameEl.addClass("is-missing");
      if (item.sub) row.createSpan({ cls: "yazi-sub", text: item.sub });
      if (info) this.renderFmTail(row, info);
      if (idx === this.listIndex) {
        row.addClass("is-cursor");
        activeEl = row;
      }
      row.addEventListener("click", () => {
        this.listIndex = idx;
        if (this.view === "relations") this.enterRelation();
        else if (this.view === "views") this.runView(item.viewDef);
        else this.activateListItem("current");
      });
    });
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  /*
   * 全文搜尋的中欄：一個結果一張卡 —— 檔名、路徑、最多三行命中的上下文，
   * 命中的字 highlight。這樣掃一眼就知道哪一篇是要找的，不必逐個打開。
   */
  renderTextCards() {
    let activeEl = null;
    this.listItems.forEach((item, idx) => {
      const card = this.mainEl.createDiv({ cls: "yazi-card" });
      card.createDiv({ cls: "yazi-card-name", text: item.label });
      card.createDiv({ cls: "yazi-card-path", text: item.sub });
      for (const line of item.ctx || []) {
        const row = card.createDiv({ cls: "yazi-ctx-line" });
        row.createSpan({ cls: "yazi-ctx-num", text: String(line.num) });
        const body = row.createSpan({ cls: "yazi-ctx-text" });
        appendHighlighted(body, line.text, item.tokens || []);
      }
      if (idx === this.listIndex) {
        card.addClass("is-cursor");
        activeEl = card;
      }
      card.addEventListener("click", () => {
        this.listIndex = idx;
        this.activateListItem("current");
      });
    });
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  /*
   * 右欄：完整內文，命中處一樣 highlight，並自動捲到第一個命中。
   * 超過 PREVIEW_FULL_CHARS 就截斷 —— 一個 pre 塞十幾萬字會讓捲動變頓。
   */
  renderTextBody(el, item) {
    const full = item.content || "";
    const body = full.length > PREVIEW_FULL_CHARS ? full.slice(0, PREVIEW_FULL_CHARS) : full;
    const pre = el.createEl("pre", { cls: "yazi-preview-text" });
    const firstHit = appendHighlighted(pre, body, item.tokens || []);
    if (full.length > body.length) pre.createSpan({ cls: "yazi-ctx-num", text: this.t("ui.truncated", "  …(truncated)") });
    if (firstHit) {
      // 不用 scrollIntoView：那會連帶捲動外層容器。直接算這一欄自己的捲動位置。
      el.scrollTop = Math.max(0, firstHit.offsetTop - el.clientHeight / 3);
    }
  }

  /*
   * 說明頁：三欄一起用。HELP 已經用「只有左欄有字」的列當段落標題，這裡先切段，
   * 再依每段的高度把段落分配到三欄，讓三欄長度大致相當 —— 純粹平均分列數的話，
   * 段落標題會被拆散在欄的接縫上。
   */
  renderHelp() {
    const cols = [this.parentEl, this.mainEl, this.previewEl];
    const boxes = cols.map((c) => {
      c.empty();
      return c.createDiv({ cls: "yazi-help" });
    });
    const q = (this.helpFilter || "").trim().toLowerCase();
    boxes[0].createDiv({
      cls: "yazi-help-title",
      text: q
        ? this.t("ui.helpTitleFiltered", "Keys · “{q}” · Esc clears", { q: this.helpFilter })
        : this.t("ui.helpTitle", "Keys · / to search · Esc or ? to close"),
    });

    /* HELP 的每一列是 [鍵位, i18n key]；只有一個元素的是區塊標題（見 HELP 常數） */
    let groups = [];
    let cur = null;
    for (const row of HELP) {
      if (row.length === 1) {
        cur = { head: this.t(row[0]), rows: [] };
        groups.push(cur);
        continue;
      }
      if (!cur) {
        cur = { head: "", rows: [] };
        groups.push(cur);
      }
      cur.rows.push([row[0], this.t(row[1])]);
    }

    /*
     * 過濾：鍵位與說明任一命中就留。**段落標題本身也算命中**（打 "書籤" 想看的是
     * 整個書籤段落，不是剛好描述裡有這兩個字的那一列），命中標題就整段留著。
     * 全部過濾掉時不要留三個空欄 —— 明講找不到，比讓人以為壞了好。
     */
    if (q) {
      groups = groups
        .map((g) => {
          if (g.head && g.head.toLowerCase().includes(q)) return g;
          const rows = g.rows.filter(([k, d]) =>
            String(k).toLowerCase().includes(q) || String(d).toLowerCase().includes(q));
          return rows.length ? { head: g.head, rows } : null;
        })
        .filter(Boolean);
      if (!groups.length) {
        boxes[0].createDiv({ cls: "yazi-empty", text: this.t("ui.helpNoMatch", "Nothing matches “{q}”", { q: this.helpFilter }) });
        return;
      }
    }

    const weight = (g) => g.rows.length + 1.5;   // 段落標題本身也佔高度
    const per = groups.reduce((s, g) => s + weight(g), 0) / 3;
    let ci = 0;
    let used = 0;
    for (const g of groups) {
      const w = weight(g);
      if (ci < 2 && used > 0 && used + w > per) {
        ci++;
        used = 0;
      }
      const box = boxes[ci];
      if (g.head) box.createDiv({ cls: "yazi-help-section", text: g.head.replace(/^— | —$/g, "") });
      for (const [k, desc] of g.rows) {
        const row = box.createDiv({ cls: "yazi-help-row" });
        this.hilite(row.createSpan({ cls: "yazi-help-key" }), k, q);
        this.hilite(row.createSpan({ cls: "yazi-help-desc" }), desc, q);
      }
      used += w;
    }
  }

  /*
   * 把 text 寫進 el，命中的片段包成 <mark>。
   * 用 createSpan 一段一段建，不是塞 innerHTML —— 說明文字裡有 < > &（例如 <Space>），
   * 而且走 innerHTML 等於把使用者輸入的關鍵字當標記解析。
   */
  hilite(el, text, q) {
    const s = String(text);
    if (!q) {
      el.setText(s);
      return;
    }
    const hay = s.toLowerCase();
    let i = 0;
    for (;;) {
      const at = hay.indexOf(q, i);
      if (at < 0) break;
      if (at > i) el.createSpan({ text: s.slice(i, at) });
      el.createEl("mark", { cls: "yazi-hit", text: s.slice(at, at + q.length) });
      i = at + q.length;
    }
    if (i < s.length) el.createSpan({ text: s.slice(i) });
  }

  renderPreview() {
    const el = this.previewEl;
    // 大綱檢視：右欄畫的還是同一個檔就不重畫，只捲到游標所指的標題。
    // 重畫會把捲動位置歸零、還要再等一次渲染 —— j/k 掃標題就不可能即時。
    if (this.view === "outline" && this.outlineFile && this.previewPath === this.outlineFile.path) {
      this.followOutline();
      return;
    }
    this.previewPath = null;
    el.empty();
    this.previewToken++;
    // 上一格的渲染（已排程的、已掛上的）一律收掉：token 只擋得住「結果回來時」，
    // 排程中的 timer 與掛著的 Component 要自己清
    if (this.previewTimer) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.disposePreviewMd();

    if (this.view !== "files") {
      // 大綱：右欄永遠是那個檔（沒有標題、或過濾到空也一樣要看得到內文）
      if (this.view === "outline" && this.outlineFile) {
        this.renderFilePreview(el, this.outlineFile);
        return;
      }
      // 關聯：預覽 ＋ 最上面一條關聯摘要（按 l 有沒有路可走，看這條就知道）
      if (this.view === "relations") {
        const it = this.listCurrent();
        if (it && it.collapsed) {
          el.createDiv({ cls: "yazi-empty", text: this.t("ui.relCollapsedHint", "l or Enter expands this group") });
          return;
        }
        if (it && it.file) {
          this.renderFilePreview(el, it.file, { header: (box) => this.renderRelStrip(box, it.file) });
          return;
        }
      }
      const item = this.listCurrent();
      // 全文搜尋：右欄是完整內文（命中處 highlight、自動捲到第一處）
      if (item && item.content !== undefined) {
        this.renderTextBody(el, item);
        return;
      }
      if (item && item.file) this.renderFilePreview(el, item.file);
      else if (item && item.path) {
        const f = this.app.vault.getAbstractFileByPath(item.path);
        if (isFolder(f)) this.renderFolderPreview(el, f);
        else el.createDiv({ cls: "yazi-empty", text: this.t("ui.noPreview", "(cannot preview)") });
      } else {
        el.createDiv({ cls: "yazi-empty", text: this.t("ui.noItems", "(no items)") });
      }
      return;
    }

    const cur = this.current();
    if (!cur) {
      el.createDiv({ cls: "yazi-empty", text: this.t("ui.noItems", "(no items)") });
      return;
    }
    if (isFolder(cur)) this.renderFolderPreview(el, cur);
    else this.renderFilePreview(el, cur);
  }

  /* ── 預覽欄捲動 ──
   *
   * 游標留在檔案清單上（j/k 還是換檔案），只捲右邊那一欄——手不用離開鍵盤，
   * 也不用把滑鼠移過去。滑鼠滾輪本來就能捲（.yazi-col 是 overflow-y:auto），
   * 這裡補的是鍵盤那一半。
   *
   * 鍵位兩套並存，因為它們來自兩個都在用的肌肉記憶：
   *   J / K            yazi 的 seek 5 / seek -5（你的 keymap 就是這兩顆）
   *   ^E ^Y ^D ^U ^F ^B  vim 捲動 buffer 的那一組（行／半頁／整頁）
   * 平鍵的 d / u 維持「游標半頁」不變（Surfingkeys），要捲預覽是加 Ctrl 的那個。
   */
  /*
   * 滾輪一律捲**預覽欄**，不管游標停在哪一欄。
   *
   * 為什麼要搶：這是鍵盤介面，滑鼠多半停在畫面中間、或整場都沒動過，而想捲的永遠是
   * 右邊那篇內文 —— 為了捲它還得先把滑鼠移過去，是這個介面裡最沒必要的一段動作。
   * 檔案清單自己不需要滾輪：游標用 j/k 移動，清單會跟著捲（scrollIntoView），
   * 用滾輪捲它反而會捲到跟游標對不上，下一次按 j 又彈回去。
   *
   * 三個例外，都是「那一塊本身就是要捲的內容」，搶走會變成滾了卻沒反應：
   *   1. 人就停在預覽欄上 —— 原生行為本來就對，不必攔
   *   2. 說明頁（?）：三欄都是說明內文
   *   3. 搜尋組合卡：卡片自己會捲
   * Ctrl+滾輪也放行 —— 那是 Obsidian 的介面縮放。
   */
  handleWheel(ev) {
    if (!ev || ev.ctrlKey || ev.metaKey) return;
    if (this.showHelp || this.composing) return;
    const el = this.previewEl;
    if (!el || !ev.target) return;
    if (el === ev.target || el.contains(ev.target)) return;
    if (this.barEl && (this.barEl === ev.target || this.barEl.contains(ev.target))) return;
    const px = wheelPx(ev, this.previewLinePx(), el.clientHeight);
    if (!px) return;
    el.scrollTop += px;
    ev.preventDefault();
  }

  previewLinePx() {
    try {
      const lh = parseFloat(window.getComputedStyle(this.previewEl).lineHeight);
      if (lh > 0) return lh;
    } catch (e) { /* 拿不到就用估的 */ }
    return 20;
  }

  seekPreview(unit, dir) {
    const el = this.previewEl;
    if (!el) return;
    const line = this.previewLinePx();
    // 整頁留兩行重疊：捲完還看得到前一屏的最後一兩行，接得上文意（vim 也是這個手感）
    const page = Math.max(line, el.clientHeight - line * 2);
    const px = { line: line, seek: line * PREVIEW_SEEK_LINES, half: page / 2, page: page }[unit] || line;
    el.scrollTop += px * dir;
  }

  /* 渲染預覽開著嗎（,p 切換，存在 plugin data，預設開）。 */
  /* 設定裡的值（settings.preview.renderMarkdown），,p 與設定頁改的是同一個。 */
  renderMd() {
    const p = this.plugin && this.plugin.settings && this.plugin.settings.preview;
    return !p || p.renderMarkdown !== false;
  }

  toggleRenderMd() {
    const on = !this.renderMd();
    if (this.plugin) this.plugin.setRenderPreview(on);
    this.previewPath = null;   // 大綱檢視平常不重畫右欄，切換渲染模式是要重畫的那一次
    new Notice(on
      ? this.t("notice.previewRendered", "Preview: rendered markdown")
      : this.t("notice.previewPlain", "Preview: plain text"));
    this.render();
  }

  /*
   * 使用者的鍵位覆寫，解析過就快取住 —— handleKey 每一顆鍵都會問它一次，
   * 而設定不會在按鍵之間改變。設定頁存檔時會清掉快取（見 plugin.saveSettings）。
   */
  keymap() {
    const text = (this.plugin && this.plugin.settings && this.plugin.settings.keymap) || "";
    if (!this._km || this._kmText !== text) {
      this._kmText = text;
      this._km = parseKeymap(text);
    }
    return this._km;
  }

  /*
   * modal 裡到處都要翻譯，從 plugin 轉一手（plugin 可能是 null —— 測試會這樣建）。
   * 沒有 plugin 時也要把 {var} 代換掉：不代換的話畫面上會出現字面的 "{path}"，
   * 那看起來像壞掉的字串而不是「翻譯還沒載好」。
   */
  t(key, fallback, vars) {
    if (this.plugin && this.plugin.t) return this.plugin.t(key, fallback, vars);
    const s = fallback || key;
    if (!vars) return s;
    return String(s).replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  }

  /*
   * 把純文字預覽換成渲染過的 markdown。
   *
   * ⚠️ 一定要餵**洗過的**文字（stripPluginNoise ＋ stripForRender），不是原文 ——
   *    原文交給 renderer 等於讓 dataviewjs / meta-bind 在預覽欄裡真的跑起來。
   * ⚠️ 每次渲染要一個 Component 並在下次渲染前 unload：MarkdownRenderer 會把
   *    圖片、內嵌、程式碼區塊的 post-processor 掛在它身上，不 unload 就是每移動
   *    一次游標累積一份，關掉 modal 也收不回來。
   */
  renderMarkdownInto(el, placeholder, body, file) {
    const md = stripForRender(body);
    const box = el.createDiv({ cls: "yazi-preview-md markdown-rendered" });
    this.disposePreviewMd();
    const comp = new Component();
    this.previewComp = comp;
    comp.load();
    try {
      const render = MarkdownRenderer.render
        ? MarkdownRenderer.render(this.app, md, box, file.path, comp)
        // 舊版 Obsidian 只有 renderMarkdown（已 deprecated，但簽名相容）
        : MarkdownRenderer.renderMarkdown(md, box, file.path, comp);
      const done = () => {
        if (this.previewComp !== comp) return;   // 已經被下一次渲染換掉了
        placeholder.remove();                    // 渲染完成才拿掉純文字，中間不留空窗
        if (this.view === "outline") this.followOutline();   // 版面換了，標題的位置也換了
      };
      /*
       * ⚠️ 失敗要走**另一條**路。原本兩邊都接 done()，於是渲染失敗時純文字被拿掉、
       *    只留下一個空盒子 —— 畫面上看起來就是「開了渲染卻什麼都沒有」，而且無聲。
       *    失敗時要保留純文字，並在上面標一行，讓人知道是渲染壞了而不是檔案是空的。
       */
      if (render && typeof render.then === "function") render.then(done, (e) => this.previewRenderFailed(comp, box, e));
      else done();
    } catch (e) {
      this.previewRenderFailed(comp, box, e);
    }
  }

  /* 渲染失敗：收掉空盒子、留住純文字，並在最上面標一行（無聲降級最難查）。 */
  previewRenderFailed(comp, box, e) {
    console.error("[yazi-explorer] markdown render failed", e);
    if (this.previewComp !== comp) return;   // 已經被下一次渲染換掉了，不要動畫面
    box.remove();
    const el = this.previewEl;
    if (el && !el.querySelector(".yazi-preview-warn")) {
      const warn = el.createDiv({ cls: "yazi-preview-warn", text: this.t("ui.renderFallback", "Could not render this note — showing plain text") });
      el.insertBefore(warn, el.firstChild);
    }
  }

  disposePreviewMd() {
    if (this.previewComp) {
      try { this.previewComp.unload(); } catch (e) { console.error(e); }
      this.previewComp = null;
    }
  }

  renderFolderPreview(el, folder) {
    const list = this.entries(folder);
    if (!list.length) {
      el.createDiv({ cls: "yazi-empty", text: this.t("ui.emptyFolder", "(empty folder)") });
      return;
    }
    for (const f of list) {
      const folderish = isFolder(f);
      const row = el.createDiv({ cls: "yazi-row is-preview" + (folderish ? " is-folder" : "") });
      row.createSpan({ cls: "yazi-icon", text: folderish ? "▸" : "·" });
      row.createSpan({ cls: "yazi-name", text: f.name });
    }
  }

  /*
   * opts.header(el)：要畫在預覽最上面的東西（關聯檢視的摘要條）。
   * 純文字那條路會在讀完檔之後 el.empty()，所以 header 在那之後要再叫一次。
   */
  renderFilePreview(el, file, opts) {
    const ext = (file.extension || "").toLowerCase();
    this.previewPath = file.path;
    const header = opts && typeof opts.header === "function" ? opts.header : null;
    if (header) header(el);

    if (IMAGE_EXT.has(ext)) {
      const img = el.createEl("img", { cls: "yazi-preview-img" });
      img.src = this.app.vault.getResourcePath(file);
      return;
    }
    if (!TEXT_EXT.has(ext)) {
      this.renderFileInfo(el, file);
      return;
    }

    // 非同步讀檔：游標可能在讀完之前就移走了，用 token 擋掉過期的結果
    const token = this.previewToken;
    this.app.vault.cachedRead(file).then(
      (text) => {
        if (token !== this.previewToken) return;
        el.empty();
        if (header) header(el);
        /*
         * 認得的 frontmatter → 上面畫成表格，並把原始的 YAML 區塊從內文裡切掉。
         * 切掉是重點之一：task 的 frontmatter 有 11 行，不切的話預覽的前 11 行
         * 永遠是同一堆 YAML，真正的內容被擠出畫面。
         * 認不得 type 的筆記維持原樣（連同 YAML 一起顯示）—— 寧可多顯示，
         * 也不要把使用者的內容藏起來。
         */
        const info = fmInfo(file);
        let raw = text;
        if (info) {
          /*
           * ⚠️ frontmatter 面板不能拖垮整個預覽。
           * 這裡是 cachedRead().then() 裡面，沒有人接 —— 面板丟出例外的話，下面的
           * <pre> 根本不會被建、markdown 也不會排程渲染，畫面上看起來就是
           * 「某些筆記突然不渲染了」，而且只有 console 看得到。
           * （實際發生過：renderFmPanel 呼叫了一個不存在的函式。）
           */
          try {
            this.renderFmPanel(el, info);
            raw = stripFrontmatter(this.app, file, text);
          } catch (e) {
            console.error("[yazi-explorer] frontmatter panel failed", e);
            raw = text;   // 切不掉就連 YAML 一起顯示，總比整個預覽不見好
          }
        }
        /*
         * plugin 的機關（meta-bind 按鈕、dataviewjs…）一律不進預覽 ——
         * 那是給 Obsidian 讀的，不是給人讀的。一般的 ```js / ```bash 保留，
         * 因為那可能正是筆記裡想看的東西（判準見 stripPluginNoise）。
         * 對**所有** md 都做，不只有工作專案：dataviewjs 到處都有。
         */
        raw = stripPluginNoise(raw);
        let body = raw.slice(0, PREVIEW_MAX_CHARS);
        const lines = body.split("\n");
        if (lines.length > PREVIEW_MAX_LINES) {
          body = lines.slice(0, PREVIEW_MAX_LINES).join("\n") + "\n…";
        } else if (raw.length > PREVIEW_MAX_CHARS) {
          body += "\n…";
        }
        const pre = el.createEl("pre", { cls: "yazi-preview-text", text: body });
        if (this.view === "outline") this.followOutline();   // 純文字這一段先對位，渲染完再對一次
        /*
         * 渲染版（,p）刻意**先畫純文字、停下來才換掉**：
         *   - 不閃空白：markdown 渲染要等，中間那段時間總得顯示點什麼
         *   - 長按 j 滑過一整個資料夾時，中途那幾十列根本不會渲染，只有停住的那一列會
         * 只對 .md 做——.ts / .json 當 markdown 渲染沒有意義。
         */
        if (this.renderMd() && ext === "md") {
          this.previewTimer = window.setTimeout(() => {
            if (token !== this.previewToken) return;
            this.renderMarkdownInto(el, pre, body, file);
          }, PREVIEW_RENDER_DELAY);
        }
      },
      () => {
        if (token !== this.previewToken) return;
        el.empty();
        this.renderFileInfo(el, file);
      }
    );
  }

  renderFileInfo(el, file) {
    const info = fmInfo(file);
    if (info) this.renderFmPanel(el, info);
    const box = el.createDiv({ cls: "yazi-fileinfo" });
    const stat = file.stat || {};
    const kb = stat.size != null ? (stat.size / 1024).toFixed(1) + " KB" : "—";
    const mtime = stat.mtime ? new Date(stat.mtime).toLocaleString() : "—";
    for (const [k, v] of [[this.t("ui.type", "Type"), file.extension || "—"], [this.t("sort.size", "Size"), kb], [this.t("sort.mtime", "Modified"), mtime]]) {
      const row = box.createDiv({ cls: "yazi-help-row" });
      row.createSpan({ cls: "yazi-help-key", text: k });
      row.createSpan({ cls: "yazi-help-desc", text: v });
    }
  }

  /*
   * 預覽欄上方的 frontmatter 表。行內 chips 只放得下「分類 + 狀態 + P0/P1」，
   * 其餘欄位（專案、到期、來源、版本、說明、標籤…）全部在這裡攤開 ——
   * 兩層刻意不重疊：行內給掃視，這裡給細看。
   * 欄位順序照手冊 §3 各 type 的表格，空值不佔一行。
   */
  renderFmPanel(el, info) {
    const fm = info.fm || {};
    const box = el.createDiv({ cls: "yazi-fileinfo yazi-fm-panel" });
    const rows = [];
    const push = (k, v) => {
      if (v === undefined || v === null) return;
      const s = Array.isArray(v) ? v.join("　") : String(v).trim();
      if (s) rows.push([k, s]);
    };

    /*
     * 欄位順序：命中的裝飾規則可以指定 panel（["kind", {field:"due", label:"到期"}]），
     * 沒指定就照 frontmatter 自己的順序全部攤開。
     * 「全部攤開」是刻意的預設：這個 plugin 不知道別人的 frontmatter 長什麼樣，
     * 猜一份欄位清單只會讓大多數人的預覽少掉他們真正在看的東西。
     */
    const rule = FM_RULES.find((r) => r && r.id === info.ruleId);
    const panel = (rule && rule.panel) || null;

    if (panel) {
      for (const entry of panel) {
        const field = typeof entry === "string" ? entry : entry.field;
        const label = typeof entry === "string" ? entry : entry.label || entry.field;
        if (field === "tags") continue;   // 標籤固定畫在最後
        push(label, fm[field]);
      }
    } else {
      for (const [k, v] of Object.entries(fm)) {
        if (k === "tags" || k === "position") continue;
        push(k, v);
      }
    }
    if (info.overdue) push("⏰", this.t("ui.overdue", "overdue"));
    // Obsidian 自己掛的 work/ 之類自動標籤在 userTags 裡濾掉
    push("tags", userTags(fm.tags).join("　"));

    for (const [k, v] of rows) {
      const row = box.createDiv({ cls: "yazi-help-row" });
      row.createSpan({ cls: "yazi-help-key", text: k });
      row.createSpan({ cls: "yazi-help-desc", text: v });
    }
    return box;
  }

  /*
   * which-key 卡要顯示的內容。回 null ＝現在沒有待完成的序列（卡片收起來）。
   * sort / open 兩個前綴的選項會跟著當下狀態變，所以在這裡算而不是寫死在
   * PENDING_MENUS：排序要標出「現在是哪一個」，O 則是「檔案還是資料夾」決定選項。
   */
  pendingMenu() {
    const p = this.pending;
    if (!p) return null;

    if (p === "sort") {
      const cfg = this.sortCfg();
      return {
        key: "S",
        desc: this.t("menu.sort.desc") + "　·　" + this.t("ui.sortNow") + "：" + this.sortText(),
        items: SORTS.map((s) => [s.k, this.t(s.labelKey) + (cfg.field === s.field ? "　←" : "")]).concat([
          ["S", this.t("menu.sort.reverse")],
          ["d", this.t(cfg.foldersFirst ? "menu.sort.foldersOff" : "menu.sort.foldersOn")],
        ]),
      };
    }

    if (p === "open") {
      const t = this.openTarget();
      const items = this.openActions().map((a) => [a.key, this.openLabel(a)]);
      return {
        key: "O",
        desc: this.t("menu.open.desc") + "　·　" + (t ? (t.path === "/" ? this.app.vault.getName() : t.path) : ""),
        items,
        note: items.length ? "" : this.t("notice.noOpeners", "No openers apply to this item"),
      };
    }

    const spec = PENDING_MENUS[p];
    if (!spec) return { key: p, desc: "", items: [] };
    return {
      key: spec.key || p,
      desc: spec.descKey ? this.t(spec.descKey) : "",
      items: (spec.items || []).map(([k, dk]) => [k, this.t(dk)]),
      note: spec.noteKey ? this.t(spec.noteKey) : "",
    };
  }

  renderKeyMenu() {
    const m = this.pendingMenu();
    if (!m) {
      this.menuEl.hide();
      return;
    }
    this.kmTitleEl.empty();
    this.kmTitleEl.createSpan({ cls: "yazi-km-prefix", text: m.key });
    if (m.desc) this.kmTitleEl.createSpan({ cls: "yazi-km-desc", text: m.desc });

    this.kmItemsEl.empty();
    /*
     * 直向排、排滿一欄才換下一欄（grid-auto-flow: column）—— 掃一欄比掃一列快，
     * 而且鍵的順序在視覺上是連續的。欄數由列數決定，最多三欄。
     */
    const n = m.items.length;
    const cols = Math.min(3, Math.max(1, Math.ceil(n / KEYMENU_MAX_ROWS)));
    this.kmItemsEl.style.setProperty("--km-rows", String(Math.ceil(n / cols) || 1));
    for (const [k, label] of m.items) {
      const row = this.kmItemsEl.createDiv({ cls: "yazi-km-row" });
      row.createSpan({ cls: "yazi-km-key", text: k === " " ? "␣" : k });
      row.createSpan({ cls: "yazi-km-label", text: label });
    }
    this.kmHintEl.setText((m.note ? m.note + "　·　" : "") + this.t("ui.cancel", "Esc to cancel"));
    this.menuEl.show();
  }

  renderBar() {
    this.renderChips();
    if (this.view === "files") {
      const cur = this.current();
      const where = this.cwd.path === "/" ? this.app.vault.getName() : this.cwd.path;
      this.pathEl.setText(where + (cur ? " / " + cur.name : ""));
    } else {
      const item = this.listCurrent();
      this.pathEl.setText(item ? (item.sub || item.label) : "");
    }

    if (this.mode === "confirm" && this.confirmAsk) {
      this.hintEl.setText(this.confirmAsk.message + this.t("confirm.yes", "  y = confirm, any other key cancels"));
      this.hintEl.addClass("is-warn");
      return;
    }
    if (this.mode === "confirm" && this.confirmTarget) {
      const n = (this.confirmTargets || []).length;
      this.hintEl.setText(
        (n > 1
          ? this.t("confirm.deleteMany", "Delete the {count} selected items?", { count: n })
          : this.t("confirm.deleteOne", "Delete “{name}”?", { name: this.confirmTarget.name })) +
          this.t("confirm.yes", "  y = confirm, any other key cancels")
      );
      this.hintEl.addClass("is-warn");
      return;
    }
    this.hintEl.removeClass("is-warn");

    if (this.showHelp) {
      this.hintEl.setText(this.t("ui.helpBar", "Help · Esc or ? to close"));
      return;
    }

    // 選項本身畫在置中的 which-key 卡（renderKeyMenu），這裡只留一行狀態，
    // 免得同一份清單在兩個地方各寫一次、改一邊忘一邊
    if (this.pending) {
      const m = this.pendingMenu();
      this.hintEl.setText((m ? m.key : this.pending) + " …　" + this.t("ui.waitingKey", "waiting for the next key") + "　" + this.t("ui.cancel", "Esc to cancel"));
      return;
    }

    const n = this.view === "files" ? this.mainList().length : this.listItems.length;
    const i = this.view === "files" ? this.cursorIndex() : this.listIndex;
    const count = n ? `${i + 1}/${n}` : "0/0";
    const bits = [count, this.t("ui.sortShort", "sort:") + this.sortText()];
    if (this.visual) bits.push(this.visual > 0 ? "VISUAL" : this.t("ui.visualUnselect", "VISUAL (unselect)"));
    // 選取數：檔案檢視與清單檢視各有一個集合，狀態列只報人現在看著的那個
    const picked = this.view === "files" ? this.sel.size : this.listSel.size;
    if (picked) bits.push(this.t("ui.selected", "{count} selected", { count: picked }));
    const clipNow = this.clip();
    if (clipNow && clipNow.paths.length) {
      bits.push(this.t(clipNow.cut ? "ui.cutN" : "ui.copiedN",
        clipNow.cut ? "cut {count}" : "copied {count}", { count: clipNow.paths.length }));
    }
    if (this.filter) bits.push(this.t("ui.filterShort", "filter:") + this.filter);
    if (this.listFilter) bits.push(this.t("ui.inResults", "in results:") + this.listFilter);
    if (this.searchQuery && this.view === "search") bits.push(this.t("ui.query", "query:") + this.searchQuery);
    // 關聯檢視的左欄是上一跳（不是圖例），這三顆鍵就放狀態列常駐
    if (this.view === "relations") bits.push(this.t("ui.relHint", "l enter · o open · h back"));
    // 編輯檢視時進到結果頁：狀態列要說清楚這不是一般搜尋，以及怎麼存回去
    if (this.view === "search" && this.editingView) {
      bits.push(this.t("ui.editingViewResults", "editing “{name}” · s saves · i back to the card · Esc discards", { name: this.editingView.name }));
    }
    this.hintEl.setText(bits.join("　") + "　" + this.t("ui.help", "? help"));
  }
}

/* ───────────────────────────── 小工具 ───────────────────────────── */

// 中文檔名要照 zh-Hant 排序，而不是 code point。Collator 建一次重複用，比每次
// 比較都呼叫 localeCompare 快得多（資料夾一大差很明顯）。
const COLLATOR = (() => {
  try {
    return new Intl.Collator("zh-Hant", { numeric: true });
  } catch (e) {
    return new Intl.Collator(undefined, { numeric: true });
  }
})();

function msg(e) {
  return e && e.message ? e.message : String(e);
}

/* ─────────────────── frontmatter 讀取（見上方常數區的說明）─────────────────── */

/*
 * fmInfo() 要能從排序函式（模組層、拿不到 modal）裡呼叫，所以 app 存在模組層。
 * onload 設一次、onunload 清掉。
 */
let FM_APP = null;

/*
 * 模組層的翻譯函式。onload 會把真的那支灌進來。
 * 為什麼需要它：stripForRender / sortFiles 這些是模組層的純函式，拿不到 modal 的
 * this.t，但它們產出的東西（例如「內嵌筆記」那個佔位字）是使用者看得到的。
 * 預設實作直接回 fallback —— 還沒 onload 時（測試、或載入途中）介面仍然是英文。
 */
let T = (key, fallback, vars) => {
  let sOut = fallback || key;
  if (vars) sOut = sOut.replace(/\{(\w+)\}/g, (whole, k) => (k in vars ? String(vars[k]) : whole));
  return sOut;
};

/*
 * 目前生效的裝飾規則（settings.decorations 的快照）。
 * 跟 FM_APP 同樣住在模組層，因為排序函式也要用，而那裡拿不到 modal 或 plugin。
 * onload 與每次 openExplorer 都會同步一次。
 */
let FM_RULES = [];

/*
 * 哪些 code fence 是「plugin 的機關」而不是「內容」。
 * 只清這幾種是刻意的 —— 一般的 ```js / ```bash / ```mermaid 可能正是你記在筆記裡
 * 要看的東西，一律砍掉就變成「為了少看幾行雜訊而看不到真正想看的」。
 * meta-bind 用前綴比對，因為它有好幾種變體（-button / -js-view / -embed…）。
 */
const PLUGIN_FENCES = new Set(["dataview", "dataviewjs", "tasks", "query", "button", "chart"]);

function isPluginFence(info) {
  if (!info) return false;
  return info.startsWith("meta-bind") || PLUGIN_FENCES.has(info);
}

// 行內的 Meta Bind 控制項：`INPUT[...]` / `BUTTON[...]` / `VIEW[...]`
const MB_INLINE_SRC = "`(?:INPUT|BUTTON|VIEW)\\[[^\\]]*\\]`";

/*
 * 渲染預覽（,p 開關）只對 .md 生效，而且吃的是 stripPluginNoise() 洗過的文字 ——
 * 目的就是「只渲染純 markdown」：表格、標題、清單畫出來，plugin 的機關一律不進來。
 * 除了 fence 與行內控制項（stripPluginNoise 已經處理）之外，渲染版還要多清兩種
 * ——它們對純文字預覽無害，但**交給 renderer 就會真的跑起來**：
 *
 *   1. 筆記內嵌 ![[某筆記]]：renderer 會把那份筆記整個嵌進來一起渲染，裡面的
 *      dataviewjs 就在預覽欄裡執行了（這個 vault 的 dashboard 會寫 frontmatter，
 *      等於光是把游標移過去就改了檔案）。圖片／PDF 之類的內嵌保留，那才是想看的。
 *   2. Dataview 的行內查詢 `= expr` / `$= expr`：它掛的是 markdown post-processor，
 *      不是 code fence，stripPluginNoise 看不到。
 */
const EMBED_KEEP_EXT = new Set([
  ...IMAGE_EXT, "pdf", "mp4", "webm", "mov", "mp3", "wav", "m4a", "ogg", "flac",
]);
const PREVIEW_RENDER_DELAY = 120;   // 停多久才把純文字換成渲染版（長按 j 時不要每列都渲染）

/*
 * 把 plugin 的機關從預覽內文裡拿掉。清兩種：
 *   1. plugin 的 code fence（整段）
 *   2. 行內的 Meta Bind 控制項 —— 拿掉之後整行只剩分隔符號（`狀態 ｜ 優先級 ｜`）
 *      的話就把整行丟掉，否則只拿掉控制項、保留人寫的字
 * 這兩種加起來，一張 task 筆記的預覽大概少掉 40 行純機關。
 */
function stripPluginNoise(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let fenceChar = null;
  let dropping = false;

  for (const line of lines) {
    const t = line.trim();
    const m = /^(`{3,}|~{3,})\s*(.*)$/.exec(t);
    if (m) {
      const ch = m[1][0];
      const info = m[2].trim().toLowerCase().split(/[\s{,]/)[0];
      if (fenceChar === null) {
        fenceChar = ch;
        dropping = isPluginFence(info);
        if (dropping) continue;
      } else if (ch === fenceChar && !info) {
        fenceChar = null;
        if (dropping) {
          dropping = false;
          continue;
        }
      }
    }
    if (dropping) continue;

    /*
     * 含 Meta Bind 控制項的行**整行**拿掉，不是只拿掉控制項。
     * 第一版只拿控制項，結果留下「狀態 ｜ 優先級 ｜ 到期 ｜」這種只剩標籤的殘骸 ——
     * 那比原本更沒有意義。控制列本來就是一整行的 UI（標籤是給控制項用的，
     * 控制項沒了標籤也沒有存在理由），所以要拿就整行拿。
     */
    if (fenceChar === null && new RegExp(MB_INLINE_SRC).test(line)) continue;
    out.push(line);
  }

  // 清完之後常留下連續空行，收斂成最多一個
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/*
 * 渲染預覽專用的第二道清理（理由見 EMBED_KEEP_EXT 上面那段）。
 * 一定要跑在 stripPluginNoise 之後：那支已經把 fence 拿掉，這裡處理的是
 * 「不是 fence、但 renderer 會當真」的兩種東西。
 * 拿掉的東西不是默默消失，換成看得出來的佔位字 —— 預覽的用途是判斷「是不是這一篇」，
 * 憑空少一段會讓人以為筆記裡沒有那個東西。
 */
function stripForRender(text) {
  return String(text || "")
    // ![[note]] → 佔位；![[a.png]] / ![[a.pdf]] 之類保留
    .replace(/!\[\[([^\]|#^]+)([^\]]*)\]\]/g, (whole, target) => {
      const ext = (target.split(".").pop() || "").toLowerCase();
      if (target.includes(".") && EMBED_KEEP_EXT.has(ext)) return whole;
      return "`" + T("ui.embeddedNote", "[embedded note: {name}]", { name: target.trim() }) + "`";
    })
    // Dataview 行內查詢：`= this.file.name` / `$= dv.el(...)`
    .replace(/`\$?=[^`]*`/g, () => "`" + T("ui.inlineQuery", "[inline query]") + "`");
}

/* ── 搜尋條件用的小工具 ── */

// 一個檔案身上所有標籤（frontmatter 的 tags ＋ 內文的 #tag），一律不帶 #
/*
 * frontmatter 的 tags 值 → 乾淨的標籤陣列。
 *
 * YAML 那一欄可能長成清單、單一字串，或空白／逗號分隔的一串；`#` 前綴有人加有人不加。
 * 這裡全部收斂成同一種形狀，並套用 AUTO_TAG_PREFIXES（理由見那個常數）。
 */
function userTags(value) {
  const out = [];
  const add = (t) => {
    const s = String(t == null ? "" : t).replace(/^#/, "").trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  };
  if (Array.isArray(value)) value.forEach(add);
  else if (value != null && typeof value !== "object") {
    for (const part of String(value).split(/[,\s]+/)) add(part);
  }
  return out.filter((t) => !AUTO_TAG_PREFIXES.some((p) => t.startsWith(p)));
}

/*
 * 把開頭那塊 YAML frontmatter 從內文裡切掉。
 *
 * 為什麼要切：認得的 frontmatter 已經在上面畫成表格了，不切的話預覽的前十幾行
 * 永遠是同一堆 YAML，真正的內容被擠出畫面。
 *
 * 先用 metadataCache 的 frontmatterPosition（Obsidian 自己算的，最準）；拿不到就退回
 * 自己比對開頭的 `---` 區塊。兩條路都失敗就原樣回傳 —— 寧可多顯示幾行，
 * 也不要為了切乾淨而砍掉別人的內容。
 */
function stripFrontmatter(app, file, text) {
  const s = String(text == null ? "" : text);
  try {
    const cache = app && app.metadataCache ? app.metadataCache.getFileCache(file) : null;
    const pos = cache && (cache.frontmatterPosition || (cache.frontmatter && cache.frontmatter.position));
    if (pos && pos.end && typeof pos.end.offset === "number") {
      return s.slice(pos.end.offset).replace(/^\r?\n/, "");
    }
  } catch (e) { /* 拿不到就走下面的比對 */ }

  // `---` 必須在第一行；結尾是 --- 或 ...（YAML 兩種都合法）
  if (!/^---\s*\r?\n/.test(s)) return s;
  const lines = s.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*\r?$/.test(lines[i])) return lines.slice(i + 1).join("\n").replace(/^\r?\n/, "");
  }
  return s;   // 沒有收尾的 ---：那不是 frontmatter，別亂切
}

function fileTags(app, f) {
  try {
    const c = app.metadataCache.getFileCache(f);
    if (!c) return [];
    const out = [];
    const add = (t) => {
      const s = String(t || "").replace(/^#/, "").trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    };
    const fmTags = c.frontmatter && c.frontmatter.tags;
    if (Array.isArray(fmTags)) fmTags.forEach(add);
    else if (fmTags) add(fmTags);
    if (Array.isArray(c.tags)) for (const t of c.tags) add(t.tag);
    /*
     * `work/*` 是工作專案制度**自動掛**的標籤（work/task、work/doc、work/file-ref…），
     * 手冊 §3 明講「UI 一律濾掉」。不濾的話它們靠數量穩坐候選清單前幾名，
     * 把真正有意義的自由標籤（平台、csod、p1…）擠到看不見的地方 ——
     * 標籤是「照使用量排序」的，所以雜訊越多筆，傷害越大。
     * 它們表達的那條軸已經有「筆記 type」這個條件了，不會漏掉任何篩選能力。
     */
    return out.filter((t) => !AUTO_TAG_PREFIXES.some((p) => t.startsWith(p)));
  } catch (e) {
    return [];
  }
}

/*
 * 正則的語法檢查。原生搜尋打壞正則是**靜默**的（就只是搜不到東西），
 * 而那正是正則最勸退的地方 —— 所以這裡當場把錯誤訊息顯示出來。
 */
function regexError(s) {
  try {
    new RegExp(s);
    return "";
  } catch (e) {
    return msg(e).replace(/^Invalid regular expression:\s*/, "");
  }
}

function safeRegex(s) {
  try {
    return new RegExp(s, "i");
  } catch (e) {
    return null;
  }
}

// chip 上只放最後兩層，路徑長起來會把整條 bar 吃光
function shortPath(p) {
  const parts = String(p || "").split("/");
  return parts.length <= 2 ? p : "…/" + parts.slice(-2).join("/");
}

function idxOr(list, v, fallback) {
  const i = list.indexOf(v);
  return i < 0 ? fallback : i;
}

// due 是 YYYY-MM-DD；YAML 可能解成 Date 也可能解成字串（手冊 §4 踩過同一個坑）
function dueStr(v) {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function todayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/*
 * 回傳這個檔案的顯示資訊，沒有認得的 type 就回 null（＝這一列什麼都不加）。
 * 用 metadataCache 查表，是記憶體操作；**絕對不要改成 vault.read**，
 * 一次 render 幾十列，讀檔會讓捲動變成幻燈片。
 */
/*
 * 滾輪一格要捲幾個 px。deltaMode：0＝像素、1＝行、2＝頁。
 * 一般滑鼠在 Chromium 上是 0，但有些驅動與觸控板會回 1 —— 不換算的話那些裝置
 * 一格只捲三個 px，症狀是「滾了幾乎沒動」。
 */
function wheelPx(ev, linePx, pagePx) {
  const d = ev.deltaY || 0;
  if (ev.deltaMode === 1) return d * (linePx || 20);
  if (ev.deltaMode === 2) return d * (pagePx || 400);
  return d;
}

function fmInfo(file) {
  if (!FM_APP || !file || file.children) return null; // 資料夾沒有 frontmatter
  if (!FM_RULES.length) return null;                  // 沒設定規則就完全不裝飾
  let fm = null;
  try {
    const cache = FM_APP.metadataCache.getFileCache(file);
    fm = cache && cache.frontmatter;
  } catch (e) {
    return null;
  }
  if (!fm) return null;
  return decorate(fm, FM_RULES, { name: file.name, basename: file.basename });
}

// TFolder 身上沒有 stat，所以時間／大小一律當 0；配合「資料夾優先」就不會亂。
function statOf(f) {
  return (f && f.stat) || {};
}

/*
 * 依設定排序一批 TFile / TFolder。field === "natural" 時原樣回傳 ——
 * 呼叫端負責維持該檢視原本的順序。
 */
function sortFiles(list, cfg) {
  if (!cfg || cfg.field === "natural") return list;
  const arr = list.slice();
  arr.sort((a, b) => {
    if (cfg.foldersFirst) {
      const af = isFolder(a);
      const bf = isFolder(b);
      if (af !== bf) return af ? -1 : 1;
    }
    let r = 0;
    if (cfg.field === "mtime") r = (statOf(a).mtime || 0) - (statOf(b).mtime || 0);
    else if (cfg.field === "ctime") r = (statOf(a).ctime || 0) - (statOf(b).ctime || 0);
    else if (cfg.field === "size") r = (statOf(a).size || 0) - (statOf(b).size || 0);
    else if (cfg.field === "ext") r = COLLATOR.compare(a.extension || "", b.extension || "");
    else if (FM_SORT_KEY[cfg.field]) {
      // frontmatter 欄位：沒有的一律 FM_LAST 沉底，同分再落到下面的檔名比較
      const k = FM_SORT_KEY[cfg.field];
      const ia = fmInfo(a);
      const ib = fmInfo(b);
      r = (ia ? ia[k] : FM_LAST) - (ib ? ib[k] : FM_LAST);
    } else r = COLLATOR.compare(a.name || "", b.name || "");
    if (r === 0) r = COLLATOR.compare(a.name || "", b.name || "");
    return cfg.reverse ? -r : r;
  });
  return arr;
}

/*
 * 找出 text 裡所有關鍵字的命中區間，重疊的合併起來。
 * 合併是必要的：搜「客製 製平」這種有重疊的詞時，不合併會產生交錯的 span，
 * 畫出來會少字。
 */
function hitRanges(text, tokens) {
  const lower = text.toLowerCase();
  const ranges = [];
  for (const t of tokens) {
    if (!t) continue;
    let i = lower.indexOf(t);
    while (i >= 0) {
      ranges.push([i, i + t.length]);
      i = lower.indexOf(t, i + t.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

// 把 text 塞進 el，命中的部分包成 .yazi-hit。回傳第一個命中的 span（給捲動用）。
function appendHighlighted(el, text, tokens) {
  const doc = el.ownerDocument;
  const ranges = hitRanges(text, tokens);
  if (!ranges.length) {
    el.appendChild(doc.createTextNode(text));
    return null;
  }
  let pos = 0;
  let firstHit = null;
  for (const [s, e] of ranges) {
    if (s > pos) el.appendChild(doc.createTextNode(text.slice(pos, s)));
    const span = el.createSpan({ cls: "yazi-hit", text: text.slice(s, e) });
    if (!firstHit) firstHit = span;
    pos = e;
  }
  if (pos < text.length) el.appendChild(doc.createTextNode(text.slice(pos)));
  return firstHit;
}

/*
 * 長行只顯示命中位置附近的一段窗格 —— 整行貼上去的話，命中的字很可能被擠到
 * 看不見的右邊，那就違背「不用打開檔案就知道命中在哪」的目的。
 */
function windowAround(line, tokens) {
  const ranges = hitRanges(line, tokens);
  const at = ranges.length ? ranges[0][0] : 0;
  let start = Math.max(0, at - CTX_BEFORE);
  let end = Math.min(line.length, at + CTX_AFTER);
  let out = line.slice(start, end);
  if (start > 0) out = "…" + out;
  if (end < line.length) out = out + "…";
  return out;
}

/*
 * 中欄每個結果要顯示的上下文：挑出含關鍵字的行，最多 CTX_MAX_LINES 行。
 * 這是「不用逐個檔打開就知道要找的在哪」的關鍵 —— 只給檔名等於沒給線索。
 */
function contextLines(content, lower, tokens) {
  const lines = content.split("\n");
  const lowerLines = lower.split("\n");
  const out = [];
  for (let i = 0; i < lowerLines.length && out.length < CTX_MAX_LINES; i++) {
    if (!tokens.some((t) => lowerLines[i].includes(t))) continue;
    const text = lines[i].trim();
    if (!text) continue;
    out.push({ num: i + 1, text: windowAround(text, tokens) });
  }
  return out;
}

/*
 * 書籤結構 0.1.0 是 { 字母: 路徑 }，強迫每個書籤在建立當下就決定快捷字母。
 * 0.2.0 改成 [{path, key, added}]：key 可以是 null，之後在書籤清單裡再指定。
 * 這裡負責把舊格式讀進來，使用者不用手動搬。
 */
function migrateBookmarks(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.keys(raw)
      .sort()
      .map((k) => ({ path: raw[k], key: k, added: Date.now() }));
  }
  return [];
}

/* ───────────────────────────── plugin ───────────────────────────── */

module.exports = class YaziExplorer extends Plugin {
  async onload() {
    // 書籤存在本外掛自己的 data.json（loadData/saveData 是公開 API）。
    // 刻意不寫進 Obsidian 核心的「書籤」外掛：那要走 app.internalPlugins 的內部
    // API，而且核心書籤的群組結構跟這裡「字母 → 路徑」的 mark 模型對不起來。
    // 兩份清單用途本來就不同：這裡是導航跳點，核心書籤是常用筆記。
    const raw = await this.loadData();
    /*
     * 設定與使用者資料住在同一份 data.json：
     *   settings —— 偏好（openers / 預覽 / 索引…），有預設值，設定頁會改
     *   data     —— 書籤、frecency、排序，是使用者累積出來的東西
     * 兩者共用同一個物件（this.data === this.settings），只是程式碼裡用不同的名字
     * 表達意圖。分成兩份檔案的話，「設定頁存檔」與「加書籤存檔」會互相蓋掉對方。
     */
    this.settings = mergeSettings(defaultSettings(), raw);
    this.data = this.settings;
    this._t = createTranslator(this.settings.locale);
    this.data.bookmarks = migrateBookmarks(raw && raw.bookmarks);
    this.data.sort = Object.assign(
      { field: "name", reverse: false, foldersFirst: true },
      raw && raw.sort
    );
    this.data.frecency = (raw && raw.frecency) || {};
    this.addSettingTab(new YaziSettingTab(this.app, this));
    /*
     * 剪貼簿只活在記憶體（跨 modal 開關，但不跨 Obsidian 重啟）。
     * 存進 data.json 只會留下一堆指向不存在路徑的殘骸，而且重開之後人也不記得
     * 當初剪了什麼，貼出來是驚喜不是功能。
     */
    this.clip = null;

    /*
     * frontmatter 裝飾要從模組層的排序函式裡讀 metadataCache，所以 app 存在模組層。
     * 分類圖示從 vault 的 docCategories.js 讀（單一來源，見常數區），失敗就用 fallback。
     */
    FM_APP = this.app;
    T = (k, f, v) => this.t(k, f, v);
    FM_RULES = this.settings.decorations || [];
    setFacets(this.settings.facets);

    this.addCommand({
      id: "open",
      name: this.t("cmd.open", "Open file explorer (at the current file)"),
      callback: () => this.openExplorer("files"),
    });
    this.addCommand({
      id: "open-tabs",
      name: this.t("cmd.openTabs", "Open tab list"),
      callback: () => this.openExplorer("tabs"),
    });
    this.addCommand({
      id: "open-bookmarks",
      name: this.t("cmd.openBookmarks", "Open bookmarks"),
      callback: () => this.openExplorer("bookmarks"),
    });
    this.addCommand({
      id: "open-recent",
      name: this.t("cmd.openRecent", "Open recent files (newest first)"),
      callback: () => this.openExplorer("recent"),
    });
    this.addCommand({
      id: "open-frecency",
      name: this.t("cmd.openFrecency", "Open most visited (folders and files)"),
      callback: () => this.openExplorer("frecency"),
    });
    this.addCommand({
      id: "open-views",
      name: this.t("cmd.openViews", "Open saved views"),
      callback: () => this.openExplorer("views"),
    });
    this.addCommand({
      id: "open-outline",
      name: this.t("cmd.openOutline", "Open outline of the current note"),
      callback: () => this.openExplorer("outline"),
    });
    this.addCommand({
      id: "open-relations",
      name: this.t("cmd.openRelations", "Open relations of the current note"),
      callback: () => this.openExplorer("relations"),
    });

    /*
     * 常用紀錄：開檔就記一筆。用 workspace 的 file-open 而不是只在這個瀏覽器裡記，
     * 這樣 quick switcher、點連結、側邊欄開的檔也一起算進來 —— 不然 z 只反映
     * 「用這個瀏覽器開過的」，跟真正的常用度差很遠。資料夾則記在 gotoFolder。
     */
    this.registerEvent(
      this.app.workspace.on("file-open", (f) => {
        if (f && f.path) this.bumpFrecency(f.path);
      })
    );

    this.registerIndexEvents();

    this.addCommand({
      id: "search-text",
      name: this.t("cmd.searchText", "Search: full text"),
      callback: () => this.openExplorer("search-text"),
    });
    this.addCommand({
      id: "search-file",
      name: this.t("cmd.searchFile", "Search: file names"),
      callback: () => this.openExplorer("search-file"),
    });
    this.addCommand({
      id: "search-dir",
      name: this.t("cmd.searchDir", "Search: folders"),
      callback: () => this.openExplorer("search-dir"),
    });
  }

  /*
   * 全文索引：Map<路徑, 內容>。第一次按 gt 才建，之後靠 vault 事件維持新鮮。
   * 為什麼要索引而不是每次敲鍵重讀：cachedRead 是非同步 I/O，幾千個檔跑一輪
   * 要以秒計，每敲一個字跑一次完全不可行。建成記憶體字串之後，搜尋是純
   * indexOf，數千筆在個位數毫秒內。
   *
   * 只收 TEXT_EXT 裡的副檔名（二進位檔沒有搜尋意義又吃記憶體），單檔上限
   * INDEX_MAX_CHARS 擋住異常大的檔。
   */
  /** 索引的上限與排除清單全部來自設定（設定頁那幾個開關必須真的生效）。 */
  indexCfg() {
    const c = (this.settings && this.settings.index) || {};
    return {
      enabled: c.enabled !== false,
      maxFileBytes: c.maxFileBytes || INDEX_SKIP_ABOVE,
      maxChars: c.maxChars || INDEX_MAX_CHARS,
      exclude: (c.excludeFolders || []).filter(Boolean),
    };
  }

  indexableFiles() {
    const cfg = this.indexCfg();
    return this.app.vault.getFiles().filter((f) => {
      if (!TEXT_EXT.has((f.extension || "").toLowerCase())) return false;
      if (cfg.exclude.some((p) => f.path === p || f.path.startsWith(p.replace(/\/$/, "") + "/"))) return false;
      return ((f.stat && f.stat.size) || 0) <= cfg.maxFileBytes;
    });
  }

  /* 把索引整個丟掉（設定頁的「清除快取」）。下次搜尋會重建。 */
  async clearIndex() {
    this.textIndex = null;
    this.textMtime = null;
    this.textIndexStats = null;
    this.indexDirty = false;
    try {
      const p = this.indexPath();
      if (await this.app.vault.adapter.exists(p)) await this.app.vault.adapter.remove(p);
    } catch (e) {
      console.error("[yazi-explorer] could not remove the index cache", e);
    }
  }

  indexPath() {
    return this.manifest.dir + "/" + INDEX_FILE;
  }

  async indexOne(f) {
    try {
      const t = await this.app.vault.cachedRead(f);
      const max = this.indexCfg().maxChars;
      this.textIndex.set(f.path, t.length > max ? t.slice(0, max) : t);
      this.textMtime.set(f.path, (f.stat && f.stat.mtime) || 0);
    } catch (e) {
      // 讀不到就跳過那一個檔，不要讓整個索引建不起來
    }
  }

  /*
   * 分批「併發」讀，而不是一個 await 一個。循序的話兩千多個檔就是兩千多次
   * 來回等 I/O；一次丟 INDEX_BATCH 個出去，磁碟與 Obsidian 的快取層才有機會
   * 重疊工作。
   */
  async readFilesInto(files) {
    for (let i = 0; i < files.length; i += INDEX_BATCH) {
      await Promise.all(files.slice(i, i + INDEX_BATCH).map((f) => this.indexOne(f)));
    }
  }

  /*
   * 全文索引的入口。有存檔就載入，再用 mtime 比對補上差異；沒有就整份建。
   *
   * 為什麼用 mtime 比對而不是「信任存檔」：這個 vault 是雙機 + obsidian-git，
   * Obsidian 關著的時候檔案照樣會被 pull 進來改掉。信任存檔的話搜出來是舊內容，
   * 而且完全沒有徵兆。而比對本身是零 I/O —— TFile.stat.mtime 早就在記憶體裡，
   * 兩千多筆的 Map 比較不到 1 毫秒，所以正確性幾乎是免費的。
   */
  async ensureTextIndex() {
    if (this.textIndex) return this.textIndex;
    /* 設定裡關掉全文搜尋就給一個空索引：搜尋照樣能用（只是沒有結果），
       而不是讓呼叫端拿到 null 再各自處理一次「沒有索引」的情況。 */
    if (!this.indexCfg().enabled) {
      this.textIndex = new Map();
      this.textMtime = new Map();
      this.textIndexStats = { files: 0, ms: 0, fromCache: false, loaded: 0, reread: 0, disabled: true };
      return this.textIndex;
    }
    const t0 = Date.now();
    const files = this.indexableFiles();
    const cached = await this.loadIndexFile();

    this.textIndex = new Map();
    this.textMtime = new Map();
    if (cached) {
      for (const p of Object.keys(cached)) {
        const e = cached[p];
        if (!e || typeof e.c !== "string") continue;
        this.textIndex.set(p, e.c);
        this.textMtime.set(p, e.m || 0);
      }
    }
    const loaded = this.textIndex.size;

    // 索引裡有、但 vault 已經沒有（或已超過大小上限）的，丟掉
    const live = new Set(files.map((f) => f.path));
    let dropped = 0;
    for (const p of Array.from(this.textIndex.keys())) {
      if (live.has(p)) continue;
      this.textIndex.delete(p);
      this.textMtime.delete(p);
      dropped++;
    }

    // 只重讀 mtime 對不上的，以及索引裡沒有的
    const stale = files.filter(
      (f) => this.textMtime.get(f.path) !== ((f.stat && f.stat.mtime) || 0)
    );
    await this.readFilesInto(stale);

    this.textIndexStats = {
      files: this.textIndex.size,
      loaded,
      reread: stale.length,
      dropped,
      fromCache: !!cached,
      ms: Date.now() - t0,
    };
    if (!cached || stale.length || dropped) this.scheduleIndexSave(0);
    return this.textIndex;
  }

  async loadIndexFile() {
    try {
      const p = this.indexPath();
      if (!(await this.app.vault.adapter.exists(p))) return null;
      const obj = JSON.parse(await this.app.vault.adapter.read(p));
      if (!obj || obj.version !== INDEX_VERSION || !obj.entries) return null;
      return obj.entries;
    } catch (e) {
      console.error("[yazi-explorer] index cache missing or corrupt; rebuilding", e);
      return null;
    }
  }

  scheduleIndexSave(delay) {
    this.indexDirty = true;
    if (this.indexSaveTimer) window.clearTimeout(this.indexSaveTimer);
    this.indexSaveTimer = window.setTimeout(
      () => this.saveTextIndex(),
      delay === undefined ? INDEX_SAVE_DELAY : delay
    );
  }

  async saveTextIndex() {
    if (!this.textIndex || !this.indexDirty) return;
    this.indexDirty = false;
    try {
      const entries = {};
      for (const [p, c] of this.textIndex) entries[p] = { m: this.textMtime.get(p) || 0, c };
      await this.app.vault.adapter.write(
        this.indexPath(),
        JSON.stringify({ version: INDEX_VERSION, entries })
      );
    } catch (e) {
      console.error("[yazi-explorer] could not write the index cache", e);
    }
  }

  // 索引沒建過就什麼都不做 —— 沒人用過 gt 的話不該為此付維護成本
  registerIndexEvents() {
    const v = this.app.vault;
    const touch = async (f) => {
      if (!this.textIndex || !f || isFolder(f)) return;
      if (!TEXT_EXT.has((f.extension || "").toLowerCase())) return;
      if (((f.stat && f.stat.size) || 0) > this.indexCfg().maxFileBytes) {
        // 檔案長超過上限就從索引移除，不要留著一份過期的截斷內容
        if (this.textIndex.delete(f.path)) {
          this.textMtime.delete(f.path);
          this.scheduleIndexSave();
        }
        return;
      }
      await this.indexOne(f);
      this.scheduleIndexSave();
    };
    const forget = (path) => {
      if (!this.textIndex) return;
      if (this.textIndex.delete(path)) {
        this.textMtime.delete(path);
        this.scheduleIndexSave();
      }
    };
    this.registerEvent(v.on("modify", touch));
    this.registerEvent(v.on("create", touch));
    this.registerEvent(v.on("delete", (f) => f && forget(f.path)));
    this.registerEvent(
      v.on("rename", (f, oldPath) => {
        forget(oldPath);
        touch(f);
      })
    );
  }

  onunload() {
    FM_APP = null; // 模組層持有 app，不清掉的話 reload 插件會留著舊的實例
    // 關閉前把還沒寫出去的索引補寫一次，否則這次 session 的更新就白做了
    if (this.indexSaveTimer) window.clearTimeout(this.indexSaveTimer);
    this.saveTextIndex();
    // 常用紀錄同理：延遲寫檔還沒到期就關掉的話，這次 session 的次數會白算
    if (this.frecencySaveTimer) {
      window.clearTimeout(this.frecencySaveTimer);
      this.frecencySaveTimer = null;
      this.pruneFrecency();
      this.saveData(this.data);
    }
  }

  /* ── 常用（frecency）── */

  /*
   * zoxide 的 frecency：分數 = 次數 × 時間衰減。只存 {n 次數, t 最後一次}，
   * 排序時才算分 —— 不必為了維持排序在每次存取時重算整份。
   */
  bumpFrecency(path) {
    if (!path || path === "/") return;
    const f = this.data.frecency || (this.data.frecency = {});
    const rec = f[path] || (f[path] = { n: 0, t: 0 });
    rec.n++;
    rec.t = Date.now();
    this.scheduleFrecencySave();
  }

  frecencyScore(rec, now) {
    const hours = (now - (rec.t || 0)) / 3600000;
    const decay = hours < 1 ? 4 : hours < 24 ? 2 : hours < 24 * 7 ? 0.5 : 0.25;
    return (rec.n || 0) * decay;
  }

  frecencyRanked() {
    const f = this.data.frecency || {};
    const now = Date.now();
    return Object.keys(f)
      .map((path) => ({ path, n: f[path].n || 0, s: this.frecencyScore(f[path], now) }))
      .sort((a, b) => b.s - a.s);
  }

  async forgetFrecency(path) {
    if (this.data.frecency) delete this.data.frecency[path];
    await this.saveData(this.data);
  }

  /*
   * 每開一個檔就寫一次 data.json 太吵（書籤、排序都在同一個檔），所以延遲合併寫。
   * 寫之前順手修剪：只留分數最高的 FRECENCY_KEEP 筆，data.json 才不會無限長大。
   */
  scheduleFrecencySave() {
    if (this.frecencySaveTimer) window.clearTimeout(this.frecencySaveTimer);
    this.frecencySaveTimer = window.setTimeout(() => {
      this.frecencySaveTimer = null;
      this.pruneFrecency();
      this.saveData(this.data);
    }, 5000);
  }

  pruneFrecency() {
    const ranked = this.frecencyRanked();
    if (ranked.length <= FRECENCY_KEEP) return;
    const next = {};
    for (const r of ranked.slice(0, FRECENCY_KEEP)) next[r.path] = this.data.frecency[r.path];
    this.data.frecency = next;
  }

  /* 設定頁與 modal 都走這一支存檔（data 與 settings 是同一個物件，見 onload）。 */
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** 語言換了之後重建翻譯函式（設定頁會呼叫）。 */
  reloadTranslator() {
    this._t = createTranslator(this.settings.locale);
    T = (k, f, v) => this.t(k, f, v);
  }

  /** 翻譯。onload 會建好 this._t；還沒建好時退回 fallback，不要讓 UI 變成 key。 */
  t(key, fallback, vars) {
    return this._t ? this._t(key, fallback, vars) : (fallback || key);
  }

  setSort(cfg) {
    this.data.sort = cfg;
    this.saveData(this.data);
  }

  // 預覽欄渲染 markdown（,p）。存進 settings.preview，跟設定頁是同一個值
  setRenderPreview(on) {
    this.settings.preview.renderMarkdown = !!on;
    this.saveData(this.settings);
  }

  /* ── 儲存的檢視（gv）──
   *
   * 一個檢視就是「一張組好的搜尋卡」的快照：種類、關鍵字、條件、範圍。
   * 存的是條件本身而不是結果，所以 vault 變了它就跟著變 —— 那正是「我的未完成 P0」
   * 這種檢視要的行為。快捷字母沿用書籤那一套（清單裡 m + 字母指定，再按該字母就開）。
   */
  views() {
    return (this.data && this.data.views) || [];
  }

  viewByKey(key) {
    return this.views().find((v) => v.key === key) || null;
  }

  /*
   * 先比 id（改名既有那一筆），再比名字（同名＝覆寫：組了一次更好的條件想存回同一個
   * 名字是常事，逼人先刪再存只是多一步）。回傳 true 代表蓋掉了既有的。
   */
  async saveView(view) {
    const list = this.views();
    let at = list.findIndex((v) => v.id === view.id);
    if (at < 0) at = list.findIndex((v) => v.name === view.name);
    const replaced = at >= 0;
    if (replaced) view.key = view.key || list[at].key;   // 蓋掉時保留原本的快捷字母
    if (replaced) list[at] = view;
    else list.push(view);
    this.data.views = list;
    await this.saveData(this.data);
    return replaced;
  }

  async removeView(id) {
    this.data.views = this.views().filter((v) => v.id !== id);
    await this.saveData(this.data);
  }

  // 搶字母的語意與書籤一致（見 assignBookmarkKey 的說明）
  async assignViewKey(id, key) {
    let stolenFrom = null;
    for (const v of this.views()) {
      if (key && v.key === key && v.id !== id) {
        v.key = null;
        stolenFrom = v.name;
      }
      if (v.id === id) v.key = key || null;
    }
    await this.saveData(this.data);
    return stolenFrom;
  }

  bookmarks() {
    return (this.data && this.data.bookmarks) || [];
  }

  findBookmark(path) {
    return this.bookmarks().find((b) => b.path === path) || null;
  }

  bookmarkByKey(key) {
    return this.bookmarks().find((b) => b.key === key) || null;
  }

  /*
   * 回傳 true ＝新增、false ＝這個路徑本來就有書籤（那就改它的名字）。
   * 「已經加過了就什麼都不做」對使用者沒有用 —— 會再按一次 m 的人多半就是想改名。
   */
  async addBookmark(path, name) {
    const existing = this.findBookmark(path);
    if (existing) {
      if (name) existing.name = name;
      await this.saveData(this.data);
      return false;
    }
    this.data.bookmarks.push({ path, name: name || null, key: null, added: Date.now() });
    await this.saveData(this.data);
    return true;
  }

  async removeBookmark(path) {
    this.data.bookmarks = this.bookmarks().filter((b) => b.path !== path);
    await this.saveData(this.data);
  }

  /*
   * 指定快捷字母。同一個字母只能屬於一個書籤，所以先把別人身上的同字母清掉
   * （「搶過來」而不是拒絕）—— 清單上看得到誰有哪個字母，搶走是可見的；
   * 拒絕則會變成「按了沒反應」，那才難查。key 傳 null 就是清除。
   */
  async assignBookmarkKey(path, key) {
    let stolenFrom = null;
    for (const b of this.bookmarks()) {
      if (key && b.key === key && b.path !== path) {
        b.key = null;
        stolenFrom = b.path;
      }
      if (b.path === path) b.key = key || null;
    }
    await this.saveData(this.data);
    return stolenFrom;
  }

  openExplorer(view) {
    const ws = this.app.workspace;
    // 設定頁可能剛改過裝飾規則；每次開都同步一次，省掉「改了要重載 plugin」
    FM_RULES = this.settings.decorations || [];
    setFacets(this.settings.facets);

    // 開 modal 之前先把 active leaf 拉回主編輯區。
    // sidebar-keyboard-navigation 是靠 active leaf 的 view type 決定要不要掛
    // document keydown listener；人如果本來就在檔案總管裡，它是 armed 狀態，
    // 同一顆 j/k 會被它和這個 modal 各處理一次。
    const main = ws.getMostRecentLeaf(ws.rootSplit);
    if (main) ws.setActiveLeaf(main, { focus: false });

    const modal = new YaziModal(this.app, ws.getActiveFile(), this);
    modal.initialView = view || "files";
    modal.open();
  }
};
