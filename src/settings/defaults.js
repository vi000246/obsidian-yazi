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

/** 設定頁「加入範例」用的。不是預設值，使用者按了才會進他的設定。 */
const EXAMPLE_DECORATIONS = [
  {
    id: "example-diary",
    name: "Diary: mood icon + title",
    when: { field: "type", equals: "diary" },
    icon: { from: "field", field: "mood" },
    title: { from: "field", field: "title", fallback: "filename" },
    subtitle: { from: "basename" },
    tail: [],
    enabled: true,
  },
  {
    id: "example-status",
    name: "Tasks: status and priority tail",
    when: { field: "type", equals: "task" },
    icon: { from: "fixed", value: "📌" },
    title: { from: "filename" },
    subtitle: { from: "none" },
    tail: [{ field: "status" }, { field: "priority" }],
    enabled: true,
  },
];

/** 搜尋條件（gt / gf 的組合卡）。預設只給每個 vault 都有的那幾個。 */
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

  /* actionId → 綁定陣列。空陣列＝這個動作沒有鍵（但仍可從命令面板或選單觸發）。
     實際的預設內容在 core/keymap.js（那裡才知道有哪些 action）。 */
  keymap: {},

  openers: DEFAULT_OPENERS,
  decorations: DEFAULT_DECORATIONS,
  facets: DEFAULT_FACETS,

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
};

/** 深拷貝一份預設值（呼叫端會就地改，不能共用同一個物件）。 */
function defaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

module.exports = {
  PLACEHOLDERS,
  OPENER_KINDS,
  DEFAULT_OPENERS,
  DEFAULT_DECORATIONS,
  EXAMPLE_DECORATIONS,
  DEFAULT_FACETS,
  DEFAULT_SETTINGS,
  defaultSettings,
};
