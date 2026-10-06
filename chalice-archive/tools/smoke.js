#!/usr/bin/env node
/* Smoke test for the self-hosted archive: starts server/server.mjs on dist/ (python3 build.py first) with
   throwaway data, probes its API the way an attacker would, then drives the page in headless Chromium.

    cd tools && npm install && node smoke.js

Environment:
  CHROME       path to a Chromium/Chrome binary (default: Playwright's own install)
  CHROME_ARGS  extra browser flags, space-separated
  HTTPS_PROXY  used for the CDN requests when set

Checks:
  1. Over HTTP, against a server set up as in production (Secure cookies, PUBLIC_ORIGIN, TRUST_PROXY):
     security headers and a CSP whose hashes match the page; nothing outside the page, the model, the API and
     the art in use can be fetched; logins and writes refuse a foreign or missing Origin, a missing or wrong CSRF
     token, and non-JSON bodies; the session cookie's flags; field validation and size limits; stored markup
     cannot end the page's data block; backups; the About page's cleaning; image uploads (type sniffed from the
     bytes, size, dimensions), plates, their order and links, art served only while used, the sweep of unused
     uploads; plates of several images, flagged mature one by one; his forms, which hold the plates; GIFs and MP4s,
     which lose their metadata, and WebM videos; videos served in byte ranges; encounters, whose private sections are stored
     encrypted, never reach visitors, and need the session and its CSRF token; plates saved before
     they had several images; the password file; changing the word signs other sessions out; failed logins are
     throttled per IP.
  2. In Chromium, under the server's real CSP: the 3D model replaces the cutout with no console errors; only
     the gem wakes the construct, which reveals the choices, and they go again when the tome closes; a wrong word is refused; the right word shows the
     tools; records can be inscribed, revised and removed, and markup in them stays text; an encounter with a private
     section can be recorded, a record can name it and link to it, and the private section shows only while unsealed; the About page can be
     amended in Total RP 3's terms (directory, standard traits, glances, a description whose TRP markup becomes
     headings, darkened colours and only http(s) links while HTML stays text), Escape keeps unsaved writing, and
     the page has no portrait; a form can be added, and a plate of two images, one mature, uploaded into it, shown full
     size, linked to and removed; a video and a GIF play in their players; a mature image stays covered and unloaded until a visitor says they are 18 or older, is covered
     again once they move on, and stays covered for someone under 18; the session survives a reload; the word can
     be changed from the page; sealing it again hides the tools.
  1c. The private sections across server restarts: still readable with the word, carried over to a new word set from
     the command line (which needs the current word), unreadable when moved onto another encounter, and gone after
     set-password --forget-private.
  3. dist/preview.html, the claude.ai Artifact build, in the Artifact's skeleton under a CSP like its viewer's (no
     network requests at all): the model, the example forms and their plates, GIF and video load from the page, the
     stand-in server accepts only "preview", the About page can be amended and records and plates added, and a reload
     forgets them. The real page carries no trace
     of the stand-in.
Screenshots go to tools/.smoke/.
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'server.mjs');
const OUT = path.join(__dirname, '.smoke');
const WORD = 'a long smoke-test passphrase';
const NEW_WORD = 'another long smoke-test passphrase';
const ORIGIN = 'https://archive.test';
// The viewer plays media embedded in the page (its contract says muted autoplay works), so media-src takes data: and
// blob: here; if it ever does not, the page says the preview could not play the video.
const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com " +
  "https://cdn.tailwindcss.com https://code.jquery.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
  "img-src data:; media-src data: blob:; connect-src 'none'";
const FIXTURES = path.join(__dirname, 'fixtures'); // smoke.webm (96 x 64, 1.5 s) and smoke.gif (48 x 32, four frames)
const ARTIFACT_SKELETON = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
  '<style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
  'html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}' +
  'img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>\n';
const failures = [];
function check(ok, what) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); }

// ---------- server helpers ----------
function run(args, env, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SERVER, ...args], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(input);
  });
}

async function startServer(name, env, prepare, keep) {
  const dataDir = path.join(OUT, 'data-' + name);
  if (!keep) { // a fresh data directory, with the word set; or, with keep, the one a stopped server left
    fs.rmSync(dataDir, { recursive: true, force: true });
    const set = await run(['set-password'], { DATA_DIR: dataDir }, `${WORD}\n${WORD}\n`);
    if (set.code !== 0) throw new Error('set-password failed: ' + set.out);
  }
  if (prepare) prepare(dataDir);
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, DATA_DIR: dataDir, PORT: '0', ...env } });
  let log = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name} server did not start: ${log}`)), 10000);
    const onData = (d) => {
      log += d;
      const m = log.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`${name} server exited (${code}): ${log}`)); });
  });
  return { port, dataDir, url: `http://127.0.0.1:${port}/`, stop: () => proc.kill('SIGTERM'), log: () => log };
}

function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const all = { ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers };
    for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k]; // { Origin: undefined } sends no Origin
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: all }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

// A small RGB PNG with a gradient; its size makes each one different
function makePng(w, h) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), len = Buffer.alloc(4), sum = Buffer.alloc(4);
    len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * (w * 3 + 1) + 1 + x * 3;
    raw[i] = (x * 255 / w) | 0; raw[i + 1] = (y * 255 / h) | 0; raw[i + 2] = 160;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// The start of a JPEG, up to its frame header (48 x 32): enough for the server, which reads only the header
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);

const cookieOf = (res) => ((res.headers['set-cookie'] || [])[0] || '').split(';')[0];
const inlineHash = (html, re) => "'sha256-" + crypto.createHash('sha256').update((html.match(re) || [])[1] || '', 'utf8').digest('base64') + "'";
const archiveIn = (html) => JSON.parse((html.match(/<script type="application\/json" id="ca-data">([\s\S]*?)<\/script>/) || [])[1] || 'null');

// ---------- 1. the API, set up as in production ----------
async function apiChecks() {
  const s = await startServer('api', { COOKIE_SECURE: 'true', PUBLIC_ORIGIN: ORIGIN, TRUST_PROXY: 'true' });
  const call = (method, p, opts = {}) => request(s.port, method, p, opts);
  let ip = 0;
  const fresh = () => `198.51.100.${++ip}`; // a new client address for each login, so throttling stays out of the way
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'auth.json'), 'utf8'));
    const authMode = fs.statSync(path.join(s.dataDir, 'auth.json')).mode & 0o777;
    const authText = fs.readFileSync(path.join(s.dataDir, 'auth.json'), 'utf8');
    check(auth.kdf === 'scrypt' && auth.N === 2 ** 17 && auth.r === 8 && Buffer.from(auth.salt, 'base64').length === 16 && Buffer.from(auth.hash, 'base64').length === 64,
      'the word is stored as a salted scrypt hash (N=2^17, r=8, 16-byte salt, 64-byte key)');
    check(!authText.includes(WORD) && authMode === 0o600, 'the password file holds no plaintext and is readable only by its owner (0600)');
    check((await run(['set-password'], { DATA_DIR: s.dataDir }, 'too short\ntoo short\n')).code !== 0 &&
      (await run(['set-password'], { DATA_DIR: s.dataDir }, `${WORD}\n${WORD}!\n`)).code !== 0 &&
      fs.readFileSync(path.join(s.dataDir, 'auth.json'), 'utf8') === authText, 'set-password refuses a short word and two words that differ');

    // headers and the CSP
    const page = await call('GET', '/');
    const csp = page.headers['content-security-policy'] || '';
    check(page.status === 200 && csp.includes(inlineHash(page.text, /<script id="ca-app">([\s\S]*?)<\/script>/)) &&
      csp.includes(inlineHash(page.text, /<style id="ca-style">([\s\S]*?)<\/style>/)) && !csp.includes('unsafe') &&
      /default-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /connect-src 'self'/.test(csp),
      "the CSP allows only the page's own inline script and style, by hash, and no 'unsafe-' sources");
    const h = page.headers;
    check(h['strict-transport-security'] === 'max-age=31536000; includeSubDomains' && h['x-content-type-options'] === 'nosniff' &&
      h['x-frame-options'] === 'DENY' && h['referrer-policy'] === 'no-referrer' && h['cache-control'] === 'no-store' &&
      h['cross-origin-opener-policy'] === 'same-origin' && !h['x-powered-by'], 'HSTS, nosniff, no framing, no referrer, no caching of the page');
    check(Array.isArray((archiveIn(page.text) || {}).records), 'the page carries the archive in its data block');
    const model = page.text.match(/"(chalice\.[0-9a-f]{12}\.glb)"/)[1];
    const glb = await call('GET', '/' + model);
    check(glb.status === 200 && /immutable/.test(glb.headers['cache-control']) && glb.headers['content-type'] === 'model/gltf-binary', 'the model is served with a long, immutable cache lifetime');

    // nothing else can be fetched
    const probes = ['/../server/data/auth.json', '/%2e%2e/%2e%2e/etc/passwd', '/server/server.mjs', '/dist/index.html', '/.git/config',
      '/api/../server/data/auth.json', '/index.html/../../server/data/auth.json', '/chalice.000000000000.glb', '/backups/', '/%00'];
    const got = await Promise.all(probes.map((p) => call('GET', p)));
    check(got.every((r) => r.status === 404 && !/scrypt|"hash"|import /.test(r.text)), 'path traversal and other paths return 404 and nothing from disk');
    check((await call('OPTIONS', '/')).status === 405 && (await call('PATCH', '/api/records', { body: {} })).status === 405, 'other methods are refused');

    // logged out
    check((await call('POST', '/api/records', { headers: { Origin: ORIGIN }, body: { title: 'x' } })).status === 401, 'a write without a session is refused (401)');
    const anon = await call('GET', '/api/session');
    check(anon.status === 200 && anon.json.owner === false && anon.json.csrf === '', 'a visitor has no session and no CSRF token');

    // logging in
    const login = (headers, body = { password: WORD }) => call('POST', '/api/login', { headers: { 'X-Real-IP': fresh(), ...headers }, body });
    check((await login({})).status === 403, 'a login without an Origin header is refused');
    check((await login({ Origin: 'https://evil.test' })).status === 403, 'a login from another site is refused');
    check((await call('POST', '/api/login', { headers: { Origin: ORIGIN, 'X-Real-IP': fresh(), 'Content-Type': 'text/plain' }, body: JSON.stringify({ password: WORD }) })).status === 415,
      'a login sent as a plain form or text is refused (415)');
    const wrong = await login({ Origin: ORIGIN }, { password: 'not the word at all' });
    check(wrong.status === 401 && !wrong.headers['set-cookie'], 'a wrong word is refused and sets no cookie');
    const ok = await login({ Origin: ORIGIN });
    const setCookie = (ok.headers['set-cookie'] || [])[0] || '';
    check(ok.status === 200 && /^__Host-ca_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/.test(setCookie),
      'the right word sets a __Host- session cookie: HttpOnly, Secure, SameSite=Strict, Path=/, 12 hours');
    const cookie = cookieOf(ok), csrf = ok.json && ok.json.csrf;
    check(typeof csrf === 'string' && csrf.length === 43 && !setCookie.includes(csrf), 'the CSRF token comes back in the body, separate from the cookie');
    const me = await call('GET', '/api/session', { headers: { Cookie: cookie } });
    check(me.json.owner === true && me.json.csrf === csrf, 'the session is recognised');

    // writing
    const write = (method, p, body, extra = {}) => call(method, p, { headers: { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf, ...extra }, body });
    check((await call('POST', '/api/records', { headers: { Cookie: cookie, Origin: ORIGIN }, body: { title: 'x' } })).status === 403, 'a write without the CSRF token is refused');
    check((await write('POST', '/api/records', { title: 'x' }, { 'X-CSRF-Token': csrf.slice(0, -1) + (csrf.endsWith('A') ? 'B' : 'A') })).status === 403, 'a write with a wrong CSRF token is refused');
    check((await write('POST', '/api/records', { title: 'x' }, { Origin: 'https://evil.test' })).status === 403, 'a write from another site is refused, even with the token');
    check((await write('POST', '/api/records', { title: 'x' }, { Origin: undefined })).status === 403, 'a write without an Origin header is refused');
    check((await call('POST', '/api/records', { headers: { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf, 'Content-Type': 'text/plain' }, body: '{"title":"x"}' })).status === 415,
      'a write that is not JSON is refused');

    const evil = '</script><script>alert(1)</script><img src=x onerror=alert(2)>';
    const made = await write('POST', '/api/records', {
      title: evil + 'x'.repeat(300), domain: 'Wars & catastrophes', status: 'admin', date: '2020-13-45', note: 'line one\nline\u0000 two\u0007',
      source: 'A book', encounter: 'no-such-encounter', id: '../../etc', example: true, added: 1, extra: 'ignored',
    });
    const rec = made.json && made.json.archive.records.find((r) => r.id === made.json.id);
    check(made.status === 200 && rec && rec.title.length === 120 && !('status' in rec) && !('domain' in rec) && rec.date === '' && rec.encounter === '' &&
      rec.note === 'line one\nline two' && rec.example === false && rec.id !== '../../etc' && !('extra' in rec) && rec.added > 1,
      'a new record is cleaned: lengths capped, no state or domain, a bad date and an unknown encounter left empty, control characters stripped, id and flags set by the server');
    check((await write('POST', '/api/records', { title: '   ' })).status === 400, 'a record without a title is refused');
    check((await write('POST', '/api/records', { title: 'x', note: 'y'.repeat(70 * 1024) })).status === 413, 'a body over 64 KB is refused (413)');
    check((await call('POST', '/api/records', { headers: { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf }, body: '{"title":' })).status === 400, 'malformed JSON is refused');
    check((await write('PUT', '/api/records/nope', { title: 'x' })).status === 404 && (await write('PUT', '/api/records/..%2f..%2fx', { title: 'x' })).status === 404,
      'revising a missing or malformed id is refused');
    const revised = await write('PUT', '/api/records/' + rec.id, { title: 'Revised', date: '2026-01-02' });
    const rev = revised.json && revised.json.archive.records.find((r) => r.id === rec.id);
    check(revised.status === 200 && rev.title === 'Revised' && rev.date === '2026-01-02' && rev.added === rec.added, 'a record can be revised and keeps its id and accession time');
    await write('PUT', '/api/records/' + rec.id, { title: evil });
    const shown = await call('GET', '/');
    const data = shown.text.match(/<script type="application\/json" id="ca-data">([\s\S]*?)<\/script>/)[1];
    check(!data.includes('<') && !shown.text.includes('<script>alert(1)') && archiveIn(shown.text).records.some((r) => r.title === evil.slice(0, 120)),
      "stored markup is escaped in the page's data block and comes back intact as text");
    const del = await write('DELETE', '/api/records/' + rec.id);
    check(del.status === 200 && !del.json.archive.records.some((r) => r.id === rec.id), 'a record can be removed');
    // encounters, and their private sections
    const secret = 'Only for the keeper: ' + crypto.randomBytes(8).toString('hex');
    check((await call('POST', '/api/encounters', { headers: { Origin: ORIGIN }, body: { title: 'x' } })).status === 401, 'an encounter cannot be recorded without a session');
    const encMade = await write('POST', '/api/encounters', { title: 'Smoke encounter ' + evil, date: 'not a date', text: '{h1}What happened{/h1}', private: secret, id: '../x', extra: 1 });
    const enc = encMade.json && encMade.json.archive.encounters.find((e) => e.id === encMade.json.id);
    check(encMade.status === 200 && enc && enc.title.startsWith('Smoke encounter </script>') && enc.date === '' && enc.text === '{h1}What happened{/h1}' &&
      !('private' in enc) && !('extra' in enc) && /^e[\w-]{12}$/.test(enc.id), 'an encounter is cleaned, and the answer carries no private section');
    check((await write('POST', '/api/encounters', { title: ' ' })).status === 400 && (await write('POST', '/api/encounters', { title: 'x', text: 'y'.repeat(170 * 1024) })).status === 413,
      'an encounter without a title, or over 160 KB, is refused');
    const rawArchive = fs.readFileSync(path.join(s.dataDir, 'archive.json'), 'utf8');
    const stored = JSON.parse(rawArchive).encounters.find((e) => e.id === enc.id);
    check(!rawArchive.includes(secret) && stored.private && Buffer.from(stored.private.iv, 'base64').length === 12 && Buffer.from(stored.private.tag, 'base64').length === 16 &&
      Buffer.from(stored.private.data, 'base64').length === Buffer.byteLength(secret), 'the private section is stored encrypted (AES-256-GCM): archive.json holds no trace of its text');
    const authNow = fs.readFileSync(path.join(s.dataDir, 'auth.json'), 'utf8'), wrapped = JSON.parse(authNow).key;
    check(wrapped && Buffer.from(wrapped.salt, 'base64').length === 16 && Buffer.from(wrapped.data, 'base64').length === 32 && !authNow.includes(secret),
      'the key that encrypts it is stored only wrapped, by a key derived from the word');
    const seenPage = await call('GET', '/'), seenApi = await call('GET', '/api/archive');
    check(!seenPage.text.includes(secret) && !seenPage.text.includes(stored.private.data) && !seenApi.text.includes(stored.private.data) &&
      !archiveIn(seenPage.text).encounters.some((e) => 'private' in e), 'visitors get neither the private section nor its ciphertext, from the page or the API');
    check((await call('GET', '/api/private')).status === 401 && (await call('GET', '/api/private', { headers: { Cookie: cookie } })).status === 403,
      'reading the private sections needs the session and its CSRF token');
    const readPrivate = (c, t) => call('GET', '/api/private', { headers: { Cookie: c, 'X-CSRF-Token': t } }).then((r) => r.json && r.json.encounters);
    const priv = await call('GET', '/api/private', { headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
    check(priv.status === 200 && priv.json.encounters[enc.id] === secret && priv.headers['cache-control'] === 'no-store', 'the keeper reads it back, never cached');
    await write('PUT', '/api/encounters/' + enc.id, { title: 'Smoke encounter', text: 'Revised.' });
    check((await readPrivate(cookie, csrf))[enc.id] === secret, 'revising an encounter without sending its private section keeps it');
    const linked = await write('POST', '/api/records', { title: 'Learned there', encounter: enc.id });
    check(linked.json.archive.records.find((r) => r.id === linked.json.id).encounter === enc.id, 'a record can name an encounter as its source');
    const spare = await write('POST', '/api/encounters', { title: 'Spare', private: 'gone soon' });
    await write('PUT', '/api/encounters/' + spare.json.id, { title: 'Spare', private: '' });
    check(!(spare.json.id in (await readPrivate(cookie, csrf))), 'an empty private section removes it');
    const spareRec = await write('POST', '/api/records', { title: 'From the spare', encounter: spare.json.id });
    const goneEnc = await write('DELETE', '/api/encounters/' + spare.json.id);
    check(goneEnc.status === 200 && !goneEnc.json.archive.encounters.some((e) => e.id === spare.json.id) &&
      goneEnc.json.archive.records.find((r) => r.id === spareRec.json.id).encounter === '', 'removing an encounter unlinks the records that named it');

    const backups = fs.readdirSync(path.join(s.dataDir, 'backups')).filter((f) => f.endsWith('.json'));
    const archiveMode = fs.statSync(path.join(s.dataDir, 'archive.json')).mode & 0o777;
    check(backups.length >= 3 && archiveMode === 0o600, `each change keeps a backup of the previous archive (${backups.length} so far), and archive.json is 0600`);

    // the About page
    const about = await write('PUT', '/api/about', {
      name: 'Smoke ' + evil, epithet: 'e'.repeat(400), portrait: 'nope', title: 't'.repeat(99), race: 'Dracthyr', eyeColor: 'red; background: url(x)',
      currently: 'line one\nline\u0000 two', admin: true,
      facts: [{ label: 'Motto', value: 'v' }, { label: ' ', value: '' }, ...Array.from({ length: 30 }, (_, i) => ({ label: 'L' + i, value: 'v' }))],
      traits: [{ left: 'Chaotic', right: 'Lawful', value: 99 }, { left: 'A', right: 'B', value: -4 }, { left: 'C', right: 'D', value: 'x' }, { left: 'E', right: 'F', value: 7.6 }, { left: '', right: '' }],
      glances: Array.from({ length: 8 }, (_, i) => ({ title: 'Glance ' + i, text: 't' })),
      sections: [{ heading: 'History', body: '{h1:c}Title{/h1}\n' + 'b'.repeat(45000), color: 'red; background: url(x)' }, 'junk', null, { heading: '', body: '' }],
    });
    const ab = about.json && about.json.archive;
    check(about.status === 200 && ab.profile.name === ('Smoke ' + evil).slice(0, 60) && ab.profile.epithet.length === 280 && !('portrait' in ab.about) &&
      ab.about.facts.length === 24 && ab.about.facts[0].label === 'Motto' && ab.about.sections.length === 1 && ab.about.sections[0].body.length === 40000 &&
      ab.about.sections[0].body.startsWith('{h1:c}Title{/h1}') && ab.about.sections[0].color === '' && ab.about.title.length === 60 && ab.about.race === 'Dracthyr' && ab.about.eyeColor === '' &&
      ab.about.currently === 'line one\nline two' && ab.about.traits.map((t) => t.value).join() === '20,0,10,8' && ab.about.glances.length === 5 && !('admin' in ab.about),
      'the About page is cleaned: lengths and counts capped, empty rows dropped, traits kept within 0–20, a bad colour and a portrait dropped, TRP markup kept as text');
    const aboutPage = await call('GET', '/');
    check(!aboutPage.text.match(/<script type="application\/json" id="ca-data">([\s\S]*?)<\/script>/)[1].includes('<') && archiveIn(aboutPage.text).profile.name.startsWith('Smoke </script>'),
      "markup in the About page is escaped in the page's data block");
    check((await write('PUT', '/api/about', { name: 'Smoke', eyeColor: '#A1B2C3' })).json.archive.about.eyeColor === '#a1b2c3', 'a valid eye colour is kept');
    const tooLong = await write('PUT', '/api/about', { name: 'Smoke', sections: Array.from({ length: 8 }, () => ({ heading: 'x', body: 'z'.repeat(39000) })) });
    check(tooLong.status === 413 && /too long/.test(tooLong.json.error), 'an About page over 256 KB is refused, and says so');
    check((await write('PUT', '/api/about', [1, 2])).status === 400 && (await write('PUT', '/api/about', 'null')).status === 400, 'a JSON body that is not an object is refused');

    // uploading images
    const upload = (body, type, extra = {}) => call('POST', '/api/uploads', { headers: { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf, 'Content-Type': type, ...extra }, body });
    const pngA = makePng(40, 30), pngB = makePng(41, 30), pngC = makePng(42, 30), pngD = makePng(43, 30);
    check((await call('POST', '/api/uploads', { headers: { Origin: ORIGIN, 'Content-Type': 'image/png' }, body: pngA })).status === 401 &&
      (await upload(pngA, 'image/png', { 'X-CSRF-Token': undefined })).status === 403 && (await upload(pngA, 'image/png', { Origin: 'https://evil.test' })).status === 403,
      'an upload needs the session, the CSRF token and the right Origin');
    check((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')).status === 415 &&
      (await upload(Buffer.from('<html><script>alert(1)</script></html>'), 'text/html')).status === 415 &&
      (await upload(Buffer.from('{"title":"x"}'), 'application/json')).status === 415, 'SVG, HTML and JSON are refused as images');
    check((await upload(pngA, 'image/jpeg')).status === 415 && (await upload(Buffer.concat([Buffer.from('GIF89a'), pngA]), 'image/png')).status === 415,
      'an image whose bytes are not the type it claims is refused');
    // declares 9 MB but sends 16 bytes, so the connection must not be reused
    check((await upload(Buffer.alloc(16), 'image/png', { 'Content-Length': String(9 * 1024 * 1024), Connection: 'close' })).status === 413, 'an image over 8 MB is refused (413)');
    const huge = makePng(1, 1);
    huge.writeUInt32BE(20000, 16); // claims 20000 pixels wide
    check((await upload(huge, 'image/png')).status === 400, 'an image over 10000 pixels on a side is refused');
    const upA = await upload(pngA, 'image/png');
    check(upA.status === 200 && /^[0-9a-f]{32}\.png$/.test(upA.json.file) && upA.json.width === 40 && upA.json.height === 30 &&
      fs.readFileSync(path.join(s.dataDir, 'art', upA.json.file)).equals(pngA), 'a PNG is stored under its content hash, with its size read from the file');
    check((await upload(pngA, 'image/png')).json.file === upA.json.file, 'the same image uploaded twice is stored once');
    const upJ = await upload(JPEG_HEAD, 'image/jpeg');
    check(upJ.status === 200 && /\.jpg$/.test(upJ.json.file) && upJ.json.width === 48 && upJ.json.height === 32, "a JPEG's size is read from its frame header");
    const upB = await upload(pngB, 'image/png'), upC = await upload(pngC, 'image/png'), upD = await upload(pngD, 'image/png');
    check((await call('GET', '/art/' + upA.json.file)).status === 404, 'an upload no plate uses is not served');

    // plates: each is one or more images, the first its main image, and any of them can be flagged mature
    const img = (up, extra = {}) => ({ file: up.json.file, thumb: up.json.file, ...extra });
    check((await write('POST', '/api/art', { versions: [{ file: 'f'.repeat(32) + '.png', thumb: upA.json.file }] })).status === 400 &&
      (await write('POST', '/api/art', { versions: [{ file: '../auth.json', thumb: upA.json.file }] })).status === 400 &&
      (await write('POST', '/api/art', { title: 'x' })).status === 400 && (await write('POST', '/api/art', { title: 'x', versions: [] })).status === 400,
      'a plate needs an image, and may use only uploaded ones');
    const plateA = await write('POST', '/api/art', {
      versions: [img(upA, { width: 9999, label: 'l'.repeat(100), mature: 'yes' })], title: evil, artist: 'An artist', link: 'javascript:alert(1)', date: 'soon', note: 'n'.repeat(2000),
    });
    const pa = plateA.json && plateA.json.archive.art.find((a) => a.id === plateA.json.id), va = pa && pa.versions[0];
    check(plateA.status === 200 && pa.title === evil.slice(0, 120) && pa.link === '' && va.width === 40 && va.height === 30 && va.label.length === 60 && va.mature === false &&
      /^v[\w-]+$/.test(va.id) && /^\d{4}-\d{2}-\d{2}$/.test(pa.date) && pa.note.length === 1000,
      'a new plate is cleaned: a script link dropped, sizes taken from the image, lengths capped, and only true flags an image mature');
    const plateB = await write('POST', '/api/art', { versions: [{ file: upB.json.file, thumb: upJ.json.file, mature: true }, img(upA, { label: 'Alternate' })], title: 'B', link: 'artstation.com/someone' });
    const pb = plateB.json && plateB.json.archive.art.find((a) => a.id === plateB.json.id);
    check(plateB.status === 200 && pb.link === 'https://artstation.com/someone' && plateB.json.archive.art[0].id === pb.id && pb.versions.length === 2 &&
      pb.versions[0].mature === true && pb.versions[1].mature === false && pb.versions[1].label === 'Alternate',
      'a plate keeps its images in order with their own flags, a bare address becomes https, and the newest plate comes first');
    const served = await call('GET', '/art/' + upA.json.file);
    check(served.status === 200 && served.headers['content-type'] === 'image/png' && /immutable/.test(served.headers['cache-control']) && /s-maxage=86400/.test(served.headers['cache-control']) &&
      served.headers['x-content-type-options'] === 'nosniff' && /default-src 'none'/.test(served.headers['content-security-policy'] || '') && Number(served.headers['content-length']) === pngA.length,
      "a plate's image is served with its type, nosniff, the CSP and a long cache lifetime");
    check((await call('HEAD', '/art/' + upJ.json.file)).headers['content-type'] === 'image/jpeg' && (await call('GET', '/art/' + upA.json.file.replace('.png', '.webp'))).status === 404 &&
      (await call('GET', '/art/..%2fauth.json')).status === 404, 'only the exact names in use are served');
    const revisedPlate = await write('PUT', '/api/art/' + pa.id, { title: 'Revised plate', artist: 'An artist' });
    const rp = revisedPlate.json && revisedPlate.json.archive.art.find((a) => a.id === pa.id);
    check(revisedPlate.status === 200 && rp.title === 'Revised plate' && rp.versions.length === 1 && rp.versions[0].id === va.id && rp.versions[0].file === upA.json.file && rp.added === pa.added,
      'a plate can be revised and keeps its images');
    const reshaped = await write('PUT', '/api/art/' + pb.id, { title: 'B', versions: [{ id: pb.versions[1].id, label: 'Now first' }, { id: pb.versions[0].id, mature: true }, img(upC, { mature: true })] });
    const rb = reshaped.json && reshaped.json.archive.art.find((a) => a.id === pb.id);
    check(reshaped.status === 200 && rb.versions.map((v) => v.file).join() === [upA.json.file, upB.json.file, upC.json.file].join() && rb.versions[0].id === pb.versions[1].id &&
      rb.versions[0].label === 'Now first' && rb.versions[1].thumb === upJ.json.file && rb.versions[1].mature && rb.versions[2].mature && /^v/.test(rb.versions[2].id),
      "a plate's images can be reordered, relabelled, reflagged and added to, each keeping its own files");
    check((await write('PUT', '/api/art/' + pb.id, { versions: [{ id: 'not-one-of-its-images' }] })).status === 400 && (await write('PUT', '/api/art/' + pb.id, { versions: [] })).status === 400,
      "an image that is neither the plate's own nor uploaded is refused, and a plate cannot be left without images");
    check((await write('POST', '/api/art/order', { ids: [pa.id] })).status === 409 && (await write('POST', '/api/art/order', { ids: [pa.id, pa.id] })).status === 409,
      'a new order must name every plate once');
    const ordered = await write('POST', '/api/art/order', { ids: [pa.id, pb.id] });
    check(ordered.status === 200 && ordered.json.archive.art.map((a) => a.id).join() === [pa.id, pb.id].join(), 'the plates can be put in a new order');

    // his forms: each holds plates ("art pieces" on the page)
    check((await write('POST', '/api/galleries', { name: '  ' })).status === 400, 'a form needs a name');
    const formA = await write('POST', '/api/galleries', { name: 'Smoke (Dracthyr) ' + 'n'.repeat(100), id: 'gnope', example: true });
    const ga = formA.json && formA.json.archive.galleries.find((g) => g.id === formA.json.id);
    check(formA.status === 200 && ga && ga.name.length === 80 && /^g[\w-]{12}$/.test(ga.id) && ga.example === false, 'a form is cleaned: its name capped, its id and flags set by the server');
    const gb = (await write('POST', '/api/galleries', { name: 'Smoke (visage)' })).json.id;
    check((await write('POST', '/api/art', { gallery: 'gnot-a-form', versions: [img(upA)] })).status === 400, 'a plate cannot name a form that does not exist');
    const inForm = await write('POST', '/api/art', { gallery: ga.id, title: 'In a form', versions: [img(upA)] });
    const pf = inForm.json && inForm.json.archive.art.find((a) => a.id === inForm.json.id);
    check(inForm.status === 200 && pf.gallery === ga.id && ordered.json.archive.art.every((a) => a.gallery === ''), 'a plate belongs to the form it names, or to none');
    const keptForm = await write('PUT', '/api/art/' + pf.id, { title: 'Still in it' });
    const movedForm = await write('PUT', '/api/art/' + pf.id, { title: 'Moved', gallery: gb });
    check(keptForm.json.archive.art.find((a) => a.id === pf.id).gallery === ga.id && movedForm.json.archive.art.find((a) => a.id === pf.id).gallery === gb,
      'revising a plate keeps its form unless another is named, which moves it there');
    check((await write('PUT', '/api/galleries/' + gb, { name: 'Renamed' })).json.archive.galleries.find((g) => g.id === gb).name === 'Renamed', 'a form can be renamed');
    check((await write('POST', '/api/galleries/order', { ids: [gb] })).status === 409 &&
      (await write('POST', '/api/galleries/order', { ids: [gb, ga.id] })).json.archive.galleries.map((g) => g.id).join() === [gb, ga.id].join(), 'the forms can be put in a new order, naming each once');
    check((await write('DELETE', '/api/galleries/' + gb)).status === 409, 'a form that holds plates cannot be removed');
    await write('DELETE', '/api/art/' + pf.id);
    const goneForm = await write('DELETE', '/api/galleries/' + gb);
    check(goneForm.status === 200 && !goneForm.json.archive.galleries.some((g) => g.id === gb), 'an empty form can be removed');

    // GIFs and videos
    const gifFile = fs.readFileSync(path.join(FIXTURES, 'smoke.gif')), webm = fs.readFileSync(path.join(FIXTURES, 'smoke.webm'));
    const gct = gifFile[10] & 0x80 ? 3 * 2 ** ((gifFile[10] & 7) + 1) : 0;
    const gifNote = Buffer.concat([Buffer.from([0x21, 0xfe, 22]), Buffer.from('made at a secret place', 'latin1'), Buffer.from([0])]);
    const gifXmp = Buffer.concat([Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('XMP DataXMP', 'latin1'), Buffer.from([10]), Buffer.from('GPS secret', 'latin1'), Buffer.from([0])]);
    const gifIn = Buffer.concat([gifFile.subarray(0, 13 + gct), gifNote, gifXmp, gifFile.subarray(13 + gct)]);
    const upG = await upload(gifIn, 'image/gif');
    const gifKept = upG.status === 200 && fs.readFileSync(path.join(s.dataDir, 'art', upG.json.file));
    check(upG.status === 200 && /^[0-9a-f]{32}\.gif$/.test(upG.json.file) && upG.json.width === 48 && upG.json.height === 32 && !gifKept.includes('secret') && gifKept.equals(gifFile),
      'a GIF keeps its frames and its size, and loses its comments and XMP');
    check((await upload(gifIn.subarray(0, gifIn.length - 40), 'image/gif')).status === 415, 'a GIF cut off in the middle is refused');
    const mbox = (type, ...parts) => {
      const body = Buffer.concat(parts.map((x) => (typeof x === 'string' ? Buffer.from(x, 'latin1') : x))), len = Buffer.alloc(4);
      len.writeUInt32BE(8 + body.length);
      return Buffer.concat([len, Buffer.from(type, 'latin1'), body]);
    };
    const mdat = mbox('mdat', Buffer.alloc(64, 7)), tkhd = mbox('tkhd', Buffer.alloc(84, 1));
    const mp4 = (brand) => Buffer.concat([mbox('ftyp', brand, '\0\0\0\0', 'isommp41'),
      mbox('moov', mbox('mvhd', Buffer.alloc(100)), mbox('trak', tkhd, mbox('udta', mbox('name', 'secret track'))),
        mbox('udta', mbox('\xa9xyz', '+48.8566+002.3522/ secret')), mbox('meta', Buffer.alloc(4), mbox('ilst', 'secret tag'))),
      mbox('uuid', Buffer.alloc(16), 'secret xmp'), mdat]);
    const mp4In = mp4('isom'), upM = await upload(mp4In, 'video/mp4');
    const mp4Kept = upM.status === 200 && fs.readFileSync(path.join(s.dataDir, 'art', upM.json.file));
    check(upM.status === 200 && /\.mp4$/.test(upM.json.file) && mp4Kept.length === mp4In.length && !mp4Kept.includes('secret') && !mp4Kept.includes('+48.85') &&
      mp4Kept.includes(mdat) && mp4Kept.includes(tkhd) && mp4Kept.indexOf(mdat) === mp4In.indexOf(mdat),
      'an MP4 keeps its picture data where it was, and loses its metadata (where it was made, its tags, its XMP)');
    check((await upload(mp4('qt  '), 'video/mp4')).status === 415 && (await upload(Buffer.from('not a video, not even close'), 'video/mp4')).status === 415 &&
      (await upload(webm, 'video/mp4')).status === 415, 'a QuickTime file, or anything else that is not an MP4, is refused as one');
    const upW = await upload(webm, 'video/webm');
    check(upW.status === 200 && /\.webm$/.test(upW.json.file) && fs.readFileSync(path.join(s.dataDir, 'art', upW.json.file)).equals(webm) &&
      (await upload(mp4In, 'video/webm')).status === 415, 'a WebM video is taken as it is, and nothing else as one');
    check((await upload(Buffer.alloc(16), 'video/mp4', { 'Content-Length': String(91 * 1024 * 1024), Connection: 'close' })).status === 413 &&
      (await upload(Buffer.alloc(16), 'image/gif', { 'Content-Length': String(41 * 1024 * 1024), Connection: 'close' })).status === 413, 'a video over 90 MB and a GIF over 40 MB are refused (413)');
    check(!fs.readdirSync(path.join(s.dataDir, 'art')).some((f) => f.endsWith('.tmp')), 'no temporary upload is left behind');
    check((await write('POST', '/api/art', { versions: [{ file: upW.json.file, thumb: upG.json.file }] })).status === 400 &&
      (await write('POST', '/api/art', { versions: [{ file: upW.json.file, thumb: upM.json.file }] })).status === 400, "a video's poster and a GIF's still must be still images");
    const moving = await write('POST', '/api/art', { gallery: ga.id, title: 'Moving', versions: [
      { file: upW.json.file, thumb: upJ.json.file, width: 96, height: 64, loop: true, mature: true }, { file: upG.json.file, thumb: upA.json.file, width: 9999, loop: true }] });
    const pv = moving.json && moving.json.archive.art.find((a) => a.id === moving.json.id);
    check(moving.status === 200 && pv.versions[0].width === 96 && pv.versions[0].height === 64 && pv.versions[0].loop === true && pv.versions[0].mature === true &&
      pv.versions[1].width === 48 && pv.versions[1].loop === false, "a video's size comes from the keeper's browser, a GIF's from its file, and only a video can loop");
    const ranged = await call('GET', '/art/' + upW.json.file, { headers: { Range: 'bytes=10-19' } });
    check(ranged.status === 206 && ranged.headers['content-range'] === `bytes 10-19/${webm.length}` && ranged.headers['content-length'] === '10' &&
      ranged.headers['accept-ranges'] === 'bytes' && ranged.headers['content-type'] === 'video/webm', 'a video is served in byte ranges, as players ask for them');
    const tail = await call('GET', '/art/' + upW.json.file, { headers: { Range: 'bytes=-5' } });
    const beyond = await call('GET', '/art/' + upW.json.file, { headers: { Range: `bytes=${webm.length}-` } });
    check(tail.status === 206 && tail.headers['content-range'] === `bytes ${webm.length - 5}-${webm.length - 1}/${webm.length}` &&
      beyond.status === 416 && beyond.headers['content-range'] === `bytes */${webm.length}`, 'the last bytes can be asked for, and a range past the end is refused (416)');
    check(/media-src 'self' blob:/.test(csp), "the CSP lets the art's videos play, and nothing else");
    await write('DELETE', '/api/art/' + pv.id);
    const removedPlate = await write('DELETE', '/api/art/' + pb.id);
    check(removedPlate.status === 200 && !removedPlate.json.archive.art.some((a) => a.id === pb.id) &&
      (await call('GET', '/art/' + upB.json.file)).status === 404 && (await call('GET', '/art/' + upC.json.file)).status === 404 && (await call('GET', '/art/' + upA.json.file)).status === 200,
      'removing a plate stops serving the images only it used');
    const old = new Date(Date.now() - 2 * 24 * 3600e3);
    fs.utimesSync(path.join(s.dataDir, 'art', upD.json.file), old, old);
    fs.utimesSync(path.join(s.dataDir, 'art', upB.json.file), old, old);
    await write('DELETE', '/api/art/' + pa.id); // removing a plate sweeps
    check(!fs.existsSync(path.join(s.dataDir, 'art', upD.json.file)) && fs.existsSync(path.join(s.dataDir, 'art', upB.json.file)) && fs.existsSync(path.join(s.dataDir, 'art', upA.json.file)),
      'the sweep removes an old upload no plate used, and keeps images a backup still uses');

    // changing the word signs every other session out
    const other = cookieOf(await login({ Origin: ORIGIN }));
    check((await write('POST', '/api/password', { current: 'not the word', next: NEW_WORD })).status === 401, 'changing the word needs the current word');
    check((await write('POST', '/api/password', { current: WORD, next: 'short' })).status === 400, 'the new word must be at least 12 characters');
    const changed = await write('POST', '/api/password', { current: WORD, next: NEW_WORD });
    const cookie2 = cookieOf(changed);
    check(changed.status === 200 && cookie2 && cookie2 !== cookie, 'the word can be changed, and the change starts a new session');
    const [old1, old2, now] = await Promise.all([cookie, other, cookie2].map((c) => call('GET', '/api/session', { headers: { Cookie: c } })));
    check(old1.json.owner === false && old2.json.owner === false && now.json.owner === true, 'every older session is signed out');
    check((await login({ Origin: ORIGIN })).status === 401 && (await login({ Origin: ORIGIN }, { password: NEW_WORD })).status === 200, 'only the new word unlocks');
    check((await readPrivate(cookie2, changed.json.csrf))[enc.id] === secret, 'the private sections stay readable under the new word');

    // logging out
    const csrf2 = changed.json.csrf;
    const out = await call('POST', '/api/logout', { headers: { Cookie: cookie2, Origin: ORIGIN, 'X-CSRF-Token': csrf2 } });
    check(out.status === 200 && /Max-Age=0/.test((out.headers['set-cookie'] || [])[0]) && (await call('GET', '/api/session', { headers: { Cookie: cookie2 } })).json.owner === false,
      'sealing it again ends the session on the server and clears the cookie');

    // throttling (last: it locks this client address out)
    const attacker = '203.0.113.9';
    const tries = [];
    for (let i = 0; i < 4; i++) tries.push(await call('POST', '/api/login', { headers: { Origin: ORIGIN, 'X-Real-IP': attacker }, body: { password: 'guess ' + i } }));
    check(tries[0].status === 401 && tries[1].status === 401 && tries[2].status === 401 && tries[2].headers['retry-after'] === '2' &&
      tries[3].status === 429 && Number(tries[3].headers['retry-after']) > 0, 'after three wrong words, the client must wait, and waits grow (429 with Retry-After)');
    const locked = await call('POST', '/api/login', { headers: { Origin: ORIGIN, 'X-Real-IP': attacker }, body: { password: NEW_WORD } });
    check(locked.status === 429, 'while locked out, even the right word is not checked');
    const bystander = await call('POST', '/api/login', { headers: { Origin: ORIGIN, 'X-Real-IP': '203.0.113.10' }, body: { password: NEW_WORD } });
    check(bystander.status === 200, "another client address (from Caddy's X-Real-IP) is not affected");
  } finally {
    s.stop();
  }
}

// ---------- 1c. the private sections across restarts, a new word and a forgotten one ----------
async function privateChecks() {
  const env = { COOKIE_SECURE: 'false' };
  const login = async (s, word) => {
    const r = await request(s.port, 'POST', '/api/login', { headers: { Origin: `http://127.0.0.1:${s.port}` }, body: { password: word } });
    const k = { cookie: cookieOf(r), csrf: r.json && r.json.csrf, ok: r.status === 200 };
    k.write = (method, p, body) => request(s.port, method, p, { headers: { Cookie: k.cookie, Origin: `http://127.0.0.1:${s.port}`, 'X-CSRF-Token': k.csrf }, body });
    k.read = () => request(s.port, 'GET', '/api/private', { headers: { Cookie: k.cookie, 'X-CSRF-Token': k.csrf } }).then((r) => (r.json && r.json.encounters) || {});
    return k;
  };
  const secret = 'Only for the keeper: ' + crypto.randomBytes(8).toString('hex');
  let s = await startServer('private', env), a, b;
  const dir = s.dataDir;
  try {
    const k = await login(s, WORD);
    a = (await k.write('POST', '/api/encounters', { title: 'A', private: secret })).json.id;
    b = (await k.write('POST', '/api/encounters', { title: 'B', private: 'what B keeps' })).json.id;
  } finally { s.stop(); }
  const files = ['archive.json', 'auth.json', ...fs.readdirSync(path.join(dir, 'backups')).map((f) => path.join('backups', f))];
  check(files.every((f) => !fs.readFileSync(path.join(dir, f), 'utf8').includes(secret)), 'no file in the data directory, backups included, holds a private section as text');
  // A's ciphertext copied onto B: each is bound to its own encounter, so there it does not decrypt
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'archive.json'), 'utf8'));
  saved.encounters.find((e) => e.id === b).private = saved.encounters.find((e) => e.id === a).private;
  fs.writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(saved));
  s = await startServer('private', env, null, true);
  try {
    const seen = await (await login(s, WORD)).read();
    check(seen[a] === secret, 'after a restart, the word unlocks the private sections again');
    check(seen[b] === null, 'a private section copied onto another encounter cannot be decrypted there');
  } finally { s.stop(); }
  const NEXT = 'a third long smoke-test passphrase', LOST = 'a fourth long smoke-test passphrase';
  check((await run(['set-password'], { DATA_DIR: dir }, `${NEXT}\n${NEXT}\n`)).code !== 0 &&
    (await run(['set-password'], { DATA_DIR: dir }, `${NEXT}\n${NEXT}\nnot the current word\n`)).code !== 0, 'set-password will not let go of the private key without the current word');
  check((await run(['set-password'], { DATA_DIR: dir }, `${NEXT}\n${NEXT}\n${WORD}\n`)).code === 0, 'with the current word, set-password carries the private key over');
  s = await startServer('private', env, null, true);
  try {
    const k = await login(s, NEXT);
    check(k.ok && (await k.read())[a] === secret, 'the new word reads the same private sections');
  } finally { s.stop(); }
  check((await run(['set-password', '--forget-private'], { DATA_DIR: dir }, `${LOST}\n${LOST}\n`)).code === 0, 'set-password --forget-private replaces a lost word');
  s = await startServer('private', env, null, true);
  try {
    const k = await login(s, LOST);
    check((await k.read())[a] === null, 'after that, the private sections written before can no longer be read');
    await k.write('PUT', '/api/encounters/' + a, { title: 'A', private: 'written anew' });
    check((await k.read())[a] === 'written anew', 'and new ones can be written');
  } finally { s.stop(); }
}

// ---------- 1b. an archive saved before plates had several images ----------
async function legacyChecks() {
  const png = makePng(20, 10);
  const name = crypto.createHash('sha256').update(png).digest('hex').slice(0, 32) + '.png';
  const s = await startServer('legacy', { COOKIE_SECURE: 'false' }, (dir) => {
    fs.mkdirSync(path.join(dir, 'art'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'art', name), png);
    fs.writeFileSync(path.join(dir, 'archive.json'), JSON.stringify({
      profile: { name: 'Old' }, records: [], about: { portrait: 'aold', facts: [], sections: [] }, // portraits are no longer kept
      art: [{ id: 'aold', file: name, thumb: name, width: 20, height: 10, title: 'Old plate', date: '2026-01-01', added: 1 }],
    }));
  });
  try {
    const a = archiveIn((await request(s.port, 'GET', '/')).text);
    const v = a.art[0] && a.art[0].versions && a.art[0].versions[0];
    check(v && v.file === name && v.width === 20 && v.mature === false && v.id === 'v' + name.slice(0, 12) && !('portrait' in a.about) &&
      (await request(s.port, 'GET', '/art/' + name)).status === 200, 'a plate saved with one image becomes a plate of one image and is still served; an old portrait is dropped');
  } finally {
    s.stop();
  }
}

// The construct by keyboard (which always wakes it), then a chapter from the hub
async function enter(page, book) {
  await page.waitForSelector('.core.is-3d', { timeout: 30000 });
  await page.focus('#construct');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#hub:not([hidden])', { timeout: 5000 });
  await page.click(`.hub-opt[data-book="${book}"]`);
  await page.waitForSelector('#archive[open]', { timeout: 5000 });
}

// ---------- 2. the page in Chromium, under the server's CSP ----------
async function browserChecks() {
  const s = await startServer('browser', { COOKIE_SECURE: 'false' });
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP blocked ${e.blockedURI || 'inline'} (${e.violatedDirective})`));
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      // the expected 401 when a wrong word is tried shows up as a failed request
      if ((m.type() === 'error' || m.type() === 'warning') && !/status of 401/.test(m.text())) errors.push(m.text());
    });
    await page.goto(s.url);
    check(await page.waitForSelector('.core.is-3d', { timeout: 30000 }).then(() => true, () => false), '3D model replaces the cutout under the CSP');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, 'landing.png') });

    const box = await (await page.$('#construct')).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.click(cx, cy - box.height * .3); // the frame between the horns, above the gem
    await page.waitForTimeout(2500);
    check(!(await page.$('#archive[open]')), 'a click on the construct away from the gem does nothing');
    // Walk down the centre line until the pointer is over the gem, then click it. The construct keeps turning
    // toward the pointer, and software rendering is slow, so settle first and try the walk up to three times.
    let gem = null, opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      gem = null;
      for (let dy = 0; dy <= box.height * .5 && !gem; dy += 12) {
        await page.mouse.move(cx, cy + dy);
        await page.waitForTimeout(500);
        if (await page.$('#stage.on-gem')) gem = [cx, cy + dy];
      }
      if (!gem) continue;
      await page.waitForTimeout(1500);
      await page.mouse.move(gem[0], gem[1] + 1);
      await page.mouse.click(gem[0], gem[1]);
      opened = await page.waitForSelector('#hub:not([hidden])', { timeout: 4000 }).then(() => true, () => false);
      if (!opened) await page.mouse.move(cx - box.width, cy);
    }
    check(!!gem, 'pointing at the gem shows the hand cursor');
    check(opened && !(await page.$('#archive[open]')) && (await page.$$eval('.hub-opt', (n) => n.map((x) => x.textContent.trim()).join('|'))) === 'About|Art|Character Knowledge|Encounters',
      'clicking the gem reveals the four choices, About, Art, Character Knowledge and Encounters, with no other text');
    if (!opened) throw new Error('the hub did not appear');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, 'hub.png') });
    await page.click('.hub-opt[data-book="knowledge"]');
    check(await page.waitForSelector('#archive[open] #records', { timeout: 4000 }).then(() => true, () => false) &&
      await page.evaluate(() => location.hash === '#knowledge'), 'Knowledge opens the tome at the index, and the address names the chapter');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, 'archive.png') });
    check(await page.$('#btn-inscribe[hidden]') !== null, 'a visitor sees no editing tools');
    await page.click('#btn-close');
    check(await page.waitForFunction(() => !document.getElementById('archive').open && document.getElementById('hub').hidden && !document.getElementById('stage').classList.contains('has-hub'),
      null, { timeout: 5000 }).then(() => true, () => false), 'closing the tome takes the choices away, and the construct sinks back until its gem is woken again');
    await enter(page, 'knowledge');

    // the seal
    await page.click('#clasp');
    await page.fill('#seal-word', 'not the word at all');
    await page.click('#seal-go');
    await page.waitForSelector('#seal-error:not([hidden])', { timeout: 15000 });
    check((await page.textContent('#seal-error')).includes('does not yield') && await page.$('#btn-inscribe[hidden]') !== null, 'a wrong word is refused and the tools stay hidden');
    check(await page.evaluate(() => document.cookie === ''), 'the page script cannot see any session cookie');
    await page.fill('#seal-word', WORD);
    await page.click('#seal-go');
    check(await page.waitForSelector('#btn-inscribe:not([hidden])', { timeout: 15000 }).then(() => true, () => false), 'the right word shows the editing tools');
    check(await page.evaluate(() => document.cookie === ''), 'the session cookie is HttpOnly');

    // records
    const xss = '<img src=x onerror="window.__xss=1">';
    await page.click('#btn-inscribe');
    await page.fill('#f-title', 'Smoke record');
    await page.fill('#f-note', 'Learned in the smoke test. ' + xss);
    await page.click('#f-submit');
    await page.waitForSelector('#view-detail:not([hidden])', { timeout: 10000 });
    check((await page.textContent('#det-title')) === 'Smoke record' && (await page.textContent('#det-note')).includes(xss) &&
      await page.evaluate(() => !window.__xss && !document.querySelector('#archive img')), 'an inscribed record is shown, and markup in it stays text');
    await page.screenshot({ path: path.join(OUT, 'record.png') });

    await page.goto(s.url); // without the address of the record
    await enter(page, 'knowledge');
    check(await page.waitForSelector('#btn-inscribe:not([hidden])', { timeout: 5000 }).then(() => true, () => false), 'after a reload the keeper is still unsealed');
    check(await page.$$eval('#records .entry-title', (n) => n.some((x) => x.textContent === 'Smoke record')), 'the record is in the list after a reload');
    await page.click('#records .entry');
    await page.click('#det-edit');
    await page.fill('#f-title', 'Smoke record, revised');
    await page.click('#f-submit');
    await page.waitForFunction(() => document.getElementById('det-title').textContent === 'Smoke record, revised', null, { timeout: 10000 }).catch(() => {});
    check((await page.textContent('#det-title')) === 'Smoke record, revised', 'a record can be revised');
    await page.click('#det-delete');
    await page.click('#det-delete'); // confirm
    await page.waitForSelector('#records', { timeout: 10000 });
    check(!(await page.$$eval('#records .entry-title', (n) => n.some((x) => x.textContent.startsWith('Smoke record')))), 'a record can be removed');

    // an encounter with a private section, and a record that learned from it
    const secret = 'Only for the keeper: ' + Date.now();
    await page.click('.tab[data-book="encounters"]');
    await page.click('#btn-add-encounter');
    await page.fill('#ef-title', 'An encounter with a druid');
    await page.fill('#ef-text', '{h2:c}By the pools{/h2}\nShe spoke of the Dream. ' + xss);
    await page.fill('#ef-private', secret);
    await page.click('#ef-submit');
    await page.waitForSelector('#view-encounter:not([hidden])', { timeout: 10000 });
    await page.waitForSelector('#enc-private:not([hidden])', { timeout: 10000 }).catch(() => {});
    check((await page.textContent('#enc-title')) === 'An encounter with a druid' && (await page.textContent('#enc-text h6')) === 'By the pools' &&
      (await page.textContent('#enc-private-text')).includes(secret) && await page.evaluate(() => !window.__xss && !document.querySelector('#archive img')),
      'an encounter can be recorded; its text takes TRP markup, HTML in it stays text, and the keeper sees its private section');
    const encHash = await page.evaluate(() => location.hash);
    await page.click('.tab[data-book="knowledge"]');
    await page.click('#btn-inscribe');
    await page.fill('#f-title', 'Druids');
    await page.selectOption('#f-encounter', { label: 'An encounter with a druid' });
    await page.click('#f-submit');
    await page.waitForSelector('#view-detail:not([hidden])', { timeout: 10000 });
    check((await page.textContent('#det-date')) === '' && (await page.textContent('#det-source .link-to')) === 'An encounter with a druid', 'a record needs no date, and can name an encounter');
    await page.click('#det-source .link-to');
    check(await page.waitForSelector('#view-encounter:not([hidden])', { timeout: 5000 }).then(() => true, () => false) &&
      (await page.textContent('#enc-records')).includes('Druids'), "the record's link opens the encounter, which lists what he learned from it");
    await page.screenshot({ path: path.join(OUT, 'encounter.png') });

    // sealed, the private section leaves the page; a visitor never receives it
    await page.click('#clasp');
    await page.click('#seal-lock');
    await page.waitForFunction(() => !document.querySelector('#clasp.is-open'), null, { timeout: 10000 }).catch(() => {});
    check(await page.$('#enc-private[hidden]') !== null && !(await page.content()).includes(secret), 'sealing it again takes the private section off the page');
    const visitorCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const visitor = await visitorCtx.newPage();
    const visitorSaw = [];
    visitor.on('response', (r) => { if (r.url().startsWith(s.url)) r.text().then((t) => visitorSaw.push(t), () => {}); });
    await visitor.goto(s.url + encHash);
    await visitor.waitForSelector('#archive[open] #view-encounter:not([hidden])', { timeout: 20000 });
    await visitor.waitForTimeout(500);
    check((await visitor.textContent('#enc-title')) === 'An encounter with a druid' && await visitor.$('#enc-private[hidden]') !== null &&
      visitorSaw.length > 0 && !visitorSaw.some((t) => t.includes(secret)), 'a visitor reads the encounter but receives nothing of its private section');
    await visitorCtx.close();
    await page.click('#clasp');
    await page.fill('#seal-word', WORD);
    await page.click('#seal-go');
    await page.waitForSelector('#btn-inscribe:not([hidden])', { timeout: 15000 }).catch(() => {});
    await page.click('.tab[data-book="knowledge"]');

    // the About page
    await page.click('.tab[data-book="about"]');
    await page.click('#btn-amend');
    await page.fill('#abf-name', 'Smoke ' + xss);
    await page.fill('#abf-title', 'Archivist');
    await page.fill('#abf-race', 'Dracthyr');
    await page.fill('#abf-facts .row >> nth=0 >> [data-k="label"]', 'Motto');
    await page.fill('#abf-facts .row >> nth=0 >> [data-k="value"]', 'What is not written is lost.');
    await page.click('#abf-add-fact');
    await page.fill('#abf-facts .row >> nth=1 >> [data-k="label"]', 'Pronouns');
    await page.fill('#abf-facts .row >> nth=1 >> [data-k="value"]', 'He/him');
    await page.click('#abf-facts .row >> nth=1 >> [data-act="up"]');
    await page.click('#abf-std-traits');
    check((await page.$$('#abf-traits .row')).length === 11, "TRP's eleven standard traits can be added in one go");
    await page.$eval('#abf-traits .range', (r) => { r.value = '3'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#abf-add-glance');
    await page.fill('#abf-glances .row >> nth=0 >> [data-k="title"]', 'Scales ' + xss);
    await page.fill('#abf-sections .row >> nth=0 >> [data-k="heading"]', '“Appearance”');
    await page.$eval('#abf-sections [data-k="color"]', (c) => { c.value = '#1d6a61'; c.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.fill('#abf-sections .row >> nth=0 >> [data-k="body"]', '{h2:c}Smoke heading{/h2}\nScales the colour of old copper, in {col:ffffff}white{/col} ink and |cffffd100gold|r. ' +
      xss + '\n\n{link*javascript:alert(1)*bad link} and {link*https://example.com/*good link}{icon:inv_misc_book_09:20}');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check(await page.$('#view-about-form:not([hidden])') !== null && await page.$('#archive[open]') !== null, 'Escape does not throw away unsaved writing on the About page');
    await page.click('#abf-submit');
    await page.waitForSelector('#view-about:not([hidden])', { timeout: 10000 });
    const aboutSeen = await page.evaluate(() => {
      const out = document.getElementById('ab-sections');
      return { heading: (out.querySelector('h6.al-c') || {}).textContent, text: out.textContent, img: !!document.querySelector('#view-about img, #leaf-about img'),
        colours: [...out.querySelectorAll('.trp span')].map((n) => getComputedStyle(n).color), links: [...out.querySelectorAll('a')].map((a) => a.getAttribute('href')),
        xss: !!window.__xss, lean: (document.querySelector('#ab-traits .is-lean') || {}).textContent, traits: document.querySelectorAll('#ab-traits .trait').length,
        head: (() => { const n = out.querySelector('.ab-heading > span'), c = n && getComputedStyle(n); return n && [n.textContent, c.textAlign, c.color].join('|'); })() };
    });
    check((await page.textContent('#ab-name')) === 'Smoke ' + xss && (await page.textContent('#ab-title')) === 'Archivist' && (await page.textContent('#ab-dir')).includes('Dracthyr') &&
      (await page.$$eval('#ab-facts dt', (n) => n.map((x) => x.textContent).join())) === 'Pronouns,Motto' && aboutSeen.traits === 11 && aboutSeen.lean === 'Chaotic' &&
      (await page.textContent('#ab-glances')).includes(xss) && !aboutSeen.img && !aboutSeen.xss,
      'the About page can be amended in TRP terms, rows keep the order they were moved to, and markup stays text');
    check(aboutSeen.heading === 'Smoke heading' && aboutSeen.text.includes('old copper') && aboutSeen.text.includes(xss) && aboutSeen.text.includes('bad link') && !aboutSeen.text.includes('{') &&
      aboutSeen.links.join() === 'https://example.com/' && aboutSeen.colours.length === 2 && aboutSeen.colours.every((c) => c !== 'rgb(255, 255, 255)' && c !== 'rgb(255, 209, 0)') &&
      aboutSeen.head === 'Appearance|center|rgb(29, 106, 97)',
      "TRP markup in the description becomes headings, colours darkened for parchment and http(s) links only; a section's heading is centred in its chosen colour, without doubled quotes");
    await page.screenshot({ path: path.join(OUT, 'about.png') });

    // a plate of two images, the second mature: uploaded from the keeper's browser, shown, linked to, removed
    const requested = [];
    page.on('request', (r) => requested.push(r.url()));
    await page.click('.tab[data-book="art"]');
    await page.click('#btn-add-gallery');
    await page.fill('#gf-name', 'Smoke (Dracthyr)');
    await page.click('#gf-submit');
    check(await page.waitForFunction(() => document.getElementById('gl-title').textContent === 'Smoke (Dracthyr)' && !document.getElementById('view-gallery').hidden, null, { timeout: 10000 }).then(() => true, () => false) &&
      /^#art\/g[\w-]+$/.test(await page.evaluate(() => location.hash)), 'a form can be added; it opens at its own address');
    await page.click('#btn-add-art');
    check((await page.$eval('#af-gallery', (n) => n.options[n.selectedIndex].text)) === 'Smoke (Dracthyr)', 'a new art piece goes into the form it is added from');
    await page.setInputFiles('#af-versions .row >> nth=0 >> [data-k="file"]', { name: 'smoke.png', mimeType: 'image/png', buffer: makePng(300, 200) });
    await page.waitForFunction(() => /300 × 200/.test(document.querySelector('#af-versions [data-k="status"]').textContent), null, { timeout: 10000 }).catch(() => {});
    await page.click('#af-add');
    await page.setInputFiles('#af-versions .row >> nth=1 >> [data-k="file"]', { name: 'mature.png', mimeType: 'image/png', buffer: makePng(200, 300) });
    await page.waitForFunction(() => /200 × 300/.test(document.querySelectorAll('#af-versions [data-k="status"]')[1].textContent), null, { timeout: 10000 }).catch(() => {});
    await page.fill('#af-versions .row >> nth=1 >> [data-k="label"]', 'Mature version');
    await page.check('#af-versions .row >> nth=1 >> [data-k="mature"]');
    await page.fill('#af-title', 'Smoke plate');
    await page.fill('#af-artist', 'Smoke artist');
    await page.fill('#af-link', 'javascript:alert(1)');
    await page.click('#af-submit');
    await page.waitForFunction(() => document.getElementById('pl-title').textContent === 'Smoke plate' && !document.getElementById('view-plate').hidden, null, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => { const i = document.querySelector('#pl-open img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 10000 }).catch(() => {});
    const plate = await page.evaluate(() => {
      const i = document.querySelector('#pl-open img');
      return { title: document.getElementById('pl-title').textContent, src: i && i.getAttribute('src'), w: i && i.naturalWidth, link: !!document.querySelector('#pl-credit a'), hash: location.hash };
    });
    check(plate.title === 'Smoke plate' && /^art\/[0-9a-f]{32}\.webp$/.test(plate.src) && plate.w === 300 && !plate.link && /^#art\/a[\w-]+$/.test(plate.hash),
      'a plate can be added: the image is re-encoded in the browser, uploaded, served under the CSP, and a script link is dropped');
    const savedAll = (await page.evaluate(() => fetch('api/archive').then((r) => r.json()))).archive, saved = savedAll.art[0];
    const matureNames = [saved.versions[1].file, saved.versions[1].thumb];
    const loadedMature = (list) => list.some((u) => matureNames.some((n) => u.includes(n)));
    check(saved.versions.length === 2 && saved.versions[1].mature && saved.versions[1].label === 'Mature version' && saved.gallery === savedAll.galleries[0].id &&
      await page.$$eval('#pl-versions .ver-btn', (n) => n.length === 2 && !n[0].querySelector('.spoiler') && !!n[1].querySelector('.spoiler') && !n[1].querySelector('img')) && !loadedMature(requested),
      'a plate keeps an alternate image; the mature one shows only its cover, and its image is not loaded');
    await page.screenshot({ path: path.join(OUT, 'plate.png') });
    await page.click('#pl-versions .ver-btn >> nth=1');
    await page.waitForSelector('#gate:not([hidden])', { timeout: 3000 });
    await page.fill('#gate-age', '0');
    await page.click('#gate-go');
    check(await page.$('#gate-error:not([hidden])') !== null && await page.$('#pl-open .spoiler') !== null, 'the age check wants an age in years');
    await page.fill('#gate-age', '30');
    await page.click('#gate-go');
    check(await page.waitForFunction(() => { const i = document.querySelector('#pl-open img'); return document.getElementById('gate').hidden && i && i.complete && i.naturalWidth === 200; }, null, { timeout: 10000 }).then(() => true, () => false) &&
      loadedMature(requested), 'selecting the mature image asks for an age, and at 18 or older shows it');
    await page.screenshot({ path: path.join(OUT, 'mature-shown.png') });
    await page.click('#pl-back'); // back to the form
    check(await page.$('#view-gallery:not([hidden])') !== null && !(await page.$('#pl-open img, #pl-open .spoiler')), 'back at the form, nothing of the mature image stays on the page');
    await page.click('#plates .plate-btn');
    await page.click('#pl-versions .ver-btn >> nth=1');
    check(await page.waitForFunction(() => document.getElementById('gate').hidden && !!document.querySelector('#pl-open img'), null, { timeout: 5000 }).then(() => true, () => false),
      'the answer holds for the visit: the cover opens on a click without asking again');
    await page.click('#pl-versions .ver-btn >> nth=0');
    await page.click('#pl-open');
    await page.waitForSelector('#lightbox:not([hidden])', { timeout: 3000 });
    await page.keyboard.press('ArrowRight');
    check(await page.waitForSelector('#lb-frame .lb-cover', { timeout: 3000 }).then(() => true, () => false), 'in the full-size view, the mature image arrives covered');
    await page.keyboard.press('Escape');
    check(await page.$('#lightbox[hidden]') !== null && await page.$('#archive[open]') !== null, 'Escape closes only the full-size view');

    // someone under 18, in a browser of their own
    const minorCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const minor = await minorCtx.newPage();
    const minorSeen = [];
    minor.on('request', (r) => minorSeen.push(r.url()));
    await minor.goto(s.url + plate.hash);
    await minor.waitForSelector('#archive[open] #view-plate:not([hidden])', { timeout: 20000 });
    await minor.click('#pl-versions .ver-btn >> nth=1');
    await minor.waitForSelector('#gate:not([hidden])', { timeout: 3000 });
    await minor.fill('#gate-age', '15');
    await minor.click('#gate-go');
    const refusedText = await minor.textContent('#gate-text');
    await minor.click('#gate-back');
    await minor.click('#pl-open');
    const askedAgain = await minor.$('#gate-field:not([hidden])') !== null;
    check(/18 or older/.test(refusedText) && !askedAgain && await minor.$('#gate:not([hidden])') !== null && await minor.$('#pl-open .spoiler') !== null && !loadedMature(minorSeen),
      'under 18, the mature image stays covered for the visit and is never loaded');
    await minorCtx.close();

    // a video and a GIF, as one art piece in the same form: each plays in its own player
    await page.click('#pl-back');
    await page.click('#btn-add-art');
    await page.setInputFiles('#af-versions .row >> nth=0 >> [data-k="file"]', path.join(FIXTURES, 'smoke.webm'));
    await page.waitForFunction(() => /^A video/.test(document.querySelector('#af-versions [data-k="status"]').textContent), null, { timeout: 15000 }).catch(() => {});
    const loopOffered = await page.$('#af-versions .row >> nth=0 >> [data-k="loop-box"]:not([hidden])') !== null;
    await page.click('#af-add');
    await page.setInputFiles('#af-versions .row >> nth=1 >> [data-k="file"]', path.join(FIXTURES, 'smoke.gif'));
    await page.waitForFunction(() => /^An animated GIF/.test(document.querySelectorAll('#af-versions [data-k="status"]')[1].textContent), null, { timeout: 10000 }).catch(() => {});
    await page.fill('#af-title', 'Smoke animation');
    await page.click('#af-submit');
    await page.waitForFunction(() => document.getElementById('pl-title').textContent === 'Smoke animation' && !!document.querySelector('#pl-video video'), null, { timeout: 20000 }).catch(() => {});
    const anim = (await page.evaluate(() => fetch('api/archive').then((r) => r.json()))).archive.art.find((a) => a.title === 'Smoke animation');
    check(loopOffered && anim && /\.webm$/.test(anim.versions[0].file) && /\.webp$/.test(anim.versions[0].thumb) && anim.versions[0].width === 96 && anim.versions[0].loop === true &&
      /\.gif$/.test(anim.versions[1].file) && /\.webp$/.test(anim.versions[1].thumb) && anim.versions[1].width === 48,
      'a video and a GIF can be uploaded as they are, each with a still made in the browser; a short video is set to loop');
    await page.click('#pl-video .vid-big');
    check(await page.waitForFunction(() => { const v = document.querySelector('#pl-video video'); return v && !v.paused && v.currentTime > 0.2; }, null, { timeout: 10000 }).then(() => true, () => false) &&
      /^0:0\d \/ 0:01$/.test(await page.textContent('#pl-video .vid-time')), "the video plays in the archive's own player, served under the CSP");
    await page.screenshot({ path: path.join(OUT, 'video.png') });
    await page.click('#pl-video .vid-btn >> nth=0');
    check(await page.$eval('#pl-video video', (v) => v.paused), 'its play button pauses it');
    await page.click('#pl-versions .ver-btn >> nth=1');
    check(await page.waitForFunction(() => { const i = document.querySelector('#pl-open .gif img'); return i && i.complete && i.naturalWidth === 48 && !document.querySelector('#pl-video video'); }, null, { timeout: 5000 }).then(() => true, () => false),
      'switching to the GIF takes the video away, and the GIF plays');
    await page.click('#pl-media > .play-btn');
    check(!!(await page.$('#pl-open .gif canvas')) && (await page.getAttribute('#pl-media > .play-btn', 'aria-label')) === 'Play the animation', 'the GIF can be paused on the frame it is on');
    await page.click('#pl-media > .play-btn');
    await page.click('#pl-open');
    await page.waitForSelector('#lightbox:not([hidden])', { timeout: 3000 });
    await page.keyboard.press('ArrowLeft');
    check(await page.waitForSelector('#lb-frame .player video', { timeout: 3000 }).then(() => true, () => false), 'the full-size view shows the video in its player too');
    await page.keyboard.press('Escape');
    check(await page.$('#lightbox[hidden]') !== null && await page.$('#archive[open]') !== null,
      'Escape again closes only the full-size view (Chrome lets a page hold back a dialog\'s own Escape just once per click)');
    await page.click('#pl-delete');
    await page.click('#pl-delete'); // confirm
    await page.waitForSelector('#view-gallery:not([hidden])', { timeout: 10000 });
    const plateHash = plate.hash;
    await page.goto(s.url + '#about');
    await page.reload();
    await page.waitForSelector('#archive[open] #view-about:not([hidden])', { timeout: 10000 });
    check((await page.$$('#ab-traits .trait')).length === 11 && (await page.textContent('#ab-sections')).includes('old copper') && (await page.textContent('#ab-title')) === 'Archivist' &&
      !(await page.$('#leaf-about img, #view-about img')), 'an address with #about opens the About page at once, with no portrait on it');
    await page.goto(s.url + plateHash);
    check(await page.waitForFunction(() => document.getElementById('pl-title').textContent === 'Smoke plate' && !document.getElementById('view-plate').hidden, null, { timeout: 10000 }).then(() => true, () => false),
      "a plate's own address opens it");
    await page.click('#pl-delete');
    await page.click('#pl-delete'); // confirm
    await page.waitForFunction(() => !document.getElementById('pl-empty').hidden, null, { timeout: 10000 }).catch(() => {});
    check(await page.waitForFunction(() => !document.querySelector('#plates .plate-btn'), null, { timeout: 10000 }).then(() => true, () => false),
      'the plate can be removed');
    await page.click('#gl-delete');
    await page.click('#gl-delete'); // confirm
    check(await page.waitForFunction(() => !document.getElementById('leaf-art').hidden && !document.querySelector('#galleries .gallery-btn'), null, { timeout: 10000 }).then(() => true, () => false),
      'an empty form can be removed');
    await page.click('.tab[data-book="knowledge"]');

    // change the word from the page, then seal it again
    await page.click('#clasp');
    await page.click('#seal-change');
    await page.fill('#seal-current', WORD);
    await page.fill('#seal-word', NEW_WORD);
    await page.fill('#seal-again', NEW_WORD + '!');
    await page.click('#seal-go');
    check((await page.textContent('#seal-error')).includes("don't match"), 'mismatched new words are refused');
    await page.fill('#seal-again', NEW_WORD);
    await page.click('#seal-go');
    await page.waitForSelector('#seal', { state: 'hidden', timeout: 15000 });
    check(await page.$('#btn-inscribe:not([hidden])') !== null, 'changing the word keeps this session unsealed');
    await page.click('#clasp');
    await page.click('#seal-lock');
    await page.waitForSelector('#btn-inscribe', { state: 'hidden', timeout: 10000 });
    await page.goto(s.url);
    await enter(page, 'knowledge');
    await page.waitForTimeout(800);
    check(await page.$('#btn-inscribe[hidden]') !== null, 'sealing it again hides the tools, also after a reload');
    await page.click('#clasp');
    await page.fill('#seal-word', NEW_WORD);
    await page.click('#seal-go');
    check(await page.waitForSelector('#btn-inscribe:not([hidden])', { timeout: 15000 }).then(() => true, () => false), 'the new word unlocks');
    check(errors.length === 0, `no console errors or CSP violations${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } finally {
    await browser.close();
    s.stop();
  }
}

// ---------- 3. the claude.ai Artifact preview ----------
async function previewChecks() {
  const index = fs.readFileSync(path.join(ROOT, 'dist', 'index.html'), 'utf8');
  check(!/ca-preview|CA_PREVIEW =|ca-model|ca-files|ca-private/.test(index), 'the real page carries no preview stand-in, no embedded model, no example images and no example private text');
  const html = ARTIFACT_SKELETON + fs.readFileSync(path.join(ROOT, 'dist', 'preview.html'), 'utf8') + '</body></html>';
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    const open = () => enter(page, 'knowledge');
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    check(await open().then(() => true, () => false), 'preview: the 3D model loads from the page itself under the Artifact CSP, and the hub opens the tome');
    await page.click('.tab[data-book="art"]');
    check(await page.waitForFunction(() => [...document.querySelectorAll('#galleries .gallery-btn b')].map((b) => b.textContent).join('|') === 'Example: Character (OC)|Example: Character (Dracthyr)',
      null, { timeout: 5000 }).then(() => true, () => false), 'preview: Art opens on his example forms');
    await page.click('#galleries .gallery-btn >> nth=1');
    check(await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll('#plates img')];
      return imgs.length === 2 && imgs.every((i) => i.complete && i.naturalWidth > 0 && i.src.startsWith('data:image/jpeg')) && document.querySelectorAll('#plates .spoiler').length === 1;
    }, null, { timeout: 10000 }).then(() => true, () => false), 'preview: the example plates load from the page itself, and the one flagged mature shows only its cover');
    await page.click('#plates .plate-btn >> nth=0');
    await page.click('#pl-versions .ver-btn >> nth=2');
    await page.fill('#gate-age', '30');
    await page.click('#gate-go');
    check(await page.waitForFunction(() => { const i = document.querySelector('#pl-open img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 }).then(() => true, () => false),
      'preview: the age check works without storage');
    await page.click('#pl-back');
    await page.click('#gl-back');
    await page.click('#galleries .gallery-btn >> nth=0');
    check((await page.$$eval('#plates .media-badge', (n) => n.map((x) => x.textContent).join('|'))) === 'GIF|Video', 'preview: the GIF and the video are marked in the list');
    await page.click('#plates .plate-btn >> nth=1');
    await page.click('#pl-video .vid-big');
    check(await page.waitForFunction(() => { const v = document.querySelector('#pl-video video'); return v && !v.paused && v.currentTime > 0.3 && v.src.startsWith('data:video/webm'); }, null, { timeout: 10000 }).then(() => true, () => false),
      'preview: the example video plays from the page itself');
    await page.click('#pl-back');
    await page.click('#plates .plate-btn >> nth=0');
    check(await page.waitForFunction(() => { const i = document.querySelector('#pl-open .gif img'); return i && i.complete && i.naturalWidth > 0 && i.src.startsWith('data:image/gif'); }, null, { timeout: 5000 }).then(() => true, () => false),
      'preview: the example GIF plays from the page itself');
    await page.screenshot({ path: path.join(OUT, 'preview-gif.png') });
    await page.click('.tab[data-book="about"]');
    check((await page.textContent('#ab-dir')).includes('Dracthyr') && !(await page.$('#leaf-about img')) && (await page.$$('#ab-traits .trait')).length > 0 &&
      (await page.$$('#ab-sections h6')).length > 0, 'preview: the About page shows its example profile');
    await page.click('.tab[data-book="knowledge"]');
    await page.click('#clasp');
    check((await page.textContent('#seal-text')).includes('preview'), 'preview: the seal panel says it is the preview and gives the word');
    await page.fill('#seal-word', 'not the word');
    await page.click('#seal-go');
    await page.waitForSelector('#seal-error:not([hidden])', { timeout: 5000 });
    await page.fill('#seal-word', 'preview');
    await page.click('#seal-go');
    check(await page.waitForSelector('#btn-inscribe:not([hidden])', { timeout: 5000 }).then(() => true, () => false), 'preview: a wrong word is refused, "preview" unseals');
    await page.click('.tab[data-book="about"]');
    await page.click('#btn-amend');
    await page.fill('#abf-title', 'Preview title');
    await page.click('#abf-submit');
    check(await page.waitForFunction(() => document.getElementById('ab-title').textContent === 'Preview title' && !document.getElementById('view-about').hidden, null, { timeout: 5000 }).then(() => true, () => false) &&
      (await page.$$('#ab-traits .trait')).length > 0, 'preview: the About page can be amended');
    await page.click('.tab[data-book="encounters"]');
    await page.click('#encounters .entry >> nth=0');
    check(await page.waitForSelector('#enc-private:not([hidden])', { timeout: 5000 }).then(() => true, () => false) &&
      (await page.textContent('#enc-private-text')).includes('example private section'), "preview: the example encounter's private section shows once unsealed");
    await page.click('.tab[data-book="knowledge"]');
    await page.click('#btn-inscribe');
    await page.fill('#f-title', 'Preview record');
    await page.click('#f-submit');
    await page.waitForSelector('#view-detail:not([hidden])', { timeout: 5000 });
    check((await page.textContent('#det-title')) === 'Preview record', 'preview: records can be inscribed');
    await page.click('.tab[data-book="art"]');
    await page.click('#galleries .gallery-btn >> nth=0');
    await page.click('#btn-add-art');
    await page.setInputFiles('#af-versions .row >> nth=0 >> [data-k="file"]', { name: 'preview.png', mimeType: 'image/png', buffer: makePng(120, 90) });
    await page.waitForFunction(() => /120 × 90/.test(document.querySelector('#af-versions [data-k="status"]').textContent), null, { timeout: 10000 }).catch(() => {});
    await page.click('#af-add');
    await page.setInputFiles('#af-versions .row >> nth=1 >> [data-k="file"]', path.join(FIXTURES, 'smoke.gif'));
    await page.waitForFunction(() => /^An animated GIF/.test(document.querySelectorAll('#af-versions [data-k="status"]')[1].textContent), null, { timeout: 10000 }).catch(() => {});
    await page.fill('#af-title', 'Preview plate');
    await page.click('#af-submit');
    check(await page.waitForFunction(() => {
      const i = document.querySelector('#pl-open img');
      return document.getElementById('pl-title').textContent === 'Preview plate' && i && i.complete && i.naturalWidth === 120 && i.src.startsWith('data:image/webp');
    }, null, { timeout: 10000 }).then(() => true, () => false), 'preview: a plate can be uploaded and is shown from memory');
    await page.click('#pl-versions .ver-btn >> nth=1');
    check(await page.waitForFunction(() => { const i = document.querySelector('#pl-open .gif img'); return i && i.complete && i.naturalWidth === 48 && i.src.startsWith('data:image/gif'); }, null, { timeout: 5000 }).then(() => true, () => false),
      'preview: a GIF can be uploaded too');
    await page.click('.tab[data-book="knowledge"]');
    await page.screenshot({ path: path.join(OUT, 'preview.png') });
    await page.evaluate(() => history.replaceState(null, '', location.pathname)); // reload the page itself, not a chapter's address
    await page.reload();
    await open();
    await page.waitForTimeout(500);
    check(await page.$('#btn-inscribe[hidden]') !== null && !(await page.$$eval('#records .entry-title', (n) => n.some((x) => x.textContent === 'Preview record'))) &&
      (await page.textContent('#ab-title')) === 'Archivist', 'preview: a reload forgets the changes and seals the archive again');
    check(errors.length === 0, `preview: no console errors or CSP violations${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } finally {
    await browser.close();
    server.close();
  }
}

function launch() {
  return chromium.launch({
    executablePath: process.env.CHROME || undefined,
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'].concat((process.env.CHROME_ARGS || '').split(' ').filter(Boolean)),
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, fn] of [['API checks', apiChecks], ['private section checks', privateChecks], ['older archive checks', legacyChecks], ['browser checks', browserChecks], ['preview checks', previewChecks]]) {
    try { await fn(); } catch (e) { check(false, `${name} completed (${e.message})`); }
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
  process.exitCode = failures.length ? 1 : 0;
})();
