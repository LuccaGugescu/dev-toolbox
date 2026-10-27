'use strict';

// Tests for the pure engines behind the database / backend tools (src/renderer/lib).
const assert = require('node:assert/strict');
const SqlLexer = require('../src/renderer/lib/sql-lexer');
const SqlFormat = require('../src/renderer/lib/sql-format');
const SqlConvert = require('../src/renderer/lib/sql-convert');
const ExplainPlan = require('../src/renderer/lib/explain');
const DataSql = require('../src/renderer/lib/data-sql');
const Conn = require('../src/renderer/lib/conn');
const Cron = require('../src/renderer/lib/cron');
const Ids = require('../src/renderer/lib/ids');
const DbErrors = require('../src/renderer/lib/db-errors');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- lexer ----------
test('lexer keeps PostgreSQL and Oracle string forms intact', () => {
  const kinds = (sql) => SqlLexer.tokenize(sql).filter((t) => t.type === 'string').map((t) => t.text);
  assert.deepEqual(kinds(String.raw`select E'it\'s', 'a''b', $$x;y$$, $fn$ q $fn$ from t`), [String.raw`E'it\'s'`, "'a''b'", '$$x;y$$', '$fn$ q $fn$']);
  assert.deepEqual(kinds("select q'[it's]' from dual"), ["q'[it's]'"]);
});

test('lexer separates binds from casts', () => {
  const binds = SqlLexer.tokenize('select a::int from t where b = :name and c = ? and d = $2').filter((t) => t.type === 'bind').map((t) => t.text);
  assert.deepEqual(binds, [':name', '?', '$2']);
});

test('splitStatements ignores ; inside strings and comments', () => {
  assert.equal(SqlLexer.splitStatements("select ';' from t; -- a;b\nselect 2;").length, 2);
});

// ---------- formatter ----------
test('formats clauses, joins, AND/OR and subqueries', () => {
  const out = SqlFormat.format('select a, b from t join u on u.id = t.id and u.x > 0 where a = 1 and b in (select id from v) order by a');
  assert.equal(out, [
    'SELECT', '  a,', '  b', 'FROM', '  t', '  JOIN u ON u.id = t.id', '    AND u.x > 0', 'WHERE', '  a = 1',
    '  AND b IN (', '    SELECT', '      id', '    FROM', '      v', '  )', 'ORDER BY', '  a', '',
  ].join('\n'));
});

test('BETWEEN ... AND stays on one line; CASE is laid out', () => {
  const out = SqlFormat.format('select case when x then 1 else 2 end from t where d between 1 and 2 and e = 3');
  assert.equal(out, 'SELECT\n  CASE\n    WHEN x THEN 1\n    ELSE 2\n  END\nFROM\n  t\nWHERE\n  d BETWEEN 1 AND 2\n  AND e = 3\n');
  // inside a function call CASE stays inline
  assert.match(SqlFormat.format('select sum(case when x then 1 else 0 end) from t'), /sum\(CASE WHEN x THEN 1 ELSE 0 END\)/);
});

test('CREATE TABLE lists one column per line and leaves "with time zone" alone', () => {
  const out = SqlFormat.format('create table t (id bigint primary key, ts timestamp with time zone, n numeric(10,2))');
  assert.equal(out, 'CREATE TABLE t (\n  id bigint PRIMARY KEY,\n  ts timestamp WITH time zone,\n  n numeric(10, 2)\n)\n');
});

test('minify keeps strings and Oracle hints, drops comments', () => {
  assert.equal(SqlFormat.minifySql("select /*+ index(t i) */ a -- c\n, 'x  y' from t"), "select /*+ index(t i) */ a,'x  y' from t");
});

test('fills ?, $n and :name binds from several param formats', () => {
  assert.equal(SqlFormat.fillParams('a = ? and b = ?', SqlFormat.parseParams("1\n'O''Neil'")).sql, "a = 1 and b = 'O''Neil'");
  assert.equal(SqlFormat.fillParams('a = $2 and b = $1', SqlFormat.parseParams('[10, "x"]')).sql, "a = 'x' and b = 10");
  assert.equal(SqlFormat.fillParams('a = :id and b = :name', SqlFormat.parseParams('name=null\nid=7')).sql, 'a = 7 and b = NULL');
  const hib = SqlFormat.parseParams('binding parameter [2] as [BIGINT] - [5]\nbinding parameter [1] as [VARCHAR] - [007]');
  assert.equal(SqlFormat.fillParams('x = ? and y = ?', hib).sql, "x = '007' and y = 5");
  assert.deepEqual(SqlFormat.fillParams('a = ? and b = ?', SqlFormat.parseParams('1')).missing, ['?']);
});

// ---------- Oracle <-> PostgreSQL ----------
const o2p = (s) => SqlConvert.convert(s, 'ora2pg');
const p2o = (s) => SqlConvert.convert(s, 'pg2ora');

test('Oracle types map to PostgreSQL types', () => {
  const { sql } = o2p('create table t (a NUMBER(5), b NUMBER(12), c NUMBER(10,2), d VARCHAR2(30 CHAR), e DATE, f CLOB, g BLOB, h NUMBER)');
  assert.equal(sql, 'create table t (a integer, b bigint, c numeric(10, 2), d varchar(30), e timestamp(0), f text, g bytea, h numeric)');
});

test('Oracle functions are rewritten, nested calls too', () => {
  assert.equal(o2p('select NVL(a, NVL(b, 0)) from dual').sql, 'select COALESCE(a, COALESCE(b, 0))');
  assert.equal(o2p("select DECODE(s, 'A', 1, 'B', 2, 0) from t").sql, "select CASE s WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 0 END from t");
  assert.equal(o2p('select DECODE(s, NULL, 0, 1) from t').sql, 'select CASE WHEN s IS NULL THEN 0 ELSE 1 END from t');
  assert.equal(o2p('select my_seq.NEXTVAL, SYSDATE from dual').sql, "select nextval('my_seq'), LOCALTIMESTAMP(0)");
  assert.equal(o2p("select TRUNC(d, 'MM') from t").sql, "select date_trunc('month', d) from t");
  assert.equal(o2p("select LISTAGG(n, ',') WITHIN GROUP (ORDER BY n) from t").sql, "select string_agg(n, ',' ORDER BY n) from t");
  assert.equal(o2p('select a from t MINUS select a from u').sql, 'select a from t EXCEPT select a from u');
});

test('Oracle constructs that need a human are flagged, strings untouched', () => {
  const r = o2p("select 'NVL(x) SYSDATE' from a, b where a.id = b.id(+) and rownum <= 5");
  assert.match(r.sql, /'NVL\(x\) SYSDATE'/);
  const msgs = r.warnings.map((w) => w.message).join('\n');
  assert.match(msgs, /outer join/);
  assert.match(msgs, /ROWNUM/);
});

test('PostgreSQL -> Oracle: types, casts, LIMIT, functions', () => {
  assert.equal(p2o('create table t (id bigserial primary key, ok boolean default true, body text, u uuid)').sql,
    'create table t (id NUMBER(19) GENERATED BY DEFAULT AS IDENTITY primary key, ok NUMBER(1) default 1, body CLOB, u RAW(16))');
  assert.equal(p2o('select x::int, now() from t order by x limit 10 offset 20').sql, 'select CAST(x AS NUMBER(10)), SYSTIMESTAMP from t order by x OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY');
  assert.equal(p2o("select string_agg(n, ', ' order by n), nextval('s') from t").sql, "select LISTAGG(n, ', ') WITHIN GROUP (ORDER BY n), s.NEXTVAL from t");
  assert.ok(p2o('insert into t values (1) on conflict do nothing').warnings.some((w) => /MERGE/.test(w.message)));
});

// ---------- EXPLAIN ----------
const PG_TEXT = `Sort  (cost=10.00..11.00 rows=100 width=8) (actual time=50.000..60.000 rows=5000 loops=1)
  Sort Key: a
  Sort Method: external merge  Disk: 2048kB
  ->  Seq Scan on big b  (cost=0.00..9.00 rows=100 width=8) (actual time=0.010..40.000 rows=5000 loops=1)
        Filter: (status = 1)
        Rows Removed by Filter: 95000
Planning Time: 0.100 ms
Execution Time: 61.000 ms`;

test('PostgreSQL text plan: tree, self time, findings', () => {
  const p = ExplainPlan.parse(PG_TEXT);
  assert.equal(p.dialect, 'postgres');
  assert.equal(p.nodes.length, 2);
  assert.equal(p.root.children[0].relation, 'big');
  assert.equal(p.root.children[0].alias, 'b');
  assert.equal(p.root.exclusiveMs, 20);
  assert.equal(p.executionMs, 61);
  const texts = p.findings.map((f) => f.text).join('\n');
  assert.match(texts, /Sort spilled to disk/);
  assert.match(texts, /Seq Scan read 100,000 rows to keep 5,000/);
  assert.match(texts, /Row estimate off by 50×/);
  assert.equal(p.findings.filter((f) => /estimate/.test(f.text)).length, 1, 'misestimate reported once, at its source');
});

test('PostgreSQL JSON plan', () => {
  const p = ExplainPlan.parse(JSON.stringify([{ Plan: { 'Node Type': 'Hash Join', 'Join Type': 'Left', 'Total Cost': 5, 'Plan Rows': 1, 'Actual Total Time': 3, 'Actual Rows': 1, 'Actual Loops': 1, 'Hash Cond': '(a.id = b.id)', Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'a', 'Index Name': 'a_pk', 'Plan Rows': 1, 'Actual Total Time': 1, 'Actual Rows': 1, 'Actual Loops': 1 }] }, 'Execution Time': 3.2 }]));
  assert.equal(p.root.type, 'Hash Join (Left)');
  assert.equal(p.root.details['Hash Cond'], '(a.id = b.id)');
  assert.equal(p.root.children[0].index, 'a_pk');
  assert.equal(p.findings.length, 0);
});

test('Oracle DBMS_XPLAN ALLSTATS plan with predicates', () => {
  const p = ExplainPlan.parse(`
| Id  | Operation          | Name   | Starts | E-Rows | A-Rows |   A-Time   |
---------------------------------------------------------------------------
|   0 | SELECT STATEMENT   |        |      1 |        |    50K |00:00:01.00 |
|*  1 |  TABLE ACCESS FULL | ORDERS |      1 |     10 |    50K |00:00:01.00 |
---------------------------------------------------------------------------
Predicate Information (identified by operation id):
---------------------------------------------------
   1 - filter("STATUS"='NEW')`);
  assert.equal(p.dialect, 'oracle');
  assert.equal(p.root.children[0].relation, 'ORDERS');
  assert.equal(p.root.children[0].actual.rows, 50000);
  assert.equal(p.root.children[0].details.Filter, '"STATUS"=\'NEW\'');
  assert.ok(p.findings.some((f) => /Full table scan of ORDERS/.test(f.text)));
  assert.ok(p.findings.some((f) => /5,000×/.test(f.text)));
});

// ---------- Data -> SQL ----------
const CSV = 'id,name,price,active,zip\n1,"O\'Brien",10.5,true,007\n2,Ana,3,false,12345\n3,,7.25,true,99999';

test('CSV parsing and type inference (leading zeros stay text)', () => {
  const p = DataSql.parseInput(CSV);
  assert.deepEqual(p.columns, ['id', 'name', 'price', 'active', 'zip']);
  assert.deepEqual(DataSql.inferColumns(p).map((c) => c.kind), ['int', 'text', 'dec', 'bool', 'text']);
});

test('multi-row INSERT and upsert for both dialects', () => {
  const p = DataSql.parseInput(CSV);
  const pg = DataSql.generate(p, { mode: 'insert-multi', dialect: 'postgres', table: 'items' }).sql;
  assert.match(pg, /^INSERT INTO items \(id, name, price, active, zip\) VALUES\n {2}\(1, 'O''Brien', 10\.5, TRUE, '007'\),/);
  assert.match(pg, /\(3, NULL, 7\.25, TRUE, '99999'\);$/);
  const up = DataSql.generate(p, { mode: 'upsert', dialect: 'postgres', table: 'items', keys: ['id'] }).sql;
  assert.match(up, /ON CONFLICT \(id\) DO UPDATE SET\n {2}name = EXCLUDED\.name/);
  const merge = DataSql.generate(p, { mode: 'upsert', dialect: 'oracle', table: 'items', keys: ['id'] }).sql;
  assert.match(merge, /^MERGE INTO items t\nUSING \(\n {2}SELECT 1 AS id/);
  assert.match(merge, /WHEN NOT MATCHED THEN INSERT/);
});

test('Oracle IN list is split at 1000 items', () => {
  const list = DataSql.parseInput(Array.from({ length: 2500 }, (_, i) => i + 1).join('\n'));
  const r = DataSql.generate(list, { mode: 'in-list', dialect: 'oracle' });
  assert.equal((r.sql.match(/ IN \(/g) || []).length, 3);
  assert.equal((r.sql.match(/\n OR /g) || []).length, 2);
});

test('JSON input and CREATE TABLE', () => {
  const p = DataSql.parseInput('[{"id": 1, "meta": {"a": 1}, "at": "2024-01-02T03:04:05Z"}]');
  const sql = DataSql.generate(p, { mode: 'create', dialect: 'postgres', table: 't', keys: ['id'] }).sql;
  assert.equal(sql, 'CREATE TABLE t (\n  id integer NOT NULL,\n  meta jsonb NOT NULL,\n  at timestamp NOT NULL,\n  PRIMARY KEY (id)\n);');
});

// ---------- connection strings ----------
test('parses JDBC / URI / libpq / Oracle forms', () => {
  const pg = Conn.parse('jdbc:postgresql://db:5433/shop?sslmode=require&currentSchema=sales');
  assert.deepEqual([pg.db, pg.host, pg.port, pg.database, pg.sslmode, pg.schema], ['postgres', 'db', 5433, 'shop', 'require', 'sales']);
  const uri = Conn.parse('postgres://app:p%40ss@localhost/shop');
  assert.deepEqual([uri.user, uri.password, uri.port], ['app', 'p@ss', 5432]);
  assert.equal(Conn.parse("host=h dbname=d user=u password='a b'").password, 'a b');
  const sid = Conn.parse('jdbc:oracle:thin:scott/tiger@ora:1521:ORCL');
  assert.deepEqual([sid.db, sid.oracleMode, sid.database, sid.user], ['oracle', 'sid', 'ORCL', 'scott']);
  const tns = Conn.parse('(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=adb)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=svc)))');
  assert.deepEqual([tns.host, tns.port, tns.database, tns.sslmode], ['adb', 1522, 'svc', 'require']);
});

test('builds outputs with a password placeholder and URL-encoding', () => {
  const m = { ...Conn.empty('postgres'), host: 'h', database: 'd', user: 'u', password: 'p@ss' };
  const get = (label, opts) => Conn.build(m, opts).find((o) => o.label.startsWith(label)).value;
  assert.equal(get('JDBC URL'), 'jdbc:postgresql://h:5432/d');
  assert.equal(get('libpq URI', { placeholder: false }), 'postgresql://u:p%40ss@h:5432/d');
  assert.match(get('Spring Boot application.properties'), /spring\.datasource\.password=\$\{DB_PASSWORD\}/);
  const ora = Conn.build({ ...Conn.empty('oracle'), host: 'o', database: 'PDB1' }).find((o) => o.label.startsWith('JDBC URL (thin')).value;
  assert.equal(ora, 'jdbc:oracle:thin:@//o:1521/PDB1');
});

// ---------- cron ----------
const at = (s) => new Date(s);
const nextIso = (expr, from, n = 3, flavor = 'auto') => Cron.next(Cron.parse(expr, flavor), at(from), n, { utc: true }).map((d) => d.toISOString().slice(0, 19));

test('cron flavours are detected and validated', () => {
  assert.equal(Cron.parse('*/5 * * * *').flavor, 'unix');
  assert.equal(Cron.parse('0 0 9 * * MON-FRI').flavor, 'spring');
  assert.equal(Cron.parse('0 0 9 ? * 2-6').flavor, 'quartz');
  assert.throws(() => Cron.parse('60 * * * *'), /Minute must be 0-59/);
  assert.throws(() => Cron.parse('0 0 12 * * MON', 'quartz'), /"\?"/);
});

test('cron next runs: steps, weekdays, L, W, #', () => {
  assert.deepEqual(nextIso('*/15 * * * *', '2026-10-27T10:07:30Z'), ['2026-10-27T10:15:00', '2026-10-27T10:30:00', '2026-10-27T10:45:00']);
  assert.deepEqual(nextIso('0 9 * * 1-5', '2026-10-30T10:00:00Z', 2), ['2026-11-02T09:00:00', '2026-11-03T09:00:00']);
  assert.deepEqual(nextIso('0 0 12 L * ?', '2026-02-01T00:00:00Z', 2), ['2026-02-28T12:00:00', '2026-03-31T12:00:00']);
  assert.deepEqual(nextIso('0 0 10 ? * 6#3', '2026-10-27T00:00:00Z', 1), ['2026-11-20T10:00:00']);
  assert.deepEqual(nextIso('0 0 1 15W * ?', '2026-11-01T00:00:00Z', 1), ['2026-11-16T01:00:00']); // 15th is a Sunday
  // Unix: both day fields restricted = OR
  assert.deepEqual(nextIso('0 0 13 * 5', '2026-11-01T00:00:00Z', 2), ['2026-11-06T00:00:00', '2026-11-13T00:00:00']);
});

test('cron description and conversions', () => {
  assert.equal(Cron.describe(Cron.parse('0 9 * * 1-5')), 'At 09:00, on Monday through Friday');
  assert.equal(Cron.describe(Cron.parse('*/15 * * * *')), 'Every 15 minutes');
  assert.deepEqual(Cron.convert(Cron.parse('0 9 * * 1-5')), { unix: '0 9 * * 1-5', spring: '0 0 9 * * 1-5', quartz: '0 0 9 ? * 2-6' });
  assert.equal(Cron.convert(Cron.parse('0 0 10 ? * 6#3')).spring, '0 0 10 * * 5#3');
  assert.equal(Cron.convert(Cron.parse('0 0/30 8-18 ? * MON-FRI')).unix, '*/30 8-18 * * MON-FRI');
  assert.equal(Cron.convert(Cron.parse('0 5/15 * * * *')).unix, '5-59/15 * * * *');
});

// ---------- ids ----------
test('UUID v7 embeds the current time and sorts', () => {
  const ids = Ids.generate('v7', 50);
  assert.deepEqual([...ids].sort(), ids);
  const r = Ids.inspect(ids[0]);
  assert.match(r.version, /^7/);
  assert.ok(Math.abs(Date.now() - r.time) < 5000);
});

test('UUID forms round-trip (RAW hex, Base64, Java longs) and v1 time decodes', () => {
  const u = '550e8400-e29b-41d4-a716-446655440000';
  const forms = Object.fromEntries(Ids.inspect(u).forms);
  assert.equal(forms['32 hex (Oracle RAW / SYS_GUID)'], '550E8400E29B41D4A716446655440000');
  for (const f of ['550E8400E29B41D4A716446655440000', forms['Base64URL (22 chars)'], forms['Java new UUID(msb, lsb)'].replace(/new UUID\(|L|\)/g, ''), `HEXTORAW('${u.replace(/-/g, '')}')`]) {
    assert.equal(Ids.inspect(f).canonical, u, f);
  }
  assert.equal(new Date(Ids.inspect('C232AB00-9414-11EC-B3C8-9F6BDECED846').time).toISOString(), '2022-02-22T19:22:22.000Z');
});

test('ULID round-trips its timestamp', () => {
  const [id] = Ids.generate('ulid');
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(Math.abs(Date.now() - Ids.inspect(id).time) < 5000);
});

// ---------- DB errors ----------
test('recognises codes, messages, constraint and key in a stack trace', () => {
  const pg = DbErrors.scan('PSQLException: ERROR: duplicate key value violates unique constraint "users_email_key"\n  Detail: Key (email)=(a@b.c) already exists.');
  assert.equal(pg.found[0].entry.code, '23505');
  assert.equal(pg.constraint, 'users_email_key');
  assert.deepEqual(pg.key, { columns: 'email', values: 'a@b.c' });
  const ora = DbErrors.scan('java.sql.SQLException: ORA-00001: unique constraint (APP.UK_NO) violated\nORA-06512: at line 3');
  assert.deepEqual(ora.found.map((f) => f.entry.code), ['ORA-00001', 'ORA-06512']);
  assert.equal(ora.constraint, 'APP.UK_NO');
  assert.equal(DbErrors.scan('SQL state [40P01]').found[0].entry.name, 'deadlock_detected');
  assert.ok(DbErrors.search('pgbouncer').length >= 1);
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
