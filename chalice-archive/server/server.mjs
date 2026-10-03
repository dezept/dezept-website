#!/usr/bin/env node
/* Chalice Archive server: serves the page and the model, keeps the records, and lets the keeper write after
   logging in with the keeper's word. Node 20 or later; no dependencies beyond Node's own modules.

     node server/server.mjs                 serve the archive
     node server/server.mjs set-password    set or replace the keeper's word (asks twice; or two lines on stdin)

   Environment:
     PORT=8080, HOST=127.0.0.1             where to listen. Keep it on loopback, behind Caddy.
     DATA_DIR=./server/data                records (archive.json), the password hash (auth.json), backups/
     SITE_DIR=./dist                       the built page and model (python3 build.py)
     PUBLIC_ORIGIN=https://archive.example.com
                                           the address visitors use. Logins and writes must come from it.
     TRUST_PROXY=true                      take the client IP from X-Real-IP (set by Caddy), only from a loopback peer
     COOKIE_SECURE=false                   only for local testing over plain http
     SESSION_HOURS=12                      how long a login lasts

   Security, in short (deploy/README.md has the whole picture):
     - The keeper's word is stored only as a salted scrypt hash (N=2^17, r=8, p=1), set from the command line,
       so the web never offers a "choose a password" form an attacker could reach first.
     - A login gets a random 256-bit session token in an HttpOnly, SameSite=Strict, Secure cookie (__Host- prefix).
       The server keeps only the token's SHA-256. Changing the word signs every session out.
     - Writes need that session, its CSRF token in a header, a JSON body and an Origin equal to PUBLIC_ORIGIN.
     - Failed logins are throttled per client IP (rising waits) and overall.
     - Every field is validated and capped here; the page renders all of it as text.
     - Every response carries a strict Content-Security-Policy built from hashes of the page's own inline
       script and style, so no other inline code can run.
     - Only two files are served: the page and the model. There is no static directory to wander through.
*/
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const env = process.env;

const CONFIG = {
  port: Number(env.PORT ?? 8080),
  host: env.HOST || "127.0.0.1",
  dataDir: path.resolve(env.DATA_DIR || path.join(HERE, "data")),
  siteDir: path.resolve(env.SITE_DIR || path.join(ROOT, "dist")),
  origin: (env.PUBLIC_ORIGIN || "").replace(/\/+$/, ""),
  trustProxy: env.TRUST_PROXY === "true",
  secureCookie: env.COOKIE_SECURE !== "false",
  sessionMs: Math.max(1, Number(env.SESSION_HOURS || 12)) * 3600e3,
};

const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };
const WORD = { min: 12, max: 1024 };
const LIMIT = { body: 64 * 1024, records: 5000, title: 120, domain: 60, note: 4000, source: 160, sessions: 50 };
const STATUSES = ["remembered", "superseded", "relearned", "fragment", "sought"];
const FILES = {
  archive: path.join(CONFIG.dataDir, "archive.json"),
  auth: path.join(CONFIG.dataDir, "auth.json"),
  backups: path.join(CONFIG.dataDir, "backups"),
  seed: path.join(ROOT, "src", "seed.json"),
};

class HttpError extends Error {
  constructor(status, message, headers) { super(message); this.status = status; this.headers = headers; }
}

// ---------- files ----------
function ensureDataDir() {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(FILES.backups, { recursive: true, mode: 0o700 });
}

// Write to a temporary file, flush it to disk, then rename over the target: a crash never leaves half a file.
function writeAtomic(file, text) {
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

// ---------- the keeper's word ----------
// Each scrypt call takes 128 MiB for a fraction of a second. They run one at a time, and a long queue is
// refused, so a burst of logins cannot exhaust a small VPS's memory.
let kdfChain = Promise.resolve();
let kdfWaiting = 0;
function oneAtATime(fn) {
  if (kdfWaiting >= 4) return Promise.reject(new HttpError(503, "The archive is busy. Try again in a moment.", { "Retry-After": "5" }));
  kdfWaiting += 1;
  const run = kdfChain.then(fn, fn);
  kdfChain = run.catch(() => {});
  return run.finally(() => { kdfWaiting -= 1; });
}

async function hashWord(word) {
  const salt = crypto.randomBytes(16);
  const key = await oneAtATime(() => scrypt(word.normalize("NFC"), salt, SCRYPT.keylen, SCRYPT));
  return {
    kdf: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString("base64"), hash: key.toString("base64"),
    generation: crypto.randomBytes(12).toString("hex"), // sessions remember this; a new word changes it
    changed: new Date().toISOString(),
  };
}

function readAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(FILES.auth, "utf8"));
    const sane = a && a.kdf === "scrypt" && typeof a.salt === "string" && typeof a.hash === "string" && typeof a.generation === "string"
      && Number.isInteger(a.N) && a.N >= 2 ** 14 && a.N <= 2 ** 20 && a.r >= 1 && a.r <= 32 && a.p >= 1 && a.p <= 4;
    return sane ? a : null;
  } catch { return null; }
}

// Always runs scrypt, even without a stored word, so timing says nothing about the setup.
const DUMMY = { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: crypto.randomBytes(16).toString("base64"), hash: crypto.randomBytes(64).toString("base64") };
async function checkWord(word, auth) {
  const ref = auth || DUMMY;
  const expected = Buffer.from(ref.hash, "base64");
  const key = await oneAtATime(() => scrypt(String(word).normalize("NFC"), Buffer.from(ref.salt, "base64"), expected.length,
    { N: ref.N, r: ref.r, p: ref.p, maxmem: SCRYPT.maxmem }));
  return Boolean(auth) && key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function validWord(word) {
  if (typeof word !== "string" || word.length < WORD.min) return `Use at least ${WORD.min} characters.`;
  if (word.length > WORD.max) return `Use at most ${WORD.max} characters.`;
  return "";
}

// ---------- the archive ----------
const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const today = () => new Date().toISOString().slice(0, 10);
const validDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z"));
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(id);

function cleanRecord(input, prev) {
  if (!input || typeof input !== "object") throw new HttpError(400, "The record is malformed.");
  const title = str(input.title, LIMIT.title);
  if (!title) throw new HttpError(400, "Give the record a title.");
  return {
    id: prev ? prev.id : "r" + crypto.randomBytes(9).toString("base64url"),
    title,
    domain: str(input.domain, LIMIT.domain) || "Unsorted",
    status: STATUSES.includes(input.status) ? input.status : "fragment",
    note: str(input.note, LIMIT.note),
    source: str(input.source, LIMIT.source),
    date: validDate(input.date) ? input.date : today(),
    added: prev ? prev.added : Date.now(),
    example: false,
  };
}

function cleanArchive(raw) {
  const p = (raw && raw.profile) || {};
  const records = (Array.isArray(raw && raw.records) ? raw.records : []).filter((r) => r && validId(r.id) && str(r.title, LIMIT.title)).slice(0, LIMIT.records)
    .map((r) => ({ ...cleanRecord(r, { id: r.id, added: Number(r.added) || 0 }), example: Boolean(r.example) }));
  return {
    profile: { name: str(p.name, 60) || "Unnamed Dracthyr", epithet: str(p.epithet, 280), construct: str(p.construct, 60), constructNote: str(p.constructNote, 400) },
    records,
  };
}

let archive = null;
function loadArchive() {
  if (!fs.existsSync(FILES.archive)) {
    const seed = fs.existsSync(FILES.seed) ? JSON.parse(fs.readFileSync(FILES.seed, "utf8")) : {};
    writeAtomic(FILES.archive, JSON.stringify(cleanArchive(seed), null, 2) + "\n");
  }
  archive = cleanArchive(JSON.parse(fs.readFileSync(FILES.archive, "utf8")));
}

// Keep the previous version as a backup (the last 50), then write the new one.
function commit(next) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (fs.existsSync(FILES.archive)) fs.copyFileSync(FILES.archive, path.join(FILES.backups, `archive-${stamp}.json`));
  const old = fs.readdirSync(FILES.backups).filter((f) => /^archive-.*\.json$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 50))) fs.unlinkSync(path.join(FILES.backups, f));
  writeAtomic(FILES.archive, JSON.stringify(next, null, 2) + "\n");
  archive = next;
}

// ---------- sessions ----------
const sessions = new Map(); // sha256(token) -> { csrf, expires, generation }
const COOKIE = CONFIG.secureCookie ? "__Host-ca_session" : "ca_session";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("base64url");

function createSession(auth) {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expires <= now) sessions.delete(k);
  while (sessions.size >= LIMIT.sessions) sessions.delete(sessions.keys().next().value); // oldest first
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(32).toString("base64url");
  sessions.set(sha256(token), { csrf, expires: now + CONFIG.sessionMs, generation: auth.generation });
  return { token, csrf };
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionOf(req) {
  const token = cookies(req)[COOKIE];
  if (!token || token.length > 128) return null;
  const key = sha256(token);
  const s = sessions.get(key);
  if (!s) return null;
  const auth = readAuth();
  if (s.expires <= Date.now() || !auth || auth.generation !== s.generation) { sessions.delete(key); return null; }
  return { key, ...s };
}

function sessionCookie(token, maxAgeMs) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${CONFIG.secureCookie ? "; Secure" : ""}`;
}

// ---------- login throttling ----------
const failures = new Map(); // ip -> { count, until, last }
let recentFailures = []; // timestamps of all failed logins, for the overall cap
const GLOBAL = { windowMs: 10 * 60e3, max: 50 };

function loginWait(ip) {
  const now = Date.now();
  recentFailures = recentFailures.filter((t) => now - t < GLOBAL.windowMs);
  if (recentFailures.length >= GLOBAL.max) return Math.ceil((recentFailures[0] + GLOBAL.windowMs - now) / 1000);
  const f = failures.get(ip);
  return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
}

function noteFailure(ip) {
  const now = Date.now();
  recentFailures.push(now);
  const f = failures.get(ip) || { count: 0, until: 0, last: 0 };
  if (now - f.last > 24 * 3600e3) f.count = 0; // forgive after a quiet day
  f.count += 1;
  f.last = now;
  const secs = f.count < 3 ? 0 : Math.min(3600, 2 ** (f.count - 2)); // two free typos, then 2 s, 4 s, 8 s … up to an hour
  f.until = now + secs * 1000;
  failures.set(ip, f);
  if (failures.size > 10000) for (const [k, v] of failures) if (now - v.last > 3600e3) failures.delete(k);
  return secs;
}

function clientIp(req) {
  const peer = req.socket.remoteAddress || "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (CONFIG.trustProxy && loopback) {
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (/^[0-9a-fA-F:.]{2,45}$/.test(real)) return real;
  }
  return peer;
}

// ---------- the site ----------
function loadSite() {
  const pagePath = path.join(CONFIG.siteDir, "index.html");
  const page = fs.readFileSync(pagePath, "utf8");
  const parts = page.split("__ARCHIVE__");
  if (parts.length !== 2) throw new Error(`${pagePath} must contain the __ARCHIVE__ placeholder exactly once; run python3 build.py`);
  const inline = (re, what) => {
    const m = page.match(re);
    if (!m) throw new Error(`${pagePath} has no ${what}`);
    return `'sha256-${crypto.createHash("sha256").update(m[1], "utf8").digest("base64")}'`;
  };
  const appHash = inline(/<script id="ca-app">([\s\S]*?)<\/script>/, "app script");
  const styleHash = inline(/<style id="ca-style">([\s\S]*?)<\/style>/, "style block");
  const modelName = (page.match(/"(chalice\.[0-9a-f]{12}\.glb)"/) || [])[1];
  if (!modelName) throw new Error(`${pagePath} does not name a model file`);
  return {
    before: parts[0], after: parts[1],
    model: { name: modelName, body: fs.readFileSync(path.join(CONFIG.siteDir, modelName)) },
    csp: [
      "default-src 'none'",
      `script-src ${appHash} https://cdn.jsdelivr.net/npm/`,
      `style-src ${styleHash} https://fonts.googleapis.com`,
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
  };
}

// The archive goes into a JSON <script> block; escape what could end it or confuse a parser.
function scriptJson(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// ---------- http ----------
let SITE = null;

function securityHeaders(res) {
  res.setHeader("Content-Security-Policy", SITE.csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (CONFIG.secureCookie) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function sendJson(req, res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text), ...headers });
  res.end(req.method === "HEAD" ? undefined : text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return reject(new HttpError(415, "Send JSON."));
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > LIMIT.body) return reject(new HttpError(413, "That is too large."));
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > LIMIT.body) { reject(new HttpError(413, "That is too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new HttpError(400, "The request is not valid JSON.")); }
    });
    req.on("error", reject);
  });
}

// Writes must come from the archive's own address: the browser's Origin header, which pages cannot forge.
function sameOrigin(req) {
  const expected = CONFIG.origin || `${CONFIG.secureCookie ? "https" : "http"}://${req.headers.host}`;
  return req.headers.origin === expected;
}

function csrfOk(req, session) {
  const sent = Buffer.from(String(req.headers["x-csrf-token"] || ""));
  const want = Buffer.from(session.csrf);
  return sent.length === want.length && crypto.timingSafeEqual(sent, want);
}

async function login(req, res) {
  if (!sameOrigin(req)) throw new HttpError(403, "The request was refused.");
  const ip = clientIp(req);
  const wait = loginWait(ip);
  if (wait) throw new HttpError(429, `Too many tries. Wait ${wait} s.`, { "Retry-After": String(wait) });
  const body = await readJson(req);
  const word = typeof body.password === "string" ? body.password.slice(0, WORD.max) : "";
  const auth = readAuth();
  if (!word || !(await checkWord(word, auth))) {
    const secs = noteFailure(ip);
    throw new HttpError(401, "The seal does not yield.", secs ? { "Retry-After": String(secs) } : undefined);
  }
  failures.delete(ip);
  const { token, csrf } = createSession(auth);
  sendJson(req, res, 200, { owner: true, csrf }, { "Set-Cookie": sessionCookie(token, CONFIG.sessionMs) });
}

async function changeWord(req, res, session) {
  const ip = clientIp(req);
  const wait = loginWait(ip);
  if (wait) throw new HttpError(429, `Too many tries. Wait ${wait} s.`, { "Retry-After": String(wait) });
  const body = await readJson(req);
  const auth = readAuth();
  if (!(await checkWord(typeof body.current === "string" ? body.current.slice(0, WORD.max) : "", auth))) {
    noteFailure(ip);
    throw new HttpError(401, "The current word is wrong.");
  }
  const problem = validWord(body.next);
  if (problem) throw new HttpError(400, problem);
  const next = await hashWord(body.next);
  writeAtomic(FILES.auth, JSON.stringify(next, null, 2) + "\n");
  sessions.clear(); // every session, here and elsewhere, is signed out
  const fresh = createSession(next);
  sendJson(req, res, 200, { owner: true, csrf: fresh.csrf }, { "Set-Cookie": sessionCookie(fresh.token, CONFIG.sessionMs) });
}

async function handle(req, res) {
  securityHeaders(res);
  let pathname;
  try { pathname = new URL(req.url, "http://localhost").pathname; } catch { return sendJson(req, res, 400, { error: "Bad request." }); }

  if (req.method === "GET" || req.method === "HEAD") {
    if (pathname === "/" || pathname === "/index.html") {
      const html = SITE.before + scriptJson(archive) + SITE.after;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(html) });
      return res.end(req.method === "HEAD" ? undefined : html);
    }
    if (pathname === "/" + SITE.model.name) {
      res.writeHead(200, { "Content-Type": "model/gltf-binary", "Cache-Control": "public, max-age=31536000, immutable", "Content-Length": SITE.model.body.length });
      return res.end(req.method === "HEAD" ? undefined : SITE.model.body);
    }
    if (pathname === "/api/session") {
      const s = sessionOf(req);
      return sendJson(req, res, 200, { owner: Boolean(s), csrf: s ? s.csrf : "" });
    }
    if (pathname === "/api/archive") return sendJson(req, res, 200, { archive });
    return sendJson(req, res, 404, { error: "Not found." });
  }

  if (!pathname.startsWith("/api/") || !["POST", "PUT", "DELETE"].includes(req.method)) {
    return sendJson(req, res, 405, { error: "Not allowed." }, { Allow: "GET, HEAD" });
  }
  if (req.method === "POST" && pathname === "/api/login") return login(req, res);

  const session = sessionOf(req);
  if (!session) throw new HttpError(401, "Unlock the archive first.");
  if (!sameOrigin(req) || !csrfOk(req, session)) throw new HttpError(403, "The request was refused.");

  if (req.method === "POST" && pathname === "/api/logout") {
    sessions.delete(session.key);
    return sendJson(req, res, 200, { owner: false }, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (req.method === "POST" && pathname === "/api/password") return changeWord(req, res, session);

  if (req.method === "POST" && pathname === "/api/records") {
    if (archive.records.length >= LIMIT.records) throw new HttpError(413, "The archive is full.");
    const rec = cleanRecord(await readJson(req));
    commit({ ...archive, records: [...archive.records, rec] });
    return sendJson(req, res, 200, { archive, id: rec.id });
  }
  if (req.method === "POST" && pathname === "/api/records/clear-examples") {
    commit({ ...archive, records: archive.records.filter((r) => !r.example) });
    return sendJson(req, res, 200, { archive });
  }
  const m = pathname.match(/^\/api\/records\/([^/]+)$/);
  if (m && validId(m[1])) {
    const prev = archive.records.find((r) => r.id === m[1]);
    if (!prev) throw new HttpError(404, "That record is gone.");
    if (req.method === "PUT") {
      const rec = cleanRecord(await readJson(req), prev);
      commit({ ...archive, records: archive.records.map((r) => (r.id === prev.id ? rec : r)) });
      return sendJson(req, res, 200, { archive, id: rec.id });
    }
    if (req.method === "DELETE") {
      commit({ ...archive, records: archive.records.filter((r) => r.id !== prev.id) });
      return sendJson(req, res, 200, { archive });
    }
  }
  throw new HttpError(404, "Not found.");
}

function serve() {
  ensureDataDir();
  loadArchive();
  SITE = loadSite();
  if (!readAuth()) console.warn("No keeper's word yet: nobody can log in until you run `node server/server.mjs set-password`.");
  if (CONFIG.secureCookie && !CONFIG.origin) console.warn("PUBLIC_ORIGIN is not set; writes will be checked against the Host header instead.");

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) return sendJson(req, res, err.status, { error: err.message }, err.headers);
      console.error(err);
      sendJson(req, res, 500, { error: "Something went wrong." });
    });
  });
  server.headersTimeout = 15e3;
  server.requestTimeout = 20e3;
  server.keepAliveTimeout = 5e3;
  server.listen(CONFIG.port, CONFIG.host, () => {
    const { address, port } = server.address();
    console.log(`Chalice Archive listening on http://${address.includes(":") ? `[${address}]` : address}:${port}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// ---------- set-password ----------
function readHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let word = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); stdout.write("\n");
          return resolve(word);
        }
        if (ch === "\u0003") { stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") word = word.slice(0, -1); else word += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readWords() {
  if (process.stdin.isTTY) return [await readHidden("Keeper's word: "), await readHidden("The word again: ")];
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const lines = text.split(/\r?\n/);
  return [lines[0] || "", lines.length > 1 && lines[1] !== "" ? lines[1] : lines[0] || ""];
}

async function setPassword() {
  ensureDataDir();
  const [word, again] = await readWords();
  const problem = validWord(word);
  if (problem) { console.error(problem); process.exit(1); }
  if (word !== again) { console.error("The two words don't match."); process.exit(1); }
  writeAtomic(FILES.auth, JSON.stringify(await hashWord(word), null, 2) + "\n");
  console.log(`The keeper's word is set (${FILES.auth}). Every existing session is signed out.`);
}

if (process.argv[2] === "set-password") await setPassword();
else if (process.argv[2]) { console.error(`Unknown command: ${process.argv[2]}`); process.exit(2); }
else serve();
