'use strict';

(() => {
  const DBS = [['postgres', 'PostgreSQL'], ['oracle', 'Oracle'], ['mysql', 'MySQL'], ['sqlserver', 'SQL Server']];
  const SSL = {
    postgres: [['', 'default (prefer)'], ['disable', 'disable'], ['require', 'require'], ['verify-ca', 'verify-ca'], ['verify-full', 'verify-full']],
    oracle: [['', 'TCP'], ['require', 'TCPS (TLS)']],
    mysql: [['', 'default'], ['disabled', 'DISABLED'], ['required', 'REQUIRED'], ['verify-identity', 'VERIFY_IDENTITY']],
    sqlserver: [['', 'encrypt=false'], ['require', 'encrypt, trust cert'], ['verify-full', 'encrypt + verify cert']],
  };

  Toolbox.register({
    id: 'conn',
    name: 'Connection Strings',
    group: 'Database',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15l6-6"/><path d="M11 6l1.5-1.5a4.2 4.2 0 0 1 6 6L17 12M13 18l-1.5 1.5a4.2 4.2 0 0 1-6-6L7 12"/></svg>',

    mount(root) {
      const { h, copyButton, debounce, pane } = Toolbox;
      let model = Conn.empty('postgres');

      const pasteInput = h('input.code', { spellcheck: 'false', placeholder: 'Paste any connection string: jdbc:…, postgres://…, host=… dbname=…, user/pass@host:1521/svc, (DESCRIPTION=…), Host=…;Database=…' });
      const status = h('span.status.muted');
      root.append(h('div.toolbar', {}, h('div', { style: 'flex:1;min-width:300px;display:flex' }, pasteInput), status));

      const dbButtons = h('span.segmented', {}, DBS.map(([id, label]) => h('button', { dataset: { db: id } }, label)));
      const f = {
        host: h('input.code', { spellcheck: 'false' }),
        port: h('input.code', { type: 'number', min: 1, max: 65535 }),
        database: h('input.code', { spellcheck: 'false' }),
        oracleMode: h('select', {}, h('option', { value: 'service' }, 'Service name'), h('option', { value: 'sid' }, 'SID')),
        user: h('input.code', { spellcheck: 'false' }),
        password: h('input.code', { type: 'password', autocomplete: 'off' }),
        sslmode: h('select'),
        schema: h('input.code', { spellcheck: 'false', placeholder: 'search_path / currentSchema' }),
        appName: h('input.code', { spellcheck: 'false', placeholder: 'shows in pg_stat_activity / v$session' }),
      };
      const placeholder = h('input', { type: 'checkbox', checked: true });
      const dbLabel = h('span.muted', {}, 'Database');
      const row = (label, el, extra) => h('label.form-row', {}, h('span.muted', {}, label), el, extra || null);
      const schemaRow = row('Schema', f.schema);
      const modeRow = row('Connect by', f.oracleMode);
      const left = pane('Connection', [dbButtons], h('div.pane-body'));
      left.body.append(h('div.form', {},
        row('Host', f.host), row('Port', f.port), h('label.form-row', {}, dbLabel, f.database), modeRow,
        row('User', f.user), row('Password', f.password), row('TLS / SSL', f.sslmode), schemaRow, row('Application', f.appName),
        h('label.check', { style: 'margin-top:6px' }, placeholder, 'Write ${DB_PASSWORD} instead of the real password'),
        h('p.muted', { style: 'margin:10px 0 0;font-size:12px' }, 'Everything stays on this computer. Prefer environment variables / a secret store over passwords in config files.')));
      const outputs = h('div.conn-outputs');
      const right = pane('Generated', [], h('div.pane-body'));
      right.body.append(outputs);
      root.append(h('div.split.wide-right', {}, left.el, right.el));

      function fill() {
        for (const b of dbButtons.children) b.classList.toggle('on', b.dataset.db === model.db);
        f.sslmode.replaceChildren(...SSL[model.db].map(([v, l]) => h('option', { value: v }, l)));
        for (const [k, el] of Object.entries(f)) el.value = model[k] ?? '';
        if (!SSL[model.db].some(([v]) => v === (model.sslmode || ''))) f.sslmode.value = model.sslmode ? SSL[model.db][SSL[model.db].length - 1][0] : '';
        dbLabel.textContent = model.db === 'oracle' ? (model.oracleMode === 'sid' ? 'SID' : 'Service name') : 'Database';
        modeRow.hidden = model.db !== 'oracle';
        schemaRow.hidden = model.db !== 'postgres';
        render();
      }

      function readForm() {
        for (const [k, el] of Object.entries(f)) model[k] = k === 'port' ? Number(el.value) || Conn.DEFAULT_PORT[model.db] : el.value.trim();
        model.password = f.password.value;
        dbLabel.textContent = model.db === 'oracle' ? (model.oracleMode === 'sid' ? 'SID' : 'Service name') : 'Database';
        render();
      }

      function render() {
        outputs.replaceChildren();
        let group = null;
        for (const o of Conn.build(model, { placeholder: placeholder.checked })) {
          if (o.group !== group) {
            group = o.group;
            outputs.append(h('h3.conn-group', {}, group));
          }
          outputs.append(h('div.conn-item', {},
            h('div.conn-head', {}, h('span', {}, o.label), h('span.grow'), copyButton(() => o.value)),
            h('pre.code', {}, o.value)));
        }
      }

      function parsePasted() {
        const text = pasteInput.value.trim();
        if (!text) {
          status.textContent = '';
          return;
        }
        try {
          model = Conn.parse(text);
          status.textContent = `✓ Parsed as ${DBS.find(([id]) => id === model.db)[1]}${model.extra.length ? ` · extra params: ${model.extra.map(([k]) => k).join(', ')}` : ''}`;
          status.className = 'status ok';
          fill();
        } catch (err) {
          status.textContent = `✗ ${err.message}`;
          status.title = err.message;
          status.className = 'status err';
        }
      }

      dbButtons.addEventListener('click', (e) => {
        const db = e.target.dataset.db;
        if (!db || db === model.db) return;
        const keep = { host: model.host, user: model.user, password: model.password, database: model.database };
        model = { ...Conn.empty(db), ...keep };
        fill();
      });
      pasteInput.addEventListener('input', debounce(parsePasted, 200));
      for (const el of Object.values(f)) el.addEventListener('input', debounce(readForm, 150));
      f.oracleMode.addEventListener('change', readForm);
      f.sslmode.addEventListener('change', readForm);
      placeholder.addEventListener('change', render);
      fill();
    },
  });
})();
