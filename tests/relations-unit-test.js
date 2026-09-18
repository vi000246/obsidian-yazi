/* core/relations.js：連結欄位的解析，以及「反向靠推導」這件事 */
const { parseLinks, collectRelations } = require("../src/core/relations.js");

let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};

/* ── parseLinks ── */
eq("空值", [parseLinks(undefined), parseLinks(null), parseLinks("")], [[], [], []]);
eq("單一 wikilink", parseLinks("[[OB-19 開會]]"), ["OB-19 開會"]);
eq("別名切掉", parseLinks("[[path/to/a.md|顯示名]]"), ["path/to/a.md"]);
eq("#標題與 ^區塊切掉", parseLinks(["[[A#章節]]", "[[B^blk]]"]), ["A", "B"]);
eq("清單", parseLinks(["[[A]]", "[[B]]"]), ["A", "B"]);
eq("一個字串裡好幾個連結", parseLinks("[[A]] 和 [[B]]"), ["A", "B"]);
eq("沒有 [[ ]] 的純字串整串當目標（有人就是寫 parent: OB-19）", parseLinks("OB-19"), ["OB-19"]);
eq("純字串有 [[ ]] 時就不整串當目標", parseLinks("見 [[A]]"), ["A"]);
eq("去重", parseLinks(["[[A]]", "[[A|別名]]"]), ["A"]);
eq("空白元素丟掉", parseLinks(["", "  ", "[[A]]"]), ["A"]);
eq("物件不猜", parseLinks({ a: 1 }), []);

/* ── collectRelations ── */
const F = (path) => ({ path, basename: path.replace(/\.md$/, "") });
const a = F("a.md"), b = F("b.md"), c = F("c.md"), d = F("d.md"), e = F("e.md");
const ALL = [a, b, c, d, e];
const FM = {
  "a.md": { parent: "[[b]]", related: "[[c]]" },
  "b.md": {},
  "c.md": {},
  "d.md": { parent: "[[a]]" },          // a 的 child
  "e.md": { related: "[[a]]" },         // 對稱：從另一邊寫的
};
const ctx = (over) => Object.assign({
  fmOf: (f) => FM[f.path] || null,
  resolve: (p) => ALL.find((x) => x.basename === p) || null,
  mdFiles: () => ALL,
  linksFrom: () => [],
  linksTo: () => [],
  labels: {},
}, over);
const RULES = [
  { field: "parent", label: "Parent", inverse: "Children" },
  { field: "related", label: "Related", symmetric: true },
];
const dump = (gs) => gs.map((g) => [g.label, g.items.map((f) => f.basename)]);

eq("正向 parent、推導出的 children、對稱的 related（兩邊都算）",
   dump(collectRelations(a, RULES, ctx())),
   [["Parent", ["b"]], ["Children", ["d"]], ["Related", ["c", "e"]]]);
eq("從 b 看：只有推導出來的 children", dump(collectRelations(b, RULES, ctx())), [["Children", ["a"]]]);
eq("空的組不回", dump(collectRelations(c, [RULES[0]], ctx())), []);
eq("enabled: false 的規則跳過",
   dump(collectRelations(a, [Object.assign({ enabled: false }, RULES[0]), RULES[1]], ctx())),
   [["Related", ["c", "e"]]]);
eq("沒有 inverse 就不推導反向",
   dump(collectRelations(a, [{ field: "parent", label: "Parent" }], ctx())), [["Parent", ["b"]]]);
eq("label 沒填就用欄位名", dump(collectRelations(a, [{ field: "parent" }], ctx())), [["parent", ["b"]]]);

/* 指向自己的不列（frontmatter 寫錯或複製貼上的產物） */
eq("自我連結不列",
   dump(collectRelations(b, [{ field: "self", label: "Self" }], ctx({ fmOf: () => ({ self: "[[b]]" }) }))), []);

/* 解析不到的連結安靜跳過，不要變成一列壞掉的項目 */
eq("解析不到的連結跳過",
   dump(collectRelations(a, [{ field: "parent", label: "Parent" }], ctx({ resolve: () => null }))), []);

/* 一般連結：扣掉已經有型別的，排在最後 */
const withLinks = ctx({
  linksFrom: () => [b, c],       // b 是 parent、c 是 related，兩個都已經有型別了
  linksTo: () => [d, e],         // d 是 child、e 是 related
  labels: { links: "Links", backlinks: "Backlinks" },
});
eq("有型別的不會重複出現在一般連結裡", dump(collectRelations(a, RULES, withLinks)),
   [["Parent", ["b"]], ["Children", ["d"]], ["Related", ["c", "e"]]]);
const onlyPlain = ctx({
  fmOf: () => null,
  linksFrom: () => [b],
  linksTo: () => [c],
  labels: { links: "Links", backlinks: "Backlinks" },
});
eq("沒有型別欄位時，一般連結照樣列（反向在前）", dump(collectRelations(a, RULES, onlyPlain)),
   [["Backlinks", ["c"]], ["Links", ["b"]]]);

/* 同一個檔在兩種關係裡都出現 → 兩組都列（那是資訊，不是錯誤） */
const dual = ctx({ fmOf: (f) => (f.path === "a.md" ? { parent: "[[b]]", related: "[[b]]" } : {}) });
eq("同一個檔可以同時是 parent 與 related", dump(collectRelations(a, RULES, dual)),
   [["Parent", ["b"]], ["Related", ["b"]]]);

/* 規則順序＝顯示順序 */
eq("組的順序照規則順序", dump(collectRelations(a, [RULES[1], RULES[0]], ctx())).map((x) => x[0]),
   ["Related", "Parent", "Children"]);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
