#!/usr/bin/env node
/* Chalice Archive server: serves the page, the model and the art, keeps the records, the About page and the
   plates, and lets the keeper write after logging in with the keeper's word. Node 20 or later; no dependencies
   beyond Node's own modules.

     node server/server.mjs                 serve the archive
     node server/server.mjs set-password    set or replace the keeper's word (asks twice; or two lines on stdin)

   Environment:
     PORT=8080, HOST=127.0.0.1             where to listen. Keep it on loopback, behind Caddy.
     DATA_DIR=./server/data                records (archive.json), the password hash (auth.json), backups/, art/
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
     - Writes need that session, its CSRF token in a header, a JSON body (or, for art, a PNG, JPEG or WebP image
       whose bytes match its type) and an Origin equal to PUBLIC_ORIGIN.
     - Failed logins are throttled per client IP (rising waits) and overall.
     - Every field is validated and capped here; the page renders all of it as text.
     - Every response carries a strict Content-Security-Policy built from hashes of the page's own inline
       script and style, so no other inline code can run.
     - Only the page, the model and the art the archive names are served, art only under its content hash.
       There is no static directory to wander through.
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
const LIMIT = {
  body: 64 * 1024, aboutBody: 256 * 1024, upload: 8 * 1024 * 1024, records: 5000, sessions: 50,
  title: 120, domain: 60, note: 4000, source: 160,
  art: 500, versions: 12, files: 2000, side: 10000, artist: 80, link: 300, caption: 1000, label: 60,
  facts: 24, factLabel: 40, factValue: 400, sections: 24, heading: 120, section: 40000,
  traits: 24, pole: 40, glances: 5, glanceTitle: 80, glanceText: 1000,
};
// The About page follows a Total RP 3 profile. Its short text fields and their caps:
const ABOUT_TEXT = {
  title: 60, currently: 1000, ooc: 1000,
  race: 60, class: 60, age: 60, eyes: 60, height: 60, build: 60, birthplace: 120, residence: 120,
};
const STATUSES = ["remembered", "superseded", "relearned", "fragment", "sought"];
// Art is stored as uploaded, under the first 32 hex digits of its SHA-256, so its name changes with its content
const IMAGE_TYPES = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };
const ART_TYPES = { webp: "image/webp", jpg: "image/jpeg", png: "image/png" };
const ART_FILE = /^[0-9a-f]{32}\.(webp|jpg|png)$/;
const ART_GRACE_MS = 24 * 3600e3; // an upload no plate uses is kept this long before the sweep removes it
const FILES = {
  archive: path.join(CONFIG.dataDir, "archive.json"),
  auth: path.join(CONFIG.dataDir, "auth.json"),
  backups: path.join(CONFIG.dataDir, "backups"),
  art: path.join(CONFIG.dataDir, "art"),
  seed: path.join(ROOT, "src", "seed.json"),
};

class HttpError extends Error {
  constructor(status, message, headers) { super(message); this.status = status; this.headers = headers; }
}

// ---------- files ----------
function ensureDataDir() {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(FILES.backups, { recursive: true, mode: 0o700 });
  fs.mkdirSync(FILES.art, { recursive: true, mode: 0o700 });
}

// Write to a temporary file, flush it to disk, then rename over the target: a crash never leaves half a file.
function writeAtomic(file, text) { // text: a string or a Buffer
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

// ---------- the art ----------
// Width and height straight from the file's header, and which of the three types it really is
function imageInfo(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString("latin1", 12, 16) === "IHDR") {
    return { ext: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8 " && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) return { ext: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && buf[20] === 0x2f) { const b = buf.readUInt32LE(21); return { ext: "webp", width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 }; }
    if (chunk === "VP8X") return { ext: "webp", width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    for (let i = 2; i + 9 < buf.length;) { // walk the segments to the frame header
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      if (m === 0xff) { i += 1; continue; }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { ext: "jpg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// An uploaded file a plate may use: a valid name, on disk, and an image
function storedImage(name) {
  if (typeof name !== "string" || !ART_FILE.test(name)) throw new HttpError(400, "Upload the image first.");
  let info = null;
  try { info = imageInfo(fs.readFileSync(path.join(FILES.art, name))); } catch {}
  if (!info) throw new HttpError(400, "That image is gone. Upload it again.");
  return info;
}

// Only http(s) addresses, so a link can never run script; "artstation.com/x" becomes "https://artstation.com/x"
function cleanLink(v) {
  const s = str(v, LIMIT.link);
  if (!s) return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "https://" + s);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") && u.href.length <= LIMIT.link ? u.href : "";
  } catch { return ""; }
}

// One image of a plate: its files and size come from `base`; its label and mature flag from the request.
// A mature image stays hidden behind the page's age check.
const side = (n) => Math.min(LIMIT.side, Math.max(1, Math.round(Number(n)) || 1));
function versionOf(v, base) {
  return {
    id: base.id || "v" + crypto.randomBytes(6).toString("base64url"),
    file: base.file, thumb: base.thumb, width: side(base.width), height: side(base.height),
    label: str(v.label, LIMIT.label), mature: v.mature === true,
  };
}

// A plate's images as sent, in their new order; the first is the main image. One that names an image of the plate
// keeps that image's files unless it brings new ones; any other must name uploaded files.
function cleanVersions(input, prev) {
  const old = new Map((prev || []).map((v) => [v.id, v]));
  const used = new Set();
  const out = (Array.isArray(input) ? input : []).filter((v) => v && typeof v === "object").slice(0, LIMIT.versions).map((v) => {
    const was = typeof v.id === "string" && !used.has(v.id) ? old.get(v.id) : undefined;
    if (was) used.add(was.id);
    if (was && v.file === undefined) return versionOf(v, was);
    const info = storedImage(v.file);
    storedImage(v.thumb);
    return versionOf(v, { id: was && was.id, file: v.file, thumb: v.thumb, width: info.width, height: info.height });
  });
  if (!out.length) throw new HttpError(400, "A plate needs an image.");
  return out;
}

// A plate's images as stored. A plate saved before plates had several images kept its one image on itself.
function storedVersions(a) {
  return (Array.isArray(a.versions) ? a.versions : [{ ...a, id: undefined, label: "", mature: false }]).filter((v) => v && ART_FILE.test(v.file) && ART_FILE.test(v.thumb)).slice(0, LIMIT.versions)
    .map((v) => versionOf(v, { ...v, id: validId(v.id) ? v.id : "v" + v.file.slice(0, 12) }));
}

// A plate. On a write (check) its images must have been uploaded, and their sizes are read from the files.
function cleanArt(input, prev, check) {
  if (!input || typeof input !== "object") throw new HttpError(400, "The plate is malformed.");
  const versions = !check ? storedVersions(input) : input.versions === undefined && prev ? prev.versions : cleanVersions(input.versions, prev && prev.versions);
  return {
    id: prev ? prev.id : "a" + crypto.randomBytes(9).toString("base64url"),
    versions,
    title: str(input.title, LIMIT.title),
    artist: str(input.artist, LIMIT.artist),
    link: cleanLink(input.link),
    date: validDate(input.date) ? input.date : today(),
    note: str(input.note, LIMIT.caption),
    added: prev ? prev.added : Date.now(),
    example: false,
  };
}

// The About page, laid out like a Total RP 3 profile: a short title, what he is
// doing now and an OOC note, the directory (race, class, age …), additional information (the particulars, label
// and value), personality traits (two opposites and a value from 0, all left, to 20, all right), up to five things
// seen at first glance, and the description in sections. Section text keeps TRP's markup; the page renders it.
function cleanAbout(input) {
  const a = input && typeof input === "object" ? input : {};
  const list = (v) => (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object");
  const color = (c) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : "");
  const out = {};
  for (const [key, max] of Object.entries(ABOUT_TEXT)) out[key] = str(a[key], max);
  out.eyeColor = color(a.eyeColor);
  out.facts = list(a.facts).map((f) => ({ label: str(f.label, LIMIT.factLabel), value: str(f.value, LIMIT.factValue) }))
    .filter((f) => f.label || f.value).slice(0, LIMIT.facts);
  out.traits = list(a.traits).map((t) => {
    const v = Math.round(Number(t.value));
    return { left: str(t.left, LIMIT.pole), right: str(t.right, LIMIT.pole), value: Number.isFinite(v) ? Math.min(20, Math.max(0, v)) : 10 };
  }).filter((t) => t.left || t.right).slice(0, LIMIT.traits);
  out.glances = list(a.glances).map((g) => ({ title: str(g.title, LIMIT.glanceTitle), text: str(g.text, LIMIT.glanceText) }))
    .filter((g) => g.title || g.text).slice(0, LIMIT.glances);
  // a section's heading may have its own colour; "" is TRP's gold
  out.sections = list(a.sections).map((x) => ({ heading: str(x.heading, LIMIT.heading), body: str(x.body, LIMIT.section), color: color(x.color) }))
    .filter((x) => x.heading || x.body).slice(0, LIMIT.sections);
  return out;
}

function cleanProfile(p, prev = {}) {
  return {
    name: str(p.name, 60) || "Unnamed Dracthyr", epithet: str(p.epithet, 280),
    construct: str(p.construct ?? prev.construct, 60), constructNote: str(p.constructNote ?? prev.constructNote, 400),
  };
}

function cleanArchive(raw) {
  const p = (raw && raw.profile) || {};
  const records = (Array.isArray(raw && raw.records) ? raw.records : []).filter((r) => r && validId(r.id) && str(r.title, LIMIT.title)).slice(0, LIMIT.records)
    .map((r) => ({ ...cleanRecord(r, { id: r.id, added: Number(r.added) || 0 }), example: Boolean(r.example) }));
  const art = (Array.isArray(raw && raw.art) ? raw.art : []).filter((a) => a && validId(a.id)).slice(0, LIMIT.art)
    .map((a) => ({ ...cleanArt(a, { id: a.id, added: Number(a.added) || 0 }, false), example: Boolean(a.example) })).filter((a) => a.versions.length);
  return { profile: cleanProfile(p), about: cleanAbout(raw && raw.about), art, records };
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
  artFiles = filesOf(next);
}

// Art files are served only while a plate uses them. The sweep removes a file once neither the archive nor any
// of its backups uses it and it has been left alone for a day, so restoring a backup always finds its images.
let artFiles = new Set();
function filesOf(a) {
  const out = new Set();
  for (const x of (a && Array.isArray(a.art) ? a.art : [])) {
    for (const v of x && Array.isArray(x.versions) ? x.versions : [x]) if (v) { out.add(v.file); out.add(v.thumb); }
  }
  return out;
}
function sweepArt() {
  const keep = filesOf(archive);
  for (const f of fs.readdirSync(FILES.backups)) {
    if (!/^archive-.*\.json$/.test(f)) continue;
    try { for (const x of filesOf(JSON.parse(fs.readFileSync(path.join(FILES.backups, f), "utf8")))) keep.add(x); } catch {}
  }
  const cutoff = Date.now() - ART_GRACE_MS;
  for (const f of fs.readdirSync(FILES.art)) {
    if (keep.has(f)) continue;
    const file = path.join(FILES.art, f);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch {}
  }
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

function readBody(req, limit, tooLarge = "That is too large.") {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) return reject(new HttpError(413, tooLarge));
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, tooLarge)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit = LIMIT.body) {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) throw new HttpError(415, "Send JSON.");
  const body = await readBody(req, limit);
  let value;
  try { value = JSON.parse(body.toString("utf8") || "{}"); } catch { throw new HttpError(400, "The request is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "The request is malformed.");
  return value;
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

// An image for a plate: the raw bytes, sent with their own type. The page scales and re-encodes images before
// sending them (which also drops their metadata); here the type, the size and the dimensions are checked.
async function upload(req, res) {
  const ext = IMAGE_TYPES[String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase()];
  if (!ext) throw new HttpError(415, "Send a PNG, JPEG or WebP image.");
  const body = await readBody(req, LIMIT.upload, `That image is too large. The limit is ${LIMIT.upload / 1024 / 1024} MB.`);
  const info = imageInfo(body);
  if (!info || info.ext !== ext) throw new HttpError(415, "That file is not the image it claims to be.");
  if (!(info.width >= 1 && info.height >= 1 && info.width <= LIMIT.side && info.height <= LIMIT.side)) {
    throw new HttpError(400, `An image can be at most ${LIMIT.side} pixels on a side.`);
  }
  const name = crypto.createHash("sha256").update(body).digest("hex").slice(0, 32) + "." + ext;
  const file = path.join(FILES.art, name);
  if (fs.existsSync(file)) {
    const now = new Date();
    fs.utimesSync(file, now, now); // a fresh upload: the sweep leaves it alone for another day
  } else {
    if (fs.readdirSync(FILES.art).length >= LIMIT.files) sweepArt();
    if (fs.readdirSync(FILES.art).length >= LIMIT.files) throw new HttpError(507, "There is no room for more images.");
    writeAtomic(file, body);
  }
  sendJson(req, res, 200, { file: name, width: info.width, height: info.height });
}

function sendArt(req, res, name) {
  const file = path.join(FILES.art, name);
  let st = null;
  try { st = fs.statSync(file); } catch {}
  if (!artFiles.has(name) || !st || !st.isFile()) return sendJson(req, res, 404, { error: "Not found." });
  // Named by content, so browsers keep it for good; Cloudflare's copy expires within a day once a plate is removed
  res.writeHead(200, { "Content-Type": ART_TYPES[name.split(".")[1]], "Content-Length": st.size, "Cache-Control": "public, max-age=31536000, s-maxage=86400, immutable" });
  if (req.method === "HEAD") return res.end();
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file);
    stream.on("error", () => { res.destroy(); resolve(); });
    res.on("close", resolve);
    stream.pipe(res);
  });
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
    const art = pathname.match(/^\/art\/([^/]+)$/);
    if (art && ART_FILE.test(art[1])) return sendArt(req, res, art[1]);
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
  if (req.method === "PUT" && pathname === "/api/about") {
    const body = await readJson(req, LIMIT.aboutBody).catch((e) => {
      throw e.status === 413 ? new HttpError(413, `The About page is too long to keep: ${LIMIT.aboutBody / 1024} KB in all.`) : e;
    });
    commit({ ...archive, profile: cleanProfile(body, archive.profile), about: cleanAbout(body) });
    return sendJson(req, res, 200, { archive });
  }
  if (req.method === "POST" && pathname === "/api/uploads") return upload(req, res);
  if (req.method === "POST" && pathname === "/api/art") {
    if (archive.art.length >= LIMIT.art) throw new HttpError(413, "There is no room for more plates.");
    const plate = cleanArt(await readJson(req), null, true);
    commit({ ...archive, art: [plate, ...archive.art] }); // the newest plate comes first
    return sendJson(req, res, 200, { archive, id: plate.id });
  }
  if (req.method === "POST" && pathname === "/api/art/order") {
    const ids = (await readJson(req)).ids;
    const byId = new Map(archive.art.map((a) => [a.id, a]));
    if (!Array.isArray(ids) || ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
      throw new HttpError(409, "The plates have changed. Reload and try again.");
    }
    commit({ ...archive, art: ids.map((id) => byId.get(id)) });
    return sendJson(req, res, 200, { archive });
  }
  const pm = pathname.match(/^\/api\/art\/([^/]+)$/);
  if (pm && validId(pm[1])) {
    const prev = archive.art.find((a) => a.id === pm[1]);
    if (!prev) throw new HttpError(404, "That plate is gone.");
    if (req.method === "PUT") {
      const plate = cleanArt(await readJson(req), prev, true);
      const art = archive.art.map((a) => (a.id === prev.id ? plate : a));
      commit({ ...archive, art });
      sweepArt();
      return sendJson(req, res, 200, { archive, id: plate.id });
    }
    if (req.method === "DELETE") {
      const art = archive.art.filter((a) => a.id !== prev.id);
      commit({ ...archive, art });
      sweepArt();
      return sendJson(req, res, 200, { archive });
    }
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
  artFiles = filesOf(archive);
  sweepArt();
  setInterval(sweepArt, 6 * 3600e3).unref();
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
  server.requestTimeout = 120e3; // an image upload over a slow connection takes a while
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
