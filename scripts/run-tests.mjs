/*
 * 測試執行器。
 *
 * 為什麼不用 node --test：那支的檔名探索規則會隨版本變（tests/ 這個目錄名在某些
 * 版本不被當成測試目錄），而且它會把每支測試的輸出吞掉只留 TAP。這裡的每一支
 * 測試本身就會印出「PASS/FAIL 某某行為」的中文清單 —— 那是失敗時最有用的東西，
 * 值得原樣印出來。
 *
 * 規則：tests/ 底下所有 *-test.js（底線開頭的是共用工具，跳過），各自開一個行程跑，
 * 離開碼非 0 就算失敗。
 */
import { readdirSync } from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "tests");
const only = process.argv[2];

const files = readdirSync(dir)
  .filter((f) => f.endsWith("-test.js") && !f.startsWith("_"))
  .filter((f) => !only || f.includes(only))
  .sort();

if (!files.length) {
  console.error(only ? "沒有符合 " + only + " 的測試" : "tests/ 底下沒有測試");
  process.exit(1);
}

let failed = 0;
const width = Math.max(...files.map((f) => f.length));
const lines = [];

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const ok = r.status === 0;
  if (!ok) failed++;
  const last = out.trim().split("\n").filter(Boolean).pop() || "(沒有輸出)";
  lines.push((ok ? "  ✓ " : "  ✗ ") + f.padEnd(width) + "  " + last);
  if (!ok) lines.push(out.split("\n").map((l) => "      " + l).join("\n"));
}

console.log(lines.join("\n"));
console.log(failed ? "\n" + failed + " / " + files.length + " 組失敗" : "\n" + files.length + " 組全部通過");
process.exit(failed ? 1 : 0);
