'use strict';

const assert = require('node:assert/strict');
const { scan, detectEncoding, convert, repairDoubleEncoding } = require('../src/core/encoding');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const cats = (r) => r.issues.map((i) => i.category);

test('pure ASCII is clean for both targets', () => {
  const buf = Buffer.from('public class A { int x = 1; }\n');
  assert.equal(detectEncoding(buf).encoding, 'ascii');
  assert.equal(scan(buf, { target: 'iso-8859-1' }).totalIssues, 0);
  assert.equal(scan(buf, { target: 'utf-8' }).totalIssues, 0);
});

test('UTF-8 accents break when read as ISO-8859-1', () => {
  const buf = Buffer.from('msg=Olá\nb=ok\n', 'utf8');
  const r = scan(buf, { target: 'iso-8859-1' });
  assert.equal(r.source, 'utf-8');
  assert.deepEqual(cats(r), ['mojibake']);
  assert.equal(r.issues[0].line, 1);
  assert.equal(r.issues[0].column, 7);
  assert.equal(r.issues[0].bytes, 'C3 A1');
  assert.match(r.issues[0].message, /Ã¡/);
});

test('UTF-8 file is clean when read as UTF-8', () => {
  assert.equal(scan(Buffer.from('Olá ação\n', 'utf8'), { target: 'utf-8' }).totalIssues, 0);
});

test('chars outside ISO-8859-1 are unmappable', () => {
  const r = scan(Buffer.from('price = "10 €" “quoted”', 'utf8'), { target: 'iso-8859-1' });
  assert.deepEqual(cats(r), ['unmappable', 'unmappable', 'unmappable']);
  assert.match(r.issues[0].suggestion, /\\u20AC/);
});

test('ISO-8859-1 file read as UTF-8 flags each high byte', () => {
  const buf = Buffer.from('nome=João\n', 'latin1');
  assert.equal(detectEncoding(buf).encoding, 'iso-8859-1');
  const r = scan(buf, { target: 'utf-8' });
  assert.deepEqual(cats(r), ['invalid-utf8']);
  assert.equal(r.issues[0].bytes, 'E3');
  assert.equal(scan(buf, { target: 'iso-8859-1' }).totalIssues, 0);
});

test('Windows-1252 smart quotes are C1 controls in ISO-8859-1', () => {
  const buf = Buffer.from([0x61, 0x93, 0x62, 0x94]);
  assert.equal(detectEncoding(buf).encoding, 'windows-1252');
  const r = scan(buf, { target: 'iso-8859-1' });
  assert.deepEqual(cats(r), ['c1-control', 'c1-control']);
  assert.equal(r.issues[0].char, '“');
});

test('mixed file: mostly UTF-8 with one Latin-1 byte', () => {
  const buf = Buffer.concat([Buffer.from('ação ', 'utf8'), Buffer.from([0xe9]), Buffer.from('\n')]);
  const d = detectEncoding(buf);
  assert.equal(d.encoding, 'utf-8');
  assert.equal(d.mixed, true);
  const r = scan(buf, { target: 'utf-8' });
  assert.deepEqual(cats(r), ['invalid-utf8']);
});

test('BOM is reported', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('class A {}')]);
  const r = scan(buf, { target: 'utf-8' });
  assert.deepEqual(cats(r), ['bom']);
  assert.equal(r.text, 'class A {}');
});

test('double-encoded UTF-8 is detected and repairable', () => {
  const r = scan(Buffer.from('nome=JoÃ£o e cafÃ©', 'utf8'), { target: 'utf-8' });
  assert.deepEqual(cats(r), ['double-encoded', 'double-encoded']);
  assert.equal(repairDoubleEncoding('JoÃ£o cafÃ© donâ€™t'), 'João café don’t');
});

test('invisible and bidi characters are flagged', () => {
  const r = scan(Buffer.from('a b​c‮d�', 'utf8'), { target: 'utf-8' });
  assert.deepEqual(cats(r), ['invisible', 'invisible', 'bidi', 'replacement-char']);
});

test('line/column positions across lines', () => {
  const r = scan(Buffer.from('line1\nabé\nç', 'utf8'), { target: 'iso-8859-1' });
  assert.deepEqual(r.issues.map((i) => [i.line, i.column]), [[2, 3], [3, 1]]);
});

test('convert: UTF-8 -> ISO-8859-1 with escapes', () => {
  const out = convert(Buffer.from('﻿Olá €', 'utf8'), { mode: 'iso-8859-1' });
  assert.deepEqual([...out], [...Buffer.from('Olá \\u20AC', 'latin1')]);
});

test('convert: ISO-8859-1 -> UTF-8', () => {
  const out = convert(Buffer.from('João', 'latin1'), { mode: 'utf-8' });
  assert.equal(out.toString('utf8'), 'João');
});

test('convert: ASCII escapes incl. astral chars', () => {
  const out = convert(Buffer.from('é😀', 'utf8'), { mode: 'ascii-escape' });
  assert.equal(out.toString('latin1'), '\\u00E9\\uD83D\\uDE00');
});

test('large file scans fast', () => {
  const line = 'String s = "Configuração inválida — ação necessária";\n';
  const buf = Buffer.from(line.repeat(100000), 'utf8');
  const t0 = performance.now();
  const r = scan(buf, { target: 'iso-8859-1' });
  const ms = performance.now() - t0;
  assert.ok(r.totalIssues >= 600000);
  assert.ok(ms < 5000, `took ${ms} ms`);
  console.log(`    (${(buf.length / 1e6).toFixed(1)} MB, ${r.totalIssues.toLocaleString()} issues in ${Math.round(ms)} ms)`);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message.split('\n').join('\n       ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
