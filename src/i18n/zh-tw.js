/*
 * 繁體中文。
 *
 * 缺的 key 會自動退回 en.js，所以這份**不必是完整的** —— 補到哪算到哪，
 * 不會因為漏一個就讓介面出現 key 名稱。
 */
module.exports = {
  /* ── 命令 ── */
  "cmd.open": "開啟浮動檔案瀏覽器（定位到當前檔案）",
  "cmd.openTabs": "開啟分頁清單",
  "cmd.openBookmarks": "開啟書籤清單",
  "cmd.openRecent": "開啟最近檔案",
  "cmd.openSearch": "開啟全文搜尋",

  /* ── 提示 ── */
  "notice.noPath": "這一項沒有對應的檔案路徑",
  "notice.noOpeners": "這一項沒有可用的外部開啟方式",
  "notice.noAbsPath": "算不出絕對路徑（行動版沒有）",
  "notice.openFailed": "開啟失敗",
  "notice.copied": "已複製：{text}",
  "notice.copyFailed": "複製失敗：{error}",
  "notice.nothingToCopy": "沒有可複製的路徑",
  "notice.atVaultRoot": "已經在 vault 根目錄",
  "notice.deleted": "已刪除 {count} 個項目",
  "notice.deleteFailed": "刪除失敗 {count} 個：\n{errors}",
  "notice.pathGone": "路徑已不存在：{path}",
  "notice.sort": "排序：{value}",
  "notice.previewRendered": "預覽：渲染 markdown",
  "notice.previewPlain": "預覽：原始文字",

  /* ── 瀏覽器介面 ── */
  "ui.empty": "（空）",
  "ui.emptyFolder": "（空資料夾）",
  "ui.noItems": "（沒有項目）",
  "ui.noPreview": "（無法預覽）",
  "ui.help": "? 說明",
  "ui.helpTitle": "按鍵總覽　·　Esc 或 ? 關閉說明",
  "ui.cancel": "Esc 取消",
  "ui.waitingKey": "等下一顆鍵",
  "ui.selected": "已選 {count}",
  "ui.filter": "篩選：{value}",
  "ui.vaultRoot": "（vault 根目錄）",

  /* ── 設定：分頁 ── */
  "settings.section.keys": "鍵位",
  "settings.section.openers": "開啟方式",
  "settings.section.decorations": "列裝飾",
  "settings.section.search": "搜尋欄位",
  "settings.section.preview": "預覽",
  "settings.section.index": "索引",

  /* ── 設定：共用 ── */
  "settings.export": "匯出",
  "settings.import": "匯入",
  "settings.reset": "重設",
  "settings.exported": "已複製到剪貼簿",
  "settings.imported": "已匯入",
  "settings.resetConfirm": "把這一段重設回預設值？",
  "settings.language": "語言",
  "settings.languageDesc": "跟著 Obsidian，或直接指定一種。",

  /* ── 設定：開啟方式 ── */
  "settings.openers.desc":
    "大寫 O 的選單內容。每一條是「一顆鍵 ＋ 一個動作」，選單會依游標停在檔案還是資料夾自動變化。",
  "settings.openers.empty": "還沒有任何開啟方式。",
  "settings.openers.label": "名稱",
  "settings.openers.labelDesc": "顯示在 O 的選單裡。",
  "settings.openers.key": "鍵",
  "settings.openers.keyDesc": "按 O 之後要按的那一顆。留空就只能從選單挑。",
  "settings.openers.appliesTo": "適用於",
  "settings.openers.extensions": "副檔名",
  "settings.openers.extensionsDesc": "逗號分隔，例如 md, canvas。留空＝所有檔案。",
  "settings.openers.platform": "平台",
  "settings.openers.kind": "動作",
  "settings.openers.command": "執行檔",
  "settings.openers.commandDesc": "完整路徑，或 PATH 上的名稱。",
  "settings.openers.args": "參數",
  "settings.openers.argsDesc": "一行一個。每一行當成一個獨立參數傳過去，所以含空白的路徑不必跳脫。",
  "settings.openers.placeholders": "可用的佔位字",
  "settings.openers.commandId": "命令 ID",
  "settings.openers.commandIdDesc": "例如 editor:open-search。會先開啟游標所在的檔案，再執行該命令。",
  "settings.openers.desktopOnly": "只有桌面版。這會生一個外部行程，行動版不會出現這一項。",
  "settings.openers.addSystem": "系統預設程式",
  "settings.openers.addCommand": "外部指令",
  "settings.openers.addObsidian": "Obsidian 命令",
  "settings.openers.kind.system": "系統預設程式",
  "settings.openers.kind.reveal": "檔案管理器",
  "settings.openers.kind.command": "外部指令",
  "settings.openers.kind.obsidian": "Obsidian 命令",

  /* ── 設定：鍵位 ── */
  "settings.keys.desc": "任何動作都能改鍵，支援多鍵序列（例如 g g）。",

  /* ── 設定：列裝飾 ── */
  "settings.decorations.desc": "用 frontmatter 決定一列長什麼樣：圖示、換成別的標題、右側的次要欄位。",

  /* ── 設定：搜尋 ── */
  "settings.search.desc": "哪些 frontmatter 欄位要變成搜尋條件。",

  /* ── 設定：預覽 ── */
  "settings.preview.render": "渲染 markdown",
  "settings.preview.renderDesc":
    "預覽欄畫成閱讀檢視的樣子。plugin 的區塊（dataviewjs、tasks、meta-bind…）一律會先被拿掉，所以瀏覽不會執行任何東西。",
  "settings.preview.delay": "渲染延遲",
  "settings.preview.delayDesc":
    "純文字先出現，停頓這麼久之後才換成渲染版。長按 j 滑過一整個資料夾時，只有停住的那一列會渲染。",
  "settings.preview.seek": "捲動幅度",
  "settings.preview.seekDesc": "預覽捲動鍵一次捲幾行。",
  "settings.preview.wheel": "滾輪捲預覽",
  "settings.preview.wheelDesc": "不管滑鼠停在哪一欄，滾輪都捲預覽欄——不用先把游標移過去。",
  "settings.behavior.wrap": "循環移動",
  "settings.behavior.wrapDesc": "最後一個按下移會回到第一個。半頁移動與 visual 模式不循環。",
  "settings.behavior.halfPage": "半頁列數",
  "settings.behavior.halfPageDesc": "半頁鍵一次跳幾列。",

  /* ── 設定：索引 ── */
  "settings.index.desc": "全文搜尋有自己的索引：第一次搜尋時才建，存在 plugin 的資料夾，檔案變動時跟著更新。",
  "settings.index.enabled": "啟用全文搜尋",
  "settings.index.maxFile": "超過這個大小的檔案不收",
  "settings.index.maxFileDesc": "MB。",
  "settings.index.exclude": "排除的資料夾",
  "settings.index.excludeDesc": "一行一個，用 vault 相對路徑做前綴比對。",
  "settings.index.stats": "已索引",
};
