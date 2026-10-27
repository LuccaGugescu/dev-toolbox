'use strict';

// Execution plan parser + analyzer.
//   PostgreSQL: EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) or the default text format (with or without ANALYZE).
//   Oracle:     DBMS_XPLAN.DISPLAY / DISPLAY_CURSOR table output (with E-Rows / A-Rows when gathered).
// Produces one tree of normalized nodes plus per-node findings, so the UI can treat both the same way.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExplainPlan = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  /**
   * Node: { id, type, relation, index, alias, startupCost, totalCost, planRows, width,
   *         actual: { startup, total, rows, loops } | null, neverExecuted, details: {key: value},
   *         children: [], depth, // computed:
   *         inclusiveMs, exclusiveMs, pctTime, rowsTotal, misestimate, findings: [{ level, text }] }
   */

  function parse(input) {
    const text = input.trim();
    if (!text) throw new Error('Paste an execution plan');
    if (text.startsWith('[') || text.startsWith('{')) return parsePgJson(text);
    if (/^\s*\|\s*Id\s*\|/m.test(text)) return parseOracle(text);
    // psql output may wrap every line in "QUERY PLAN" table borders and quotes
    return parsePgText(text);
  }

  // ---------- PostgreSQL JSON ----------
  function parsePgJson(text) {
    let doc;
    try {
      doc = JSON.parse(text.replace(/^\s*QUERY PLAN\s*-+\s*/i, ''));
    } catch (err) {
      throw new Error(`Invalid JSON plan: ${err.message}`);
    }
    const top = Array.isArray(doc) ? doc[0] : doc;
    if (!top || !top.Plan) throw new Error('JSON has no "Plan" key: use EXPLAIN (FORMAT JSON)');
    let id = 0;
    const conv = (p, depth) => {
      const node = {
        id: id++,
        type: p['Node Type'] + (p['Join Type'] && p['Join Type'] !== 'Inner' ? ` (${p['Join Type']})` : '') + (p['Scan Direction'] === 'Backward' ? ' Backward' : ''),
        relation: p['Relation Name'] ? (p.Schema && p.Schema !== 'public' ? `${p.Schema}.` : '') + p['Relation Name'] : p['CTE Name'] || p['Function Name'] || null,
        alias: p.Alias && p.Alias !== p['Relation Name'] ? p.Alias : null,
        index: p['Index Name'] || null,
        startupCost: p['Startup Cost'], totalCost: p['Total Cost'], planRows: p['Plan Rows'], width: p['Plan Width'],
        actual: p['Actual Loops'] != null && p['Actual Loops'] > 0 ? { startup: p['Actual Startup Time'], total: p['Actual Total Time'], rows: p['Actual Rows'], loops: p['Actual Loops'] } : null,
        neverExecuted: p['Actual Loops'] === 0,
        parentRel: p['Parent Relationship'] || null,
        details: {},
        children: [],
        depth,
      };
      for (const [k, v] of Object.entries(p)) {
        if (['Plans', 'Node Type', 'Relation Name', 'Alias', 'Index Name', 'Startup Cost', 'Total Cost', 'Plan Rows', 'Plan Width',
          'Actual Startup Time', 'Actual Total Time', 'Actual Rows', 'Actual Loops', 'Parent Relationship', 'Schema', 'Join Type',
          'Scan Direction', 'Parallel Aware', 'Async Capable', 'Inner Unique'].includes(k)) continue;
        node.details[k] = Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : v;
      }
      node.children = (p.Plans || []).map((c) => conv(c, depth + 1));
      return node;
    };
    return finish({
      dialect: 'postgres',
      root: conv(top.Plan, 0),
      planningMs: top['Planning Time'] ?? null,
      executionMs: top['Execution Time'] ?? null,
    });
  }

  // ---------- PostgreSQL text ----------
  const PG_NODE = /^(?<title>.+?)\s+(?:\((?:cost=(?<sc>[\d.]+)\.\.(?<tc>[\d.]+) rows=(?<pr>\d+) width=(?<w>\d+))\))?\s*(?:\((?:actual (?:time=(?<as>[\d.]+)\.\.(?<at>[\d.]+) )?rows=(?<ar>[\d.]+) loops=(?<al>\d+))\)|\((?<never>never executed)\))?\s*$/;

  function parsePgText(text) {
    const lines = text.split(/\r?\n/)
      .map((l) => l.replace(/^\s*\|?\s?/, (m) => (m.includes('|') ? '' : m)).replace(/\s*\|?\s*$/, '').replace(/^"|"$/g, ''))
      .filter((l) => !/^\s*(QUERY PLAN|-{3,}|\(\d+ rows?\))\s*$/i.test(l));
    let root = null;
    let planningMs = null;
    let executionMs = null;
    let id = 0;
    const stack = []; // { indent, node }
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const pt = /^\s*Planning(?: Time)?:\s*([\d.]+)\s*ms/i.exec(raw);
      if (pt) { planningMs = Number(pt[1]); continue; }
      const et = /^\s*Execution(?: Time)?:\s*([\d.]+)\s*ms/i.exec(raw);
      if (et) { executionMs = Number(et[1]); continue; }
      const arrow = /^(\s*)->\s+(.*)$/.exec(raw);
      const isNode = arrow || (!root && /\((cost=|actual |never executed)/.test(raw));
      if (isNode) {
        const indent = arrow ? arrow[1].length : 0;
        const body = arrow ? arrow[2] : raw.trim();
        const m = PG_NODE.exec(body);
        const g = m ? m.groups : { title: body };
        const node = {
          id: id++, ...splitTitle(g.title),
          startupCost: num(g.sc), totalCost: num(g.tc), planRows: num(g.pr), width: num(g.w),
          actual: g.al != null && Number(g.al) > 0 ? { startup: num(g.as), total: num(g.at), rows: Number(g.ar), loops: Number(g.al) } : null,
          neverExecuted: !!g.never || g.al === '0',
          details: {}, children: [], depth: 0,
        };
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        if (stack.length) {
          const parent = stack[stack.length - 1].node;
          node.depth = parent.depth + 1;
          parent.children.push(node);
        } else if (!root) root = node;
        else continue;
        stack.push({ indent, node });
        continue;
      }
      const sub = /^\s*(SubPlan|InitPlan|CTE)\s*(.*)$/.exec(raw);
      if (sub && stack.length) {
        stack[stack.length - 1].node.details[`${sub[1]} ${sub[2]}`.trim()] = '';
        continue;
      }
      const kv = /^\s*([A-Za-z][A-Za-z /-]+?):\s+(.*)$/.exec(raw);
      if (kv && stack.length) {
        const node = stack[stack.length - 1].node;
        node.details[kv[1]] = node.details[kv[1]] ? `${node.details[kv[1]]}; ${kv[2]}` : kv[2];
      }
    }
    if (!root) throw new Error('No plan found: expected lines like "Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)"');
    // Normalize text details into the same keys as JSON so findings work for both.
    walk(root, (n) => {
      const d = n.details;
      const b = d.Buffers;
      if (b) {
        const grab = (re) => Number(re.exec(b)?.[1] || 0);
        d['Shared Hit Blocks'] = grab(/shared[^,]*?hit=(\d+)/);
        d['Shared Read Blocks'] = grab(/shared[^,]*?read=(\d+)/);
        d['Temp Written Blocks'] = grab(/temp[^,]*?written=(\d+)/);
      }
      if (d['Sort Method']) {
        const sm = /^(.*?)\s+(Disk|Memory):\s*(\d+)kB/.exec(d['Sort Method']);
        if (sm) { d['Sort Method'] = sm[1]; d['Sort Space Type'] = sm[2]; d['Sort Space Used'] = Number(sm[3]); }
      }
      if (d.Buckets) {
        const hb = /Batches:\s*(\d+)/.exec(d.Buckets);
        if (hb) d['Hash Batches'] = Number(hb[1]);
      }
      for (const k of ['Rows Removed by Filter', 'Rows Removed by Join Filter', 'Rows Removed by Index Recheck', 'Heap Fetches', 'Workers Planned', 'Workers Launched']) {
        if (d[k] != null) d[k] = Number(d[k]);
      }
    });
    return finish({ dialect: 'postgres', root, planningMs, executionMs });
  }

  function splitTitle(title) {
    let t = title.trim();
    let relation = null;
    let index = null;
    let alias = null;
    const on = / on (\S+)(?: (\S+))?$/.exec(t);
    if (on) {
      relation = on[1];
      alias = on[2] && on[2] !== on[1] ? on[2] : null;
      t = t.slice(0, on.index);
    }
    const using = / using (\S+)$/.exec(t);
    if (using) {
      index = using[1];
      t = t.slice(0, using.index);
    }
    return { type: t, relation, alias, index };
  }

  // ---------- Oracle DBMS_XPLAN ----------
  function parseOracle(text) {
    const lines = text.split(/\r?\n/);
    const headerIdx = lines.findIndex((l) => /^\s*\|\s*Id\s*\|/.test(l));
    const headers = lines[headerIdx].split('|').slice(1, -1).map((h) => h.trim());
    const col = (name) => headers.findIndex((h) => h.replace(/\s+/g, ' ').toUpperCase() === name);
    const cId = col('ID');
    const cOp = col('OPERATION');
    const cName = col('NAME');
    const cRows = col('ROWS') >= 0 ? col('ROWS') : col('E-ROWS');
    const cCost = headers.findIndex((h) => /^Cost/i.test(h));
    const cStarts = col('STARTS');
    const cARows = col('A-ROWS');
    const cATime = col('A-TIME');
    const cBuffers = col('BUFFERS');
    const cBytes = col('BYTES');
    const cTime = col('TIME');
    const flat = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*-{5,}\s*$/.test(l)) {
        if (flat.length) break;
        continue;
      }
      if (!/^\s*\|/.test(l)) continue;
      const cells = l.split('|').slice(1, -1);
      const idCell = cells[cId].trim();
      const opRaw = cells[cOp].replace(/\s+$/, '');
      const depth = opRaw.length - opRaw.trimStart().length - (cells[cOp].startsWith(' ') ? 1 : 0);
      const actual = cARows >= 0 && cells[cARows].trim() ? {
        rows: oraNum(cells[cARows]), loops: cStarts >= 0 ? oraNum(cells[cStarts]) || 1 : 1,
        total: cATime >= 0 ? oraTime(cells[cATime]) : null, startup: null, perLoopRows: false,
      } : null;
      flat.push({
        id: Number(idCell.replace('*', '')),
        hasPredicate: idCell.startsWith('*'),
        type: opRaw.trim(),
        relation: cName >= 0 ? cells[cName].trim() || null : null,
        index: null, alias: null,
        planRows: cRows >= 0 ? oraNum(cells[cRows]) : null,
        totalCost: cCost >= 0 ? oraNum(String(cells[cCost]).replace(/\(.*\)/, '')) : null,
        startupCost: null, width: null,
        actual,
        neverExecuted: false,
        details: Object.fromEntries([
          ['Bytes', cBytes >= 0 ? cells[cBytes].trim() : ''], ['Est. Time', cTime >= 0 ? cells[cTime].trim() : ''],
          ['Buffers', cBuffers >= 0 ? cells[cBuffers].trim() : ''], ['Starts', cStarts >= 0 ? cells[cStarts].trim() : ''],
        ].filter(([, v]) => v)),
        children: [],
        depth: Math.max(0, depth),
      });
    }
    if (!flat.length) throw new Error('Oracle plan table has no rows');
    // Indentation of the Operation column gives the tree.
    const stack = [];
    let root = null;
    for (const n of flat) {
      while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
      if (stack.length) stack[stack.length - 1].children.push(n);
      else if (!root) root = n;
      stack.push(n);
    }
    // Predicate Information: "   2 - access("O"."ID"=:B1)"  /  "       filter(...)"
    const predStart = lines.findIndex((l) => /Predicate Information/i.test(l));
    if (predStart >= 0) {
      let current = null;
      for (let i = predStart + 1; i < lines.length; i++) {
        const l = lines[i];
        if (/^\s*(Note|Column Projection|Hint Report)/i.test(l)) break;
        const m = /^\s*(\d+)\s*-\s*(access|filter)\((.*)$/.exec(l) || (current && /^\s*()(access|filter)\((.*)$/.exec(l));
        if (m) {
          if (m[1]) current = flat.find((n) => n.id === Number(m[1]));
          if (current) {
            const key = m[2] === 'access' ? 'Access' : 'Filter';
            const val = m[3].replace(/\)\s*$/, '');
            current.details[key] = current.details[key] ? `${current.details[key]} AND ${val}` : val;
          }
        } else if (current && l.trim() && !/^-+$/.test(l.trim())) {
          const last = current.details.Filter != null ? 'Filter' : 'Access';
          current.details[last] += ' ' + l.trim().replace(/\)\s*$/, '');
        }
      }
    }
    const notes = [];
    const noteIdx = lines.findIndex((l) => /^\s*Note\s*$/i.test(l));
    if (noteIdx >= 0) for (let i = noteIdx + 2; i < lines.length && lines[i].trim(); i++) notes.push(lines[i].trim().replace(/^-\s*/, ''));
    return finish({ dialect: 'oracle', root, planningMs: null, executionMs: root.actual?.total ?? null, notes });
  }

  function oraNum(s) {
    const m = /^\s*([\d.]+)\s*([KMGT]?)/i.exec(String(s));
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2].toUpperCase()]));
  }
  function oraTime(s) {
    const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
    return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
  }
  const num = (v) => (v == null ? null : Number(v));

  // ---------- analysis ----------
  function walk(node, fn) {
    fn(node);
    node.children.forEach((c) => walk(c, fn));
  }

  function finish(plan) {
    const { root } = plan;
    const oracle = plan.dialect === 'oracle';
    // Inclusive time: PostgreSQL "actual time" is per loop; Oracle A-Time is already the total.
    walk(root, (n) => {
      n.inclusiveMs = n.actual && n.actual.total != null ? (oracle ? n.actual.total : n.actual.total * n.actual.loops) : null;
      n.rowsTotal = n.actual ? (oracle ? n.actual.rows : n.actual.rows * n.actual.loops) : null;
    });
    const totalMs = plan.executionMs || root.inclusiveMs || null;
    const findings = [];
    walk(root, (n) => {
      if (n.inclusiveMs != null) {
        const childMs = n.children.reduce((s, c) => s + (c.inclusiveMs || 0), 0);
        // Parallel workers / CTE scans can make children exceed the parent; clamp.
        n.exclusiveMs = Math.max(0, n.inclusiveMs - (n.type.startsWith('Gather') ? 0 : childMs));
        n.pctTime = totalMs ? Math.min(100, (n.exclusiveMs / totalMs) * 100) : null;
      } else {
        n.exclusiveMs = null;
        n.pctTime = null;
      }
      // Estimate vs actual (per loop for PostgreSQL; Oracle E-Rows is per start, A-Rows is total)
      if (n.actual && n.planRows != null) {
        const actualPerLoop = oracle ? n.actual.rows / Math.max(1, n.actual.loops) : n.actual.rows;
        const est = Math.max(1, n.planRows);
        const act = Math.max(1, actualPerLoop);
        n.misestimate = act >= est ? act / est : -(est / act);
      } else n.misestimate = null;
    });
    walk(root, (n) => {
      n.findings = analyzeNode(n, plan.dialect, totalMs);
      for (const f of n.findings) findings.push({ ...f, node: n });
    });
    const order = { bad: 0, warn: 1, info: 2 };
    findings.sort((a, b) => order[a.level] - order[b.level] || (b.node.exclusiveMs || 0) - (a.node.exclusiveMs || 0));
    const nodes = [];
    walk(root, (n) => nodes.push(n));
    const slowest = nodes.filter((n) => n.exclusiveMs != null).sort((a, b) => b.exclusiveMs - a.exclusiveMs).slice(0, 5);
    return { ...plan, totalMs, findings, nodes, slowest, analyzed: nodes.some((n) => n.actual) };
  }

  const fmtN = (n) => Math.round(n).toLocaleString('en-US');

  function analyzeNode(n, dialect, totalMs) {
    const out = [];
    const d = n.details;
    const add = (level, text) => out.push({ level, text });
    const t = n.type.toUpperCase();
    const heavy = totalMs && n.exclusiveMs != null ? n.exclusiveMs / totalMs > 0.2 : true;

    // Report a misestimate where it starts, not again on every parent that inherits it.
    const inherited = n.children.some((c) => c.misestimate != null && Math.abs(c.misestimate) >= 10);
    if (n.misestimate != null && Math.abs(n.misestimate) >= 10 && !inherited && (n.rowsTotal || 0) + (n.planRows || 0) > 100) {
      add(Math.abs(n.misestimate) >= 100 ? 'bad' : 'warn',
        `Row estimate off by ${fmtN(Math.abs(n.misestimate))}× (${n.misestimate > 0 ? 'under' : 'over'}-estimated: planned ${fmtN(n.planRows)}, got ${fmtN(n.actual.rows)}${dialect === 'postgres' && n.actual.loops > 1 ? ' per loop' : ''}). ` +
        (dialect === 'postgres' ? 'Run ANALYZE on the table, or raise the column statistics target / create extended statistics for correlated columns.' : 'Gather stats with DBMS_STATS.GATHER_TABLE_STATS, consider histograms / extended stats.'));
    }

    if (dialect === 'postgres') {
      const removed = d['Rows Removed by Filter'] || 0;
      if (/SEQ SCAN/.test(t)) {
        const kept = n.rowsTotal ?? n.planRows ?? 0;
        if (removed * (n.actual?.loops || 1) > 10000 && removed > kept) {
          add(heavy ? 'bad' : 'warn', `Seq Scan read ${fmtN(removed * (n.actual?.loops || 1) + kept)} rows to keep ${fmtN(kept)} — an index on the filter column(s) would help: ${d.Filter || ''}`);
        } else if (kept > 100000 && heavy) {
          add('info', `Seq Scan returns ${fmtN(kept)} rows; fine for large result sets, otherwise add a selective WHERE / index.`);
        }
      }
      if (/INDEX SCAN|BITMAP HEAP/.test(t) && removed > 1000 && removed > (n.rowsTotal || 0) * 5) {
        add('warn', `Index fetched rows then the Filter removed ${fmtN(removed)}: add the filter column to the index (${d.Filter || ''}).`);
      }
      if (d['Rows Removed by Index Recheck'] > 1000) add('warn', `Lossy bitmap: ${fmtN(d['Rows Removed by Index Recheck'])} rows rechecked. Raise work_mem so the bitmap stays exact.`);
      if (d['Sort Space Type'] === 'Disk' || /external/i.test(d['Sort Method'] || '')) {
        add('bad', `Sort spilled to disk (${d['Sort Method']}${d['Sort Space Used'] ? `, ${fmtN(d['Sort Space Used'])} kB` : ''}). Raise work_mem for this query (SET LOCAL work_mem = '…') or add an index matching the ORDER BY.`);
      }
      if (d['Hash Batches'] > 1 || d['Original Hash Batches'] > 1) add('warn', `Hash used ${d['Hash Batches']} batches (spilled to disk). Raise work_mem / hash_mem_multiplier.`);
      if (d['Temp Written Blocks'] > 0) add('warn', `Wrote ${fmtN(d['Temp Written Blocks'])} temp blocks (${fmtN(d['Temp Written Blocks'] * 8 / 1024)} MB) to disk.`);
      if (/NESTED LOOP/.test(t) && n.children[1]?.actual?.loops > 10000) {
        add(heavy ? 'warn' : 'info', `Nested Loop ran its inner side ${fmtN(n.children[1].actual.loops)} times. If the outer estimate is wrong a Hash Join would be cheaper; check the estimate and indexes on the join key.`);
      }
      if (d['Heap Fetches'] > 1000) add('warn', `Index Only Scan did ${fmtN(d['Heap Fetches'])} heap fetches: VACUUM the table so the visibility map is current.`);
      if (d['Workers Planned'] && d['Workers Launched'] != null && d['Workers Launched'] < d['Workers Planned']) {
        add('warn', `Only ${d['Workers Launched']} of ${d['Workers Planned']} parallel workers launched: max_parallel_workers / max_worker_processes exhausted.`);
      }
      const read = d['Shared Read Blocks'] || 0;
      if (read > 10000 && heavy) add('info', `Read ${fmtN(read)} blocks (${fmtN(read * 8 / 1024)} MB) from disk / OS cache, not shared_buffers.`);
      if (/^CTE SCAN|SUBQUERY SCAN/.test(t) && n.actual?.loops > 1000) add('warn', `${n.type} executed ${fmtN(n.actual.loops)} times.`);
    } else {
      if (/TABLE ACCESS (STORAGE )?FULL/.test(t) && ((n.rowsTotal ?? n.planRows) > 10000 || heavy)) {
        add(d.Filter ? 'bad' : 'warn', `Full table scan of ${n.relation}${d.Filter ? ` with filter ${d.Filter}: an index on these columns may help` : ''}.`);
      }
      if (/CARTESIAN/.test(t)) add('bad', 'MERGE JOIN CARTESIAN: a join condition is probably missing.');
      if (/INDEX FULL SCAN|INDEX SKIP SCAN/.test(t)) add('info', `${n.type} on ${n.relation}: the leading index column is not in the predicate.`);
      if (/NESTED LOOPS/.test(t) && n.children[1]) {
        const starts = n.children[1].actual?.loops;
        if (starts > 10000) add('warn', `Nested loops started the inner side ${fmtN(starts)} times; a HASH JOIN may be cheaper.`);
      }
      if (/SORT/.test(t) && /\d+[MG]/.test(d['Used-Tmp'] || '')) add('warn', 'Sort spilled to TEMP.');
    }
    if (n.neverExecuted) add('info', 'Never executed (pruned at run time).');
    return out;
  }

  return { parse };
});
