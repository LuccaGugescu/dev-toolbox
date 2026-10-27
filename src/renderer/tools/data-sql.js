'use strict';

(() => {
  const MODES = [
    ['insert-multi', 'Multi-row INSERT'], ['insert', 'INSERT per row'], ['upsert', 'Upsert (ON CONFLICT / MERGE)'],
    ['update', 'UPDATE by key'], ['delete', 'DELETE by key'], ['in-list', 'IN (...) list'],
    ['values', 'VALUES / WITH data'], ['create', 'CREATE TABLE'],
  ];

  Toolbox.register({
    id: 'data-sql',
    name: 'Data → SQL',
    group: 'Database',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/></svg>',

    mount(root, monaco) {
      const { h, copyButton, debounce, createEditor, pane, toast, errorMessage } = Toolbox;
      let dialect = 'postgres';
      const keys = new Set();

      const modeSelect = h('select', {}, MODES.map(([v, l]) => h('option', { value: v }, l)));
      const dialectButtons = h('span.segmented', {},
        h('button.on', { dataset: { dialect: 'postgres' } }, 'PostgreSQL'),
        h('button', { dataset: { dialect: 'oracle' } }, 'Oracle'));
      const tableInput = h('input.code', { value: 'my_table', style: 'width:160px', spellcheck: 'false', title: 'Table name (schema.table allowed)' });
      const headerSelect = h('select', { title: 'Is the first row a header?' },
        h('option', { value: 'auto' }, 'Header: auto'), h('option', { value: 'yes' }, 'Header: yes'), h('option', { value: 'no' }, 'Header: no'));
      const batchInput = h('input', { type: 'number', min: 1, value: 500, style: 'width:70px', title: 'Rows per statement (multi-row INSERT / upsert)' });
      const emptyNull = h('input', { type: 'checkbox', checked: true });
      const status = h('span.status.muted');
      root.append(h('div.toolbar', {}, modeSelect, dialectButtons,
        h('label.field', {}, 'Table', tableInput), headerSelect,
        h('label.field', {}, 'Batch', batchInput),
        h('label.check', { title: 'Empty cells become NULL' }, emptyNull, 'Empty = NULL'),
        h('span.sep'), status));

      const keyBar = h('div.chips-bar');
      const input = pane('Data (CSV, TSV, JSON, or one value per line)', [h('button', { onclick: openFile }, 'Open file…'), h('button', { onclick: () => inModel.setValue('') }, 'Clear')], h('div.pane-body.stack'));
      const inHost = h('div', { style: 'flex:1;min-height:0;position:relative' });
      input.body.append(keyBar, inHost);
      const output = pane('SQL', [copyButton(() => outModel.getValue())], h('div.pane-body.editor'));
      root.append(h('div.split', {}, input.el, output.el));

      const inModel = monaco.editor.createModel('', 'plaintext');
      const outModel = monaco.editor.createModel('', 'sql');
      createEditor(inHost, { model: inModel, wordWrap: 'off' });
      createEditor(output.body, { model: outModel, readOnly: true });

      function run() {
        const text = inModel.getValue();
        if (!text.trim()) {
          outModel.setValue('');
          keyBar.replaceChildren(h('span.muted', {}, 'Paste rows copied from Excel / a DB client (tab-separated), CSV, a JSON array, or a list of ids.'));
          setStatus('', 'muted');
          return;
        }
        let parsed;
        try {
          parsed = DataSql.parseInput(text, { header: headerSelect.value });
        } catch (err) {
          setStatus(`✗ ${err.message}`, 'err');
          return;
        }
        for (const k of [...keys]) if (!parsed.columns.includes(k)) keys.delete(k);
        const mode = modeSelect.value;
        const needsKey = ['upsert', 'update', 'delete', 'create'].includes(mode);
        if (['upsert', 'update', 'delete'].includes(mode) && !keys.size && parsed.columns.length) keys.add(parsed.columns[0]);
        const types = DataSql.inferColumns(parsed, { emptyAsNull: emptyNull.checked });
        renderKeys(parsed, types, needsKey || mode === 'in-list');
        try {
          const result = DataSql.generate(parsed, {
            mode, dialect, table: tableInput.value.trim() || 'my_table', keys: [...keys],
            batch: Math.max(1, Number(batchInput.value) || 500), emptyAsNull: emptyNull.checked,
            inColumn: [...keys][0] || parsed.columns[0],
          });
          outModel.setValue(result.sql);
          const base = `${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} × ${parsed.columns.length} col · ${typeof parsed.format === 'string' ? parsed.format.toUpperCase() : ''}`;
          setStatus(result.warnings.length ? `${base} · ⚠ ${result.warnings.join(' ')}` : `✓ ${base}`, result.warnings.length ? 'warn' : 'ok');
        } catch (err) {
          outModel.setValue('');
          setStatus(`✗ ${err.message}`, 'err');
        }
      }

      function renderKeys(parsed, types, keyed) {
        const label = modeSelect.value === 'in-list' ? 'Column:' : modeSelect.value === 'create' ? 'Primary key:' : 'Key:';
        keyBar.replaceChildren(
          keyed ? h('span.muted', {}, label) : h('span.muted', {}, 'Columns:'),
          ...parsed.columns.map((c, i) => {
            const on = keys.has(c);
            return h(`button.chip${on ? '.on' : ''}`, {
              title: `${DataSql.sqlType(types[i], dialect)}${keyed ? ' · click to toggle' : ''}`,
              disabled: !keyed,
              onclick: () => {
                if (modeSelect.value === 'in-list') keys.clear();
                if (on) keys.delete(c); else keys.add(c);
                run();
              },
            }, c, h('span.muted', { style: 'margin-left:6px;font-size:11px' }, types[i].kind));
          }));
      }

      function setStatus(text, kind) {
        status.textContent = text;
        status.title = text;
        status.className = `status ${kind}`;
      }

      async function openFile() {
        const [p] = await window.api.openFile({ title: 'Open CSV / JSON file' });
        if (!p) return;
        try {
          inModel.setValue((await window.api.readTextFile(p)).text);
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      }

      inModel.onDidChangeContent(debounce(run, 250));
      for (const el of [modeSelect, headerSelect, emptyNull]) el.addEventListener('change', run);
      for (const el of [tableInput, batchInput]) el.addEventListener('input', debounce(run, 250));
      dialectButtons.addEventListener('click', (e) => {
        if (!e.target.dataset.dialect) return;
        dialect = e.target.dataset.dialect;
        for (const b of dialectButtons.children) b.classList.toggle('on', b === e.target);
        run();
      });
      run();
    },
  });
})();
