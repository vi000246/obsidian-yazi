/* core/aliases.js：frontmatter 別名的各種寫法都要讀得出來 */
const { aliasesOf } = require("../src/core/aliases.js");

let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};

eq("沒有 frontmatter", aliasesOf(null), []);
eq("沒有別名欄位", aliasesOf({ title: "x" }), []);
eq("aliases 清單", aliasesOf({ aliases: ["Foo", "Bar"] }), ["Foo", "Bar"]);
eq("aliases 單一字串", aliasesOf({ aliases: "Foo" }), ["Foo"]);
eq("aliases 逗號字串（舊版 Obsidian 的存法）", aliasesOf({ aliases: "Foo, Bar" }), ["Foo", "Bar"]);
eq("清單裡的元素不照逗號切", aliasesOf({ aliases: ["Foo, Inc"] }), ["Foo, Inc"]);
eq("舊寫法 alias 也認", aliasesOf({ alias: "Old" }), ["Old"]);
eq("兩個欄位都有就合併、去重", aliasesOf({ aliases: ["A", "B"], alias: "B" }), ["A", "B"]);
eq("空白與 null 元素丟掉", aliasesOf({ aliases: ["", "  ", null, "X"] }), ["X"]);
eq("數字別名轉成字串", aliasesOf({ aliases: [2024] }), ["2024"]);
eq("aliases: null（YAML 空值）", aliasesOf({ aliases: null }), []);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
