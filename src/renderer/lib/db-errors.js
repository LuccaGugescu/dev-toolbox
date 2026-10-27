'use strict';

// Reference of the Oracle (ORA-) and PostgreSQL (SQLSTATE) errors backend developers hit most,
// with cause and fix, plus extraction of codes / constraint names from a pasted stack trace.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DbErrors = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // [code, title, cause, fix, springException?]
  const ORACLE = [
    ['ORA-00001', 'unique constraint violated', 'An INSERT or UPDATE created a duplicate value in a column with a UNIQUE / PRIMARY KEY constraint (the message names the constraint).', 'Look up the constraint: SELECT table_name, column_name FROM all_cons_columns WHERE constraint_name = \'…\'. For sequence-backed ids the sequence is often behind the data: raise it with ALTER SEQUENCE … RESTART START WITH (MAX(id)+1) (18c+). For "insert or update" use MERGE.', 'DuplicateKeyException / DataIntegrityViolationException'],
    ['ORA-00018', 'maximum number of sessions exceeded', 'The instance reached its SESSIONS limit.', 'Check connection leaks and pool sizes (sum of max pool size across all app instances); raise SESSIONS / PROCESSES if justified.'],
    ['ORA-00020', 'maximum number of processes exceeded', 'The PROCESSES parameter limit was reached (each dedicated connection is a process).', 'Shrink connection pools, close leaked connections, or raise PROCESSES (needs restart).'],
    ['ORA-00054', 'resource busy and acquire with NOWAIT specified or timeout expired', 'DDL or SELECT … FOR UPDATE NOWAIT needed a lock another session holds.', 'Find the blocker: SELECT sid, blocking_session, event FROM v$session WHERE blocking_session IS NOT NULL. Commit/rollback it, retry later, or use DDL_LOCK_TIMEOUT / FOR UPDATE WAIT n.', 'CannotAcquireLockException'],
    ['ORA-00060', 'deadlock detected while waiting for resource', 'Two sessions each hold a row lock the other needs. Oracle rolled back one statement (not the transaction).', 'Always lock/update rows in the same order (e.g. ORDER BY id), keep transactions short, index foreign-key columns (unindexed FKs cause table locks). Check the trace file named in the alert log.', 'DeadlockLoserDataAccessException / CannotAcquireLockException'],
    ['ORA-00900', 'invalid SQL statement', 'The statement is not SQL Oracle understands (often a PL/SQL or SQL*Plus command sent through JDBC, e.g. EXEC / DESC).', 'Wrap PL/SQL in BEGIN … END; and call it with CallableStatement; SQL*Plus commands cannot be sent through JDBC.'],
    ['ORA-00904', 'invalid identifier', 'A column name does not exist, is misspelled, is out of scope (e.g. a SELECT alias used in WHERE), or was created with quotes in mixed case.', 'Check the column with DESC table. Quoted "camelCase" columns must always be quoted. Aliases cannot be used in WHERE / GROUP BY of the same query level.', 'BadSqlGrammarException'],
    ['ORA-00905', 'missing keyword', 'Syntax error: a required keyword is missing (frequently PostgreSQL / MySQL syntax such as LIMIT, or a misplaced AS for a table alias).', 'Oracle table aliases cannot use AS. Use FETCH FIRST n ROWS ONLY instead of LIMIT.', 'BadSqlGrammarException'],
    ['ORA-00907', 'missing right parenthesis', 'Usually not a parenthesis problem: invalid syntax inside parentheses, such as ORDER BY in a subquery used with IN, or a wrong data type in DDL.', 'Check the syntax inside the parentheses; remove ORDER BY from IN subqueries.', 'BadSqlGrammarException'],
    ['ORA-00911', 'invalid character', 'An invalid character in the statement — most often a trailing ";" sent through JDBC, or a smart quote.', 'Remove the trailing semicolon from SQL executed via JDBC / JPA native queries (keep it only after END in PL/SQL).', 'BadSqlGrammarException'],
    ['ORA-00913', 'too many values', 'An INSERT lists more values than columns, or a subquery returns more columns than expected.', 'Make the column list and VALUES / SELECT list the same length.', 'BadSqlGrammarException'],
    ['ORA-00917', 'missing comma', 'Syntax error in a list, often in INSERT … VALUES.', 'Check commas and quotes in the VALUES list.', 'BadSqlGrammarException'],
    ['ORA-00918', 'column ambiguously defined', 'A column name exists in more than one joined table and is referenced without an alias.', 'Qualify the column: t.col. Also happens with SELECT * over joins inside a subquery with duplicate names.', 'BadSqlGrammarException'],
    ['ORA-00923', 'FROM keyword not found where expected', 'Syntax error in the SELECT list: a missing comma, a reserved word used as alias, or a missing FROM (Oracle needs FROM DUAL before 23ai).', 'Add FROM DUAL, quote reserved-word aliases, check commas.', 'BadSqlGrammarException'],
    ['ORA-00932', 'inconsistent datatypes', 'An expression mixes incompatible types, e.g. comparing a CLOB with =, or DATE with NUMBER.', 'Use DBMS_LOB.COMPARE / TO_CHAR(clob) for CLOBs; convert explicitly with TO_DATE / TO_NUMBER. Check JPA mapping of Boolean / LocalDate fields.', 'BadSqlGrammarException'],
    ['ORA-00933', 'SQL command not properly ended', 'Unexpected text after the end of the statement: a PostgreSQL clause (LIMIT, ON CONFLICT, RETURNING), AS before a table alias, or a stray character.', 'Use FETCH FIRST n ROWS ONLY, MERGE, and table aliases without AS.', 'BadSqlGrammarException'],
    ['ORA-00936', 'missing expression', 'Part of an expression is missing: an empty SELECT list item, a trailing comma, or an unbound parameter rendered as empty.', 'Check for "SELECT , col", "WHERE x = " or a dynamic SQL builder that produced an empty fragment.', 'BadSqlGrammarException'],
    ['ORA-00937', 'not a single-group group function', 'A SELECT mixes aggregates (COUNT, SUM) with columns that are not in GROUP BY.', 'Add the non-aggregated columns to GROUP BY, or use an analytic function (COUNT(*) OVER ()).', 'BadSqlGrammarException'],
    ['ORA-00942', 'table or view does not exist', 'The table does not exist, is in another schema, or the user lacks a grant on it (Oracle reports missing privileges this way).', 'Check the owner: SELECT owner FROM all_tables WHERE table_name = \'X\'. Prefix the schema, create a synonym, or GRANT SELECT. Mind case: unquoted names are stored in UPPER case.', 'BadSqlGrammarException'],
    ['ORA-00955', 'name is already used by an existing object', 'CREATE of a table/index/sequence whose name already exists in the schema.', 'Drop it first, or check existence in USER_OBJECTS (Oracle 23ai supports CREATE … IF NOT EXISTS). Common with Flyway/Liquibase re-runs.'],
    ['ORA-00979', 'not a GROUP BY expression', 'A selected column or ORDER BY expression is not in GROUP BY.', 'Add the expression to GROUP BY or aggregate it.', 'BadSqlGrammarException'],
    ['ORA-01000', 'maximum open cursors exceeded', 'The session has more open cursors than OPEN_CURSORS — almost always Statements / ResultSets not closed in the application.', 'Close statements and result sets (try-with-resources). Check v$open_cursor for the leaking SQL. Raising OPEN_CURSORS only delays the failure.'],
    ['ORA-01008', 'not all variables bound', 'The statement has bind placeholders (:x or ?) with no value set — often a ":" inside a string literal or comment confused for a bind.', 'Set every parameter. In JPA / JdbcTemplate escape literal colons (\\\\:) or avoid them in native SQL.', 'InvalidDataAccessApiUsageException'],
    ['ORA-01017', 'invalid username/password; logon denied', 'Wrong credentials, case-sensitive password mismatch, or the user is in another PDB.', 'Verify user/password and connect to the right service (PDB, not CDB root). Passwords are case-sensitive since 11g.', 'CannotGetJdbcConnectionException'],
    ['ORA-01031', 'insufficient privileges', 'The user lacks the system or object privilege for this action.', 'GRANT the specific privilege (CREATE TABLE, EXECUTE ON pkg, …). Privileges granted via roles do not work inside definer-rights PL/SQL.'],
    ['ORA-01033', 'ORACLE initialization or shutdown in progress', 'The database or PDB is starting, stopping, or mounted but not open.', 'Wait, or open it: ALTER PLUGGABLE DATABASE x OPEN. In Docker, wait for "DATABASE IS READY TO USE!".'],
    ['ORA-01034', 'ORACLE not available', 'The instance is not running (or ORACLE_SID points to a different one).', 'Start the instance; check ORACLE_SID / the listener service.'],
    ['ORA-01400', 'cannot insert NULL into ("SCHEMA"."TABLE"."COLUMN")', 'A NOT NULL column received NULL. In Oracle an empty string \'\' is NULL too.', 'Provide a value or a column DEFAULT. Watch for empty strings coming from forms, and for identity columns needing GENERATED BY DEFAULT ON NULL.', 'DataIntegrityViolationException'],
    ['ORA-01403', 'no data found', 'SELECT … INTO in PL/SQL returned no rows.', 'Handle the NO_DATA_FOUND exception, or use a cursor / aggregate (MAX) that always returns a row.', 'EmptyResultDataAccessException'],
    ['ORA-01422', 'exact fetch returns more than requested number of rows', 'SELECT … INTO in PL/SQL returned more than one row.', 'Make the WHERE unique, add FETCH FIRST 1 ROW ONLY, or handle TOO_MANY_ROWS.', 'IncorrectResultSizeDataAccessException'],
    ['ORA-01427', 'single-row subquery returns more than one row', 'A subquery used with = (or in the SELECT list) returned several rows.', 'Use IN / EXISTS, aggregate the subquery, or make it unique.'],
    ['ORA-01438', 'value larger than specified precision allowed for this column', 'A number does not fit NUMBER(p, s), e.g. 1000 into NUMBER(3) or 10.5 into NUMBER(3,2).', 'Widen the column or validate input; the integer part may have at most p - s digits.', 'DataIntegrityViolationException'],
    ['ORA-01452', 'cannot CREATE UNIQUE INDEX; duplicate keys found', 'Existing data already has duplicates for the new unique index.', 'Find them: SELECT col, COUNT(*) FROM t GROUP BY col HAVING COUNT(*) > 1.'],
    ['ORA-01476', 'divisor is equal to zero', 'Division by zero.', 'Use NULLIF(divisor, 0) or a CASE expression.'],
    ['ORA-01555', 'snapshot too old: rollback segment number … too small', 'A long-running query needed undo data that was already overwritten.', 'Make the query faster, avoid fetching across commits, raise UNDO_RETENTION and the undo tablespace size.'],
    ['ORA-01652', 'unable to extend temp segment by … in tablespace TEMP', 'TEMP tablespace is full: a huge sort / hash join or a query without a join condition.', 'Check the plan for cartesian joins; add tempfile space if the workload is legitimate.'],
    ['ORA-01653', 'unable to extend table … in tablespace', 'The data tablespace is full.', 'Add a datafile or enable AUTOEXTEND; purge old data.'],
    ['ORA-01722', 'invalid number', 'A string that is not a number was converted to NUMBER — often an implicit conversion comparing a VARCHAR2 column to a number.', 'Compare strings with strings (WHERE code = \'123\'), use TO_NUMBER(x DEFAULT NULL ON CONVERSION ERROR) (12.2+), and check NLS decimal separators.', 'DataIntegrityViolationException / UncategorizedSQLException'],
    ['ORA-01747', 'invalid user.table.column, table.column, or column specification', 'A reserved word (e.g. USER, DATE, LEVEL, COMMENT, ORDER) is used as a column name unquoted.', 'Quote the column ("COMMENT") or rename it; in JPA use @Column(name = "\\"COMMENT\\"").', 'BadSqlGrammarException'],
    ['ORA-01795', 'maximum number of expressions in a list is 1000', 'An IN (...) list has more than 1000 items.', 'Split into OR-ed IN lists of 1000, join against a temporary table / collection (TABLE(:arr)), or use a subquery.', 'BadSqlGrammarException'],
    ['ORA-01830', 'date format picture ends before converting entire input string', 'TO_DATE input is longer than the format (e.g. time part present but format is \'YYYY-MM-DD\').', 'Match the format to the input, e.g. \'YYYY-MM-DD HH24:MI:SS\'; better: bind java.time values instead of strings.'],
    ['ORA-01843', 'not a valid month', 'A date string does not match the format / NLS_DATE_FORMAT / NLS_DATE_LANGUAGE.', 'Use explicit TO_DATE(str, \'YYYY-MM-DD\') or ANSI DATE \'2024-01-31\' literals; bind dates as parameters.'],
    ['ORA-01858', 'a non-numeric character was found where a numeric was expected', 'The date string and format mask disagree.', 'Fix the TO_DATE format mask, or bind a java.sql.Date / LocalDate.'],
    ['ORA-01861', 'literal does not match format string', 'A date string is converted with the session NLS_DATE_FORMAT, which differs from the string.', 'Always pass an explicit format to TO_DATE / TO_TIMESTAMP, or bind date parameters.'],
    ['ORA-02049', 'timeout: distributed transaction waiting for lock', 'A distributed (DB link / XA) transaction waited longer than DISTRIBUTED_LOCK_TIMEOUT.', 'Find and end the blocking session; keep XA transactions short.'],
    ['ORA-02291', 'integrity constraint violated - parent key not found', 'An INSERT/UPDATE set a foreign key to a value that does not exist in the parent table.', 'Insert the parent first (check flush order in JPA), or fix the referenced id.', 'DataIntegrityViolationException'],
    ['ORA-02292', 'integrity constraint violated - child record found', 'DELETE of a parent row that still has child rows.', 'Delete children first, or use ON DELETE CASCADE / orphanRemoval in JPA.', 'DataIntegrityViolationException'],
    ['ORA-02290', 'check constraint violated', 'A value broke a CHECK constraint (the message names it).', 'Look up the condition: SELECT search_condition FROM all_constraints WHERE constraint_name = \'…\'.', 'DataIntegrityViolationException'],
    ['ORA-03113', 'end-of-file on communication channel', 'The connection was dropped: server process died, firewall/NAT idle timeout, or the instance crashed.', 'Check the alert log; enable keepalive / validation in the pool (Hikari keepaliveTime, maxLifetime below the firewall timeout).', 'DataAccessResourceFailureException'],
    ['ORA-04031', 'unable to allocate … bytes of shared memory', 'The shared pool is fragmented or too small — commonly caused by SQL built with literals instead of bind variables.', 'Use bind variables; size SGA / shared pool properly.'],
    ['ORA-04061', 'existing state of package has been invalidated', 'A package was recompiled while sessions held its state.', 'Retry (the session reinitialises); deploy package changes when pools are drained, or make packages stateless.'],
    ['ORA-04068', 'existing state of packages has been discarded', 'Same as ORA-04061: package state was reset after recompilation.', 'Retry the call; avoid package-level variables in pooled applications.'],
    ['ORA-04091', 'table … is mutating, trigger/function may not see it', 'A row-level trigger queries or modifies the table that fired it.', 'Use a compound trigger, or move the logic to a statement-level trigger / the application.'],
    ['ORA-06502', 'PL/SQL: numeric or value error', 'A value does not fit a PL/SQL variable (string too long for VARCHAR2(n), number conversion).', 'Enlarge the variable (%TYPE anchoring helps) or validate the input length.'],
    ['ORA-06508', 'PL/SQL: could not find program unit being called', 'A called package/procedure is invalid or missing.', 'Recompile: ALTER PACKAGE x COMPILE; check USER_ERRORS.'],
    ['ORA-06512', 'at line …', 'Stack-trace line for the error above it; not an error by itself.', 'Read the first ORA- error in the stack: that is the real cause.'],
    ['ORA-06550', 'line …, column …: PL/SQL compilation error', 'An anonymous block or procedure does not compile.', 'Read the PLS- error that follows (e.g. PLS-00201 identifier must be declared).'],
    ['ORA-08177', "can't serialize access for this transaction", 'A SERIALIZABLE transaction tried to change rows modified by another committed transaction.', 'Retry the transaction, or use READ COMMITTED with explicit locking.', 'CannotSerializeTransactionException'],
    ['ORA-12154', 'TNS:could not resolve the connect identifier specified', 'The TNS alias is not in tnsnames.ora (or TNS_ADMIN is not set).', 'Use EZConnect (//host:port/service) or set TNS_ADMIN / -Doracle.net.tns_admin to the folder with tnsnames.ora.', 'CannotGetJdbcConnectionException'],
    ['ORA-12505', 'TNS:listener does not currently know of SID given in connect descriptor', 'Connected with a SID (host:port:SID) that the listener does not have — usually it is a service name.', 'Use the service-name form jdbc:oracle:thin:@//host:port/SERVICE. List services with lsnrctl status.', 'CannotGetJdbcConnectionException'],
    ['ORA-12514', 'TNS:listener does not currently know of service requested', 'The service name is wrong, or the database / PDB has not registered with the listener yet.', 'Check lsnrctl services; in containers the PDB (e.g. FREEPDB1, XEPDB1, ORCLPDB1) is the service to use.', 'CannotGetJdbcConnectionException'],
    ['ORA-12516', 'TNS:listener could not find available handler', 'The database reached PROCESSES / SESSIONS, so the listener rejects new connections.', 'See ORA-00020: reduce pool sizes or raise PROCESSES.', 'CannotGetJdbcConnectionException'],
    ['ORA-12519', 'TNS:no appropriate service handler found', 'Same root cause as ORA-12516: connection limit reached (often a pool storm).', 'Reduce max pool size, fix leaks, raise PROCESSES.', 'CannotGetJdbcConnectionException'],
    ['ORA-12537', 'TNS:connection closed', 'The listener or server closed the connection: process limit, invalid node checking, or a firewall.', 'Check listener.log and sqlnet.ora (tcp.validnode_checking).', 'CannotGetJdbcConnectionException'],
    ['ORA-12541', 'TNS:no listener', 'Nothing listens on host:port.', 'Check host / port (default 1521), that the listener is started, and firewall / Docker port mapping.', 'CannotGetJdbcConnectionException'],
    ['ORA-12899', 'value too large for column … (actual: n, maximum: m)', 'A string exceeds the column length. With VARCHAR2(n BYTE), multi-byte characters (é, €) count 2-3 bytes.', 'Enlarge the column or declare it VARCHAR2(n CHAR); validate length in the application (@Size).', 'DataIntegrityViolationException'],
    ['ORA-14400', 'inserted partition key does not map to any partition', 'A row\'s partition key is outside every defined range partition.', 'Add the partition, or switch to INTERVAL partitioning.'],
    ['ORA-28000', 'the account is locked', 'Too many failed logins, or an administrator locked the account.', 'ALTER USER x ACCOUNT UNLOCK; fix the wrong password in the deployed config so retries do not relock it.', 'CannotGetJdbcConnectionException'],
    ['ORA-28001', 'the password has expired', 'The profile\'s PASSWORD_LIFE_TIME elapsed.', 'Change the password; for service accounts use a profile with PASSWORD_LIFE_TIME UNLIMITED.', 'CannotGetJdbcConnectionException'],
    ['ORA-30036', 'unable to extend segment by … in undo tablespace', 'The undo tablespace is full — usually a single huge transaction.', 'Commit in batches; size UNDO properly.'],
    ['ORA-17002', 'IO Error (JDBC driver)', 'Network-level failure between the JDBC driver and the database: connection refused / reset / timed out.', 'Check host, port, firewall, VPN; set connect and read timeouts (oracle.net.CONNECT_TIMEOUT, oracle.jdbc.ReadTimeout).', 'DataAccessResourceFailureException'],
    ['ORA-17008', 'Closed Connection (JDBC driver)', 'Code used a connection after it was closed / returned to the pool, or the server killed it.', 'Do not keep Connection references; enable pool validation.'],
    ['ORA-17410', 'No more data to read from socket (JDBC driver)', 'The server process ended abruptly (crash, kill, ORA-600) or the network dropped.', 'Check the alert log and trace files for an internal error.'],
  ];

  const POSTGRES = [
    ['23505', 'unique_violation', 'duplicate key value violates unique constraint "…"', 'A row with the same value already exists in a unique / primary key index. DETAIL shows the key: Key (email)=(a@b.c) already exists.', 'Use INSERT … ON CONFLICT (col) DO UPDATE / DO NOTHING. For serial/identity ids out of sync after manual inserts: SELECT setval(pg_get_serial_sequence(\'t\', \'id\'), MAX(id)) FROM t.', 'DuplicateKeyException'],
    ['23503', 'foreign_key_violation', 'insert or update on table "…" violates foreign key constraint "…"', 'The referenced parent row does not exist (insert), or child rows still reference the row being deleted.', 'Insert parents first / delete children first, or use ON DELETE CASCADE. In JPA check cascade and flush order.', 'DataIntegrityViolationException'],
    ['23502', 'not_null_violation', 'null value in column "…" of relation "…" violates not-null constraint', 'A NOT NULL column got NULL.', 'Provide a value or a DEFAULT. With JPA, check that the entity field is set and that @GeneratedValue matches the column (IDENTITY vs SEQUENCE).', 'DataIntegrityViolationException'],
    ['23514', 'check_violation', 'new row for relation "…" violates check constraint "…"', 'A value broke a CHECK constraint.', 'Show it with \\d+ table or SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = \'…\'.', 'DataIntegrityViolationException'],
    ['23P01', 'exclusion_violation', 'conflicting key value violates exclusion constraint "…"', 'A row overlaps another under an EXCLUDE constraint (e.g. overlapping time ranges).', 'Adjust the range or handle the conflict in the application.', 'DataIntegrityViolationException'],
    ['22001', 'string_data_right_truncation', 'value too long for type character varying(n)', 'A string is longer than the varchar(n) limit (counted in characters).', 'Enlarge the column (ALTER TABLE … ALTER COLUMN … TYPE varchar(m)), or use text; validate with @Size.', 'DataIntegrityViolationException'],
    ['22003', 'numeric_value_out_of_range', 'numeric field overflow / integer out of range', 'A number does not fit the column type (e.g. > 2147483647 into integer, or too many digits for numeric(p,s)).', 'Use bigint / a wider numeric. Serial columns overflowing at 2^31: migrate to bigint.', 'DataIntegrityViolationException'],
    ['22P02', 'invalid_text_representation', 'invalid input syntax for type integer / uuid: "…"', 'A string could not be parsed into the target type — e.g. "abc" for an integer or a malformed UUID.', 'Validate input; make sure the parameter type matches the column (a String bound against a uuid column needs ?::uuid or setObject(UUID)).', 'DataIntegrityViolationException'],
    ['22007', 'invalid_datetime_format', 'invalid input syntax for type timestamp', 'A date/time string is not in a recognized format.', 'Use ISO-8601 (2024-01-31 13:45:00) or bind java.time types.'],
    ['22008', 'datetime_field_overflow', 'date/time field value out of range', 'An impossible date (month 13) or ambiguous day/month order for the DateStyle setting.', 'Use ISO dates, or set DateStyle explicitly.'],
    ['22012', 'division_by_zero', 'division by zero', 'Division by zero.', 'Use NULLIF(divisor, 0).'],
    ['22021', 'character_not_in_repertoire', 'invalid byte sequence for encoding "UTF8"', 'Input bytes are not valid UTF-8 (e.g. Latin-1 data, or a NUL byte 0x00 which PostgreSQL text cannot store).', 'Fix the client encoding (client_encoding / JDBC charset), strip \\u0000 from strings.'],
    ['22023', 'invalid_parameter_value', 'invalid parameter value', 'A function argument or setting value is invalid.', 'Check the argument against the function documentation.'],
    ['21000', 'cardinality_violation', 'more than one row returned by a subquery used as an expression', 'A scalar subquery returned several rows (or ON CONFLICT DO UPDATE touched the same row twice).', 'Make the subquery unique / aggregate it; deduplicate rows inside one INSERT … ON CONFLICT batch.'],
    ['40001', 'serialization_failure', 'could not serialize access due to concurrent update / read/write dependencies', 'A REPEATABLE READ or SERIALIZABLE transaction conflicted with a concurrent one.', 'Retry the whole transaction (this is expected under these isolation levels); Spring @Retryable works well.', 'CannotAcquireLockException / CannotSerializeTransactionException'],
    ['40P01', 'deadlock_detected', 'deadlock detected', 'Two transactions waited on locks held by each other; PostgreSQL aborted one.', 'Lock rows in a consistent order (ORDER BY id … FOR UPDATE), keep transactions short, retry.', 'CannotAcquireLockException'],
    ['55P03', 'lock_not_available', 'could not obtain lock on row in relation "…" / canceling statement due to lock timeout', 'NOWAIT or lock_timeout hit a lock held by another transaction.', 'Find the blocker: SELECT pid, pg_blocking_pids(pid), query FROM pg_stat_activity WHERE wait_event_type = \'Lock\'. Use SKIP LOCKED for queue-style workers.', 'CannotAcquireLockException / PessimisticLockingFailureException'],
    ['57014', 'query_canceled', 'canceling statement due to statement timeout / user request', 'statement_timeout elapsed or the client cancelled (JDBC setQueryTimeout, Spring @Transactional(timeout)).', 'Speed up the query (EXPLAIN ANALYZE) or raise the timeout for that statement: SET LOCAL statement_timeout = \'60s\'.', 'QueryTimeoutException'],
    ['57P01', 'admin_shutdown', 'terminating connection due to administrator command', 'The server is shutting down or pg_terminate_backend() killed the session.', 'Let the pool reconnect; check for failovers / restarts.', 'DataAccessResourceFailureException'],
    ['57P03', 'cannot_connect_now', 'the database system is starting up / in recovery mode', 'The server is starting or recovering.', 'Retry with backoff; in Docker wait for "ready to accept connections".'],
    ['25P02', 'in_failed_sql_transaction', 'current transaction is aborted, commands ignored until end of transaction block', 'An earlier statement in this transaction failed; PostgreSQL rejects everything until ROLLBACK.', 'Find the FIRST error in the log — it is the real one. Roll back, or use SAVEPOINTs to continue after expected errors.', 'InvalidDataAccessResourceUsageException'],
    ['25006', 'read_only_sql_transaction', 'cannot execute INSERT in a read-only transaction', 'A write ran on a read replica, or in a transaction marked read-only (@Transactional(readOnly = true)).', 'Route writes to the primary; remove readOnly on writing methods.'],
    ['42P01', 'undefined_table', 'relation "…" does not exist', 'The table is missing, in a schema not on search_path, or was created with quotes in mixed case ("Users" ≠ users).', 'Check \\dt *.name, set search_path / currentSchema, quote mixed-case names, check that migrations ran.', 'BadSqlGrammarException'],
    ['42703', 'undefined_column', 'column "…" does not exist', 'Column misspelled, missing (migration not run), mixed-case without quotes, or a string literal written with double quotes ("text" is an identifier in SQL).', 'Use single quotes for strings; check the column with \\d table.', 'BadSqlGrammarException'],
    ['42601', 'syntax_error', 'syntax error at or near "…"', 'Invalid SQL near the reported token: reserved word as identifier (user, order), Oracle / MySQL syntax, or a trailing comma.', 'Quote reserved words ("user"), check the token named in the message.', 'BadSqlGrammarException'],
    ['42883', 'undefined_function', 'function …(…) does not exist / operator does not exist: character varying = integer', 'No function/operator for these argument types — PostgreSQL does not cast implicitly between text and numbers.', 'Add an explicit cast (col::int, ?::uuid), install the extension (pgcrypto, uuid-ossp), or fix the bound parameter type.', 'BadSqlGrammarException'],
    ['42804', 'datatype_mismatch', 'column "…" is of type … but expression is of type …', 'Inserting a value of the wrong type (e.g. varchar into jsonb, bigint into boolean).', 'Cast explicitly (?::jsonb). With JDBC set stringtype=unspecified, or map the type properly (Hibernate @JdbcTypeCode(SqlTypes.JSON)).', 'BadSqlGrammarException'],
    ['42P07', 'duplicate_table', 'relation "…" already exists', 'CREATE TABLE / INDEX for an object that exists.', 'Use IF NOT EXISTS; check migration history.'],
    ['42710', 'duplicate_object', 'constraint / type / role "…" already exists', 'Creating an object that exists.', 'Drop it or guard with a DO block / IF NOT EXISTS.'],
    ['42501', 'insufficient_privilege', 'permission denied for table / schema "…"', 'The role lacks a GRANT. Since PostgreSQL 15, ordinary users cannot create objects in the public schema by default.', 'GRANT SELECT/INSERT … ON … TO role; GRANT USAGE, CREATE ON SCHEMA … TO role; set ALTER DEFAULT PRIVILEGES for future tables.', 'BadSqlGrammarException'],
    ['42702', 'ambiguous_column', 'column reference "…" is ambiguous', 'A column name exists in more than one joined table, or a PL/pgSQL variable has the same name as a column.', 'Qualify with the table alias; rename PL/pgSQL variables (v_id).', 'BadSqlGrammarException'],
    ['42803', 'grouping_error', 'column "…" must appear in the GROUP BY clause or be used in an aggregate function', 'A selected column is neither grouped nor aggregated.', 'Add it to GROUP BY, aggregate it, or GROUP BY the primary key (functional dependency).', 'BadSqlGrammarException'],
    ['42P18', 'indeterminate_datatype', 'could not determine data type of parameter $1', 'A bind parameter is used where PostgreSQL cannot infer its type (e.g. "? IS NULL" with a null value).', 'Cast the parameter: CAST(? AS text) IS NULL / ?::text. Typical with optional JPA query parameters.', 'InvalidDataAccessResourceUsageException'],
    ['3D000', 'invalid_catalog_name', 'database "…" does not exist', 'The database in the connection string does not exist.', 'Create it (CREATE DATABASE) or fix the name; note the default database is the user name.', 'CannotGetJdbcConnectionException'],
    ['3F000', 'invalid_schema_name', 'schema "…" does not exist', 'Referenced schema is missing.', 'CREATE SCHEMA, or fix currentSchema / search_path.'],
    ['28P01', 'invalid_password', 'password authentication failed for user "…"', 'Wrong password, or the user does not exist.', 'Check credentials; the server log may show which pg_hba.conf line matched.', 'CannotGetJdbcConnectionException'],
    ['28000', 'invalid_authorization_specification', 'no pg_hba.conf entry for host "…", user "…", database "…", SSL off', 'pg_hba.conf has no rule allowing this client address / user / database / SSL mode.', 'Add a host / hostssl line to pg_hba.conf and reload, or connect with sslmode=require if only hostssl is allowed.', 'CannotGetJdbcConnectionException'],
    ['53300', 'too_many_connections', 'sorry, too many clients already / remaining connection slots are reserved', 'max_connections is reached.', 'Lower pool sizes (sum across all instances), close leaked connections, put PgBouncer in front; check pg_stat_activity for idle sessions.', 'CannotGetJdbcConnectionException'],
    ['53100', 'disk_full', 'could not extend file: No space left on device', 'The data or WAL volume is full.', 'Free space urgently; check WAL retention from replication slots (pg_replication_slots) and archiving.'],
    ['53200', 'out_of_memory', 'out of memory', 'A backend could not allocate memory — large work_mem × many sort/hash nodes × connections.', 'Lower work_mem / connections, check the plan, fix huge IN lists or arrays.'],
    ['54000', 'program_limit_exceeded', 'index row size exceeds maximum / stack depth limit exceeded / too many arguments', 'A hard limit was hit: btree entry > ~2.7 kB, deep recursion, or more than 65535 bind parameters in one statement.', 'Index a hash / md5(col) instead of long text; batch statements to stay under 65535 parameters.'],
    ['0A000', 'feature_not_supported', 'cannot … / feature not supported', 'The operation is not supported, e.g. altering a column used by a view.', 'Drop and recreate the dependent object, or use a supported alternative.'],
    ['2BP01', 'dependent_objects_still_exist', 'cannot drop table … because other objects depend on it', 'Views, FKs or other objects depend on the object being dropped.', 'Drop dependents first, or use DROP … CASCADE (carefully).'],
    ['55006', 'object_in_use', 'database "…" is being accessed by other users', 'DROP / ALTER DATABASE while sessions are connected.', 'Terminate sessions: SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = \'…\'; or DROP DATABASE … WITH (FORCE) (PG 13+).'],
    ['08001', 'sqlclient_unable_to_establish_sqlconnection', 'Connection to host:port refused', 'Nothing listens on the host/port, or a firewall blocks it.', 'Check host / port, listen_addresses in postgresql.conf, Docker port mapping, security groups.', 'CannotGetJdbcConnectionException'],
    ['08006', 'connection_failure', 'An I/O error occurred while sending to the backend / connection reset', 'The connection was dropped (server restart, network, idle timeout in a proxy / firewall).', 'Configure pool keepalive and maxLifetime below the network idle timeout; enable TCP keepalives.', 'DataAccessResourceFailureException'],
    ['08P01', 'protocol_violation', 'bind message supplies N parameters, but prepared statement requires M', 'Client and server disagree on the protocol — often a parameter count mismatch, or a pooler (PgBouncer transaction mode) breaking prepared statements.', 'Match placeholders with parameters; with PgBouncer transaction pooling set prepareThreshold=0.'],
    ['XX000', 'internal_error', 'internal error', 'An unexpected server-side error (bug, corruption).', 'Check the server log; upgrade to the latest minor release.'],
    ['26000', 'invalid_sql_statement_name', 'prepared statement "S_1" does not exist / already exists', 'Server-side prepared statements were lost — typically PgBouncer in transaction mode reusing server connections.', 'Set prepareThreshold=0 in the JDBC URL, or use PgBouncer 1.21+ with max_prepared_statements.'],
  ];

  const ENTRIES = [
    ...ORACLE.map(([code, title, cause, fix, spring]) => ({ db: 'oracle', code, title, cause, fix, spring })),
    ...POSTGRES.map(([code, name, title, cause, fix, spring]) => ({ db: 'postgres', code, name, title, cause, fix, spring })),
  ];

  // PostgreSQL messages without a code in the pasted text -> SQLSTATE
  const PG_MESSAGES = [
    [/duplicate key value violates unique constraint "([^"]+)"/i, '23505'],
    [/violates foreign key constraint "([^"]+)"/i, '23503'],
    [/null value in column "([^"]+)"/i, '23502'],
    [/violates check constraint "([^"]+)"/i, '23514'],
    [/value too long for type/i, '22001'],
    [/(numeric field overflow|integer out of range)/i, '22003'],
    [/invalid input syntax for type/i, '22P02'],
    [/could not serialize access/i, '40001'],
    [/deadlock detected/i, '40P01'],
    [/could not obtain lock|lock timeout/i, '55P03'],
    [/canceling statement due to (statement timeout|user request)/i, '57014'],
    [/current transaction is aborted/i, '25P02'],
    [/relation "([^"]+)" does not exist/i, '42P01'],
    [/column "([^"]+)" (of relation "[^"]+" )?does not exist/i, '42703'],
    [/syntax error at or near "([^"]*)"/i, '42601'],
    [/(function|operator) .* does not exist/i, '42883'],
    [/is of type .* but expression is of type/i, '42804'],
    [/permission denied for/i, '42501'],
    [/must appear in the GROUP BY clause/i, '42803'],
    [/could not determine data type of parameter/i, '42P18'],
    [/password authentication failed/i, '28P01'],
    [/no pg_hba\.conf entry/i, '28000'],
    [/database "([^"]+)" does not exist/i, '3D000'],
    [/(too many clients|remaining connection slots are reserved)/i, '53300'],
    [/Connection to .* refused/i, '08001'],
    [/I\/O error occurred while sending to the backend/i, '08006'],
    [/prepared statement "\w+" (does not exist|already exists)/i, '26000'],
    [/cannot execute \w+ in a read-only transaction/i, '25006'],
    [/more than one row returned by a subquery/i, '21000'],
    [/division by zero/i, '22012'],
    [/invalid byte sequence for encoding/i, '22021'],
  ];

  /** Find every known error in a pasted log / stack trace. Returns [{ entry, detail }] in order of appearance. */
  function scan(text) {
    const found = [];
    const seen = new Set();
    const push = (entry, detail, at) => {
      if (!entry || seen.has(entry.code)) return;
      seen.add(entry.code);
      found.push({ entry, detail, at });
    };
    for (const m of text.matchAll(/\b(ORA|PLS|TNS)-(\d{5})\b:?\s*([^\n]*)/g)) {
      const code = `${m[1] === 'TNS' ? 'ORA' : m[1]}-${m[2]}`;
      const entry = ENTRIES.find((e) => e.code === code) || { db: 'oracle', code, title: m[3].trim() || 'Oracle error', cause: 'Not in the built-in list.', fix: `Look it up: oerr ${m[1].toLowerCase()} ${Number(m[2])} (on the DB server) or docs.oracle.com/error-help/db/${m[1].toLowerCase()}-${m[2]}`, unknown: true };
      push(entry, m[3].trim(), m.index);
    }
    for (const m of text.matchAll(/(?:SQLSTATE|SQL ?state|SQLState|sqlState)\s*[:=[(\s]\s*["']?([0-9A-Z]{5})\b/g)) {
      const entry = ENTRIES.find((e) => e.db === 'postgres' && e.code === m[1]) || { db: 'postgres', code: m[1], title: 'SQLSTATE', cause: 'Not in the built-in list.', fix: 'See the PostgreSQL "Error Codes" appendix (Appendix A).', unknown: true };
      push(entry, '', m.index);
    }
    for (const [re, code] of PG_MESSAGES) {
      const m = re.exec(text);
      if (m) push(ENTRIES.find((e) => e.db === 'postgres' && e.code === code), m[0], m.index);
    }
    const key = /Key \(([^)]+)\)=\(([^)]*)\)/.exec(text);
    const constraint = /constraint "?([\w.$#"]+?)"?(?:\s|$|\))/i.exec(text)?.[1] || /\(([A-Z0-9_$#]+\.[A-Z0-9_$#]+)\) violated/.exec(text)?.[1];
    return {
      found: found.sort((a, b) => a.at - b.at),
      key: key ? { columns: key[1], values: key[2] } : null,
      constraint: constraint || null,
    };
  }

  function search(query, db = 'all') {
    const q = query.trim().toLowerCase();
    return ENTRIES.filter((e) => (db === 'all' || e.db === db) && (!q || [e.code, e.name, e.title, e.cause, e.fix, e.spring].some((x) => x && x.toLowerCase().includes(q))));
  }

  return { scan, search, ENTRIES };
});
