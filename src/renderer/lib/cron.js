'use strict';

// Cron expressions: Unix / Kubernetes (5 fields), Spring @Scheduled (6 fields, seconds first)
// and Quartz (6-7 fields, ? L W #). Parses, explains in English, computes the next run times
// and converts between the three flavours.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cron = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MACROS = {
    '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
  };

  const FIELD_DEFS = {
    second: { min: 0, max: 59 }, minute: { min: 0, max: 59 }, hour: { min: 0, max: 23 },
    dom: { min: 1, max: 31 }, month: { min: 1, max: 12, names: MONTHS }, dow: { min: 0, max: 7, names: DAYS }, year: { min: 1970, max: 2199 },
  };

  function detectFlavor(expr) {
    const e = expr.trim();
    if (e.startsWith('@')) return 'unix';
    const n = e.split(/\s+/).length;
    if (n === 5) return 'unix';
    if (n === 7) return 'quartz';
    if (n === 6) return /\?/.test(e) || /(^|\s)[1-7]#|\b[1-7]L\b/.test(e.split(/\s+/)[5]) ? 'quartz' : 'spring';
    return null;
  }

  /** Returns { flavor, fields: { second, minute, hour, dom, month, dow, year }, raw: {...} } or throws. */
  function parse(expr, flavor = 'auto') {
    let e = expr.trim().replace(/\s+/g, ' ');
    if (!e) throw new Error('Enter a cron expression');
    const macro = MACROS[e.toLowerCase()];
    if (macro) {
      const f = flavor === 'auto' ? 'unix' : flavor;
      e = f === 'unix' ? macro : `0 ${macro}`;
      if (f === 'quartz') e = toQuartzDays(e);
      flavor = f;
    }
    if (flavor === 'auto') flavor = detectFlavor(e);
    const parts = e.split(' ');
    const expected = { unix: [5], spring: [6], quartz: [6, 7] }[flavor];
    if (!expected) throw new Error(`Expected 5 (Unix), 6 (Spring) or 6-7 (Quartz) fields, got ${parts.length}`);
    if (!expected.includes(parts.length)) {
      throw new Error(`${label(flavor)} cron needs ${expected.join(' or ')} fields, got ${parts.length}${parts.length === 5 ? ' (looks like a Unix expression)' : parts.length === 6 ? ' (looks like Spring/Quartz: seconds first)' : ''}`);
    }
    const names = flavor === 'unix' ? ['minute', 'hour', 'dom', 'month', 'dow'] : ['second', 'minute', 'hour', 'dom', 'month', 'dow', 'year'];
    const raw = Object.fromEntries(names.slice(0, parts.length).map((n, i) => [n, parts[i]]));
    if (flavor === 'unix') raw.second = '0';
    if (!raw.year) raw.year = '*';
    if (flavor === 'quartz' && raw.dom !== '?' && raw.dow !== '?') throw new Error('Quartz needs "?" in either day-of-month or day-of-week');
    const fields = {};
    for (const [name, text] of Object.entries(raw)) fields[name] = parseField(name, text, flavor);
    return { flavor, fields, raw };
  }

  const label = (f) => ({ unix: 'Unix', spring: 'Spring', quartz: 'Quartz' }[f]);

  function parseField(name, text, flavor) {
    const def = FIELD_DEFS[name];
    const field = { values: new Set(), any: false, last: false, lastOffset: 0, lastWeekday: false, nearestWeekday: [], lastDow: [], nthDow: [], text };
    const quartzDow = flavor === 'quartz' && name === 'dow';
    const value = (s) => {
      const up = s.toUpperCase();
      if (def.names) {
        const idx = def.names.indexOf(up);
        if (idx >= 0) return name === 'month' ? idx + 1 : idx;
      }
      if (!/^\d+$/.test(s)) throw new Error(`Invalid ${fieldLabel(name)} value "${s}"`);
      let n = Number(s);
      if (quartzDow) {
        if (n < 1 || n > 7) throw new Error(`Quartz day-of-week is 1-7 (1 = Sunday), got ${n}`);
        n -= 1;
      }
      if (n < def.min || n > def.max) throw new Error(`${fieldLabel(name)} must be ${def.min}-${def.max}, got ${n}`);
      return name === 'dow' && n === 7 ? 0 : n;
    };
    for (const part of text.split(',')) {
      if (part === '*' || part === '?') {
        if (part === '?' && name !== 'dom' && name !== 'dow') throw new Error('"?" is only allowed in day-of-month / day-of-week');
        field.any = true;
        continue;
      }
      if (name === 'dom' && /^L(-\d+)?$/i.test(part)) { field.last = true; field.lastOffset = Number(part.slice(2) || 0); continue; }
      if (name === 'dom' && /^LW$/i.test(part)) { field.lastWeekday = true; continue; }
      if (name === 'dom' && /^\d+W$/i.test(part)) { field.nearestWeekday.push(value(part.slice(0, -1))); continue; }
      if (name === 'dow' && /^\w+L$/i.test(part) && part.length > 1) { field.lastDow.push(value(part.slice(0, -1))); continue; }
      if (name === 'dow' && /^\w+#[1-5]$/.test(part)) { const [d, nth] = part.split('#'); field.nthDow.push({ dow: value(d), nth: Number(nth) }); continue; }
      if (name === 'dow' && part.toUpperCase() === 'L') { field.values.add(6); continue; } // Quartz: L alone = Saturday
      const m = /^([^/-]+)(?:-([^/]+))?(?:\/(\d+))?$/.exec(part);
      if (!m) throw new Error(`Invalid ${fieldLabel(name)} "${part}"`);
      const [, a, b, stepText] = m;
      const step = stepText ? Number(stepText) : 1;
      if (step < 1) throw new Error('Step must be at least 1');
      let from;
      let to;
      if (a === '*') { from = def.min; to = name === 'dow' ? 6 : def.max; }
      else {
        from = value(a);
        to = b != null ? value(b) : stepText ? (name === 'dow' ? 6 : def.max) : from;
      }
      if (name === 'dow' && b != null && to === 0 && from > 0) to = 7; // MON-SUN
      if (to < from) {
        // wrap-around range like FRI-MON or 22-2
        for (let v = from; v <= (name === 'dow' ? 6 : def.max); v += step) field.values.add(v);
        for (let v = def.min; v <= to; v += step) field.values.add(v);
      } else for (let v = from; v <= to; v += step) field.values.add(name === 'dow' ? v % 7 : v);
    }
    return field;
  }

  const fieldLabel = (n) => ({ second: 'Second', minute: 'Minute', hour: 'Hour', dom: 'Day-of-month', month: 'Month', dow: 'Day-of-week', year: 'Year' }[n]);
  const restricted = (f) => !f.any;

  // ---------- matching ----------
  function makeClock(utc) {
    const g = (d, k) => d[`get${utc ? 'UTC' : ''}${k}`]();
    return {
      year: (d) => g(d, 'FullYear'), month: (d) => g(d, 'Month') + 1, dom: (d) => g(d, 'Date'), dow: (d) => g(d, 'Day'),
      hour: (d) => g(d, 'Hours'), minute: (d) => g(d, 'Minutes'), second: (d) => g(d, 'Seconds'),
      make: (y, mo, d, h = 0, mi = 0, s = 0) => (utc ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : new Date(y, mo - 1, d, h, mi, s)),
    };
  }

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function weekday(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

  function domMatches(f, y, m, d) {
    if (f.any) return true;
    const dim = daysInMonth(y, m);
    if (f.values.has(d)) return true;
    if (f.last && d === dim - f.lastOffset) return true;
    if (f.lastWeekday) {
      let last = dim;
      while ([0, 6].includes(weekday(y, m, last))) last--;
      if (d === last) return true;
    }
    for (const target of f.nearestWeekday) {
      if (target > dim) continue;
      let t = target;
      const wd = weekday(y, m, t);
      if (wd === 6) t = t === 1 ? 3 : t - 1;
      else if (wd === 0) t = t === dim ? t - 2 : t + 1;
      if (d === t) return true;
    }
    return false;
  }

  function dowMatches(f, y, m, d) {
    if (f.any) return true;
    const wd = weekday(y, m, d);
    if (f.values.has(wd)) return true;
    if (f.lastDow.includes(wd) && d + 7 > daysInMonth(y, m)) return true;
    return f.nthDow.some((x) => x.dow === wd && Math.ceil(d / 7) === x.nth);
  }

  function dayMatches(p, y, m, d) {
    const { dom, dow } = p.fields;
    // Unix: when both day fields are restricted, a day matching EITHER runs. Spring/Quartz: both must match.
    if (p.flavor === 'unix' && restricted(dom) && restricted(dow)) return domMatches(dom, y, m, d) || dowMatches(dow, y, m, d);
    return domMatches(dom, y, m, d) && dowMatches(dow, y, m, d);
  }

  const has = (f, v) => f.any || f.values.has(v);

  /** Next `count` run times strictly after `from`. */
  function next(p, from = new Date(), count = 10, { utc = false } = {}) {
    const c = makeClock(utc);
    const out = [];
    let t = new Date(Math.floor(from.getTime() / 1000) * 1000 + 1000);
    const limit = from.getTime() + 1000 * 60 * 60 * 24 * 366 * 8;
    let guard = 0;
    while (out.length < count && t.getTime() < limit && guard++ < 200000) {
      const y = c.year(t);
      const mo = c.month(t);
      const d = c.dom(t);
      if (!has(p.fields.year, y)) { t = c.make(y + 1, 1, 1); continue; }
      if (!has(p.fields.month, mo)) { t = mo === 12 ? c.make(y + 1, 1, 1) : c.make(y, mo + 1, 1); continue; }
      if (!dayMatches(p, y, mo, d)) { t = c.make(y, mo, d + 1); continue; }
      const h = c.hour(t);
      if (!has(p.fields.hour, h)) { t = c.make(y, mo, d, h + 1); continue; }
      const mi = c.minute(t);
      if (!has(p.fields.minute, mi)) { t = c.make(y, mo, d, h, mi + 1); continue; }
      const s = c.second(t);
      if (!has(p.fields.second, s)) { t = c.make(y, mo, d, h, mi, s + 1); continue; }
      out.push(new Date(t));
      t = new Date(t.getTime() + 1000);
    }
    return out;
  }

  // ---------- English ----------
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const pad = (n) => String(n).padStart(2, '0');
  const list = (arr) => (arr.length <= 2 ? arr.join(' and ') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);
  const sorted = (f) => [...f.values].sort((a, b) => a - b);

  // "*/15" or "5/15" or "0-30/5" -> describe step; contiguous range -> "a through b"
  function describeSet(f, unit, nameOf = (v) => String(v), def) {
    const text = f.text;
    const stepM = /^(\*|\d+)(?:-(\d+))?\/(\d+)$/.exec(text);
    if (stepM) {
      const start = stepM[1] === '*' ? def.min : Number(stepM[1]);
      const range = stepM[2] ? ` between ${nameOf(start)} and ${nameOf(Number(stepM[2]))}` : start !== def.min ? ` starting at ${nameOf(start)}` : '';
      return `every ${stepM[3]} ${unit}s${range}`;
    }
    const vals = sorted(f);
    if (vals.length > 2 && vals.every((v, i) => i === 0 || v === vals[i - 1] + 1)) return `${nameOf(vals[0])} through ${nameOf(vals[vals.length - 1])}`;
    return list(vals.map(nameOf));
  }

  function describe(p) {
    const { second, minute, hour, dom, month, dow, year } = p.fields;
    const single = (f) => !f.any && f.values.size === 1 && !/\//.test(f.text);
    const parts = [];
    const secZero = single(second) && second.values.has(0);

    if (single(hour) && single(minute) && (secZero || single(second))) {
      parts.push(`At ${pad(sorted(hour)[0])}:${pad(sorted(minute)[0])}${secZero ? '' : `:${pad(sorted(second)[0])}`}`);
    } else if (!hour.any && !/\//.test(hour.text) && single(minute) && secZero && hour.values.size <= 6) {
      parts.push(`At ${list(sorted(hour).map((h) => `${pad(h)}:${pad(sorted(minute)[0])}`))}`);
    } else {
      if (second.any) parts.push('Every second');
      else if (!secZero) parts.push(/\//.test(second.text) ? capital(describeSet(second, 'second', String, FIELD_DEFS.second)) : `At second ${describeSet(second, 'second', String, FIELD_DEFS.second)}`);
      if (minute.any) parts.push(second.any ? 'of every minute' : 'Every minute');
      else parts.push(/\//.test(minute.text) ? describeSet(minute, 'minute', String, FIELD_DEFS.minute) : `at minute ${describeSet(minute, 'minute', String, FIELD_DEFS.minute)}`);
      if (!hour.any) {
        if (/\//.test(hour.text)) parts.push(`of ${describeSet(hour, 'hour', String, FIELD_DEFS.hour)}`.replace('of every', 'every'));
        else {
          const hv = sorted(hour);
          const contiguous = hv.length > 2 && hv.every((v, i) => i === 0 || v === hv[i - 1] + 1);
          parts.push(contiguous ? `between ${pad(hv[0])}:00 and ${pad(hv[hv.length - 1])}:59` : `past hour ${list(hv.map(String))}`);
        }
      }
    }

    const dayParts = [];
    if (!dom.any) {
      const bits = [];
      if (dom.values.size) bits.push(`on day ${describeSet(dom, 'day', String, FIELD_DEFS.dom)} of the month`);
      if (dom.last) bits.push(dom.lastOffset ? `${dom.lastOffset} day(s) before the last day of the month` : 'on the last day of the month');
      if (dom.lastWeekday) bits.push('on the last weekday of the month');
      for (const n of dom.nearestWeekday) bits.push(`on the weekday nearest the ${ord(n)}`);
      dayParts.push(bits.join(' or '));
    }
    if (!dow.any) {
      const bits = [];
      if (dow.values.size) bits.push(describeSet(dow, 'day', (v) => DAY_NAMES[v % 7], { min: 0 }).replace(/^every (\d+) days/, 'every $1 days of the week'));
      for (const d of dow.lastDow) bits.push(`the last ${DAY_NAMES[d]} of the month`);
      for (const x of dow.nthDow) bits.push(`the ${ord(x.nth)} ${DAY_NAMES[x.dow]} of the month`);
      dayParts.push(`on ${bits.join(' or ')}`);
    }
    if (dayParts.length) parts.push(dayParts.join(p.flavor === 'unix' && dayParts.length === 2 ? ' or ' : ' and '));
    if (!month.any) parts.push(`in ${describeSet(month, 'month', (v) => MONTH_NAMES[v - 1], FIELD_DEFS.month)}`);
    if (!year.any) parts.push(`in ${describeSet(year, 'year', String, FIELD_DEFS.year)}`);
    return capital(parts.join(', ').replace(/, of /g, ' of ').replace(/, (past|between|at minute)/g, ' $1'));
  }

  const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ---------- conversions ----------
  // Renumber day-of-week values, leaving the nth in "6#3" and step sizes in "1/2" alone.
  const shiftDow = (s, fn) => s.replace(/(^|[^#/\d])(\d+)/g, (_m, pre, n) => pre + fn(Number(n)));

  function toQuartzDays(sixFields) {
    const f = sixFields.split(' ');
    // dow numbers shift by one (Quartz 1 = Sunday); one of the day fields must be "?"
    f[5] = shiftDow(f[5], (n) => (n % 7) + 1);
    if (f[5] === '*') f[5] = '?';
    else if (f[3] === '*') f[3] = '?';
    return f.join(' ');
  }

  /** Equivalent expressions in the other flavours: { unix, spring, quartz } (null when not representable). */
  function convert(p) {
    const r = p.raw;
    const dowStd = p.flavor === 'quartz' ? shiftDow(r.dow, (n) => n - 1) : r.dow;
    const domStd = r.dom === '?' ? '*' : r.dom;
    const dowStd2 = dowStd === '?' ? '*' : dowStd;
    const special = /[LW#]/i.test(domStd + dowStd2);
    const unixOk = r.second === '0' && r.year === '*' && !special;
    // Vixie cron rejects Quartz-style "0/30": write it as "*/30" or "5-59/30".
    const unixStep = (s, min, max) => s.replace(/^(\d+)\/(\d+)$/, (_m, a, step) => (Number(a) === min ? `*/${step}` : `${a}-${max}/${step}`));
    const unix = unixOk ? `${unixStep(r.minute, 0, 59)} ${unixStep(r.hour, 0, 23)} ${unixStep(domStd, 1, 31)} ${unixStep(r.month, 1, 12)} ${dowStd2}` : null;
    const spring = r.year === '*' ? `${r.second} ${r.minute} ${r.hour} ${domStd} ${r.month} ${dowStd2}` : null;
    let quartz;
    if (p.flavor === 'quartz') quartz = Object.values({ s: r.second, m: r.minute, h: r.hour, d: r.dom, mo: r.month, w: r.dow }).join(' ') + (r.year !== '*' ? ` ${r.year}` : '');
    else if (domStd !== '*' && dowStd2 !== '*') quartz = null; // Quartz cannot restrict both day fields
    else quartz = toQuartzDays(`${r.second} ${r.minute} ${r.hour} ${domStd} ${r.month} ${dowStd2.replace(/[A-Z]{3}/gi, (x) => x)}`);
    return { unix, spring, quartz };
  }

  return { parse, next, describe, convert, detectFlavor };
});
