'use strict';

(() => {
  const PG_CMD = 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)\n';
  const ORA_CMD = "-- 1. run the query with the hint, 2. then:\nSELECT /*+ GATHER_PLAN_STATISTICS */ ...;\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'));";

  Toolbox.register({
    id: 'explain',
    name: 'EXPLAIN Analyzer',
    group: 'Database',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6v4H4zM14 10h6v4h-6zM14 18h6v3h-6z"/><path d="M7 8v4h7M7 12v7.5h7"/></svg>',

    mount(root, monaco) {
      const { h, copy, debounce, createEditor, pane } = Toolbox;
      const status = h('span.status.muted', {}, 'Paste an execution plan on the left');
      root.append(h('div.toolbar', {},
        h('button', { title: 'Copy the PostgreSQL EXPLAIN prefix', onclick: () => copy(PG_CMD) }, 'Copy PostgreSQL EXPLAIN'),
        h('button', { title: 'Copy the Oracle DBMS_XPLAN query', onclick: () => copy(ORA_CMD) }, 'Copy Oracle DBMS_XPLAN'),
        h('span.sep'), status));

      const input = pane('Plan (PostgreSQL JSON / text, Oracle DBMS_XPLAN)', [h('button', { onclick: () => inModel.setValue('') }, 'Clear')], h('div.pane-body.editor'));
      const summary = h('div.ex-summary');
      const findings = h('div.ex-findings');
      const tree = h('div.ex-tree');
      const expandAll = h('input', { type: 'checkbox' });
      const right = pane('Analysis', [h('label.check', {}, expandAll, 'Show all details')]);
      right.body.append(summary, findings, tree);
      root.append(h('div.split.wide-right', {}, input.el, right.el));

      const inModel = monaco.editor.createModel('', 'plaintext');
      createEditor(input.body, { model: inModel, wordWrap: 'off' });

      let plan = null;

      function run() {
        const text = inModel.getValue();
        for (const el of [summary, findings, tree]) el.replaceChildren();
        plan = null;
        if (!text.trim()) {
          setStatus('Paste an execution plan on the left', 'muted');
          summary.append(h('div.empty', {}, h('h2', {}, 'Find the slow part of a query'),
            h('ul', {},
              h('li', {}, 'PostgreSQL: run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <query>, or plain-text EXPLAIN ANALYZE output from psql / DBeaver / pgAdmin'),
              h('li', {}, "Oracle: DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST') after running the query with /*+ GATHER_PLAN_STATISTICS */"),
              h('li', {}, 'Shows exclusive time per node, row-estimate errors, disk spills, missing indexes'))));
          return;
        }
        try {
          plan = ExplainPlan.parse(text);
        } catch (err) {
          setStatus(`✗ ${err.message}`, 'err');
          return;
        }
        const bad = plan.findings.filter((f) => f.level === 'bad').length;
        const warn = plan.findings.filter((f) => f.level === 'warn').length;
        setStatus(`${plan.dialect === 'oracle' ? 'Oracle' : 'PostgreSQL'} plan · ${plan.nodes.length} nodes${plan.analyzed ? '' : ' · estimates only (no ANALYZE / A-Rows)'} · ${bad} problems, ${warn} warnings`, bad ? 'err' : warn ? 'warn' : 'ok');
        renderSummary();
        renderFindings();
        renderTree();
      }

      function renderSummary() {
        const stat = (label, value) => h('div.ex-stat', {}, h('span.muted', {}, label), h('b', {}, value));
        const items = [];
        if (plan.executionMs != null) items.push(stat('Execution', ms(plan.executionMs)));
        if (plan.planningMs != null) items.push(stat('Planning', ms(plan.planningMs)));
        if (plan.root.totalCost != null) items.push(stat('Total cost', fmt(plan.root.totalCost)));
        if (plan.root.rowsTotal != null) items.push(stat('Rows returned', fmt(plan.root.rowsTotal)));
        else if (plan.root.planRows != null) items.push(stat('Rows (est.)', fmt(plan.root.planRows)));
        if (plan.slowest[0]) items.push(stat('Slowest node', `${plan.slowest[0].type}${plan.slowest[0].relation ? ` on ${plan.slowest[0].relation}` : ''} · ${pct(plan.slowest[0].pctTime)}`));
        summary.append(h('div.ex-stats', {}, items));
        if (plan.notes?.length) summary.append(h('div.muted', { style: 'padding:0 12px 8px' }, `Note: ${plan.notes.join(' · ')}`));
      }

      function renderFindings() {
        if (!plan.findings.length) {
          findings.append(h('div.ex-finding.ok', {}, plan.analyzed ? '✓ No obvious problems found.' : 'No problems detected from estimates. Run with ANALYZE / ALLSTATS for timings and row counts.'));
          return;
        }
        for (const f of plan.findings) {
          findings.append(h(`div.ex-finding.${f.level}`, { onclick: () => focusNode(f.node.id), title: 'Show node' },
            h('span.ex-dot'), h('span', {}, h('b', {}, `${f.node.type}${f.node.relation ? ` · ${f.node.relation}` : ''}: `), f.text)));
        }
      }

      function renderTree() {
        tree.append(h('div.ex-row.ex-head', {}, h('span', {}, 'Node'), h('span.num', {}, 'Self time'), h('span.num', {}, 'Rows (actual / est.)'), h('span.num', {}, 'Loops'), h('span.num', {}, 'Cost')));
        for (const n of plan.nodes) {
          const level = n.findings.some((f) => f.level === 'bad') ? 'bad' : n.findings.some((f) => f.level === 'warn') ? 'warn' : '';
          const mis = n.misestimate != null && Math.abs(n.misestimate) >= 10
            ? h(`span.badge.${Math.abs(n.misestimate) >= 100 ? 'err' : 'warn'}`, { title: 'Estimate error' }, `${n.misestimate > 0 ? '▲' : '▼'}${fmt(Math.abs(n.misestimate))}×`) : null;
          const details = h('div.ex-details', { hidden: !expandAll.checked },
            h('div.kv', {}, Object.entries(n.details).filter(([, v]) => v !== '' && v != null).flatMap(([k, v]) => [h('span.k', {}, k), h('span.v', {}, String(v)), h('span')])));
          const row = h(`div.ex-row${level ? `.${level}` : ''}`, { dataset: { node: n.id }, onclick: () => { details.hidden = !details.hidden; } },
            h('span.ex-name', { style: `padding-left:${n.depth * 16}px` },
              n.depth ? h('span.muted', {}, '└ ') : null,
              h('b', {}, n.type),
              n.relation ? h('span', {}, ` on ${n.relation}${n.alias ? ` ${n.alias}` : ''}`) : null,
              n.index ? h('span.muted', {}, ` using ${n.index}`) : null,
              n.neverExecuted ? h('span.badge', {}, 'never executed') : null),
            h('span.num', {}, n.exclusiveMs != null ? h('span.ex-bar', { style: `--w:${Math.max(1, n.pctTime || 0)}%` }, `${ms(n.exclusiveMs)} · ${pct(n.pctTime)}`) : '—'),
            h('span.num', {}, `${n.actual ? fmt(n.actual.rows) : '—'} / ${n.planRows != null ? fmt(n.planRows) : '—'} `, mis),
            h('span.num', {}, n.actual ? fmt(n.actual.loops) : '—'),
            h('span.num', {}, n.totalCost != null ? fmt(n.totalCost) : '—'));
          tree.append(row, details);
        }
      }

      function focusNode(id) {
        const row = tree.querySelector(`[data-node="${id}"]`);
        if (!row) return;
        row.nextElementSibling.hidden = false;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.add('flash');
        setTimeout(() => row.classList.remove('flash'), 1200);
      }

      const fmt = (n) => (n == null ? '—' : Number(n) >= 1000 || Number.isInteger(Number(n)) ? Math.round(n).toLocaleString('en-US') : Number(n).toFixed(2));
      const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v >= 10 ? v.toFixed(0) : v.toFixed(2)} ms`);
      const pct = (p) => (p == null ? '' : `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`);

      function setStatus(text, kind) {
        status.textContent = text;
        status.title = text;
        status.className = `status ${kind}`;
      }

      inModel.onDidChangeContent(debounce(run, 250));
      expandAll.addEventListener('change', () => {
        for (const d of tree.querySelectorAll('.ex-details')) d.hidden = !expandAll.checked;
      });
      run();
    },
  });
})();
