/*
 * 開啟方式（大寫 O 的選單）。
 *
 * 這支只做兩件事：**挑出哪些 opener 適用於游標這一項**，以及**把一條 opener 變成
 * 實際的動作**。規則本身完全來自設定（見 settings/defaults.js），程式碼裡沒有任何
 * 寫死的路徑或程式名稱 —— 那是這個 plugin 能公開發佈的前提。
 *
 * 分成純函式（resolve / expand）與有副作用的執行（runOpener）兩半，前者可以在
 * 沒有 Obsidian、沒有作業系統的情況下測試，而那半正是容易錯的部分。
 */

/** 目前平台的代號，對應 opener 的 platform 欄位。 */
function platformId(Platform) {
  if (!Platform) return "all";
  if (Platform.isWin) return "win";
  if (Platform.isMacOS) return "mac";
  return "linux";
}

/**
 * 這條 opener 適用於這個項目嗎。
 * @param {object} o     一條 opener 設定
 * @param {object} item  { folder: boolean, ext: string }
 * @param {string} plat  "win" / "mac" / "linux"
 * @param {boolean} desktop 桌面版才能生外部行程
 */
function opnerApplies(o, item, plat, desktop) {
  if (!o || o.enabled === false) return false;
  if (o.platform && o.platform !== "all" && o.platform !== plat) return false;
  if (o.kind === "command" && !desktop) return false;

  const applies = o.appliesTo || "both";
  if (applies === "file" && item.folder) return false;
  if (applies === "folder" && !item.folder) return false;

  /* 副檔名條件只對檔案有意義：資料夾沒有副檔名，拿它去比對只會讓
     「限定 .md 的 opener」在資料夾上神秘消失又神秘出現。 */
  const exts = (o.extensions || []).map((e) => String(e).replace(/^\./, "").toLowerCase()).filter(Boolean);
  if (exts.length && !item.folder && !exts.includes(String(item.ext || "").toLowerCase())) return false;

  return true;
}

/** 選單內容：適用的 opener，依設定順序。 */
function resolveOpeners(openers, item, plat, desktop) {
  return (openers || []).filter((o) => opnerApplies(o, item, plat, desktop));
}

/**
 * 把 {{placeholder}} 換成真的值。
 * 找不到的佔位字**原樣留著**而不是換成空字串 —— 打錯字時看得見 `{{paht}}`，
 * 換成空的話只會得到一個少了參數、行為詭異的指令。
 */
function expand(template, vars) {
  return String(template == null ? "" : template).replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
  );
}

/**
 * 組出指令要用的變數表。
 * @param {object} t  { path（絕對）, relPath, folder, ext, name, basename }
 * @param {object} vault { path（絕對）, name }
 */
function opnerVars(t, vault) {
  const sep = String(t.path || "").includes("\\") ? "\\" : "/";
  const cut = Math.max(String(t.path || "").lastIndexOf("/"), String(t.path || "").lastIndexOf("\\"));
  return {
    path: t.path || "",
    dir: t.folder ? t.path || "" : cut > 0 ? t.path.slice(0, cut) : (vault && vault.path) || "",
    relPath: t.relPath || "",
    name: t.name || "",
    basename: t.basename || "",
    ext: t.ext || "",
    vaultPath: (vault && vault.path) || "",
    vaultName: (vault && vault.name) || "",
    sep,
  };
}

/**
 * 把一條 command opener 變成 spawn 要的 [執行檔, 參數陣列]。
 * 參數是一個一個展開的（不是把整串指令切開）—— 路徑含空白時，切字串那條路一定會爆，
 * 而 Windows 上「路徑含空白」是常態。
 */
function buildCommand(o, vars) {
  const cmd = expand(o.command, vars);
  const args = (o.args || []).map((a) => expand(a, vars));
  return [cmd, args];
}

module.exports = { platformId, opnerApplies, resolveOpeners, expand, opnerVars, buildCommand };
