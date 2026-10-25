'use strict';

(() => {
  const MAX_MATCHES = 5000;
  const JAVA_FLAGS = { i: 'Pattern.CASE_INSENSITIVE', m: 'Pattern.MULTILINE', s: 'Pattern.DOTALL', u: 'Pattern.UNICODE_CASE' };

  const javaString = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
  // Java uses ${name} for named groups in replacements; JS uses $<name>.
  const javaReplacement = (r) => r.replace(/\$<([A-Za-z][A-Za-z0-9]*)>/g, '${$1}');

  /** Capturing-group number -> name (undefined for unnamed groups), from the pattern source. */
  function groupNames(src) {
    const names = [undefined];
    let inClass = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (inClass) { if (c === ']') inClass = false; continue; }
      if (c === '[') { inClass = true; continue; }
      if (c !== '(') continue;
      if (src[i + 1] !== '?') { names.push(undefined); continue; }
      const named = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(src.slice(i));
      if (named) names.push(named[1]);
    }
    return names;
  }

  Toolbox.register({
    id: 'regex',
    name: 'Regex Tester',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 3v10M12.7 5.5l8.6 5M12.7 10.5l8.6-5"/><rect x="3" y="15" width="6" height="6" rx="1"/></svg>',

    mount(root, monaco) {
      const { h, copy, debounce, createEditor, pane } = Toolbox;

      const pattern = h('input.code', { type: 'text', placeholder: 'Pattern, e.g. (?<user>[\\w.]+)@(?<domain>[\\w.]+)', spellcheck: 'false' });
      const flagBoxes = Object.fromEntries(['i', 'm', 's', 'u'].map((f) => [f, h('input', { type: 'checkbox' })]));
      const flagTitles = { i: 'Ignore case', m: 'Multiline (^ $ per line)', s: 'Dot matches newline', u: 'Unicode' };
      const status = h('span.status.muted');
      root.append(h('div.toolbar', {},
        h('div.regex-bar', {}, h('span.slash', {}, '/'), pattern, h('span.slash', {}, '/g')),
        Object.entries(flagBoxes).map(([f, box]) => h('label.check', { title: flagTitles[f] }, box, f)),
        status));

      const left = pane('Test text', [], h('div.pane-body.editor'));
      const matchList = h('div');
      const replaceInput = h('input.code', { type: 'text', placeholder: 'Replacement: $1, $<name>, $&', spellcheck: 'false' });
      const replaceOut = h('pre.code', { style: 'max-height:200px;overflow:auto;margin-top:6px' });
      const javaOut = h('pre.code');
      const right = pane('Matches');
      right.body.append(
        h('div.section', {}, h('h3', {}, 'Replace'), replaceInput, replaceOut),
        h('div.section', {}, h('h3', {}, 'Java', h('span.grow'), h('button', { onclick: () => copy(javaOut.textContent), style: 'height:22px;font-size:11px' }, 'Copy')), javaOut,
          h('div.muted', { style: 'margin-top:6px;font-size:12px' }, 'Tested with the JavaScript engine. Same syntax as java.util.regex for classes, groups, lookarounds and named groups; Java-only features (possessive quantifiers a*+, atomic groups (?>…), \\A \\Z) are not supported here.')),
        h('div.section', { style: 'padding:10px 0 0' }, h('h3', { style: 'padding:0 12px' }, 'Match list'), matchList));
      root.append(h('div.split', {}, left.el, right.el));

      const model = monaco.editor.createModel('Contact: alice.smith@example.com, bob@test.org\nInvalid: carol@\nSupport: support@company.io\n', 'plaintext');
      const editor = createEditor(left.body, { model, wordWrap: 'on', renderWhitespace: 'boundary' });
      const decorations = editor.createDecorationsCollection();
      pattern.value = '(?<user>[\\w.]+)@(?<domain>[\\w-]+\\.[\\w.]+)';

      function run() {
        const flags = Object.entries(flagBoxes).filter(([, b]) => b.checked).map(([f]) => f).join('');
        const text = model.getValue();
        matchList.replaceChildren();
        replaceOut.textContent = '';
        renderJava(flags);
        if (!pattern.value) {
          decorations.clear();
          setStatus('Type a pattern', 'muted');
          return;
        }
        let re;
        try {
          re = new RegExp(pattern.value, `${flags}gd`);
        } catch (err) {
          decorations.clear();
          setStatus(`✗ ${err.message.replace(/^Invalid regular expression: /, '')}`, 'err');
          return;
        }
        const matches = [];
        for (const m of text.matchAll(re)) {
          matches.push(m);
          if (matches.length >= MAX_MATCHES) break;
        }
        decorations.set(matches.map((m, i) => {
          const start = model.getPositionAt(m.index);
          const end = model.getPositionAt(m.index + m[0].length);
          return {
            range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
            options: { inlineClassName: `regex-m${i % 2}`, hoverMessage: { value: `Match ${i + 1}` } },
          };
        }));
        const names = groupNames(pattern.value);
        matchList.replaceChildren(...matches.slice(0, 500).map((m, i) => {
          const groupLines = [];
          for (let g = 1; g < m.length; g++) {
            groupLines.push(h('span.grp', {}, `${g}${names[g] ? ` <${names[g]}>` : ''}: ${m[g] === undefined ? '(no match)' : JSON.stringify(m[g])}`));
          }
          return h('div.match-row', { onclick: () => reveal(m) },
            h('span.idx', {}, `#${i + 1} @${m.index}`), JSON.stringify(m[0]), groupLines);
        }));
        if (matches.length > 500) matchList.append(h('div.match-row.muted', {}, `…${matches.length - 500} more`));
        setStatus(matches.length ? `${matches.length >= MAX_MATCHES ? '≥' : ''}${matches.length} match${matches.length === 1 ? '' : 'es'}` : 'No match', matches.length ? 'ok' : 'warn');
        if (replaceInput.value) replaceOut.textContent = text.replace(re, replaceInput.value);
      }

      function renderJava(flags) {
        const javaFlags = [...flags].map((f) => JAVA_FLAGS[f]).filter(Boolean);
        const lines = [`Pattern p = Pattern.compile(${javaString(pattern.value)}${javaFlags.length ? `, ${javaFlags.join(' | ')}` : ''});`];
        if (replaceInput.value) lines.push(`String out = p.matcher(input).replaceAll(${javaString(javaReplacement(replaceInput.value))});`);
        else lines.push('Matcher m = p.matcher(input);', 'while (m.find()) { m.group(); }');
        javaOut.textContent = lines.join('\n');
      }

      function reveal(m) {
        const start = model.getPositionAt(m.index);
        const end = model.getPositionAt(m.index + m[0].length);
        editor.setSelection(new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column));
        editor.revealPositionInCenter(start);
        editor.focus();
      }

      function setStatus(text, kind) {
        status.textContent = text;
        status.title = text;
        status.className = `status ${kind}`;
      }

      const debounced = debounce(run, 120);
      pattern.addEventListener('input', debounced);
      replaceInput.addEventListener('input', debounced);
      model.onDidChangeContent(debounced);
      for (const box of Object.values(flagBoxes)) box.addEventListener('change', run);
      run();
    },
  });
})();
