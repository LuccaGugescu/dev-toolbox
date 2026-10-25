'use strict';

// Byte-level encoding analysis. Runs in the main process (Node Buffers).
// Answers: "what encoding is this file really in?" and "which characters break
// when a Java runtime reads it as <target encoding>?"

// Windows-1252 bytes 0x80-0x9F that differ from ISO-8859-1 (where they are C1 controls).
const CP1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const CP1252_REVERSE = Object.fromEntries(Object.entries(CP1252).map(([b, cp]) => [cp, Number(b)]));

// Plain-ASCII stand-ins for characters that commonly sneak in from Word, Outlook, web pages.
const ASCII_LOOKALIKE = {
  0x2018: "'", 0x2019: "'", 0x201a: "'", 0x201b: "'", 0x2032: "'",
  0x201c: '"', 0x201d: '"', 0x201e: '"', 0x2033: '"',
  0x2013: '-', 0x2014: '-', 0x2212: '-', 0x2010: '-', 0x2011: '-',
  0x2026: '...', 0x2022: '*', 0x00a0: ' ', 0x2002: ' ', 0x2003: ' ', 0x2009: ' ', 0x202f: ' ',
  0x200b: '', 0x200c: '', 0x200d: '', 0x2060: '', 0xfeff: '', 0x00ad: '',
  0x20ac: 'EUR', 0x2122: '(TM)', 0x00a9: '(c)', 0x00ae: '(R)',
};

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

const CATEGORY_INFO = {
  'bom': { label: 'Byte Order Mark', severity: 'warning' },
  'utf16': { label: 'UTF-16 file', severity: 'error' },
  'invalid-utf8': { label: 'Invalid UTF-8', severity: 'error' },
  'mojibake': { label: 'Breaks as ISO-8859-1', severity: 'error' },
  'unmappable': { label: 'Not in ISO-8859-1', severity: 'error' },
  'c1-control': { label: 'Windows-1252 / C1 char', severity: 'error' },
  'replacement-char': { label: 'Already corrupted (\uFFFD)', severity: 'error' },
  'bidi': { label: 'Bidi control (Trojan Source)', severity: 'error' },
  'double-encoded': { label: 'Double-encoded UTF-8', severity: 'warning' },
  'invisible': { label: 'Invisible / look-alike', severity: 'warning' },
  'control-char': { label: 'Control character', severity: 'warning' },
};

/** Length of the valid UTF-8 sequence starting at buf[i], or 0 if invalid. */
function utf8SeqLength(buf, i) {
  const b0 = buf[i];
  const len = buf.length;
  const cont = (k) => i + k < len && (buf[i + k] & 0xc0) === 0x80;
  if (b0 < 0x80) return 1;
  if (b0 >= 0xc2 && b0 <= 0xdf) return cont(1) ? 2 : 0;
  if (b0 >= 0xe0 && b0 <= 0xef) {
    if (i + 2 >= len) return 0;
    const b1 = buf[i + 1];
    if (b0 === 0xe0 && (b1 < 0xa0 || b1 > 0xbf)) return 0;
    if (b0 === 0xed && (b1 < 0x80 || b1 > 0x9f)) return 0; // UTF-16 surrogates
    return cont(1) && cont(2) ? 3 : 0;
  }
  if (b0 >= 0xf0 && b0 <= 0xf4) {
    if (i + 3 >= len) return 0;
    const b1 = buf[i + 1];
    if (b0 === 0xf0 && (b1 < 0x90 || b1 > 0xbf)) return 0;
    if (b0 === 0xf4 && (b1 < 0x80 || b1 > 0x8f)) return 0;
    return cont(1) && cont(2) && cont(3) ? 4 : 0;
  }
  return 0;
}

function utf8CodePoint(buf, i, n) {
  if (n === 2) return ((buf[i] & 0x1f) << 6) | (buf[i + 1] & 0x3f);
  if (n === 3) return ((buf[i] & 0x0f) << 12) | ((buf[i + 1] & 0x3f) << 6) | (buf[i + 2] & 0x3f);
  return ((buf[i] & 0x07) << 18) | ((buf[i + 1] & 0x3f) << 12) | ((buf[i + 2] & 0x3f) << 6) | (buf[i + 3] & 0x3f);
}

function isLikelyBinary(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
  const end = Math.min(buf.length, 8000);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Guess the encoding of a buffer.
 * @returns {{encoding: 'ascii'|'utf-8'|'iso-8859-1'|'windows-1252'|'utf-16le'|'utf-16be', bom: boolean, mixed: boolean, validUtf8Seqs: number, invalidBytes: number}}
 */
function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const rest = detectEncoding(buf.subarray(3));
    return { ...rest, encoding: 'utf-8', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf-16le', bom: true, mixed: false, validUtf8Seqs: 0, invalidBytes: 0 };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'utf-16be', bom: true, mixed: false, validUtf8Seqs: 0, invalidBytes: 0 };

  let validUtf8Seqs = 0;
  let invalidBytes = 0;
  let c1Bytes = 0;
  for (let i = 0; i < buf.length;) {
    if (buf[i] < 0x80) { i++; continue; }
    const n = utf8SeqLength(buf, i);
    if (n) { validUtf8Seqs++; i += n; continue; }
    invalidBytes++;
    if (buf[i] >= 0x80 && buf[i] <= 0x9f) c1Bytes++;
    i++;
  }
  const mixed = validUtf8Seqs > 0 && invalidBytes > 0;
  let encoding;
  if (validUtf8Seqs === 0 && invalidBytes === 0) encoding = 'ascii';
  else if (validUtf8Seqs >= invalidBytes) encoding = 'utf-8';
  else encoding = c1Bytes > 0 ? 'windows-1252' : 'iso-8859-1';
  return { encoding, bom: false, mixed, validUtf8Seqs, invalidBytes };
}

const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const hexBytes = (buf, start, end) => Array.from(buf.subarray(start, end), hex2).join(' ');
const codePointLabel = (cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

/** Java/properties-style escape: \u00E9, or a surrogate pair for astral code points. */
function javaEscape(cp) {
  const s = String.fromCodePoint(cp);
  let out = '';
  for (let k = 0; k < s.length; k++) out += '\\u' + s.charCodeAt(k).toString(16).toUpperCase().padStart(4, '0');
  return out;
}

/** Make invisible/control chars readable inside a message. */
function visible(s) {
  return Array.from(s, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return `<${hex2(cp)}>`;
    return ch;
  }).join('');
}

function suggestionFor(cp) {
  const parts = [javaEscape(cp)];
  if (cp in ASCII_LOOKALIKE) {
    const r = ASCII_LOOKALIKE[cp];
    parts.push(r === '' ? 'or delete it' : `or ASCII "${r}"`);
  }
  return parts.join('  ');
}

// Text that was UTF-8, wrongly decoded as Latin-1/CP1252, then saved again as UTF-8: "Ã©" for "é".
const DOUBLE_ENCODED_RE = /(?:[\u00C2-\u00F4][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201A\u201C-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]{1,3})+/g;

function undoDoubleEncoding(s) {
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xff) bytes.push(cp);
    else if (cp in CP1252_REVERSE) bytes.push(CP1252_REVERSE[cp]);
    else return null;
  }
  const buf = Buffer.from(bytes);
  for (let i = 0; i < buf.length;) {
    const n = utf8SeqLength(buf, i);
    if (!n) return null;
    i += n;
  }
  const fixed = buf.toString('utf8');
  return fixed !== s ? fixed : null;
}

function repairDoubleEncoding(text) {
  return text.replace(DOUBLE_ENCODED_RE, (m) => undoDoubleEncoding(m) ?? m);
}

const SUSPICIOUS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00A0\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFFD]/g;

function classifySuspicious(cp, index) {
  if (cp === 0xfffd) return ['replacement-char', 'U+FFFD replacement character is in the file: the original character was already lost by an earlier wrong conversion.'];
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return ['bidi', 'Bidirectional control character: can make code display differently from how it compiles (CVE-2021-42574).'];
  if (cp === 0xfeff) return ['invisible', index === 0 ? 'Zero-width no-break space (BOM) at start of text.' : 'BOM (U+FEFF) in the middle of the file, usually from concatenating files. javac reports "illegal character: \'\\ufeff\'".'];
  if (cp < 0x20 || cp === 0x7f) return ['control-char', `ASCII control character ${hex2(cp)} (not tab/CR/LF).`];
  const names = { 0x00a0: 'No-break space', 0x00ad: 'Soft hyphen', 0x200b: 'Zero-width space', 0x200c: 'Zero-width non-joiner', 0x200d: 'Zero-width joiner', 0x200e: 'Left-to-right mark', 0x200f: 'Right-to-left mark', 0x2028: 'Line separator', 0x2029: 'Paragraph separator', 0x2060: 'Word joiner' };
  return ['invisible', `${names[cp] || 'Invisible character'}: looks like normal text but is a different character (breaks string compares, parsing, identifiers).`];
}

/**
 * Scan a buffer for characters that break when read with `target` encoding.
 * @param {Buffer} buf
 * @param {{source?: 'auto'|'utf-8'|'iso-8859-1'|'windows-1252', target?: 'iso-8859-1'|'utf-8', maxIssues?: number, collectText?: boolean}} [opts]
 */
function scan(buf, opts = {}) {
  const target = opts.target || 'iso-8859-1';
  const maxIssues = opts.maxIssues ?? 20000;
  const det = detectEncoding(buf);
  let source = !opts.source || opts.source === 'auto' ? det.encoding : opts.source;
  if (source === 'ascii') source = 'utf-8';

  const issues = [];
  const counts = { error: 0, warning: 0, info: 0 };
  const byCategory = {};
  const flagged = new Set();
  const add = (category, index, length, extra) => {
    const severity = CATEGORY_INFO[category].severity;
    counts[severity]++;
    byCategory[category] = (byCategory[category] || 0) + 1;
    flagged.add(index);
    if (issues.length < maxIssues) issues.push({ category, severity, index, length, ...(typeof extra === 'function' ? extra() : extra) });
  };

  const parts = [];
  let idx = 0;
  const push = (s) => { parts.push(s); idx += s.length; };
  let nonAscii = 0;

  if (source.startsWith('utf-16')) {
    const text = new TextDecoder(source).decode(buf);
    add('utf16', 0, 0, { char: '', codePoint: '', bytes: hexBytes(buf, 0, 2), message: `File is ${source.toUpperCase()} (BOM ${hexBytes(buf, 0, 2)}). Java reading it as ${target.toUpperCase()} sees every ASCII char followed by a NUL byte.`, suggestion: 'Re-save as UTF-8 (export below).' });
    return finish(text);
  }

  let i = 0;
  if (det.bom && source === 'utf-8') {
    i = 3;
    add('bom', 0, 0, { char: '', codePoint: 'U+FEFF', bytes: 'EF BB BF', message: target === 'iso-8859-1' ? 'UTF-8 BOM at file start. Read as ISO-8859-1 it becomes "ï»¿" at the start of the first line/key.' : 'UTF-8 BOM at file start. Java does NOT strip it: javac fails with "illegal character: \'\\ufeff\'", Properties gets a key prefixed with \\uFEFF.', suggestion: 'Save without BOM.' });
  }

  const len = buf.length;
  while (i < len) {
    if (buf[i] < 0x80) {
      let j = i + 1;
      while (j < len && buf[j] < 0x80) j++;
      push(buf.toString('latin1', i, j));
      i = j;
      continue;
    }
    nonAscii++;
    if (source === 'utf-8') {
      const n = utf8SeqLength(buf, i);
      if (!n) {
        const b = buf[i];
        const asLatin = String.fromCharCode(CP1252[b] ?? b);
        add('invalid-utf8', idx, 1, () => ({ char: asLatin, codePoint: '', bytes: hex2(b), message: `Byte ${hex2(b)} is not valid UTF-8 (probably "${visible(asLatin)}" saved as ISO-8859-1/Windows-1252 in a UTF-8 file). Java reads it as "\uFFFD".`, suggestion: `Re-type as UTF-8: ${javaEscape(CP1252[b] ?? b)}` }));
        push('\uFFFD');
        i++;
        continue;
      }
      const cp = utf8CodePoint(buf, i, n);
      const ch = String.fromCodePoint(cp);
      if (target === 'iso-8859-1') {
        // Detail builders run synchronously inside add(), only while under maxIssues.
        const readAs = () => visible(buf.toString('latin1', i, i + n));
        const bytes = () => hexBytes(buf, i, i + n);
        if (cp > 0xff) {
          add('unmappable', idx, ch.length, () => ({ char: ch, codePoint: codePointLabel(cp), bytes: bytes(), message: `"${ch}" ${codePointLabel(cp)} does not exist in ISO-8859-1. Read as ISO-8859-1 it shows "${readAs()}"; written as ISO-8859-1 it becomes "?".`, suggestion: suggestionFor(cp) }));
        } else {
          add('mojibake', idx, ch.length, () => ({ char: ch, codePoint: codePointLabel(cp), bytes: bytes(), message: `"${ch}" is ${n} bytes in UTF-8 (${bytes()}). Read as ISO-8859-1 it shows "${readAs()}".`, suggestion: `${suggestionFor(cp)}  or convert file to ISO-8859-1` }));
        }
      }
      push(ch);
      i += n;
    } else {
      const b = buf[i];
      const cp = source === 'windows-1252' && CP1252[b] ? CP1252[b] : b;
      const ch = String.fromCharCode(cp);
      if (target === 'utf-8') {
        add('invalid-utf8', idx, 1, () => {
          const n = utf8SeqLength(buf, i);
          const readAs = n > 1 ? buf.toString('utf8', i, i + n) : '\uFFFD';
          return { char: ch, codePoint: codePointLabel(cp), bytes: hex2(b), message: `"${visible(ch)}" is the single byte ${hex2(b)} in ${source.toUpperCase()}. Read as UTF-8 it becomes "${readAs}".`, suggestion: `${suggestionFor(cp)}  or convert file to UTF-8` };
        });
      } else if (b >= 0x80 && b <= 0x9f) {
        add('c1-control', idx, 1, () => ({ char: ch, codePoint: codePointLabel(cp), bytes: hex2(b), message: CP1252[b] ? `Byte ${hex2(b)} is "${ch}" in Windows-1252, but in ISO-8859-1 it is an invisible C1 control character.` : `Byte ${hex2(b)} is an invisible C1 control character in ISO-8859-1.`, suggestion: CP1252[b] ? suggestionFor(cp) : 'Delete it' }));
      }
      push(ch);
      i++;
    }
  }

  const text = parts.join('');
  for (const m of text.matchAll(SUSPICIOUS_RE)) {
    if (flagged.has(m.index)) continue;
    const cp = m[0].charCodeAt(0);
    const [category, message] = classifySuspicious(cp, m.index);
    add(category, m.index, 1, { char: m[0], codePoint: codePointLabel(cp), bytes: '', message, suggestion: suggestionFor(cp) });
  }
  for (const m of text.matchAll(DOUBLE_ENCODED_RE)) {
    const fixed = undoDoubleEncoding(m[0]);
    if (!fixed) continue;
    add('double-encoded', m.index, m[0].length, { char: m[0], codePoint: '', bytes: '', message: `"${visible(m[0])}" looks like "${fixed}" that was converted to UTF-8 twice.`, suggestion: `Replace with "${fixed}"` });
  }
  return finish(text);

  function finish(text) {
    const lineStarts = [0];
    for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) === 10) lineStarts.push(k + 1);
    for (const issue of issues) {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= issue.index) lo = mid; else hi = mid - 1;
      }
      issue.line = lo + 1;
      issue.column = issue.index - lineStarts[lo] + 1;
    }
    issues.sort((a, b) => a.index - b.index || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    return {
      detected: det,
      source,
      target,
      lines: lineStarts.length,
      nonAscii,
      counts,
      byCategory,
      totalIssues: counts.error + counts.warning + counts.info,
      truncated: counts.error + counts.warning + counts.info > issues.length,
      issues,
      text: opts.collectText === false ? undefined : text,
    };
  }
}

/** Decode a buffer to a JS string using a detected or forced encoding (BOM stripped). */
function decode(buf, source = 'auto') {
  const det = detectEncoding(buf);
  let enc = source === 'auto' ? det.encoding : source;
  if (enc === 'ascii') enc = 'utf-8';
  let text;
  if (enc === 'utf-8') text = buf.toString('utf8', det.bom ? 3 : 0);
  else if (enc.startsWith('utf-16')) text = new TextDecoder(enc).decode(buf);
  else if (enc === 'windows-1252') text = new TextDecoder('windows-1252').decode(buf);
  else text = buf.toString('latin1');
  return { text, encoding: enc, detected: det };
}

/**
 * Re-encode a file.
 * mode: 'utf-8' | 'iso-8859-1' (unmappable -> \uXXXX) | 'ascii-escape' (all non-ASCII -> \uXXXX)
 */
function convert(buf, { source = 'auto', mode = 'utf-8', repairDouble = false, cleanInvisible = false } = {}) {
  let { text } = decode(buf, source);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (repairDouble) text = repairDoubleEncoding(text);
  if (cleanInvisible) {
    text = text.replace(/[\u00A0\u00AD\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g, (c) => ASCII_LOOKALIKE[c.charCodeAt(0)] ?? '');
  }
  if (mode === 'utf-8') return Buffer.from(text, 'utf8');
  const limit = mode === 'iso-8859-1' ? 0xff : 0x7f;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    out += cp <= limit && !(cp >= 0x80 && cp <= 0x9f) ? ch : javaEscape(cp);
  }
  return Buffer.from(out, 'latin1');
}

module.exports = { scan, detectEncoding, decode, convert, isLikelyBinary, repairDoubleEncoding, CATEGORY_INFO };
