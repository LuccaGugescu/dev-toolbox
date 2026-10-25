'use strict';

Toolbox.register({
  id: 'encoding',
  name: 'Encoding Checker',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h10v2M9 5v12M7 17h4"/><circle cx="17.5" cy="15.5" r="4"/><path d="M17.5 13.5v2.2M17.5 17.4v.1"/></svg>',

  mount(root, monaco) {
    const { h, toast, languageForFile } = Toolbox;
    const MAX_ROWS = 3000;
    const MAX_DECORATIONS = 10000;

    const state = {
      roots: [],       // paths the user opened (files or folders)
      files: [],       // per-file summaries from the main process
      current: null,   // detailed scan of the selected file
      filter: null,    // category filter for the issue list
      onlyProblems: true,
    };

    // ----- Toolbar -----
    const sourceSelect = h('select', { title: 'How the file is actually encoded on disk' },
      h('option', { value: 'auto' }, 'Auto-detect'),
      h('option', { value: 'utf-8' }, 'UTF-8'),
      h('option', { value: 'iso-8859-1' }, 'ISO-8859-1'),
      h('option', { value: 'windows-1252' }, 'Windows-1252'));
    const targetSelect = h('select', { title: 'Encoding the Java runtime uses to read the file (file.encoding / -Dfile.encoding / Properties.load)' },
      h('option', { value: 'iso-8859-1' }, 'ISO-8859-1'),
      h('option', { value: 'utf-8' }, 'UTF-8'));
    const extInput = h('input', {
      type: 'text',
      size: 34,
      value: 'java properties xml jsp jspf html htm txt sql csv json yml yaml js ts kt groovy gradle md',
      title: 'Extensions included when scanning a folder (* = all)',
    });
    const status = h('span.muted');

    root.append(h('div.toolbar', {},
      h('button.primary', { onclick: openFiles }, 'Open files…'),
      h('button', { onclick: openFolder }, 'Open folder…'),
      h('span.sep'),
      h('label.field', {}, 'File is', sourceSelect),
      h('label.field', {}, 'Java reads it as', targetSelect),
      h('label.field', {}, 'Extensions', extInput),
      h('button', { onclick: rescan, title: 'Scan again' }, 'Rescan'),
      h('span.grow'),
      status));

    // ----- Left: file list -----
    const onlyCheck = h('input', { type: 'checkbox', checked: true });
    const fileCount = h('span.muted');
    const fileList = h('div.enc-file-list');
    const filesPane = h('div.enc-files', {},
      h('div.enc-files-head', {}, h('label.check', {}, onlyCheck, 'Only files with problems'), h('span.grow'), fileCount),
      fileList);
    onlyCheck.addEventListener('change', () => { state.onlyProblems = onlyCheck.checked; renderFileList(); });

    // ----- Right: detail -----
    const titleEl = h('span.title');
    const detailMeta = h('span.meta');
    const exportMode = h('select', { title: 'Output encoding for the converted copy' },
      h('option', { value: 'utf-8' }, 'UTF-8 (no BOM)'),
      h('option', { value: 'iso-8859-1' }, 'ISO-8859-1 (others → \\uXXXX)'),
      h('option', { value: 'ascii-escape' }, 'ASCII, all non-ASCII → \\uXXXX'));
    const repairCheck = h('input', { type: 'checkbox', checked: true });
    const cleanCheck = h('input', { type: 'checkbox' });
    const exportBtn = h('button', { onclick: exportCurrent }, 'Save converted copy…');
    const head = h('div.enc-detail-head', {},
      titleEl, detailMeta, h('span.grow'),
      exportMode,
      h('label.check', { title: 'Turn "Ã©" back into "é"' }, repairCheck, 'Repair double-encoding'),
      h('label.check', { title: 'Replace NBSP, zero-width chars, BOMs, bidi controls' }, cleanCheck, 'Clean invisible chars'),
      exportBtn);

    const viewerHost = h('div.editor-host');
    const viewer = h('div.enc-viewer', {}, viewerHost);
    const chips = h('div.enc-chips');
    const issueList = h('div.enc-issue-list');
    const issuesPane = h('div.enc-issues', {}, chips, issueList);
    const detail = h('div.enc-detail', { hidden: true }, head, viewer, issuesPane);

    const empty = h('div.empty', {},
      h('h2', {}, 'Find characters that break between UTF-8 and ISO-8859-1'),
      h('div', {}, 'Open files or a whole folder, or drop them here.'),
      h('ul', {},
        h('li', {}, 'UTF-8 file read as ISO-8859-1: every accent turns into "Ã©", €/“”/… do not exist at all'),
        h('li', {}, 'ISO-8859-1 / Windows-1252 file read as UTF-8: accents become "�"'),
        h('li', {}, 'BOMs, double-encoded text, invisible spaces, bidi controls, already-lost "�"')));
    const rightPane = h('div', { style: 'display:flex;flex-direction:column;min-width:0;min-height:0' }, empty, detail);
    const body = h('div.enc-body', {}, filesPane, rightPane);
    root.append(body);

    const editor = monaco.editor.create(viewerHost, {
      readOnly: true,
      automaticLayout: true,
      glyphMargin: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderControlCharacters: true,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
      minimap: { enabled: true },
    });
    const model = monaco.editor.createModel('', 'plaintext');
    editor.setModel(model);
    const decorations = editor.createDecorationsCollection();

    sourceSelect.addEventListener('change', rescan);
    targetSelect.addEventListener('change', rescan);
    window.api.onScanProgress(({ scanned }) => { status.textContent = `Scanning… ${scanned} files`; });

    // ----- Actions -----
    async function openFiles() {
      const paths = await window.api.openFile({ title: 'Choose files to check', multi: true });
      if (paths.length) scanPaths(paths);
    }

    async function openFolder() {
      const dir = await window.api.openFolder();
      if (dir) scanPaths([dir]);
    }

    function rescan() {
      if (state.roots.length) scanPaths(state.roots, state.current?.path);
    }

    async function scanPaths(paths, keepSelected) {
      state.roots = paths;
      status.textContent = 'Scanning…';
      const t0 = performance.now();
      try {
        state.files = await window.api.scanPaths({ paths, extensions: extInput.value, source: sourceSelect.value, target: targetSelect.value });
      } catch (err) {
        toast(cleanError(err), 'error');
        status.textContent = '';
        return;
      }
      state.files.sort((a, b) => (b.counts?.error ?? -1) - (a.counts?.error ?? -1) || (b.totalIssues ?? -1) - (a.totalIssues ?? -1) || a.relative.localeCompare(b.relative));
      const scanned = state.files.filter((f) => !f.skipped);
      const bad = scanned.filter((f) => f.totalIssues > 0);
      const issues = bad.reduce((n, f) => n + f.totalIssues, 0);
      status.textContent = `${scanned.length} files · ${bad.length} with problems · ${issues.toLocaleString()} issues · ${Math.round(performance.now() - t0)} ms`;
      renderFileList();
      const toOpen = (keepSelected && state.files.find((f) => f.path === keepSelected)) || bad[0] || scanned[0];
      if (toOpen) selectFile(toOpen.path);
      else showEmpty();
    }

    function showEmpty() {
      state.current = null;
      detail.hidden = true;
      empty.hidden = false;
    }

    function renderFileList() {
      const visibleFiles = state.files.filter((f) => !state.onlyProblems || f.totalIssues > 0);
      fileCount.textContent = `${visibleFiles.length} / ${state.files.length}`;
      fileList.replaceChildren(...visibleFiles.slice(0, MAX_ROWS).map((f) => {
        const meta = h('div.meta', {});
        if (f.skipped) {
          meta.append(h('span.badge', {}, `skipped: ${f.skipped}`));
        } else {
          meta.append(h('span.badge', {}, encLabel(f)));
          if (f.counts.error) meta.append(h('span.badge.err', {}, `${f.counts.error.toLocaleString()} errors`));
          if (f.counts.warning) meta.append(h('span.badge.warn', {}, `${f.counts.warning.toLocaleString()} warnings`));
          if (!f.totalIssues) meta.append(h('span.badge.ok', {}, '✓ clean'));
        }
        const row = h('div.enc-file', { title: f.path, dataset: { path: f.path }, onclick: () => !f.skipped && selectFile(f.path) },
          h('span.name', {}, '‎' + f.relative), meta);
        if (state.current?.path === f.path) row.classList.add('active');
        return row;
      }));
      if (visibleFiles.length > MAX_ROWS) fileList.append(h('div.enc-file.muted', {}, `…and ${visibleFiles.length - MAX_ROWS} more`));
      if (state.files.length && !visibleFiles.length) fileList.append(h('div.empty', {}, h('h2', {}, '✓ No problems found'), 'Untick the filter above to see all files.'));
    }

    async function selectFile(filePath) {
      let r;
      try {
        r = await window.api.scanFile({ path: filePath, source: sourceSelect.value, target: targetSelect.value });
      } catch (err) {
        toast(cleanError(err), 'error');
        return;
      }
      state.current = r;
      state.filter = null;
      for (const row of fileList.children) row.classList.toggle('active', row.dataset.path === filePath);
      empty.hidden = true;
      detail.hidden = false;

      titleEl.textContent = r.name;
      titleEl.title = r.path;
      detailMeta.replaceChildren(
        h('span.badge', {}, `on disk: ${encLabel({ encoding: r.detected.encoding, bom: r.detected.bom, mixed: r.detected.mixed })}`),
        h('span.badge', {}, `read as ${r.target.toUpperCase()}`),
        h('span.badge', {}, `${r.lines.toLocaleString()} lines · ${r.nonAscii.toLocaleString()} non-ASCII`));
      exportMode.value = r.target === 'iso-8859-1' ? 'iso-8859-1' : 'utf-8';

      model.setValue(r.text);
      monaco.editor.setModelLanguage(model, languageForFile(r.name));
      decorations.set(r.issues.slice(0, MAX_DECORATIONS).map((i) => ({
        range: i.length
          ? new monaco.Range(i.line, i.column, i.line, i.column + i.length)
          : new monaco.Range(i.line, 1, i.line, 1),
        options: {
          inlineClassName: i.length ? `enc-mark-${i.severity}` : undefined,
          glyphMarginClassName: `enc-glyph-${i.severity}`,
          hoverMessage: { value: `**${r.categories[i.category].label}** — ${escapeMd(i.message)}\n\nFix: \`${i.suggestion}\`` },
          glyphMarginHoverMessage: { value: escapeMd(i.message) },
          overviewRuler: { color: i.severity === 'error' ? '#f85149' : '#d29922', position: monaco.editor.OverviewRulerLane.Right },
          minimap: { color: i.severity === 'error' ? '#f85149' : '#d29922', position: monaco.editor.MinimapPosition.Inline },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })));
      editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
      renderChips();
      renderIssues();
    }

    function renderChips() {
      const r = state.current;
      const entries = Object.entries(r.byCategory).sort((a, b) =>
        (r.categories[a[0]].severity === 'error' ? 0 : 1) - (r.categories[b[0]].severity === 'error' ? 0 : 1) || b[1] - a[1]);
      if (!entries.length) {
        chips.replaceChildren(h('span.badge.ok', {}, `✓ Nothing breaks when this file is read as ${r.target.toUpperCase()}`));
        return;
      }
      const chip = (key, label, n, sev) => {
        const btn = h(`button.chip.${sev === 'error' ? 'err' : 'warn'}`, {
          onclick: () => { state.filter = state.filter === key ? null : key; renderChips(); renderIssues(); },
        }, `${label} `, h('span.n', {}, n.toLocaleString()));
        if (state.filter === key) btn.classList.add('on');
        return btn;
      };
      chips.replaceChildren(
        h(`button.chip${state.filter ? '' : '.on'}`, { onclick: () => { state.filter = null; renderChips(); renderIssues(); } }, `All ${r.totalIssues.toLocaleString()}`),
        ...entries.map(([key, n]) => chip(key, r.categories[key].label, n, r.categories[key].severity)));
      if (r.truncated) chips.append(h('span.muted', {}, `(details for first ${r.issues.length.toLocaleString()})`));
    }

    function renderIssues() {
      const r = state.current;
      const list = state.filter ? r.issues.filter((i) => i.category === state.filter) : r.issues;
      issueList.replaceChildren(...list.slice(0, MAX_ROWS).map((i) => h('div.issue', { onclick: () => reveal(i) },
        h('span', {}, h('span', { class: `dot ${i.severity}` })),
        h('span.pos', {}, `${i.line}:${i.column}`),
        h('span.ch', {}, showChar(i.char), h('small', {}, i.codePoint || i.bytes)),
        h('div.msg', {},
          h('div', {}, i.message),
          i.suggestion ? h('div.fix', {}, i.suggestion) : null))));
      if (list.length > MAX_ROWS) issueList.append(h('div.issue.muted', {}, h('span'), h('span'), h('span'), h('span', {}, `…${(list.length - MAX_ROWS).toLocaleString()} more. Filter by category above.`)));
    }

    function reveal(i) {
      const range = new monaco.Range(i.line, i.column, i.line, i.column + Math.max(i.length, 1));
      editor.setSelection(range);
      editor.revealRangeInCenter(range);
      editor.focus();
    }

    async function exportCurrent() {
      const r = state.current;
      if (!r) return;
      try {
        const saved = await window.api.exportConverted({
          path: r.path,
          source: sourceSelect.value,
          mode: exportMode.value,
          repairDouble: repairCheck.checked,
          cleanInvisible: cleanCheck.checked,
        });
        if (saved) toast(`Saved ${saved}`);
      } catch (err) {
        toast(cleanError(err), 'error');
      }
    }

    this.openPaths = (paths) => scanPaths(paths);

    // ----- Drag & drop files or folders -----
    body.addEventListener('dragover', (e) => e.preventDefault());
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
      if (paths.length) scanPaths(paths);
    });
  },
});

function encLabel(f) {
  return f.encoding.toUpperCase() + (f.bom ? ' + BOM' : '') + (f.mixed ? ' (mixed)' : '');
}

function showChar(ch) {
  if (!ch) return '—';
  return Array.from(ch, (c) => {
    const cp = c.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return '␀';
    if ([0x00a0, 0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x2060, 0xfeff].includes(cp) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return '·';
    return c;
  }).join('');
}

function escapeMd(s) {
  return String(s).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function cleanError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
