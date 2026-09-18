/*
 * 「呼叫了一個不存在的函式」的靜態檢查。
 *
 * 由來：userTags 與 stripFrontmatter 都是被呼叫但從來沒定義過，而 JS 要到**執行到
 * 那一行**才會爆。它們躲在預覽的非同步回呼裡，症狀是「某些筆記不渲染」，沒有任何
 * 錯誤訊息浮到介面上 —— 兩次都是使用者回報才發現的。
 *
 * 做法：把 src/ 的每個檔案當文字掃一遍，抓出「裸函式呼叫」（前面不是 . 也不是 new 的
 * `名字(`），扣掉本檔宣告的、require 進來的、參數名、以及語言／執行環境的內建。
 * 剩下的就是跑到才會爆的呼叫。
 *
 * 這是近似而非型別檢查：寧可漏，不可誤報 —— 誤報會讓人開始忽略這支測試。
 */
const fs = require("fs");
const path = require("path");

let fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + "  → " + JSON.stringify(got) + (ok ? "" : "\n      want " + JSON.stringify(want)));
};

/* 語言內建 ＋ Obsidian／Electron 執行環境給的全域。不在這裡的名字才會被回報。 */
const BUILTIN = new Set([
  "require", "eval", "parseInt", "parseFloat", "isNaN", "isFinite", "String", "Number", "Boolean",
  "Array", "Object", "Map", "Set", "WeakMap", "WeakSet", "Date", "RegExp", "Error", "TypeError",
  "Promise", "JSON", "Math", "Symbol", "Proxy", "Reflect", "BigInt", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "queueMicrotask", "structuredClone", "fetch", "atob", "btoa",
  "console", "window", "document", "navigator", "localStorage", "process", "Buffer", "URL",
  "Intl", "Function", "escape", "unescape", "super", "if", "for", "while", "switch", "catch",
  "return", "typeof", "delete", "void", "in", "of", "new", "do", "else", "try", "finally",
  "function", "class", "const", "let", "var", "await", "async", "yield", "throw", "case",
]);

/* 檔案自己宣告了哪些名字（函式、變數、class、解構、import、參數） */
function declared(src) {
  const names = new Set();
  const add = (s) => { if (s) names.add(s); };

  /* 具名函式：宣告與**具名函式運算式**（`return function t(...)`）都算 */
  for (const m of src.matchAll(/\bfunction\s*\*?\s+(\w+)/g)) add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*class\s+(\w+)/g)) add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+(\w+)/g)) add(m[1]);
  /* 解構：const { a, b: c } = require(...) —— 取左邊的名字，有別名就取別名 */
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const t = part.split(":").pop().trim().split("=")[0].trim();
      if (/^\w+$/.test(t)) add(t);
    }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().split("=")[0].trim();
      if (/^\w+$/.test(t)) add(t);
    }
  }
  /* 參數：function f(a, b) / (a, b) => / method(a, b) {  —— 一律當成宣告過 */
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().replace(/^\.\.\./, "").split("=")[0].trim();
      if (/^\w+$/.test(t)) add(t);
    }
  }
  /* 單一參數的箭頭函式：x => ... */
  for (const m of src.matchAll(/(?:^|[^\w.])(\w+)\s*=>/g)) add(m[1]);
  /* catch (e) */
  for (const m of src.matchAll(/catch\s*\(\s*(\w+)\s*\)/g)) add(m[1]);
  return names;
}

/* 註解與字串裡的東西不算呼叫（例如說明文字裡寫的 userTags()） */
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    /*
     * ⚠️ 方法**定義**長得跟呼叫一樣（`foo(a, b) {`）—— class 的方法、物件字面量的
     * 簡寫方法都是。不砍掉的話這支測試會把整個 class 的方法一律回報成「未定義」。
     * 只砍在行首（前面只有空白）的那種，行內的 `x = foo(a) {` 不存在於 JS。
     */
    .replace(/(^|\n)([ \t]*)(?:async\s+|static\s+|\*\s*|get\s+|set\s+)*\w+\s*\([^()]*\)\s*\{/g, "$1$2{");
}

const dir = path.join(__dirname, "..", "src");
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;             // .probe.generated.js
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
})(dir);

const missing = [];
for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const code = stripNoise(raw);
  const names = declared(raw);
  const seen = new Set();
  for (const m of code.matchAll(/(^|[^\w.$])(\w+)\s*\(/g)) {
    const name = m[2];
    if (seen.has(name) || names.has(name) || BUILTIN.has(name)) continue;
    // `new Foo(` 的 Foo 由 require/宣告涵蓋；關鍵字後面的括號不是呼叫
    if (/(?:^|[^\w])(?:new|if|for|while|switch|catch|return|typeof)\s*$/.test(m[1] + " ")) continue;
    seen.add(name);
    missing.push(path.relative(dir, file).replace(/\\/g, "/") + " → " + name + "()");
  }
}

eq("src/ 裡沒有『呼叫了但沒定義』的函式", missing.sort(), []);

console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
process.exit(fail ? 1 : 0);
