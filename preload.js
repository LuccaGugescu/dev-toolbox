'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile: (opts) => ipcRenderer.invoke('dialog:open-file', opts),
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  readTextFile: (path) => ipcRenderer.invoke('file:read-text', path),
  isDirectory: (path) => ipcRenderer.invoke('file:is-directory', path),
  pathForFile: (file) => webUtils.getPathForFile(file),

  computeHashes: (opts) => ipcRenderer.invoke('hash:compute', opts),

  scanPaths: (opts) => ipcRenderer.invoke('encoding:scan-paths', opts),
  scanFile: (opts) => ipcRenderer.invoke('encoding:scan-file', opts),
  exportConverted: (opts) => ipcRenderer.invoke('encoding:export', opts),
  onScanProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('encoding:progress', listener);
    return () => ipcRenderer.removeListener('encoding:progress', listener);
  },
});
