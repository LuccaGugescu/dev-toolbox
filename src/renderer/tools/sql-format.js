'use strict';

(() => {
  Toolbox.register({
    id: 'sql-format',
    name: 'SQL Formatter',
    group: 'Database',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3M20 5v4"/><path d="M4 11v6c0 1.7 3.6 3 8 3"/><path d="M15 14h6M15 18h4M15 22h6"/></svg>',

    mount(root, monaco) {
      const { h, copyButton, debounce, createEditor, pane, toast, errorMessage } = Toolbox;
      let style = 'pretty';

      const styleButtons = h('span.segmented', {},
        h('button.on', { dataset: { style: 'pretty' } }, 'Format'),
        h('button', { dataset: { style: 'minify' } }, 'One line'));
      const caseSelect = h('select', { title: 'Keyword case' },
        h('option', { value: 'upper' }, 'UPPER keywords'), h('option', { value: 'lower' }, 'lower keywords'), h('option', { value: 'keep' }, 'Keep case'));
      const indentSelect = h('select', { title: 'Indentation' },
        h('option', { value: '2' }, '2 spaces'), h('option', { value: '4' }, '4 spaces'), h('option', { value: 'tab' }, 'Tabs'));
      const status = h('span.status.muted', {}, 'Paste SQL on the left');
      root.append(h('div.toolbar', {}, styleButtons, caseSelect, indentSelect, h('span.sep'), status));

      const paramsInput = h('textarea.code.boxed', {
        rows: 4, spellcheck: 'false',
        placeholder: 'Optional: values for ?, $1, :name binds — one per line, name=value, a JSON array, or paste Hibernate "binding parameter [1] as [VARCHAR] - [abc]" log lines',
      });
      const bindInfo = h('span.muted');
      const input = pane('SQL (PostgreSQL / Oracle)', [h('button', { onclick: openFile }, 'Open file…'), h('button', { onclick: () => inModel.setValue('') }, 'Clear')], h('div.pane-body.stack'));
      const inHost = h('div', { style: 'flex:1;min-height:0;position:relative' });
      input.body.append(inHost, h('div.section', { style: 'border-top:1px solid var(--border);border-bottom:none' },
        h('h3', {}, 'Bind parameters', h('span.grow'), bindInfo), paramsInput));
      const output = pane('Formatted', [copyButton(() => outModel.getValue())], h('div.pane-body.editor'));
      root.append(h('div.split', {}, input.el, output.el));

      const inModel = monaco.editor.createModel('', 'sql');
      const outModel = monaco.editor.createModel('', 'sql');
      createEditor(inHost, { model: inModel });
      createEditor(output.body, { model: outModel, readOnly: true });

      function run() {
        let sql = inModel.getValue();
        if (!sql.trim()) {
          outModel.setValue('');
          bindInfo.textContent = '';
          setStatus('Paste SQL on the left', 'muted');
          return;
        }
        try {
          const binds = SqlFormat.listBinds(sql);
          let filled = null;
          if (paramsInput.value.trim()) {
            filled = SqlFormat.fillParams(sql, SqlFormat.parseParams(paramsInput.value));
            sql = filled.sql;
          }
          bindInfo.textContent = !binds.length ? 'no binds in the SQL'
            : filled ? `${filled.used} of ${binds.length} filled${filled.missing.length ? ` · missing ${filled.missing.join(', ')}` : ''}`
              : `${binds.length} bind${binds.length > 1 ? 's' : ''}: ${[...new Set(binds)].slice(0, 6).join(' ')}`;
          const indent = indentSelect.value === 'tab' ? '\t' : ' '.repeat(Number(indentSelect.value));
          const result = SqlFormat.format(sql, { indent, keywordCase: caseSelect.value, minify: style === 'minify' });
          outModel.setValue(result);
          const statements = SqlLexer.splitStatements(sql).length;
          setStatus(`✓ ${statements} statement${statements === 1 ? '' : 's'} · ${result.split('\n').length} lines`, filled?.missing.length ? 'warn' : 'ok');
        } catch (err) {
          setStatus(`✗ ${err.message}`, 'err');
        }
      }

      function setStatus(text, kind) {
        status.textContent = text;
        status.title = text;
        status.className = `status ${kind}`;
      }

      async function openFile() {
        const [p] = await window.api.openFile({ title: 'Open SQL file' });
        if (!p) return;
        try {
          inModel.setValue((await window.api.readTextFile(p)).text);
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      }

      inModel.onDidChangeContent(debounce(run, 200));
      paramsInput.addEventListener('input', debounce(run, 200));
      for (const el of [caseSelect, indentSelect]) el.addEventListener('change', run);
      styleButtons.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        style = btn.dataset.style;
        for (const b of styleButtons.children) b.classList.toggle('on', b === btn);
        run();
      });
    },
  });
})();
