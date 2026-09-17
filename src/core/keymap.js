/*
 * 鍵位覆寫。
 *
 * ── 為什麼是「鍵 → 鍵」而不是「鍵 → 動作」 ──
 * 讓每個動作都能綁到任意鍵，需要先把散在 switch 裡的每個動作抽成有 id 的註冊表 ——
 * 那是整個輸入層的改寫。而 Surfingkeys 的 `map` 其實是另一回事：`map('J', 'gT')`
 * 的語意是「**按 J 等於按 gT**」，是鍵的別名。那條路只要在派工之前把鍵換掉就好，
 * 既有的鍵位邏輯一個字都不用動。
 *
 * 代價誠實地說：把 x 映到 d 之後，x 原本的動作就沒有鍵了，除非你再映一顆過去。
 * 這正是 vim remap 的語意，不是 bug。
 *
 * ── 語法 ──
 *   map J gt        按 J 等於按 g 再按 t
 *   map w O         按 w 等於按 O
 *   unmap S         S 不做任何事
 *   # 這是註解
 *
 * 右邊可以是多鍵序列；左邊只能是一顆鍵（序列當觸發鍵會與既有的前綴打架）。
 */

/* 打不出來的鍵用角括號寫。對應到 KeyboardEvent.key 的值。 */
const NAMED = {
  space: " ",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/**
 * 把一個 token 拆成一連串的鍵。
 * "gt" → ["g","t"]、"<Space>" → [" "]、",x" → [",","x"]、"g<Enter>" → ["g","Enter"]
 * 認不得的角括號名稱會丟錯，讓呼叫端可以指出是哪一行寫錯。
 */
function keysOf(token) {
  const out = [];
  let i = 0;
  while (i < token.length) {
    if (token[i] === "<") {
      const end = token.indexOf(">", i);
      if (end < 0) throw new Error("unclosed <");
      const name = token.slice(i + 1, end).toLowerCase();
      if (!(name in NAMED)) throw new Error("unknown key <" + token.slice(i + 1, end) + ">");
      out.push(NAMED[name]);
      i = end + 1;
    } else {
      out.push(token[i]);
      i++;
    }
  }
  if (!out.length) throw new Error("empty key");
  return out;
}

/**
 * 解析設定裡那段文字。
 * @returns {{ map: object, unmap: object, errors: Array<{line:number, text:string, reason:string}> }}
 *   map[觸發鍵] = [目標鍵, …]，unmap[鍵] = true
 */
function parseKeymap(text) {
  const map = {};
  const unmap = {};
  const errors = [];

  String(text || "").split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;

    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const add = (reason) => errors.push({ line: idx + 1, text: line, reason });

    if (cmd === "unmap") {
      if (parts.length !== 2) return add("unmap needs exactly one key");
      let keys;
      try {
        keys = keysOf(parts[1]);
      } catch (e) {
        return add(e.message);
      }
      if (keys.length !== 1) return add("unmap only takes a single key");
      unmap[keys[0]] = true;
      delete map[keys[0]];
      return;
    }

    if (cmd === "map") {
      if (parts.length !== 3) return add("map needs two arguments: map <key> <target>");
      let from, to;
      try {
        from = keysOf(parts[1]);
        to = keysOf(parts[2]);
      } catch (e) {
        return add(e.message);
      }
      /* 觸發鍵只能是一顆：多鍵當觸發鍵要走 pending 那套前綴機制，會跟既有的
         g / c / , / S / O 打架，而且「兩個前綴誰先誰後」沒有直覺的答案 */
      if (from.length !== 1) return add("the key on the left must be a single key");
      if (from[0] === to[0] && to.length === 1) return add("mapping a key to itself does nothing");
      map[from[0]] = to;
      delete unmap[from[0]];
      return;
    }

    add("unknown command (expected map or unmap)");
  });

  return { map, unmap, errors };
}

module.exports = { parseKeymap, keysOf, NAMED };
