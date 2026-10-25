# Dev Toolbox

Windows desktop app (Electron + Monaco, the VS Code editor) that hosts multiple dev tools.

## Run

```
npm install
npm start
```

`npm test` runs the encoding engine tests. `node test/make-samples.js` writes demo files to `samples/`.

## Windows installer

```
npm run dist
```

Produces `dist/DevToolbox-Setup-<version>.exe` (NSIS): per-user install by default (no admin needed),
choice of install folder, Start Menu + desktop shortcuts, uninstaller in *Apps & features*.
`npm run pack` builds only the unpacked app in `dist/win-unpacked/` (faster, for testing).

- **Path length:** NSIS cannot read files whose full path exceeds 260 characters. Build from a short
  folder such as `C:\projects\dev-toolbox`.
- **Releases:** push a tag (`git tag v0.2.0 && git push --tags`, after bumping `version` in
  `package.json`) and GitHub Actions builds the installer and attaches it to a GitHub Release.
- **Icon:** `build/icon.ico` / `build/icon.png`, regenerated with `npm run icon` (needs Python + Pillow).
- **Unsigned:** the installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC"
  the first time. Click *More info → Run anyway*. A code-signing certificate removes this.

## Tools

### Diff Checker
- Open, drag-and-drop (drop 2 files at once, or one per half) or paste text on either side.
- Syntax coloring auto-detected from the file extension (~80 languages), or pick one.
- Side-by-side / inline, ignore whitespace, word wrap, "only changes" (collapse unchanged), prev/next change (F7 / Shift+F7), swap.
- Shows each file's encoding (UTF-8 / ISO-8859-1 / Windows-1252, BOM, mixed).

### Encoding Checker
Pick files or a whole folder (recursive, `.git`/`target`/`node_modules`/... skipped), choose
**how the file is encoded** (auto-detect) and **how Java reads it** (`ISO-8859-1` or `UTF-8`).

| Problem | Example |
|---|---|
| UTF-8 char read as ISO-8859-1 | `é` → `Ã©` |
| Char that does not exist in ISO-8859-1 | `€ “ ” — … 😀` |
| ISO-8859-1 byte read as UTF-8 | `é` (byte E9) → `�` |
| Windows-1252 bytes 0x80–0x9F | `“ ” €` become invisible C1 controls in ISO-8859-1 |
| BOM | javac: `illegal character: '﻿'` |
| Double-encoded UTF-8 | `JoÃ£o` should be `João` |
| Invisible / bidi / lost chars | NBSP, zero-width space, RTL override, `U+FFFD` |

Every hit shows line:column, code point, bytes, what Java will see, and the fix (`\uXXXX` escape or ASCII
replacement). **Save converted copy…** writes a new file (never overwrites in place) as UTF-8, ISO-8859-1 with
`\uXXXX` for unmappable chars, or pure ASCII with `\uXXXX` escapes — optionally repairing double-encoding and
removing invisible chars.

## Adding a tool

Create `src/renderer/tools/<name>.js`, add a `<script>` tag in `src/renderer/index.html`:

```js
Toolbox.register({
  id: 'my-tool',
  name: 'My Tool',
  icon: '<svg ...>',
  mount(container, monaco) { /* build UI; optional: this.openPaths = (paths) => ... */ },
});
```

File system work goes in `main.js` (IPC handler) + `preload.js` (exposed on `window.api`).
