'use strict';

// Launches the real app, drives both tools with the sample files, saves screenshots, then quits.
// Usage: npx electron test/smoke.js <output-dir>
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, 'smoke-out'));
const samples = path.join(__dirname, '..', 'samples');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (s) => JSON.stringify(s);

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (_ev, level, message) => console.log(`[renderer:${level}] ${message}`));
  win.webContents.once('did-finish-load', async () => {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const run = (code) => win.webContents.executeJavaScript(code);
      for (let i = 0; i < 50 && !(await run('!!window.monaco && !!document.querySelector("#tool-list button")')); i++) await wait(200);

      await run(`Toolbox.openIn('diff', [${js(path.join(samples, 'OrderService.old.java'))}, ${js(path.join(samples, 'OrderService.new.java'))}])`);
      await wait(1500);
      console.log('[diff stats]', await run('document.querySelector(".diff-stats").textContent'));
      console.log('[diff language]', await run('monaco.editor.getModels()[0].getLanguageId()'));
      fs.writeFileSync(path.join(outDir, 'diff.png'), (await win.webContents.capturePage()).toPNG());

      await run(`Toolbox.openIn('encoding', [${js(path.join(samples, 'encoding'))}])`);
      await wait(1500);
      console.log('[enc status]', await run('document.querySelector(".tool-container:not([hidden]) .toolbar > span.muted").textContent'));
      console.log('[enc files]', await run('[...document.querySelectorAll(".enc-file")].map(e => e.innerText.replace(/\\s+/g, " ")).join(" | ")'));
      console.log('[enc chips]', await run('document.querySelector(".enc-chips").innerText.replace(/\\s+/g, " ")'));
      fs.writeFileSync(path.join(outDir, 'encoding-iso.png'), (await win.webContents.capturePage()).toPNG());

      await run(`(() => { const s = document.querySelectorAll('.tool-container:not([hidden]) .toolbar select')[1]; s.value = 'utf-8'; s.dispatchEvent(new Event('change')); })()`);
      await wait(1500);
      console.log('[enc utf-8 status]', await run('document.querySelector(".tool-container:not([hidden]) .toolbar > span.muted").textContent'));
      fs.writeFileSync(path.join(outDir, 'encoding-utf8.png'), (await win.webContents.capturePage()).toPNG());
      console.log('[smoke] done');
    } catch (err) {
      console.error('[smoke] FAILED', err);
      process.exitCode = 1;
    }
    app.quit();
  });
});

require('../main.js');
