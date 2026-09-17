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
const { defaultSettings, EXAMPLE_DECORATIONS, PLACEHOLDERS, OPENER_KINDS } = require("./defaults.js");

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

  renderKeys(el) {
    this.header(el, this.t("settings.section.keys", "Keys"),
      this.t("settings.keys.desc", "Rebind any action. Multi-key sequences are supported."));
    this.emptyHint(el, "Coming in the next step.");
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
    this.emptyHint(el, "Coming in the next step.");
    const add = el.createDiv({ cls: "yazi-set-add" });
    for (const ex of EXAMPLE_DECORATIONS) {
      const b = add.createEl("button", { text: "+ " + ex.name });
      b.onclick = async () => {
        s.decorations.push(Object.assign({}, ex, { id: uid() }));
        await this.commit();
      };
    }
  }

  renderSearch(el) {
    this.header(el, this.t("settings.section.search", "Search fields"),
      this.t("settings.search.desc", "Which frontmatter fields become search conditions."));
    this.emptyHint(el, "Coming in the next step.");
  }

  /* ════════════════════ 預覽與行為 ════════════════════ */

  renderPreview(el) {
    const s = this.plugin.settings;
    this.header(el, this.t("settings.section.preview", "Preview & behaviour"), "");

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

    const stats = this.plugin.textIndexStats;
    if (stats) {
      const box = el.createDiv({ cls: "yazi-set-stats" });
      box.setText(this.t("settings.index.stats", "Indexed") + ": " + stats.files + " files");
    }
  }
}

module.exports = { YaziSettingTab, RuleCard, ImportModal, SECTIONS };
