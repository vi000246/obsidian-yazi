/*
 * English — the reference catalogue.
 *
 * Every key that exists anywhere must exist here, because every other language
 * falls back to this file. Keys are grouped by where they appear:
 *   cmd.*      command palette entries
 *   notice.*   transient notices
 *   ui.*       the explorer itself (status bar, which-key, empty states)
 *   settings.* the settings tab
 *   help.*     the ? page
 */
module.exports = {
  /* ── commands ── */
  "cmd.open": "Open file explorer (at the current file)",
  "cmd.openTabs": "Open tab list",
  "cmd.openBookmarks": "Open bookmarks",
  "cmd.openRecent": "Open recent files",
  "cmd.openSearch": "Open full-text search",

  /* ── notices ── */
  "notice.noPath": "This item has no file path",
  "notice.noOpeners": "No openers apply to this item",
  "notice.noAbsPath": "Cannot resolve an absolute path here",
  "notice.openFailed": "Open failed",
  "notice.copied": "Copied: {text}",
  "notice.copyFailed": "Copy failed: {error}",
  "notice.nothingToCopy": "Nothing to copy",
  "notice.atVaultRoot": "Already at the vault root",
  "notice.deleted": "Deleted {count} items",
  "notice.deleteFailed": "Failed to delete {count} items:\n{errors}",
  "notice.pathGone": "Path no longer exists: {path}",
  "notice.sort": "Sort: {value}",
  "notice.previewRendered": "Preview: rendered markdown",
  "notice.previewPlain": "Preview: plain text",

  /* ── explorer UI ── */
  "ui.empty": "(empty)",
  "ui.emptyFolder": "(empty folder)",
  "ui.noItems": "(no items)",
  "ui.noPreview": "(cannot preview)",
  "ui.help": "? help",
  "ui.helpTitle": "Keys · Esc or ? to close",
  "ui.cancel": "Esc to cancel",
  "ui.waitingKey": "waiting for the next key",
  "ui.selected": "{count} selected",
  "ui.filter": "Filter: {value}",
  "ui.vaultRoot": "(vault root)",

  /* ── settings: sections ── */
  "settings.section.keys": "Keys",
  "settings.section.openers": "Openers",
  "settings.section.decorations": "Row decorations",
  "settings.section.search": "Search fields",
  "settings.section.preview": "Preview",
  "settings.section.index": "Index",

  /* ── settings: shared ── */
  "settings.export": "Export",
  "settings.import": "Import",
  "settings.reset": "Reset",
  "settings.exported": "Copied to clipboard",
  "settings.imported": "Imported",
  "settings.resetConfirm": "Reset this section to defaults?",
  "settings.language": "Language",
  "settings.languageDesc": "Follow Obsidian, or pick one explicitly.",

  /* ── settings: openers ── */
  "settings.openers.desc":
    "What the O menu offers for the item under the cursor. Each entry is a key plus an action; " +
    "the menu adapts to whether a file or a folder is selected.",
  "settings.openers.empty": "No openers yet.",
  "settings.openers.label": "Label",
  "settings.openers.labelDesc": "Shown in the O menu.",
  "settings.openers.key": "Key",
  "settings.openers.keyDesc": "Single key pressed after O. Leave empty for menu-only.",
  "settings.openers.appliesTo": "Applies to",
  "settings.openers.extensions": "Extensions",
  "settings.openers.extensionsDesc": "Comma separated, e.g. md, canvas. Empty means any file.",
  "settings.openers.platform": "Platform",
  "settings.openers.kind": "Action",
  "settings.openers.command": "Executable",
  "settings.openers.commandDesc": "Full path, or a name on PATH.",
  "settings.openers.args": "Arguments",
  "settings.openers.argsDesc":
    "One per line. Each line is passed as a single argument, so paths with spaces are safe.",
  "settings.openers.placeholders": "Placeholders",
  "settings.openers.commandId": "Command ID",
  "settings.openers.commandIdDesc":
    "e.g. editor:open-search. The file under the cursor is opened first, then the command runs.",
  "settings.openers.desktopOnly":
    "Desktop only. This spawns an external process; it will not appear on mobile.",
  "settings.openers.addSystem": "Default app",
  "settings.openers.addCommand": "Command line",
  "settings.openers.addObsidian": "Obsidian command",
  "settings.openers.kind.system": "default app",
  "settings.openers.kind.reveal": "file manager",
  "settings.openers.kind.command": "command line",
  "settings.openers.kind.obsidian": "Obsidian command",

  /* ── settings: keys ── */
  "settings.keys.desc": "Rebind any action. Multi-key sequences are supported.",

  /* ── settings: decorations ── */
  "settings.decorations.desc":
    "Use frontmatter to change how a row looks: an icon, a different title, a secondary column.",

  /* ── settings: search ── */
  "settings.search.desc": "Which frontmatter fields become search conditions.",

  /* ── settings: preview ── */
  "settings.preview.render": "Render markdown",
  "settings.preview.renderDesc":
    "Show the preview the way Reading view does. Plugin blocks (dataviewjs, tasks, meta-bind…) " +
    "are always stripped first, so browsing never executes anything.",
  "settings.preview.delay": "Render delay",
  "settings.preview.delayDesc":
    "Plain text shows immediately; the rendered version replaces it after this pause. " +
    "Holding j then costs one render, not thirty.",
  "settings.preview.seek": "Scroll step",
  "settings.preview.seekDesc": "Lines scrolled by the preview scroll keys.",
  "settings.preview.wheel": "Wheel scrolls the preview",
  "settings.preview.wheelDesc":
    "Scroll the preview pane wherever the pointer sits, so you never have to move the mouse there.",
  "settings.behavior.wrap": "Wrap around",
  "settings.behavior.wrapDesc":
    "The last item jumps back to the first. Half-page moves and visual mode never wrap.",
  "settings.behavior.halfPage": "Half page",
  "settings.behavior.halfPageDesc": "Rows moved by the half-page keys.",

  /* ── settings: index ── */
  "settings.index.desc":
    "Full-text search keeps its own index. It is built the first time you search, kept in the " +
    "plugin's data folder, and updated as files change.",
  "settings.index.enabled": "Enable full-text search",
  "settings.index.maxFile": "Skip files larger than",
  "settings.index.maxFileDesc": "Megabytes.",
  "settings.index.exclude": "Excluded folders",
  "settings.index.excludeDesc": "One per line. Prefix match on the vault-relative path.",
  "settings.index.stats": "Indexed",
};
