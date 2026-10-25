'use strict';

// Load Monaco (AMD build), then start the toolbox.
// Absolute URL: Monaco's web workers resolve it with importScripts, which rejects relative paths.
require.config({ paths: { vs: new URL('../../node_modules/monaco-editor/min/vs', location.href).href } });
require(['vs/editor/editor.main'], () => Toolbox.start(window.monaco));

// Dropping a file anywhere outside a drop zone must not navigate the window away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
