'use strict';

// SQL formatter (PostgreSQL / Oracle / ANSI) and bind-parameter inliner.
// Pure functions: run in the renderer (window.SqlFormat) and under Node for tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sql-lexer'));
  else root.SqlFormat = factory(root.SqlLexer);
})(typeof self !== 'undefined' ? self : this, (SqlLexer) => {
  const { tokenize } = SqlLexer;

  // Clause keywords (possibly multi-word) that start a new line at the statement's base indent.
  // body: content goes on the next line, indented one level. list: top-level commas break lines.
  const CLAUSES = [
    ['WITH RECURSIVE', { list: true }], ['WITH', { list: true }],
    ['SELECT', { body: true, list: true }], ['FROM', { body: true, list: true }], ['WHERE', { body: true }],
    ['GROUP BY', { body: true, list: true }], ['HAVING', { body: true }], ['ORDER BY', { body: true, list: true }],
    ['WINDOW', {}], ['LIMIT', {}], ['OFFSET', {}], ['FETCH', {}], ['FOR UPDATE', {}],
    ['UNION ALL', {}], ['UNION', {}], ['INTERSECT', {}], ['EXCEPT', {}], ['MINUS', {}],
    ['INSERT INTO', {}], ['INSERT ALL', {}], ['VALUES', { body: true, list: true }], ['UPDATE', {}], ['SET', { body: true, list: true }],
    ['DELETE FROM', {}], ['RETURNING', { list: true }], ['ON CONFLICT', {}], ['DO UPDATE SET', { body: true, list: true }], ['DO NOTHING', {}],
    ['MERGE INTO', {}], ['USING', {}], ['WHEN NOT MATCHED', {}], ['WHEN MATCHED', {}],
    ['START WITH', {}], ['CONNECT BY', {}],
  ].map(([words, opts]) => ({ words: words.split(' '), name: words, ...opts }));

  const JOIN_START = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL']);
  const NO_SPACE_BEFORE_PAREN = new Set(['CAST', 'REPLACE', 'LEFT', 'RIGHT', 'ANY', 'COALESCE', 'NULLIF', 'ROW', 'ARRAY']);

  function format(sql, { indent = '  ', keywordCase = 'upper', minify = false } = {}) {
    if (minify) return minifySql(sql);
    const all = tokenize(sql);
    const toks = all.filter((t) => t.type !== 'ws');
    const caseKw = (t) => (keywordCase === 'upper' ? t.toUpperCase() : keywordCase === 'lower' ? t.toLowerCase() : t);
    const word = (t) => (t && (t.type === 'keyword' || t.type === 'ident') ? t.text.toUpperCase() : null);

    let out = '';
    let lineIndent = 0;
    let atLineStart = true;
    let prev = null;
    let prevUnary = false;
    let forceBreak = false;
    // Block context: base indent + current clause. Parens: { kind: 'inline' | 'block' | 'columns', openIndent, ctx }
    let ctx = { base: 0, clause: null };
    let parens = [];
    let cases = [];
    let between = false;
    let stmtFirst = null;
    let sawCreateParen = false;

    const newline = (level) => {
      out = out.replace(/[ \t]+$/, '');
      if (out.length && !atLineStart) out += '\n';
      out += indent.repeat(level);
      lineIndent = level;
      atLineStart = true;
    };
    const emit = (text, tok) => {
      if (forceBreak) {
        forceBreak = false;
        newline(lineIndent);
      }
      if (!atLineStart && needSpace(prev, tok)) out += ' ';
      out += text;
      atLineStart = false;
      prevUnary = tok.text === '-' || tok.text === '+' ? isUnaryPosition(prev) : false;
      prev = tok;
    };
    const needSpace = (p, t) => {
      if (!p) return false;
      const pt = p.text;
      const tt = t.text;
      if (pt === '(' || pt === '[' || pt === '.' || pt === '::') return false;
      if (tt === ')' || tt === ']' || tt === ',' || tt === ';' || tt === '.' || tt === '::') return false;
      if (tt === '[' && (p.type === 'ident' || p.type === 'qident' || pt === ']')) return false;
      if (prevUnary && (t.type === 'number' || t.type === 'ident' || tt === '(')) return false;
      if (tt === '(') {
        if (p.type === 'ident' || p.type === 'qident') return ctx.clause === 'INSERT INTO' || ctx.clause === 'MERGE INTO' || (stmtFirst === 'CREATE' && !sawCreateParen);
        if (p.type === 'keyword') return !NO_SPACE_BEFORE_PAREN.has(pt.toUpperCase());
      }
      return true;
    };
    const isUnaryPosition = (p) => !p || p.type === 'op' || p.type === 'keyword' || p.text === '(' || p.text === ',';
    // Clause/AND/OR line breaks apply only outside inline parens (calls, IN lists) and DDL column lists.
    const inline = () => parens.length > 0 && parens[parens.length - 1].kind !== 'block';
    const matchClause = (k) => {
      for (const c of CLAUSES) {
        if (c.words.every((w, j) => word(toks[k + j]) === w && toks[k + j].type !== 'comment')) return c;
      }
      return null;
    };
    const nextSignificant = (k) => {
      for (let j = k + 1; j < toks.length; j++) if (toks[j].type !== 'comment') return toks[j];
      return null;
    };

    for (let k = 0; k < toks.length; k++) {
      const tok = toks[k];
      const up = word(tok);

      if (tok.type === 'comment') {
        const isLine = tok.text.startsWith('--');
        const isHint = tok.text.startsWith('/*+');
        if (!isHint && /\n/.test(tok.text)) newline(lineIndent);
        emit(tok.text, tok);
        if (isLine) forceBreak = true;
        continue;
      }
      if (!stmtFirst) stmtFirst = up;

      if (tok.text === ';') {
        emit(';', tok);
        ctx = { base: 0, clause: null };
        parens = [];
        cases = [];
        stmtFirst = null;
        sawCreateParen = false;
        forceBreak = false;
        if (nextSignificant(k)) {
          newline(0);
          out += '\n';
        }
        continue;
      }

      if (!inline()) {
        const clause = tok.type === 'keyword' || tok.type === 'ident' ? matchClause(k) : null;
        // A WITH clause only opens a statement, a subquery or a view body ("timestamp with time zone" is not one).
        const withOk = !clause || !clause.name.startsWith('WITH') || !prev || prev.text === '(' || prev.text === ';' || word(prev) === 'AS';
        if (clause && withOk) {
          if ((clause.name === 'USING' && ctx.clause !== 'MERGE INTO') || (stmtFirst === 'MERGE' && ['UPDATE', 'INSERT INTO', 'VALUES', 'SET'].includes(clause.name))) {
            // USING (...) in joins/DDL, and MERGE's "THEN UPDATE SET ..." / "THEN INSERT ... VALUES (...)" stay inline.
            clause.words.forEach((w, j) => emit(caseKw(toks[k + j].text), toks[k + j]));
            k += clause.words.length - 1;
            if (clause.name === 'SET') {
              ctx.clause = 'SET';
              ctx.list = true;
            }
            continue;
          }
          newline(ctx.base);
          clause.words.forEach((w, j) => emit(caseKw(toks[k + j].text), toks[k + j]));
          k += clause.words.length - 1;
          ctx.clause = clause.name;
          ctx.list = !!clause.list;
          if (clause.name === 'SELECT') {
            // keep DISTINCT / ALL / Oracle hints on the SELECT line
            while (toks[k + 1] && (['DISTINCT', 'ALL', 'UNIQUE'].includes(word(toks[k + 1])) || toks[k + 1].text.startsWith('/*+'))) {
              k++;
              emit(toks[k].type === 'comment' ? toks[k].text : caseKw(toks[k].text), toks[k]);
              if (word(toks[k]) === 'DISTINCT' && word(toks[k + 1]) === 'ON') {
                // PostgreSQL DISTINCT ON (...)
                k++;
                emit(caseKw(toks[k].text), toks[k]);
              }
            }
          }
          if (clause.body) newline(ctx.base + 1);
          continue;
        }

        if (JOIN_START.has(up) && tok.type === 'keyword' && isJoin(toks, k)) {
          newline(ctx.base + 1);
          for (;;) {
            emit(caseKw(toks[k].text), toks[k]);
            if (word(toks[k]) === 'JOIN') break;
            k++;
          }
          ctx.clause = 'FROM';
          continue;
        }
        if ((up === 'AND' || up === 'OR') && tok.type === 'keyword') {
          if (between && up === 'AND') {
            between = false;
            emit(caseKw(tok.text), tok);
            continue;
          }
          if (ctx.clause === 'WHERE' || ctx.clause === 'HAVING') newline(ctx.base + 1);
          else if (ctx.clause === 'FROM' || ctx.clause === 'CONNECT BY' || ctx.clause === 'START WITH') newline(ctx.base + 2);
          emit(caseKw(tok.text), tok);
          continue;
        }
      }

      if (up === 'BETWEEN') between = true;

      if (up === 'CASE' && tok.type === 'keyword') {
        cases.push({ indent: lineIndent, formatted: !inline() });
        emit(caseKw(tok.text), tok);
        continue;
      }
      if (cases.length && (up === 'WHEN' || up === 'ELSE') && tok.type === 'keyword') {
        const c = cases[cases.length - 1];
        if (c.formatted) newline(c.indent + 1);
        emit(caseKw(tok.text), tok);
        continue;
      }
      if (cases.length && up === 'END' && tok.type === 'keyword') {
        const c = cases.pop();
        if (c.formatted) newline(c.indent);
        emit(caseKw(tok.text), tok);
        continue;
      }

      if (tok.text === '(') {
        const nxt = nextSignificant(k);
        const isSub = ['SELECT', 'WITH'].includes(word(nxt));
        const isColumns = !isSub && !sawCreateParen && stmtFirst === 'CREATE' && parens.length === 0 && prev && (prev.type === 'ident' || prev.type === 'qident');
        emit('(', tok);
        if (isColumns) sawCreateParen = true;
        if (isSub || isColumns) {
          parens.push({ kind: isSub ? 'block' : 'columns', openIndent: lineIndent, ctx });
          if (isSub) ctx = { base: lineIndent + 1, clause: null };
          newline(lineIndent + 1);
        } else {
          parens.push({ kind: 'inline', openIndent: lineIndent, ctx });
        }
        continue;
      }
      if (tok.text === ')') {
        const p = parens.pop();
        if (p && p.kind !== 'inline') {
          ctx = p.ctx;
          newline(p.openIndent);
        }
        emit(')', tok);
        continue;
      }
      if (tok.text === ',') {
        emit(',', tok);
        const top = parens[parens.length - 1];
        if (top && top.kind === 'columns') newline(top.openIndent + 1);
        else if (!top || top.kind === 'block' ? ctx.list : false) newline(ctx.clause === 'WITH' ? ctx.base : ctx.base + 1);
        continue;
      }

      emit(tok.type === 'keyword' ? caseKw(tok.text) : tok.text, tok);
    }
    return out.replace(/[ \t]+$/gm, '').trim() + '\n';
  }

  function isJoin(toks, k) {
    for (let j = k; j < Math.min(toks.length, k + 4); j++) {
      const w = toks[j].text.toUpperCase();
      if (w === 'JOIN' || w === 'APPLY') return true;
      if (!['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER'].includes(w)) return false;
    }
    return false;
  }

  function minifySql(sql) {
    let out = '';
    let prev = null;
    for (const t of tokenize(sql)) {
      if (t.type === 'ws') continue;
      if (t.type === 'comment' && !t.text.startsWith('/*+')) continue;
      const wordish = (x) => x && /[A-Za-z0-9_$"'#\u0080-￿]/.test(x);
      if (prev && (t.type === 'comment' || prev.type === 'comment')) out += ' ';
      else if (prev && wordish(prev.text.slice(-1)) && wordish(t.text[0])) out += ' ';
      else if (prev && prev.type === 'op' && t.type === 'op') out += ' ';
      out += t.text;
      prev = t;
    }
    return out;
  }

  /**
   * Parses a parameter list. Accepts one value per line, a JSON array, a comma-separated list,
   * Hibernate "binding parameter [1] as [VARCHAR] - [abc]" log lines, or "name=value" lines.
   * Returns [{ name?, value, type? }]; value null means SQL NULL.
   */
  function parseParams(text) {
    const t = text.trim();
    if (!t) return [];
    if (t.startsWith('[')) {
      try {
        return JSON.parse(t).map((v) => ({ value: v }));
      } catch { /* fall through */ }
    }
    const hib = [...t.matchAll(/binding parameter \[?\(?(\d+)\)?\]? as \[(\w+)\] - \[(.*?)\]\s*$/gm)];
    if (hib.length) return hib.map((m) => ({ index: Number(m[1]), type: m[2], value: m[3] === 'null' ? null : m[3] })).sort((a, b) => a.index - b.index);
    // Spring/JdbcTemplate "Setting SQL statement parameter value: column index 1, parameter value [abc], value class [java.lang.String]"
    const jdbc = [...t.matchAll(/column index (\d+), parameter value \[(.*?)\], value class \[([\w.]+)\]/g)];
    if (jdbc.length) return jdbc.map((m) => ({ index: Number(m[1]), type: m[3].split('.').pop(), value: m[2] === 'null' ? null : m[2] })).sort((a, b) => a.index - b.index);
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 1 && lines[0].includes(',')) return splitCsvLine(lines[0]).map((v) => ({ value: unquote(v) }));
    return lines.map((l) => {
      const m = /^\s*:?([A-Za-z_][\w]*)\s*[=:]\s*(.*)$/.exec(l);
      return m ? { name: m[1], value: unquote(m[2]) } : { value: unquote(l) };
    });
  }

  const unquote = (v) => {
    const s = v.trim();
    if (/^null$/i.test(s)) return null;
    if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/.test(s)) return s.slice(1, -1);
    return s;
  };

  function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let q = null;
    for (const ch of line) {
      if (q) {
        if (ch === q) q = null;
        cur += ch;
      } else if (ch === "'" || ch === '"') {
        q = ch;
        cur += ch;
      } else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  const NUMERIC_TYPES = /^(INTEGER|INT|BIGINT|SMALLINT|TINYINT|NUMERIC|DECIMAL|FLOAT|DOUBLE|REAL|Integer|Long|Short|Double|Float|BigDecimal|BigInteger)$/;

  function sqlLiteral(p) {
    if (p.value === null || p.value === undefined) return 'NULL';
    if (typeof p.value === 'number') return String(p.value);
    if (typeof p.value === 'boolean') return p.value ? 'TRUE' : 'FALSE';
    const v = String(p.value);
    if (p.type ? NUMERIC_TYPES.test(p.type) && /^-?\d+(\.\d+)?$/.test(v) : /^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v)) return v;
    if (p.type === 'BOOLEAN' || p.type === 'Boolean' || (!p.type && /^(true|false)$/i.test(v))) return v.toUpperCase();
    return `'${v.replace(/'/g, "''")}'`;
  }

  /** Replace ?, $1, :1 and :name binds with literals. Returns { sql, used, missing }. */
  function fillParams(sql, params) {
    const byName = new Map(params.filter((p) => p.name).map((p) => [p.name.toLowerCase(), p]));
    const positional = params.filter((p) => !p.name);
    let qIndex = 0;
    let used = 0;
    const missing = new Set();
    const out = tokenize(sql).map((t) => {
      if (t.type !== 'bind') return t.text;
      let p;
      if (t.text === '?') p = positional[qIndex++];
      else if (/^\$\d+$/.test(t.text) || /^:\d+$/.test(t.text)) p = positional[Number(t.text.slice(1)) - 1];
      else p = byName.get(t.text.slice(1).toLowerCase()) || positional[qIndex++];
      if (!p) {
        missing.add(t.text);
        return t.text;
      }
      used++;
      return sqlLiteral(p);
    }).join('');
    return { sql: out, used, missing: [...missing] };
  }

  /** Bind placeholders in order of appearance. */
  const listBinds = (sql) => tokenize(sql).filter((t) => t.type === 'bind').map((t) => t.text);

  return { format, minifySql, parseParams, fillParams, listBinds, sqlLiteral };
});
