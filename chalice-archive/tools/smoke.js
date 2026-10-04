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
     security headers and a CSP whose hashes match the page; nothing outside the page, the model and the API
     can be fetched; logins and writes refuse a foreign or missing Origin, a missing or wrong CSRF token, and
     non-JSON bodies; the session cookie's flags; field validation and size limits; stored markup cannot end
     the page's data block; backups; the password file; changing the word signs other sessions out;
     failed logins are throttled per client IP.
  2. In Chromium, under the server's real CSP: the 3D model replaces the cutout with no console errors; only
     the gem opens the archive; a wrong word is refused; the right word shows the tools; records can be
     inscribed, revised and removed, and markup in them stays text; the session survives a reload; the word
     can be changed from the page; sealing it again hides the tools.
  3. dist/preview.html, the claude.ai Artifact build, in the Artifact's skeleton under a CSP like its viewer's (no
     network requests at all): the model loads from the page, the stand-in server accepts only "preview", records
     can be inscribed, and a reload forgets them. The real page carries no trace of the stand-in.
Screenshots go to tools/.smoke/.
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'server.mjs');
const OUT = path.join(__dirname, '.smoke');
const WORD = 'a long smoke-test passphrase';
const NEW_WORD = 'another long smoke-test passphrase';
const ORIGIN = 'https://archive.test';
const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com " +
  "https://cdn.tailwindcss.com https://code.jquery.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
  "img-src data:; connect-src 'none'";
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

async function startServer(name, env) {
  const dataDir = path.join(OUT, 'data-' + name);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const set = await run(['set-password'], { DATA_DIR: dataDir }, `${WORD}\n${WORD}\n`);
  if (set.code !== 0) throw new Error('set-password failed: ' + set.out);
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
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
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
      source: 'A book', id: '../../etc', example: true, added: 1, extra: 'ignored',
    });
    const rec = made.json && made.json.archive.records.find((r) => r.id === made.json.id);
    check(made.status === 200 && rec && rec.title.length === 120 && rec.status === 'fragment' && /^\d{4}-\d{2}-\d{2}$/.test(rec.date) && rec.date !== '2020-13-45' &&
      rec.note === 'line one\nline two' && rec.example === false && rec.id !== '../../etc' && !('extra' in rec) && rec.added > 1,
      'a new record is cleaned: lengths capped, unknown status and bad date replaced, control characters stripped, id and flags set by the server');
    check((await write('POST', '/api/records', { title: '   ' })).status === 400, 'a record without a title is refused');
    check((await write('POST', '/api/records', { title: 'x', note: 'y'.repeat(70 * 1024) })).status === 413, 'a body over 64 KB is refused (413)');
    check((await call('POST', '/api/records', { headers: { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf }, body: '{"title":' })).status === 400, 'malformed JSON is refused');
    check((await write('PUT', '/api/records/nope', { title: 'x' })).status === 404 && (await write('PUT', '/api/records/..%2f..%2fx', { title: 'x' })).status === 404,
      'revising a missing or malformed id is refused');
    const revised = await write('PUT', '/api/records/' + rec.id, { title: 'Revised', status: 'relearned', date: '2026-01-02' });
    const rev = revised.json && revised.json.archive.records.find((r) => r.id === rec.id);
    check(revised.status === 200 && rev.title === 'Revised' && rev.status === 'relearned' && rev.added === rec.added, 'a record can be revised and keeps its id and accession time');
    await write('PUT', '/api/records/' + rec.id, { title: evil });
    const shown = await call('GET', '/');
    const data = shown.text.match(/<script type="application\/json" id="ca-data">([\s\S]*?)<\/script>/)[1];
    check(!data.includes('<') && !shown.text.includes('<script>alert(1)') && archiveIn(shown.text).records.some((r) => r.title === evil.slice(0, 120)),
      "stored markup is escaped in the page's data block and comes back intact as text");
    const del = await write('DELETE', '/api/records/' + rec.id);
    check(del.status === 200 && !del.json.archive.records.some((r) => r.id === rec.id), 'a record can be removed');
    const backups = fs.readdirSync(path.join(s.dataDir, 'backups')).filter((f) => f.endsWith('.json'));
    const archiveMode = fs.statSync(path.join(s.dataDir, 'archive.json')).mode & 0o777;
    check(backups.length >= 3 && archiveMode === 0o600, `each change keeps a backup of the previous archive (${backups.length} so far), and archive.json is 0600`);

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
    check(!(await page.$('#archive[open]')), 'a click on the construct away from the gem does not scan');
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
      opened = await page.waitForSelector('#archive[open]', { timeout: 4000 }).then(() => true, () => false);
      if (!opened) await page.mouse.move(cx - box.width, cy);
    }
    check(!!gem, 'pointing at the gem shows the hand cursor');
    check(opened, 'clicking the gem opens the archive');
    if (!opened) throw new Error('the archive did not open');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, 'archive.png') });
    check(await page.$('#btn-inscribe[hidden]') !== null, 'a visitor sees no editing tools');

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

    await page.reload();
    await page.waitForSelector('.core.is-3d', { timeout: 30000 });
    await page.focus('#construct');
    await page.keyboard.press('Enter'); // keyboard activation always scans
    await page.waitForSelector('#archive[open]', { timeout: 5000 });
    check(await page.waitForSelector('#btn-inscribe:not([hidden])', { timeout: 5000 }).then(() => true, () => false), 'after a reload the keeper is still unsealed');
    check(await page.$$eval('#index .topic-title', (n) => n.some((x) => x.textContent === 'Smoke record')), 'the record is in the index after a reload');
    await page.click('#index .topic');
    await page.click('#det-edit');
    await page.fill('#f-title', 'Smoke record, revised');
    await page.click('#f-submit');
    await page.waitForFunction(() => document.getElementById('det-title').textContent === 'Smoke record, revised', null, { timeout: 10000 }).catch(() => {});
    check((await page.textContent('#det-title')) === 'Smoke record, revised', 'a record can be revised');
    await page.click('#det-delete');
    await page.click('#det-delete'); // confirm
    await page.waitForSelector('#view-overview:not([hidden])', { timeout: 10000 });
    check(!(await page.$$eval('#index .topic-title', (n) => n.some((x) => x.textContent.startsWith('Smoke record')))), 'a record can be removed');

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
    await page.reload();
    await page.waitForSelector('.core.is-3d', { timeout: 30000 });
    await page.focus('#construct');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#archive[open]', { timeout: 5000 });
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
  check(!/ca-preview|CA_PREVIEW =|ca-model/.test(index), 'the real page carries no preview stand-in and no embedded model');
  const html = ARTIFACT_SKELETON + fs.readFileSync(path.join(ROOT, 'dist', 'preview.html'), 'utf8') + '</body></html>';
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    const open = async () => {
      await page.waitForSelector('.core.is-3d', { timeout: 30000 });
      await page.focus('#construct');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#archive[open]', { timeout: 5000 });
    };
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    check(await open().then(() => true, () => false), 'preview: the 3D model loads from the page itself under the Artifact CSP');
    await page.click('#clasp');
    check((await page.textContent('#seal-text')).includes('preview'), 'preview: the seal panel says it is the preview and gives the word');
    await page.fill('#seal-word', 'not the word');
    await page.click('#seal-go');
    await page.waitForSelector('#seal-error:not([hidden])', { timeout: 5000 });
    await page.fill('#seal-word', 'preview');
    await page.click('#seal-go');
    check(await page.waitForSelector('#btn-inscribe:not([hidden])', { timeout: 5000 }).then(() => true, () => false), 'preview: a wrong word is refused, "preview" unseals');
    await page.click('#btn-inscribe');
    await page.fill('#f-title', 'Preview record');
    await page.click('#f-submit');
    await page.waitForSelector('#view-detail:not([hidden])', { timeout: 5000 });
    check((await page.textContent('#det-title')) === 'Preview record', 'preview: records can be inscribed');
    await page.screenshot({ path: path.join(OUT, 'preview.png') });
    await page.reload();
    await open();
    await page.waitForTimeout(500);
    check(await page.$('#btn-inscribe[hidden]') !== null && !(await page.$$eval('#index .topic-title', (n) => n.some((x) => x.textContent === 'Preview record'))),
      'preview: a reload forgets the record and seals the archive again');
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
  for (const [name, fn] of [['API checks', apiChecks], ['browser checks', browserChecks], ['preview checks', previewChecks]]) {
    try { await fn(); } catch (e) { check(false, `${name} completed (${e.message})`); }
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
  process.exitCode = failures.length ? 1 : 0;
})();
