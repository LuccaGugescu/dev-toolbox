'use strict';

// Rule-based Oracle <-> PostgreSQL SQL translator. Token-aware: strings, comments and quoted
// identifiers are never touched. It rewrites what can be translated mechanically and returns a
// warning for every construct that needs a human decision (outer joins (+), CONNECT BY, ROWNUM, ...).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sql-lexer'));
  else root.SqlConvert = factory(root.SqlLexer);
})(typeof self !== 'undefined' ? self : this, (SqlLexer) => {
  const { tokenize } = SqlLexer;

  // ---------- token helpers ----------
  const isSig = (t) => t && t.type !== 'ws' && t.type !== 'comment';
  const up = (t) => (t && (t.type === 'ident' || t.type === 'keyword') ? t.text.toUpperCase() : null);
  const nextSig = (toks, i) => { for (let j = i + 1; j < toks.length; j++) if (isSig(toks[j])) return j; return -1; };
  const prevSig = (toks, i) => { for (let j = i - 1; j >= 0; j--) if (isSig(toks[j])) return j; return -1; };
  const text = (toks, from, to) => toks.slice(from, to + 1).map((t) => t.text).join('');

  function matchParen(toks, open) {
    let depth = 0;
    for (let j = open; j < toks.length; j++) {
      if (toks[j].text === '(') depth++;
      else if (toks[j].text === ')' && --depth === 0) return j;
    }
    return -1;
  }

  /** For a function name at i: { open, close, args: [string] } with args split on top-level commas. */
  function callAt(toks, i) {
    const open = nextSig(toks, i);
    if (open < 0 || toks[open].text !== '(') return null;
    const close = matchParen(toks, open);
    if (close < 0) return null;
    const args = [];
    let depth = 0;
    let start = open + 1;
    for (let j = open + 1; j < close; j++) {
      const t = toks[j].text;
      if (t === '(') depth++;
      else if (t === ')') depth--;
      else if (t === ',' && depth === 0) {
        args.push(text(toks, start, j - 1).trim());
        start = j + 1;
      }
    }
    const last = text(toks, start, close - 1).trim();
    if (last || args.length) args.push(last);
    return { open, close, args };
  }

  // ---------- Oracle -> PostgreSQL ----------
  function numberType(args) {
    if (!args.length || args[0] === '*') return args[1] && args[1] !== '0' ? `numeric(38, ${args[1]})` : 'numeric';
    const p = Number(args[0]);
    const s = args[1] == null ? 0 : Number(args[1]);
    if (s === 0 && p <= 4) return 'smallint';
    if (s === 0 && p <= 9) return 'integer';
    if (s === 0 && p <= 19) return 'bigint'; // NUMBER(19) is the usual Oracle id column; identity needs an integer type
    return s === 0 ? `numeric(${p})` : `numeric(${p}, ${s})`;
  }

  const TRUNC_UNITS = { MM: 'month', MON: 'month', MONTH: 'month', RM: 'month', YYYY: 'year', YEAR: 'year', YY: 'year', Y: 'year', SYYYY: 'year', RRRR: 'year', DD: 'day', DDD: 'day', J: 'day', HH: 'hour', HH24: 'hour', HH12: 'hour', MI: 'minute', Q: 'quarter', IW: 'week', CC: 'century' };

  function oracleToPostgres(sql, warn) {
    const toks = tokenize(sql);
    let out = '';
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const u = up(t);
      const nx = nextSig(toks, i);
      const nxt = nx >= 0 ? toks[nx] : null;
      const pv = prevSig(toks, i);
      const prv = pv >= 0 ? toks[pv] : null;
      const afterDot = prv && prv.text === '.';
      const isCall = nxt && nxt.text === '(';

      if (!u || afterDot && !['NEXTVAL', 'CURRVAL'].includes(u)) {
        if (t.text === '(' && toks[nx] && toks[nx].text === '+' && toks[nextSig(toks, nx)]?.text === ')') {
          warn('Oracle outer join "(+)": rewrite as LEFT/RIGHT JOIN ... ON ...');
        }
        if (t.type === 'string' && t.text === "''") warn("Oracle treats '' as NULL; in PostgreSQL '' is an empty string (check comparisons and IS NULL)");
        out += t.text;
        continue;
      }

      // seq.NEXTVAL / seq.CURRVAL (optionally schema-qualified)
      if ((u === 'NEXTVAL' || u === 'CURRVAL') && afterDot) {
        let start = pv - 1;
        while (start - 2 >= 0 && toks[start - 1].text === '.' && toks[start - 2].type !== 'ws') start -= 2;
        const seqName = toks.slice(start, pv).map((x) => x.text).join('');
        out = out.slice(0, out.length - (seqName.length + 1)) + `${u.toLowerCase()}('${seqName.toLowerCase()}')`;
        continue;
      }

      const call = isCall ? callAt(toks, i) : null;
      const conv = (s) => oracleToPostgres(s, warn);
      // Args are converted up front; their warnings count only if this call is rewritten (else the walk revisits them).
      const pending = [];
      const A = call ? call.args.map((s) => oracleToPostgres(s, (m) => pending.push(m))) : [];
      const replaceCall = (s) => { pending.forEach(warn); out += s; i = call.close; };

      switch (u) {
        case 'VARCHAR2': case 'NVARCHAR2':
          if (call) replaceCall(`varchar(${A[0].replace(/\s+(BYTE|CHAR)$/i, '')})`);
          else out += 'varchar';
          continue;
        case 'NCHAR':
          out += 'char';
          continue;
        case 'NUMBER':
          if (call) replaceCall(numberType(A));
          else out += 'numeric';
          continue;
        case 'DATE':
          // DATE '2024-01-01' literal stays; the DATE type carries a time in Oracle.
          if (nxt && nxt.type === 'string') out += t.text;
          else out += 'timestamp(0)';
          continue;
        case 'CLOB': case 'NCLOB': out += 'text'; continue;
        case 'BLOB': out += 'bytea'; continue;
        case 'RAW':
          if (call) replaceCall(A[0] === '16' ? 'uuid /* RAW(16), or bytea */' : 'bytea');
          else out += 'bytea';
          continue;
        case 'LONG':
          if (up(nxt) === 'RAW') { out += 'bytea'; i = nx; } else out += 'text';
          continue;
        case 'BINARY_FLOAT': out += 'real'; continue;
        case 'BINARY_DOUBLE': out += 'double precision'; continue;
        case 'XMLTYPE': out += 'xml'; continue;
        case 'ROWID': case 'UROWID': warn('ROWID has no PostgreSQL equivalent (ctid is not stable): use the primary key'); out += t.text; continue;
        case 'SYSDATE': out += 'LOCALTIMESTAMP(0)'; continue;
        case 'SYSTIMESTAMP': out += 'CURRENT_TIMESTAMP'; continue;
        case 'MINUS': out += 'EXCEPT'; continue;
        case 'NOCACHE': case 'NOORDER':
          i = dropToken(toks, i);
          continue;
        case 'NOCYCLE': out += 'NO CYCLE'; continue;
        case 'NOMAXVALUE': out += 'NO MAXVALUE'; continue;
        case 'NOMINVALUE': out += 'NO MINVALUE'; continue;
        case 'NOLOGGING': case 'LOGGING':
          i = dropToken(toks, i);
          continue;
        case 'TABLESPACE': case 'PCTFREE': case 'STORAGE': case 'INITRANS':
          warn(`Storage clause ${u} removed: review tablespace / physical storage settings`);
          i = call && u === 'STORAGE' ? call.close : nx;
          out = out.replace(/[ \t]+$/, '');
          continue;
        case 'DUAL':
          if (up(prv) === 'FROM') {
            out = out.replace(/\s*FROM\s*$/i, '');
            continue;
          }
          break;
        case 'ROWNUM':
          warn('ROWNUM: use LIMIT n (or FETCH FIRST n ROWS ONLY) after ORDER BY, or row_number() OVER (...)');
          break;
        case 'CONNECT':
          if (up(nxt) === 'BY') warn('CONNECT BY hierarchical query: rewrite as WITH RECURSIVE');
          break;
        case 'PRIOR': case 'LEVEL': case 'SYS_CONNECT_BY_PATH':
          break;
        case 'MERGE':
          warn('MERGE: supported from PostgreSQL 15; on older versions use INSERT ... ON CONFLICT');
          break;
        case 'ON':
          // GENERATED BY DEFAULT ON NULL AS IDENTITY -> GENERATED BY DEFAULT AS IDENTITY
          if (up(nxt) === 'NULL' && up(toks[nextSig(toks, nx)]) === 'AS' && up(prv) === 'DEFAULT') { i = dropToken(toks, nx); continue; }
          break;
        default:
          break;
      }

      if (call) {
        switch (u) {
          case 'NVL': replaceCall(`COALESCE(${A.join(', ')})`); continue;
          case 'NVL2': replaceCall(`CASE WHEN ${A[0]} IS NOT NULL THEN ${A[1]} ELSE ${A[2]} END`); continue;
          case 'DECODE': {
            const [expr, ...rest] = A;
            const hasNull = rest.some((a, k) => k % 2 === 0 && k < rest.length - 1 && /^null$/i.test(a));
            let s = hasNull ? 'CASE' : `CASE ${expr}`;
            for (let k = 0; k + 1 < rest.length; k += 2) {
              s += hasNull ? (/^null$/i.test(rest[k]) ? ` WHEN ${expr} IS NULL THEN ${rest[k + 1]}` : ` WHEN ${expr} = ${rest[k]} THEN ${rest[k + 1]}`) : ` WHEN ${rest[k]} THEN ${rest[k + 1]}`;
            }
            if (rest.length % 2 === 1) s += ` ELSE ${rest[rest.length - 1]}`;
            replaceCall(`${s} END`);
            continue;
          }
          case 'SYS_GUID': replaceCall('gen_random_uuid()'); continue;
          case 'LENGTHB': replaceCall(`octet_length(${A[0]})`); continue;
          case 'INSTR':
            if (A.length === 2) replaceCall(`strpos(${A[0]}, ${A[1]})`);
            else { warn('INSTR with start/occurrence arguments: no direct PostgreSQL function (use regexp_instr in PG 15+)'); replaceCall(`regexp_instr(${A.join(', ')})`); }
            continue;
          case 'TO_NUMBER':
            replaceCall(A.length === 1 ? `(${A[0]})::numeric` : `to_number(${A.join(', ')})`);
            continue;
          case 'TO_DATE':
            if (A.length === 1) replaceCall(`(${A[0]})::timestamp(0)`);
            else { replaceCall(`to_timestamp(${A[0]}, ${A[1]})::timestamp(0)`); if (/RR|SSSSS|FF/i.test(A[1])) warn(`Date format ${A[1]}: RR, SSSSS and FF behave differently in PostgreSQL`); }
            continue;
          case 'TO_TIMESTAMP':
            replaceCall(A.length === 1 ? `(${A[0]})::timestamp` : `to_timestamp(${A[0]}, ${A[1]})::timestamp`);
            continue;
          case 'TRUNC':
            if (A.length === 2 && /^'.*'$/.test(A[1])) {
              const unit = TRUNC_UNITS[A[1].slice(1, -1).toUpperCase()];
              if (unit) { replaceCall(`date_trunc('${unit}', ${A[0]})`); continue; }
            }
            if (A.length === 1) warn(`TRUNC(${A[0]}): if the argument is a DATE, use date_trunc('day', ...) or ::date; trunc() only works on numbers in PostgreSQL`);
            replaceCall(`trunc(${A.join(', ')})`);
            continue;
          case 'ADD_MONTHS': replaceCall(`(${A[0]} + (${A[1]}) * INTERVAL '1 month')`); continue;
          case 'LAST_DAY': replaceCall(`(date_trunc('month', ${A[0]}) + INTERVAL '1 month - 1 day')::date`); continue;
          case 'MONTHS_BETWEEN':
            warn('MONTHS_BETWEEN: approximated with age(); fractional months differ');
            replaceCall(`(EXTRACT(YEAR FROM age(${A[0]}, ${A[1]})) * 12 + EXTRACT(MONTH FROM age(${A[0]}, ${A[1]})))`);
            continue;
          case 'REGEXP_LIKE': {
            const op = A[2] && /i/.test(A[2]) ? '~*' : '~';
            replaceCall(`${A[0]} ${op} ${A[1]}`);
            continue;
          }
          case 'LISTAGG': {
            // LISTAGG(x, sep) WITHIN GROUP (ORDER BY y)
            let order = '';
            let end = call.close;
            const w = nextSig(toks, call.close);
            if (up(toks[w]) === 'WITHIN') {
              const g = nextSig(toks, w);
              const p = nextSig(toks, g);
              const pc = matchParen(toks, p);
              order = ' ' + conv(text(toks, p + 1, pc - 1).trim());
              end = pc;
            }
            pending.forEach(warn);
            out += `string_agg(${A[0]}, ${A[1] || "''"}${order})`;
            i = end;
            continue;
          }
          case 'PUT_LINE':
            if (up(prv) === null && toks[pv]?.text === '.' && up(toks[prevSig(toks, pv)]) === 'DBMS_OUTPUT') {
              out = out.replace(/DBMS_OUTPUT\s*\.\s*$/i, '');
              replaceCall(`RAISE NOTICE '%', ${A[0]}`);
              continue;
            }
            break;
          default:
            break;
        }
      }
      out += t.text;
    }
    return out;
  }

  // Index to continue from after removing token i: also swallows the following same-line space.
  function dropToken(toks, i) {
    const ws = toks[i + 1];
    return ws && ws.type === 'ws' && !ws.text.includes('\n') ? i + 1 : i;
  }

  // ---------- PostgreSQL -> Oracle ----------
  const PG_TYPES = {
    TEXT: 'CLOB', BOOLEAN: 'NUMBER(1)', BOOL: 'NUMBER(1)', SMALLINT: 'NUMBER(5)', INT2: 'NUMBER(5)',
    INTEGER: 'NUMBER(10)', INT: 'NUMBER(10)', INT4: 'NUMBER(10)', BIGINT: 'NUMBER(19)', INT8: 'NUMBER(19)',
    REAL: 'BINARY_FLOAT', FLOAT4: 'BINARY_FLOAT', FLOAT8: 'BINARY_DOUBLE', BYTEA: 'BLOB', UUID: 'RAW(16)',
    JSON: 'JSON', JSONB: 'JSON', TIMESTAMPTZ: 'TIMESTAMP WITH TIME ZONE', SERIAL: 'NUMBER(10) GENERATED BY DEFAULT AS IDENTITY',
    BIGSERIAL: 'NUMBER(19) GENERATED BY DEFAULT AS IDENTITY', SMALLSERIAL: 'NUMBER(5) GENERATED BY DEFAULT AS IDENTITY',
    CITEXT: 'VARCHAR2(4000 CHAR)', INET: 'VARCHAR2(45)', MONEY: 'NUMBER(19, 4)',
  };
  const DATE_TRUNC_FMT = { year: 'YYYY', quarter: 'Q', month: 'MM', week: 'IW', day: 'DD', hour: 'HH24', minute: 'MI' };

  function mapPgType(name, args) {
    const u = name.toUpperCase();
    if (u === 'VARCHAR' || u === 'CHARACTER VARYING') return args ? `VARCHAR2(${args} CHAR)` : 'VARCHAR2(4000 CHAR)';
    if (u === 'CHAR' || u === 'CHARACTER') return args ? `CHAR(${args} CHAR)` : 'CHAR(1)';
    if (u === 'NUMERIC' || u === 'DECIMAL') return args ? `NUMBER(${args})` : 'NUMBER';
    if (u === 'DOUBLE PRECISION') return 'BINARY_DOUBLE';
    if (u === 'TIMESTAMP') return args ? `TIMESTAMP(${args})` : 'TIMESTAMP';
    return PG_TYPES[u] || null;
  }

  function postgresToOracle(sql, warn) {
    const toks = tokenize(sql);
    let out = '';
    const conv = (s) => postgresToOracle(s, warn);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const u = up(t);
      const nx = nextSig(toks, i);
      const nxt = nx >= 0 ? toks[nx] : null;
      const pv = prevSig(toks, i);
      const prv = pv >= 0 ? toks[pv] : null;

      if (t.text === '::') {
        // expr::type -> CAST(expr AS type); expr is the previous operand already written to out.
        const { type, end } = readType(toks, nx);
        const operand = lastOperand(out);
        const target = /^text$/i.test(type.name) ? 'VARCHAR2(4000 CHAR)' : mapPgType(type.name, type.args) || type.raw;
        out = out.slice(0, out.length - operand.length) + `CAST(${operand} AS ${target})`;
        i = end;
        continue;
      }
      if (t.type === 'string' && /^[eE]'/.test(t.text)) warn("E'...' escape strings: Oracle has no backslash escapes, use CHR() or UNISTR()");
      if (t.type === 'op' && (t.text === '~' || t.text === '~*' || t.text === '!~')) warn(`Regex operator ${t.text}: use REGEXP_LIKE(value, pattern${t.text === '~*' ? ", 'i'" : ''})`);
      if (t.type === 'op' && ['->', '->>', '#>', '#>>', '@>', '?'].includes(t.text)) warn(`JSON operator ${t.text}: use JSON_VALUE / JSON_QUERY / JSON_EXISTS`);
      if (t.text === '[' && prv && (prv.type === 'ident' || prv.type === 'keyword')) warn('Arrays: Oracle has no array columns; use a child table, a JSON array or a nested table type');
      if (!u || (prv && prv.text === '.')) { out += t.text; continue; }

      const call = nxt && nxt.text === '(' ? callAt(toks, i) : null;
      const pending = [];
      const A = call ? call.args.map((s) => postgresToOracle(s, (m) => pending.push(m))) : [];
      const replaceCall = (s) => { pending.forEach(warn); out += s; i = call.close; };

      // multi-word types
      if (u === 'DOUBLE' && up(nxt) === 'PRECISION') { out += 'BINARY_DOUBLE'; i = nx; continue; }
      if (u === 'CHARACTER' && up(nxt) === 'VARYING') {
        const c = callAt(toks, nx);
        if (c) { out += mapPgType('VARCHAR', c.args.join(', ')); i = c.close; } else { out += mapPgType('VARCHAR'); i = nx; }
        continue;
      }
      if ((u === 'TIMESTAMP' || u === 'TIME') && (up(nxt) === 'WITH' || up(nxt) === 'WITHOUT')) {
        const z = nextSig(toks, nextSig(toks, nx)); // ZONE
        out += up(nxt) === 'WITH' ? `${u} WITH TIME ZONE` : u;
        i = z;
        continue;
      }

      if (isTypePosition(prv) || PG_TYPES[u] && ['SERIAL', 'BIGSERIAL', 'SMALLSERIAL', 'TEXT', 'BYTEA', 'JSONB', 'TIMESTAMPTZ', 'UUID', 'BOOLEAN', 'INT4', 'INT8'].includes(u) && !call) {
        const mapped = mapPgType(u, call ? call.args.join(', ') : null);
        if (mapped && !(call && !['VARCHAR', 'CHAR', 'CHARACTER', 'NUMERIC', 'DECIMAL', 'TIMESTAMP'].includes(u))) {
          if (u === 'TEXT') warn('TEXT -> CLOB: use VARCHAR2(4000 CHAR) when values stay short (CLOBs cannot be indexed or compared with =)');
          if (u === 'BOOLEAN' || u === 'BOOL') warn('BOOLEAN -> NUMBER(1) (Oracle 23ai has a native BOOLEAN type)');
          if (u === 'JSON' || u === 'JSONB') warn('JSON type needs Oracle 21c+; on older versions use CLOB CHECK (col IS JSON)');
          if (call) replaceCall(mapped); else out += mapped;
          continue;
        }
      }

      switch (u) {
        case 'NOW':
          if (call) { replaceCall('SYSTIMESTAMP'); continue; }
          break;
        case 'CURRENT_TIMESTAMP': out += 'SYSTIMESTAMP'; continue;
        case 'TRUE': out += '1'; continue;
        case 'FALSE': out += '0'; continue;
        case 'EXCEPT': out += 'MINUS'; continue;
        case 'ILIKE': warn('ILIKE: use UPPER(a) LIKE UPPER(b), or REGEXP_LIKE(a, b, \'i\')'); out += 'LIKE'; continue;
        case 'LIMIT': {
          // LIMIT n [OFFSET m]  ->  OFFSET m ROWS FETCH NEXT n ROWS ONLY
          const nEnd = nx;
          let offset = '';
          let end = nEnd;
          const o = nextSig(toks, nEnd);
          if (up(toks[o]) === 'OFFSET') { offset = `OFFSET ${toks[nextSig(toks, o)].text} ROWS `; end = nextSig(toks, o); }
          out += `${offset}FETCH NEXT ${toks[nEnd].text} ROWS ONLY`;
          i = end;
          continue;
        }
        case 'OFFSET': {
          const n = toks[nx];
          const f = nextSig(toks, nx);
          out += `OFFSET ${n.text} ROWS`;
          i = nx;
          if (up(toks[f]) === 'LIMIT') { out += ` FETCH NEXT ${toks[nextSig(toks, f)].text} ROWS ONLY`; i = nextSig(toks, f); }
          continue;
        }
        case 'RETURNING': warn('RETURNING: Oracle supports it only as RETURNING ... INTO in PL/SQL / JDBC getGeneratedKeys'); break;
        case 'CONFLICT': warn('INSERT ... ON CONFLICT: rewrite as MERGE INTO ... USING ... WHEN MATCHED / WHEN NOT MATCHED'); break;
        case 'IF':
          if (up(nxt) === 'NOT' || up(nxt) === 'EXISTS') warn('IF [NOT] EXISTS in DDL needs Oracle 23ai; older versions need a PL/SQL block');
          break;
        default: break;
      }

      if (call) {
        switch (u) {
          case 'GEN_RANDOM_UUID': case 'UUID_GENERATE_V4': replaceCall('SYS_GUID()'); continue;
          case 'NEXTVAL': case 'CURRVAL':
            replaceCall(`${A[0].replace(/^'|'$/g, '').replace(/::regclass$/i, '')}.${u}`);
            continue;
          case 'STRPOS': case 'POSITION':
            replaceCall(u === 'STRPOS' ? `INSTR(${A[0]}, ${A[1]})` : positionToInstr(A[0]));
            continue;
          case 'STRING_AGG': {
            const m = /^(.*?)\s+ORDER\s+BY\s+(.*)$/is.exec(A[1] || '');
            const sep = m ? m[1] : A[1];
            replaceCall(`LISTAGG(${A[0]}, ${sep}) WITHIN GROUP (ORDER BY ${m ? m[2] : 'NULL'})`);
            continue;
          }
          case 'DATE_TRUNC': {
            const unit = A[0].replace(/^'|'$/g, '').toLowerCase();
            replaceCall(`TRUNC(${A[1]}, '${DATE_TRUNC_FMT[unit] || unit.toUpperCase()}')`);
            continue;
          }
          case 'LENGTH': case 'CHAR_LENGTH': replaceCall(`LENGTH(${A[0]})`); continue;
          case 'OCTET_LENGTH': replaceCall(`LENGTHB(${A[0]})`); continue;
          case 'RANDOM': replaceCall('DBMS_RANDOM.VALUE'); continue;
          case 'CONCAT': if (A.length > 2) { replaceCall(A.join(' || ')); continue; } break;
          default: break;
        }
      }
      out += t.text;
    }
    return out;
  }

  const positionToInstr = (arg) => {
    const m = /^(.*?)\s+IN\s+(.*)$/is.exec(arg);
    return m ? `INSTR(${m[2]}, ${m[1]})` : `INSTR(${arg})`;
  };

  // Previous token is a column name or CAST(... AS: the current identifier is a data type.
  function isTypePosition(prv) {
    if (!prv) return false;
    return up(prv) === 'AS' || prv.type === 'ident' || prv.type === 'qident' || up(prv) === 'TYPE';
  }

  function readType(toks, i) {
    let name = toks[i].text;
    let end = i;
    if (up(toks[i]) === 'DOUBLE' && up(toks[nextSig(toks, i)]) === 'PRECISION') { name = 'DOUBLE PRECISION'; end = nextSig(toks, i); }
    let args = null;
    const p = nextSig(toks, end);
    if (p >= 0 && toks[p].text === '(') {
      const c = matchParen(toks, p);
      args = text(toks, p + 1, c - 1).trim();
      end = c;
    }
    let raw = text(toks, i, end);
    const b = nextSig(toks, end);
    if (b >= 0 && toks[b].text === '[') { raw += '[]'; end = nextSig(toks, b); }
    return { type: { name, args, raw }, end };
  }

  // The operand just before "::": a parenthesised group (with a function name), a string, or a dotted name.
  function lastOperand(out) {
    const s = out.replace(/\s+$/, '');
    if (s.endsWith(')')) {
      let depth = 0;
      for (let j = s.length - 1; j >= 0; j--) {
        if (s[j] === ')') depth++;
        else if (s[j] === '(' && --depth === 0) {
          const fn = /[\w.$"]*$/.exec(s.slice(0, j))[0];
          return s.slice(j - fn.length);
        }
      }
    }
    if (s.endsWith("'")) {
      const m = /'(?:[^']|'')*'$/.exec(s);
      if (m) return m[0];
    }
    return /[\w.$"]+$/.exec(s)?.[0] || '';
  }

  /** direction: 'ora2pg' | 'pg2ora'. Returns { sql, warnings: [{ message, count }] }. */
  function convert(sql, direction) {
    const counts = new Map();
    const warn = (m) => counts.set(m, (counts.get(m) || 0) + 1);
    const out = direction === 'pg2ora' ? postgresToOracle(sql, warn) : oracleToPostgres(sql, warn);
    return { sql: out, warnings: [...counts].map(([message, count]) => ({ message, count })) };
  }

  return { convert };
});
