'use strict';

// SQL tokenizer shared by the SQL tools. Understands PostgreSQL and Oracle lexical quirks:
// 'strings' with '' escapes, E'...' escape strings, $tag$ dollar quotes $tag$, Oracle q'[...]' quotes,
// "quoted identifiers", -- and /* */ comments, :named / :1 / ? / $1 binds and :: casts.
// Token: { type, text } where type is one of
//   ws, comment, string, ident, qident, keyword, number, bind, op, punct
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SqlLexer = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const KEYWORDS = new Set(`
    ADD ALL ALTER AND ANY ARRAY AS ASC BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLUMN COMMENT COMMIT
    CONFLICT CONNECT CONSTRAINT CREATE CROSS CURRENT_DATE CURRENT_TIMESTAMP CURSOR DECLARE DEFAULT DELETE
    DESC DISTINCT DO DROP ELSE ELSIF END EXCEPT EXCEPTION EXECUTE EXISTS EXPLAIN FALSE FETCH FIRST FOR
    FOREIGN FROM FULL FUNCTION GRANT GROUP HAVING IF ILIKE IN INDEX INNER INSERT INTERSECT INTERVAL INTO IS
    JOIN KEY LATERAL LEFT LIKE LIMIT LOOP MATCHED MERGE MINUS NATURAL NEXT NOT NOTHING NULL NULLS OF OFFSET ON
    ONLY OR ORDER OUTER OVER PACKAGE PARTITION PRIMARY PRIOR PROCEDURE RAISE RECURSIVE REFERENCES REPLACE
    RETURN RETURNING RETURNS REVOKE RIGHT ROLLBACK ROW ROWS SCHEMA SELECT SEQUENCE SET START TABLE THEN TO
    TRIGGER TRUE TRUNCATE UNION UNIQUE UPDATE USING VALUES VIEW WHEN WHERE WINDOW WITH WITHIN
  `.trim().split(/\s+/));

  const OPS = ['::', '||', '<=', '>=', '<>', '!=', '=>', ':=', '->>', '->', '#>>', '#>', '@>', '<@', '?|', '?&', '**'];

  function tokenize(sql) {
    const tokens = [];
    let i = 0;
    const n = sql.length;
    const push = (type, start) => tokens.push({ type, text: sql.slice(start, i) });

    while (i < n) {
      const start = i;
      const c = sql[i];
      const next = sql[i + 1];

      if (/\s/.test(c)) {
        while (i < n && /\s/.test(sql[i])) i++;
        push('ws', start);
      } else if (c === '-' && next === '-') {
        while (i < n && sql[i] !== '\n') i++;
        push('comment', start);
      } else if (c === '/' && next === '*') {
        const end = sql.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 2;
        push('comment', start);
      } else if ((c === 'q' || c === 'Q' || ((c === 'n' || c === 'N') && (sql[i + 1] === 'q' || sql[i + 1] === 'Q'))) && /^[nN]?[qQ]'/.test(sql.slice(i, i + 3))) {
        // Oracle alternative quoting: q'[...]', q'{...}', q'!...!'
        const qAt = sql[i] === 'q' || sql[i] === 'Q' ? i : i + 1;
        const open = sql[qAt + 2];
        const close = { '[': ']', '{': '}', '(': ')', '<': '>' }[open] || open;
        const end = sql.indexOf(close + "'", qAt + 3);
        i = end < 0 ? n : end + 2;
        push('string', start);
      } else if ((c === 'E' || c === 'e' || c === 'N' || c === 'n' || c === 'B' || c === 'b' || c === 'X' || c === 'x' || c === 'U' || c === 'u') && next === "'") {
        const escapes = c === 'E' || c === 'e';
        i += 2;
        i = scanQuoted(sql, i, "'", escapes);
        push('string', start);
      } else if (c === "'") {
        i = scanQuoted(sql, i + 1, "'", false);
        push('string', start);
      } else if (c === '"') {
        i = scanQuoted(sql, i + 1, '"', false);
        push('qident', start);
      } else if (c === '$' && /[A-Za-z_$]/.test(next || '') && /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.test(sql.slice(i))) {
        const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(sql.slice(i))[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
        push('string', start);
      } else if (c === '$' && /\d/.test(next || '')) {
        i++;
        while (i < n && /\d/.test(sql[i])) i++;
        push('bind', start);
      } else if (c === '?' && !/[|&]/.test(next || '')) {
        i++;
        push('bind', start);
      } else if (c === ':' && /[A-Za-z0-9_]/.test(next || '') && sql[i - 1] !== ':') {
        i++;
        while (i < n && /[A-Za-z0-9_]/.test(sql[i])) i++;
        push('bind', start);
      } else if (/\d/.test(c) || (c === '.' && /\d/.test(next || ''))) {
        while (i < n && /[\d.]/.test(sql[i])) {
          if (sql[i] === '.' && sql[i + 1] === '.') break; // range "1..10" in PL/SQL
          i++;
        }
        if (/[eE]/.test(sql[i] || '') && /[\d+-]/.test(sql[i + 1] || '')) {
          i += 2;
          while (i < n && /\d/.test(sql[i])) i++;
        }
        push('number', start);
      } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
        while (i < n && /[A-Za-z0-9_$#\u0080-￿]/.test(sql[i])) i++;
        const text = sql.slice(start, i);
        tokens.push({ type: KEYWORDS.has(text.toUpperCase()) ? 'keyword' : 'ident', text });
      } else {
        const op = OPS.find((o) => sql.startsWith(o, i));
        if (op) {
          i += op.length;
          push('op', start);
        } else {
          i++;
          push('()[],;.'.includes(c) ? 'punct' : 'op', start);
        }
      }
    }
    return tokens;
  }

  function scanQuoted(sql, i, quote, backslashEscapes) {
    while (i < sql.length) {
      if (backslashEscapes && sql[i] === '\\') { i += 2; continue; }
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) { i += 2; continue; }
        return i + 1;
      }
      i++;
    }
    return i;
  }

  /** Tokens without whitespace and comments. */
  const significant = (tokens) => tokens.filter((t) => t.type !== 'ws' && t.type !== 'comment');

  /** Split on top-level ";" (outside strings, comments, parentheses and BEGIN..END blocks is not tracked). */
  function splitStatements(sql) {
    const out = [];
    let cur = [];
    for (const t of tokenize(sql)) {
      if (t.type === 'punct' && t.text === ';') {
        out.push(cur);
        cur = [];
      } else cur.push(t);
    }
    if (cur.some((t) => t.type !== 'ws' && t.type !== 'comment')) out.push(cur);
    return out.filter((s) => s.some((t) => t.type !== 'ws'));
  }

  return { tokenize, significant, splitStatements, KEYWORDS };
});
