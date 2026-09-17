/*
 * 列裝飾：用 frontmatter 決定一列長什麼樣。
 *
 * ── 為什麼要有這層 ──
 * 原本這段是寫死的：某個 vault 的 task / doc / project 制度直接刻在程式碼裡，連詞彙表
 * 都是去讀那個 vault 裡的 .js 檔再 eval。那對作者以外的任何人都是死重量，也過不了
 * plugin 審查。現在規則是**設定裡的資料**，引擎不認得任何特定的 type 名稱。
 *
 * ── 一條規則能表達什麼 ──
 *   when      這條規則作用在哪些筆記（frontmatter 的某個欄位等於／屬於某些值）
 *   icon      前面那顆圖示：固定值、直接取某欄位、或某欄位查表
 *   title     主文字要不要換成某個欄位（例如日記的檔名是日期，標題才是重點）
 *   subtitle  右側的小字
 *   status    狀態徽章：查表拿到文字、排序權重、以及「要不要變淡」
 *   priority  只在夠高的時候才畫（低優先度畫出來每一列都是噪音）
 *   dimWhen / pinWhen / overdue
 *
 * ── 未知值一定要看得見 ──
 * 「有填、但表裡沒有」的值畫成 ❓＋原值。這是**漂移的偵測機制**不是裝飾：靜靜退回一個
 * 長得很正常的預設圖示，等於把「詞彙表改了一半」這種錯誤藏起來。
 * 空值不算未知 —— 留空是合法狀態。
 */

/** 排序時「沒有這個欄位」一律沉底。比任何真值都大。 */
const LAST = 9999;
const UNKNOWN = "❓";

/** fm[field] 拿值，統一成字串（YAML 可能給 number / boolean）。 */
function fieldOf(fm, field) {
  if (!fm || !field) return "";
  const v = fm[field];
  return v == null ? "" : String(v);
}

function matches(fm, when) {
  if (!when || !when.field) return false;
  const v = fieldOf(fm, when.field);
  if (Array.isArray(when.in)) return when.in.map(String).includes(v);
  if (when.equals !== undefined) return v === String(when.equals);
  return v !== "";   // 只給 field ＝「有這個欄位就算」
}

function condTrue(fm, cond) {
  if (!cond || !cond.field) return false;
  const raw = fm ? fm[cond.field] : undefined;
  if (cond.equals !== undefined) return raw === cond.equals || String(raw) === String(cond.equals);
  return raw === true;
}

/** icon 規則 → 一個字。 */
function iconOf(fm, spec) {
  if (!spec) return "";
  if (spec.from === "fixed") return spec.value || "";
  const v = fieldOf(fm, spec.field);
  if (!v) return spec.fallback || "";
  if (spec.from === "field") return v;
  if (spec.from === "map") {
    const hit = spec.map && spec.map[v];
    return hit || spec.unknown || UNKNOWN;
  }
  return spec.fallback || "";
}

/**
 * title / subtitle 規則 → 要顯示的字串。空字串＝這一格不畫。
 * @param {object} names { name, basename } —— from: "filename" 時用得到
 */
function textOf(fm, spec, names) {
  if (!spec || spec.from === "none") return "";
  const n = names || {};
  /* filename ＝含副檔名（跟列表平常顯示的一樣）；basename ＝不含。
     日記的用法是「標題沒填就退回 filename、右邊的小字用 basename」，
     所以這兩個必須分得開 —— 只有一種的話，沒填標題的那幾列會左右各印一次日期。 */
  if (spec.from === "filename") return n.name || "";
  if (spec.from === "basename") return n.basename || n.name || "";
  if (spec.from === "fixed") return spec.value || "";
  if (spec.from === "field") {
    const v = fieldOf(fm, spec.field);
    if (v) return v;
    if (spec.fallback === "filename") return n.name || "";
    if (spec.fallback === "basename") return n.basename || n.name || "";
    return "";
  }
  return "";
}

/**
 * 依規則算出一列的裝飾。
 * @param {object} fm     frontmatter
 * @param {Array}  rules  settings.decorations
 * @returns {object|null} 沒有規則命中就回 null（那一列照原樣畫）
 */
function decorate(fm, rules, names) {
  if (!fm) return null;
  const rule = (rules || []).find((r) => r && r.enabled !== false && matches(fm, r.when));
  if (!rule) return null;

  /*
   * titleFromField ＝標題真的取自某個欄位（而不是退回檔名）。
   * 呼叫端靠它決定要不要畫右邊的小字：標題已經退回檔名時再畫一次日期，
   * 那一列就會左右各印一次同樣的東西。
   */
  const titleSpec = rule.title;
  const titleFromField = !!(titleSpec && titleSpec.from === "field" && fieldOf(fm, titleSpec.field));

  const out = {
    ruleId: rule.id,
    icon: iconOf(fm, rule.icon),
    title: textOf(fm, rule.title, names),
    titleFromField,
    subtitle: textOf(fm, rule.subtitle, names),
    group: "",
    groupOrder: LAST,
    status: "",
    statusOrder: LAST,
    prio: "",
    prioOrder: LAST,
    dim: false,
    pinned: false,
    overdue: false,
    fm,
  };

  /* 分組（也是「依分類排序」時的權重） */
  if (rule.group && rule.group.field) {
    out.group = fieldOf(fm, rule.group.field);
    const order = rule.group.order || [];
    const i = order.indexOf(out.group);
    out.groupOrder = i >= 0 ? i : LAST;
  }

  /* 狀態徽章 */
  if (rule.status && rule.status.field) {
    const v = fieldOf(fm, rule.status.field);
    const hit = v && rule.status.map ? rule.status.map[v] : null;
    if (hit) {
      out.status = hit.text != null ? hit.text : v;
      out.statusOrder = hit.order != null ? hit.order : LAST;
      if (hit.dim) out.dim = true;
    } else if (v) {
      out.status = UNKNOWN + v;   // 有填但不認得：把原值攤出來
    }
  }

  /* 優先度：只畫夠高的那幾級 */
  if (rule.priority && rule.priority.field) {
    const v = fieldOf(fm, rule.priority.field);
    const ord = rule.priority.order ? rule.priority.order[v] : undefined;
    if (ord != null) {
      out.prioOrder = ord;
      const max = rule.priority.showMaxOrder != null ? rule.priority.showMaxOrder : 0;
      if (ord <= max) out.prio = v.slice(0, rule.priority.textLength || 2);
    }
  }

  for (const c of rule.dimWhen || []) if (condTrue(fm, c)) out.dim = true;
  for (const c of rule.pinWhen || []) if (condTrue(fm, c)) out.pinned = true;

  /* 某個欄位為真時，狀態徽章直接換成固定文字（例：原檔不見了的卡片） */
  for (const o of rule.statusWhen || []) {
    if (condTrue(fm, o)) {
      out.status = o.text || out.status;
      if (o.dim) out.dim = true;
    }
  }

  /* 逾期：已經變淡的（完成/取消）不再標 —— 做完的事沒有逾期可言 */
  if (rule.overdue && rule.overdue.field && !out.dim) {
    const due = fieldOf(fm, rule.overdue.field).slice(0, 10);
    if (due && due <= todayStr()) out.overdue = true;
  }

  return out;
}

function todayStr(now) {
  const d = now || new Date();
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

module.exports = { decorate, matches, iconOf, textOf, todayStr, LAST, UNKNOWN };
