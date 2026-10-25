'use strict';

(() => {
  const utf8 = new TextEncoder();
  const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

  const bytesToBase64 = (bytes) => {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const base64ToBytes = (s) => {
    const clean = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const hexToBytes = (s) => {
    const clean = s.replace(/0x/gi, '').replace(/[\s:,-]+/g, '');
    if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2) throw new Error('Not valid hex (needs an even number of 0-9 / a-f digits)');
    return Uint8Array.from(clean.match(/../g) || [], (b) => parseInt(b, 16));
  };
  const javaEscape = (s) => Array.from(s, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) return ch;
    let out = '';
    for (let k = 0; k < ch.length; k++) out += '\\u' + ch.charCodeAt(k).toString(16).toUpperCase().padStart(4, '0');
    return out;
  }).join('');

  // Each codec: encode(text) -> string, decode(text) -> string | Uint8Array (binary result).
  const CODECS = {
    base64: { label: 'Base64', encode: (s) => bytesToBase64(utf8.encode(s)), decode: base64ToBytes },
    base64url: {
      label: 'Base64URL',
      encode: (s) => bytesToBase64(utf8.encode(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      decode: base64ToBytes,
    },
    url: { label: 'URL', encode: (s) => encodeURIComponent(s), decode: (s) => decodeURIComponent(s.replace(/\+/g, ' ')) },
    html: {
      label: 'HTML entities',
      encode: (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
      decode: (s) => {
        const t = document.createElement('textarea');
        t.innerHTML = s;
        return t.value;
      },
    },
    hex: { label: 'Hex', encode: (s) => toHex(utf8.encode(s)), decode: hexToBytes },
    unicode: {
      label: 'Java \\uXXXX',
      encode: javaEscape,
      decode: (s) => s.replace(/\\u+([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))),
    },
    json: { label: 'JSON string', encode: (s) => JSON.stringify(s).slice(1, -1), decode: (s) => JSON.parse(`"${s.replace(/^"|"$/g, '')}"`) },
  };

  Toolbox.register({
    id: 'codec',
    name: 'Encode / Decode',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',

    mount(root) {
      const { h, copyButton, debounce, pane } = Toolbox;
      let codec = 'base64';
      let direction = 'encode';

      const codecButtons = h('span.segmented', {},
        Object.entries(CODECS).map(([id, c]) => h(`button${id === codec ? '.on' : ''}`, { dataset: { codec: id } }, c.label)));
      const dirButtons = h('span.segmented', {},
        h('button.on', { dataset: { dir: 'encode' } }, 'Encode'),
        h('button', { dataset: { dir: 'decode' } }, 'Decode'));
      const status = h('span.status.muted');

      root.append(h('div.toolbar', {}, codecButtons, h('span.sep'), dirButtons,
        h('button', { title: 'Use the output as the new input and flip direction', onclick: swap }, '⇄ Swap'),
        h('span.grow'), status));

      const input = h('textarea.code', { spellcheck: 'false', placeholder: 'Type or paste text…' });
      const output = h('textarea.code', { spellcheck: 'false', readonly: true });
      const left = pane('Input', [h('button', { onclick: () => { input.value = ''; run(); } }, 'Clear')]);
      const right = pane('Output', [copyButton(() => output.value)]);
      left.body.append(input);
      right.body.append(output);
      root.append(h('div.split', {}, left.el, right.el));

      function run() {
        const text = input.value;
        status.className = 'status muted';
        if (!text) {
          output.value = '';
          status.textContent = '';
          return;
        }
        try {
          const result = CODECS[codec][direction](text);
          if (result instanceof Uint8Array) {
            try {
              output.value = strictUtf8.decode(result);
              status.textContent = `${result.length} bytes → UTF-8 text`;
            } catch {
              output.value = hexDump(result);
              status.textContent = `${result.length} bytes of binary data (not UTF-8), shown as hex`;
              status.className = 'status warn';
            }
          } else {
            output.value = result;
            status.textContent = `${text.length} → ${result.length} chars`;
          }
        } catch (err) {
          output.value = '';
          status.textContent = `✗ Cannot ${direction}: ${err.message}`;
          status.className = 'status err';
        }
      }

      function swap() {
        input.value = output.value;
        setDirection(direction === 'encode' ? 'decode' : 'encode');
      }

      function setDirection(dir) {
        direction = dir;
        for (const b of dirButtons.children) b.classList.toggle('on', b.dataset.dir === dir);
        run();
      }

      input.addEventListener('input', debounce(run, 100));
      dirButtons.addEventListener('click', (e) => e.target.dataset.dir && setDirection(e.target.dataset.dir));
      codecButtons.addEventListener('click', (e) => {
        if (!e.target.dataset.codec) return;
        codec = e.target.dataset.codec;
        for (const b of codecButtons.children) b.classList.toggle('on', b === e.target);
        run();
      });
    },
  });

  function hexDump(bytes) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const row = bytes.subarray(i, i + 16);
      const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47);
      const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
    }
    return lines.join('\n');
  }
})();
