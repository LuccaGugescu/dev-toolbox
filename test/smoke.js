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

      // Helpers evaluated in the page: the visible tool container, its status text, input setters.
      await run(`
        window.$vis = () => document.querySelector('.tool-container:not([hidden])');
        window.$status = () => $vis().querySelector('.status').textContent;
        window.$type = (sel, value, i = 0) => { const el = $vis().querySelectorAll(sel)[i]; el.value = value; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
        window.$editor = () => monaco.editor.getEditors().find((e) => $vis().contains(e.getContainerDomNode()) && !e.getOption(monaco.editor.EditorOption.readOnly));
        window.$output = () => monaco.editor.getEditors().find((e) => $vis().contains(e.getContainerDomNode()) && e.getOption(monaco.editor.EditorOption.readOnly)).getValue();
        true`);
      const check = (name, actual, ok) => {
        console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}: ${String(actual).slice(0, 160).replace(/\n/g, '\\n')}`);
        if (!ok) process.exitCode = 1;
      };
      const shot = async (name) => fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());

      await run(`Toolbox.show('format'); $vis().querySelector('input[type=checkbox]').click(); $editor().setValue('{"id": 9007199254740993, "b": [1, 2, {"c": true}], "a": "x"}'); true`);
      await wait(600);
      let out = await run('$output()');
      check('json keeps 64-bit id + sorts keys', out, out.includes('9007199254740993') && out.indexOf('"a"') < out.indexOf('"b"'));
      check('json status', await run('$status()'), (await run('$status()')).startsWith('✓ Valid JSON'));
      await shot('format-json');
      await run(`$editor().setValue('{\\n  "a": 1,\\n}'); true`);
      await wait(600);
      check('json error position', await run('$status()'), /line 3/.test(await run('$status()')));
      await run(`$editor().setValue('<?xml version="1.0"?><a><b x="1">t</b><c/></a>'); true`);
      await wait(600);
      out = await run('$output()');
      check('xml pretty', out, out.includes('\n  <b x="1">t</b>') && out.startsWith('<?xml'));

      await run(`Toolbox.show('codec'); $type('textarea', 'Olá €'); true`);
      await wait(300);
      check('base64 encode utf-8', await run(`$vis().querySelectorAll('textarea')[1].value`), (await run(`$vis().querySelectorAll('textarea')[1].value`)) === 'T2zDoSDigqw=');
      await run(`$vis().querySelector('[data-dir=decode]').click(); $type('textarea', 'T2zDoSDigqw='); true`);
      await wait(300);
      check('base64 decode', await run(`$vis().querySelectorAll('textarea')[1].value`), (await run(`$vis().querySelectorAll('textarea')[1].value`)) === 'Olá €');
      await shot('codec');

      const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const signingInput = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: '42', name: 'Ana', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
      const jwt = `${signingInput}.${require('node:crypto').createHmac('sha256', 'my-secret').update(signingInput).digest('base64url')}`;
      await run(`Toolbox.show('jwt'); $type('textarea', ${js('Bearer ' + jwt)}); true`);
      await wait(400);
      check('jwt decode', await run('$status()'), (await run('$status()')).startsWith('✓ Decoded · HS256'));
      await run(`$type('textarea', 'wrong', 1); true`);
      await wait(500);
      check('jwt wrong secret', await run(`$vis().querySelector('.claim-bad')?.textContent`), !!(await run(`$vis().querySelector('.claim-bad')?.textContent`)));
      await run(`$type('textarea', 'my-secret', 1); true`);
      await wait(500);
      check('jwt verify', await run(`$vis().querySelector('.section .claim-good')?.textContent`), (await run(`$vis().querySelector('.section .claim-good')?.textContent`)) === '✓ Signature verified');
      await shot('jwt');

      await run(`Toolbox.show('hash'); $type('textarea', 'abc'); true`);
      await wait(600);
      console.log('[hash status]', await run('$status()'));
      const sha = await run(`[...$vis().querySelectorAll('.kv .v')][3].textContent`);
      check('sha256(abc)', sha, sha === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      await run(`$type('input.code', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 1); true`);
      await wait(200);
      check('hash compare', await run(`$vis().querySelector('.claim-good')?.textContent`), (await run(`$vis().querySelector('.claim-good')?.textContent`)) === '✓ Matches SHA-256');
      await shot('hash');

      await run(`Toolbox.show('time'); $type('input.code', '1717000000'); true`);
      await wait(300);
      const iso = await run(`[...$vis().querySelectorAll('.kv .v')][2].textContent`);
      check('epoch seconds -> ISO', iso, iso === '2024-05-29T16:26:40.000Z');
      await run(`$type('input.code', '1717000000123456'); true`);
      await wait(300);
      check('microseconds detected', await run('$status()'), (await run('$status()')).includes('microseconds'));
      await shot('time');

      await run(`Toolbox.show('regex'); true`);
      await wait(500);
      check('regex matches', await run('$status()'), (await run('$status()')) === '3 matches');
      check('regex named groups', await run(`$vis().querySelector('.match-row .grp')?.textContent`), (await run(`$vis().querySelector('.match-row .grp')?.textContent`)) === '1 <user>: "alice.smith"');
      check('regex java', await run(`$vis().querySelectorAll('pre.code')[1].textContent`), (await run(`$vis().querySelectorAll('pre.code')[1].textContent`)).includes('Pattern.compile("(?<user>[\\\\w.]+)'));
      await shot('regex');

      check('sidebar groups', await run(`[...document.querySelectorAll('#tool-list .group-label')].map((e) => e.textContent).join(',')`), (await run(`[...document.querySelectorAll('#tool-list .group-label')].map((e) => e.textContent).join(',')`)) === 'General,Database,Backend');

      await run(`Toolbox.show('sql-format'); $editor().setValue('select a, b from t where x = ? and y = :name'); $type('textarea.code', '5\\nname=O\\'x'); true`);
      await wait(600);
      out = await run('$output()');
      check('sql format + binds', out, out.startsWith('SELECT\n  a,\n  b\nFROM') && out.includes("x = 5") && out.includes("y = 'O''x'"));
      await shot('sql-format');

      await run(`Toolbox.show('explain'); $editor().setValue(${js(fs.readFileSync(path.join(samples, 'explain', 'postgres-analyze.txt'), 'utf8'))}); true`);
      await wait(700);
      check('explain findings', await run('$status()'), /PostgreSQL plan · \d+ nodes · [1-9]\d* problems/.test(await run('$status()')));
      check('explain tree rows', await run(`$vis().querySelectorAll('.ex-row:not(.ex-head)').length`), (await run(`$vis().querySelectorAll('.ex-row:not(.ex-head)').length`)) >= 4);
      await shot('explain');

      await run(`Toolbox.show('sql-convert'); $editor().setValue('select NVL(a, 0), SYSDATE from orders where rownum <= 5'); true`);
      await wait(600);
      out = await run('$output()');
      check('oracle -> pg', out, out === 'select COALESCE(a, 0), LOCALTIMESTAMP(0) from orders where rownum <= 5');
      check('oracle -> pg warnings', await run(`$vis().querySelectorAll('.conv-warning').length`), (await run(`$vis().querySelectorAll('.conv-warning').length`)) === 1);
      await shot('sql-convert');

      await run(`Toolbox.show('data-sql'); $editor().setValue('id\\tname\\n1\\tAna\\n2\\tBo'); true`);
      await wait(600);
      out = await run('$output()');
      check('data -> sql', out, out === "INSERT INTO my_table (id, name) VALUES\n  (1, 'Ana'),\n  (2, 'Bo');");
      await shot('data-sql');

      await run(`Toolbox.show('conn'); $type('input.code', 'jdbc:oracle:thin:@//ora.example.com:1521/ORCLPDB1'); true`);
      await wait(500);
      check('conn parse', await run('$status()'), (await run('$status()')).startsWith('✓ Parsed as Oracle'));
      check('conn outputs', await run(`$vis().querySelector('.conn-item pre').textContent`), (await run(`$vis().querySelector('.conn-item pre').textContent`)) === 'jdbc:oracle:thin:@//ora.example.com:1521/ORCLPDB1');
      await shot('conn');

      await run(`Toolbox.show('db-errors'); $type('textarea', 'ERROR: duplicate key value violates unique constraint "users_email_key"'); true`);
      await wait(500);
      check('db error lookup', await run(`$vis().querySelector('.err-code')?.textContent`), (await run(`$vis().querySelector('.err-code')?.textContent`)) === '23505');
      await shot('db-errors');

      await run(`Toolbox.show('cron'); $type('input.code', '0 0/30 8-18 ? * MON-FRI'); true`);
      await wait(400);
      check('cron describe', await run(`$vis().querySelector('.cron-desc').textContent`), (await run(`$vis().querySelector('.cron-desc').textContent`)) === 'Every 30 minutes between 08:00 and 18:59, on Monday through Friday');
      check('cron next runs', await run(`$vis().querySelectorAll('.cron-run').length`), (await run(`$vis().querySelectorAll('.cron-run').length`)) === 12);
      await shot('cron');

      await run(`Toolbox.show('ids'); true`);
      await wait(300);
      const firstId = await run(`$vis().querySelector('textarea').value.split('\\n')[0]`);
      check('uuid v7 generated', firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(firstId));
      check('uuid inspected', await run(`$vis().querySelector('.kv .v').textContent`), (await run(`$vis().querySelector('.kv .v').textContent`)).startsWith('7 '));
      await shot('ids');
      console.log('[smoke] done');
    } catch (err) {
      console.error('[smoke] FAILED', err);
      process.exitCode = 1;
    }
    app.quit();
  });
});

require('../main.js');
