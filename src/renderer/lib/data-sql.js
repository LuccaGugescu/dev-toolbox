'use strict';

// Data -> SQL: turns CSV / TSV / JSON / a plain list into INSERT, multi-row INSERT, UPSERT / MERGE,
// UPDATE, DELETE, IN lists (Oracle's 1000-item limit handled), VALUES CTEs and CREATE TABLE,
// for PostgreSQL or Oracle. Column types are inferred from the data.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DataSql = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // ---------- parsing ----------
  function parseCsv(text, delimiter) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    let wasQuoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && cell === '') { quoted = true; wasQuoted = true; }
      else if (c === delimiter) { row.push(cellValue(cell, wasQuoted)); cell = ''; wasQuoted = false; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cellValue(cell, wasQuoted));
        rows.push(row);
        row = [];
        cell = '';
        wasQuoted = false;
      } else cell += c;
    }
    if (cell !== '' || row.length || wasQuoted) {
      row.push(cellValue(cell, wasQuoted));
      rows.push(row);
    }
    return rows.filter((r) => !(r.length === 1 && r[0].text === ''));
  }
  // Quoted cells stay strings even when they look like numbers ("007").
  const cellValue = (text, quoted) => ({ text: quoted ? text : text.trim(), quoted });

  function detectDelimiter(text) {
    const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
    const counts = ['\t', ';', ',', '|'].map((d) => [d, sample.split(d).length - 1]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : null;
  }

  /**
   * Returns { columns: [name], rows: [[value]], format } where a value is
   * null | string | number | boolean, plus { quoted } info used for type inference.
   */
  function parseInput(text, { format = 'auto', header = 'auto' } = {}) {
    const t = text.trim();
    if (!t) return { columns: [], rows: [], format: 'empty' };
    if (format === 'json' || (format === 'auto' && /^[[{]/.test(t))) {
      let data;
      try {
        data = JSON.parse(t);
      } catch (err) {
        throw new Error(`Invalid JSON: ${err.message}`);
      }
      if (!Array.isArray(data)) data = [data];
      if (data.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
        const columns = [...new Set(data.flatMap((r) => Object.keys(r)))];
        return { columns, rows: data.map((r) => columns.map((c) => jsonValue(r[c]))), format: 'json' };
      }
      if (data.every(Array.isArray)) {
        const width = Math.max(...data.map((r) => r.length));
        return { columns: Array.from({ length: width }, (_, i) => `col${i + 1}`), rows: data.map((r) => r.map(jsonValue)), format: 'json' };
      }
      return { columns: ['value'], rows: data.map((v) => [jsonValue(v)]), format: 'json' };
    }
    const delimiter = format === 'list' ? null : detectDelimiter(t);
    const cells = delimiter ? parseCsv(t, delimiter) : t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => [cellValue(l.replace(/,$/, ''), false)]);
    const width = Math.max(...cells.map((r) => r.length));
    const useHeader = header === 'yes' || (header === 'auto' && looksLikeHeader(cells));
    const columns = useHeader
      ? Array.from({ length: width }, (_, i) => (cells[0][i]?.text || `col${i + 1}`))
      : Array.from({ length: width }, (_, i) => (width === 1 ? 'value' : `col${i + 1}`));
    const body = useHeader ? cells.slice(1) : cells;
    return {
      columns,
      rows: body.map((r) => Array.from({ length: width }, (_, i) => (r[i] ? textValue(r[i]) : null))),
      format: delimiter ? { '\t': 'tsv', ',': 'csv', ';': 'csv (;)', '|': 'psv' }[delimiter] : 'list',
    };
  }

  function looksLikeHeader(cells) {
    if (cells.length < 2) return false;
    const first = cells[0];
    if (!first.every((c) => /^[A-Za-z_][\w .-]*$/.test(c.text))) return false;
    if (first.length > 1) return true;
    // Single column: a header only if the rest are clearly a different kind (e.g. numbers).
    return cells.slice(1).every((r) => /^-?\d+(\.\d+)?$/.test(r[0]?.text || ''));
  }

  // JSON strings behave like quoted CSV cells: "007" stays text, ISO dates are still recognised.
  const jsonValue = (v) => (v === undefined || v === null ? null
    : typeof v === 'object' ? { json: JSON.stringify(v) }
      : typeof v === 'string' ? { text: v, quoted: true } : v);
  const textValue = (c) => ({ text: c.text, quoted: c.quoted });

  // ---------- types ----------
  const RE = {
    int: /^-?(0|[1-9]\d*)$/,
    dec: /^-?(0|[1-9]\d*)?\.\d+$|^-?(0|[1-9]\d*)\.\d*$/,
    bool: /^(true|false)$/i,
    date: /^\d{4}-\d{2}-\d{2}$/,
    ts: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  };

  function kindOf(v, emptyAsNull) {
    if (v === null) return 'null';
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'dec';
    if (typeof v === 'boolean') return 'bool';
    if (v.json != null) return 'json';
    const s = v.text;
    if (s === '' && emptyAsNull) return 'null';
    if (/^null$/i.test(s) && !v.quoted) return 'null';
    if (v.quoted) return RE.ts.test(s) ? 'ts' : RE.date.test(s) ? 'date' : RE.uuid.test(s) ? 'uuid' : 'text';
    for (const k of ['int', 'dec', 'bool', 'date', 'ts', 'uuid']) if (RE[k].test(s)) return k;
    return 'text';
  }

  function inferColumns(parsed, { emptyAsNull = true } = {}) {
    return parsed.columns.map((name, i) => {
      const kinds = new Set();
      let maxLen = 0;
      let maxAbs = 0;
      let scale = 0;
      let nulls = 0;
      for (const r of parsed.rows) {
        const v = r[i];
        const k = kindOf(v, emptyAsNull);
        if (k === 'null') { nulls++; continue; }
        kinds.add(k);
        const s = typeof v === 'object' && v ? (v.text ?? v.json) : String(v);
        maxLen = Math.max(maxLen, [...s].length);
        if (k === 'int' || k === 'dec') {
          maxAbs = Math.max(maxAbs, Math.abs(Number(s)));
          scale = Math.max(scale, (s.split('.')[1] || '').length);
        }
      }
      let kind = 'text';
      if (kinds.size === 0) kind = 'text';
      else if (kinds.size === 1) kind = [...kinds][0];
      else if ([...kinds].every((k) => k === 'int' || k === 'dec')) kind = 'dec';
      else if ([...kinds].every((k) => k === 'date' || k === 'ts')) kind = 'ts';
      // Leading zeros (zip codes, ids like 007) must stay text.
      if (kind === 'int' && parsed.rows.some((r) => r[i] && typeof r[i] === 'object' && /^-?0\d/.test(r[i].text || ''))) kind = 'text';
      return { name, kind, maxLen, maxAbs, scale, nullable: nulls > 0 };
    });
  }

  function sqlType(col, dialect) {
    const ora = dialect === 'oracle';
    switch (col.kind) {
      case 'int':
        if (col.maxAbs < 2147483648) return ora ? 'NUMBER(10)' : 'integer';
        return ora ? 'NUMBER(19)' : 'bigint';
      case 'dec': {
        const intDigits = Math.max(1, String(Math.floor(col.maxAbs)).length);
        const p = Math.min(38, intDigits + col.scale + 2);
        return ora ? `NUMBER(${p}, ${col.scale})` : `numeric(${p}, ${col.scale})`;
      }
      case 'bool': return ora ? 'NUMBER(1)' : 'boolean';
      case 'date': return ora ? 'DATE' : 'date';
      case 'ts': return ora ? 'TIMESTAMP' : 'timestamp';
      case 'uuid': return ora ? 'VARCHAR2(36 CHAR)' : 'uuid';
      case 'json': return ora ? 'CLOB CHECK (%c IS JSON)' : 'jsonb';
      default: {
        const n = Math.max(1, col.maxLen);
        if (ora) return n > 4000 ? 'CLOB' : `VARCHAR2(${roundUp(n)} CHAR)`;
        return n > 1000 ? 'text' : `varchar(${roundUp(n)})`;
      }
    }
  }
  const roundUp = (n) => [10, 20, 50, 100, 255, 500, 1000, 2000, 4000].find((x) => x >= n) || n;

  function literal(v, col, dialect, emptyAsNull) {
    const ora = dialect === 'oracle';
    const k = kindOf(v, emptyAsNull);
    if (k === 'null') return 'NULL';
    const s = typeof v === 'object' ? (v.text ?? v.json) : String(v);
    const str = (x) => `'${x.replace(/'/g, "''")}'`;
    switch (col.kind) {
      case 'int': case 'dec': return k === 'int' || k === 'dec' ? s : str(s);
      case 'bool': return ora ? (/^true$/i.test(s) ? '1' : '0') : s.toUpperCase();
      case 'date': return k === 'date' ? `DATE ${str(s)}` : str(s);
      case 'ts': {
        if (k === 'date') return ora ? `DATE ${str(s)}` : `DATE ${str(s)}`;
        if (k !== 'ts') return str(s);
        const norm = s.replace('T', ' ').replace(/Z$/, ' +00:00').replace(/([+-]\d{2})(\d{2})$/, ' $1:$2');
        // Oracle reads an offset in a TIMESTAMP literal as TIMESTAMP WITH TIME ZONE; PostgreSQL would drop it.
        return /[+-]\d{2}:\d{2}$/.test(norm) && !ora ? `TIMESTAMPTZ ${str(norm)}` : `TIMESTAMP ${str(norm)}`;
      }
      case 'uuid': return ora ? str(s) : `${str(s)}::uuid`;
      case 'json': return ora ? str(s) : `${str(s)}::jsonb`;
      default: return str(s);
    }
  }

  const SIMPLE_ID = /^[a-z_][a-z0-9_$]*$/;
  function ident(name, dialect, quoteAll) {
    if (quoteAll) return `"${name.replace(/"/g, '""')}"`;
    const clean = name.trim();
    if (dialect === 'oracle' ? /^[A-Za-z][A-Za-z0-9_$#]*$/.test(clean) && clean.length <= 128 : SIMPLE_ID.test(clean)) return clean;
    // Simple mixed-case names: unquoted lower-case for PostgreSQL is what people usually want.
    if (dialect !== 'oracle' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) return clean.toLowerCase();
    return `"${clean.replace(/"/g, '""')}"`;
  }

  // ---------- generation ----------
  /**
   * opts: { mode, dialect, table, keys: [colName], batch, emptyAsNull, quoteAll, inColumn }
   * modes: insert | insert-multi | upsert | update | delete | in-list | values | create
   */
  function generate(parsed, opts) {
    const { dialect = 'postgres', table = 'my_table', batch = 500, emptyAsNull = true, quoteAll = false } = opts;
    const ora = dialect === 'oracle';
    const cols = inferColumns(parsed, { emptyAsNull });
    const tbl = table.split('.').map((p) => ident(p, dialect, quoteAll)).join('.');
    const colIds = cols.map((c) => ident(c.name, dialect, quoteAll));
    const keyIdx = (opts.keys || []).map((k) => cols.findIndex((c) => c.name === k)).filter((i) => i >= 0);
    const lit = (row, i) => literal(row[i], cols[i], dialect, emptyAsNull);
    const tuple = (row) => `(${row.map((_, i) => lit(row, i)).join(', ')})`;
    const colList = `(${colIds.join(', ')})`;
    const rows = parsed.rows;
    const warnings = [];
    const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
    const needKeys = () => {
      if (!keyIdx.length) throw new Error('Pick the key column(s) for this mode');
    };
    if (ora && rows.some((r) => r.some((v) => v && typeof v === 'object' && (v.text || v.json || '').length > 4000))) {
      warnings.push('Oracle string literals are limited to 4000 bytes (32767 in PL/SQL); long values need bind variables or TO_CLOB(...) || TO_CLOB(...) concatenation.');
    }

    let sql;
    switch (opts.mode) {
      case 'insert':
        sql = rows.map((r) => `INSERT INTO ${tbl} ${colList} VALUES ${tuple(r)};`).join('\n');
        break;
      case 'insert-multi':
        sql = chunks(rows, batch).map((part) => (ora
          ? `INSERT ALL\n${part.map((r) => `  INTO ${tbl} ${colList} VALUES ${tuple(r)}`).join('\n')}\nSELECT 1 FROM DUAL;`
          : `INSERT INTO ${tbl} ${colList} VALUES\n${part.map((r) => `  ${tuple(r)}`).join(',\n')};`)).join('\n\n');
        if (ora) warnings.push('INSERT ALL does not fire sequence-based identity defaults per row reliably; Oracle 23ai also accepts multi-row VALUES.');
        break;
      case 'upsert': {
        needKeys();
        const nonKey = cols.map((_, i) => i).filter((i) => !keyIdx.includes(i));
        if (ora) {
          sql = chunks(rows, batch).map((part) => {
            const src = part.map((r) => `  SELECT ${r.map((_, i) => `${lit(r, i)} AS ${colIds[i]}`).join(', ')} FROM DUAL`).join(' UNION ALL\n');
            return `MERGE INTO ${tbl} t\nUSING (\n${src}\n) s\nON (${keyIdx.map((i) => `t.${colIds[i]} = s.${colIds[i]}`).join(' AND ')})\n` +
              (nonKey.length ? `WHEN MATCHED THEN UPDATE SET ${nonKey.map((i) => `t.${colIds[i]} = s.${colIds[i]}`).join(', ')}\n` : '') +
              `WHEN NOT MATCHED THEN INSERT ${colList} VALUES (${colIds.map((c) => `s.${c}`).join(', ')});`;
          }).join('\n\n');
        } else {
          sql = chunks(rows, batch).map((part) => `INSERT INTO ${tbl} ${colList} VALUES\n${part.map((r) => `  ${tuple(r)}`).join(',\n')}\n` +
            `ON CONFLICT (${keyIdx.map((i) => colIds[i]).join(', ')}) ` +
            (nonKey.length ? `DO UPDATE SET\n${nonKey.map((i) => `  ${colIds[i]} = EXCLUDED.${colIds[i]}`).join(',\n')};` : 'DO NOTHING;')).join('\n\n');
          warnings.push('ON CONFLICT needs a unique index or constraint on the key column(s).');
        }
        break;
      }
      case 'update': {
        needKeys();
        const nonKey = cols.map((_, i) => i).filter((i) => !keyIdx.includes(i));
        if (!nonKey.length) throw new Error('UPDATE needs at least one non-key column');
        sql = rows.map((r) => `UPDATE ${tbl} SET ${nonKey.map((i) => `${colIds[i]} = ${lit(r, i)}`).join(', ')} WHERE ${keyIdx.map((i) => whereEq(colIds[i], lit(r, i))).join(' AND ')};`).join('\n');
        break;
      }
      case 'delete': {
        needKeys();
        if (keyIdx.length === 1) {
          sql = `DELETE FROM ${tbl}\nWHERE ${inList(colIds[keyIdx[0]], rows.map((r) => lit(r, keyIdx[0])), ora)};`;
        } else {
          sql = rows.map((r) => `DELETE FROM ${tbl} WHERE ${keyIdx.map((i) => whereEq(colIds[i], lit(r, i))).join(' AND ')};`).join('\n');
        }
        break;
      }
      case 'in-list': {
        const i = Math.max(0, cols.findIndex((c) => c.name === opts.inColumn));
        const values = [...new Set(rows.map((r) => lit(r, i)))].filter((v) => v !== 'NULL');
        sql = inList(colIds[i], values, ora);
        if (values.length < rows.length) warnings.push(`${rows.length - values.length} duplicate / NULL value(s) removed.`);
        if (ora && values.length > 1000) warnings.push(`Oracle allows 1000 items per IN list (ORA-01795): split into ${Math.ceil(values.length / 1000)} OR-ed lists. A temp table / collection join is faster for big lists.`);
        if (!ora && values.length > 10000) warnings.push('Very long IN list: consider = ANY(?) with an array parameter, or a temp table.');
        break;
      }
      case 'values':
        sql = ora
          ? `WITH data ${colList} AS (\n${rows.map((r) => `  SELECT ${r.map((_, i) => lit(r, i)).join(', ')} FROM DUAL`).join(' UNION ALL\n')}\n)\nSELECT * FROM data;`
          : `WITH data ${colList} AS (\n  VALUES\n${rows.map((r) => `    ${tuple(r)}`).join(',\n')}\n)\nSELECT * FROM data;`;
        break;
      case 'create': {
        const defs = cols.map((c, i) => `  ${colIds[i]} ${sqlType(c, dialect).replace('%c', colIds[i])}${c.nullable ? '' : ' NOT NULL'}`);
        if (keyIdx.length) defs.push(`  ${ora ? `CONSTRAINT ${ident(`${table.split('.').pop()}_pk`, dialect, quoteAll)} ` : ''}PRIMARY KEY (${keyIdx.map((i) => colIds[i]).join(', ')})`);
        sql = `CREATE TABLE ${tbl} (\n${defs.join(',\n')}\n);`;
        break;
      }
      default:
        throw new Error(`Unknown mode ${opts.mode}`);
    }
    return { sql, columns: cols, warnings };
  }

  const whereEq = (col, value) => (value === 'NULL' ? `${col} IS NULL` : `${col} = ${value}`);

  function inList(col, values, oracle) {
    if (!values.length) return `1 = 0 /* empty list */`;
    const wrap = (vs) => {
      const lines = [];
      for (let i = 0; i < vs.length; i += 10) lines.push(vs.slice(i, i + 10).join(', '));
      return lines.length === 1 ? `${col} IN (${lines[0]})` : `${col} IN (\n  ${lines.join(',\n  ')}\n)`;
    };
    if (!oracle || values.length <= 1000) return wrap(values);
    const parts = [];
    for (let i = 0; i < values.length; i += 1000) parts.push(wrap(values.slice(i, i + 1000)));
    return `(\n${parts.join('\n OR ')}\n)`;
  }

  return { parseInput, inferColumns, generate, sqlType };
});
