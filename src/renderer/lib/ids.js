'use strict';

// UUID / ULID generation and inspection. Generates v4, v7 (time-ordered, good primary keys) and ULID;
// decodes any UUID (version, variant, embedded timestamp) and renders it for PostgreSQL, Oracle
// RAW(16) / SYS_GUID, Java and Base64.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ids = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const fmt = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

  function uuidV4() {
    const b = rnd(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    return fmt(hex(b));
  }

  // RFC 9562 v7: 48-bit Unix ms timestamp, then random. A per-call counter in rand_a keeps ids
  // generated within the same millisecond sortable.
  let lastMs = -1;
  let seq = 0;
  function uuidV7(ms = Date.now()) {
    const b = rnd(16);
    if (ms === lastMs) seq = (seq + 1) & 0xfff;
    else { lastMs = ms; seq = (b[6] << 8 | b[7]) & 0x7ff; }
    const t = BigInt(ms);
    for (let i = 0; i < 6; i++) b[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
    b[6] = 0x70 | (seq >> 8);
    b[7] = seq & 0xff;
    b[8] = (b[8] & 0x3f) | 0x80;
    return fmt(hex(b));
  }

  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function ulid(ms = Date.now()) {
    let time = '';
    let t = ms;
    for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
    const r = rnd(10);
    let bits = 0n;
    for (const x of r) bits = (bits << 8n) | BigInt(x);
    let rand = '';
    for (let i = 0; i < 16; i++) { rand = CROCKFORD[Number(bits & 31n)] + rand; bits >>= 5n; }
    return time + rand;
  }

  function generate(kind, count = 1, { upper = false, braces = false, dashes = true } = {}) {
    const one = () => {
      let id = kind === 'v7' ? uuidV7() : kind === 'ulid' ? ulid() : uuidV4();
      if (kind === 'ulid') return id;
      if (!dashes) id = id.replace(/-/g, '');
      if (upper) id = id.toUpperCase();
      return braces ? `{${id}}` : id;
    };
    return Array.from({ length: count }, one);
  }

  /** Inspect a UUID (any common spelling) or a ULID. Returns details or throws. */
  function inspect(input) {
    const s = input.trim().replace(/^urn:uuid:/i, '').replace(/^[{(]|[})]$/g, '').replace(/^HEXTORAW\('|'\)$/gi, '').replace(/^'|'(::uuid)?$/g, '');
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(s) && !/^[0-9a-f]{26}$/i.test(s)) return inspectUlid(s.toUpperCase());
    let h = null;
    if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) h = s.replace(/-/g, '').toLowerCase();
    else if (/^[A-Za-z0-9+/_-]{22}(==)?$/.test(s)) {
      const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64.length === 22 ? `${b64}==` : b64);
      h = hex(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } else if (/^-?\d+\s*[, ]\s*-?\d+$/.test(s)) {
      // Java new UUID(mostSigBits, leastSigBits)
      const [msb, lsb] = s.split(/\s*[, ]\s*/).map((x) => BigInt.asUintN(64, BigInt(x)));
      h = msb.toString(16).padStart(16, '0') + lsb.toString(16).padStart(16, '0');
    }
    if (!h) throw new Error('Not a UUID / ULID. Accepted: 8-4-4-4-12 hex, 32 hex (Oracle RAW), {braces}, urn:uuid:, Base64 (22 chars), "msb, lsb" longs, or a 26-char ULID');
    return inspectHex(h);
  }

  function inspectHex(h) {
    const canonical = fmt(h);
    const version = parseInt(h[12], 16);
    const v = parseInt(h[16], 16);
    const variant = v >= 0xe ? 'Reserved (future)' : v >= 0xc ? 'Microsoft (GUID, mixed-endian)' : v >= 0x8 ? 'RFC 9562 / 4122' : 'NCS (legacy)';
    const isNil = /^0+$/.test(h);
    const isMax = /^f+$/i.test(h);
    let time = null;
    let note = '';
    if (variant.startsWith('RFC')) {
      if (version === 7) time = Number(BigInt(`0x${h.slice(0, 12)}`));
      else if (version === 1 || version === 6) {
        const ticks = version === 1
          ? (BigInt(`0x${h.slice(13, 16)}`) << 48n) | (BigInt(`0x${h.slice(8, 12)}`) << 32n) | BigInt(`0x${h.slice(0, 8)}`)
          : (BigInt(`0x${h.slice(0, 12)}`) << 12n) | BigInt(`0x${h.slice(13, 16)}`);
        time = Number((ticks - 122192928000000000n) / 10000n); // 100 ns since 1582-10-15 -> Unix ms
        note = `node (MAC) ${h.slice(20).match(/../g).join(':')}`;
      }
    }
    const VERSIONS = {
      1: 'time-based (MAC + timestamp)', 2: 'DCE security', 3: 'name-based (MD5)', 4: 'random',
      5: 'name-based (SHA-1)', 6: 'reordered time-based', 7: 'Unix-time ordered (best for primary keys)', 8: 'custom',
    };
    const bytes = Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
    const msb = BigInt.asIntN(64, BigInt(`0x${h.slice(0, 16)}`));
    const lsb = BigInt.asIntN(64, BigInt(`0x${h.slice(16)}`));
    // .NET Guid.ToByteArray / SQL Server uniqueidentifier byte order (first three groups little-endian)
    const msOrder = h.slice(6, 8) + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2) + h.slice(10, 12) + h.slice(8, 10) + h.slice(14, 16) + h.slice(12, 14) + h.slice(16);
    return {
      kind: 'uuid',
      canonical,
      version: isNil ? 'Nil UUID' : isMax ? 'Max UUID' : `${version} — ${VERSIONS[version] || 'unknown'}`,
      variant,
      time,
      note,
      forms: [
        ['Canonical', canonical],
        ['Upper case', canonical.toUpperCase()],
        ['32 hex (Oracle RAW / SYS_GUID)', h.toUpperCase()],
        ['PostgreSQL literal', `'${canonical}'::uuid`],
        ['Oracle RAW(16) literal', `HEXTORAW('${h.toUpperCase()}')`],
        ['Oracle SYS_GUID() → UUID text', `REGEXP_REPLACE(RAWTOHEX(SYS_GUID()), '(.{8})(.{4})(.{4})(.{4})(.{12})', '\\1-\\2-\\3-\\4-\\5')`],
        ['Java', `UUID.fromString("${canonical}")`],
        ['Java new UUID(msb, lsb)', `new UUID(${msb}L, ${lsb}L)`],
        ['Base64', btoa(String.fromCharCode(...bytes))],
        ['Base64URL (22 chars)', btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')],
        ['URN', `urn:uuid:${canonical}`],
        ['.NET / SQL Server byte order (hex)', msOrder.toUpperCase()],
      ],
    };
  }

  function inspectUlid(s) {
    let time = 0;
    for (const c of s.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(c);
    let bits = 0n;
    for (const c of s) bits = (bits << 5n) | BigInt(CROCKFORD.indexOf(c));
    const h = (bits & ((1n << 128n) - 1n)).toString(16).padStart(32, '0');
    return {
      kind: 'ulid',
      canonical: s,
      version: 'ULID (48-bit ms timestamp + 80 random bits)',
      variant: '—',
      time,
      note: '',
      forms: [['ULID', s], ['As UUID (same 128 bits)', fmt(h)], ['32 hex', h.toUpperCase()], ['PostgreSQL literal', `'${fmt(h)}'::uuid`], ['Oracle RAW(16) literal', `HEXTORAW('${h.toUpperCase()}')`]],
    };
  }

  return { generate, inspect, uuidV4, uuidV7, ulid };
});
