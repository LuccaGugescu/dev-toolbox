'use strict';

(() => {
  Toolbox.register({
    id: 'db-errors',
    name: 'DB Error Lookup',
    group: 'Database',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>',

    mount(root) {
      const { h, debounce, pane } = Toolbox;
      let db = 'all';

      const searchInput = h('input.code', { spellcheck: 'false', placeholder: 'Search: ORA-00942, 23505, deadlock, timeout…', style: 'width:300px' });
      const dbButtons = h('span.segmented', {},
        h('button.on', { dataset: { db: 'all' } }, 'All'), h('button', { dataset: { db: 'oracle' } }, 'Oracle'), h('button', { dataset: { db: 'postgres' } }, 'PostgreSQL'));
      const status = h('span.status.muted');
      root.append(h('div.toolbar', {}, searchInput, dbButtons, h('span.sep'), status));

      const traceInput = h('textarea.code', { spellcheck: 'false', placeholder: 'Paste an exception / stack trace / log excerpt.\n\nORA- codes, SQLSTATE values and PostgreSQL error messages are recognised, plus constraint names and the offending key from "Key (col)=(value)".' });
      const left = pane('Stack trace or log', [h('button', { onclick: () => { traceInput.value = ''; run(); } }, 'Clear')]);
      left.body.append(traceInput);
      const results = h('div.err-results');
      const right = pane('Explanation', [], h('div.pane-body'));
      right.body.append(results);
      root.append(h('div.split', {}, left.el, right.el));

      function card(e, detail) {
        return h('div.err-card', {},
          h('div.err-head', {}, h('span.badge', {}, e.db === 'oracle' ? 'Oracle' : 'PostgreSQL'), h('b.err-code', {}, e.code), e.name ? h('span.muted', {}, e.name) : null),
          h('div.err-title', {}, e.title),
          detail && detail !== e.title ? h('div.err-detail', {}, detail) : null,
          h('div.err-label', {}, 'Cause'), h('div', {}, e.cause),
          h('div.err-label', {}, 'Fix'), h('div', {}, e.fix),
          e.spring ? h('div.err-spring', {}, h('span.muted', {}, 'Spring: '), e.spring) : null);
      }

      function run() {
        results.replaceChildren();
        const trace = traceInput.value.trim();
        if (trace) {
          const r = DbErrors.scan(trace);
          if (r.constraint || r.key) {
            results.append(h('div.kv', { style: 'margin-bottom:8px' },
              r.constraint ? [h('span.k', {}, 'Constraint'), h('span.v', {}, r.constraint), h('span')] : null,
              r.key ? [h('span.k', {}, 'Key'), h('span.v', {}, `${r.key.columns} = ${r.key.values}`), h('span')] : null));
          }
          const found = r.found.filter((f) => db === 'all' || f.entry.db === db);
          for (const f of found) results.append(card(f.entry, f.detail));
          status.textContent = found.length ? `${found.length} error${found.length > 1 ? 's' : ''} recognised — the first one is usually the root cause` : 'No known error code found in the text';
          status.className = `status ${found.length ? 'ok' : 'warn'}`;
          if (found.length) return;
        }
        const list = DbErrors.search(searchInput.value, db);
        status.textContent = trace ? status.textContent : `${list.length} errors${searchInput.value ? ' match' : ' in the reference'}`;
        if (!trace) status.className = 'status muted';
        for (const e of list.slice(0, 80)) results.append(card(e));
      }

      searchInput.addEventListener('input', debounce(run, 120));
      traceInput.addEventListener('input', debounce(run, 200));
      dbButtons.addEventListener('click', (e) => {
        if (!e.target.dataset.db) return;
        db = e.target.dataset.db;
        for (const b of dbButtons.children) b.classList.toggle('on', b === e.target);
        run();
      });
      run();
    },
  });
})();
