'use strict';

Toolbox.register({
  id: 'diff',
  name: 'Diff Checker',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/><path d="M5.5 9h2M5.5 13h2M16.5 9h2M17.5 12v2M16.5 13h2"/></svg>',

  mount(root, monaco) {
    const { h, toast, languageForFile } = Toolbox;
    const sides = {
      left: { model: monaco.editor.createModel('', 'plaintext'), file: null },
      right: { model: monaco.editor.createModel('', 'plaintext'), file: null },
    };
    let languageMode = 'auto';

    // ----- Toolbar -----
    const languages = monaco.languages.getLanguages()
      .map((l) => ({ id: l.id, name: (l.aliases && l.aliases[0]) || l.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const langSelect = h('select', { title: 'Syntax highlighting language' },
      h('option', { value: 'auto' }, 'Auto-detect'),
      languages.map((l) => h('option', { value: l.id }, l.name)));
    const viewSelect = h('select', { title: 'Layout' },
      h('option', { value: 'split' }, 'Side by side'),
      h('option', { value: 'inline' }, 'Inline'));
    const wsCheck = h('input', { type: 'checkbox' });
    const wrapCheck = h('input', { type: 'checkbox' });
    const collapseCheck = h('input', { type: 'checkbox' });
    const stats = h('span.diff-stats.muted', {}, 'Open or paste two texts to compare');

    const toolbar = h('div.toolbar', {},
      h('label.field', {}, 'Language', langSelect),
      viewSelect,
      h('label.check', { title: 'Ignore leading/trailing whitespace' }, wsCheck, 'Ignore whitespace'),
      h('label.check', {}, wrapCheck, 'Word wrap'),
      h('label.check', { title: 'Hide unchanged regions' }, collapseCheck, 'Only changes'),
      h('span.sep'),
      h('button', { title: 'Previous change (Shift+F7)', onclick: () => go('previous') }, '↑ Prev'),
      h('button', { title: 'Next change (F7)', onclick: () => go('next') }, '↓ Next'),
      h('button', { title: 'Swap left and right', onclick: swap }, '⇄ Swap'),
      h('button', { title: 'Clear both sides', onclick: clear }, 'Clear'),
      h('span.grow'),
      stats);

    const fileBar = (side, label) => {
      const pathEl = h('span.path.muted', {}, 'Paste text or drop a file');
      const encEl = h('span.badge', { hidden: true });
      sides[side].pathEl = pathEl;
      sides[side].encEl = encEl;
      return h('div.diff-file', {},
        h('button', { onclick: () => pick(side) }, `Open ${label}…`),
        pathEl, encEl);
    };
    const files = h('div.diff-files', {}, fileBar('left', 'original'), fileBar('right', 'modified'));

    // ----- Editor -----
    const host = h('div.editor-host');
    const zoneLeft = h('div.drop-zone', {}, 'Drop here → original (left)');
    const zoneRight = h('div.drop-zone', {}, 'Drop here → modified (right)');
    const overlay = h('div.drop-overlay', { hidden: true }, zoneLeft, zoneRight);
    const wrap = h('div.editor-wrap', {}, host, overlay);
    root.append(toolbar, files, wrap);

    const editor = monaco.editor.createDiffEditor(host, {
      automaticLayout: true,
      originalEditable: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
      ignoreTrimWhitespace: false,
      renderIndicators: true,
      diffAlgorithm: 'advanced',
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      scrollBeyondLastLine: false,
      minimap: { enabled: true },
      hideUnchangedRegions: { enabled: false },
    });
    editor.setModel({ original: sides.left.model, modified: sides.right.model });
    editor.onDidUpdateDiff(updateStats);

    langSelect.addEventListener('change', () => {
      languageMode = langSelect.value;
      applyLanguage();
    });
    viewSelect.addEventListener('change', () => editor.updateOptions({ renderSideBySide: viewSelect.value === 'split' }));
    wsCheck.addEventListener('change', () => editor.updateOptions({ ignoreTrimWhitespace: wsCheck.checked }));
    wrapCheck.addEventListener('change', () => editor.updateOptions({ wordWrap: wrapCheck.checked ? 'on' : 'off' }));
    collapseCheck.addEventListener('change', () => editor.updateOptions({ hideUnchangedRegions: { enabled: collapseCheck.checked } }));

    // ----- Behaviour -----
    function applyLanguage() {
      let lang = languageMode;
      if (lang === 'auto') {
        const name = sides.right.file?.name || sides.left.file?.name;
        lang = languageForFile(name);
      }
      monaco.editor.setModelLanguage(sides.left.model, lang);
      monaco.editor.setModelLanguage(sides.right.model, lang);
    }

    async function load(side, filePath) {
      try {
        const file = await window.api.readTextFile(filePath);
        const s = sides[side];
        s.file = file;
        s.model.setValue(file.text);
        s.pathEl.textContent = file.path;
        s.pathEl.title = file.path;
        s.pathEl.classList.remove('muted');
        s.encEl.hidden = false;
        s.encEl.textContent = file.encoding.toUpperCase() + (file.bom ? ' + BOM' : '') + (file.mixed ? ' (mixed!)' : '');
        s.encEl.className = file.mixed ? 'badge warn' : 'badge';
        applyLanguage();
      } catch (err) {
        toast(`Could not open ${filePath}: ${cleanError(err)}`, 'error');
      }
    }

    async function pick(side) {
      const [p] = await window.api.openFile({ title: side === 'left' ? 'Open original file' : 'Open modified file' });
      if (p) load(side, p);
    }

    function swap() {
      const l = sides.left, r = sides.right;
      const lv = l.model.getValue(), rv = r.model.getValue();
      [l.file, r.file] = [r.file, l.file];
      l.model.setValue(rv);
      r.model.setValue(lv);
      for (const s of [l, r]) refreshFileBar(s);
    }

    function clear() {
      for (const s of Object.values(sides)) {
        s.file = null;
        s.model.setValue('');
        refreshFileBar(s);
      }
      applyLanguage();
    }

    function refreshFileBar(s) {
      s.pathEl.textContent = s.file ? s.file.path : 'Paste text or drop a file';
      s.pathEl.title = s.file ? s.file.path : '';
      s.pathEl.classList.toggle('muted', !s.file);
      s.encEl.hidden = !s.file;
      if (s.file) s.encEl.textContent = s.file.encoding.toUpperCase() + (s.file.bom ? ' + BOM' : '');
    }

    function go(direction) {
      if (typeof editor.goToDiff === 'function') {
        editor.goToDiff(direction);
        return;
      }
      const changes = editor.getLineChanges() || [];
      if (!changes.length) return;
      const mod = editor.getModifiedEditor();
      const line = mod.getPosition()?.lineNumber ?? 0;
      const starts = changes.map((c) => Math.max(1, c.modifiedStartLineNumber));
      const target = direction === 'next'
        ? starts.find((s) => s > line) ?? starts[0]
        : [...starts].reverse().find((s) => s < line) ?? starts[starts.length - 1];
      mod.setPosition({ lineNumber: target, column: 1 });
      mod.revealLineInCenter(target);
      mod.focus();
    }

    function updateStats() {
      const changes = editor.getLineChanges() || [];
      const leftText = sides.left.model.getValueLength();
      const rightText = sides.right.model.getValueLength();
      stats.replaceChildren();
      if (!leftText && !rightText) {
        stats.textContent = 'Open or paste two texts to compare';
        return;
      }
      if (!changes.length) {
        stats.append(h('span.badge.ok', {}, '✓ Identical'));
        return;
      }
      let added = 0, removed = 0;
      for (const c of changes) {
        if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
        if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
      }
      stats.append(
        h('span', {}, `${changes.length} change${changes.length === 1 ? '' : 's'}`),
        h('span.add', {}, `+${added}`),
        h('span.del', {}, `−${removed}`));
    }

    // ----- Drag & drop -----
    let dragDepth = 0;
    wrap.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragDepth++;
      overlay.hidden = false;
    });
    wrap.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; }
    });
    wrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      const leftHalf = e.clientX < wrap.getBoundingClientRect().left + wrap.clientWidth / 2;
      zoneLeft.classList.toggle('hot', leftHalf);
      zoneRight.classList.toggle('hot', !leftHalf);
    });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      overlay.hidden = true;
      const dropped = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
      if (dropped.length >= 2) {
        load('left', dropped[0]);
        load('right', dropped[1]);
      } else if (dropped.length === 1) {
        const leftHalf = e.clientX < wrap.getBoundingClientRect().left + wrap.clientWidth / 2;
        load(leftHalf ? 'left' : 'right', dropped[0]);
      }
    });

    this.openPaths = ([left, right]) => Promise.all([left && load('left', left), right && load('right', right)]);
    updateStats();
  },
});

function cleanError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
