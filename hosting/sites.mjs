#!/usr/bin/env node
/* sites: the sites on this VPS. Each is a folder in /srv/sites, served by its own server behind Caddy, at a domain of
   its own. Node 20 or later; no dependencies. hosting/README.md has the whole setup.

     sudo sites setup <login>             once: installs the service template, Caddy's configuration and this command,
                                          and lets <login>, the account you sign in with, put folders in /srv/sites
     sudo sites link <folder> <domain>    puts /srv/sites/<folder> online at https://<domain> (again: moves it there),
                                          its certificate from Let's Encrypt, from Cloudflare, or your own:
                                          --letsencrypt, --cloudflare, or --cert <file> --key <file> (else as it was,
                                          or as the certificates in /etc/caddy/certs say; else Let's Encrypt)
     sudo sites restart <folder>          after a new version of the folder has been put in place
     sudo sites password <folder>         sets or replaces the site's keeper's word; with --forget-private, a
                                          forgotten one (the private sections written so far are lost)
     sudo sites unlink <folder>           takes the site offline; its folder and its data stay
     sites list                           every site: its address, port and state

   A site's folder is a whole site, made from chalice-archive/ (hosting/README.md, "Making a site"): it must hold
   server/server.mjs, which serves it, and dist/index.html, its built page. Each site runs as a user of its own,
   site-<folder>, keeps its data in /var/lib/sites/<folder> and listens on a port of its own on loopback, which
   /etc/sites/<folder>.env gives along with its address and how it has its certificate (TLS=). Caddy sends
   https://<domain> there, from /etc/caddy/sites/<folder>.caddy:
     - letsencrypt: visitors come straight here; Caddy gets the certificate from Let's Encrypt and renews it;
     - own: visitors come straight here; your certificate, copied to /etc/caddy/certs/<domain>.pem and .key;
     - cloudflare: visitors come through Cloudflare's proxy, and only Cloudflare gets in (its client certificate);
       a Cloudflare Origin Certificate in /etc/caddy/certs that covers the domain.

   For tests: SITES_ROOT puts every path under another directory, SITES_DRY_RUN=1 shows the system's commands
   (useradd, systemctl, runuser, caddy …) instead of running them, SITES_FIRST_PORT is the first port handed out, and
   SITES_HOSTS (JSON: {"name": ["address", …]}) stands in for DNS.
*/
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // hosting/ in the checkout, where this file really is
const env = process.env;
const ROOT = env.SITES_ROOT ? path.resolve(env.SITES_ROOT) : "/";
const at = (p) => path.join(ROOT, p);
const PATHS = {
  sites: at("/srv/sites"), env: at("/etc/sites"), caddy: at("/etc/caddy"), caddySites: at("/etc/caddy/sites"), certs: at("/etc/caddy/certs"),
  data: at("/var/lib/sites"), unit: at("/etc/systemd/system/site@.service"), bin: at("/usr/local/bin/sites"),
};
const CADDYFILE = path.join(PATHS.caddy, "Caddyfile");
const PULL_CA = path.join(PATHS.certs, "cloudflare-origin-pull-ca.pem");
const PULL_CA_URL = "https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem";
const DRY = env.SITES_DRY_RUN === "1";
const FIRST_PORT = Number(env.SITES_FIRST_PORT || 8081);
const NODE = "/usr/bin/node"; // as site@.service runs it
const NAME = /^[a-z][a-z0-9_-]{0,26}$/; // it also names the site's user, site-<folder>, which may have 32 characters
const MARK = "Installed by `sites setup`"; // in hosting/Caddyfile's first line
// How a site has its certificate (TLS= in its file), each with the snippet of the same name in hosting/Caddyfile
const WAYS = { letsencrypt: "Let's Encrypt", own: "own certificate", cloudflare: "Cloudflare" };

class Fail extends Error {}

// ---------- the system ----------
// A command of the system's. A dry run only shows it.
function system(cmd, args, inherit = false) {
  if (DRY) {
    console.log(`  [dry run] ${[cmd, ...args].join(" ")}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: inherit ? "inherit" : "pipe" });
  if (r.error) throw new Fail(`${cmd} could not be run: ${r.error.message}`);
  return r;
}
function must(cmd, args, what) {
  const r = system(cmd, args);
  if (r.status !== 0) throw new Fail(`${what} failed:\n${(r.stderr || r.stdout || "").trim()}`);
  return r;
}
function asRoot() {
  if (ROOT === "/" && process.getuid() !== 0) throw new Fail("Run it with sudo: it changes the system's services and Caddy's configuration.");
}
function getent(db, key) {
  const r = spawnSync("getent", [db, key], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(":") : null;
}
// Owner and group by name ("root", "caddy", a login); without a group, the user's own
function own(file, user, group) {
  if (DRY) return console.log(`  [dry run] chown ${user}${group ? ":" + group : ""} ${file}`);
  const u = getent("passwd", user), g = group ? getent("group", group) : u;
  if (!u || !g) throw new Fail(`There is no ${u ? "group" : "user"} ${u ? group : user}.`);
  fs.chownSync(file, Number(u[2]), Number(group ? g[2] : u[3]));
}

// ---------- files ----------
function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
// Written whole or not at all: a half-written configuration never reaches systemd or Caddy
function writeFile(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.new-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
function mkdir(dir, mode, user = "root", group = "root") {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, mode);
  own(dir, user, group);
}

// A site's environment file: KEY=value lines (systemd's EnvironmentFile), comments and lines of the owner's own kept
function envFile(name) { return path.join(PATHS.env, `${name}.env`); }
function getVar(lines, key) {
  for (const line of lines || []) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === key) return m[2].replace(/^"(.*)"$/, "$1");
  }
  return "";
}
function setVar(lines, key, value) { // in place of the key's line (only one is kept), or at the end
  const out = [];
  let done = false;
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || m[1] !== key) out.push(line);
    else if (!done) { out.push(`${key}=${value}`); done = true; }
  }
  if (!done) out.push(`${key}=${value}`);
  return out;
}

// Every linked site, from /etc/sites: { name, domain, port, way }
function linked() {
  let files = [];
  try { files = fs.readdirSync(PATHS.env); } catch {}
  return files.filter((f) => f.endsWith(".env") && NAME.test(f.slice(0, -4))).sort().map((f) => {
    const lines = readText(path.join(PATHS.env, f)).split("\n");
    return { name: f.slice(0, -4), domain: getVar(lines, "PUBLIC_ORIGIN").replace(/^https:\/\//, ""), port: Number(getVar(lines, "PORT")) || 0, way: getVar(lines, "TLS") };
  });
}

// ---------- checks ----------
function checkName(name) {
  if (!name) usage();
  if (!NAME.test(name)) {
    throw new Fail(`"${name}" cannot name a site: a folder's name must be lower-case letters, digits, - and _, start with a letter and have at most 27 characters (it also names the site's user, site-<folder>). Rename the folder in ${PATHS.sites}.`);
  }
}
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
function checkDomain(raw) {
  if (!raw) usage();
  const domain = String(raw).toLowerCase().replace(/\.$/, "");
  if (/[/:@]/.test(domain)) throw new Fail(`Give the domain alone, such as archive.example.com: no https://, path or port (not "${raw}").`);
  const labels = domain.split(".");
  if (domain.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^[0-9]+$/.test(labels[labels.length - 1])) {
    throw new Fail(`"${raw}" is not a domain such as archive.example.com.`);
  }
  return domain;
}
function installed() {
  if (!fs.existsSync(PATHS.unit) || !(readText(CADDYFILE) || "").includes(MARK)) {
    throw new Fail("The sites are not set up on this machine yet: run sudo sites setup <login> first (hosting/README.md).");
  }
}
// The site's folder, which must be a whole site
function folder(name) {
  const dir = path.join(PATHS.sites, name);
  let real = null;
  try { real = fs.realpathSync(dir); } catch {}
  if (!real || !fs.statSync(real).isDirectory()) throw new Fail(`There is no folder ${dir}. Put the site's folder there first.`);
  for (const file of ["server/server.mjs", "dist/index.html"]) {
    if (!fs.existsSync(path.join(dir, file))) {
      throw new Fail(`${dir} is not a whole site: it has no ${file}. A site's folder is a copy of chalice-archive/, with its page built (python3 build.py) and dist/ in it.`);
    }
  }
  // The service cannot see these (ProtectHome)
  if (ROOT === "/" && /^\/(home|root|run\/user)(\/|$)/.test(real)) {
    throw new Fail(`${dir} is in ${real}, which the site's service cannot see. Put the folder itself in ${PATHS.sites}, or under /opt.`);
  }
  return dir;
}
// Cloudflare's Origin Certificates are trusted by Cloudflare alone, not by browsers
const fromOriginCa = (cert) => /cloudflare origin/i.test(cert.issuer);
const day = (d) => d.toISOString().slice(0, 10);
// The certificates in /etc/caddy/certs that cover the domain, each with its key beside it (<name>.pem and <name>.key):
// one named for the domain first, then the one that runs longest. What keeps the others out goes into notes.
function certsFor(domain) {
  let files = [];
  try { files = fs.readdirSync(PATHS.certs).filter((f) => f.endsWith(".pem")).sort(); } catch {}
  const usable = [], notes = [];
  for (const f of files) {
    let cert;
    try { cert = new crypto.X509Certificate(fs.readFileSync(path.join(PATHS.certs, f))); } catch { continue; }
    if (cert.ca || !cert.checkHost(domain)) continue;
    if (!/^[A-Za-z0-9._-]+\.pem$/.test(f)) { notes.push(`"${f}" covers ${domain}, but its name would not fit in Caddy's configuration: rename it ${domain}.pem, and its key ${domain}.key.`); continue; }
    const keyFile = path.join(PATHS.certs, f.replace(/\.pem$/, ".key"));
    let key = null;
    try { key = crypto.createPrivateKey(fs.readFileSync(keyFile)); } catch {}
    const until = new Date(cert.validTo);
    if (!key) notes.push(`${f} covers ${domain}, but its key, ${path.basename(keyFile)}, is missing or cannot be read.`);
    else if (!cert.checkPrivateKey(key)) notes.push(`${f} covers ${domain}, but ${path.basename(keyFile)} is not its key.`);
    else if (until <= new Date()) notes.push(`${f} covers ${domain}, but it ran out on ${day(until)}.`);
    else usable.push({ cert: path.join(PATHS.certs, f), key: keyFile, until, named: f === `${domain}.pem`, origin: fromOriginCa(cert) });
  }
  usable.sort((a, b) => b.named - a.named || b.until - a.until);
  return { usable, notes };
}
// Your own certificate (the full chain, as fullchain.pem holds it) and its key, checked, then copied to
// /etc/caddy/certs/<domain>.pem and .key, where Caddy can read them. Returns what is worth saying about it.
function installOwn(domain, certFile, keyFile) {
  const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch (e) { throw new Fail(`Cannot read ${file} (${e.code || e.message}).`); } };
  const pem = read(certFile), keyPem = read(keyFile);
  let cert, key;
  try { cert = new crypto.X509Certificate(pem); } catch { throw new Fail(`${certFile} is not a certificate in PEM format.`); }
  try { key = crypto.createPrivateKey(keyPem); } catch { throw new Fail(`${keyFile} is not a private key in PEM format.`); }
  if (!cert.checkHost(domain)) throw new Fail(`${certFile} does not cover ${domain}; it is for ${(cert.subjectAltName || cert.subject).replace(/DNS:/g, "")}.`);
  if (fromOriginCa(cert)) {
    throw new Fail(`${certFile} is a Cloudflare Origin Certificate, which browsers trust only through Cloudflare. Save it in ${PATHS.certs} and link the site with --cloudflare, or give a certificate from a public authority, or use --letsencrypt.`);
  }
  if (!cert.checkPrivateKey(key)) throw new Fail(`${keyFile} is not the key of ${certFile}.`);
  if (new Date(cert.validTo) <= new Date()) throw new Fail(`${certFile} ran out on ${day(new Date(cert.validTo))}.`);
  const target = path.join(PATHS.certs, domain);
  writeFile(`${target}.pem`, pem.replace(/\s*$/, "\n"), 0o640);
  writeFile(`${target}.key`, keyPem.replace(/\s*$/, "\n"), 0o640);
  const chain = (pem.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
  return chain === 1 && cert.issuer !== cert.subject
    ? `${certFile} holds the certificate alone, without its authority's intermediate certificate: some browsers will not trust it. Give the full chain (often fullchain.pem) next time.`
    : "";
}
// Cloudflare's CA for Authenticated Origin Pulls, which Caddy checks Cloudflare's client certificate against
function isCert(pem) {
  try { return !!new crypto.X509Certificate(pem); } catch { return false; }
}
function pullCa() {
  try { return isCert(fs.readFileSync(PULL_CA)); } catch { return false; }
}
// Where the domain points in DNS (SITES_HOSTS stands in for DNS in tests)
async function addressesOf(domain) {
  if (env.SITES_HOSTS) return JSON.parse(env.SITES_HOSTS)[domain] || [];
  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  const got = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
  return got.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
// Is an address Cloudflare's? By the ranges Caddy trusts as Cloudflare's (hosting/Caddyfile, trusted_proxies)
function cloudflareRanges() {
  const list = new net.BlockList();
  const m = /trusted_proxies static ([^\n]+)/.exec(readText(CADDYFILE) || "");
  for (const range of m ? m[1].trim().split(/\s+/) : []) {
    const [addr, bits] = range.split("/");
    list.addSubnet(addr, Number(bits), net.isIPv6(addr) ? "ipv6" : "ipv4");
  }
  return (ip) => net.isIP(ip) > 0 && list.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}
// A site reached directly needs ports 80 and 443 open to everyone; ufw's own word for it, if ufw is on
function firewallNote() {
  if (DRY) return "";
  const r = spawnSync("ufw", ["status"], { encoding: "utf8" });
  if (r.error || r.status !== 0 || !/^Status: active/m.test(r.stdout)) return "";
  const open = (port) => new RegExp(`^${port}/tcp\\s+ALLOW\\s+Anywhere\\b`, "m").test(r.stdout);
  return open(80) && open(443) ? "" : `The firewall lets ports 80 and 443 in only from Cloudflare, or not at all. Open them to everyone, for visitors and for Let's Encrypt: sudo sh ${HERE}/firewall.sh open`;
}
function canListen(port) {
  return new Promise((done) => {
    const s = net.createServer();
    s.once("error", () => done(false));
    s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
}
async function freePort(taken) {
  for (let port = FIRST_PORT; port < FIRST_PORT + 1000; port++) {
    if (!taken.has(port) && await canListen(port)) return port;
  }
  throw new Fail(`No free port from ${FIRST_PORT} to ${FIRST_PORT + 999}.`);
}
function readableBy(user, dir) {
  const r = system("runuser", ["-u", user, "--", "test", "-r", path.join(dir, "server/server.mjs"), "-a", "-r", path.join(dir, "dist/index.html")]);
  if (r.status !== 0) throw new Fail(`The site's user, ${user}, cannot read ${dir}. Let everyone read it: sudo chmod -R a+rX ${dir}`);
}

// ---------- services ----------
async function answers(port, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      await r.arrayBuffer();
      if (r.status === 200) return true;
    } catch {}
    await new Promise((done) => setTimeout(done, 300));
  }
  return false;
}
// (Re)starts the site, and waits until it answers
async function start(name, port) {
  must("systemctl", ["daemon-reload"], "Reloading systemd");
  must("systemctl", ["enable", "--quiet", `site@${name}`], `Enabling site@${name}`);
  must("systemctl", ["restart", `site@${name}`], `Starting site@${name}`);
  if (DRY) return;
  if (!(await answers(port))) {
    const log = spawnSync("journalctl", ["-u", `site@${name}`, "-n", "25", "--no-pager", "-o", "cat"], { encoding: "utf8" }).stdout || "";
    throw new Fail(`site@${name} does not answer on port ${port}. Its last words:\n${log.trim()}\n(All of them: journalctl -u site@${name})`);
  }
}
// Writes a site's block (or, with text null, takes it away) and restarts Caddy, unless Caddy refuses the result:
// then the block is put back as it was, and nothing changes
function caddySite(name, text) {
  const file = path.join(PATHS.caddySites, `${name}.caddy`), before = readText(file);
  if (text === null) fs.rmSync(file, { force: true }); else writeFile(file, text);
  const v = system("caddy", ["validate", "--config", CADDYFILE, "--adapter", "caddyfile"]);
  if (v.status !== 0) {
    if (before === null) fs.rmSync(file, { force: true }); else writeFile(file, before);
    const why = (v.stderr || v.stdout || "").trim().split("\n").slice(-4).join("\n");
    throw new Fail(`Caddy refused the new configuration, so it stays as it was:\n${why}`);
  }
  must("systemctl", ["restart", "caddy"], "Restarting Caddy");
}
// The site's block, by how it has its certificate; one reached directly answers on port 80 too, to send visitors to https
function caddyBlock(name, domain, port, way, cert) {
  const head = `# ${name} (${PATHS.sites}/${name}), ${WAYS[way]}: written by \`sites link\`, and written again each time; change hosting/Caddyfile instead\n`;
  const server = `127.0.0.1:${port}`;
  if (way === "cloudflare") return head + `https://${domain} {\n\timport cloudflare ${server} ${cert.cert} ${cert.key}\n}\n`;
  const tls = way === "own" ? `\timport own ${server} ${cert.cert} ${cert.key}\n` : `\timport letsencrypt ${server}\n`;
  return head + `https://${domain} {\n${tls}}\nhttp://${domain} {\n\timport to-https\n}\n`;
}

// ---------- commands ----------
async function setup(login) {
  if (!login) usage();
  asRoot();
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Fail(`Node.js ${process.version} is too old: the sites need 20 or newer.`);
  if (!DRY) {
    if (!fs.existsSync(NODE)) throw new Fail(`site@.service runs ${NODE}, which is not there. Install Node.js 20 or newer so that it is (hosting/README.md, step 1).`);
    if (!getent("group", "caddy")) throw new Fail("Caddy is not installed (there is no caddy group). Install it first (hosting/README.md, step 1).");
    if (!getent("passwd", login)) throw new Fail(`There is no user ${login}. Give your own login, the account you sign in with over SSH or SFTP.`);
  }
  // Your login puts the folders in /srv/sites; root alone writes the rest, and Caddy reads the certificates
  mkdir(PATHS.sites, 0o755, login, null);
  mkdir(PATHS.env, 0o755);
  mkdir(PATHS.caddySites, 0o755);
  mkdir(PATHS.certs, 0o750, "root", "caddy");
  writeFile(PATHS.unit, fs.readFileSync(path.join(HERE, "site@.service"), "utf8"));
  must("systemctl", ["daemon-reload"], "Reloading systemd");
  // Caddy's configuration: the one it came with is kept beside it, once
  const before = readText(CADDYFILE);
  if (before !== null && !before.includes(MARK) && !fs.existsSync(`${CADDYFILE}.before-sites`)) fs.copyFileSync(CADDYFILE, `${CADDYFILE}.before-sites`);
  let caddyfile = fs.readFileSync(path.join(HERE, "Caddyfile"), "utf8");
  if (ROOT !== "/") caddyfile = caddyfile.replaceAll("/etc/caddy/", `${PATHS.caddy}/`);
  writeFile(CADDYFILE, caddyfile);
  if (!pullCa()) {
    if (DRY) console.log(`  [dry run] download ${PULL_CA_URL} to ${PULL_CA}`);
    else {
      const r = await fetch(PULL_CA_URL, { signal: AbortSignal.timeout(30000) });
      const pem = r.ok ? await r.text() : "";
      if (!isCert(pem)) throw new Fail(`Could not fetch Cloudflare's origin-pull CA from ${PULL_CA_URL}. Fetch it by hand: sudo curl -fsSo ${PULL_CA} ${PULL_CA_URL}`);
      writeFile(PULL_CA, pem, 0o640);
      own(PULL_CA, "root", "caddy");
    }
  }
  // This command, as `sites`
  fs.chmodSync(path.join(HERE, "sites.mjs"), 0o755);
  fs.mkdirSync(path.dirname(PATHS.bin), { recursive: true });
  fs.rmSync(PATHS.bin, { force: true });
  fs.symlinkSync(path.join(HERE, "sites.mjs"), PATHS.bin);
  const v = system("caddy", ["validate", "--config", CADDYFILE, "--adapter", "caddyfile"]);
  if (v.status !== 0) throw new Fail(`Caddy refuses its new configuration:\n${(v.stderr || v.stdout || "").trim().split("\n").slice(-4).join("\n")}`);
  must("systemctl", ["restart", "caddy"], "Restarting Caddy");
  console.log(`Set up. Put a site's folder in ${PATHS.sites} (as ${login}), then: sudo sites link <folder> <domain>`);
}

// How the site is to have its certificate, from the command's words: { way, cert, key }
function chosen(words) {
  const how = { way: "", cert: "", key: "" };
  const pick = (way) => {
    if (how.way && how.way !== way) throw new Fail("Choose one way for the certificate: --letsencrypt, --cloudflare, or --cert <file> --key <file>.");
    how.way = way;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--letsencrypt") pick("letsencrypt");
    else if (w === "--cloudflare") pick("cloudflare");
    else if (w === "--cert" || w === "--key") {
      const file = words[++i];
      if (!file || file.startsWith("--")) usage();
      pick("own");
      how[w.slice(2)] = path.resolve(file);
    } else usage();
  }
  if (how.way === "own" && !(how.cert && how.key)) throw new Fail("Give your certificate and its key together: --cert <file> --key <file>.");
  return how;
}

async function link(name, rawDomain, ...words) {
  checkName(name);
  const domain = checkDomain(rawDomain);
  const how = chosen(words);
  asRoot();
  installed();
  const dir = folder(name);
  const others = linked().filter((s) => s.name !== name);
  const owner = others.find((s) => s.domain === domain);
  if (owner) throw new Fail(`${domain} is already the address of ${owner.name}. Take that site off it first (sudo sites unlink ${owner.name}), or choose another domain.`);
  const file = envFile(name);
  let lines = readText(file)?.replace(/\n+$/, "").split("\n") ?? [
    `# ${name}: written by \`sites link\`, which keeps PORT, PUBLIC_ORIGIN and TLS up to date. Lines of your own stay, such`,
    `# as TZ=Europe/Berlin (the time zone of the statistics' days). After changing this file: sudo sites restart ${name}`,
  ];
  // The way: as asked; else as it was; else as the certificates here say (Cloudflare's own: through Cloudflare;
  // another: yours); else Let's Encrypt
  const later = []; // worth saying once it is online
  if (how.way === "own") later.push(installOwn(domain, how.cert, how.key));
  const { usable, notes } = certsFor(domain);
  const before = Object.hasOwn(WAYS, getVar(lines, "TLS")) ? getVar(lines, "TLS") : "";
  if (!how.way && !before && !usable.length && notes.length) { // a certificate meant for it, that cannot be used
    throw new Fail([...notes, `Put that right, or choose another way: --letsencrypt, or --cert <file> --key <file>.`].join("\n"));
  }
  const way = how.way || before || (usable.some((c) => c.origin) ? "cloudflare" : usable.length ? "own" : "letsencrypt");
  let cert = null;
  if (way === "cloudflare") {
    if (!pullCa()) throw new Fail(`Cloudflare's origin-pull CA is missing (${PULL_CA}). Run sudo sites setup <login> again, which fetches it.`);
    cert = usable.find((c) => c.named) || usable.find((c) => c.origin) || usable[0];
    if (!cert) {
      const parent = domain.split(".").slice(1).join(".");
      throw new Fail([...notes,
        `No certificate in ${PATHS.certs} covers ${domain}. In Cloudflare, in ${domain}'s zone: SSL/TLS > Origin Server > Create Certificate, for ${domain}` +
        (parent.includes(".") ? ` (or for *.${parent}, which covers every name beside it too)` : "") + `, in PEM format. ` +
        `Save the certificate as ${PATHS.certs}/${domain}.pem and its private key as ${PATHS.certs}/${domain}.key, then run this again. ` +
        `(Without Cloudflare: --letsencrypt.)`].join("\n"));
    }
  } else if (way === "own") {
    cert = usable.find((c) => !c.origin);
    if (!cert) {
      throw new Fail([...notes, usable.length
        ? `Only a Cloudflare Origin Certificate covers ${domain} here, which browsers trust only through Cloudflare: --cloudflare, or give your own (--cert <file> --key <file>), or --letsencrypt.`
        : `No certificate of yours covers ${domain}: give it with --cert <file> --key <file> (the full chain, and its key), or let Let's Encrypt give it one: --letsencrypt.`].join("\n"));
    }
  }
  // Where the domain points: Let's Encrypt cannot reach this machine through Cloudflare's proxy
  const ips = await addressesOf(domain), isCloudflare = cloudflareRanges(), proxied = ips.filter(isCloudflare);
  if (way === "letsencrypt" && proxied.length) {
    throw new Fail(`${domain} points at Cloudflare's proxy (${proxied.join(", ")}), through which Let's Encrypt cannot reach this machine. ` +
      `Either set its DNS record in Cloudflare to "DNS only" (the grey cloud), then run this again; or keep Cloudflare in front: ` +
      `save a Cloudflare Origin Certificate for it in ${PATHS.certs} and run this with --cloudflare.`);
  }
  if (way === "cloudflare") {
    if (!ips.length || ips.length > proxied.length) later.push(`In Cloudflare, ${domain} needs a proxied DNS record (the orange cloud) for this machine, if it has none yet; and the zone needs SSL/TLS Full (strict) and Authenticated Origin Pulls (hosting/README.md).`);
  } else {
    if (!ips.length) later.push(`${domain} has no DNS record yet: point it (A, and AAAA with IPv6) at this machine.` + (way === "letsencrypt" ? " Caddy keeps trying for its certificate, less and less often; once it points here, sudo systemctl restart caddy makes it try at once." : ""));
    else if (proxied.length) later.push(`${domain} points at Cloudflare's proxy. Your own certificate works through it, but the machine also lets everyone in directly: for Cloudflare alone, --cloudflare.`);
    later.push(firewallNote());
  }
  const user = `site-${name}`;
  if (DRY || !getent("passwd", user)) {
    must("useradd", ["--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", user], `Making the user ${user}`);
  }
  // The port: the site's own if it has one, else the first free one
  let port = Number(getVar(lines, "PORT"));
  if (!port || others.some((s) => s.port === port)) port = await freePort(new Set(others.map((s) => s.port)));
  lines = setVar(setVar(setVar(lines, "PORT", String(port)), "PUBLIC_ORIGIN", `https://${domain}`), "TLS", way);
  writeFile(file, lines.join("\n") + "\n");
  readableBy(user, dir);
  await start(name, port);
  if (cert) {
    for (const f of [cert.cert, cert.key]) { // Caddy reads them; nobody else
      if (!DRY) fs.chmodSync(f, 0o640);
      own(f, "root", "caddy");
    }
  }
  caddySite(name, caddyBlock(name, domain, port, way, cert));
  const said = {
    cloudflare: () => `through Cloudflare (certificate ${path.basename(cert.cert)}, until ${day(cert.until)})`,
    own: () => `reached directly, with your certificate (${path.basename(cert.cert)}, until ${day(cert.until)}). Before then: sudo sites link ${name} ${domain} --cert <new certificate> --key <its key>`,
    letsencrypt: () => "reached directly. Caddy gets its certificate from Let's Encrypt, and renews it by itself",
  };
  console.log(`${name} is online at https://${domain}, ${said[way]()}.`);
  let word = false;
  try { word = fs.existsSync(path.join(PATHS.data, name, "auth.json")); } catch {}
  if (!word) console.log(`It has no keeper's word yet: sudo sites password ${name}`);
  for (const line of later) if (line) console.log(line);
}

async function restart(name) {
  checkName(name);
  asRoot();
  const site = linked().find((s) => s.name === name);
  if (!site) throw new Fail(`${name} is not linked: sudo sites link ${name} <domain>`);
  readableBy(`site-${name}`, folder(name));
  await start(name, site.port);
  console.log(`${name} is running again, at https://${site.domain}.`);
}

async function password(name, ...flags) {
  checkName(name);
  const forget = flags.includes("--forget-private");
  if (flags.some((f) => f !== "--forget-private")) usage();
  asRoot();
  if (!linked().some((s) => s.name === name)) throw new Fail(`${name} is not linked: sudo sites link ${name} <domain> first, which starts it once.`);
  const dir = folder(name), data = path.join(PATHS.data, name);
  if (!DRY && !fs.existsSync(data)) throw new Fail(`${data} does not exist yet: the site makes it when it first starts (sudo sites restart ${name}).`);
  // As the site's own user, so that the site can read what is written (set-password refuses anyone else)
  const r = system("runuser", ["-u", `site-${name}`, "--", "env", `DATA_DIR=${data}`, NODE, path.join(dir, "server/server.mjs"), "set-password",
    ...(forget ? ["--forget-private"] : [])], true);
  if (r.status !== 0) process.exitCode = r.status || 1;
}

async function unlink(name) {
  checkName(name);
  asRoot();
  const file = envFile(name), block = path.join(PATHS.caddySites, `${name}.caddy`);
  if (!fs.existsSync(file) && !fs.existsSync(block)) throw new Fail(`${name} is not linked (sites list shows those that are).`);
  if (fs.existsSync(block)) caddySite(name, null); // Caddy first, so nobody reaches a server that is going away
  const r = system("systemctl", ["disable", "--now", "--quiet", `site@${name}`]);
  if (r.status !== 0) console.log(`(site@${name} was not running.)`);
  fs.rmSync(file, { force: true });
  console.log(`${name} is offline. Its folder (${PATHS.sites}/${name}), its data (${PATHS.data}/${name}: its records, art, word and statistics) ` +
    `and its user (site-${name}) stay. To bring it back: sudo sites link ${name} <domain>`);
}

function list() {
  const sites = linked();
  let folders = [];
  try { folders = fs.readdirSync(PATHS.sites).filter((n) => !n.startsWith(".")); } catch {}
  const names = [...new Set([...sites.map((s) => s.name), ...folders])].sort();
  if (!names.length) return console.log(`No sites yet. Put a site's folder in ${PATHS.sites}, then: sudo sites link <folder> <domain>`);
  const rows = [["SITE", "ADDRESS", "CERTIFICATE", "PORT", "STATE", "WORD"]];
  for (const name of names) {
    const site = sites.find((s) => s.name === name);
    let state = "not linked", word = "";
    if (!NAME.test(name)) state = "cannot be linked: rename the folder (lower-case letters, digits, - and _)";
    else if (site) {
      state = DRY ? "?" : (spawnSync("systemctl", ["is-active", `site@${name}`], { encoding: "utf8" }).stdout || "?").trim();
      if (!fs.existsSync(path.join(PATHS.sites, name))) state += ", folder missing";
      // the site's data is its own (0700): without sudo, there is no telling
      word = process.getuid() !== 0 && ROOT === "/" ? "?" : fs.existsSync(path.join(PATHS.data, name, "auth.json")) ? "set" : "not set";
    }
    rows.push([name, site ? `https://${site.domain}` : "", site ? WAYS[site.way] || "?" : "", site ? String(site.port) : "", state, word]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const row of rows) console.log(row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
}

function usage() {
  throw new Fail(`Usage:
  sudo sites setup <login>             once, on a new machine (<login>: the account you sign in with)
  sudo sites link <folder> <domain> [--letsencrypt | --cloudflare | --cert <file> --key <file>]
                                       put /srv/sites/<folder> online at https://<domain>
  sudo sites restart <folder>          after a new version of the folder has been put in place
  sudo sites password <folder> [--forget-private]
                                       set or replace the site's keeper's word
  sudo sites unlink <folder>           take the site offline (its folder and data stay)
  sites list                           every site, its address, port and state
hosting/README.md has the whole setup.`);
}

const COMMANDS = { setup, link, restart, password, unlink, list };
try {
  const [command, ...args] = process.argv.slice(2);
  if (!Object.hasOwn(COMMANDS, command)) usage();
  await COMMANDS[command](...args);
} catch (e) {
  if (!(e instanceof Fail)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
