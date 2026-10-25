'use strict';

// Tool registry + shared helpers. A tool is:
//   Toolbox.register({ id, name, icon /* inline SVG string */, mount(container, monaco), onShow?() })
// mount() runs lazily the first time the tool is opened.
window.Toolbox = (() => {
  const tools = [];
  const mounted = new Map();
  let monaco = null;
  let active = null;

  const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

  function register(tool) {
    tools.push(tool);
  }

  function start(monacoInstance) {
    monaco = monacoInstance;
    monaco.editor.setTheme(isDark() ? 'vs-dark' : 'vs');
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      monaco.editor.setTheme(isDark() ? 'vs-dark' : 'vs');
    });

    const list = document.getElementById('tool-list');
    for (const tool of tools) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.dataset.tool = tool.id;
      btn.innerHTML = `<span class="icon">${tool.icon}</span>`;
      const label = document.createElement('span');
      label.textContent = tool.name;
      btn.append(label);
      btn.addEventListener('click', () => show(tool.id));
      li.append(btn);
      list.append(li);
    }
    document.querySelector('#tool-host .loading')?.remove();
    let last = null;
    try { last = localStorage.getItem('toolbox.lastTool'); } catch { /* storage unavailable */ }
    show(tools.some((t) => t.id === last) ? last : tools[0].id);
  }

  function show(id) {
    const tool = tools.find((t) => t.id === id);
    if (!tool || active === id) return;
    const host = document.getElementById('tool-host');
    if (!mounted.has(id)) {
      const container = document.createElement('section');
      container.className = 'tool-container';
      host.append(container);
      tool.mount(container, monaco);
      mounted.set(id, container);
    }
    for (const [toolId, el] of mounted) el.hidden = toolId !== id;
    for (const btn of document.querySelectorAll('#tool-list button')) btn.classList.toggle('active', btn.dataset.tool === id);
    active = id;
    try { localStorage.setItem('toolbox.lastTool', id); } catch { /* storage unavailable */ }
    tool.onShow?.();
  }

  /** Show a tool and hand it file paths (tools may define openPaths(paths) in mount). */
  function openIn(id, paths) {
    show(id);
    return tools.find((t) => t.id === id)?.openPaths?.(paths);
  }

  let toastTimer;
  function toast(message, kind = 'info') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = `show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 6000 : 3000);
  }

  /** Monaco language id for a file name, using Monaco's own extension table. */
  function languageForFile(fileName) {
    if (!monaco || !fileName) return 'plaintext';
    const lower = fileName.toLowerCase();
    const base = lower.split(/[\\/]/).pop();
    let best = null;
    for (const lang of monaco.languages.getLanguages()) {
      if (lang.filenames?.some((f) => f.toLowerCase() === base)) return lang.id;
      for (const ext of lang.extensions || []) {
        if (lower.endsWith(ext.toLowerCase()) && (!best || ext.length > best.ext.length)) best = { id: lang.id, ext };
      }
    }
    return best ? best.id : 'plaintext';
  }

  /** Build an element: h('div.cls', {attr}, ...children). */
  function h(tag, attrs, ...children) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name);
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  return { register, start, show, openIn, toast, languageForFile, h, get monaco() { return monaco; } };
})();
