/* core/outline.js：標題 → 清單項目、純文字裡找標題的行號 */
const { outlineItems, headingLines } = require("../src/core/outline.js");

let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};

/* ── outlineItems ── */
const H = (level, heading, line) => ({ level, heading, position: { start: { line } } });

eq("沒有標題 → 空清單", outlineItems(undefined), []);
eq("null 也不能爆", outlineItems(null), []);

const items = outlineItems([H(2, "Intro", 3), H(3, "Detail", 8), H(2, "  Next  ", 20), H(4, "", 25)], "(untitled)");
eq("標籤、層級、行號、序號", items.map((i) => [i.label, i.level, i.line, i.idx]),
   [["Intro", 2, 3, 0], ["Detail", 3, 8, 1], ["Next", 2, 20, 2], ["(untitled)", 4, 25, 3]]);
eq("depth 相對最淺層（從 H2 開始就從 0 算）", items.map((i) => i.depth), [0, 1, 0, 2]);
eq("depth 上限 5", outlineItems([H(1, "a", 0), H(6, "b", 1), H(6, "c", 2)]).map((i) => i.depth), [0, 5, 5]);
eq("沒有 position 時行號 0", outlineItems([{ level: 1, heading: "x" }])[0].line, 0);

/* ── headingLines ── */
eq("ATX 標題", headingLines("# A\ntext\n## B\n### C"), [0, 2, 3]);
eq("#tag 不算標題（# 後面要有空白）", headingLines("#tag\n# real"), [1]);
eq("空標題 `#` 算", headingLines("#\ntext"), [0]);
eq("fenced code 裡的 # 註解跳過", headingLines("# A\n```bash\n# not a heading\n```\n## B"), [0, 4]);
eq("~~~ 圍欄也認", headingLines("~~~\n# no\n~~~\n# yes"), [3]);
eq("不同種類的圍欄不互相關閉", headingLines("```\n~~~\n# still code\n```\n# out"), [4]);
eq("frontmatter 裡的 YAML 註解跳過", headingLines("---\ntitle: x\n# comment\n---\n# A"), [4]);
eq("setext 標題（=== / ---）", headingLines("Title\n=====\n\nSub\n---\ntext"), [0, 3]);
eq("清單項目後面的 --- 不是 setext", headingLines("- item\n---\n# A"), [2]);
eq("引言、表格列後面的 --- 不是 setext", headingLines("> quote\n---\n| a |\n---"), []);
eq("空行後面的 --- 是分隔線不是標題", headingLines("text\n\n---\n# A"), [3]);
eq("預覽被截斷時後面的標題不在裡面", headingLines("# A\n## B\n…").length, 2);
eq("空字串", headingLines(""), []);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
