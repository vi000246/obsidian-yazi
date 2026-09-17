/*
 * 設定頁。
 *
 * ── 為什麼不是一長條 Setting() ──
 * 這個 plugin 的設定有兩種形狀：一種是開關與數字（適合 Obsidian 內建的 Setting 元件），
 * 另一種是**規則清單**（開啟方式、列裝飾、搜尋條件）—— 那是一張可增刪、可排序、每列
 * 又有六七個欄位的表。把它們全部攤成一長條，會變成一個捲十屏、找不到東西的頁面。
 * 所以分成左側分頁：每次只看一組，而且每一組都能整組匯出／匯入 JSON（分享設定用）。
 *
 * ── 規則清單的互動 ──
 * 每條規則是一張卡：收合時只顯示「啟用 / 鍵 / 名稱 / 摘要」，展開才編輯細節。
 * 這樣十條規則仍然一眼看得完，而不是十張攤開的表單。
 */
const { PluginSettingTab, Setting, Notice, Modal } = require("obsidian");
const { defaultSettings, EXAMPLE_DECORATIONS, EXAMPLE_OPENERS, PLACEHOLDERS, OPENER_KINDS } = require("./defaults.js");
const { LOCALES } = require("../i18n/index.js");
const { decorate } = require("../core/decorate.js");
const { parseKeymap } = require("../core/keymap.js");

/* 分頁。加一個分頁＝在這裡加一筆，並寫一個 renderXxx。 */
const SECTIONS = [
  { id: "keys", icon: "⌨", labelKey: "settings.section.keys" },
  { id: "openers", icon: "🚀", labelKey: "settings.section.openers" },
  { id: "decorations", icon: "🎨", labelKey: "settings.section.decorations" },
  { id: "search", icon: "🔍", labelKey: "settings.section.search" },
  { id: "preview", icon: "👁", labelKey: "settings.section.preview" },
  { id: "index", icon: "🗂", labelKey: "settings.section.index" },
];

const uid = () => Math.random().toString(36).slice(2, 9);

/* ── 小工具：一張可收合的規則卡 ─────────────────────────────── */
class RuleCard {
  /**
   * @param {HTMLElement} parent
   * @param {object} opts { title, subtitle, badge, enabled, onToggle, onDelete, onMove, open }
   */
  constructor(parent, opts) {
    const o = opts || {};
    this.el = parent.createDiv({ cls: "yazi-set-card" + (o.enabled === false ? " is-off" : "") });

    const head = this.el.createDiv({ cls: "yazi-set-card-head" });
    /* 收合／展開整張卡：點標題那一列，不是只有一顆小箭頭 —— 命中區域大很多 */
    head.addEventListener("click", (ev) => {
      if (ev.target.closest("button, input, select, .yazi-set-card-actions")) return;
      this.toggleOpen();
    });

    this.caret = head.createSpan({ cls: "yazi-set-caret", text: "▸" });

    if (o.badge != null) head.createSpan({ cls: "yazi-set-key", text: o.badge || "—" });

    const titleBox = head.createDiv({ cls: "yazi-set-card-title" });
    titleBox.createSpan({ cls: "yazi-set-card-name", text: o.title || "(untitled)" });
    if (o.subtitle) titleBox.createSpan({ cls: "yazi-set-card-sub", text: o.subtitle });

    const actions = head.createDiv({ cls: "yazi-set-card-actions" });
    if (o.onMove) {
      const up = actions.createEl("button", { text: "↑" });
      up.onclick = () => o.onMove(-1);
      const down = actions.createEl("button", { text: "↓" });
      down.onclick = () => o.onMove(1);
    }
    if (o.onToggle) {
      const tg = actions.createEl("input");
      tg.type = "checkbox";
      tg.checked = o.enabled !== false;
      tg.title = "Enabled";
      tg.onchange = () => o.onToggle(tg.checked);
    }
    if (o.onDelete) {
      const del = actions.createEl("button", { cls: "mod-warning", text: "✕" });
      del.title = "Delete";
      del.onclick = () => o.onDelete();
    }

    this.body = this.el.createDiv({ cls: "yazi-set-card-body" });
    this.open = !!o.open;
    this.apply();
  }

  toggleOpen() { this.open = !this.open; this.apply(); }

  apply() {
    this.caret.setText(this.open ? "▾" : "▸");
    this.body.toggleClass("is-open", this.open);
  }
}

/* ── 匯入 JSON 用的小視窗 ─────────────────────────────────── */
class ImportModal extends Modal {
  constructor(app, title, onSubmit) {
    super(app);
    this.title = title;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    const ta = contentEl.createEl("textarea", { cls: "yazi-set-import" });
    ta.rows = 14;
    ta.placeholder = '[\n  { "id": "...", "label": "..." }\n]';
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    btns.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const ok = btns.createEl("button", { cls: "mod-cta", text: "Import" });
    ok.onclick = () => {
      let parsed = null;
      try {
        parsed = JSON.parse(ta.value);
      } catch (e) {
        new Notice("Not valid JSON: " + e.message);
        return;
      }
      this.close();
      this.onSubmit(parsed);
    };
    setTimeout(() => ta.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}

class YaziSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.section = "keys";
  }

  t(key, fallback) {
    return this.plugin.t ? this.plugin.t(key, fallback) : fallback || key;
  }

  async save() {
    await this.plugin.saveSettings();
  }

  /** 改了設定就存檔並重畫目前這一段（不重畫整頁，捲動位置才不會跳掉）。 */
  async commit(rerender) {
    await this.save();
    if (rerender !== false) this.renderSection();
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("yazi-settings");

    const layout = containerEl.createDiv({ cls: "yazi-set-layout" });

    /* 左側分頁 */
    const nav = layout.createDiv({ cls: "yazi-set-nav" });
    for (const s of SECTIONS) {
      const item = nav.createDiv({
        cls: "yazi-set-nav-item" + (s.id === this.section ? " is-active" : ""),
      });
      item.createSpan({ cls: "yazi-set-nav-icon", text: s.icon });
      item.createSpan({ text: this.t(s.labelKey, s.id) });
      item.onclick = () => {
        this.section = s.id;
        this.display();
      };
    }

    this.paneEl = layout.createDiv({ cls: "yazi-set-pane" });
    this.renderSection();
  }

  renderSection() {
    const el = this.paneEl;
    el.empty();
    const fn = {
      keys: () => this.renderKeys(el),
      openers: () => this.renderOpeners(el),
      decorations: () => this.renderDecorations(el),
      search: () => this.renderSearch(el),
      preview: () => this.renderPreview(el),
      index: () => this.renderIndex(el),
    }[this.section];
    if (fn) fn();
  }

  /** 每一段上方固定的標題＋說明＋整段的匯出/匯入/重設。 */
  header(el, title, desc, opts) {
    const o = opts || {};
    const head = el.createDiv({ cls: "yazi-set-head" });
    const text = head.createDiv();
    text.createEl("h3", { text: title });
    if (desc) text.createEl("p", { cls: "yazi-set-desc", text: desc });

    const tools = head.createDiv({ cls: "yazi-set-tools" });
    if (o.onExport) {
      const b = tools.createEl("button", { text: this.t("settings.export", "Export") });
      b.onclick = async () => {
        const json = JSON.stringify(o.onExport(), null, 2);
        try {
          await navigator.clipboard.writeText(json);
          new Notice(this.t("settings.exported", "Copied to clipboard"));
        } catch (e) {
          new Notice("Copy failed: " + e.message);
        }
      };
    }
    if (o.onImport) {
      const b = tools.createEl("button", { text: this.t("settings.import", "Import") });
      b.onclick = () => new ImportModal(this.app, title, o.onImport).open();
    }
    if (o.onReset) {
      const b = tools.createEl("button", { cls: "mod-warning", text: this.t("settings.reset", "Reset") });
      b.onclick = async () => {
        if (!window.confirm(this.t("settings.resetConfirm", "Reset this section to defaults?"))) return;
        await o.onReset();
      };
    }
    return head;
  }

  emptyHint(el, text) {
    el.createDiv({ cls: "yazi-set-empty", text });
  }

  /* ════════════════════ 開啟方式 ════════════════════ */

  renderOpeners(el) {
    const s = this.plugin.settings;
    this.header(
      el,
      this.t("settings.section.openers", "Openers"),
      this.t("settings.openers.desc",
        "What the O menu offers for the item under the cursor. Each entry is a key plus an action; " +
        "the menu adapts to whether a file or a folder is selected."),
      {
        onExport: () => s.openers,
        onImport: async (parsed) => {
          if (!Array.isArray(parsed)) { new Notice("Expected a JSON array of openers"); return; }
          s.openers = parsed;
          await this.commit();
          new Notice(this.t("settings.imported", "Imported"));
        },
        onReset: async () => {
          s.openers = defaultSettings().openers;
          await this.commit();
        },
      }
    );

    if (!s.openers.length) this.emptyHint(el, this.t("settings.openers.empty", "No openers yet."));

    const list = el.createDiv({ cls: "yazi-set-list" });
    s.openers.forEach((o, i) => this.openerCard(list, o, i));

    const add = el.createDiv({ cls: "yazi-set-add" });
    const mk = (label, preset) => {
      const b = add.createEl("button", { text: label });
      b.onclick = async () => {
        s.openers.push(Object.assign({
          id: uid(), label: "New opener", key: "", appliesTo: "both",
          extensions: [], platform: "all", kind: "system", enabled: true,
        }, preset));
        await this.commit();
      };
    };
    mk("+ " + this.t("settings.openers.addSystem", "Default app"), { kind: "system", label: "Open with default app" });
    mk("+ " + this.t("settings.openers.addCommand", "Command line"), { kind: "command", label: "Run command", command: "", args: [] });
    mk("+ " + this.t("settings.openers.addObsidian", "Obsidian command"), { kind: "obsidian-command", label: "Run Obsidian command", commandId: "" });

    /* 範例：空白的 command opener 對新使用者太抽象（執行檔要填什麼？參數怎麼斷行？），
       給兩個填好的範本，改兩個字就能用。 */
    const ex = el.createDiv({ cls: "yazi-set-add" });
    ex.createSpan({ cls: "yazi-set-add-label", text: this.t("settings.examples", "Examples:") });
    for (const e of EXAMPLE_OPENERS) {
      const b = ex.createEl("button", { text: e.label + (e.platform !== "all" ? " (" + e.platform + ")" : "") });
      b.onclick = async () => {
        s.openers.push(Object.assign(JSON.parse(JSON.stringify(e)), { id: uid() }));
        await this.commit();
      };
    }
  }

  openerCard(list, o, i) {
    const s = this.plugin.settings;
    const kindLabel = {
      system: this.t("settings.openers.kind.system", "default app"),
      reveal: this.t("settings.openers.kind.reveal", "file manager"),
      command: this.t("settings.openers.kind.command", "command line"),
      "obsidian-command": this.t("settings.openers.kind.obsidian", "Obsidian command"),
    }[o.kind] || o.kind;
    const scope = { file: "files", folder: "folders", both: "files + folders" }[o.appliesTo || "both"];
    const exts = (o.extensions || []).length ? " · ." + o.extensions.join(", .") : "";
    const plat = o.platform && o.platform !== "all" ? " · " + o.platform : "";

    const card = new RuleCard(list, {
      title: o.label || "(untitled)",
      subtitle: kindLabel + " · " + scope + exts + plat,
      badge: o.key,
      enabled: o.enabled,
      onToggle: async (v) => { o.enabled = v; await this.commit(); },
      onDelete: async () => { s.openers.splice(i, 1); await this.commit(); },
      onMove: async (d) => {
        const j = i + d;
        if (j < 0 || j >= s.openers.length) return;
        s.openers.splice(j, 0, s.openers.splice(i, 1)[0]);
        await this.commit();
      },
    });

    const body = card.body;

    new Setting(body)
      .setName(this.t("settings.openers.label", "Label"))
      .setDesc(this.t("settings.openers.labelDesc", "Shown in the O menu."))
      .addText((tc) => tc.setValue(o.label || "").onChange(async (v) => { o.label = v; await this.save(); }));

    new Setting(body)
      .setName(this.t("settings.openers.key", "Key"))
      .setDesc(this.t("settings.openers.keyDesc", "Single key pressed after O. Leave empty for menu-only."))
      .addText((tc) => {
        tc.inputEl.maxLength = 1;
        tc.inputEl.style.width = "3em";
        tc.setValue(o.key || "").onChange(async (v) => { o.key = v; await this.save(); });
      });

    new Setting(body)
      .setName(this.t("settings.openers.appliesTo", "Applies to"))
      .addDropdown((d) => d
        .addOption("both", "Files and folders")
        .addOption("file", "Files only")
        .addOption("folder", "Folders only")
        .setValue(o.appliesTo || "both")
        .onChange(async (v) => { o.appliesTo = v; await this.commit(); }));

    new Setting(body)
      .setName(this.t("settings.openers.extensions", "Extensions"))
      .setDesc(this.t("settings.openers.extensionsDesc", "Comma separated, e.g. md, canvas. Empty means any file."))
      .addText((tc) => tc
        .setPlaceholder("md, canvas")
        .setValue((o.extensions || []).join(", "))
        .onChange(async (v) => {
          o.extensions = v.split(",").map((x) => x.trim().replace(/^\./, "")).filter(Boolean);
          await this.save();
        }));

    new Setting(body)
      .setName(this.t("settings.openers.platform", "Platform"))
      .addDropdown((d) => d
        .addOption("all", "All")
        .addOption("win", "Windows")
        .addOption("mac", "macOS")
        .addOption("linux", "Linux")
        .setValue(o.platform || "all")
        .onChange(async (v) => { o.platform = v; await this.commit(); }));

    new Setting(body)
      .setName(this.t("settings.openers.kind", "Action"))
      .addDropdown((d) => {
        for (const k of OPENER_KINDS) d.addOption(k, k);
        d.setValue(o.kind || "system").onChange(async (v) => { o.kind = v; await this.commit(); });
      });

    if (o.kind === "command") {
      const warn = body.createDiv({ cls: "yazi-set-warn" });
      warn.setText(this.t("settings.openers.desktopOnly",
        "Desktop only. This spawns an external process; it will not appear on mobile."));

      new Setting(body)
        .setName(this.t("settings.openers.command", "Executable"))
        .setDesc(this.t("settings.openers.commandDesc", "Full path, or a name on PATH."))
        .addText((tc) => tc
          .setPlaceholder("code")
          .setValue(o.command || "")
          .onChange(async (v) => { o.command = v; await this.save(); }));

      new Setting(body)
        .setName(this.t("settings.openers.args", "Arguments"))
        .setDesc(this.t("settings.openers.argsDesc",
          "One per line. Each line is passed as a single argument, so paths with spaces are safe."))
        .addTextArea((ta) => {
          ta.inputEl.rows = 5;
          ta.inputEl.addClass("yazi-set-args");
          ta.setPlaceholder("--reuse-window\n{{path}}")
            .setValue((o.args || []).join("\n"))
            .onChange(async (v) => {
              o.args = v.split("\n").map((x) => x.trim()).filter(Boolean);
              await this.save();
            });
        });

      const ph = body.createDiv({ cls: "yazi-set-ph" });
      ph.createSpan({ cls: "yazi-set-ph-title", text: this.t("settings.openers.placeholders", "Placeholders") });
      for (const [token, desc] of PLACEHOLDERS) {
        const row = ph.createDiv({ cls: "yazi-set-ph-row" });
        const code = row.createEl("code", { text: token });
        code.onclick = async () => {
          try { await navigator.clipboard.writeText(token); new Notice(token); } catch (e) { /* 複製失敗不重要 */ }
        };
        row.createSpan({ text: desc });
      }
    }

    if (o.kind === "obsidian-command") {
      new Setting(body)
        .setName(this.t("settings.openers.commandId", "Command ID"))
        .setDesc(this.t("settings.openers.commandIdDesc",
          "e.g. editor:open-search. The file under the cursor is opened first, then the command runs."))
        .addText((tc) => tc
          .setPlaceholder("workspace:split-vertical")
          .setValue(o.commandId || "")
          .onChange(async (v) => { o.commandId = v; await this.save(); }));
    }
  }

  /* ════════════════════ 其餘分頁（下一步接上） ════════════════════ */

  /*
   * 鍵位頁刻意短。
   * 內建鍵位為什麼不開放逐顆重綁、remap 的語意與限制 —— 那些寫在 README，
   * 設定頁只留「現在能做什麼」與一個看了就會寫的範例。設定頁不是讀文件的地方。
   */
  renderKeys(el) {
    this.header(el, this.t("settings.section.keys", "Keys"),
      this.t("settings.keys.desc",
        "Keys inside the explorer are fixed — press ? in the explorer for the list. " +
        "Give these commands a hotkey in Settings → Hotkeys."));

    const box = el.createDiv({ cls: "yazi-set-cmds" });
    for (const [key, fallback] of [
      ["cmd.open", "Open file explorer (at the current file)"],
      ["cmd.openTabs", "Open tab list"],
      ["cmd.openBookmarks", "Open bookmarks"],
      ["cmd.openRecent", "Open recent files"],
      ["cmd.openFrecency", "Open frequently used"],
      ["cmd.searchText", "Search: full text"],
      ["cmd.searchFile", "Search: file names"],
      ["cmd.searchDir", "Search: folders"],
    ]) {
      box.createDiv({ cls: "yazi-set-cmd-row" }).createSpan({ cls: "yazi-set-cmd-name", text: this.t(key, fallback) });
    }

    /*
     * 狀態列：打字的當下就回答「我設對了嗎」。
     * 三種狀態都要講清楚 —— 沒設定、生效幾條（並列出實際結果）、哪幾行沒生效。
     * 只顯示錯誤是不夠的：沒有錯誤訊息時，人分不出「設定成功」與「根本沒被讀到」。
     */
    const errBox = el.createDiv({ cls: "yazi-set-km-errors" });
    const showErrors = (text) => {
      errBox.empty();
      const { map, unmap, errors } = parseKeymap(text);
      const pairs = Object.entries(map).map(([from, to]) => from + " → " + to.join(""));
      const offs = Object.keys(unmap).map((k) => k + " ✕");
      const active = pairs.concat(offs);

      const status = errBox.createDiv({ cls: "yazi-set-km-status" });
      if (!String(text || "").trim()) {
        status.addClass("is-idle");
        status.setText(this.t("settings.keys.statusNone", "No overrides — using the built-in keys."));
      } else if (active.length) {
        status.addClass(errors.length ? "is-warn" : "is-ok");
        status.setText((errors.length ? "⚠ " : "✓ ") +
          this.t("settings.keys.statusActive", "{count} in effect", { count: active.length }) +
          "　" + active.join("　"));
      } else {
        status.addClass("is-warn");
        status.setText("⚠ " + this.t("settings.keys.statusNothing", "Nothing is in effect."));
      }

      if (!errors.length) return;
      errBox.createDiv({ cls: "yazi-set-warn", text: this.t("settings.keys.badLines", "These lines were ignored:") });
      for (const e of errors) {
        errBox.createDiv({ cls: "yazi-set-km-error", text: "L" + e.line + "  " + e.text + "  —  " + e.reason });
      }
    };

    const set = new Setting(el)
      .setName(this.t("settings.keys.overrides", "Remap keys"))
      .setDesc(this.t("settings.keys.remapShort",
        "Make one key behave as another. Left: one key. Right: a key or a sequence."));
    /* 範例直接當 placeholder：空白時就是教學，開始打字就讓位 */
    set.addTextArea((ta) => {
      ta.inputEl.rows = 6;
      ta.inputEl.addClass("yazi-set-args");
      ta.setPlaceholder(["# J does what gt does", "map J gt", "map w O", "unmap S"].join("\n"))
        .setValue(this.plugin.settings.keymap || "")
        .onChange(async (v) => {
          this.plugin.settings.keymap = v;
          showErrors(v);
          await this.save();
        });
    });
    showErrors(this.plugin.settings.keymap || "");

    el.createDiv({ cls: "yazi-set-desc", text: this.t("settings.keys.remapNote",
      "Not affected: typing, bookmark letters, Ctrl combinations. See the README for the full key list.") });
  }


  renderDecorations(el) {
    const s = this.plugin.settings;
    this.header(el, this.t("settings.section.decorations", "Row decorations"),
      this.t("settings.decorations.desc",
        "Use frontmatter to change how a row looks: an icon, a different title, a secondary column."),
      {
        onExport: () => s.decorations,
        onImport: async (parsed) => {
          if (!Array.isArray(parsed)) { new Notice("Expected a JSON array"); return; }
          s.decorations = parsed;
          await this.commit();
        },
        onReset: async () => { s.decorations = []; await this.commit(); },
      });

    if (!s.decorations.length) {
      this.emptyHint(el, this.t("settings.decorations.empty",
        "No rules yet. Rows are drawn plain. Add one below, or import a set."));
    }

    const list = el.createDiv({ cls: "yazi-set-list" });
    s.decorations.forEach((r, i) => this.decorationCard(list, r, i));

    const add = el.createDiv({ cls: "yazi-set-add" });
    const blank = add.createEl("button", { text: "+ " + this.t("settings.decorations.add", "New rule") });
    blank.onclick = async () => {
      s.decorations.push({
        id: uid(), name: "New rule", enabled: true,
        when: { field: "type", equals: "" },
        icon: { from: "fixed", value: "📄" },
      });
      await this.commit();
    };
    for (const ex of EXAMPLE_DECORATIONS) {
      const b = add.createEl("button", { text: "+ " + ex.name });
      b.onclick = async () => {
        s.decorations.push(Object.assign(JSON.parse(JSON.stringify(ex)), { id: uid() }));
        await this.commit();
      };
    }
  }

  decorationCard(list, r, i) {
    const s = this.plugin.settings;
    const when = r.when || {};
    const cond = when.field
      ? when.field + " = " + (Array.isArray(when.in) ? when.in.join(" / ") : when.equals)
      : this.t("settings.decorations.noCondition", "no condition");

    const card = new RuleCard(list, {
      title: r.name || r.id || "(untitled)",
      subtitle: cond,
      badge: (r.icon && (r.icon.value || (r.icon.field ? "{" + r.icon.field + "}" : ""))) || "",
      enabled: r.enabled,
      onToggle: async (v) => { r.enabled = v; await this.commit(); },
      onDelete: async () => { s.decorations.splice(i, 1); await this.commit(); },
      onMove: async (d) => {
        const j = i + d;
        if (j < 0 || j >= s.decorations.length) return;
        s.decorations.splice(j, 0, s.decorations.splice(i, 1)[0]);
        await this.commit();
      },
    });
    const body = card.body;

    /*
     * 即時預覽：用這條規則畫一列假的檔案。
     * 規則的 schema 是抽象的（from: map / fallback: filename…），看設定表單想像不出
     * 結果長怎樣；畫出來就不必想像了。假資料從規則本身推導 —— 它用到哪些欄位，
     * 就給哪些欄位一個示範值。
     */
    const demo = body.createDiv({ cls: "yazi-set-demo" });
    demo.createSpan({ cls: "yazi-set-demo-label", text: this.t("settings.decorations.preview", "Looks like") });
    this.decorationPreview(demo.createDiv({ cls: "yazi-row" }), r);

    new Setting(body)
      .setName(this.t("settings.decorations.name", "Name"))
      .addText((tc) => tc.setValue(r.name || "").onChange(async (v) => { r.name = v; await this.save(); }));

    /* 命中條件：一個 frontmatter 欄位等於某個值（或屬於幾個值之一）。
       ⚠️ 規則由上而下比對，第一條命中就用它 —— 所以順序有意義，卡片可以上下移動。 */
    new Setting(body)
      .setName(this.t("settings.decorations.when", "Applies when"))
      .setDesc(this.t("settings.decorations.whenDesc",
        "A frontmatter field equals this value. Several values: separate with commas. " +
        "Rules are matched top to bottom; the first match wins."))
      .addText((tc) => tc.setPlaceholder("type").setValue(when.field || "")
        .onChange(async (v) => { r.when = Object.assign({}, r.when, { field: v }); await this.save(); }))
      .addText((tc) => tc.setPlaceholder("task, bug")
        .setValue(Array.isArray(when.in) ? when.in.join(", ") : (when.equals || ""))
        .onChange(async (v) => {
          const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
          const next = { field: (r.when && r.when.field) || "" };
          if (parts.length > 1) next.in = parts;
          else next.equals = parts[0] || "";
          r.when = next;
          await this.save();
        }));

    this.sourceSetting(body, r, "icon",
      this.t("settings.decorations.icon", "Icon"),
      this.t("settings.decorations.iconDesc", "Replaces the bullet in front of the row."),
      ["fixed", "field", "map"]);

    this.sourceSetting(body, r, "title",
      this.t("settings.decorations.title", "Title"),
      this.t("settings.decorations.titleDesc",
        "What the row shows instead of the file name. Useful when the file name is a date or an id."),
      ["none", "field", "fixed"]);

    this.sourceSetting(body, r, "subtitle",
      this.t("settings.decorations.subtitle", "Secondary text"),
      this.t("settings.decorations.subtitleDesc", "Small text on the right. Only drawn when the title came from a field."),
      ["none", "basename", "filename", "field"]);

    /* 剩下那些（狀態對照表、優先度權重、變淡條件、面板欄位順序）是巢狀資料，
       用表單編輯會變成一頁三十個輸入框。這裡給 JSON —— 誠實面對它的形狀，
       而且整條規則能直接複製給別人。 */
    const adv = body.createDiv({ cls: "yazi-set-adv" });
    adv.createEl("div", { cls: "yazi-set-ph-title", text: this.t("settings.decorations.advanced", "Advanced (JSON)") });
    adv.createEl("div", { cls: "yazi-set-desc", text: this.t("settings.decorations.advancedDesc",
      "status / priority / dimWhen / pinWhen / overdue / panel. Edit as JSON and press Apply.") });
    const ta = adv.createEl("textarea", { cls: "yazi-set-args" });
    ta.rows = 8;
    const advKeys = ["status", "priority", "dimWhen", "pinWhen", "statusWhen", "overdue", "panel", "group"];
    const advOf = (rule) => {
      const o = {};
      for (const k of advKeys) if (rule[k] !== undefined) o[k] = rule[k];
      return o;
    };
    ta.value = JSON.stringify(advOf(r), null, 2);
    const apply = adv.createEl("button", { cls: "mod-cta", text: this.t("settings.apply", "Apply") });
    apply.onclick = async () => {
      let parsed = null;
      try {
        parsed = JSON.parse(ta.value || "{}");
      } catch (e) {
        new Notice("Not valid JSON: " + e.message);
        return;
      }
      for (const k of advKeys) delete r[k];
      Object.assign(r, parsed);
      await this.commit();
    };
  }

  /**
   * 用一條規則畫一列示範。
   * 示範用的 frontmatter 是**從規則推導**出來的：規則讀哪個欄位就給哪個欄位一個值，
   * 所以預覽永遠跟當下的設定對得上，不必另外維護一份假資料。
   */
  decorationPreview(row, rule) {
    const fm = {};
    const put = (spec, value) => { if (spec && spec.field) fm[spec.field] = value; };
    if (rule.when && rule.when.field) {
      fm[rule.when.field] = Array.isArray(rule.when.in) ? rule.when.in[0] : rule.when.equals;
    }
    put(rule.icon, rule.icon && rule.icon.from === "map"
      ? Object.keys((rule.icon && rule.icon.map) || {})[0] || "?"
      : "📘");
    put(rule.title, this.t("settings.decorations.sampleTitle", "A note title"));
    put(rule.subtitle, this.t("settings.decorations.sampleSub", "field value"));
    if (rule.status && rule.status.field) {
      fm[rule.status.field] = Object.keys((rule.status.map) || {})[0] || "";
    }
    if (rule.priority && rule.priority.field) {
      fm[rule.priority.field] = Object.keys((rule.priority.order) || {})[0] || "";
    }

    const names = { name: "2026-09-13.md", basename: "2026-09-13" };
    let info = null;
    try {
      info = decorate(fm, [rule], names);
    } catch (e) {
      row.createSpan({ text: "⚠ " + e.message });
      return;
    }
    if (!info) {
      row.createSpan({ cls: "yazi-set-desc", text: this.t("settings.decorations.noMatch", "This rule matches nothing yet") });
      return;
    }
    if (info.dim) row.addClass("is-fm-dim");
    row.createSpan({ cls: "yazi-icon", text: info.icon || "·" });
    row.createSpan({ cls: "yazi-name", text: info.title || names.name });
    if (info.titleFromField && info.subtitle) {
      row.createSpan({ cls: "yazi-sub is-date", text: info.subtitle });
    }
    if (info.status || info.prio || info.pinned || info.overdue) {
      const tail = row.createSpan({ cls: "yazi-fm" });
      if (info.pinned) tail.createSpan({ cls: "yazi-fm-pin", text: "📌" });
      if (info.overdue) tail.createSpan({ cls: "yazi-fm-due", text: "⏰" });
      if (info.status) tail.createSpan({ cls: "yazi-fm-status", text: info.status });
      if (info.prio) tail.createSpan({ cls: "yazi-fm-prio", text: info.prio });
    }
  }

  /** icon / title / subtitle 共用的「來源」設定列。 */
  sourceSetting(body, rule, key, name, desc, froms) {
    const spec = rule[key] || {};
    const set = new Setting(body).setName(name).setDesc(desc);

    set.addDropdown((d) => {
      for (const f of froms) d.addOption(f, f);
      d.setValue(spec.from || froms[0]).onChange(async (v) => {
        rule[key] = Object.assign({}, rule[key], { from: v });
        await this.commit();
      });
    });

    if (spec.from === "field" || spec.from === "map") {
      set.addText((tc) => tc.setPlaceholder("field name").setValue(spec.field || "")
        .onChange(async (v) => { rule[key] = Object.assign({}, rule[key], { field: v }); await this.save(); }));
    }
    if (spec.from === "fixed") {
      set.addText((tc) => tc.setPlaceholder("📄").setValue(spec.value || "")
        .onChange(async (v) => { rule[key] = Object.assign({}, rule[key], { value: v }); await this.save(); }));
    }
    if (spec.from === "map") {
      set.addTextArea((ta) => {
        ta.inputEl.rows = 3;
        ta.inputEl.addClass("yazi-set-args");
        ta.setPlaceholder('{"bug": "🐞"}').setValue(JSON.stringify(spec.map || {}))
          .onChange(async (v) => {
            try {
              rule[key] = Object.assign({}, rule[key], { map: JSON.parse(v || "{}") });
              await this.save();
            } catch (e) { /* 打到一半的 JSON 是常態，不要每按一鍵就噴錯 */ }
          });
      });
    }
    if (spec.from === "field") {
      set.addDropdown((d) => d
        .addOption("", this.t("settings.decorations.noFallback", "no fallback"))
        .addOption("filename", "filename")
        .addOption("basename", "basename")
        .setValue(spec.fallback || "")
        .onChange(async (v) => {
          rule[key] = Object.assign({}, rule[key], { fallback: v || undefined });
          await this.save();
        }));
    }
  }

  /* ════════════════════ 搜尋條件 ════════════════════ */

  renderSearch(el) {
    const s = this.plugin.settings;
    this.header(el, this.t("settings.section.search", "Search fields"),
      this.t("settings.search.desc",
        "The conditions offered while searching. Each one has a key you can press directly, " +
        "and its values are read from the vault, so you only ever see values that actually exist."),
      {
        onExport: () => s.facets,
        onImport: async (parsed) => {
          if (!Array.isArray(parsed)) { new Notice("Expected a JSON array"); return; }
          s.facets = parsed;
          await this.commit();
        },
        onReset: async () => { s.facets = defaultSettings().facets; await this.commit(); },
      });

    const list = el.createDiv({ cls: "yazi-set-list" });
    s.facets.forEach((f, i) => this.facetCard(list, f, i));

    const add = el.createDiv({ cls: "yazi-set-add" });
    const b = add.createEl("button", { text: "+ " + this.t("settings.search.add", "Frontmatter field") });
    b.onclick = async () => {
      s.facets.push({ id: uid(), key: "", icon: "🔖", label: "New field", kind: "fm", field: "", enabled: true });
      await this.commit();
    };
  }

  facetCard(list, f, i) {
    const s = this.plugin.settings;
    const kindLabel = {
      path: this.t("settings.search.kind.path", "folder"),
      tag: this.t("settings.search.kind.tag", "tag"),
      ext: this.t("settings.search.kind.ext", "extension"),
      free: this.t("settings.search.kind.free", "free text"),
      fm: this.t("settings.search.kind.fm", "frontmatter"),
    }[f.kind] || f.kind;

    const card = new RuleCard(list, {
      title: (f.icon ? f.icon + "  " : "") + (f.label || f.id),
      subtitle: kindLabel + (f.kind === "fm" && f.field ? " · " + f.field : ""),
      badge: f.key ? "^" + f.key : "",
      enabled: f.enabled,
      onToggle: async (v) => { f.enabled = v; await this.commit(); },
      onDelete: async () => { s.facets.splice(i, 1); await this.commit(); },
      onMove: async (d) => {
        const j = i + d;
        if (j < 0 || j >= s.facets.length) return;
        s.facets.splice(j, 0, s.facets.splice(i, 1)[0]);
        await this.commit();
      },
    });
    const body = card.body;

    new Setting(body).setName(this.t("settings.search.label", "Label"))
      .addText((tc) => tc.setValue(f.label || "").onChange(async (v) => { f.label = v; await this.save(); }));

    new Setting(body).setName(this.t("settings.search.icon", "Icon"))
      .addText((tc) => { tc.inputEl.style.width = "4em";
        tc.setValue(f.icon || "").onChange(async (v) => { f.icon = v; await this.save(); }); });

    new Setting(body)
      .setName(this.t("settings.search.key", "Direct key"))
      .setDesc(this.t("settings.search.keyDesc", "Pressed with Ctrl while searching. Avoid j and k — those move the selection."))
      .addText((tc) => { tc.inputEl.maxLength = 1; tc.inputEl.style.width = "3em";
        tc.setValue(f.key || "").onChange(async (v) => { f.key = v; await this.save(); }); });

    new Setting(body)
      .setName(this.t("settings.search.kind", "Kind"))
      .addDropdown((d) => d
        .addOption("fm", this.t("settings.search.kind.fm", "frontmatter"))
        .addOption("path", this.t("settings.search.kind.path", "folder"))
        .addOption("tag", this.t("settings.search.kind.tag", "tag"))
        .addOption("ext", this.t("settings.search.kind.ext", "extension"))
        .addOption("free", this.t("settings.search.kind.free", "free text"))
        .setValue(f.kind || "fm")
        .onChange(async (v) => { f.kind = v; await this.commit(); }));

    if (f.kind === "fm") {
      new Setting(body)
        .setName(this.t("settings.search.field", "Frontmatter field"))
        .setDesc(this.t("settings.search.fieldDesc", "Its values are collected from the vault, with counts."))
        .addText((tc) => tc.setPlaceholder("status").setValue(f.field || "")
          .onChange(async (v) => { f.field = v; await this.save(); }));
    }
  }

  /* ════════════════════ 預覽與行為 ════════════════════ */

  renderPreview(el) {
    const s = this.plugin.settings;
    this.header(el, this.t("settings.section.preview", "Preview & behaviour"), "");

    new Setting(el)
      .setName(this.t("settings.language", "Language"))
      .setDesc(this.t("settings.languageDesc", "Follow Obsidian, or pick one explicitly."))
      .addDropdown((d) => {
        for (const l of LOCALES) d.addOption(l.id, l.label);
        d.setValue(s.locale || "auto").onChange(async (v) => {
          s.locale = v;
          await this.save();
          this.plugin.reloadTranslator();
          this.display();   // 整頁重畫，不然只有下一次開設定才會變成新語言
        });
      });

    new Setting(el)
      .setName(this.t("settings.preview.render", "Render markdown"))
      .setDesc(this.t("settings.preview.renderDesc",
        "Show the preview the way Reading view does. Plugin blocks (dataviewjs, tasks, meta-bind…) " +
        "are always stripped first, so browsing never executes anything."))
      .addToggle((t) => t.setValue(s.preview.renderMarkdown).onChange(async (v) => {
        s.preview.renderMarkdown = v;
        await this.save();
      }));

    new Setting(el)
      .setName(this.t("settings.preview.delay", "Render delay"))
      .setDesc(this.t("settings.preview.delayDesc",
        "Plain text shows immediately; the rendered version replaces it after this pause. " +
        "Holding j then costs one render, not thirty."))
      .addSlider((sl) => sl.setLimits(0, 600, 20).setValue(s.preview.renderDelay).setDynamicTooltip()
        .onChange(async (v) => { s.preview.renderDelay = v; await this.save(); }));

    new Setting(el)
      .setName(this.t("settings.preview.seek", "Scroll step"))
      .setDesc(this.t("settings.preview.seekDesc", "Lines scrolled by the preview scroll keys."))
      .addSlider((sl) => sl.setLimits(1, 20, 1).setValue(s.preview.seekLines).setDynamicTooltip()
        .onChange(async (v) => { s.preview.seekLines = v; await this.save(); }));

    new Setting(el)
      .setName(this.t("settings.preview.wheel", "Wheel scrolls the preview"))
      .setDesc(this.t("settings.preview.wheelDesc",
        "Scroll the preview pane wherever the pointer sits, so you never have to move the mouse there."))
      .addToggle((t) => t.setValue(s.preview.wheelScrollsPreview).onChange(async (v) => {
        s.preview.wheelScrollsPreview = v;
        await this.save();
      }));

    new Setting(el)
      .setName(this.t("settings.behavior.wrap", "Wrap around"))
      .setDesc(this.t("settings.behavior.wrapDesc",
        "The last item jumps back to the first. Half-page moves and visual mode never wrap."))
      .addToggle((t) => t.setValue(s.behavior.wrapCursor).onChange(async (v) => {
        s.behavior.wrapCursor = v;
        await this.save();
      }));

    new Setting(el)
      .setName(this.t("settings.behavior.halfPage", "Half page"))
      .setDesc(this.t("settings.behavior.halfPageDesc", "Rows moved by the half-page keys."))
      .addSlider((sl) => sl.setLimits(2, 40, 1).setValue(s.behavior.halfPage).setDynamicTooltip()
        .onChange(async (v) => { s.behavior.halfPage = v; await this.save(); }));
  }

  /* ════════════════════ 索引 ════════════════════ */

  renderIndex(el) {
    const s = this.plugin.settings;
    this.header(el, this.t("settings.section.index", "Full-text index"),
      this.t("settings.index.desc",
        "Full-text search keeps its own index. It is built the first time you search, kept in the " +
        "plugin's data folder, and updated as files change."));

    new Setting(el)
      .setName(this.t("settings.index.enabled", "Enable full-text search"))
      .addToggle((t) => t.setValue(s.index.enabled).onChange(async (v) => {
        s.index.enabled = v;
        await this.save();
      }));

    new Setting(el)
      .setName(this.t("settings.index.maxFile", "Skip files larger than"))
      .setDesc(this.t("settings.index.maxFileDesc", "Megabytes."))
      .addSlider((sl) => sl.setLimits(1, 20, 1).setValue(Math.round(s.index.maxFileBytes / 1048576)).setDynamicTooltip()
        .onChange(async (v) => { s.index.maxFileBytes = v * 1048576; await this.save(); }));

    new Setting(el)
      .setName(this.t("settings.index.exclude", "Excluded folders"))
      .setDesc(this.t("settings.index.excludeDesc", "One per line. Prefix match on the vault-relative path."))
      .addTextArea((ta) => {
        ta.inputEl.rows = 4;
        ta.setValue((s.index.excludeFolders || []).join("\n")).onChange(async (v) => {
          s.index.excludeFolders = v.split("\n").map((x) => x.trim()).filter(Boolean);
          await this.save();
        });
      });

    /*
     * 索引檔的大小要看得見：它住在 vault 的 .obsidian 底下，一個大 vault 可以長到
     * 十幾 MB —— 那會跟著同步與備份跑。看不到大小的話，沒有人會知道該不該清它。
     */
    const box = el.createDiv({ cls: "yazi-set-stats" });
    const refresh = async () => {
      box.empty();
      const stats = this.plugin.textIndexStats;
      let size = null;
      try {
        const st = await this.app.vault.adapter.stat(this.plugin.indexPath());
        size = st && st.size;
      } catch (e) { /* 還沒建過就沒有這個檔 */ }
      const bits = [];
      if (stats) bits.push(this.t("settings.index.stats", "Indexed") + ": " + stats.files);
      bits.push(this.t("settings.index.size", "Cache on disk") + ": " +
        (size ? (size / 1048576).toFixed(1) + " MB" : "—"));
      box.createSpan({ text: bits.join("　·　") });

      const clear = box.createEl("button", { text: this.t("settings.index.clear", "Clear cache") });
      clear.onclick = async () => {
        await this.plugin.clearIndex();
        new Notice(this.t("settings.index.cleared", "Index cache cleared"));
        refresh();
      };
    };
    refresh();
  }
}

module.exports = { YaziSettingTab, RuleCard, ImportModal, SECTIONS };
