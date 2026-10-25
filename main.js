'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const encoding = require('./src/core/encoding');

// Serve the app from app://local/ instead of file:// so Monaco's web workers are allowed.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', 'target', 'build', 'dist', 'out', '.idea', '.gradle', '.vs', 'bin', 'obj']);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    title: 'Dev Toolbox',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('app://local/src/renderer/index.html');
}

async function readTextFile(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const buf = await fs.readFile(filePath);
  if (encoding.isLikelyBinary(buf)) throw new Error('File looks binary');
  const { text, encoding: enc, detected } = encoding.decode(buf);
  return { path: filePath, name: path.basename(filePath), text, encoding: enc, bom: detected.bom, mixed: detected.mixed };
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function extensionFilter(extensions) {
  const list = (extensions || '').split(/[\s,;]+/).map((x) => x.replace(/^\*?\./, '').toLowerCase()).filter(Boolean);
  if (list.length === 0 || list.includes('*')) return () => true;
  const set = new Set(list);
  return (file) => set.has(path.extname(file).slice(1).toLowerCase()) || set.has(path.basename(file).toLowerCase());
}

async function summarizeFile(file, root, opts) {
  const base = { path: file, relative: root ? path.relative(root, file) : path.basename(file) };
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_FILE_BYTES) return { ...base, skipped: 'too large' };
    const buf = await fs.readFile(file);
    if (encoding.isLikelyBinary(buf)) return { ...base, skipped: 'binary' };
    const r = encoding.scan(buf, { ...opts, maxIssues: 0, collectText: false });
    return { ...base, size: stat.size, encoding: r.detected.encoding, bom: r.detected.bom, mixed: r.detected.mixed, counts: r.counts, byCategory: r.byCategory, totalIssues: r.totalIssues };
  } catch (err) {
    return { ...base, skipped: err.message };
  }
}

// Electron's Node is built on BoringSSL, which has no SHA-3.
const HASH_ALGORITHMS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];

/** Hex digests of text (UTF-8) or a file, for every algorithm; HMAC when a key is given. */
async function computeHashes({ text, path: filePath, hmacKey }) {
  const hashers = HASH_ALGORITHMS.map((alg) => (hmacKey ? crypto.createHmac(alg, hmacKey) : crypto.createHash(alg)));
  let size;
  if (filePath != null) {
    for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
      for (const hsh of hashers) hsh.update(chunk);
    }
    size = (await fs.stat(filePath)).size;
  } else {
    const buf = Buffer.from(text ?? '', 'utf8');
    for (const hsh of hashers) hsh.update(buf);
    size = buf.length;
  }
  return { size, digests: Object.fromEntries(HASH_ALGORITHMS.map((alg, i) => [alg, hashers[i].digest('hex')])) };
}

function registerIpc() {
  ipcMain.handle('hash:compute', (_e, opts) => computeHashes(opts));

  ipcMain.handle('dialog:open-file', async (e, { title, multi } = {}) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title,
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('dialog:open-folder', async (e) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('file:read-text', (_e, filePath) => readTextFile(filePath));

  ipcMain.handle('file:is-directory', async (_e, p) => {
    try {
      return (await fs.stat(p)).isDirectory();
    } catch {
      return false;
    }
  });

  // Scan a set of files and/or folders; streams progress back to the renderer.
  ipcMain.handle('encoding:scan-paths', async (e, { paths, extensions, source, target }) => {
    const accept = extensionFilter(extensions);
    const results = [];
    let scanned = 0;
    for (const p of paths) {
      let isDir = false;
      try {
        isDir = (await fs.stat(p)).isDirectory();
      } catch {
        results.push({ path: p, relative: p, skipped: 'not found' });
        continue;
      }
      if (!isDir) {
        results.push(await summarizeFile(p, null, { source, target }));
        continue;
      }
      for await (const file of walk(p)) {
        if (!accept(file)) continue;
        results.push(await summarizeFile(file, path.dirname(p), { source, target }));
        if (++scanned % 50 === 0) e.sender.send('encoding:progress', { scanned, current: file });
      }
    }
    return results;
  });

  ipcMain.handle('encoding:scan-file', async (_e, { path: filePath, source, target }) => {
    const buf = await fs.readFile(filePath);
    return { path: filePath, name: path.basename(filePath), categories: encoding.CATEGORY_INFO, ...encoding.scan(buf, { source, target }) };
  });

  ipcMain.handle('encoding:export', async (e, { path: filePath, source, mode, repairDouble, cleanInvisible }) => {
    const buf = await fs.readFile(filePath);
    const out = encoding.convert(buf, { source, mode, repairDouble, cleanInvisible });
    const ext = path.extname(filePath);
    const suffix = { 'utf-8': 'utf8', 'iso-8859-1': 'iso', 'ascii-escape': 'escaped' }[mode];
    const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Save converted copy',
      defaultPath: path.join(path.dirname(filePath), `${path.basename(filePath, ext)}.${suffix}${ext}`),
    });
    if (res.canceled || !res.filePath) return null;
    await fs.writeFile(res.filePath, out);
    return res.filePath;
  });
}

// Must match build.appId so the taskbar groups the window with its installed shortcut.
app.setAppUserModelId('com.luccagugescu.devtoolbox');

// A second launch focuses the existing window instead of opening another app instance.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const target = path.normalize(path.join(__dirname, decodeURIComponent(pathname)));
    if (!target.startsWith(__dirname)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]));
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
