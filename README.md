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

### JSON / XML Formatter
Live format / minify with 2, 4 or tab indent, optional key sorting, error line:column marked in the editor.
Large integers (64-bit ids such as `9007199254740993`) are kept exactly instead of being rounded.

### Encode / Decode
Base64, Base64URL, URL, HTML entities, hex, Java `\uXXXX` escapes and JSON string escaping, always via UTF-8.
Binary results (not valid UTF-8) are shown as a hex dump. *Swap* feeds the output back in reversed.

### JWT Decoder
Header, payload and claims (`exp`/`iat`/`nbf` as dates with "expires in …"), expired tokens flagged.
Verifies signatures for HS256/384/512 (secret, plain or Base64), RS*, PS* and ES* (public key PEM or JWK).
Everything runs locally.

### Hash Generator
MD5, SHA-1, SHA-224, SHA-256, SHA-384, SHA-512 of text (UTF-8) or a file (streamed, any size), optional HMAC
key, hex / HEX / Base64 output, and a compare box that tells you which digest matches.

### Timestamp Converter
Paste Unix seconds, ms, µs or ns (unit detected by size), ISO-8601, SQL datetime or an HTTP date. Shows Instant,
OffsetDateTime, ZonedDateTime, SQL timestamp, RFC 1123, relative time and ISO week in any time zone.

### Regex Tester
Live match highlighting, numbered and named groups, replace preview, and ready-to-paste Java
`Pattern.compile(...)` / `replaceAll(...)` code with escaped backslashes and flags.

## Adding a tool

Create `src/renderer/tools/<name>.js`, add a `<script>` tag in `src/renderer/index.html`. Wrap the file in
`(() => { ... })();` so its top-level names don't collide with other tools. Shared helpers live on `Toolbox`
(`h`, `pane`, `createEditor`, `copy`, `copyButton`, `debounce`, `relativeTime`, `toast`).

```js
Toolbox.register({
  id: 'my-tool',
  name: 'My Tool',
  icon: '<svg ...>',
  mount(container, monaco) { /* build UI; optional: this.openPaths = (paths) => ... */ },
});
```

File system work goes in `main.js` (IPC handler) + `preload.js` (exposed on `window.api`).
