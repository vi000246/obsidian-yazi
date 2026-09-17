/*
 * core/decorate.js：規則引擎。
 * 這支的每一項都對照**原本寫死在 code 裡的 fmInfo 行為** —— 這次重構的驗收標準是
 * 「同一份 frontmatter 畫出來的東西一模一樣」，所以測的是那個等價性，不是新功能。
 */
const { decorate, todayStr, LAST } = require("../src/core/decorate.js");

/* Logan 的實際規則（之後會 seed 進他的 data.json），照 vault 的詞彙表逐字抄 */
const KINDS = ["功能", "Bug", "分析", "決策", "會議", "維護"];
const KIND_ICON = { 功能: "✨", Bug: "🐞", 分析: "🔍", 決策: "⚖️", 會議: "👥", 維護: "🔧" };
const CATS = ["需求", "調查、分析", "提案、設計", "規格", "資料、參考", "溝通", "事故檢討", "其他"];
const CAT_ICON = { 需求: "📋", "調查、分析": "🔍", "提案、設計": "✏️", 規格: "📐", "資料、參考": "📚", 溝通: "💬", 事故檢討: "🚨", 其他: "🗃" };

const RULES = [
  {
    id: "task", enabled: true, when: { field: "type", equals: "task" },
    icon: { from: "map", field: "kind", map: KIND_ICON, fallback: "📌" },
    group: { field: "kind", order: KINDS },
    status: { field: "status", map: {
      "1 Backlog": { text: "📥", order: 1 }, "2 Todo": { text: "📋", order: 2 },
      "3 In Progress": { text: "🔨", order: 3 }, "4 In Review": { text: "👀", order: 4 },
      "5 Done": { text: "✅", order: 5, dim: true }, "6 Canceled": { text: "🚫", order: 6, dim: true },
    } },
    priority: { field: "priority", order: { "P0 Urgent": 0, "P1 High": 1, "P2 Medium": 2, "P3 Low": 3 }, showMaxOrder: 1 },
    overdue: { field: "due" },
  },
  {
    id: "doc", enabled: true, when: { field: "type", in: ["doc", "doc-ref"] },
    icon: { from: "map", field: "category", map: CAT_ICON, fallback: "📄" },
    group: { field: "category", order: CATS },
    status: { field: "status", map: { draft: { text: "draft", order: 1 }, final: { text: "final", order: 2 } } },
    dimWhen: [{ field: "archived", equals: true }],
    pinWhen: [{ field: "pinned", equals: true }],
    statusWhen: [{ field: "missing", equals: true, text: "missing", dim: true }],
  },
  {
    id: "diary", enabled: true, when: { field: "type", equals: "diary" },
    icon: { from: "field", field: "mood" },
    title: { from: "field", field: "title", fallback: "filename" },
    subtitle: { from: "basename" },
  },
];

const NAMES = { name: "2026-09-13.md", basename: "2026-09-13" };
let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "  want " + JSON.stringify(want)));
};
const d = (fm, names) => decorate(fm, RULES, names || NAMES);
const pick = (o, keys) => { const r = {}; for (const k of keys) r[k] = o[k]; return r; };

/* ── task ── */
let r = d({ type: "task", kind: "Bug", status: "3 In Progress", priority: "P0 Urgent" });
eq("task：kind 決定圖示", r.icon, "🐞");
eq("task：狀態徽章與權重", pick(r, ["status", "statusOrder"]), { status: "🔨", statusOrder: 3 });
eq("task：P0 畫出來", pick(r, ["prio", "prioOrder"]), { prio: "P0", prioOrder: 0 });
eq("task：分組權重＝kind 在清單裡的位置", pick(r, ["group", "groupOrder"]), { group: "Bug", groupOrder: 1 });

r = d({ type: "task", kind: "功能", status: "5 Done", priority: "P2 Medium" });
eq("task：Done 變淡", r.dim, true);
eq("task：P2 不畫（每一列都有就是噪音），但排序權重仍在", pick(r, ["prio", "prioOrder"]), { prio: "", prioOrder: 2 });

r = d({ type: "task", status: "2 Todo" });
eq("task：沒有 kind 時的預設圖示", r.icon, "📌");
r = d({ type: "task", kind: "外星人", status: "2 Todo" });
eq("task：不認得的 kind ＝ ❓（漂移偵測，不是靜靜退回預設）", r.icon, "❓");
r = d({ type: "task", status: "7 Unknown" });
eq("task：不認得的狀態把原值攤出來", r.status, "❓7 Unknown");

/* 逾期 */
const past = "2020-01-01";
const future = "2999-01-01";
eq("task：過期未完成＝逾期", d({ type: "task", status: "2 Todo", due: past }).overdue, true);
eq("task：未來的期限不算逾期", d({ type: "task", status: "2 Todo", due: future }).overdue, false);
eq("task：已完成就不標逾期（做完的事沒有逾期可言）", d({ type: "task", status: "5 Done", due: past }).overdue, false);
eq("todayStr 格式", todayStr(new Date(2026, 8, 5)), "2026-09-05");

/* ── doc ── */
r = d({ type: "doc", category: "規格", status: "final" });
eq("doc：category 決定圖示", r.icon, "📐");
eq("doc：狀態用短字不用符號", pick(r, ["status", "statusOrder"]), { status: "final", statusOrder: 2 });
eq("doc：沒有 category 的預設圖示", d({ type: "doc" }).icon, "📄");
eq("doc：空 category 不算未知（留空是合法的）", d({ type: "doc", category: "" }).icon, "📄");
eq("doc-ref 吃同一條規則", d({ type: "doc-ref", category: "需求" }).icon, "📋");
eq("doc：archived 變淡", d({ type: "doc", archived: true }).dim, true);
eq("doc：pinned", d({ type: "doc", pinned: true }).pinned, true);
r = d({ type: "doc", missing: true, status: "draft" });
eq("doc：原檔不見了 → 狀態換成 missing 並變淡", pick(r, ["status", "dim"]), { status: "missing", dim: true });

/* ── diary ── */
r = d({ type: "diary", mood: "🤩", title: "九份二日遊" });
eq("diary：心情當圖示、標題當主文字、檔名縮到右邊",
   pick(r, ["icon", "title", "subtitle"]), { icon: "🤩", title: "九份二日遊", subtitle: "2026-09-13" });
eq("diary：沒填標題就退回檔名（含副檔名，跟平常的列一樣）", d({ type: "diary", mood: "😄" }).title, "2026-09-13.md");
eq("diary：退回檔名時不算「標題來自欄位」，右邊就不會再印一次日期", d({ type: "diary", mood: "😄" }).titleFromField, false);

/* ── 沒有規則命中 ── */
eq("沒有 type 的筆記不裝飾", d({ foo: "bar" }), null);
eq("type 不在任何規則裡也不裝飾", d({ type: "note" }), null);
eq("沒有 frontmatter", decorate(null, RULES), null);
eq("沒有規則（預設狀態）＝完全不裝飾", decorate({ type: "task" }, []), null);
eq("停用的規則不生效", decorate({ type: "task" }, [Object.assign({}, RULES[0], { enabled: false })]), null);

/* 排序權重：沒有的欄位一律沉底 */
r = d({ type: "doc" });
eq("沒有狀態/優先度時權重沉底", pick(r, ["statusOrder", "prioOrder", "groupOrder"]),
   { statusOrder: LAST, prioOrder: LAST, groupOrder: LAST });

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
