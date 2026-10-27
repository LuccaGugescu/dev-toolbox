'use strict';

(() => {
  const PRESETS = [
    ['Every 5 minutes', '*/5 * * * *'], ['Hourly', '0 * * * *'], ['Daily 02:00', '0 2 * * *'], ['Weekdays 09:00', '0 9 * * 1-5'],
    ['Every 30 s (Spring)', '*/30 * * * * *'], ['1st of month', '0 0 1 * *'], ['Last day of month (Quartz)', '0 0 23 L * ?'], ['2nd Monday (Quartz)', '0 0 8 ? * 2#2'],
  ];

  Toolbox.register({
    id: 'cron',
    name: 'Cron Expression',
    group: 'Backend',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6M12 2v3"/></svg>',

    mount(root) {
      const { h, copyButton, debounce, pane, relativeTime } = Toolbox;
      let utc = false;

      const flavorSelect = h('select', {},
        h('option', { value: 'auto' }, 'Auto-detect'), h('option', { value: 'unix' }, 'Unix / Kubernetes (5 fields)'),
        h('option', { value: 'spring' }, 'Spring @Scheduled (6 fields)'), h('option', { value: 'quartz' }, 'Quartz (6-7 fields)'));
      const tzButtons = h('span.segmented', {}, h('button.on', { dataset: { tz: 'local' } }, 'Local time'), h('button', { dataset: { tz: 'utc' } }, 'UTC'));
      const status = h('span.status.muted');
      root.append(h('div.toolbar', {}, flavorSelect, tzButtons, h('span.sep'), status));

      const exprInput = h('input.code.cron-input', { spellcheck: 'false', value: '0 9 * * 1-5' });
      const description = h('div.cron-desc');
      const legend = h('div.cron-legend');
      const presets = h('div.chips-bar', {}, h('span.muted', {}, 'Examples:'),
        PRESETS.map(([label, expr]) => h('button.chip', { title: expr, onclick: () => { exprInput.value = expr; flavorSelect.value = 'auto'; run(); } }, label)));
      const left = pane('Expression', [], h('div.pane-body'));
      left.body.append(h('div.section', {}, exprInput, description), legend, h('div.section', {}, presets),
        h('div.section.muted', { style: 'font-size:12px;line-height:1.6' },
          h('div', {}, h('b', {}, 'Unix'), ': min hour day month weekday (0/7 = Sun). Day-of-month and weekday both set = either matches.'),
          h('div', {}, h('b', {}, 'Spring'), ': sec min hour day month weekday. Supports L, W, # since Spring 5.3; both day fields must match.'),
          h('div', {}, h('b', {}, 'Quartz'), ': sec min hour day month weekday [year], weekday 1 = Sun, one day field must be "?".')));

      const runs = h('div.cron-runs');
      const equivalents = h('div.kv');
      const snippets = h('div', { style: 'padding-top:12px' });
      const right = pane('Next runs', [], h('div.pane-body'));
      right.body.append(runs, h('div.section', { style: 'padding:10px 0 0' }, h('h3', { style: 'padding:0 12px' }, 'Equivalent expressions'), equivalents), snippets);
      root.append(h('div.split', {}, left.el, right.el));

      function run() {
        for (const el of [runs, equivalents, snippets, legend]) el.replaceChildren();
        description.textContent = '';
        let p;
        try {
          p = Cron.parse(exprInput.value, flavorSelect.value);
        } catch (err) {
          setStatus(`✗ ${err.message}`, 'err');
          description.textContent = '';
          return;
        }
        setStatus(`✓ ${{ unix: 'Unix', spring: 'Spring', quartz: 'Quartz' }[p.flavor]} expression`, 'ok');
        description.textContent = Cron.describe(p);

        const order = p.flavor === 'unix' ? ['minute', 'hour', 'dom', 'month', 'dow'] : ['second', 'minute', 'hour', 'dom', 'month', 'dow', ...(p.raw.year !== '*' ? ['year'] : [])];
        const NAMES = { second: 'Second', minute: 'Minute', hour: 'Hour', dom: 'Day of month', month: 'Month', dow: 'Day of week', year: 'Year' };
        legend.append(h('div.cron-fields', {}, order.map((k) => h('div.cron-field', {}, h('code', {}, p.raw[k]), h('span.muted', {}, NAMES[k])))));

        const now = new Date();
        const next = Cron.next(p, now, 12, { utc });
        if (!next.length) runs.append(h('div.empty', {}, 'No run in the next 8 years'));
        for (const d of next) {
          const text = utc ? d.toISOString().replace('T', ' ').replace(/\.000Z$/, ' UTC') : d.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: p.flavor === 'unix' ? undefined : '2-digit' });
          runs.append(h('div.cron-run', {}, h('span', {}, text), h('span.muted', {}, relativeTime(d.getTime(), now.getTime()))));
        }

        const eq = Cron.convert(p);
        const add = (label, value, hint) => equivalents.append(h('span.k', {}, label), h('span.v', {}, value ?? h('span.muted', {}, hint)), value ? copyButton(() => value) : h('span'));
        add('Unix / Kubernetes', eq.unix, 'not representable (seconds, year or L/W/#)');
        add('Spring', eq.spring, 'not representable (year field)');
        add('Quartz', eq.quartz, 'Quartz cannot restrict both day fields');

        const blocks = [];
        if (eq.spring) blocks.push(['Spring', `@Scheduled(cron = "${eq.spring}"${utc ? ', zone = "UTC"' : ''})\npublic void job() { }`]);
        if (eq.quartz) blocks.push(['Quartz', `CronScheduleBuilder.cronSchedule("${eq.quartz}")${utc ? '\n    .inTimeZone(TimeZone.getTimeZone("UTC"))' : ''}`]);
        if (eq.unix) {
          blocks.push(['Kubernetes CronJob', `apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: my-job\nspec:\n  schedule: "${eq.unix}"${utc ? '\n  timeZone: "Etc/UTC"' : ''}\n  concurrencyPolicy: Forbid\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: OnFailure\n          containers:\n            - name: my-job\n              image: my-image:latest`]);
          blocks.push(['crontab', `${eq.unix} /path/to/script.sh >> /var/log/my-job.log 2>&1`]);
          blocks.push(['pg_cron', `SELECT cron.schedule('my-job', '${eq.unix}', $$CALL my_procedure()$$);`]);
        }
        if (eq.unix || eq.spring) blocks.push(['Oracle DBMS_SCHEDULER', `BEGIN\n  DBMS_SCHEDULER.CREATE_JOB(\n    job_name        => 'MY_JOB',\n    job_type        => 'STORED_PROCEDURE',\n    job_action      => 'MY_PROC',\n    repeat_interval => '${toCalendar(p)}',\n    enabled         => TRUE);\nEND;\n/`]);
        for (const [label, code] of blocks) {
          snippets.append(h('div.conn-item', {}, h('div.conn-head', {}, h('span', {}, label), h('span.grow'), copyButton(() => code)), h('pre.code', {}, code)));
        }
      }

      // Oracle calendaring syntax for simple field lists (L / W / # are not mapped).
      function toCalendar(p) {
        const r = p.raw;
        const parts = [];
        const lst = (s) => s.replace(/\*\/(\d+)/, '').replace(/\//g, '');
        let freq = 'DAILY';
        if (/^\*\/\d+$/.test(r.minute)) { freq = 'MINUTELY'; parts.push(`INTERVAL=${r.minute.split('/')[1]}`); }
        else if (/^\*\/\d+$/.test(r.hour)) { freq = 'HOURLY'; parts.push(`INTERVAL=${r.hour.split('/')[1]}`); }
        else if (r.hour === '*' && r.minute !== '*') freq = 'HOURLY';
        else if (r.minute === '*') freq = 'MINUTELY';
        if (r.month !== '*') parts.push(`BYMONTH=${lst(r.month)}`);
        if (r.dom !== '*' && r.dom !== '?') parts.push(`BYMONTHDAY=${r.dom === 'L' ? '-1' : lst(r.dom)}`);
        if (r.dow !== '*' && r.dow !== '?') {
          const days = [...p.fields.dow.values].sort().map((d) => ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d]);
          if (days.length) parts.push(`BYDAY=${days.join(',')}`);
        }
        if (!/[*/]/.test(r.hour)) parts.push(`BYHOUR=${r.hour}`);
        if (!/[*/]/.test(r.minute)) parts.push(`BYMINUTE=${r.minute}`);
        if (p.flavor !== 'unix' && !/[*/]/.test(r.second)) parts.push(`BYSECOND=${r.second}`);
        return [`FREQ=${freq}`, ...parts].join('; ');
      }

      function setStatus(text, kind) {
        status.textContent = text;
        status.title = text;
        status.className = `status ${kind}`;
      }

      exprInput.addEventListener('input', debounce(run, 150));
      flavorSelect.addEventListener('change', run);
      tzButtons.addEventListener('click', (e) => {
        if (!e.target.dataset.tz) return;
        utc = e.target.dataset.tz === 'utc';
        for (const b of tzButtons.children) b.classList.toggle('on', b === e.target);
        run();
      });
      run();
    },
  });
})();
