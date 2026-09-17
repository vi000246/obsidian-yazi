# Yazi Explorer for Obsidian

**A keyboard-driven file explorer for Obsidian — miller columns, live preview, and fully rebindable keys.**
Inspired by [yazi](https://github.com/sxyazi/yazi), [ranger](https://github.com/ranger/ranger), `lf` and `nnn`.

If you navigate your vault from the sidebar file tree with a mouse, this is the replacement: a floating
three-column browser that opens on the file you are editing, and that you never have to take your hands
off the keyboard to use.

> **Status:** early. The plugin has been in daily use in a 5000-note vault, but the public API
> (settings schema, action ids) may still change before 1.0.

---

## Why another file explorer

Obsidian's built-in **File Explorer** is a tree in a narrow sidebar. That is fine for clicking, but it
makes three things awkward, and this plugin exists for those three:

| | Built-in File Explorer | Yazi Explorer |
|---|---|---|
| **Seeing where you are** | one narrow column, deep folders scroll horizontally | **miller columns**: parent / current / preview, always three levels of context |
| **Deciding "is this the file?"** | file names only | **live preview** of the file next to the list — rendered markdown, images, tables |
| **Getting there** | click, scroll, expand | `j` `k` `h` `l`, fuzzy file/folder search, full-text search, bookmarks, "frequently used" |

It is not a replacement for Quick Switcher (which is great at "I know the name"). It is for
*"I want to look around"* — browsing, comparing, moving files, and operating on a batch of them.

## Features

- **Miller columns** — parent, current folder, and a preview pane, like yazi / ranger / Midnight Commander.
- **Live preview** — markdown rendered the way Reading view renders it (tables, headings, mermaid),
  images, and a metadata panel for frontmatter. Plugin blocks (dataviewjs, tasks, meta-bind, …) are
  stripped before rendering, so browsing never executes anything.
- **Vim-style keys** — `j/k/h/l`, `gg/G`, `d/u`, visual selection with `v`, `y`/`x`/`p` to copy, cut
  and paste files. **Every key is rebindable.**
- **Search** — fuzzy file name, fuzzy folder name, and full-text search with highlighted hits and
  context lines. Searches can be narrowed with frontmatter conditions you define.
- **Bookmarks and frecency** — jump to a folder with a single letter, or open the list of the places
  you actually use.
- **Multi-select across folders** — select here, walk somewhere else, select more, then move the lot.
- **Custom openers** — open the file under the cursor with *anything*: your editor, a terminal, the
  system file manager, or any command line you configure. This is the yazi `O` menu, in Obsidian.
- **Works on mobile** for everything that does not need a shell.

## Install

Not in the community plugin list yet. To try it now:

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/vi000246/obsidian-yazi/releases).
2. Put them in `<your vault>/.obsidian/plugins/yazi-explorer/`.
3. Reload Obsidian and enable **Yazi Explorer** in *Settings → Community plugins*.

Or install with [BRAT](https://github.com/TfTHacker/obsidian42-brat) using `vi000246/obsidian-yazi`.

## Getting started

Open it with the command **“Yazi Explorer: open”** (bind it to a hotkey — `Alt+E` works well), then
press `?` for the key list.

The 20-second version:

```
j / k      down / up                l / Enter   open (folder → enter)
h          up one folder            o           open in Obsidian
gg / G     top / bottom             O           open with… (external programs)
gf / gd    fuzzy file / folder      gt          full-text search
Space      select                   y x p       copy / cut / paste
/          filter this folder       ?           help
```

## Configuration

Everything below is in *Settings → Yazi Explorer*, and every section can be exported/imported as JSON
so you can share a setup:

- **Keys** — rebind any action. Multi-key sequences (`g g`, `c c`) are supported and show a
  which-key style popup while you type them.
- **Openers** — the `O` menu. Each entry is a label, a key, what it applies to (files, folders,
  extensions) and an action: open with the system default app, reveal in the file manager, run an
  Obsidian command, or run a command line with `{{path}}`-style placeholders. Desktop only for the
  command-line kind.
- **Row decorations** — show frontmatter in the file list: an icon from a field, a different title,
  a right-aligned secondary column, status tails. Driven by rules you write, not by hardcoded
  conventions.
- **Search fields** — which frontmatter fields become search conditions.
- **Index** — the full-text search index: on/off, size caps, excluded folders.

## Development

```bash
npm install
cp .env.local.example .env.local   # point it at your vault's plugin folder
npm run dev                        # watch + copy into the vault
npm test                           # node test suite, no Obsidian required
npm run build                      # production build
```

The source is plain JavaScript (not TypeScript) on purpose: the code carries a lot of *why* in its
comments and a type-driven rewrite would churn all of it. Types come from JSDoc where they help.

`src/` is bundled by esbuild into `main.js`. Tests stub the Obsidian API, so they run in plain Node
and cover the parts worth covering: key dispatch, preview sanitising, opener resolution, path
handling, and settings migration.

## Credits

The interaction model is lifted wholesale from [yazi](https://github.com/sxyazi/yazi) by sxyazi.
This plugin is not affiliated with that project.

## License

[MIT](LICENSE)
