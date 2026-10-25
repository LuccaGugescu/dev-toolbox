'use strict';

(() => {
  const b64urlToBytes = (s) => {
    const clean = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const decodeJson = (part, name) => {
    try {
      return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
    } catch {
      throw new Error(`${name} is not Base64URL-encoded JSON`);
    }
  };

  // JWS alg -> WebCrypto parameters.
  const ALGS = {
    HS256: { kind: 'hmac', hash: 'SHA-256' }, HS384: { kind: 'hmac', hash: 'SHA-384' }, HS512: { kind: 'hmac', hash: 'SHA-512' },
    RS256: { kind: 'rsa', name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, RS384: { kind: 'rsa', name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, RS512: { kind: 'rsa', name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
    PS256: { kind: 'rsa', name: 'RSA-PSS', hash: 'SHA-256', saltLength: 32 }, PS384: { kind: 'rsa', name: 'RSA-PSS', hash: 'SHA-384', saltLength: 48 }, PS512: { kind: 'rsa', name: 'RSA-PSS', hash: 'SHA-512', saltLength: 64 },
    ES256: { kind: 'ec', hash: 'SHA-256', curve: 'P-256' }, ES384: { kind: 'ec', hash: 'SHA-384', curve: 'P-384' }, ES512: { kind: 'ec', hash: 'SHA-512', curve: 'P-521' },
  };

  async function verify(token, alg, keyText, secretIsBase64) {
    const spec = ALGS[alg];
    if (!spec) throw new Error(alg === 'none' ? 'Token is unsigned (alg "none"): never accept it' : `Algorithm ${alg} is not supported`);
    const [h, p, s] = token.split('.');
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = b64urlToBytes(s);
    if (spec.kind === 'hmac') {
      const raw = secretIsBase64 ? b64urlToBytes(keyText.trim().replace(/=+$/, '')) : new TextEncoder().encode(keyText);
      const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: spec.hash }, false, ['verify']);
      return crypto.subtle.verify('HMAC', key, sig, data);
    }
    const importAlg = spec.kind === 'ec' ? { name: 'ECDSA', namedCurve: spec.curve } : { name: spec.name, hash: spec.hash };
    const key = await importPublicKey(keyText, importAlg);
    const verifyAlg = spec.kind === 'ec' ? { name: 'ECDSA', hash: spec.hash } : spec.name === 'RSA-PSS' ? { name: 'RSA-PSS', saltLength: spec.saltLength } : spec.name;
    return crypto.subtle.verify(verifyAlg, key, sig, data);
  }

  function importPublicKey(text, alg) {
    const t = text.trim();
    if (t.startsWith('{')) {
      const jwk = JSON.parse(t);
      return crypto.subtle.importKey('jwk', jwk.keys ? jwk.keys[0] : jwk, alg, false, ['verify']);
    }
    if (!/-----BEGIN PUBLIC KEY-----/.test(t)) {
      throw new Error('Paste a public key as PEM ("-----BEGIN PUBLIC KEY-----") or JWK JSON');
    }
    const der = b64urlToBytes(t.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    return crypto.subtle.importKey('spki', der, alg, false, ['verify']);
  }

  Toolbox.register({
    id: 'jwt',
    name: 'JWT Decoder',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M17 6l3 3M15 8l2 2"/></svg>',

    mount(root) {
      const { h, copyButton, debounce, pane, relativeTime } = Toolbox;
      const status = h('span.status.muted', {}, 'Paste a JWT on the left');
      root.append(h('div.toolbar', {}, h('span.muted', {}, 'Decodes locally — the token never leaves this computer.'), h('span.grow'), status));

      const tokenInput = h('textarea.code', { spellcheck: 'false', placeholder: 'eyJhbGciOi…  (a "Bearer " prefix is fine)' });
      const parts = h('div.jwt-parts');
      const keyInput = h('textarea.code.boxed', { rows: 5, spellcheck: 'false', placeholder: 'HS*: shared secret · RS*/PS*/ES*: public key PEM or JWK' });
      const b64Check = h('input', { type: 'checkbox' });
      const verifyResult = h('div', { style: 'margin-top:8px' });
      const left = pane('Encoded token', [h('button', { onclick: () => { tokenInput.value = ''; run(); } }, 'Clear')], h('div.pane-body.stack'));
      left.body.append(
        h('div', { style: 'flex:1;min-height:120px' }, tokenInput),
        h('div.section', { style: 'border-top:1px solid var(--border)' }, h('h3', {}, 'Colored parts'), parts),
        h('div.section', {}, h('h3', {}, 'Verify signature', h('span.grow'), h('label.check', { style: 'text-transform:none;letter-spacing:0' }, b64Check, 'secret is Base64')), keyInput, verifyResult));

      const headerPre = h('pre.code');
      const payloadPre = h('pre.code');
      const claims = h('div.kv');
      const right = pane('Decoded', [copyButton(() => payloadPre.textContent, 'Copy payload')]);
      right.body.append(
        h('div.section', {}, h('h3', {}, 'Header'), headerPre),
        h('div.section', {}, h('h3', {}, 'Payload'), payloadPre),
        h('div.section', { style: 'padding:10px 0 0' }, h('h3', { style: 'padding:0 12px' }, 'Claims'), claims));
      root.append(h('div.split.wide-right', {}, left.el, right.el));

      let decoded = null;

      function run() {
        const token = tokenInput.value.trim().replace(/^Bearer\s+/i, '');
        decoded = null;
        for (const el of [headerPre, payloadPre, claims, parts, verifyResult]) el.replaceChildren();
        if (!token) {
          setStatus('Paste a JWT on the left', 'muted');
          return;
        }
        const segs = token.split('.');
        if (segs.length === 5) {
          setStatus('This is an encrypted JWE (5 parts): the payload cannot be read without the private key', 'warn');
          return;
        }
        if (segs.length !== 3) {
          setStatus(`✗ A JWT has 3 parts separated by "." — found ${segs.length}`, 'err');
          return;
        }
        parts.append(h('span.jwt-h', {}, segs[0]), '.', h('span.jwt-p', {}, segs[1]), '.', h('span.jwt-s', {}, segs[2]));
        try {
          const header = decodeJson(segs[0], 'Header');
          const payload = decodeJson(segs[1], 'Payload');
          decoded = { token, header, payload };
          headerPre.textContent = JSON.stringify(header, null, 2);
          payloadPre.textContent = JSON.stringify(payload, null, 2);
          renderClaims(header, payload);
          const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
          if (exp && exp < Date.now()) setStatus(`Decoded · ${header.alg} · EXPIRED ${relativeTime(exp)}`, 'err');
          else setStatus(`✓ Decoded · ${header.alg}${exp ? ` · expires ${relativeTime(exp)}` : ' · no expiry'}`, 'ok');
          runVerify();
        } catch (err) {
          setStatus(`✗ ${err.message}`, 'err');
        }
      }

      function renderClaims(header, payload) {
        const row = (k, v, cls) => claims.append(h('span.k', {}, k), h(`span.v${cls ? '.' + cls : ''}`, {}, v), h('span'));
        const NAMES = { iss: 'Issuer', sub: 'Subject', aud: 'Audience', jti: 'JWT ID', scope: 'Scope', azp: 'Authorized party', typ: 'Type' };
        const now = Date.now();
        row('Algorithm', String(header.alg), header.alg === 'none' ? 'claim-bad' : null);
        if (header.kid) row('Key ID (kid)', String(header.kid));
        for (const [key, label] of [['iat', 'Issued at'], ['nbf', 'Not before'], ['exp', 'Expires']]) {
          if (typeof payload[key] !== 'number') continue;
          const ms = payload[key] * 1000;
          const bad = (key === 'exp' && ms < now) || (key === 'nbf' && ms > now);
          row(`${label} (${key})`, `${new Date(ms).toLocaleString()} · ${relativeTime(ms)}`, bad ? 'claim-bad' : key === 'exp' ? 'claim-good' : null);
        }
        if (typeof payload.iat === 'number' && typeof payload.exp === 'number') {
          row('Lifetime', `${Math.round((payload.exp - payload.iat) / 60)} minutes`);
        }
        for (const [key, label] of Object.entries(NAMES)) {
          if (payload[key] != null) row(`${label} (${key})`, Array.isArray(payload[key]) ? payload[key].join(', ') : String(payload[key]));
        }
      }

      async function runVerify() {
        verifyResult.replaceChildren();
        if (!decoded || !keyInput.value.trim()) return;
        try {
          const ok = await verify(decoded.token, decoded.header.alg, keyInput.value, b64Check.checked);
          verifyResult.append(ok
            ? h('span.claim-good', {}, '✓ Signature verified')
            : h('span.claim-bad', {}, '✗ Invalid signature: wrong key/secret or the token was modified'));
        } catch (err) {
          verifyResult.append(h('span.claim-bad', {}, `✗ ${err.message || 'Key could not be imported'}`));
        }
      }

      function setStatus(text, kind) {
        status.textContent = text;
        status.title = text;
        status.className = `status ${kind}`;
      }

      tokenInput.addEventListener('input', debounce(run, 100));
      keyInput.addEventListener('input', debounce(runVerify, 200));
      b64Check.addEventListener('change', runVerify);
    },
  });
})();
