/* core/openers.js：選單過濾與指令展開。純函式，不需要 Obsidian。 */
const { resolveOpeners, opnerApplies, expand, opnerVars, buildCommand, platformId } = require("../src/core/openers.js");

let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};

const O = (over) => Object.assign({ id: "x", label: "X", key: "x", appliesTo: "both", extensions: [], platform: "all", kind: "system", enabled: true }, over);
const FILE = { folder: false, ext: "md" };
const PNG = { folder: false, ext: "png" };
const DIR = { folder: true, ext: "" };

/* ── 適用判斷 ── */
eq("both 對檔案", opnerApplies(O(), FILE, "win", true), true);
eq("both 對資料夾", opnerApplies(O(), DIR, "win", true), true);
eq("file 不對資料夾", opnerApplies(O({ appliesTo: "file" }), DIR, "win", true), false);
eq("folder 不對檔案", opnerApplies(O({ appliesTo: "folder" }), FILE, "win", true), false);
eq("副檔名限定：命中", opnerApplies(O({ extensions: ["md"] }), FILE, "win", true), true);
eq("副檔名限定：沒命中", opnerApplies(O({ extensions: ["md"] }), PNG, "win", true), false);
eq("副檔名寫成 .MD 也算", opnerApplies(O({ extensions: [".MD"] }), FILE, "win", true), true);
eq("副檔名限定不影響資料夾（appliesTo 才是關鍵）", opnerApplies(O({ extensions: ["md"], appliesTo: "folder" }), DIR, "win", true), true);
eq("平台不符", opnerApplies(O({ platform: "mac" }), FILE, "win", true), false);
eq("平台相符", opnerApplies(O({ platform: "win" }), FILE, "win", true), true);
eq("停用的不出現", opnerApplies(O({ enabled: false }), FILE, "win", true), false);
eq("command 在行動版不出現", opnerApplies(O({ kind: "command" }), FILE, "win", false), false);
eq("system 在行動版仍出現", opnerApplies(O({ kind: "system" }), FILE, "win", false), true);

/* ── 選單順序＝設定順序 ── */
const list = [O({ id: "a", key: "a" }), O({ id: "b", key: "b", appliesTo: "folder" }), O({ id: "c", key: "c" })];
eq("選單依設定順序、只留適用的", resolveOpeners(list, FILE, "win", true).map((o) => o.id), ["a", "c"]);
eq("資料夾的選單", resolveOpeners(list, DIR, "win", true).map((o) => o.id), ["a", "b", "c"]);
eq("沒有設定時是空選單", resolveOpeners(null, FILE, "win", true), []);

/* ── 佔位字展開 ── */
const t = {
  path: "C:\\Vault\\100 work\\note.md", relPath: "100 work/note.md",
  folder: false, ext: "md", name: "note.md", basename: "note",
};
const vars = opnerVars(t, { path: "C:\\Vault", name: "Vault" });
eq("{{path}}", expand("{{path}}", vars), "C:\\Vault\\100 work\\note.md");
eq("{{dir}} 取檔案所在資料夾", vars.dir, "C:\\Vault\\100 work");
eq("{{basename}} / {{ext}}", expand("{{basename}}.{{ext}}", vars), "note.md");
eq("{{vaultName}}", expand("{{vaultName}}", vars), "Vault");
eq("不認得的佔位字原樣留著（打錯字看得見）", expand("{{paht}}", vars), "{{paht}}");
eq("資料夾的 {{dir}} 是它自己", opnerVars({ path: "/vault/notes", folder: true }, {}).dir, "/vault/notes");

/* ── 組指令 ── */
const nvim = O({
  kind: "command",
  command: "powershell.exe",
  args: ["-NoProfile", "-File", "C:\\scripts\\open.ps1", "nvim", "{{path}}"],
});
eq("參數一個一個展開，不切字串", buildCommand(nvim, vars),
   ["powershell.exe", ["-NoProfile", "-File", "C:\\scripts\\open.ps1", "nvim", "C:\\Vault\\100 work\\note.md"]]);
eq("含空白的路徑不會被切開", buildCommand(O({ command: "code", args: ["{{dir}}"] }), vars)[1], ["C:\\Vault\\100 work"]);
eq("沒有 args 也不會炸", buildCommand(O({ command: "open" }), vars), ["open", []]);

/* ── 平台代號 ── */
eq("platformId win", platformId({ isWin: true }), "win");
eq("platformId mac", platformId({ isMacOS: true }), "mac");
eq("platformId linux", platformId({}), "linux");

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
