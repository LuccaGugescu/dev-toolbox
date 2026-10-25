'use strict';

(() => {
  const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /**
   * Parse epoch numbers (unit guessed from magnitude) or date strings.
   * @returns {{ ms: number, extraNanos: string, detected: string }}
   */
  function parseInput(raw) {
    const s = raw.trim();
    if (!s || s.toLowerCase() === 'now') return { ms: Date.now(), extraNanos: '', detected: 'now' };
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      const abs = Math.abs(n);
      if (abs < 1e11) return { ms: n * 1000, extraNanos: '', detected: 'Unix seconds' };
      if (abs < 1e14) return { ms: n, extraNanos: '', detected: 'Unix milliseconds' };
      if (abs < 1e17) return { ms: Math.floor(n / 1e3), extraNanos: s.slice(-3), detected: 'Unix microseconds' };
      return { ms: Math.floor(n / 1e6), extraNanos: s.slice(-6), detected: 'Unix nanoseconds' };
    }
    // "2024-05-01 10:00:00" (SQL style) -> ISO; keep fractional seconds beyond ms out of Date.
    const iso = s.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2');
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) throw new Error('Not a recognised timestamp or date. Try 1717000000, 2024-05-29T14:30:00Z, or "Wed, 29 May 2024 14:30:00 GMT".');
    const hasZone = /(Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(iso.trim()) || /^[A-Za-z]{3},/.test(s);
    return { ms, extraNanos: '', detected: hasZone ? 'Date with time zone' : `Date without zone (read as ${LOCAL_ZONE})` };
  }

  /** Wall-clock parts of `ms` in `zone`, plus its UTC offset like +02:00. */
  function zonedParts(ms, zone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long', timeZoneName: 'longOffset',
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
    return { ...p, offset };
  }

  function isoWeek(ms) {
    const d = new Date(ms);
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return `${d.getUTCFullYear()}-W${String(1 + Math.round(((d - firstThursday) / 864e5 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
  }

  Toolbox.register({
    id: 'time',
    name: 'Timestamp Converter',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',

    mount(root) {
      const { h, copy, debounce, relativeTime } = Toolbox;
      const zones = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')];
      const zoneSelect = h('select', { title: 'Time zone for the zoned rows' },
        zones.map((z) => h('option', { value: z, selected: z === LOCAL_ZONE }, z === LOCAL_ZONE ? `${z} (local)` : z)));
      const input = h('input.code', { type: 'text', placeholder: 'Unix seconds / ms / µs / ns, ISO-8601, RFC 1123, "now"…', style: 'flex:1;min-width:280px', spellcheck: 'false' });
      const status = h('span.status.muted');

      const nowSec = h('span.v');
      const nowMs = h('span.v');
      const nowIso = h('span.v');
      const nowRow = (label, el) => [h('span.k', {}, label), el, h('button', { onclick: () => copy(el.textContent) }, 'Copy')];
      const clock = h('div.kv', {}, nowRow('Now · seconds', nowSec), nowRow('Now · milliseconds', nowMs), nowRow('Now · ISO UTC', nowIso));

      const rows = h('div.kv');
      root.append(
        h('div.toolbar', {}, input, h('button', { onclick: () => { input.value = String(Math.floor(Date.now() / 1000)); run(); } }, 'Now'), h('label.field', {}, 'Zone', zoneSelect), status),
        h('div.pane-body', {},
          h('div.section', { style: 'padding:10px 0 0' }, h('h3', { style: 'padding:0 12px' }, 'Converted'), rows),
          h('div.section', { style: 'padding:10px 0 0' }, h('h3', { style: 'padding:0 12px' }, 'Current time'), clock)));

      function run() {
        rows.replaceChildren();
        if (!input.value.trim()) {
          status.textContent = 'Type a timestamp or date';
          status.className = 'status muted';
          return;
        }
        let parsed;
        try {
          parsed = parseInput(input.value);
        } catch (err) {
          status.textContent = `✗ ${err.message}`;
          status.className = 'status err';
          return;
        }
        const { ms, extraNanos, detected } = parsed;
        if (Number.isNaN(new Date(ms).getTime())) {
          status.textContent = '✗ Out of the supported date range';
          status.className = 'status err';
          return;
        }
        status.textContent = `Detected: ${detected}`;
        status.className = 'status ok';

        const zone = zoneSelect.value;
        const z = zonedParts(ms, zone);
        const millis = String(((ms % 1000) + 1000) % 1000).padStart(3, '0');
        const frac = extraNanos ? `${millis}${extraNanos}` : millis;
        const zonedIso = `${z.year}-${z.month}-${z.day}T${z.hour}:${z.minute}:${z.second}.${frac}${z.offset === '+00:00' ? 'Z' : z.offset}`;
        const list = [
          ['Unix seconds', String(Math.floor(ms / 1000))],
          ['Unix milliseconds', String(ms)],
          ['ISO-8601 UTC (Instant)', new Date(ms).toISOString().replace(/\.\d{3}Z$/, `.${frac}Z`)],
          [`ISO-8601 ${zone} (OffsetDateTime)`, zonedIso],
          [`ZonedDateTime`, `${zonedIso}[${zone}]`],
          [`SQL timestamp (${zone})`, `${z.year}-${z.month}-${z.day} ${z.hour}:${z.minute}:${z.second}.${millis}`],
          ['RFC 1123 / HTTP date', new Date(ms).toUTCString()],
          ['Human', new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }).format(new Date(ms))],
          ['Relative', relativeTime(ms)],
          ['Day / ISO week', `${z.weekday} · ${isoWeek(ms)}`],
        ];
        for (const [k, v] of list) rows.append(h('span.k', {}, k), h('span.v', {}, v), h('button', { onclick: () => copy(v) }, 'Copy'));
      }

      function tick() {
        if (root.hidden) return;
        const now = Date.now();
        nowSec.textContent = String(Math.floor(now / 1000));
        nowMs.textContent = String(now);
        nowIso.textContent = new Date(now).toISOString();
      }

      input.addEventListener('input', debounce(run, 100));
      zoneSelect.addEventListener('change', run);
      setInterval(tick, 1000);
      tick();
      input.value = String(Math.floor(Date.now() / 1000));
      run();
    },

    onShow() {
      document.querySelector('.tool-container:not([hidden]) .toolbar input')?.focus();
    },
  });
})();
