#!/usr/bin/env node
/* Chalice Archive server: serves the page, the model and the art, keeps the records, the About page, his forms
   and their art pieces, and lets the keeper write after logging in with the keeper's word. Node 20 or later; no dependencies
   beyond Node's own modules.

     node server/server.mjs                 serve the archive
     node server/server.mjs set-password    set or replace the keeper's word (asks twice, then for the current word once
                                           there are private sections; or those lines on stdin)
     node server/server.mjs set-password --forget-private
                                           replace a forgotten word; the private sections written so far are lost

   Environment:
     PORT=8080, HOST=127.0.0.1             where to listen. Keep it on loopback, behind Caddy.
     DATA_DIR=./server/data                records (archive.json), the password hash (auth.json), backups/, art/
     SITE_DIR=./dist                       the built page and model (python3 build.py)
     PUBLIC_ORIGIN=https://archive.example.com
                                           the address visitors use. Logins and writes must come from it. Required,
                                           except with COOKIE_SECURE=false; anything but an address stops the server.
     TRUST_PROXY=true                      take the client IP from X-Real-IP (set by Caddy), only from a loopback peer
     COOKIE_SECURE=false                   only for local testing over plain http
     SESSION_HOURS=12                      how long a login lasts, 1 to 720 (anything else stops the server, as does a bad PORT)

   Security, in short (deploy/README.md has the whole picture):
     - The keeper's word is stored only as a salted scrypt hash (N=2^17, r=8, p=1), set from the command line,
       so the web never offers a "choose a password" form an attacker could reach first.
     - A login gets a random 256-bit session token in an HttpOnly, SameSite=Strict, Secure cookie (__Host- prefix).
       The server keeps only the token's SHA-256. Changing the word signs every session out.
     - Writes need that session, its CSRF token in a header, a JSON body (or, for art, a PNG, JPEG, WebP or GIF
       image, or an MP4 or WebM video, whose bytes match its type) and an Origin equal to PUBLIC_ORIGIN.
     - Failed logins are throttled per client IP (an IPv6 address by its /64; rising waits) and overall, and each
       try counts the moment it is made, so parallel guesses gain nothing. The pause for everyone spares a browser
       that has spoken the right word before (a device cookie, signed, cancelled by a new word).
     - The encounters' private sections are encrypted at rest with a key that only the keeper's word unwraps, and
       are never sent to visitors.
     - Every field is validated and capped here; the page renders all of it as text.
     - Every response carries a strict Content-Security-Policy built from hashes of the page's own inline
       script and style, so no other inline code can run; scripts and fonts come only from this server (three.js
       and the fonts are served here, not from a CDN or Google), and Trusted Types forbid writing HTML into the page.
     - Only the page, the model, three.js, the fonts and the art the archive names are served, art only under its
       content hash. There is no static directory to wander through.
*/
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const env = process.env;

// A number from the environment, or the default when unset. Anything else stops the server: a mistyped
// SESSION_HOURS ("12h") would otherwise make every session last for ever.
function envNumber(name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.error(`${name} must be a number from ${min} to ${max}, not ${JSON.stringify(raw)}.`);
    process.exit(2);
  }
  return n;
}

// The site's address as a browser writes it in the Origin header ("https://archive.example.com": the host in lower
// case, no path). Anything else stops the server, since no write could ever match it.
function envOrigin(name) {
  const raw = env[name];
  if (!raw) return "";
  let u = null;
  try { u = new URL(raw); } catch {}
  if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    console.error(`${name} must be the site's address, such as https://archive.example.com, not ${JSON.stringify(raw)}.`);
    process.exit(2);
  }
  return u.origin;
}

const CONFIG = {
  port: Math.round(envNumber("PORT", 8080, 0, 65535)),
  host: env.HOST || "127.0.0.1",
  dataDir: path.resolve(env.DATA_DIR || path.join(HERE, "data")),
  siteDir: path.resolve(env.SITE_DIR || path.join(ROOT, "dist")),
  origin: envOrigin("PUBLIC_ORIGIN"),
  trustProxy: env.TRUST_PROXY === "true",
  secureCookie: env.COOKIE_SECURE !== "false",
  sessionMs: envNumber("SESSION_HOURS", 12, 1, 24 * 30) * 3600e3,
};

const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };
const WORD = { min: 12, max: 1024 };
const MiB = 1024 * 1024;
const LIMIT = {
  body: 64 * 1024, aboutBody: 256 * 1024, encounterBody: 160 * 1024, records: 5000, encounters: 2000, sessions: 50,
  upload: 8 * MiB, gif: 40 * MiB, video: 90 * MiB, // a still image (scaled down in the keeper's browser first), a GIF, a video
  story: 20000, private: 20000,
  title: 120, note: 4000, source: 160,
  galleries: 40, galleryName: 80,
  art: 500, versions: 12, files: 2000, side: 10000, artist: 80, link: 300, caption: 1000, label: 60,
  facts: 24, factLabel: 40, factValue: 400, sections: 24, heading: 120, section: 40000,
  traits: 24, pole: 40, glances: 5, glanceTitle: 80, glanceText: 1000,
};
// The About page follows a Total RP 3 profile. Its short text fields and their caps:
const ABOUT_TEXT = {
  title: 60, currently: 1000, ooc: 1000,
  race: 60, class: 60, age: 60, eyes: 60, height: 60, build: 60, birthplace: 120, residence: 120,
};
// Art is stored under the first 32 hex digits of its SHA-256, so its name changes with its content. A still image,
// a GIF or a video; every one of them also has a still (its thumbnail, or a video's poster), which is a still image.
const UPLOAD_TYPES = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" };
const ART_TYPES = { webp: "image/webp", jpg: "image/jpeg", png: "image/png", gif: "image/gif", mp4: "video/mp4", webm: "video/webm" };
const ART_FILE = /^[0-9a-f]{32}\.(webp|jpg|png|gif|mp4|webm)$/;
const STILL_FILE = /^[0-9a-f]{32}\.(webp|jpg|png)$/;
const isVideo = (name) => /\.(mp4|webm)$/.test(name);
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
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true }); // a full disk leaves no half-written temporary file behind
    throw err;
  }
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
      && Number.isInteger(a.N) && a.N >= 2 ** 14 && a.N <= 2 ** 20 && a.r >= 1 && a.r <= 32 && a.p >= 1 && a.p <= 4
      && (a.key === undefined || validWrapped(a.key)); // the private key, wrapped by the word, once there is one
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

// ---------- the private key ----------
// The encounters' private sections are encrypted (AES-256-GCM) with one random 256-bit key. On disk that key exists
// only wrapped, in auth.json, by a second key derived from the keeper's word with scrypt; unwrapped, it lives only
// in memory, with each of the keeper's sessions. Whoever copies the data directory, backups included, gets
// ciphertext they can read only by guessing the word. A forgotten word takes the private sections with it.
const b64 = (buf) => buf.toString("base64");
const validBox = (b) => Boolean(b) && typeof b === "object" && ["iv", "tag", "data"].every((k) => typeof b[k] === "string")
  && Buffer.from(b.iv, "base64").length === 12 && Buffer.from(b.tag, "base64").length === 16;
const box = (b) => ({ iv: b.iv, tag: b.tag, data: b.data });
const validWrapped = (w) => validBox(w) && typeof w.salt === "string" && Buffer.from(w.salt, "base64").length === 16;
function encrypt(key, plain, aad) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) };
}
// Throws if the key is wrong or the box was altered
function decrypt(key, b, aad) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(b.iv, "base64"));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(b.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(b.data, "base64")), d.final()]);
}
// Each private text is bound to its encounter's id, so it cannot be moved onto another encounter
const sealPrivate = (key, id, text) => encrypt(key, Buffer.from(text, "utf8"), "encounter:" + id);
function openPrivate(key, id, b) {
  try { return decrypt(key, b, "encounter:" + id).toString("utf8"); } catch { return null; }
}
const wordKey = (word, salt) => oneAtATime(() => scrypt(String(word).normalize("NFC"), salt, 32, SCRYPT));
async function wrapKey(word, key) {
  const salt = crypto.randomBytes(16);
  return { salt: b64(salt), ...encrypt(await wordKey(word, salt), key, "archive key") };
}
async function unwrapKey(word, wrapped) {
  return decrypt(await wordKey(word, Buffer.from(wrapped.salt, "base64")), wrapped, "archive key");
}

// auth.json is written by the first login (which makes the private key), by a change of the word from the page,
// and by set-password. Here those writes take turns, and each checks first that the word it was given is still the
// word on file (its generation): otherwise a login with a word that a change had just replaced would get a session
// that was already over, or fail on the key wrapped under the new word, and two first logins could make two keys.
let authChain = Promise.resolve();
function authTurn(fn) {
  const run = authChain.then(fn);
  authChain = run.catch(() => {});
  return run;
}
// auth.json as it is now, if it still holds the word that `auth` held; null once the word has changed
function stillWord(auth) {
  const now = readAuth();
  return now && now.generation === auth.generation ? now : null;
}
// The keeper's session, for a word just checked against `auth`: the private key is unwrapped with the word, or made
// on the first login. Null if the word was changed meanwhile, so it is not the word any more.
function unseal(word, auth) {
  return authTurn(async () => {
    let now = stillWord(auth), key;
    if (!now) return null;
    if (!now.key) {
      key = crypto.randomBytes(32);
      const wrapped = await wrapKey(word, key);
      now = stillWord(auth); // set-password may have run while the key was wrapped
      if (!now) return null;
      if (!now.key) writeAtomic(FILES.auth, JSON.stringify({ ...now, key: wrapped }, null, 2) + "\n");
    }
    if (now.key) {
      key = await unwrapKey(word, now.key).catch(() => {
        throw new Error("auth.json holds a private key the keeper's word does not open. `set-password --forget-private` lets it go.");
      });
      if (!stillWord(auth)) return null;
    }
    return createSession(auth, key);
  });
}

function validWord(word) {
  if (typeof word !== "string" || word.length < WORD.min) return `Use at least ${WORD.min} characters.`;
  if (word.length > WORD.max) return `Use at most ${WORD.max} characters.`;
  // An arrow key or Escape pressed while typing at set-password goes into the word, and no browser could send it back
  if (/[\u0000-\u001f\u007f]/.test(word)) return "The word cannot hold control characters, such as an arrow key or Escape pressed while typing it.";
  return "";
}

// ---------- the archive ----------
const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const today = () => new Date().toISOString().slice(0, 10);
// When something was added (ms since 1970): an archive restored or edited by hand may hold anything there, and a
// time no date can show would stop the page from listing anything
const stamp = (v) => { const n = Math.floor(Number(v)); return n >= 0 && n <= 8.64e15 ? n : 0; };
// A day that exists: Date.parse alone takes 2024-02-30 (and rolls it over into March)
const validDate = (d) => {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(d + "T00:00:00Z");
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(id);

// A record of something he knows: a title, his note, and where he learned it, in his own words, from one of the
// encounters (its id), or both. The date is optional.
function cleanRecord(input, prev, encounters = archive.encounters) {
  if (!input || typeof input !== "object") throw new HttpError(400, "The record is malformed.");
  const title = str(input.title, LIMIT.title);
  if (!title) throw new HttpError(400, "Give the record a title.");
  return {
    id: prev ? prev.id : "r" + crypto.randomBytes(9).toString("base64url"),
    title,
    note: str(input.note, LIMIT.note),
    source: str(input.source, LIMIT.source),
    encounter: typeof input.encounter === "string" && encounters.some((e) => e.id === input.encounter) ? input.encounter : "",
    date: validDate(input.date) ? input.date : "",
    added: prev ? prev.added : Date.now(),
    example: false,
  };
}

// ---------- encounters ----------
// An encounter: what happened, for everyone, and a private section only the keeper can read. The private text is
// encrypted before it is stored (sealPrivate, below), so archive.json and its backups hold only ciphertext, and
// visitors never receive it, not even encrypted (publicArchive).
function cleanEncounter(input, prev) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "The encounter is malformed.");
  const title = str(input.title, LIMIT.title);
  if (!title) throw new HttpError(400, "Give the encounter a title.");
  return {
    id: prev ? prev.id : "e" + crypto.randomBytes(9).toString("base64url"),
    title,
    date: validDate(input.date) ? input.date : "",
    text: str(input.text, LIMIT.story), // keeps TRP markup as text; only the page reads it
    added: prev ? prev.added : Date.now(),
    example: false,
  };
}
// A private text as sent: undefined keeps what was there, "" removes it, anything else replaces it, encrypted
function withPrivate(enc, text, prevBox, key) {
  if (text === undefined) return prevBox ? { ...enc, private: prevBox } : enc;
  const plain = str(text, LIMIT.private);
  return plain ? { ...enc, private: sealPrivate(key, enc.id, plain) } : enc;
}

// An encounter only for the keeper ("Only for me" on the page): all of it, its title, date, text and private
// section, is encrypted as one box bound to its id. Only its id and when it was added are stored in the clear.
// Visitors never receive it, not even that it exists (publicArchive), and records that name it lose the link there.
const SEALED = "sealed encounter:";
const sealEncounter = (key, id, fields) => encrypt(key, Buffer.from(JSON.stringify(fields), "utf8"), SEALED + id);
// Its fields, or null if it cannot be decrypted (the word was forgotten, or the box was moved onto another id)
function openSealed(key, e) {
  try {
    const f = JSON.parse(decrypt(key, e.sealed, SEALED + e.id).toString("utf8"));
    return { title: str(f.title, LIMIT.title) || "Untitled", date: validDate(f.date) ? f.date : "", text: str(f.text, LIMIT.story), private: str(f.private, LIMIT.private) };
  } catch { return null; }
}
// An encounter as sent, for everyone or only for the keeper (`sealed`; left out, it stays as it was). Its private
// text, left out, is kept: inside the box for a sealed one, as its own encrypted section for one everyone can read.
function encounterFrom(body, prev, key) {
  const enc = cleanEncounter(body, prev), wasSealed = Boolean(prev && prev.sealed);
  const sealed = body.sealed === undefined ? wasSealed : body.sealed === true;
  if (!sealed && !wasSealed) return withPrivate(enc, body.private, prev && prev.private, key);
  let text = body.private === undefined ? undefined : str(body.private, LIMIT.private);
  if (text === undefined && prev) text = wasSealed ? (openSealed(key, prev) || {}).private || "" : prev.private ? openPrivate(key, prev.id, prev.private) || "" : "";
  if (!sealed) return withPrivate(enc, text || "", null, key);
  return { id: enc.id, sealed: sealEncounter(key, enc.id, { title: enc.title, date: enc.date, text: enc.text, private: text || "" }), added: enc.added, example: false };
}

// Everything visitors may see: the archive without the encounters' private sections, without the encounters only
// for the keeper, and without records' links to those
function publicArchive() {
  const hidden = new Set(archive.encounters.filter((e) => e.sealed).map((e) => e.id));
  return {
    ...archive,
    encounters: archive.encounters.filter((e) => !e.sealed).map(({ private: _, ...e }) => e),
    records: archive.records.map((r) => (hidden.has(r.encounter) ? { ...r, encounter: "" } : r)),
  };
}
// What the keeper's session sees: everything, with the encounters only for the keeper decrypted, but still without
// the private sections, which the page asks for apart (GET /api/private)
function keeperArchive(key) {
  return {
    ...archive,
    encounters: archive.encounters.map(({ private: _, ...e }) => {
      if (!e.sealed) return e;
      const f = openSealed(key, e);
      return f ? { id: e.id, title: f.title, date: f.date, text: f.text, added: e.added, example: false, sealed: true }
        : { id: e.id, title: "An encounter that can no longer be read", date: "", text: "", added: e.added, example: false, sealed: true, unreadable: true };
    }),
  };
}

// ---------- the art ----------
// Width and height straight from the file's header, and which of the four types it really is
function imageInfo(buf) {
  if (buf.length >= 13 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return { ext: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
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

// A GIF keeps its frames, but not what else it can carry: comments, plain text and application blocks such as XMP
// are dropped; only the blocks that make it loop stay. Null if it is not a GIF that can be read to its end.
function cleanGif(buf) {
  const keep = [];
  let i = 13, images = 0;
  if (buf.length < 13 || !/^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return null;
  if (buf[10] & 0x80) i += 3 * 2 ** ((buf[10] & 7) + 1); // the global colour table
  keep.push([0, i]);
  const blocks = (at) => { // the data sub-blocks from `at`; where they end, or -1
    while (at < buf.length) { const n = buf[at]; if (!n) return at + 1; at += n + 1; }
    return -1;
  };
  while (i < buf.length) {
    const start = i, b = buf[i];
    if (b === 0x3b) break; // the trailer
    if (b === 0x2c) { // an image: its descriptor, its own colour table, the LZW code size, then its data
      if (i + 10 > buf.length) return null;
      i += 10;
      if (buf[i - 1] & 0x80) i += 3 * 2 ** ((buf[i - 1] & 7) + 1);
      i = blocks(i + 1);
      if (i < 0) return null;
      keep.push([start, i]);
      images += 1;
    } else if (b === 0x21 && i + 2 < buf.length) { // an extension: its label, then its sub-blocks
      const label = buf[i + 1], app = buf.toString("latin1", i + 3, i + 14);
      i = blocks(i + 2);
      if (i < 0) return null;
      if (label === 0xf9 || (label === 0xff && (app === "NETSCAPE2.0" || app === "ANIMEXTS1.0"))) keep.push([start, i]);
    } else return null;
  }
  if (!images) return null; // no image at all (blocks that only set how a frame is shown are not one)
  return Buffer.concat([...keep.map(([a, z]) => buf.subarray(a, z)), Buffer.from([0x3b])]);
}

// An MP4 keeps its pictures and sound, but not what else it can carry, such as where a phone recorded it: every
// udta and meta box (at the top, in moov and in each trak) and every top-level uuid box (XMP) becomes a free box
// of the same size, filled with zeros, so no offset in the file moves. Works on the file in place; false if it is
// not an MP4 (an ftyp box first, a moov box somewhere; QuickTime files are refused, as not every browser plays them).
function cleanMp4(fd, size) {
  const read = (pos, len) => { const b = Buffer.alloc(len); return fs.readSync(fd, b, 0, len, pos) === len ? b : null; };
  const zeros = Buffer.alloc(64 * 1024);
  const blank = (pos, hdr, len) => {
    fs.writeSync(fd, Buffer.from("free", "latin1"), 0, 4, pos + 4);
    for (let at = pos + hdr; at < pos + len; at += zeros.length) fs.writeSync(fd, zeros, 0, Math.min(zeros.length, pos + len - at), at);
  };
  // the boxes between start and end, each as [type, pos, header length, length]; null if they do not fit
  const boxes = (start, end) => {
    const out = [];
    for (let pos = start; pos < end;) {
      const h = end - pos >= 16 ? read(pos, 16) : end - pos >= 8 ? read(pos, 8) : null;
      if (!h) return null;
      let len = h.readUInt32BE(0), hdr = 8;
      if (len === 1) { if (h.length < 16) return null; len = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = end - pos;
      if (len < hdr || pos + len > end) return null;
      out.push([h.toString("latin1", 4, 8), pos, hdr, len]);
      pos += len;
      if (out.length > 100000) return null;
    }
    return out;
  };
  const top = boxes(0, size);
  if (!top || !top.length || top[0][0] !== "ftyp" || top[0][3] < top[0][2] + 8) return false;
  // its major brand follows its header, which is 16 bytes long when the box gives its size in 64 bits
  if (read(top[0][2], 4).toString("latin1") === "qt  " || !top.some((b) => b[0] === "moov")) return false;
  const META = ["udta", "meta"];
  for (const [type, pos, hdr, len] of top) {
    if (META.includes(type) || type === "uuid") { blank(pos, hdr, len); continue; }
    if (type !== "moov") continue;
    // a moov or trak whose boxes cannot be read is refused: its metadata could not be found to be blanked
    const inMoov = boxes(pos + hdr, pos + len);
    if (!inMoov) return false;
    for (const [t, p, h, l] of inMoov) {
      if (META.includes(t)) { blank(p, h, l); continue; }
      if (t !== "trak") continue;
      const inTrak = boxes(p + h, p + l);
      if (!inTrak) return false;
      for (const [t2, p2, h2, l2] of inTrak) if (META.includes(t2)) blank(p2, h2, l2);
    }
  }
  return true;
}

// A WebM file: an EBML header whose DocType is "webm"
function isWebm(fd) {
  const b = Buffer.alloc(64), n = fs.readSync(fd, b, 0, 64, 0);
  if (n < 8 || b.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const at = b.indexOf(Buffer.from([0x42, 0x82]), 4); // the DocType element; then its size, as an EBML number, and "webm"
  if (at < 0 || at + 3 > n || !b[at + 2]) return false;
  const len = Math.clz32(b[at + 2]) - 23; // the bytes the size takes: 1 for 0x8_, 2 for 0x4_ …
  let size = b[at + 2] & (0xff >> len);
  for (let k = 1; k < len; k++) size = size * 256 + b[at + 2 + k];
  return size === 4 && at + 2 + len + 4 <= n && b.toString("latin1", at + 2 + len, at + 6 + len) === "webm";
}

// An uploaded file a plate may use: a valid name, on disk, and of its type. A still is a PNG, JPEG or WebP image
// (a thumbnail, or a video's poster); its size comes from the file. A video's size comes from the keeper's browser.
function storedMedia(name, still) {
  if (typeof name !== "string" || !(still ? STILL_FILE : ART_FILE).test(name)) throw new HttpError(400, "Upload the image first.");
  if (isVideo(name)) {
    if (!fs.existsSync(path.join(FILES.art, name))) throw new HttpError(400, "That video is gone. Upload it again.");
    return { ext: name.split(".")[1] };
  }
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

// One image of a plate (a still image, a GIF or a video): its files and size come from `base`; its label, its
// mature flag and, for a video, whether it plays on a loop, from the request. A mature image stays hidden behind
// the page's age check.
const side = (n) => Math.min(LIMIT.side, Math.max(1, Math.round(Number(n)) || 1));
function versionOf(v, base) {
  return {
    id: base.id || "v" + crypto.randomBytes(6).toString("base64url"),
    file: base.file, thumb: base.thumb, width: side(base.width), height: side(base.height),
    label: str(v.label, LIMIT.label), mature: v.mature === true, loop: isVideo(base.file) && v.loop === true,
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
    const info = storedMedia(v.file), still = storedMedia(v.thumb, true);
    // a video's size is what the keeper's browser measured as it made the poster; a picture's comes from its file
    const size = isVideo(v.file) ? { width: v.width, height: v.height } : info;
    return versionOf(v, { id: was && was.id, file: v.file, thumb: v.thumb, width: size.width || still.width, height: size.height || still.height });
  });
  if (!out.length) throw new HttpError(400, "An art piece needs an image.");
  return out;
}

// A plate's images as stored. A plate saved before plates had several images kept its one image on itself.
function storedVersions(a) {
  return (Array.isArray(a.versions) ? a.versions : [{ ...a, id: undefined, label: "", mature: false }]).filter((v) => v && ART_FILE.test(v.file) && STILL_FILE.test(v.thumb)).slice(0, LIMIT.versions)
    .map((v) => versionOf(v, { ...v, id: validId(v.id) ? v.id : "v" + v.file.slice(0, 12) }));
}

// A plate (an "art piece" on the page). On a write (check) its images must have been uploaded, and their sizes are
// read from the files. It belongs to one of his forms (a gallery), or to none ("Other art" on the page).
function cleanArt(input, prev, check, galleries = archive.galleries) {
  if (!input || typeof input !== "object") throw new HttpError(400, "The art piece is malformed.");
  const versions = !check ? storedVersions(input) : input.versions === undefined && prev ? prev.versions : cleanVersions(input.versions, prev && prev.versions);
  let gallery = typeof input.gallery === "string" && galleries.some((g) => g.id === input.gallery) ? input.gallery : "";
  if (check && input.gallery === undefined && prev) gallery = prev.gallery;
  else if (check && input.gallery && !gallery) throw new HttpError(400, "That form is gone. Reload the page and choose another.");
  return {
    id: prev ? prev.id : "a" + crypto.randomBytes(9).toString("base64url"),
    gallery,
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

// One of his forms, such as "Vaelith (Dracthyr)" and "Vaelith (visage)": a gallery of the art pieces that show him so
function cleanGallery(input, prev) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "The form is malformed.");
  const name = str(input.name, LIMIT.galleryName);
  if (!name) throw new HttpError(400, "Give the form a name.");
  return { id: prev ? prev.id : "g" + crypto.randomBytes(9).toString("base64url"), name, added: prev ? prev.added : Date.now(), example: false };
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
  const encounters = (Array.isArray(raw && raw.encounters) ? raw.encounters : []).filter((e) => e && validId(e.id) && (validBox(e.sealed) || str(e.title, LIMIT.title))).slice(0, LIMIT.encounters)
    .map((e) => (validBox(e.sealed) ? { id: e.id, sealed: box(e.sealed), added: stamp(e.added), example: false }
      : { ...cleanEncounter(e, { id: e.id, added: stamp(e.added) }), example: Boolean(e.example), ...(validBox(e.private) ? { private: box(e.private) } : {}) }));
  const records = (Array.isArray(raw && raw.records) ? raw.records : []).filter((r) => r && validId(r.id) && str(r.title, LIMIT.title)).slice(0, LIMIT.records)
    .map((r) => ({ ...cleanRecord(r, { id: r.id, added: stamp(r.added) }, encounters), example: Boolean(r.example) }));
  const galleries = (Array.isArray(raw && raw.galleries) ? raw.galleries : []).filter((g) => g && validId(g.id) && str(g.name, LIMIT.galleryName)).slice(0, LIMIT.galleries)
    .map((g) => ({ ...cleanGallery(g, { id: g.id, added: stamp(g.added) }), example: Boolean(g.example) }));
  const art = (Array.isArray(raw && raw.art) ? raw.art : []).filter((a) => a && validId(a.id)).slice(0, LIMIT.art)
    .map((a) => ({ ...cleanArt(a, { id: a.id, added: stamp(a.added) }, false, galleries), example: Boolean(a.example) })).filter((a) => a.versions.length);
  return { profile: cleanProfile(p), about: cleanAbout(raw && raw.about), galleries, art, records, encounters };
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
  if (fs.existsSync(FILES.archive)) {
    let n = 0; // a second change in the same millisecond gets the next number, so no backup overwrites another
    while (fs.existsSync(path.join(FILES.backups, `archive-${stamp}-${n}.json`))) n++;
    fs.copyFileSync(FILES.archive, path.join(FILES.backups, `archive-${stamp}-${n}.json`), fs.constants.COPYFILE_EXCL);
  }
  const old = fs.readdirSync(FILES.backups).filter((f) => /^archive-.*\.json$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 50))) fs.unlinkSync(path.join(FILES.backups, f));
  writeAtomic(FILES.archive, JSON.stringify(next, null, 2) + "\n");
  archive = next;
  artFiles = filesOf(next);
  shared = null;
}

// What visitors get changes only with the archive, so the page and the archive as JSON are made once per change,
// not for every request: a visitor asking for them over and over costs a copy, not the whole archive serialized.
let shared = null;
function forVisitors() {
  if (!shared) {
    const pub = publicArchive();
    shared = { page: Buffer.from(SITE.before + scriptJson(pub) + SITE.after, "utf8"), json: Buffer.from(JSON.stringify({ archive: pub }), "utf8") };
  }
  return shared;
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
// Housekeeping: a sweep that fails (a directory it cannot read) is logged, and neither stops the server, as it would
// from the timer, nor turns a change already saved into an error.
function sweepArt() {
  try {
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
  } catch (err) {
    console.error("The sweep of unused art failed:", err);
  }
}

// ---------- sessions ----------
const sessions = new Map(); // sha256(token) -> { csrf, expires, generation, privateKey (in memory only) }
const COOKIE = CONFIG.secureCookie ? "__Host-ca_session" : "ca_session";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("base64url");

function createSession(auth, key) {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expires <= now) sessions.delete(k);
  while (sessions.size >= LIMIT.sessions) sessions.delete(sessions.keys().next().value); // oldest first
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(32).toString("base64url");
  sessions.set(sha256(token), { csrf, expires: now + CONFIG.sessionMs, generation: auth.generation, privateKey: key });
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

// ---------- the keeper's browsers ----------
// More than 50 wrong words in ten minutes, from anywhere, pause every login (loginWait), so that guesses spread over
// many addresses gain nothing. So that nobody can keep the keeper out that way, a browser that has spoken the right
// word carries a device cookie, signed with a key derived from the word's hash: a new word cancels every one of them
// (the browser it was changed in gets a new one). With it, a login does not wait for the misses from everywhere
// else, only for those from its own address.
const DEVICE = CONFIG.secureCookie ? "__Host-ca_device" : "ca_device";
const deviceMac = (auth, id) => crypto.createHmac("sha256", Buffer.from(crypto.hkdfSync("sha256", Buffer.from(auth.hash, "base64"), "", "chalice-archive device", 32)))
  .update(id).digest("base64url");
function deviceCookie(auth) {
  const id = crypto.randomBytes(16).toString("base64url");
  return `${DEVICE}=${id}.${deviceMac(auth, id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${400 * 86400}${CONFIG.secureCookie ? "; Secure" : ""}`;
}
function knownDevice(req, auth) {
  const [id, mac, more] = String(cookies(req)[DEVICE] || "").split(".");
  if (!auth || more !== undefined || !/^[A-Za-z0-9_-]{22}$/.test(id || "") || !/^[A-Za-z0-9_-]{43}$/.test(mac || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(deviceMac(auth, id)), Buffer.from(mac));
}

// ---------- login throttling ----------
const failures = new Map(); // ip -> { count, until, last }
let recentFailures = []; // timestamps of all failed logins, for the overall cap
const GLOBAL = { windowMs: 10 * 60e3, max: 50 };

function loginWait(ip, known) { // known: the keeper's browser (knownDevice), which the pause for everyone spares
  const now = Date.now();
  recentFailures = recentFailures.filter((t) => now - t < GLOBAL.windowMs);
  if (!known && recentFailures.length >= GLOBAL.max) return Math.ceil((recentFailures[0] + GLOBAL.windowMs - now) / 1000);
  const f = failures.get(ip);
  return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
}

function noteFailure(ip, now = Date.now()) {
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

function refuseWhileWaiting(ip, known) {
  const wait = loginWait(ip, known);
  if (wait) throw new HttpError(429, `Too many tries. Wait ${wait} s.`, { "Retry-After": String(wait) });
}
// A try at the word counts as a failure from the moment it is made, and is forgiven once the word proves right.
// The wait is checked and the try counted together, with nothing awaited in between, so a burst of parallel tries
// cannot all slip past the wait before the first of them has failed.
function beginTry(ip, known) {
  refuseWhileWaiting(ip, known);
  const at = Date.now();
  return { ip, at, secs: noteFailure(ip, at) };
}
function forgive(t) {
  failures.delete(t.ip);
  const i = recentFailures.indexOf(t.at);
  if (i >= 0) recentFailures.splice(i, 1);
}

// What failed logins are counted against: an IPv4 address, or an IPv6 address's /64, since one client usually
// holds a whole /64 and could otherwise take a fresh address for every guess
function throttleKey(ip) {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1];
  if (!net.isIPv6(ip)) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const a = head ? head.split(":") : [], b = tail ? tail.split(":") : [];
  const groups = tail === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
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
  // The files the page names, each by its hash, so they can be cached for good: the model, three.js and the fonts
  const files = new Map();
  const named = (re, type, what) => {
    const names = new Set([...page.matchAll(re)].map((m) => m[1]));
    if (!names.size) throw new Error(`${pagePath} does not name ${what}; run python3 build.py`);
    for (const name of names) files.set(name, { type, body: fs.readFileSync(path.join(CONFIG.siteDir, name)) });
  };
  named(/"(chalice\.[0-9a-f]{12}\.glb)"/g, "model/gltf-binary", "a model file");
  named(/"\.\/(three\.[0-9a-f]{12}\.js)"/g, "text/javascript; charset=utf-8", "its three.js file");
  named(/url\(([a-z0-9-]+\.[0-9a-f]{12}\.woff2)\)/g, "font/woff2", "its fonts");
  return {
    before: parts[0], after: parts[1],
    files,
    csp: [
      "default-src 'none'",
      // The page's own script, by its hash, and three.js, which the site serves itself ('self': nothing else here is
      // served as JavaScript, and every response says nosniff). No CDN can run code in the page.
      `script-src ${appHash} 'self'`,
      // The page's own style, and its fonts, which the site serves too: nothing is asked of any other host
      `style-src ${styleHash}`,
      "font-src 'self'",
      "img-src 'self' data:",
      "media-src 'self' blob:", // the art's videos; blob: lets the keeper's browser look at a video before uploading it
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      // The page builds every element with createElement and textContent, never from HTML, so browsers that
      // support Trusted Types refuse any HTML or script sink (innerHTML, eval …) outright
      "require-trusted-types-for 'script'",
      "trusted-types 'none'",
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
// Powerful browser features the page never uses are switched off for it (full screen stays, for the video player)
const PERMISSIONS = ["accelerometer", "browsing-topics", "camera", "display-capture", "geolocation", "gyroscope", "hid",
  "identity-credentials-get", "idle-detection", "magnetometer", "microphone", "midi", "payment", "publickey-credentials-get", "screen-wake-lock",
  "serial", "usb", "xr-spatial-tracking"].map((f) => f + "=()").join(", ");

function securityHeaders(res) {
  res.setHeader("Content-Security-Policy", SITE.csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", PERMISSIONS);
  if (CONFIG.secureCookie) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function sendJson(req, res, status, body, headers = {}) { // body: a value, or JSON made already, as a Buffer
  const text = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": text.length, ...headers });
  res.end(req.method === "HEAD" ? undefined : text);
}

// The body, at most `limit` bytes. With `deadlineMs`, a body still arriving after that long is refused, so a client
// cannot hold a connection open by sending a small body a byte at a time (the server's own timeout is long, for videos).
// A body refused half way gets its answer at once; serve() lets go of the connection soon after.
function readBody(req, limit, tooLarge = "That is too large.", deadlineMs = 0) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) return reject(new HttpError(413, tooLarge));
    const chunks = [];
    let size = 0, done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const timer = deadlineMs ? setTimeout(() => finish(new HttpError(408, "The request took too long.")), deadlineMs) : null;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { finish(new HttpError(413, tooLarge)); return; }
      chunks.push(c);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks)));
    req.on("error", (err) => finish(err));
    req.on("close", () => finish(new HttpError(400, "The request was cut off.")));
  });
}

async function readJson(req, limit = LIMIT.body) {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) throw new HttpError(415, "Send JSON.");
  const body = await readBody(req, limit, undefined, 60e3);
  let value;
  try { value = JSON.parse(body.toString("utf8") || "{}"); } catch { throw new HttpError(400, "The request is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "The request is malformed.");
  return value;
}

// Writes must come from the archive's own address: the browser's Origin header, which pages cannot forge.
// PUBLIC_ORIGIN is required with Secure cookies (serve()); only plain http on this machine falls back to the Host header.
function sameOrigin(req) {
  const expected = CONFIG.origin || `http://${req.headers.host}`;
  return req.headers.origin === expected;
}

function csrfOk(req, session) {
  const sent = Buffer.from(String(req.headers["x-csrf-token"] || ""));
  const want = Buffer.from(session.csrf);
  return sent.length === want.length && crypto.timingSafeEqual(sent, want);
}

async function login(req, res) {
  if (!sameOrigin(req)) throw new HttpError(403, "The request was refused.");
  const ip = throttleKey(clientIp(req)), known = knownDevice(req, readAuth());
  refuseWhileWaiting(ip, known);
  const body = await readJson(req);
  const word = typeof body.password === "string" ? body.password.slice(0, WORD.max) : "";
  const auth = readAuth();
  const attempt = beginTry(ip, known);
  // a word that was the word when it was checked, but was changed before the session began, is refused like any other
  const session = word && (await checkWord(word, auth)) ? await unseal(word, auth) : null;
  if (!session) throw new HttpError(401, "The seal does not yield.", attempt.secs ? { "Retry-After": String(attempt.secs) } : undefined);
  forgive(attempt);
  sendJson(req, res, 200, { owner: true, csrf: session.csrf }, { "Set-Cookie": [sessionCookie(session.token, CONFIG.sessionMs), deviceCookie(auth)] });
}

async function changeWord(req, res, session) {
  const ip = throttleKey(clientIp(req));
  refuseWhileWaiting(ip, true); // it needs the session already: only its own address's misses hold it back
  const body = await readJson(req);
  const auth = readAuth();
  if (!auth || auth.generation !== session.generation) throw new HttpError(401, "Unlock the archive first."); // changed while the request came in
  const attempt = beginTry(ip, true);
  if (!(await checkWord(typeof body.current === "string" ? body.current.slice(0, WORD.max) : "", auth))) {
    throw new HttpError(401, "The current word is wrong.");
  }
  forgive(attempt);
  const problem = validWord(body.next);
  if (problem) throw new HttpError(400, problem);
  const next = { ...(await hashWord(body.next)), key: await wrapKey(body.next, session.privateKey) }; // the same private key, under the new word
  const fresh = await authTurn(() => {
    if (!stillWord(auth)) throw new HttpError(401, "Unlock the archive first."); // the word was changed elsewhere meanwhile
    writeAtomic(FILES.auth, JSON.stringify(next, null, 2) + "\n");
    sessions.clear(); // every session, here and elsewhere, is signed out
    return createSession(next, session.privateKey);
  });
  sendJson(req, res, 200, { owner: true, csrf: fresh.csrf }, { "Set-Cookie": [sessionCookie(fresh.token, CONFIG.sessionMs), deviceCookie(next)] });
}

// A file for an art piece: the raw bytes, sent with their own type. The page scales and re-encodes still images
// before sending them (which also drops their metadata); GIFs and videos come as they are, and lose their metadata
// here. The type is read from the bytes, and the size and the dimensions are checked.
async function upload(req, res) {
  const ext = UPLOAD_TYPES[String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase()];
  if (!ext) throw new HttpError(415, "Send an image (PNG, JPEG, WebP or GIF) or a video (MP4 or WebM).");
  roomForArt();
  if (ext === "mp4" || ext === "webm") return uploadVideo(req, res, ext);
  const limit = ext === "gif" ? LIMIT.gif : LIMIT.upload;
  let body = await readBody(req, limit, `That ${ext === "gif" ? "GIF" : "image"} is too large. The limit is ${limit / MiB} MB.`);
  const info = imageInfo(body);
  if (!info || info.ext !== ext) throw new HttpError(415, "That file is not the image it claims to be.");
  if (!(info.width >= 1 && info.height >= 1 && info.width <= LIMIT.side && info.height <= LIMIT.side)) {
    throw new HttpError(400, `An image can be at most ${LIMIT.side} pixels on a side.`);
  }
  if (ext === "gif" && !(body = cleanGif(body))) throw new HttpError(415, "That GIF could not be read to its end.");
  const name = crypto.createHash("sha256").update(body).digest("hex").slice(0, 32) + "." + ext;
  const file = path.join(FILES.art, name);
  if (fs.existsSync(file)) touch(file);
  else writeAtomic(file, body);
  sendJson(req, res, 200, { file: name, width: info.width, height: info.height });
}
function roomForArt() {
  if (fs.readdirSync(FILES.art).length >= LIMIT.files) sweepArt();
  if (fs.readdirSync(FILES.art).length >= LIMIT.files) throw new HttpError(507, "There is no room for more images.");
}
function touch(file) { const now = new Date(); fs.utimesSync(file, now, now); } // a fresh upload: the sweep leaves it alone for another day

// A video is too large to hold in memory: it goes to a temporary file (which the sweep removes if it is ever left
// behind), its metadata is blanked there, and it is renamed after the hash of what is left.
async function uploadVideo(req, res, ext) {
  const tooLarge = `That video is too large. The limit is ${LIMIT.video / MiB} MB.`;
  if (Number(req.headers["content-length"] || 0) > LIMIT.video) throw new HttpError(413, tooLarge);
  const tmp = path.join(FILES.art, `.upload-${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    const size = await receive(req, tmp, LIMIT.video, tooLarge);
    const fd = fs.openSync(tmp, "r+");
    try {
      if (!(ext === "mp4" ? cleanMp4(fd, size) : isWebm(fd))) throw new HttpError(415, "That file is not the video it claims to be.");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(tmp)) hash.update(chunk);
    const name = hash.digest("hex").slice(0, 32) + "." + ext, file = path.join(FILES.art, name);
    if (fs.existsSync(file)) { touch(file); fs.rmSync(tmp, { force: true }); } else fs.renameSync(tmp, file);
    sendJson(req, res, 200, { file: name });
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
// The request's body into `file`, at most `limit` bytes; resolves with its size
function receive(req, file, limit, tooLarge) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: "wx", mode: 0o600 });
    let size = 0, done = false;
    const fail = (err) => { if (done) return; done = true; req.unpipe(out); out.destroy(); reject(err); };
    req.on("data", (c) => { size += c.length; if (size > limit) fail(new HttpError(413, tooLarge)); }); // answered at once; serve() lets go of the rest
    req.on("aborted", () => fail(new HttpError(400, "The upload was cut off.")));
    req.on("close", () => { if (!req.complete) fail(new HttpError(400, "The upload was cut off.")); });
    req.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => { if (!done) { done = true; resolve(size); } });
    req.pipe(out);
  });
}

function sendArt(req, res, name) {
  const file = path.join(FILES.art, name);
  let st = null;
  try { st = fs.statSync(file); } catch {}
  if (!artFiles.has(name) || !st || !st.isFile()) return sendJson(req, res, 404, { error: "Not found." });
  // Named by content, so browsers keep it for good; Cloudflare's copy expires within a day once a plate is removed
  const headers = { "Content-Type": ART_TYPES[name.split(".")[1]], "Cache-Control": "public, max-age=31536000, s-maxage=86400, immutable", "Accept-Ranges": "bytes" };
  // One byte range, as a video player asks for to seek (and Safari, to play at all): "bytes=a-b", "bytes=a-", "bytes=-n"
  let start = 0, end = st.size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || "").trim());
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); } else start = Math.max(0, st.size - Number(range[2]));
    if (start > end || start >= st.size || !range[1] && Number(range[2]) === 0) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}`, "Content-Length": 0 });
      return res.end();
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  }
  res.writeHead(status, { ...headers, "Content-Length": end - start + 1 });
  if (req.method === "HEAD") return res.end();
  // pipeline closes the file when the visitor goes away half way (pipe() kept it open for good, one more for every
  // download stopped early, until the server ran out of files it could open), and ends the answer if the file fails
  return new Promise((resolve) => { pipeline(fs.createReadStream(file, { start, end }), res, () => resolve()); });
}

async function handle(req, res) {
  securityHeaders(res);
  let pathname;
  try { pathname = new URL(req.url, "http://localhost").pathname; } catch { return sendJson(req, res, 400, { error: "Bad request." }); }

  if (req.method === "GET" || req.method === "HEAD") {
    if (pathname === "/" || pathname === "/index.html") {
      const html = forVisitors().page;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": html.length });
      return res.end(req.method === "HEAD" ? undefined : html);
    }
    const file = SITE.files.get(pathname.slice(1)); // the model, three.js or a font, by the exact name the page gives it
    if (file) {
      res.writeHead(200, { "Content-Type": file.type, "Cache-Control": "public, max-age=31536000, immutable", "Content-Length": file.body.length });
      return res.end(req.method === "HEAD" ? undefined : file.body);
    }
    if (pathname === "/api/session") {
      const s = sessionOf(req);
      return sendJson(req, res, 200, { owner: Boolean(s), csrf: s ? s.csrf : "" });
    }
    if (pathname === "/api/archive") return sendJson(req, res, 200, forVisitors().json);
    // The encounters' private sections, decrypted, and the archive as the keeper sees it, with the encounters only
    // for the keeper; only for the keeper's session (and its CSRF token, so no other page can make the browser fetch
    // them). A private section that cannot be decrypted comes back as null.
    if (pathname === "/api/private") {
      const s = sessionOf(req);
      if (!s) throw new HttpError(401, "Unlock the archive first.");
      if (!csrfOk(req, s)) throw new HttpError(403, "The request was refused.");
      const out = {};
      for (const e of archive.encounters) {
        if (e.sealed) { const f = openSealed(s.privateKey, e); if (!f) out[e.id] = null; else if (f.private) out[e.id] = f.private; }
        else if (e.private) out[e.id] = openPrivate(s.privateKey, e.id, e.private);
      }
      return sendJson(req, res, 200, { encounters: out, archive: keeperArchive(s.privateKey) });
    }
    const art = pathname.match(/^\/art\/([^/]+)$/);
    if (art && ART_FILE.test(art[1])) return sendArt(req, res, art[1]);
    return sendJson(req, res, 404, { error: "Not found." });
  }

  if (!pathname.startsWith("/api/") || !["POST", "PUT", "DELETE"].includes(req.method)) {
    throw new HttpError(405, "Not allowed.", { Allow: "GET, HEAD" });
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
    return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey), id: rec.id });
  }
  if (req.method === "POST" && pathname === "/api/records/clear-examples") { // the example records and encounters
    const encounters = archive.encounters.filter((e) => !e.example);
    const records = archive.records.filter((r) => !r.example).map((r) => (encounters.some((e) => e.id === r.encounter) ? r : { ...r, encounter: "" }));
    commit({ ...archive, records, encounters });
    return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey) });
  }
  if (req.method === "PUT" && pathname === "/api/about") {
    const body = await readJson(req, LIMIT.aboutBody).catch((e) => {
      throw e.status === 413 ? new HttpError(413, `The About page is too long to keep: ${LIMIT.aboutBody / 1024} KB in all.`) : e;
    });
    commit({ ...archive, profile: cleanProfile(body, archive.profile), about: cleanAbout(body) });
    return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey) });
  }
  if (req.method === "POST" && pathname === "/api/uploads") return upload(req, res);
  if (req.method === "POST" && pathname === "/api/art") {
    if (archive.art.length >= LIMIT.art) throw new HttpError(413, "There is no room for more art pieces.");
    const plate = cleanArt(await readJson(req), null, true);
    commit({ ...archive, art: [plate, ...archive.art] }); // the newest plate comes first
    return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey), id: plate.id });
  }
  if (req.method === "POST" && pathname === "/api/art/order") {
    const ids = (await readJson(req)).ids;
    const byId = new Map(archive.art.map((a) => [a.id, a]));
    if (!Array.isArray(ids) || ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
      throw new HttpError(409, "The art pieces have changed. Reload and try again.");
    }
    commit({ ...archive, art: ids.map((id) => byId.get(id)) });
    return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey) });
  }
  const pm = pathname.match(/^\/api\/art\/([^/]+)$/);
  if (pm && validId(pm[1])) {
    const prev = archive.art.find((a) => a.id === pm[1]);
    if (!prev) throw new HttpError(404, "That art piece is gone.");
    if (req.method === "PUT") {
      const plate = cleanArt(await readJson(req), prev, true);
      const art = archive.art.map((a) => (a.id === prev.id ? plate : a));
      commit({ ...archive, art });
      sweepArt();
      return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey), id: plate.id });
    }
    if (req.method === "DELETE") {
      const art = archive.art.filter((a) => a.id !== prev.id);
      commit({ ...archive, art });
      sweepArt();
      return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey) });
    }
  }
  // his forms: galleries of art pieces, in the keeper's order
  if (req.method === "POST" && pathname === "/api/galleries") {
    if (archive.galleries.length >= LIMIT.galleries) throw new HttpError(413, "There is no room for more forms.");
    const gallery = cleanGallery(await readJson(req));
    commit({ ...archive, galleries: [...archive.galleries, gallery] });
    return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey), id: gallery.id });
  }
  if (req.method === "POST" && pathname === "/api/galleries/order") {
    const ids = (await readJson(req)).ids;
    const byId = new Map(archive.galleries.map((g) => [g.id, g]));
    if (!Array.isArray(ids) || ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
      throw new HttpError(409, "The forms have changed. Reload and try again.");
    }
    commit({ ...archive, galleries: ids.map((id) => byId.get(id)) });
    return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey) });
  }
  const gm = pathname.match(/^\/api\/galleries\/([^/]+)$/);
  if (gm && validId(gm[1])) {
    const prev = archive.galleries.find((g) => g.id === gm[1]);
    if (!prev) throw new HttpError(404, "That form is gone.");
    if (req.method === "PUT") {
      const gallery = cleanGallery(await readJson(req), prev);
      commit({ ...archive, galleries: archive.galleries.map((g) => (g.id === prev.id ? gallery : g)) });
      return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey), id: gallery.id });
    }
    if (req.method === "DELETE") { // only an empty one, so no art piece is lost with it
      if (archive.art.some((a) => a.gallery === prev.id)) throw new HttpError(409, "Move its art pieces to another form, or remove them, first.");
      commit({ ...archive, galleries: archive.galleries.filter((g) => g.id !== prev.id) });
      return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey) });
    }
  }
  if (req.method === "POST" && pathname === "/api/encounters") {
    if (archive.encounters.length >= LIMIT.encounters) throw new HttpError(413, "There is no room for more encounters.");
    const body = await readJson(req, LIMIT.encounterBody);
    const enc = encounterFrom(body, null, session.privateKey);
    commit({ ...archive, encounters: [...archive.encounters, enc] });
    return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey), id: enc.id });
  }
  const em = pathname.match(/^\/api\/encounters\/([^/]+)$/);
  if (em && validId(em[1])) {
    const prev = archive.encounters.find((e) => e.id === em[1]);
    if (!prev) throw new HttpError(404, "That encounter is gone.");
    if (req.method === "PUT") {
      const body = await readJson(req, LIMIT.encounterBody);
      const enc = encounterFrom(body, prev, session.privateKey);
      commit({ ...archive, encounters: archive.encounters.map((e) => (e.id === prev.id ? enc : e)) });
      return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey), id: enc.id });
    }
    if (req.method === "DELETE") { // records that named it keep their own words, without the link
      commit({ ...archive, encounters: archive.encounters.filter((e) => e.id !== prev.id),
        records: archive.records.map((r) => (r.encounter === prev.id ? { ...r, encounter: "" } : r)) });
      return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey) });
    }
  }
  const m = pathname.match(/^\/api\/records\/([^/]+)$/);
  if (m && validId(m[1])) {
    const prev = archive.records.find((r) => r.id === m[1]);
    if (!prev) throw new HttpError(404, "That record is gone.");
    if (req.method === "PUT") {
      const rec = cleanRecord(await readJson(req), prev);
      commit({ ...archive, records: archive.records.map((r) => (r.id === prev.id ? rec : r)) });
      return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey), id: rec.id });
    }
    if (req.method === "DELETE") {
      commit({ ...archive, records: archive.records.filter((r) => r.id !== prev.id) });
      return sendJson(req, res, 200, { archive: keeperArchive(session.privateKey) });
    }
  }
  throw new HttpError(404, "Not found.");
}

function serve() {
  // Logins and writes are checked against the site's own address. Without it, the server would have to take the
  // Host header's word for what that is; only plain http on this machine (COOKIE_SECURE=false) may do without.
  if (CONFIG.secureCookie && !CONFIG.origin.startsWith("https://")) {
    console.error("Set PUBLIC_ORIGIN to the site's https address, such as https://archive.example.com. " +
      "(For plain http on this machine only: COOKIE_SECURE=false.)");
    process.exit(2);
  }
  ensureDataDir();
  loadArchive();
  artFiles = filesOf(archive);
  sweepArt();
  setInterval(sweepArt, 6 * 3600e3).unref();
  SITE = loadSite();
  if (!readAuth()) console.warn("No keeper's word yet: nobody can log in until you run `node server/server.mjs set-password`.");

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.destroy(); return; }
      // A body refused before it was read (an upload without a session) or half way is read and thrown away only for
      // a while, long enough for the client to take in the answer, not for as long as a video upload may take
      if (!req.complete) { // (still arriving: the next request on the connection cannot have begun)
        const cut = setTimeout(() => { if (!req.complete) req.socket.destroy(); }, 10e3), keep = () => clearTimeout(cut);
        cut.unref();
        req.once("end", keep).once("close", keep);
      }
      if (err instanceof HttpError) return sendJson(req, res, err.status, { error: err.message }, err.headers);
      console.error(err);
      sendJson(req, res, 500, { error: "Something went wrong." });
    });
  });
  server.headersTimeout = 15e3;
  server.requestTimeout = 900e3; // a video upload over a slow connection takes a while (Cloudflare holds slow uploads back anyway)
  // Caddy keeps an idle connection to this server for 2 minutes, then closes it. Were this server to close it first,
  // Caddy could send a request down it at that very moment, and a login, a save or an upload would fail with a 502
  // (only a request that is safe to send twice, such as a GET, is tried again). So this server waits longer, and
  // Caddy always lets go first.
  server.keepAliveTimeout = 130e3;
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

// The new word twice, then, while there is a private key to carry over, the current word. On stdin: one per line.
async function readWords(withCurrent) {
  if (process.stdin.isTTY) {
    const words = [await readHidden("Keeper's word: "), await readHidden("The word again: ")];
    if (withCurrent) words.push(await readHidden("The current word, to keep the private sections readable: "));
    return words;
  }
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const lines = text.split(/\r?\n/);
  return [lines[0] || "", lines.length > 1 && lines[1] !== "" ? lines[1] : lines[0] || "", lines[2] || ""];
}

// Sets the word. The private key is carried over to the new word, which needs the current one; with
// --forget-private it is let go instead, and the private sections written so far can no longer be read.
async function setPassword() {
  // Only as the server's own user: auth.json written by anyone else (root, through sudo) is a file the server cannot
  // read, so nobody could unseal the archive, and directories made here would be ones it cannot write
  if (typeof process.getuid === "function" && fs.existsSync(CONFIG.dataDir) && fs.statSync(CONFIG.dataDir).uid !== process.getuid()) {
    console.error(`${CONFIG.dataDir} belongs to another user. Run set-password as that user, such as:\n` +
      `  sudo -u chalice env DATA_DIR=${CONFIG.dataDir} node ${fileURLToPath(import.meta.url)} set-password`);
    process.exit(1);
  }
  ensureDataDir();
  const prev = readAuth(), forget = process.argv.includes("--forget-private"), carry = Boolean(prev && prev.key) && !forget;
  const [word, again, current] = await readWords(carry);
  const problem = validWord(word);
  if (problem) { console.error(problem); process.exit(1); }
  if (word !== again) { console.error("The two words don't match."); process.exit(1); }
  const next = await hashWord(word);
  if (carry) {
    let key = null;
    if (await checkWord(current, prev)) key = await unwrapKey(current, prev.key).catch(() => null);
    if (!key) {
      console.error("That is not the current word, so the private sections could not be carried over. Nothing was changed.\n" +
        "If the word is lost, run set-password --forget-private: the encounters' private sections written so far will no longer be readable.");
      process.exit(1);
    }
    next.key = await wrapKey(word, key);
  }
  // The server may have written auth.json while the words were typed: the keeper's first login makes the private
  // key, and the word can be changed from the page. Writing over that would lose it, and with the key every
  // private section written since.
  if (JSON.stringify(readAuth()) !== JSON.stringify(prev)) {
    console.error("The keeper's word or the private key changed on the server while you typed. Nothing was changed; run set-password again.");
    process.exit(1);
  }
  writeAtomic(FILES.auth, JSON.stringify(next, null, 2) + "\n");
  console.log(`The keeper's word is set (${FILES.auth}). Every existing session is signed out.` +
    (forget && prev && prev.key ? " The old private key is gone: private sections written before can no longer be read." : ""));
}

if (process.argv[2] === "set-password") await setPassword();
else if (process.argv[2]) { console.error(`Unknown command: ${process.argv[2]}`); process.exit(2); }
else serve();
