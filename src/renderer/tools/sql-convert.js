'use strict';

(() => {
  Toolbox.register({
    id: 'sql-convert',
    name: 'Oracle ⇄ PostgreSQL',
    group: 'Database',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="6" cy="6" rx="4" ry="2"/><path d="M2 6v5c0 1.1 1.8 2 4 2s4-.9 4-2V6"/><ellipse cx="18" cy="13" rx="4" ry="2"/><path d="M14 13v5c0 1.1 1.8 2 4 2s4-.9 4-2v-5"/><path d="M13 5h5l-2-2M11 20H6l2 2"/></svg>',

    mount(root, monaco) {
      const { h, copyButton, debounce, createEditor, pane } = Toolbox;
      let direction = 'ora2pg';

      const dirButtons = h('span.segmented', {},
        h('button.on', { dataset: { dir: 'ora2pg' } }, 'Oracle → PostgreSQL'),
        h('button', { dataset: { dir: 'pg2ora' } }, 'PostgreSQL → Oracle'));
      const formatCheck = h('input', { type: 'checkbox' });
      const status = h('span.status.muted');
      root.append(h('div.toolbar', {}, dirButtons,
        h('button', { title: 'Use the output as input and flip direction', onclick: swap }, '⇄ Swap'),
        h('label.check', { title: 'Run the SQL formatter on the result' }, formatCheck, 'Format output'),
        h('span.sep'), status));

      const input = pane('Oracle SQL / DDL', [h('button', { onclick: () => inModel.setValue('') }, 'Clear')], h('div.pane-body.editor'));
      const outHost = h('div', { style: 'flex:1;min-height:0;position:relative' });
      const warnList = h('div.conv-warnings');
      const output = pane('PostgreSQL', [copyButton(() => outModel.getValue())], h('div.pane-body.stack'));
      output.body.append(outHost, warnList);
      root.append(h('div.split', {}, input.el, output.el));

      const inModel = monaco.editor.createModel('', 'sql');
      const outModel = monaco.editor.createModel('', 'sql');
      createEditor(input.body, { model: inModel });
      createEditor(outHost, { model: outModel, readOnly: true });

      function run() {
        const text = inModel.getValue();
        warnList.replaceChildren();
        if (!text.trim()) {
          outModel.setValue('');
          status.textContent = 'Paste DDL, queries or PL/SQL snippets on the left';
          status.className = 'status muted';
          return;
        }
        const { sql, warnings } = SqlConvert.convert(text, direction);
        outModel.setValue(formatCheck.checked ? SqlFormat.format(sql) : sql);
        if (warnings.length) {
          warnList.append(h('h3', {}, `Needs review (${warnings.length})`),
            ...warnings.map((w) => h('div.conv-warning', {}, h('span.ex-dot'), h('span', {}, w.message, w.count > 1 ? h('span.badge', { style: 'margin-left:6px' }, `×${w.count}`) : null))));
        }
        status.textContent = warnings.length ? `Converted · ${warnings.length} construct(s) need manual review` : '✓ Converted · nothing flagged (still test it)';
        status.className = `status ${warnings.length ? 'warn' : 'ok'}`;
      }

      function setDirection(dir) {
        direction = dir;
        for (const b of dirButtons.children) b.classList.toggle('on', b.dataset.dir === dir);
        input.el.querySelector('.pane-title').textContent = dir === 'ora2pg' ? 'Oracle SQL / DDL' : 'PostgreSQL SQL / DDL';
        output.el.querySelector('.pane-title').textContent = dir === 'ora2pg' ? 'PostgreSQL' : 'Oracle';
        run();
      }

      function swap() {
        const out = outModel.getValue();
        setDirection(direction === 'ora2pg' ? 'pg2ora' : 'ora2pg');
        inModel.setValue(out);
      }

      inModel.onDidChangeContent(debounce(run, 250));
      formatCheck.addEventListener('change', run);
      dirButtons.addEventListener('click', (e) => e.target.dataset.dir && setDirection(e.target.dataset.dir));
      run();
    },
  });
})();
