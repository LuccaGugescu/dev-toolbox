'use strict';

(() => {
  Toolbox.register({
    id: 'ids',
    name: 'UUID / ULID',
    group: 'Backend',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>',

    mount(root) {
      const { h, copy, copyButton, debounce, pane, relativeTime } = Toolbox;
      let kind = 'v7';

      const kindButtons = h('span.segmented', {},
        h('button', { dataset: { kind: 'v4' } }, 'UUID v4'), h('button.on', { dataset: { kind: 'v7' } }, 'UUID v7'), h('button', { dataset: { kind: 'ulid' } }, 'ULID'));
      const countInput = h('input', { type: 'number', min: 1, max: 10000, value: 10, style: 'width:80px' });
      const upper = h('input', { type: 'checkbox' });
      const noDashes = h('input', { type: 'checkbox' });
      const braces = h('input', { type: 'checkbox' });
      const status = h('span.status.muted');
      root.append(h('div.toolbar', {}, kindButtons, h('label.field', {}, 'Count', countInput),
        h('label.check', {}, upper, 'UPPER'), h('label.check', {}, noDashes, 'No dashes'), h('label.check', {}, braces, '{braces}'),
        h('button.primary', { onclick: generate }, 'Generate'), h('span.sep'), status));

      const out = h('textarea.code', { spellcheck: 'false', readonly: true });
      const left = pane('Generated', [copyButton(() => out.value, 'Copy all')]);
      left.body.append(out);

      const inspectInput = h('input.code', { spellcheck: 'false', placeholder: 'Paste a UUID / GUID, Oracle RAW hex, Base64, "msb, lsb" or a ULID' });
      const info = h('div.kv');
      const forms = h('div.kv');
      const right = pane('Inspect / convert', [], h('div.pane-body'));
      right.body.append(h('div.section', {}, inspectInput), info, h('div.section', { style: 'padding:10px 0 0;border-bottom:none' }, h('h3', { style: 'padding:0 12px' }, 'Other forms'), forms));
      root.append(h('div.split', {}, left.el, right.el));

      function generate() {
        const n = Math.min(10000, Math.max(1, Number(countInput.value) || 1));
        const ids = Ids.generate(kind, n, { upper: upper.checked, dashes: !noDashes.checked, braces: braces.checked });
        out.value = ids.join('\n');
        status.textContent = `${n} × ${kind === 'ulid' ? 'ULID' : `UUID ${kind}`}${kind === 'v7' ? ' · time-ordered: index-friendly primary keys' : kind === 'v4' ? ' · fully random' : ''}`;
        if (!inspectInput.value) {
          inspectInput.value = ids[0].replace(/[{}]/g, '');
          inspect();
        }
      }

      function inspect() {
        info.replaceChildren();
        forms.replaceChildren();
        const text = inspectInput.value.trim();
        if (!text) return;
        let r;
        try {
          r = Ids.inspect(text);
        } catch (err) {
          info.append(h('span.k', {}, 'Error'), h('span.v.claim-bad', {}, err.message), h('span'));
          return;
        }
        const row = (k, v) => info.append(h('span.k', {}, k), h('span.v', {}, v), h('span'));
        row('Version', r.version);
        if (r.kind === 'uuid') row('Variant', r.variant);
        if (r.time != null) {
          const d = new Date(r.time);
          row('Timestamp', `${d.toISOString()} · ${d.toLocaleString()} · ${relativeTime(r.time)}`);
        }
        if (r.note) row('Note', r.note);
        for (const [label, value] of r.forms) {
          forms.append(h('span.k', {}, label), h('span.v', {}, value), h('button', { onclick: () => copy(value) }, 'Copy'));
        }
      }

      kindButtons.addEventListener('click', (e) => {
        if (!e.target.dataset.kind) return;
        kind = e.target.dataset.kind;
        for (const b of kindButtons.children) b.classList.toggle('on', b === e.target);
        generate();
      });
      for (const el of [upper, noDashes, braces]) el.addEventListener('change', generate);
      inspectInput.addEventListener('input', debounce(inspect, 150));
      generate();
    },
  });
})();
