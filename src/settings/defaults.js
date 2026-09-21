/*
 * 設定的預設值與形狀。
 *
 * ── 這裡的第一原則：**不放任何屬於某個人的東西** ──
 * 這份 plugin 原本是為一個特定 vault 寫的，openers 指向作者自己的腳本、裝飾規則綁著
 * 作者自己的專案制度。那些現在全都變成「使用者的設定值」，預設值只留下**每個人都
 * 適用**的那幾個。作者自己的那套改成在他自己的 data.json 裡，跟任何其他使用者一樣。
 *
 * ── 第二原則：規則是資料，不是程式碼 ──
 * openers / decorations / facets 都是陣列，設定頁可以增刪改、可以匯出成 JSON 給別人。
 * 要加一種「用某某程式開」不必改 code，也因此不必等作者發版。
 */

/** 指令模板可以用的佔位字。設定頁會把這張表直接印出來給使用者看。 */
const PLACEHOLDERS = [
  ["{{path}}", "absolute path of the item under the cursor"],
  ["{{dir}}", "absolute path of its folder (for a folder, itself)"],
  ["{{relPath}}", "path relative to the vault root"],
  ["{{name}}", "file name with extension"],
  ["{{basename}}", "file name without extension"],
  ["{{ext}}", "extension, without the dot"],
  ["{{vaultPath}}", "absolute path of the vault"],
  ["{{vaultName}}", "vault name"],
];

/**
 * opener 的動作種類。
 * system / reveal 走 Electron 的 shell，桌面與（部分）行動版都有；
 * command 會生一個外部行程，**只有桌面版**；
 * obsidian-command 執行 Obsidian 自己的命令，行動版也能用 —— 這是給不想碰 shell
 * 的人用的擴充點（例如用某個 plugin 的命令開檔）。
 */
const OPENER_KINDS = ["system", "reveal", "command", "obsidian-command"];

/** 內建的開啟方式：只有「每個平台都成立」的那三個。 */
const DEFAULT_OPENERS = [
  {
    id: "system",
    label: "Default app",
    key: "d",
    appliesTo: "file",
    extensions: [],
    platform: "all",
    kind: "system",
    enabled: true,
  },
  {
    id: "explore",
    label: "Open folder",
    key: "f",
    appliesTo: "folder",
    extensions: [],
    platform: "all",
    kind: "system",
    enabled: true,
  },
  {
    id: "reveal",
    label: "Show in file manager",
    key: "r",
    appliesTo: "both",
    extensions: [],
    platform: "all",
    kind: "reveal",
    enabled: true,
  },
];

/*
 * 列裝飾：用 frontmatter 決定一列長什麼樣。
 * 預設是**空的** —— 裝飾規則必然綁著某個人的筆記慣例，猜一個只會讓所有人的檔案列
 * 冒出看不懂的東西。設定頁會附幾個範例讓人一鍵加入（見 EXAMPLE_DECORATIONS）。
 */
const DEFAULT_DECORATIONS = [];

/*
 * 設定頁「加入範例」用的 opener。不是預設值 —— 預設值只能放每台機器都成立的東西，
 * 而 code / wt.exe 這些是「你裝了才有」。做成一鍵帶入的範本：新使用者看得到一條
 * command opener 長什麼樣（執行檔 ＋ 一行一個參數 ＋ 佔位字），改兩個字就能用。
 */
const EXAMPLE_OPENERS = [
  {
    id: "example-vscode",
    label: "Visual Studio Code",
    key: "e",
    appliesTo: "file",
    extensions: [],
    platform: "all",
    kind: "command",
    command: "code",
    args: ["--reuse-window", "{{path}}"],
    enabled: true,
  },
  {
    id: "example-terminal-win",
    label: "Terminal",
    key: "t",
    appliesTo: "both",
    extensions: [],
    platform: "win",
    kind: "command",
    command: "wt.exe",
    args: ["-d", "{{dir}}"],
    enabled: true,
  },
  {
    id: "example-terminal-mac",
    label: "Terminal",
    key: "t",
    appliesTo: "both",
    extensions: [],
    platform: "mac",
    kind: "command",
    command: "/usr/bin/open",
    args: ["-a", "Terminal", "{{dir}}"],
    enabled: true,
  },
  /* 這一條沒有外部依賴、行動版也能用 —— 放進範例是為了讓人看到「不必碰 shell 也能擴充」 */
  {
    id: "example-new-window",
    label: "Open in a new window",
    key: "n",
    appliesTo: "file",
    extensions: [],
    platform: "all",
    kind: "obsidian-command",
    commandId: "workspace:open-in-new-window",
    enabled: true,
  },
];

/*
 * 設定頁「加入範例」用的。不是預設值 —— 按了才會進使用者的設定。
 *
 * 前四個刻意**不預設任何詞彙**：命中條件是「這個欄位有值」而不是「等於某個字」，
 * 所以不管你的 status 寫的是 draft/final、待辦/完成、還是 1/2/3 都會動。
 * 範例的用途是讓人看懂這個功能跟**他自己的筆記**有什麼關係，不是示範作者的制度。
 * 最後一個才是「有一整套詞彙時長什麼樣」的完整示範（含對照表、排序權重、逾期）。
 */
const EXAMPLE_DECORATIONS = [
  {
    id: "example-status",
    name: "Show a status field on any note that has one",
    when: { field: "status" },
    icon: { from: "fixed", value: "·" },
    status: { field: "status" },
    /* 預覽用的假值。底線開頭的 key 只有設定頁的範例牆看，加入設定時會被剝掉。 */
    _sample: { status: "draft" },
    enabled: true,
  },
  {
    id: "example-alias",
    name: "Show the alias instead of the file name",
    when: { field: "aliases" },
    icon: { from: "fixed", value: "·" },
    title: { from: "field", field: "aliases", fallback: "filename" },
    subtitle: { from: "basename" },
    enabled: true,
  },
  {
    id: "example-icon-field",
    name: "Use an icon field as the row icon",
    when: { field: "icon" },
    icon: { from: "field", field: "icon" },
    enabled: true,
  },
  {
    id: "example-archived",
    name: "Dim archived notes",
    when: { field: "archived", equals: true },
    icon: { from: "fixed", value: "📦" },
    dimWhen: [{ field: "archived", equals: true }],
    enabled: true,
  },
  {
    id: "example-task",
    name: "Tasks: icon per kind, status badge, high priorities only",
    when: { field: "type", equals: "task" },
    icon: { from: "map", field: "kind", map: { feature: "✨", bug: "🐞", chore: "🔧" }, fallback: "📌" },
    group: { field: "kind", order: ["feature", "bug", "chore"] },
    status: {
      field: "status",
      map: {
        backlog: { text: "📥", order: 1 },
        todo: { text: "📋", order: 2 },
        doing: { text: "🔨", order: 3 },
        done: { text: "✅", order: 4, dim: true },
      },
    },
    priority: { field: "priority", order: { P0: 0, P1: 1, P2: 2, P3: 3 }, showMaxOrder: 1 },
    overdue: { field: "due" },
    enabled: true,
  },
];

/** 搜尋條件（gt / gf 的組合卡）。預設只給每個 vault 都有的那幾個。 */
/*
 * 關聯（gr）要讀哪些 frontmatter 欄位。
 *
 * 只列**正向**的欄位：反向那一組（Children / Down）是掃出來的，不是另一個欄位 ——
 * 兩邊都存一定會漂掉（見 core/relations.js）。
 *
 * 這三個是社群裡最通用的：
 *   parent   任務／筆記的上一層（Obsidian Tasks、專案管理那類用法）
 *   up       這則筆記歸在哪個主題底下（LYT / MOC 那派的慣例，指向索引頁）
 *   related  對稱的「有關」，兩邊都看得到
 *   blocks   「這張沒做完，那些就不能開始」（Linear / Jira 的用法）
 * 用不到的把 enabled 關掉即可；欄位名不合自己的習慣就直接改 field。
 *
 * ⚠️ 這些值要是 [[wikilink]]（或 wikilink 清單）。純文字的 id 也認得出來（會拿去
 *    比對檔名開頭），但那是**退路**不是建議寫法 —— wikilink 才能讓 Obsidian 的
 *    改名追蹤、反向連結、關係圖一起生效。
 */
const DEFAULT_RELATIONS = [
  { id: "parent", enabled: true, field: "parent", label: "Parent", inverse: "Children" },
  { id: "up", enabled: true, field: "up", label: "Up", inverse: "Down" },
  { id: "related", enabled: true, field: "related", label: "Related", symmetric: true },
  { id: "blocks", enabled: true, field: "blocks", label: "Blocks", inverse: "Blocked by" },
];

const DEFAULT_FACETS = [
  { id: "scope", key: "f", icon: "📁", label: "Folder", kind: "path", enabled: true },
  { id: "tag", key: "t", icon: "🏷", label: "Tag", kind: "tag", enabled: true },
  { id: "ext", key: "e", icon: "🧩", label: "Extension", kind: "ext", enabled: true },
  { id: "exclude", key: "x", icon: "➖", label: "Exclude word", kind: "free", enabled: true },
  { id: "regex", key: "r", icon: ".*", label: "Regex", kind: "free", enabled: true },
];

const DEFAULT_SETTINGS = {
  /* 設定格式的版本。migrate.js 靠它決定要不要升級舊的 data.json。 */
  schemaVersion: 1,

  /* "auto" ＝ 跟著 Obsidian 的語言走，找不到翻譯就退回英文 */
  locale: "auto",

  /* 鍵位覆寫，一段文字（map / unmap，語法見 core/keymap.js）。
     預設空的＝完全照內建鍵位。 */
  keymap: "",

  openers: DEFAULT_OPENERS,
  decorations: DEFAULT_DECORATIONS,
  facets: DEFAULT_FACETS,
  relations: DEFAULT_RELATIONS,

  /*
   * 儲存的檢視（gv）。刻意是空的：一個檢視存的是**條件**（status 是什麼、tag 是什麼），
   * 而那些值只在寫它的人自己的 vault 裡有意義 —— 預載別人的詞彙表只會得到一排永遠
   * 0 筆的檢視。做法是自己組一次搜尋、滿意了再按 ,v 存起來。
   */
  views: [],

  preview: {
    /* markdown 渲染成閱讀檢視的樣子。關掉就是純文字。 */
    renderMarkdown: true,
    /* 停多久才把純文字換成渲染版（毫秒）。太小會在長按 j 時每一列都渲染。 */
    renderDelay: 120,
    /* J / K 一次捲幾行 */
    seekLines: 5,
    maxChars: 20000,
    maxLines: 400,
    /* 滑鼠滾輪一律捲預覽欄，不管游標停在哪一欄 */
    wheelScrollsPreview: true,
  },

  behavior: {
    /* 最後一個按 j 回到第一個（只作用於單步移動） */
    wrapCursor: true,
    /* d / u 一次跳幾列 */
    halfPage: 10,
    /* 清單檢視最多列幾筆 */
    recentLimit: 40,
    frecencyLimit: 60,
    searchLimit: 60,
  },

  index: {
    /* 全文搜尋索引。第一次用 gt 時才會建。 */
    enabled: true,
    /* 單檔超過就不收（位元組） */
    maxFileBytes: 1048576,
    /* 每個檔最多記幾個字 */
    maxChars: 200000,
    /* 這些資料夾不進索引（前綴比對） */
    excludeFolders: [],
  },

  /* 以下是使用者資料，不是偏好設定，但住在同一個 data.json 裡 */
  bookmarks: [],
  frecency: {},
  sort: { field: "name", reverse: false, foldersFirst: true },
  // 搜尋結果自己一份：natural ＝不重排，留住相關度（見 YaziModal.sortCfg）
  sortSearch: { field: "natural", reverse: false, foldersFirst: true },
};

/** 深拷貝一份預設值（呼叫端會就地改，不能共用同一個物件）。 */
function defaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

module.exports = {
  PLACEHOLDERS,
  OPENER_KINDS,
  DEFAULT_OPENERS,
  EXAMPLE_OPENERS,
  DEFAULT_DECORATIONS,
  EXAMPLE_DECORATIONS,
  DEFAULT_FACETS,
  DEFAULT_RELATIONS,
  DEFAULT_SETTINGS,
  defaultSettings,
};
