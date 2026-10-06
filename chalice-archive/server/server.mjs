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
                                           the address visitors use. Logins and writes must come from it.
     TRUST_PROXY=true                      take the client IP from X-Real-IP (set by Caddy), only from a loopback peer
     COOKIE_SECURE=false                   only for local testing over plain http
     SESSION_HOURS=12                      how long a login lasts

   Security, in short (deploy/README.md has the whole picture):
     - The keeper's word is stored only as a salted scrypt hash (N=2^17, r=8, p=1), set from the command line,
       so the web never offers a "choose a password" form an attacker could reach first.
     - A login gets a random 256-bit session token in an HttpOnly, SameSite=Strict, Secure cookie (__Host- prefix).
       The server keeps only the token's SHA-256. Changing the word signs every session out.
     - Writes need that session, its CSRF token in a header, a JSON body (or, for art, a PNG, JPEG, WebP or GIF
       image, or an MP4 or WebM video, whose bytes match its type) and an Origin equal to PUBLIC_ORIGIN.
     - Failed logins are throttled per client IP (rising waits) and overall.
     - The encounters' private sections are encrypted at rest with a key that only the keeper's word unwraps, and
       are never sent to visitors.
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

// ---------- the private key ----------
// The encounters' private sections are encrypted (AES-256-GCM) with one random 256-bit key. On disk that key exists
// only wrapped, in auth.json, by a second key derived from the keeper's word with scrypt; unwrapped, it lives only
// in memory, with each of the keeper's sessions. Whoever copies the data directory, backups included, gets
// ciphertext they can read only by guessing the word. A forgotten word takes the private sections with it.
const b64 = (buf) => buf.toString("base64");
const validBox = (b) => Boolean(b) && typeof b === "object" && ["iv", "tag", "data"].every((k) => typeof b[k] === "string")
  && Buffer.from(b.iv, "base64").length === 12 && Buffer.from(b.tag, "base64").length === 16;
const box = (b) => ({ iv: b.iv, tag: b.tag, data: b.data });
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
// The key for a new session: unwrapped with the word just checked, or made on the first login if there is none
// yet. One at a time, so two first logins cannot make two keys.
let keyChain = Promise.resolve();
function keeperKey(word) {
  const run = keyChain.then(async () => {
    const auth = readAuth();
    if (auth.key) return unwrapKey(word, auth.key);
    const key = crypto.randomBytes(32);
    writeAtomic(FILES.auth, JSON.stringify({ ...auth, key: await wrapKey(word, key) }, null, 2) + "\n");
    return key;
  });
  keyChain = run.catch(() => {});
  return run;
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
// Everything visitors may see: the archive without the encounters' private sections
function publicArchive() {
  return { ...archive, encounters: archive.encounters.map(({ private: _, ...e }) => e) };
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
  let i = 13;
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
    } else if (b === 0x21 && i + 2 < buf.length) { // an extension: its label, then its sub-blocks
      const label = buf[i + 1], app = buf.toString("latin1", i + 3, i + 14);
      i = blocks(i + 2);
      if (i < 0) return null;
      if (label === 0xf9 || (label === 0xff && (app === "NETSCAPE2.0" || app === "ANIMEXTS1.0"))) keep.push([start, i]);
    } else return null;
  }
  if (keep.length < 2) return null; // no image at all
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
  if (!top || !top.length || top[0][0] !== "ftyp" || top[0][3] < 16) return false;
  if (read(8, 4).toString("latin1") === "qt  " || !top.some((b) => b[0] === "moov")) return false;
  const META = ["udta", "meta"];
  for (const [type, pos, hdr, len] of top) {
    if (META.includes(type) || type === "uuid") { blank(pos, hdr, len); continue; }
    if (type !== "moov") continue;
    for (const [t, p, h, l] of boxes(pos + hdr, pos + len) || []) {
      if (META.includes(t)) blank(p, h, l);
      else if (t === "trak") for (const [t2, p2, h2, l2] of boxes(p + h, p + l) || []) if (META.includes(t2)) blank(p2, h2, l2);
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
  const encounters = (Array.isArray(raw && raw.encounters) ? raw.encounters : []).filter((e) => e && validId(e.id) && str(e.title, LIMIT.title)).slice(0, LIMIT.encounters)
    .map((e) => ({ ...cleanEncounter(e, { id: e.id, added: Number(e.added) || 0 }), example: Boolean(e.example), ...(validBox(e.private) ? { private: box(e.private) } : {}) }));
  const records = (Array.isArray(raw && raw.records) ? raw.records : []).filter((r) => r && validId(r.id) && str(r.title, LIMIT.title)).slice(0, LIMIT.records)
    .map((r) => ({ ...cleanRecord(r, { id: r.id, added: Number(r.added) || 0 }, encounters), example: Boolean(r.example) }));
  const galleries = (Array.isArray(raw && raw.galleries) ? raw.galleries : []).filter((g) => g && validId(g.id) && str(g.name, LIMIT.galleryName)).slice(0, LIMIT.galleries)
    .map((g) => ({ ...cleanGallery(g, { id: g.id, added: Number(g.added) || 0 }), example: Boolean(g.example) }));
  const art = (Array.isArray(raw && raw.art) ? raw.art : []).filter((a) => a && validId(a.id)).slice(0, LIMIT.art)
    .map((a) => ({ ...cleanArt(a, { id: a.id, added: Number(a.added) || 0 }, false, galleries), example: Boolean(a.example) })).filter((a) => a.versions.length);
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
      "media-src 'self' blob:", // the art's videos; blob: lets the keeper's browser look at a video before uploading it
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
  const { token, csrf } = createSession(auth, await keeperKey(word));
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
  const next = { ...(await hashWord(body.next)), key: await wrapKey(body.next, session.privateKey) }; // the same private key, under the new word
  writeAtomic(FILES.auth, JSON.stringify(next, null, 2) + "\n");
  sessions.clear(); // every session, here and elsewhere, is signed out
  const fresh = createSession(next, session.privateKey);
  sendJson(req, res, 200, { owner: true, csrf: fresh.csrf }, { "Set-Cookie": sessionCookie(fresh.token, CONFIG.sessionMs) });
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
    req.on("data", (c) => { size += c.length; if (size > limit) { fail(new HttpError(413, tooLarge)); req.destroy(); } });
    req.on("aborted", () => fail(new HttpError(400, "The upload was cut off.")));
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
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file, { start, end });
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
      const html = SITE.before + scriptJson(publicArchive()) + SITE.after;
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
    if (pathname === "/api/archive") return sendJson(req, res, 200, { archive: publicArchive() });
    // The encounters' private sections, decrypted, only for the keeper's session (and its CSRF token, so no other
    // page can make the browser fetch them). A section that cannot be decrypted comes back as null.
    if (pathname === "/api/private") {
      const s = sessionOf(req);
      if (!s) throw new HttpError(401, "Unlock the archive first.");
      if (!csrfOk(req, s)) throw new HttpError(403, "The request was refused.");
      const out = {};
      for (const e of archive.encounters) if (e.private) out[e.id] = openPrivate(s.privateKey, e.id, e.private);
      return sendJson(req, res, 200, { encounters: out });
    }
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
    return sendJson(req, res, 200, { archive: publicArchive(), id: rec.id });
  }
  if (req.method === "POST" && pathname === "/api/records/clear-examples") { // the example records and encounters
    const encounters = archive.encounters.filter((e) => !e.example);
    const records = archive.records.filter((r) => !r.example).map((r) => (encounters.some((e) => e.id === r.encounter) ? r : { ...r, encounter: "" }));
    commit({ ...archive, records, encounters });
    return sendJson(req, res, 200, { archive: publicArchive() });
  }
  if (req.method === "PUT" && pathname === "/api/about") {
    const body = await readJson(req, LIMIT.aboutBody).catch((e) => {
      throw e.status === 413 ? new HttpError(413, `The About page is too long to keep: ${LIMIT.aboutBody / 1024} KB in all.`) : e;
    });
    commit({ ...archive, profile: cleanProfile(body, archive.profile), about: cleanAbout(body) });
    return sendJson(req, res, 200, { archive: publicArchive() });
  }
  if (req.method === "POST" && pathname === "/api/uploads") return upload(req, res);
  if (req.method === "POST" && pathname === "/api/art") {
    if (archive.art.length >= LIMIT.art) throw new HttpError(413, "There is no room for more art pieces.");
    const plate = cleanArt(await readJson(req), null, true);
    commit({ ...archive, art: [plate, ...archive.art] }); // the newest plate comes first
    return sendJson(req, res, 200, { archive: publicArchive(), id: plate.id });
  }
  if (req.method === "POST" && pathname === "/api/art/order") {
    const ids = (await readJson(req)).ids;
    const byId = new Map(archive.art.map((a) => [a.id, a]));
    if (!Array.isArray(ids) || ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
      throw new HttpError(409, "The art pieces have changed. Reload and try again.");
    }
    commit({ ...archive, art: ids.map((id) => byId.get(id)) });
    return sendJson(req, res, 200, { archive: publicArchive() });
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
      return sendJson(req, res, 200, { archive: publicArchive(), id: plate.id });
    }
    if (req.method === "DELETE") {
      const art = archive.art.filter((a) => a.id !== prev.id);
      commit({ ...archive, art });
      sweepArt();
      return sendJson(req, res, 200, { archive: publicArchive() });
    }
  }
  // his forms: galleries of art pieces, in the keeper's order
  if (req.method === "POST" && pathname === "/api/galleries") {
    if (archive.galleries.length >= LIMIT.galleries) throw new HttpError(413, "There is no room for more forms.");
    const gallery = cleanGallery(await readJson(req));
    commit({ ...archive, galleries: [...archive.galleries, gallery] });
    return sendJson(req, res, 200, { archive: publicArchive(), id: gallery.id });
  }
  if (req.method === "POST" && pathname === "/api/galleries/order") {
    const ids = (await readJson(req)).ids;
    const byId = new Map(archive.galleries.map((g) => [g.id, g]));
    if (!Array.isArray(ids) || ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
      throw new HttpError(409, "The forms have changed. Reload and try again.");
    }
    commit({ ...archive, galleries: ids.map((id) => byId.get(id)) });
    return sendJson(req, res, 200, { archive: publicArchive() });
  }
  const gm = pathname.match(/^\/api\/galleries\/([^/]+)$/);
  if (gm && validId(gm[1])) {
    const prev = archive.galleries.find((g) => g.id === gm[1]);
    if (!prev) throw new HttpError(404, "That form is gone.");
    if (req.method === "PUT") {
      const gallery = cleanGallery(await readJson(req), prev);
      commit({ ...archive, galleries: archive.galleries.map((g) => (g.id === prev.id ? gallery : g)) });
      return sendJson(req, res, 200, { archive: publicArchive(), id: gallery.id });
    }
    if (req.method === "DELETE") { // only an empty one, so no art piece is lost with it
      if (archive.art.some((a) => a.gallery === prev.id)) throw new HttpError(409, "Move its art pieces to another form, or remove them, first.");
      commit({ ...archive, galleries: archive.galleries.filter((g) => g.id !== prev.id) });
      return sendJson(req, res, 200, { archive: publicArchive() });
    }
  }
  if (req.method === "POST" && pathname === "/api/encounters") {
    if (archive.encounters.length >= LIMIT.encounters) throw new HttpError(413, "There is no room for more encounters.");
    const body = await readJson(req, LIMIT.encounterBody);
    const enc = withPrivate(cleanEncounter(body), body.private, null, session.privateKey);
    commit({ ...archive, encounters: [...archive.encounters, enc] });
    return sendJson(req, res, 200, { archive: publicArchive(), id: enc.id });
  }
  const em = pathname.match(/^\/api\/encounters\/([^/]+)$/);
  if (em && validId(em[1])) {
    const prev = archive.encounters.find((e) => e.id === em[1]);
    if (!prev) throw new HttpError(404, "That encounter is gone.");
    if (req.method === "PUT") {
      const body = await readJson(req, LIMIT.encounterBody);
      const enc = withPrivate(cleanEncounter(body, prev), body.private, prev.private, session.privateKey);
      commit({ ...archive, encounters: archive.encounters.map((e) => (e.id === prev.id ? enc : e)) });
      return sendJson(req, res, 200, { archive: publicArchive(), id: enc.id });
    }
    if (req.method === "DELETE") { // records that named it keep their own words, without the link
      commit({ ...archive, encounters: archive.encounters.filter((e) => e.id !== prev.id),
        records: archive.records.map((r) => (r.encounter === prev.id ? { ...r, encounter: "" } : r)) });
      return sendJson(req, res, 200, { archive: publicArchive() });
    }
  }
  const m = pathname.match(/^\/api\/records\/([^/]+)$/);
  if (m && validId(m[1])) {
    const prev = archive.records.find((r) => r.id === m[1]);
    if (!prev) throw new HttpError(404, "That record is gone.");
    if (req.method === "PUT") {
      const rec = cleanRecord(await readJson(req), prev);
      commit({ ...archive, records: archive.records.map((r) => (r.id === prev.id ? rec : r)) });
      return sendJson(req, res, 200, { archive: publicArchive(), id: rec.id });
    }
    if (req.method === "DELETE") {
      commit({ ...archive, records: archive.records.filter((r) => r.id !== prev.id) });
      return sendJson(req, res, 200, { archive: publicArchive() });
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
  server.requestTimeout = 900e3; // a video upload over a slow connection takes a while (Cloudflare holds slow uploads back anyway)
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
  writeAtomic(FILES.auth, JSON.stringify(next, null, 2) + "\n");
  console.log(`The keeper's word is set (${FILES.auth}). Every existing session is signed out.` +
    (forget && prev && prev.key ? " The old private key is gone: private sections written before can no longer be read." : ""));
}

if (process.argv[2] === "set-password") await setPassword();
else if (process.argv[2]) { console.error(`Unknown command: ${process.argv[2]}`); process.exit(2); }
else serve();
