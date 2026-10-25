'use strict';

(() => {
  const LABELS = { md5: 'MD5', sha1: 'SHA-1', sha224: 'SHA-224', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

  const hexToBase64 = (hex) => btoa(String.fromCharCode(...hex.match(/../g).map((b) => parseInt(b, 16))));
  const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  Toolbox.register({
    id: 'hash',
    name: 'Hash Generator',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3 7 21M17 3l-2 18M4 8h17M3 16h17"/></svg>',

    mount(root) {
      const { h, copy, debounce, pane, toast, errorMessage } = Toolbox;
      let file = null; // { path } when hashing a file instead of the text box
      let last = null;
      let runId = 0;

      const formatSelect = h('select', {},
        h('option', { value: 'hex' }, 'hex'), h('option', { value: 'HEX' }, 'HEX (upper)'), h('option', { value: 'base64' }, 'Base64'));
      const hmacInput = h('input.code', { type: 'text', placeholder: 'optional → HMAC', style: 'width:220px', spellcheck: 'false' });
      const status = h('span.status.muted');
      root.append(h('div.toolbar', {},
        h('label.field', {}, 'Output', formatSelect),
        h('label.field', { title: 'With a key, computes HMAC-<algorithm> instead of a plain hash' }, 'HMAC key', hmacInput),
        h('span.grow'), status));

      const text = h('textarea.code', { spellcheck: 'false', placeholder: 'Type or paste text (hashed as UTF-8), or open / drop a file…' });
      const fileLabel = h('span.muted');
      const clearFileBtn = h('button', { hidden: true, onclick: () => setFile(null) }, 'Use text instead');
      const left = pane('Input', [fileLabel, clearFileBtn, h('button', { onclick: pickFile }, 'Open file…')]);
      left.body.append(text);

      const compareInput = h('input.code', { type: 'text', placeholder: 'Paste an expected hash to compare (any format)', spellcheck: 'false' });
      const compareResult = h('div', { style: 'margin-top:6px' });
      const rows = h('div.kv');
      const right = pane('Digests');
      right.body.append(rows, h('div.section', {}, h('h3', {}, 'Compare'), compareInput, compareResult));
      root.append(h('div.split', {}, left.el, right.el));

      async function run() {
        const id = ++runId;
        const hmacKey = hmacInput.value || undefined;
        if (!file && !text.value) {
          last = null;
          render();
          status.textContent = '';
          return;
        }
        status.textContent = 'Hashing…';
        status.className = 'status muted';
        const t0 = performance.now();
        try {
          const res = await window.api.computeHashes(file ? { path: file.path, hmacKey } : { text: text.value, hmacKey });
          if (id !== runId) return;
          last = { ...res, hmac: !!hmacKey };
          status.textContent = `${hmacKey ? 'HMAC · ' : ''}${formatSize(res.size)} · ${Math.round(performance.now() - t0)} ms`;
          render();
        } catch (err) {
          if (id !== runId) return;
          status.textContent = `✗ ${errorMessage(err)}`;
          status.className = 'status err';
        }
      }

      const fmt = (hex) => (formatSelect.value === 'HEX' ? hex.toUpperCase() : formatSelect.value === 'base64' ? hexToBase64(hex) : hex);

      function render() {
        rows.replaceChildren();
        compareResult.replaceChildren();
        if (!last) return;
        const expected = compareInput.value.trim().replace(/^[a-z0-9-]+[:=]\s*/i, '');
        let matched = null;
        for (const [alg, hex] of Object.entries(last.digests)) {
          const value = fmt(hex);
          const isMatch = expected && (hex === expected.toLowerCase().replace(/\s+/g, '') || hexToBase64(hex) === expected);
          if (isMatch) matched = alg;
          rows.append(
            h('span.k', {}, (last.hmac ? 'HMAC-' : '') + LABELS[alg]),
            h(`span.v${isMatch ? '.match' : ''}`, {}, value),
            h('button', { onclick: () => copy(value) }, 'Copy'));
        }
        if (expected) {
          compareResult.append(matched
            ? h('span.claim-good', {}, `✓ Matches ${LABELS[matched]}`)
            : h('span.claim-bad', {}, '✗ Does not match any digest above'));
        }
      }

      function setFile(f) {
        file = f;
        text.disabled = !!f;
        text.style.opacity = f ? 0.4 : 1;
        fileLabel.textContent = f ? f.path : '';
        fileLabel.title = f ? f.path : '';
        clearFileBtn.hidden = !f;
        run();
      }

      async function pickFile() {
        const [p] = await window.api.openFile({ title: 'Choose a file to hash' });
        if (p) setFile({ path: p });
      }

      text.addEventListener('input', debounce(run, 150));
      hmacInput.addEventListener('input', debounce(run, 200));
      formatSelect.addEventListener('change', render);
      compareInput.addEventListener('input', render);
      root.addEventListener('dragover', (e) => e.preventDefault());
      root.addEventListener('drop', async (e) => {
        e.preventDefault();
        const p = e.dataTransfer.files[0] && window.api.pathForFile(e.dataTransfer.files[0]);
        if (!p) return;
        if (await window.api.isDirectory(p)) toast('Drop a file, not a folder', 'error');
        else setFile({ path: p });
      });
      this.openPaths = ([p]) => p && setFile({ path: p });
    },
  });
})();
