'use strict';

// Database connection strings: parse any common form (JDBC, URI, libpq keywords, Oracle EZConnect /
// TNS descriptor, SQL Server ;key=value) into one model, and render that model for every client.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Conn = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const DEFAULT_PORT = { postgres: 5432, oracle: 1521, mysql: 3306, sqlserver: 1433 };

  /** Model: { db, host, port, database, oracleMode: 'service' | 'sid', user, password, sslmode, schema, appName, extra: [[k, v]] } */
  const empty = (db = 'postgres') => ({ db, host: 'localhost', port: DEFAULT_PORT[db], database: '', oracleMode: 'service', user: '', password: '', sslmode: '', schema: '', appName: '', extra: [] });

  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

  function parse(input) {
    const s = input.trim().replace(/^(["'])(.*)\1$/s, '$2');
    if (!s) throw new Error('Paste a connection string');
    let m;

    // ----- Oracle -----
    if ((m = /^jdbc:oracle:(?:thin|oci):(?:([^/@]*)\/([^@]*))?@(.*)$/i.exec(s))) {
      const model = parseOracleTarget(m[3]);
      if (m[1]) model.user = m[1];
      if (m[2]) model.password = m[2];
      return model;
    }
    if (/^\(?\s*DESCRIPTION\s*=/i.test(s) || /=\s*\(DESCRIPTION/i.test(s)) return parseOracleTarget(s);

    // ----- SQL Server -----
    if ((m = /^jdbc:sqlserver:\/\/([^;:\\/]*)(?:\\\w+)?(?::(\d+))?;?(.*)$/i.exec(s))) {
      const model = { ...empty('sqlserver'), host: m[1], port: Number(m[2] || 1433) };
      for (const kv of m[3].split(';').filter(Boolean)) {
        const [k, ...rest] = kv.split('=');
        const v = rest.join('=');
        const key = k.trim().toLowerCase();
        if (key === 'databasename' || key === 'database') model.database = v;
        else if (key === 'user' || key === 'username') model.user = v;
        else if (key === 'password') model.password = v;
        else if (key === 'applicationname') model.appName = v;
        else model.extra.push([k.trim(), v]);
      }
      return model;
    }

    // ----- URL forms: jdbc:postgresql://, postgres://, mysql://, jdbc:mysql:// -----
    if ((m = /^(?:jdbc:)?(postgresql|postgres|pgsql|mysql|mariadb|r2dbc:postgresql)(?::\w+)?:\/\/(.*)$/i.exec(s))) {
      const db = /mysql|mariadb/i.test(m[1]) ? 'mysql' : 'postgres';
      const model = empty(db);
      let rest = m[2];
      const q = rest.indexOf('?');
      const query = q >= 0 ? rest.slice(q + 1) : '';
      if (q >= 0) rest = rest.slice(0, q);
      const at = rest.lastIndexOf('@');
      if (at >= 0) {
        const [u, ...p] = rest.slice(0, at).split(':');
        model.user = dec(u);
        model.password = dec(p.join(':'));
        rest = rest.slice(at + 1);
      }
      const slash = rest.indexOf('/');
      const hostPart = slash >= 0 ? rest.slice(0, slash) : rest;
      model.database = slash >= 0 ? dec(rest.slice(slash + 1)) : '';
      const hp = /^\[?([^\]]*?)\]?(?::(\d+))?$/.exec(hostPart.split(',')[0]);
      model.host = hp[1] || 'localhost';
      model.port = Number(hp[2] || DEFAULT_PORT[db]);
      for (const kv of query.split('&').filter(Boolean)) {
        const [k, v = ''] = kv.split('=').map(dec);
        applyParam(model, k, v);
      }
      return model;
    }

    // ----- libpq keyword/value: host=... port=... dbname=... -----
    if (/\b(host|dbname|hostaddr)\s*=/.test(s) && !/;/.test(s)) {
      const model = empty('postgres');
      for (const m2 of s.matchAll(/(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/g)) {
        const v = m2[2].startsWith("'") ? m2[2].slice(1, -1).replace(/\\(.)/g, '$1') : m2[2];
        applyParam(model, m2[1], v);
      }
      return model;
    }

    // ----- .NET style: Host=...;Database=... or Server=...;Database=... / Data Source=//host/service -----
    if (/;/.test(s) && /=/.test(s)) {
      const kv = Object.fromEntries(s.split(';').filter((x) => x.includes('=')).map((x) => {
        const i = x.indexOf('=');
        return [x.slice(0, i).trim().toLowerCase(), x.slice(i + 1).trim()];
      }));
      if (kv['data source'] && !kv['initial catalog']) {
        const model = parseOracleTarget(kv['data source']);
        model.user = kv['user id'] || '';
        model.password = kv.password || '';
        return model;
      }
      const isSqlServer = 'server' in kv || 'initial catalog' in kv || 'data source' in kv;
      const model = empty(isSqlServer ? 'sqlserver' : 'postgres');
      const server = kv.host || kv.server || kv['data source'] || 'localhost';
      const hp = /^(?:tcp:)?([^,:]+)(?:[,:](\d+))?$/.exec(server);
      model.host = hp ? hp[1] : server;
      model.port = Number(kv.port || hp?.[2] || DEFAULT_PORT[model.db]);
      model.database = kv.database || kv['initial catalog'] || '';
      model.user = kv.username || kv['user id'] || kv.uid || kv.user || '';
      model.password = kv.password || kv.pwd || '';
      if (kv['ssl mode']) model.sslmode = kv['ssl mode'].toLowerCase().replace('verifyfull', 'verify-full').replace('verifyca', 'verify-ca');
      if (kv['search path']) model.schema = kv['search path'];
      if (kv['application name']) model.appName = kv['application name'];
      return model;
    }

    // ----- Oracle EZConnect / sqlplus: user/pass@host:port/service -----
    if ((m = /^(?:([^/@\s]+)(?:\/([^@\s]*))?@)?(\/\/)?([\w.-]+)(?::(\d+))?\/([\w.$#-]+)(?::\w+)?$/.exec(s))) {
      return { ...empty('oracle'), user: m[1] || '', password: m[2] || '', host: m[4], port: Number(m[5] || 1521), database: m[6] };
    }
    throw new Error('Unrecognized format. Supported: JDBC URLs, postgres:// / mysql:// URIs, libpq "host=… dbname=…", Oracle EZConnect / TNS descriptors, .NET "Host=…;Database=…"');
  }

  function applyParam(model, key, v) {
    switch (key.toLowerCase()) {
      case 'host': case 'hostaddr': model.host = v; break;
      case 'port': model.port = Number(v); break;
      case 'dbname': case 'database': model.database = v; break;
      case 'user': case 'username': model.user = v; break;
      case 'password': model.password = v; break;
      case 'sslmode': case 'ssl-mode': model.sslmode = v.toLowerCase(); break;
      case 'ssl': if (v === 'true' && !model.sslmode) model.sslmode = 'require'; break;
      case 'currentschema': model.schema = v; break;
      case 'search_path': model.schema = v; break;
      case 'options': {
        const sp = /-c\s*search_path=(\S+)/.exec(v);
        if (sp) model.schema = sp[1];
        else model.extra.push([key, v]);
        break;
      }
      case 'applicationname': case 'application_name': model.appName = v; break;
      default: model.extra.push([key, v]);
    }
  }

  function parseOracleTarget(target) {
    const t = target.trim();
    const model = empty('oracle');
    if (/DESCRIPTION/i.test(t)) {
      const get = (k) => new RegExp(`\\(\\s*${k}\\s*=\\s*([^)\\s]+)\\s*\\)`, 'i').exec(t)?.[1];
      model.host = get('HOST') || 'localhost';
      model.port = Number(get('PORT') || 1521);
      const svc = get('SERVICE_NAME');
      const sid = get('SID');
      model.database = svc || sid || '';
      model.oracleMode = svc || !sid ? 'service' : 'sid';
      if (/PROTOCOL\s*=\s*TCPS/i.test(t)) model.sslmode = 'require';
      return model;
    }
    let m;
    if ((m = /^(?:\/\/)?([\w.-]+|\[[^\]]+\])(?::(\d+))?\/([\w.$#-]+)/.exec(t))) {
      Object.assign(model, { host: m[1], port: Number(m[2] || 1521), database: m[3], oracleMode: 'service' });
    } else if ((m = /^([\w.-]+):(\d+):([\w$#]+)$/.exec(t))) {
      Object.assign(model, { host: m[1], port: Number(m[2]), database: m[3], oracleMode: 'sid' });
    } else {
      // a bare TNS alias such as "ORCL" (needs tnsnames.ora)
      Object.assign(model, { host: '', database: t, oracleMode: 'service', tnsAlias: t });
    }
    return model;
  }

  // ---------- rendering ----------
  /** Returns [{ group, label, value, lang }] */
  function build(model, { placeholder = true } = {}) {
    const m = { ...model, port: Number(model.port) || DEFAULT_PORT[model.db] };
    const pw = placeholder ? '${DB_PASSWORD}' : m.password;
    const pwEnc = placeholder ? '${DB_PASSWORD}' : encodeURIComponent(m.password);
    const user = m.user || (m.db === 'postgres' ? 'postgres' : m.db === 'oracle' ? 'system' : m.db === 'sqlserver' ? 'sa' : 'root');
    const out = [];
    const add = (group, label, value, lang = 'plaintext') => out.push({ group, label, value, lang });
    const extraQuery = m.extra.filter(([k]) => k).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);

    if (m.db === 'postgres') {
      const db = m.database || 'postgres';
      const jdbcParams = [m.sslmode && `sslmode=${m.sslmode}`, m.schema && `currentSchema=${encodeURIComponent(m.schema)}`, m.appName && `ApplicationName=${encodeURIComponent(m.appName)}`, ...extraQuery].filter(Boolean);
      const uriParams = [m.sslmode && `sslmode=${m.sslmode}`, m.schema && `options=${encodeURIComponent(`-c search_path=${m.schema}`)}`, m.appName && `application_name=${encodeURIComponent(m.appName)}`, ...extraQuery].filter(Boolean);
      const jdbc = `jdbc:postgresql://${hostPort(m)}/${db}${jdbcParams.length ? `?${jdbcParams.join('&')}` : ''}`;
      const uri = `postgresql://${encodeURIComponent(user)}${pw ? `:${pwEnc}` : ''}@${hostPort(m)}/${encodeURIComponent(db)}${uriParams.length ? `?${uriParams.join('&')}` : ''}`;
      add('URL', 'JDBC URL', jdbc);
      add('URL', 'libpq URI (psql, Go pgx, Rust, Prisma, DATABASE_URL)', uri);
      add('URL', 'libpq keyword/value', [`host=${m.host}`, `port=${m.port}`, `dbname=${db}`, `user=${user}`, pw && `password=${pw}`, m.sslmode && `sslmode=${m.sslmode}`, m.schema && `options='-c search_path=${m.schema}'`, m.appName && `application_name='${m.appName}'`].filter(Boolean).join(' '));
      add('URL', 'R2DBC URL', `r2dbc:postgresql://${encodeURIComponent(user)}@${hostPort(m)}/${db}${jdbcParams.length ? `?${jdbcParams.join('&')}` : ''}`);
      add('Java', 'Spring Boot application.properties', springProps(jdbc, user, pw, 'org.postgresql.Driver'), 'ini');
      add('Java', 'Spring Boot application.yml', springYaml(jdbc, user, pw, 'org.postgresql.Driver'), 'yaml');
      add('Java', 'Quarkus application.properties', `quarkus.datasource.db-kind=postgresql\nquarkus.datasource.username=${user}\nquarkus.datasource.password=${pw}\nquarkus.datasource.jdbc.url=${jdbc}`, 'ini');
      add('Java', 'Maven dependency', '<dependency>\n  <groupId>org.postgresql</groupId>\n  <artifactId>postgresql</artifactId>\n  <scope>runtime</scope>\n</dependency>', 'xml');
      add('CLI', 'psql (password from PGPASSWORD or ~/.pgpass)', `psql "${uri.replace(/^(postgresql:\/\/[^:@]*)(:[^@]*)?@/, '$1@')}"`, 'shell');
      add('CLI', 'Environment variables (PG*)', [`PGHOST=${m.host}`, `PGPORT=${m.port}`, `PGDATABASE=${db}`, `PGUSER=${user}`, `PGPASSWORD=${pw}`, m.sslmode && `PGSSLMODE=${m.sslmode}`, m.appName && `PGAPPNAME=${m.appName}`].filter(Boolean).join('\n'), 'shell');
      add('CLI', 'pg_dump (custom format)', `pg_dump -h ${m.host} -p ${m.port} -U ${user} -d ${db} -Fc -f ${db}.dump`, 'shell');
      add('CLI', 'Docker: local PostgreSQL', `docker run -d --name ${db}-pg -p ${m.port}:5432 -e POSTGRES_USER=${user} -e POSTGRES_PASSWORD=${placeholder ? 'change-me' : m.password || 'change-me'} -e POSTGRES_DB=${db} postgres:17`, 'shell');
      add('Other', 'Node.js (pg)', `const { Pool } = require('pg');\nconst pool = new Pool({\n  host: '${m.host}',\n  port: ${m.port},\n  database: '${db}',\n  user: '${user}',\n  password: process.env.DB_PASSWORD,${m.sslmode && m.sslmode !== 'disable' ? `\n  ssl: { rejectUnauthorized: ${m.sslmode === 'verify-full' || m.sslmode === 'verify-ca'} },` : ''}${m.appName ? `\n  application_name: '${m.appName}',` : ''}\n});`, 'javascript');
      add('Other', 'Python SQLAlchemy URL', `postgresql+psycopg://${encodeURIComponent(user)}:${pwEnc}@${hostPort(m)}/${db}${m.sslmode ? `?sslmode=${m.sslmode}` : ''}`);
      add('Other', '.NET Npgsql', [`Host=${m.host}`, `Port=${m.port}`, `Database=${db}`, `Username=${user}`, `Password=${pw}`, m.sslmode && `SSL Mode=${npgsqlSsl(m.sslmode)}`, m.schema && `Search Path=${m.schema}`, m.appName && `Application Name=${m.appName}`].filter(Boolean).join(';'));
    } else if (m.db === 'oracle') {
      const svc = m.database || 'FREEPDB1';
      const sid = m.oracleMode === 'sid';
      const tcps = m.sslmode && m.sslmode !== 'disable';
      const descriptor = `(DESCRIPTION=(ADDRESS=(PROTOCOL=${tcps ? 'TCPS' : 'TCP'})(HOST=${m.host})(PORT=${m.port}))(CONNECT_DATA=(${sid ? 'SID' : 'SERVICE_NAME'}=${svc})))`;
      const ez = sid ? null : `${m.host}:${m.port}/${svc}`;
      const jdbc = m.tnsAlias ? `jdbc:oracle:thin:@${m.tnsAlias}` : tcps ? `jdbc:oracle:thin:@${descriptor}` : sid ? `jdbc:oracle:thin:@${m.host}:${m.port}:${svc}` : `jdbc:oracle:thin:@//${ez}`;
      add('URL', `JDBC URL (thin, ${sid ? 'SID' : 'service name'})`, jdbc);
      add('URL', 'JDBC URL (TNS descriptor)', `jdbc:oracle:thin:@${descriptor}`);
      if (ez) add('URL', 'EZConnect', `${tcps ? 'tcps://' : ''}${ez}`);
      add('URL', 'TNS descriptor', descriptor);
      add('URL', 'tnsnames.ora entry', `${svc.split('.')[0].toUpperCase()} =\n  (DESCRIPTION =\n    (ADDRESS = (PROTOCOL = ${tcps ? 'TCPS' : 'TCP'})(HOST = ${m.host})(PORT = ${m.port}))\n    (CONNECT_DATA =\n      (SERVER = DEDICATED)\n      (${sid ? 'SID' : 'SERVICE_NAME'} = ${svc})\n    )\n  )`);
      add('Java', 'Spring Boot application.properties', springProps(jdbc, user, pw, 'oracle.jdbc.OracleDriver'), 'ini');
      add('Java', 'Spring Boot application.yml', springYaml(jdbc, user, pw, 'oracle.jdbc.OracleDriver'), 'yaml');
      add('Java', 'Quarkus application.properties', `quarkus.datasource.db-kind=oracle\nquarkus.datasource.username=${user}\nquarkus.datasource.password=${pw}\nquarkus.datasource.jdbc.url=${jdbc}`, 'ini');
      add('Java', 'Maven dependency', '<dependency>\n  <groupId>com.oracle.database.jdbc</groupId>\n  <artifactId>ojdbc11</artifactId>\n  <scope>runtime</scope>\n</dependency>', 'xml');
      add('CLI', 'SQL*Plus / SQLcl', `sqlplus ${user}@"${sid ? descriptor : `//${ez}`}"\nsql ${user}@${sid ? `"${descriptor}"` : `//${ez}`}`, 'shell');
      add('CLI', 'Data Pump export', `expdp ${user}@${sid ? `"${descriptor}"` : `//${ez}`} schemas=${user.toUpperCase()} directory=DATA_PUMP_DIR dumpfile=${user.toLowerCase()}.dmp logfile=${user.toLowerCase()}_exp.log`, 'shell');
      add('CLI', 'Docker: local Oracle Free', `docker run -d --name oracle-free -p ${m.port}:1521 -e ORACLE_PASSWORD=${placeholder ? 'change-me' : m.password || 'change-me'} -e APP_USER=${user} -e APP_USER_PASSWORD=${placeholder ? 'change-me' : m.password || 'change-me'} gvenzl/oracle-free:23-slim`, 'shell');
      add('Other', 'Python (python-oracledb)', `import os\nimport oracledb\nconn =oracledb.connect(user="${user}", password=os.environ["DB_PASSWORD"], dsn="${sid ? descriptor : ez}")`, 'python');
      add('Other', 'Node.js (oracledb)', `const oracledb = require('oracledb');\nconst conn = await oracledb.getConnection({\n  user: '${user}',\n  password: process.env.DB_PASSWORD,\n  connectString: '${sid ? descriptor : ez}',\n});`, 'javascript');
      add('Other', '.NET ODP.NET', `User Id=${user};Password=${pw};Data Source=${sid ? descriptor : `//${ez}`}`);
    } else if (m.db === 'mysql') {
      const db = m.database || 'mysql';
      const params = [m.sslmode && `sslMode=${m.sslmode.toUpperCase().replace('-', '_')}`, ...extraQuery].filter(Boolean);
      const jdbc = `jdbc:mysql://${hostPort(m)}/${db}${params.length ? `?${params.join('&')}` : ''}`;
      add('URL', 'JDBC URL', jdbc);
      add('URL', 'URI (DATABASE_URL)', `mysql://${encodeURIComponent(user)}:${pwEnc}@${hostPort(m)}/${db}`);
      add('Java', 'Spring Boot application.properties', springProps(jdbc, user, pw, 'com.mysql.cj.jdbc.Driver'), 'ini');
      add('Java', 'Spring Boot application.yml', springYaml(jdbc, user, pw, 'com.mysql.cj.jdbc.Driver'), 'yaml');
      add('CLI', 'mysql client', `mysql -h ${m.host} -P ${m.port} -u ${user} -p ${db}`, 'shell');
      add('CLI', 'Docker: local MySQL', `docker run -d --name ${db}-mysql -p ${m.port}:3306 -e MYSQL_ROOT_PASSWORD=change-me -e MYSQL_DATABASE=${db} -e MYSQL_USER=${user} -e MYSQL_PASSWORD=change-me mysql:8.4`, 'shell');
    } else {
      const db = m.database || 'master';
      const enc = m.sslmode && m.sslmode !== 'disable';
      const jdbc = `jdbc:sqlserver://${m.host}:${m.port};databaseName=${db};encrypt=${enc};trustServerCertificate=${!(m.sslmode || '').startsWith('verify')}${m.appName ? `;applicationName=${m.appName}` : ''}`;
      add('URL', 'JDBC URL', jdbc);
      add('URL', 'ADO.NET', `Server=${m.host},${m.port};Database=${db};User Id=${user};Password=${pw};Encrypt=${enc};TrustServerCertificate=${!(m.sslmode || '').startsWith('verify')}`);
      add('Java', 'Spring Boot application.properties', springProps(jdbc, user, pw, 'com.microsoft.sqlserver.jdbc.SQLServerDriver'), 'ini');
      add('Java', 'Spring Boot application.yml', springYaml(jdbc, user, pw, 'com.microsoft.sqlserver.jdbc.SQLServerDriver'), 'yaml');
      add('CLI', 'sqlcmd', `sqlcmd -S ${m.host},${m.port} -d ${db} -U ${user} -P "${pw}"`, 'shell');
      add('CLI', 'Docker: local SQL Server', `docker run -d --name mssql -p ${m.port}:1433 -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Change-me-1!' mcr.microsoft.com/mssql/server:2022-latest`, 'shell');
    }
    return out;
  }

  const hostPort = (m) => `${m.host.includes(':') && !m.host.startsWith('[') ? `[${m.host}]` : m.host}:${m.port}`;
  const npgsqlSsl = (mode) => ({ disable: 'Disable', allow: 'Allow', prefer: 'Prefer', require: 'Require', 'verify-ca': 'VerifyCA', 'verify-full': 'VerifyFull' }[mode] || mode);

  const springProps = (url, user, pw, driver) =>
    `spring.datasource.url=${url}\nspring.datasource.username=${user}\nspring.datasource.password=${pw}\nspring.datasource.driver-class-name=${driver}\nspring.datasource.hikari.maximum-pool-size=10`;
  const springYaml = (url, user, pw, driver) =>
    `spring:\n  datasource:\n    url: ${url}\n    username: ${user}\n    password: ${pw}\n    driver-class-name: ${driver}\n    hikari:\n      maximum-pool-size: 10`;

  return { parse, build, empty, DEFAULT_PORT };
});
