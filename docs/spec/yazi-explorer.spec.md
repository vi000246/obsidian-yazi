# Spec: Yazi Explorer

## Metadata
- **Module**: yazi-explorer
- **Parent Module**: N/A
- **Sub-modules**: N/A
- **Source PRDs**: N/A — brownfield; the README (`README.md`) is the closest product statement
- **Source Issue**: N/A (repo has `tracker.primary.kind: none`, see `docs/prp.config.yml`)
- **Owner**: Logan Lin (`manifest.json`)
- **Status**: ACTIVE — living document
- **Created**: 2026-09-18 12:18
- **Last Updated**: 2026-09-18 14:45

## Change History

| Date | Source PRD | Feature SRS | Summary |
|------|------------|-------------|---------|
| 2026-09-18 12:18 | code-sync | N/A | Created from brownfield analysis — keyboard-driven miller-column file explorer for Obsidian (`main.js` modal + pure core modules), at v0.1.0 with outline / relations / saved views / layer-stack navigation just landed |
| 2026-09-18 13:40 | code-sync | N/A | Esc/h/q refactor: OVERLAYS table replaces the if-ladder; results Esc leaves the search; landing-folder `h` returns to the list; `src/main.js` anchors re-pointed after the insertions |
| 2026-09-18 14:45 | code-sync | N/A | Multi-select reaches the list views: `listSel` + the `LIST_REMOVE` table give bookmarks / views / tabs / most-visited the file view's `Space` `v` `V` `^a` `^r`, and `x` removes the whole selection behind one confirm. Fixed alongside: visual range never un-selected on pull-back (both views). Anchors re-pointed |

## Summary

Yazi Explorer is an Obsidian community plugin that replaces mouse-driven use of the sidebar file tree with a floating three-column (miller) browser modelled on `yazi` / `ranger`. One class, `YaziModal` (`src/main.js:584`), owns all interaction: a capture-phase `keydown` listener dispatches keys by *mode* × *view*, a layer stack makes `h` / `Esc` / `q` uniform across every list, and the right column renders a sanitised markdown preview. Everything that touches a specific vault's vocabulary — openers, row decorations, search facets, relation fields, saved views — is configuration in `data.json`, so the shipped code carries no vault-specific rules.

---

## Domain Model

### Bounded Context
- **Context Name**: VaultNavigation
- **Domain Layer**: Core Domain (the plugin *is* the product)
- **Parent Module**: N/A

### Ubiquitous Language
| Term | Definition |
|------|-----------|
| View | Which list the middle column shows: `files`, `tabs`, `bookmarks`, `recent`, `frecency`, `search`, `outline`, `relations`, `views` (`src/main.js:584` constructor; dispatched in `src/main.js:3302`) |
| Mode | What the keyboard is doing inside a view: `nav`, `filter`, `listfilter`, `helpfilter`, `prompt`, `confirm`, `search` (composer input focused) |
| Layer | A snapshot of the visible state pushed when you go somewhere new; `h`/`Esc` pop it (`src/main.js:1722`, `src/main.js:1732`) |
| Composer | The centred search card where words are typed and facets added; results are the same `search` view with `composing=false` (`src/main.js:2354`) |
| Facet | One search condition chip `{id, value}` whose definition (`kind: path\|tag\|ext\|free\|fm`) comes from settings (`src/main.js:404`, `src/main.js:1643`) |
| Scope | The folder a search is confined to; stored separately from facets and always shown as a chip (`src/main.js:1102`) |
| Opener | A configured way to open the item under the cursor outside the editor (`O` menu) — system default app, reveal in file manager, or a command line (`src/main.js:2882`, `src/core/openers.js:45`) |
| Decoration rule | A frontmatter-driven rule that adds icon / title / group / status / priority / dim / overdue to a row (`src/core/decorate.js:93`, applied via `src/main.js:5345`) |
| Relation rule | A frontmatter field treated as a typed link (`parent`, `up`, `related`, `blocks`); the reverse direction is always derived, never stored (`src/core/relations.js:68`, `src/settings/defaults.js:214`) |
| Saved view | A named snapshot of a search's kind + words + facets + scope, re-run on open — conditions, not results (`src/main.js:2259`, `src/main.js:2311`) |
| Frecency | Ranking of folders entered and files opened by count × time decay (`src/main.js:5833`) |
| Outline | The headings of one note as a list; the preview scrolls to the heading under the cursor instead of re-rendering (`src/main.js:2083`, `src/main.js:2122`) |
| Pending prefix | First key of a multi-key sequence (`g`, `c`, `,`, `r`, `'`, `sort`, `open`, `assign`, `vassign`) shown as a which-key card (`src/main.js:560`, `src/main.js:3748`) |
| Keymap alias | User `map A B` / `unmap A` text that re-routes one key to another sequence; keys inside the explorer are otherwise fixed (`src/core/keymap.js:68`, `src/main.js:4686`) |
| Overlay | A transient thing stacked on the current place — pending prefix, suggestion list, help page (and its filter), input line, confirm bar, composer, selection. `Esc` dismisses the innermost open one; the set is a single ordered table (`src/main.js:149`) |
| Selection | The rows a bulk action applies to. Two sets, never merged: `sel` holds file paths and survives folder changes (yazi's semantics); `listSel` holds list-row identities and is dropped whenever the view changes (`src/main.js:3099`, `src/main.js:3141`). `Esc` clears only the one belonging to the current view |
| Row identity | What a list selection stores, since a row is not always a path: views by `viewDef.id`, tabs by the `leaf` object (two tabs can show one file), everything else by path. Must survive `buildList()`, so never an index (`src/main.js:3111`) |

### Domain Events
None raised. The module *consumes* Obsidian workspace / vault events only (`file-open` for frecency at `src/main.js:5824`; vault `create/delete/rename` for re-render and index upkeep at `src/main.js:5770`).

---

## System Context

### Scope & Boundaries
- **In scope**: browsing and previewing vault files; fuzzy file / folder / full-text search with facets; bookmarks, tabs, recent, most-visited lists; outline and relation walking; saved views; file operations (create, rename, delete-to-trash, copy/cut/paste via `app.fileManager`); opening items outside Obsidian; settings tab; i18n (en reference, zh-TW).
- **Out of scope**: writing frontmatter or note content (relations, statuses are read-only); replacing Quick Switcher's "I know the name" flow; any network access; mobile-only UI (mobile works, but command-line openers are filtered out).

### Actors
| Actor | Type | Interaction |
|---|---|---|
| Vault user | Human | Opens the explorer via a command / hotkey, navigates with hjkl-style keys, opens or acts on files |
| Obsidian app | Service | Provides vault, metadata cache, workspace leaves, `MarkdownRenderer`, settings storage (`loadData`/`saveData`) |
| Other plugins | Service | Compete for `keydown`; this module listens on `window` in the capture phase and stops propagation for handled keys (`src/main.js:3302`) |
| Electron / OS | Service | `shell.openPath` / `showItemInFolder`; `child_process.spawn` for command openers — desktop only (`src/main.js:2960`, `src/main.js:2919`) |

### External Dependencies
| Dependency | Purpose | Failure Mode |
|---|---|---|
| `obsidian` API (`Plugin`, `Modal`, `PluginSettingTab`, `Setting`, `Notice`, `Platform`, `Component`, `MarkdownRenderer`, `FileSystemAdapter`, `prepareFuzzySearch`) | Everything UI and vault | `prepareFuzzySearch` missing → substring matcher fallback (`src/main.js:80`); `MarkdownRenderer.render` missing → legacy `renderMarkdown` (`src/main.js:4716`); `FileSystemAdapter` not present → absolute paths unavailable (`src/main.js:299`) |
| `electron.shell` (lazy `require`, desktop) | Open with default app / reveal in file manager | Not desktop → openers of those kinds hidden; require failure → Notice |
| `child_process.spawn` (lazy `require`, desktop) | Command-line openers, argv array never a shell string | Not desktop → command openers filtered out of the `O` menu (`src/core/openers.js:45`) |
| `esbuild`, `builtin-modules` (dev only) | Bundle to CJS `main.js` | Build-time only; no runtime npm dependencies (`package.json`) |

---

## Architecture

### High-Level Diagram
```
Obsidian command / hotkey
        │  openExplorer(view)                              src/main.js:5998
        ▼
┌──────────────────── YaziModal (src/main.js:584) ────────────────────┐
│ window keydown (capture) ──► handleKey ──► mode × view dispatch     │
│                              src/main.js:3302   resolvePending 3541 │
│                                                                      │
│  layers[] ◄── pushLayer / popLayer ◄── h / Esc / q                   │
│  src/main.js:1722 / 1672            escapeBack src/main.js:1788      │
│                                                                      │
│  ┌ parent col ┐  ┌ main col ┐  ┌ preview col ┐                       │
│  │ folder or  │  │ files /  │  │ sanitised   │  renderPreview 4325   │
│  │ prev hop   │  │ list view│  │ markdown    │  renderFilePreview    │
│  └────────────┘  └──────────┘  └─────────────┘  4561 → 4495          │
└──────────────┬───────────────────────────────────────────────────────┘
               │ pure helpers (no Obsidian import)
   ┌───────────┼──────────────┬──────────────┬──────────────┐
   ▼           ▼              ▼              ▼              ▼
 core/openers  core/decorate  core/keymap   core/relations  core/outline, core/aliases
   (O menu)    (row rules)    (map/unmap)   (typed links)   (headings, aliases)
               │
   settings/defaults.js (schema + defaults) ── settings/tab.js (UI) ── i18n/{index,en,zh-tw}.js
```

### Components
| Component | Responsibility | Interface |
|---|---|---|
| `YaziExplorer` plugin (`src/main.js:5490`) | Load/merge settings and user data, register 11 commands, keep frecency and the full-text index fresh, open the modal | Obsidian `Plugin` lifecycle (`onload` `src/main.js:5491`, `onunload` `src/main.js:5804`) |
| `YaziModal` (`src/main.js:584`) | All interaction: key dispatch, views, layer stack, rendering, file operations | `new YaziModal(app, startFile, plugin)`; `initialView` set before `open()` (`src/main.js:5998`) |
| Layer stack (`src/main.js:1722`–`1745`) | Uniform back/dismiss/close semantics across every view | `pushLayer()` before entering a place; `popLayer()`; `goBackLayer()` (h), `leaveSubView()` (Esc at the place level), `forceClose()` (q) |
| Search (`src/main.js:1102`, `1125`, `1084`) | Fuzzy over path + frontmatter aliases; folder fuzzy; full-text over an in-memory index; facets and scope narrow the pool before matching | `openSearch(kind)`, `buildSearchListRaw()`, `passFacets(f, content)` (`src/main.js:1643`) |
| Preview (`src/main.js:4546`, `4531`, `4465`) | Plain text first, rendered markdown after a debounce; plugin blocks stripped before rendering; failure keeps plain text and says so | `renderFilePreview(el, file, {header})`; `stripPluginNoise` `src/main.js:5145`, `stripForRender` `src/main.js:5194` |
| Openers (`src/main.js:2882`, `2812`, `2853`; `src/core/openers.js`) | Build the `O` menu for file vs folder on this platform; run system / reveal / command openers | `resolveOpeners(openers, item, plat, desktop)`, `buildCommand(o, vars)` |
| Decorations (`src/core/decorate.js:93`; `src/main.js:5345`, `5115`) | Frontmatter → icon/title/group/status/priority/dim/overdue; drives row rendering and frontmatter-aware sorting | `decorate(fm, rules, names)`; `fmInfo(file)`; `sortFiles(list, cfg)` |
| Relations (`src/core/relations.js:68`; `src/main.js:2173`, `2129`, `2412`) | Typed links from frontmatter with derived inverses; untyped links/backlinks folded; walked like folders | `collectRelations(file, rules, ctx)`; `relationGroupsFor(file)` (cached per modal); `enterRelation()` |
| Outline (`src/core/outline.js`; `src/main.js:2083`, `2049`) | Headings list; preview scrolls to the n-th heading by ordinal, matching rendered `<h*>` or plain-text lines | `outlineItems(headings)`, `headingLines(text)`, `followOutline()` |
| Saved views (`src/main.js:2259`, `2238`, `2281`) | Persist and re-run a search's conditions; edit by reopening the composer | `saveCurrentView()`, `runView(v)`, `editView(v)`; plugin `saveView/removeView/assignViewKey` |
| Settings tab (`src/settings/tab.js:123`) | Six sections (`src/settings/tab.js:21`) editing the arrays in settings; import/export/reset per section | `PluginSettingTab.display()`; `RuleCard` (`:34`), `ImportModal` (`:92`) |
| i18n (`src/i18n/index.js:36`) | English reference catalogue with per-call fallback strings; zh-TW overlay; locale from Obsidian or setting | `createTranslator(setting)` → `t(key, fallback, vars)` |

### Data Flow
Synchronous and pull-based. A key press mutates modal state and calls `render()`, which repaints the three columns from state (`src/main.js:3802` region — `renderFiles`/`renderList` then `renderPreview`). Only the preview is asynchronous: `cachedRead` → plain `<pre>` → after `PREVIEW_RENDER_DELAY` a `MarkdownRenderer` pass replaces it, guarded by a `previewToken` so stale reads are dropped (`src/main.js:4782`). Full-text search reads from a `Map` built once per session and persisted to `text-index.json` (`src/main.js:5678`), kept fresh by vault events (`src/main.js:5770`). Settings and user data are one object saved through `saveData` (`src/main.js:61` merge on load).

### Sequence Diagrams (key flows)
```
Esc / h / q — one rule (src/main.js:1788, src/main.js:1768, src/main.js:1841)
  Esc ─► top = first OVERLAYS row whose open(modal) is true   (src/main.js:149)
        ─► found: row.close(modal)   (composer's close leaves the search)
        ─► none:  popLayer()  ─► nothing to pop: forceClose()
  h   ─► list views: popLayer(), else stay (Notice)
        files view: at the landing folder or vault root with layers → popLayer(); else parent folder (src/main.js:976)
  q   ─► forceClose(), from anywhere
  pushLayer() first closes the ephemeral overlays (prefix, suggestion, help, confirm) so a snapshot never carries them (src/main.js:1800)
gr — relations walked like folders (src/main.js:2485)
  cursor on note X ─► gr ─► pushLayer(current) ─► relFile=X ─► list = groups(X)
  l/Enter on Y ─► pushLayer ─► relFile=Y        (left column now shows X's list)
  l/Enter on "▸ 12 Backlinks" ─► relExpanded.add(X\nBacklinks) ─► rebuild (no push)
  h ─► popLayer ─► back to X                     o/t ─► openFile(Y)
```

---

## Data Model

### Entities
| Entity | Owner | Lifecycle |
|---|---|---|
| Settings (`data.json`, same object as user data) | Plugin | Merged with defaults on load (`src/main.js:61`); arrays in saved data replace defaults wholesale; written on every settings change, bookmark, view, sort or frecency save |
| Bookmark `{path, name, key, added}` | Plugin `data.bookmarks` | Created by `m`/`M` after a name prompt (`src/main.js:2553`); legacy object form migrated to array (`migrateBookmarks`) |
| Saved view `{id, name, key, kind, query, facets[], scopePath}` | Plugin `data.views` | Created by `s` in search results; same name replaces (`saveView`) |
| Frecency record (path → visits, scored by `frecencyScore` `src/main.js:5833`) | Plugin `data.frecency` | Bumped on `file-open` and `gotoFolder`; pruned to `FRECENCY_KEEP` |
| Full-text index `Map<path, text>` + `text-index.json` | Plugin | Built on first `gt`, persisted to the plugin folder, refreshed by vault events; size shown/clearable in settings |
| Layer snapshot | Modal (in-memory) | Pushed on entering a place, popped by h/Esc, capped at `LAYER_MAX` (`src/main.js:132`); dies with the modal |

### Schema (settings — `src/settings/defaults.js:229`)
```yaml
schemaVersion: 1
locale: auto | en | zh-TW
keymap: ""                       # map/unmap text, parsed by src/core/keymap.js:68
openers:     [ { id, enabled, label, kind, appliesTo, platform, ... } ]   # src/settings/defaults.js:36
decorations: [ { id, enabled, when, icon?, title?, group?, status?, priority?, overdue?, panel? } ]  # src/core/decorate.js:93
facets:      [ { id, key, icon, label, kind: path|tag|ext|free|fm, field?, enabled } ]   # src/settings/defaults.js:221
relations:   [ { id, enabled, field, label, inverse? , symmetric? } ]     # src/settings/defaults.js:214
views:       [ { id, name, key, kind, query, facets: [{id, value}], scopePath } ]
preview:  { renderMarkdown, renderDelay, seekLines, maxChars, maxLines, wheelScrollsPreview }
behavior: { wrapCursor, halfPage, recentLimit, frecencyLimit, searchLimit }
index:    { ... }                # full-text index caps
# runtime-only additions on the same object:
bookmarks: [ { path, name, key, added } ]
frecency:  { <path>: <record> }
sort:      { field, reverse, foldersFirst }
```

### Migration Strategy
- **Forward**: `mergeSettings(defaultSettings(), raw)` deep-merges objects and takes saved arrays as-is; new keys (e.g. `relations`, `views`) appear automatically from defaults (`src/main.js:61`, `src/settings/defaults.js:294`).
- **Backward**: unknown keys in saved data are preserved and written back; older builds ignore them.
- **Backfill**: none required; `migrateBookmarks` converts the pre-array bookmark object.
- **Coexistence**: `schemaVersion` is stored but no versioned migrator exists yet (see Open Questions).

---

## API Contracts

This module exposes no HTTP API. Its public surface is Obsidian commands and the settings schema above.

### Commands (`src/main.js:5530`–`5341`)
| Command id | Opens |
|---|---|
| `open` | explorer at the current file (`files`) |
| `open-tabs`, `open-bookmarks`, `open-recent`, `open-frecency`, `open-views` | that list as the first layer |
| `open-outline`, `open-relations` | outline / relations of the active note |
| `search-text`, `search-file`, `search-dir` | straight into that search's composer |

A list opened by command is the bottom layer: `Esc`/`q` close, `h` stays (`src/main.js:1768`; `opening` flag suppresses the push in `src/main.js:1722`).

### Inter-plugin surface
`app.plugins.plugins["yazi-explorer"]` exposes `views()`, `bookmarks()`, `frecencyRanked()`, `t()`; none are documented as stable.

### Error Codes
No coded errors. Failures surface as `Notice` text (translated) and `console.error("[yazi-explorer] …")`; preview render failure keeps plain text and prints a banner (`src/main.js:4716` failure path).

### Versioning Strategy
`manifest.json` `version` ↔ git tag without `v`; `versions.json` maps plugin version → `minAppVersion` (1.4.0). Release assets `main.js`, `manifest.json`, `styles.css` built by `.github/workflows/release.yml` on tag push (runs `npm ci`, `npm test`, `npm run build`).

---

## Non-Functional Requirements

| Category | Target | Measurement | How Achieved |
|---|---|---|---|
| Performance | Cursor moves stay instant while holding `j`; preview never blocks navigation | Manual; `searchCost` timing in modal | Preview debounced by `PREVIEW_RENDER_DELAY` with token cancellation; preview text capped at `PREVIEW_MAX_CHARS`/`PREVIEW_MAX_LINES` (`src/main.js:122`); search re-run throttled when the last run exceeded its budget; relation groups cached per file (`src/main.js:2202`) |
| Security | Browsing executes nothing from the vault; no shell injection via file names | `tests/preview-sanitize-test.js`, `tests/openers-test.js` | `stripPluginNoise` + `stripForRender` before `MarkdownRenderer` (`src/main.js:5145`, `4941`); openers spawn with argv arrays (`src/main.js:2919`); no network, no `eval`, no `innerHTML` |
| Compatibility | Desktop + mobile, Obsidian ≥ 1.4.0 | Manifest `isDesktopOnly: false` | `Platform.isDesktopApp` guards around `electron`/`child_process`; legacy `renderMarkdown` fallback |
| Robustness | A broken panel or missing helper must not blank the preview | `tests/fmpanel-test.js`, `tests/undefined-calls-test.js` | try/catch around the frontmatter panel; static scan for undefined function calls in `src/` |
| Localisation | Every user-visible string has an English fallback at the call site; zh-TW may be partial | `tests/i18n-test.js` (keys used in `main.js` and `settings/tab.js` exist in `en.js`; placeholder parity) | `createTranslator` falls back per key (`src/i18n/index.js:36`) |

---

## Technology Choices

| Concern | Choice | Alternatives | Rationale |
|---|---|---|---|
| Key capture | `window` `keydown` in capture phase, `stopPropagation` on handled keys (`src/main.js:3302`) | Obsidian `Scope` | Several popular plugins register document-level handlers that fire before a modal's `Scope`; capture on `window` runs first |
| Rendering | DOM API (`createDiv/createSpan`), no `innerHTML` | Templates / innerHTML | Descriptions contain `<Space>`; search needles are user input (`hilite`, `src/main.js:4445` region) |
| Preview | `MarkdownRenderer` on sanitised text | Raw text only / iframe | Tables and headings are why the preview exists; sanitising keeps `dataviewjs`/`meta-bind` from running |
| Module split | One CJS `main.js` + pure `core/*` modules, esbuild bundle | Full TS/ESM refactor | Core logic testable in Node without Obsidian; `tests/_probe.js:32` appends a `__test` export to the built file so internals need no production exports |
| Persistence | Single `data.json` via `loadData/saveData` | Separate files per concern | One writer avoids settings and bookmarks overwriting each other (`src/main.js:5491` comment) |
| Key customisation | `map`/`unmap` aliasing only (`src/core/keymap.js:68`) | Full per-action rebinding | Keys form an interlocking set (`d/u` half-page ⇒ `D` delete); aliasing keeps the input layer intact |

---

## Integration Points

| Touchpoint | Type | Contract | Backwards Compat |
|---|---|---|---|
| Obsidian commands | Command palette / hotkeys / leader-key plugins | Ids listed above; each opens the modal with `initialView` | Ids are stable since 0.1.0 |
| `metadataCache` | Read | `getFileCache` (frontmatter, headings, tags), `resolvedLinks`, `getFirstLinkpathDest` | Obsidian public API |
| `app.fileManager` / `vault` | Write (file ops only) | `renameFile`, `create`, `createFolder`, trash; never edits note content | — |
| vim-ime-switch (user's other plugin) | DOM | Its `inputSelector` targets `.yazi-input` to restore the IME in the search box | Class name must stay |
| Task system in the user's vault | Read | `parent` / `related` / `blocks` wikilinks in task frontmatter feed the relation groups | Reverse groups are derived, so the vault stores one direction only |

### Rollout Strategy
Dev: `npm run dev` + `.env.local` `VAULT_PLUGIN_DIR` copies the build into a vault. Release: tag `X.Y.Z` → CI builds and attaches assets. Distribution today via BRAT / manual install; community listing pending submission at community.obsidian.md. No feature flags; behaviour changes ship with a version bump.

---

## Codebase Patterns to Follow

| Pattern | Where to Find | Why Follow |
|---|---|---|
| Push a layer *before* mutating state, then `openList(view, {skipPush: true})` | `src/main.js:2083`, `src/main.js:2485` | The snapshot must capture the place you are leaving, not the one you are entering |
| Every `t()` call carries an English fallback | `src/i18n/index.js:36` and all call sites | Catalogue drift never shows a bare key in the UI |
| Pure logic in `core/*.js` with a unit test beside it | `src/core/relations.js:68` ↔ `tests/relations-unit-test.js` | Testable without Obsidian; `main.js` only wires |
| Settings sections are arrays of rule objects edited by `RuleCard` | `src/settings/tab.js:34`, `src/settings/tab.js:808` | One card component for openers, decorations, facets, relations, views |
| Async preview guarded by `previewToken` and a `Component` per render | `src/main.js:4782`, `src/main.js:4716` | Cursor may move before a read/render completes; renderer post-processors must be unloaded |
| One class per new list view: `collect*()` + branch in `buildListRaw` + legend + `activateListItem` | `src/main.js:2173`, `src/main.js:2436` | Every list gets `j/k`, `/`, layer stack and preview for free |
| A list that can lose rows is one row in `LIST_REMOVE` (`remove`, `confirmOne`, `label`, message keys) — never a branch in `removeListItem()` | `src/main.js:205`, `src/main.js:2597` | Single and batch removal then share one path; presence in the table is also what makes a list multi-selectable, so the two can't drift |
| Anything that stacks on the screen is one row in `OVERLAYS` (`open`, `close`, `ephemeral`/`leaves`) — never a new branch in `escapeBack()` | `src/main.js:149` | Every new flag used to mean a new Esc bug; a missed row now costs one extra Esc, not a wrong destination |

---

## Risks & Trade-offs

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `AUTO_TAG_PREFIXES = ["work/"]` is vault-specific in shipped code (`src/main.js:184`) | H | L | Move to settings before community review |
| Editing `data.json` externally while Obsidian runs is overwritten by the in-memory copy on the next save | M | H | Documented; settings tab import/export is the supported path |
| `electron.shell` / `child_process` are outside the public Obsidian API | M | M | Lazy `require`, desktop-only guards, argv-only spawn; disclosed to reviewers |
| Capture-phase `window` listener can swallow keys other plugins expect | L | M | Only handled keys are stopped; listener removed in `onClose` |
| Full-text index grows with the vault (13.5 MB observed) | M | L | `index` settings cap size; clear button in settings |
| Relation inverse derivation scans every markdown file per rule | M | L | Cached per file per modal (`src/main.js:2202`); scan is metadata-only |

---

## Decisions Log

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Back/dismiss/close | One layer stack; `h` pops, `Esc` dismisses state then pops then closes, `q` closes | Per-view `from` fields | Three ad-hoc mechanisms produced "Esc goes to the wrong place" on every new transition |
| Esc dismissal order | Table-driven: `OVERLAYS` rows in inner→outer order, checked by `open()` | Hand-written if-ladder over mode/flag fields | The ladder had to know every flag; each feature that added one forgot a branch (stale suggestion panel after Enter, results Esc landing in the composer) |
| Search results → `Esc` | Leave the search (pop / close); `i`/`Tab` reopen the card, `Backspace` drops conditions | Reopen the card; pop one condition per Esc | `,gt` → type → Enter → Esc must leave; a card nobody asked for is a wrong destination |
| `h` after jumping into a folder from a list | At the landing folder (and at vault root with layers) `h` pops back to the list; deeper it steps up a folder | Always parent folder | Where you came from is the list, not the vault root |
| Search results → `Esc` | Reopen the composer with conditions kept; `Backspace` removes conditions | Pop one facet per Esc | Two keys doing the same thing made leaving a 3-facet search take 4 presses |
| Relations | Walked like folders: `l` enters, `h` back, `o` opens; untyped links folded; reverse derived | Enter jumps to file view; store both directions | Consistency with the miller model; stored inverses drift |
| Saved views | Store conditions, not results; created only from a real search | Editor in settings | Candidate values come from the vault with counts; a form would be guessing |
| Bookmarks | Named on creation (default = file name); `R` renames | Path only | Diary/task file names are dates or ids, not what you recognise |
| Confirm before a list removal | Ask when the row is user-curated (bookmarks, views) **or** whenever more than one row goes at once — tabs included | Mirror the single-row rule (tabs never ask) | Closing 12 tabs is not 12× closing one, and `X` only restores the last one |
| List selection vs file selection | Separate sets, cleared on view change | One set keyed by path | Tabs have no unique path, and "3 bookmarks selected" must not become "3 files selected" after `h` |
| Keys | Fixed set + `map`/`unmap` aliasing | Full rebinding UI | Interlocking mnemonics; aliasing covers "I want my own key" |
| `gf` matching | Path + frontmatter `aliases` | Path only | Date-named notes are unfindable by the name you think in |

---

## Open Questions

- [ ] Promote `AUTO_TAG_PREFIXES` (`src/main.js:184`) to a setting; it is the last vault-specific literal in shipped code.
- [ ] `schemaVersion` exists but no migrator consumes it — decide the first real migration path before 1.0.
- [ ] Show the relation summary strip in the file view preview as well (currently relations view only).
- [ ] Allow re-folding an expanded untyped group (currently per-centre expansion persists for the modal's lifetime).
- [ ] Community plugin submission (community.obsidian.md) — README already uses absolute image URLs for the in-app detail page.
