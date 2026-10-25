'use strict';

(() => {
Toolbox.register({
  id: 'format',
  name: 'JSON / XML Formatter',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2-1 3-3 3"/></svg>',

  mount(root, monaco) {
    const { h, copyButton, debounce, createEditor, pane, toast, errorMessage } = Toolbox;
    let style = 'pretty';

    const langSelect = h('select', {},
      h('option', { value: 'auto' }, 'Auto-detect'), h('option', { value: 'json' }, 'JSON'), h('option', { value: 'xml' }, 'XML'));
    const indentSelect = h('select', { title: 'Indentation' },
      h('option', { value: '2' }, '2 spaces'), h('option', { value: '4' }, '4 spaces'), h('option', { value: 'tab' }, 'Tabs'));
    const sortCheck = h('input', { type: 'checkbox' });
    const styleButtons = h('span.segmented', {},
      h('button.on', { dataset: { style: 'pretty' } }, 'Format'),
      h('button', { dataset: { style: 'minify' } }, 'Minify'));
    const status = h('span.status.muted', {}, 'Paste JSON or XML on the left');

    root.append(h('div.toolbar', {},
      h('label.field', {}, 'Language', langSelect),
      styleButtons,
      h('label.field', {}, 'Indent', indentSelect),
      h('label.check', { title: 'Sort object keys alphabetically (JSON)' }, sortCheck, 'Sort keys'),
      h('span.sep'),
      status));

    const input = pane('Input', [h('button', { onclick: openFile }, 'Open file…'), h('button', { onclick: () => inModel.setValue('') }, 'Clear')], h('div.pane-body.editor'));
    const output = pane('Output', [copyButton(() => outModel.getValue())], h('div.pane-body.editor'));
    root.append(h('div.split', {}, input.el, output.el));

    const inModel = monaco.editor.createModel('', 'json');
    const outModel = monaco.editor.createModel('', 'json');
    createEditor(input.body, { model: inModel, minimap: { enabled: true } });
    createEditor(output.body, { model: outModel, readOnly: true, minimap: { enabled: true }, folding: true });

    const run = () => {
      const text = inModel.getValue();
      monaco.editor.setModelMarkers(inModel, 'format', []);
      if (!text.trim()) {
        outModel.setValue('');
        setStatus('Paste JSON or XML on the left', 'muted');
        return;
      }
      const lang = langSelect.value === 'auto' ? (text.trimStart().startsWith('<') ? 'xml' : 'json') : langSelect.value;
      monaco.editor.setModelLanguage(inModel, lang);
      monaco.editor.setModelLanguage(outModel, lang);
      const indent = indentSelect.value === 'tab' ? '\t' : ' '.repeat(Number(indentSelect.value));
      try {
        const result = lang === 'json'
          ? formatJson(text, { indent, minify: style === 'minify', sortKeys: sortCheck.checked })
          : formatXml(text, { indent, minify: style === 'minify' });
        outModel.setValue(result.text);
        setStatus(`✓ Valid ${lang.toUpperCase()} · ${result.summary}`, 'ok');
      } catch (err) {
        const pos = err.position != null ? inModel.getPositionAt(err.position) : err.line ? { lineNumber: err.line, column: err.column || 1 } : null;
        setStatus(`✗ ${err.message}${pos ? ` (line ${pos.lineNumber}, column ${pos.column})` : ''}`, 'err');
        if (pos) {
          monaco.editor.setModelMarkers(inModel, 'format', [{
            severity: monaco.MarkerSeverity.Error, message: err.message,
            startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column + 1,
          }]);
        }
      }
    };

    function setStatus(text, kind) {
      status.textContent = text;
      status.title = text;
      status.className = `status ${kind}`;
    }

    async function openFile() {
      const [p] = await window.api.openFile({ title: 'Open JSON or XML file' });
      if (!p) return;
      try {
        inModel.setValue((await window.api.readTextFile(p)).text);
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    }

    inModel.onDidChangeContent(debounce(run, 200));
    for (const el of [langSelect, indentSelect, sortCheck]) el.addEventListener('change', run);
    styleButtons.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      style = btn.dataset.style;
      for (const b of styleButtons.children) b.classList.toggle('on', b === btn);
      run();
    });
  },
});

// Numbers that do not survive a double round-trip (64-bit ids, long decimals) are kept as written.
function formatJson(text, { indent, minify, sortKeys }) {
  let value;
  try {
    value = JSON.parse(text, (_key, v, ctx) =>
      typeof v === 'number' && ctx?.source && String(v) !== ctx.source && typeof JSON.rawJSON === 'function' ? JSON.rawJSON(ctx.source) : v);
  } catch (err) {
    const e = new Error(err.message.replace(/ in JSON at position \d+.*$/, '').replace(/ \(line \d+ column \d+\)$/, ''));
    const m = /position (\d+)/.exec(err.message);
    if (m) e.position = Number(m[1]);
    throw e;
  }
  if (sortKeys) value = sortDeep(value);
  const stats = { objects: 0, arrays: 0, values: 0, depth: 0 };
  walk(value, 1, stats);
  return {
    text: JSON.stringify(value, null, minify ? undefined : indent),
    summary: `${stats.objects} objects · ${stats.arrays} arrays · ${stats.values} values · depth ${stats.depth}`,
  };
}

const isRaw = (v) => typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(v);

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object' && !isRaw(v)) {
    return Object.fromEntries(Object.keys(v).sort((a, b) => a.localeCompare(b)).map((k) => [k, sortDeep(v[k])]));
  }
  return v;
}

function walk(v, depth, stats) {
  stats.depth = Math.max(stats.depth, depth);
  if (Array.isArray(v)) {
    stats.arrays++;
    v.forEach((x) => walk(x, depth + 1, stats));
  } else if (v && typeof v === 'object' && !isRaw(v)) {
    stats.objects++;
    Object.values(v).forEach((x) => walk(x, depth + 1, stats));
  } else {
    stats.values++;
  }
}

function formatXml(text, { indent, minify }) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) {
    const msg = error.textContent.replace(/\s+/g, ' ').replace(/^This page contains the following errors: ?/, '').replace(/ ?Below is a rendering.*$/, '').trim();
    const e = new Error(msg.replace(/^error on line \d+ at column \d+: /, ''));
    const m = /line (\d+) at column (\d+)/.exec(msg);
    if (m) { e.line = Number(m[1]); e.column = Number(m[2]); }
    throw e;
  }
  const nl = minify ? '' : '\n';
  const pad = (d) => (minify ? '' : indent.repeat(d));
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
  let elements = 0;

  const ser = (node, d) => {
    switch (node.nodeType) {
      case Node.ELEMENT_NODE: {
        elements++;
        const attrs = [...node.attributes].map((a) => ` ${a.name}="${escAttr(a.value)}"`).join('');
        const kids = [...node.childNodes].filter((c) => !(c.nodeType === Node.TEXT_NODE && !c.nodeValue.trim()));
        if (!kids.length) return `${pad(d)}<${node.nodeName}${attrs}/>`;
        if (kids.length === 1 && kids[0].nodeType === Node.TEXT_NODE) return `${pad(d)}<${node.nodeName}${attrs}>${esc(kids[0].nodeValue.trim())}</${node.nodeName}>`;
        return `${pad(d)}<${node.nodeName}${attrs}>${nl}${kids.map((c) => ser(c, d + 1)).join(nl)}${nl}${pad(d)}</${node.nodeName}>`;
      }
      case Node.TEXT_NODE: return pad(d) + esc(node.nodeValue.trim());
      case Node.CDATA_SECTION_NODE: return `${pad(d)}<![CDATA[${node.nodeValue}]]>`;
      case Node.COMMENT_NODE: return `${pad(d)}<!--${node.nodeValue}-->`;
      case Node.PROCESSING_INSTRUCTION_NODE: return `${pad(d)}<?${node.target} ${node.data}?>`;
      case Node.DOCUMENT_TYPE_NODE: return `${pad(d)}<!DOCTYPE ${node.name}${node.publicId ? ` PUBLIC "${node.publicId}" "${node.systemId}"` : node.systemId ? ` SYSTEM "${node.systemId}"` : ''}>`;
      default: return '';
    }
  };
  const decl = /^\s*(<\?xml[^?]*\?>)/.exec(text)?.[1];
  const body = [...doc.childNodes].map((n) => ser(n, 0)).filter(Boolean).join(nl);
  return { text: (decl ? decl + nl : '') + body, summary: `${elements} elements` };
}
})();
