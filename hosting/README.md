# Hosting the sites on one VPS

Every site on the machine is a folder in `/srv/sites`, such as `/srv/sites/dezept` for the Chalice Archive and `/srv/sites/person_2` for a friend's. Put a folder there, run one command, and it is online at its own domain:

```sh
sudo sites link person_2 person2.example.com
```

Each site gets its certificate one of three ways, chosen when it is linked ("4. Certificates"):

```
Let's Encrypt   visitor ──HTTPS──▶ Caddy :443 (certificate from Let's Encrypt, renewed by Caddy) ──HTTP, loopback──▶ the site's server
your own        visitor ──HTTPS──▶ Caddy :443 (your certificate) ──HTTP, loopback──▶ the site's server
Cloudflare      visitor ──HTTPS──▶ Cloudflare ──HTTPS (Origin Certificate, client cert)──▶ Caddy :443 ──HTTP, loopback──▶ the site's server
```

- **Caddy** terminates the connections, compresses responses and passes each visitor's real address on. Each domain goes to its own site. For a site through Cloudflare, it accepts only Cloudflare's client certificate.
- **Each site** runs its own server, `node server/server.mjs` from its folder, as a user of its own (`site-<folder>`), with its data in a folder of its own (`/var/lib/sites/<folder>`), listening on a port of its own on 127.0.0.1 only. Sites cannot read each other's data.
- **`sites`** (`hosting/sites.mjs`) sets all of that up, and takes it down again.
- **Cloudflare**, for the sites that go through it, holds their public certificates, hides the VPS's address and absorbs junk traffic.

The firewall lets in SSH, and HTTPS: from everyone, or, if every site goes through Cloudflare, from Cloudflare alone ("5. Firewall").

| Where | What |
| --- | --- |
| `/srv/sites/<folder>` | the site itself, as you put it there (its code and its built page) |
| `/var/lib/sites/<folder>` | its data: records, art, its word's hash, backups, statistics (mode 0700, its user's alone) |
| `/etc/sites/<folder>.env` | its port, its address and how it has its certificate (`TLS=`), written by `sites link`; lines of your own stay (`TZ=…`) |
| `/etc/caddy/sites/<folder>.caddy` | its block in Caddy's configuration, written by `sites link` |
| `/etc/caddy/certs/` | certificates you give (yours, and Cloudflare's Origin Certificates) and their keys, and Cloudflare's origin-pull CA |
| `/var/lib/caddy/` | Caddy's own data: the certificates it gets from Let's Encrypt |
| `/etc/systemd/system/site@.service` | the service every site runs as, `site@<folder>` |
| `journalctl -u site@<folder>` | its log |

## 1. Install Node.js and Caddy

- **Node.js 20 or newer** (`node --version`), at `/usr/bin/node`, where the service runs it.
  - On Debian 13, `sudo apt install nodejs` is new enough.
  - On Ubuntu 24.04 or Debian 12, install the current LTS from [NodeSource](https://github.com/nodesource/distributions).
- **Caddy**: use the [official apt repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). It installs a `caddy` service running as the `caddy` user.

## 2. Get the code

```sh
sudo git clone https://github.com/dezept/dezept-website.git /opt/dezept-website
```

- If the repository is private, give the VPS a read-only deploy key.
- Each site's `dist/` is committed, so the VPS needs no build step. It holds three.js and the fonts too: a site serves them itself, so no visitor's browser asks a CDN or Google for anything.

## 3. Set up the sites

Once, with your own login (the account you sign in with over SSH or SFTP):

```sh
sudo node /opt/dezept-website/hosting/sites.mjs setup yourlogin
```

It:

- makes `/srv/sites`, owned by your login, so you can put folders there without sudo (with SFTP, say);
- installs the service template `site@.service` and Caddy's configuration (`hosting/Caddyfile`; the one Caddy came with is kept as `Caddyfile.before-sites`);
- makes `/etc/caddy/certs` (readable by Caddy alone) and fetches Cloudflare's origin-pull CA into it, for the sites that go through Cloudflare;
- installs the command `sites` itself (`/usr/local/bin/sites`).

From then on, `sudo sites …` does the rest. Run `setup` again after a `git pull` that changed anything in `hosting/`: it installs the new versions.

## 4. Certificates

Each site has its certificate one of three ways. `sites link` takes the way you name:

```sh
sudo sites link person_2 person2.example.com --letsencrypt                                  # from Let's Encrypt
sudo sites link person_2 person2.example.com --cert fullchain.pem --key privkey.pem       # your own
sudo sites link person_2 person2.example.com --cloudflare                                   # through Cloudflare
```

Without one, a site keeps the way it had. A new one goes through Cloudflare if a Cloudflare Origin Certificate in `/etc/caddy/certs` covers its domain, takes your own if another certificate there does, and otherwise gets one from Let's Encrypt; a certificate there meant for the domain that cannot be used (its key missing, say) stops it, with what is wrong. To change a site's way, link it again with the new one.

| | Let's Encrypt | Your own | Cloudflare |
| --- | --- | --- | --- |
| The certificate | Caddy gets it, and renews it a month before it runs out | you give it, and give the next one before it runs out | Cloudflare's, at its edge; an Origin Certificate (15 years) between it and Caddy |
| DNS | the domain's `A`/`AAAA` records point at the VPS (on Cloudflare: **DNS only**, the grey cloud) | as for Let's Encrypt | **Proxied** (the orange cloud) |
| Firewall | 80 and 443 open to everyone (`firewall.sh open`) | as for Let's Encrypt | 443 from Cloudflare is enough, unless other sites are reached directly |
| Visitors see | the VPS's address | the VPS's address | Cloudflare's; the VPS's stays hidden, and Cloudflare absorbs junk traffic |
| Port 80 | sends visitors to https | sends visitors to https | Cloudflare does that |

### Let's Encrypt

The simplest: nothing to make or copy.

1. Point the domain at the VPS: an `A` record (and `AAAA` if the VPS has IPv6). If the domain is on Cloudflare, set the record to **DNS only** (the grey cloud): Let's Encrypt cannot reach the VPS through Cloudflare's proxy, so `sites link` refuses while the domain points there.
2. Open ports 80 and 443 to everyone: `sudo sh /opt/dezept-website/hosting/firewall.sh open` ("5. Firewall"). Let's Encrypt checks the domain through them.
3. `sudo sites link person_2 person2.example.com --letsencrypt`

Caddy asks Let's Encrypt for the certificate as soon as the site is linked, and has it within a minute when the domain already points here. It renews it by itself, a month before it runs out, and keeps it in `/var/lib/caddy`. If the domain did not point here yet, Caddy keeps trying, less and less often; once it does, `sudo systemctl restart caddy` makes it try at once.

### Your own certificate

A certificate from any public authority (bought, or made elsewhere), with its key:

```sh
sudo sites link person_2 person2.example.com --cert /path/to/fullchain.pem --key /path/to/privkey.pem
```

- Give the full chain, the certificate followed by its authority's intermediate certificates (`fullchain.pem`, where the authority gives one): with the certificate alone, some browsers will not trust it. `sites link` says so when the intermediate is missing.
- It checks that the certificate covers the domain, has not run out, goes with the key, and is not one of Cloudflare's Origin Certificates (browsers trust those only through Cloudflare). Then it copies both into `/etc/caddy/certs`, as `<domain>.pem` and `<domain>.key`, readable by Caddy alone.
- Point the domain at the VPS and open ports 80 and 443, as for Let's Encrypt.
- **Before it runs out**, link the site again with the next certificate. `sites list` shows the way each site has, and `sites link` says until when the certificate runs.

### Cloudflare

For each domain's zone:

| Where | Setting |
| --- | --- |
| DNS | An `A` record (and `AAAA` if the VPS has IPv6) for the site's name, pointing at the VPS. Set it to **Proxied** (orange cloud). |
| SSL/TLS → Overview | **Full (strict)** |
| SSL/TLS → Origin Server | **Create Certificate** for the site's domain, PEM format. Save the certificate and the private key (below). The key is shown only once. |
| SSL/TLS → Origin Server → Authenticated Origin Pulls | **On** (in the **Global** section). Without it, Caddy refuses every request and Cloudflare shows error 525/526. |
| SSL/TLS → Edge Certificates | **Always Use HTTPS** on, **Minimum TLS Version** 1.2, **TLS 1.3** on |
| Network → IP Geolocation | **On**. Cloudflare then adds each visitor's country to the request, and a site's statistics count visitors by country. Without it, that list stays empty. (A site reached directly has no country for its visitors.) |

Save each certificate and its key in `/etc/caddy/certs`, as `<name>.pem` and `<name>.key` (any name; `sites link` finds the one that covers a domain), then link the site (`--cloudflare`, or nothing):

```sh
sudo nano /etc/caddy/certs/example.com.pem       # paste the Origin Certificate
sudo nano /etc/caddy/certs/example.com.key       # paste its private key
sudo sites link person_2 person2.example.com --cloudflare
```

**Sites under one domain of yours** (`dezept.example.com`, `person2.example.com` …) need Cloudflare only once:

- one Origin Certificate for `*.example.com` and `example.com` (Cloudflare offers those two names by default) covers every one of them;
- one proxied DNS record for `*`, pointing at the VPS, sends every name under the domain there.

Then a new site needs nothing in Cloudflare: put its folder in place and link it.

**A friend's own domain** must be on Cloudflare too, set up as above in its own zone, with an Origin Certificate made there (by them, or by you with access to their zone). Or give it Let's Encrypt.

Leave off everything that rewrites the pages (each site counts its own visitors; Cloudflare's Web Analytics would add a script the pages refuse):

- Rocket Loader
- Email Address Obfuscation
- Cloudflare Fonts
- Zaraz
- automatic Web Analytics injection

Each page's Content-Security-Policy runs only the page's own script, matched by its hash. Anything injected is blocked, and Rocket Loader breaks the page outright.

Add no Cache Rule or Page Rule that caches every address ("Cache Everything", or an Edge TTL that ignores the origin's `Cache-Control`). The pages and the API answer `no-store`, and Cloudflare keeps one copy for everyone who asks for the same address, whoever they are: a cached answer to the keeper (`/api/private` holds the private sections, decrypted) would go to the next visitor who asked for it.

Optional, and free: add a rate-limiting rule under Security → WAF:

- Match: URI path equals `/api/login`.
- Limit: 5 requests per 10 seconds per IP.
- Action: block.

The servers throttle failed logins by themselves anyway.

## 5. Firewall

```sh
sudo sh /opt/dezept-website/hosting/firewall.sh open             # 80 and 443 from everyone
sudo sh /opt/dezept-website/hosting/firewall.sh                  # or 443 from Cloudflare alone
sudo SSH_PORT=2222 sh /opt/dezept-website/hosting/firewall.sh …  # SSH on another port than 22
```

- Both allow SSH (rate-limited) and deny everything else.
- **`open`**, for any site reached directly (Let's Encrypt, or your own certificate): lets in HTTP (80) and HTTPS (443, and 443/udp for HTTP/3) from everyone. A site through Cloudflare still lets in Cloudflare alone, by its client certificate, which nobody else has.
- **Without `open`**, when every site goes through Cloudflare: lets in 443 from Cloudflare's current ranges only, so nobody else can even reach Caddy. It checks every range it fetches before using it; if one is not a plain IPv4 or IPv6 range, or is wide enough to open the port to most of the internet, it stops and changes nothing. Run it again now and then to pick up new Cloudflare ranges.
- Each run replaces the rules the other added, so switching is one run. `sites link` says when a site reached directly needs the firewall open.
- When Cloudflare's list changes, update the `trusted_proxies` line in `hosting/Caddyfile` too, then `sudo sites setup yourlogin`.
- Your VPS provider's own firewall, if it has one, must let the same ports in.

## 6. Adding a site

1. **Put its folder in `/srv/sites`.** The folder's name names the site: lower-case letters, digits, `-` and `_`, starting with a letter, at most 27 characters (`person_2`, `dezept`).
   - From your computer: drag the folder into `/srv/sites` with SFTP (WinSCP, FileZilla, Cyberduck), signed in as your login.
   - A site in this repository: link to it, so `git pull` updates it:
     ```sh
     sudo ln -s /opt/dezept-website/chalice-archive /srv/sites/dezept
     ```
   - It must be a whole site, with `server/server.mjs` and `dist/index.html` in it ("Making a site", below). Not under `/home`: the service cannot see there.
2. **Link it:**
   ```sh
   sudo sites link person_2 person2.example.com
   ```
   It makes the site's user, gives it a port, starts it, waits until it answers, and adds its domain to Caddy, with its certificate the way you name ("4. Certificates": `--letsencrypt`, `--cert … --key …` or `--cloudflare`). It refuses, and changes nothing, if the folder is not a whole site, if the domain is another site's, or if the way cannot work (no certificate for Cloudflare, a certificate that does not fit, Let's Encrypt behind Cloudflare's proxy), saying what to do.
3. **Give it a keeper's word:**
   ```sh
   sudo sites password person_2
   ```
   - It asks twice and shows nothing while you type, so the word stays out of shell history and logs. At least 12 characters, a phrase used nowhere else. Arrow keys and Escape don't edit at this prompt; they would go into the word, so it refuses one with them in it.
   - Give the word to whoever keeps the site. They can change it from the page: the clasp on the tome's edge, then **Change the word**.
   - Only a salted scrypt hash is stored (`auth.json`, mode 0600). The word also locks the key that encrypts the encounters' private sections, and the encounters marked "Only for me" in whole: the key is made on the first login and stored only wrapped by a second key derived from the word, so nothing on disk can read them without the word.
   - Running it again replaces the word and signs every session out. Once there are private sections, it asks for the current word a third time, to carry the key over to the new word.
   - **A forgotten word:** `sudo sites password person_2 --forget-private`. The site opens again with the new word, but its private sections and its encounters "Only for me" written so far can never be read again, by anyone (the page still lists the latter, as unreadable, so they can be removed). Everything else is untouched. The statistics count visitors afresh from then on.
4. **Open it**: `https://person2.example.com`. Click the gem (or, on a site without a centerpiece, a chapter), then the brass clasp on the tome's right edge, and speak the word: the editing tools and the Statistics appear.

`sites list` shows every site, its address, its way to a certificate, its port and state, and whether it has a word.

## Day to day

- **Updating a site**: put the new version of its folder in place of the old one (delete the old folder first, so files that were removed go too), then:
  ```sh
  sudo sites restart person_2
  ```
  A site linked from this repository: `cd /opt/dezept-website && sudo git pull && sudo sites restart dezept`. Sessions live in memory, so a restart signs the keeper out.
- **Moving a site to another domain**: `sudo sites link person_2 new.example.com`, with its way if the new domain needs another.
- **Certificates**: Caddy renews Let's Encrypt's by itself. Your own, link the site again with the next one before it runs out. Cloudflare's Origin Certificates run 15 years.
- **Taking a site offline**: `sudo sites unlink person_2`. Its folder, its data and its user stay; `sites link` brings it back as it was. To remove it for good as well: `sudo rm -rf /srv/sites/person_2 /var/lib/sites/person_2 && sudo userdel site-person_2`.
- **A site's time zone**: its statistics count days in the server's time zone, usually UTC. For another, add a line such as `TZ=Europe/Berlin` to `/etc/sites/<folder>.env`, then `sudo sites restart <folder>`.
- **Logs**: `journalctl -u site@<folder>`. A server logs only startup messages and unexpected errors. Caddy keeps no access log with this configuration.
- **Backups**:
  - Each change keeps the site's previous `archive.json` in `/var/lib/sites/<folder>/backups/`, up to the last 50.
  - The images, GIFs and videos are in `/var/lib/sites/<folder>/art/`. A file stays there while the archive or any of those 50 backups uses it, so restoring a backup finds its images. Videos take room: a removed one stays until it has dropped out of the last 50 backups, so keep an eye on the disk (`df -h /var/lib`).
  - Copy the whole of `/var/lib/sites` off the VPS now and then (`sudo tar czf sites-backup.tar.gz -C /var/lib sites`).
  - To restore, stop the site (`sudo systemctl stop site@<folder>`), copy a backup over `archive.json`, then `sudo sites restart <folder>`.
  - The private sections, and the encounters only for the keeper, are encrypted in `archive.json` and every backup. Keep `auth.json` with them: its wrapped key and the word are what read them. A copy without the word is a copy without the private sections.
  - The statistics are `stats.json`, saved every half minute while visitors come and whenever the keeper reads them. It holds no visitor's address, so a copy of it tells nobody who visited.
- **Removing a picture for good**: removing its art piece stops the server serving it at once. For a site through Cloudflare, Cloudflare keeps its copy for up to a day; to clear it sooner, purge the image's address under Caching → Configuration → Custom Purge.
- **Videos and Cloudflare** (for sites through it): Cloudflare's Service-Specific Terms ([explained here](https://blog.cloudflare.com/updated-tos/)) say that on the Free, Pro and Business plans the CDN is not for serving video from your own server; that takes Stream, R2 or the Enterprise plan. Cloudflare reserves the right to limit a site that does it anyway, or that serves a disproportionate share of pictures or other large files. Keep videos short and few, or host them elsewhere.
- **Checking a site**:
  ```sh
  curl -sI https://person2.example.com | grep -iE '^(HTTP|content-security-policy|strict-transport)'
  curl -sI http://person2.example.com | head -2       # reached directly: 301 to https
  curl -m 5 -k https://<the VPS's IP>/        # every site through Cloudflare, firewall without open: should time out
  sudo sites list
  ```

## Making a site

A friend's site is a whole copy of `chalice-archive/`, changed freely for them: their own look, their own centerpiece or none, their own links. Make it in a folder of its own beside `chalice-archive/` in this repository, then put it in `/srv/sites` and link it.

- **Copy** `chalice-archive/`, leaving out `tools/node_modules/`, `tools/.smoke/` and `server/data/`.
- **What is the owner's in it**, to change or take out:
  - the page's `<title>` (`src/page.html`);
  - the X marks: the handle `dezeptdrac` in `src/page.html` (the warning card's link, the marks' names, the warning's words). For a friend without X, take out both marks (`#x-stage`, `#x-tome`) and their code; for an account without mature content, the warning can go too;
  - the profile it starts with (`src/seed.json`: name, epithet) and "Unnamed Dracthyr" where the page falls back to it;
  - "he" in the page ("What he learned from it"), for a character who is not a he;
  - `HANDOVER.md`, to describe the friend's site.
- **The centerpiece** follows the files in `assets/` (`build.py`'s first lines):
  - `assets/front.webp` and one `assets/model/<name>.glb`: a 3D model, drawn over its cutout once loaded (the chalice);
  - `assets/front.webp` alone: the cutout alone;
  - neither: no centerpiece. The landing shows the archive's name and the four chapters at once, and keeps them when the tome closes; no model or three.js is built or served.
  - The chalice wakes when its gem is clicked: `gemAt()` tests the part of the model whose material is named `gem`, and `.gem` (in the style) places it on the cutout. Another centerpiece needs its own way to wake, or the gem's test taken out.
- **Keep what the hosting needs**:
  - `server/server.mjs`, run with Node 20 or later and nothing else, reading `HOST`, `PORT`, `DATA_DIR`, `PUBLIC_ORIGIN`, `TRUST_PROXY`, `SESSION_HOURS` and `TZ` from its environment, with `set-password` (and `--forget-private`) for the word;
  - `dist/`, built with `python3 build.py`, committed with the site.
- **Test it** with its own `tools/smoke.js`, changed where it checks the owner's things (the X handle).

## What protects what

- **Between sites**:
  - Each site runs as its own user. It can write only its own data folder, which no other site can read: not its records, its word's hash, its private sections nor its statistics. Its own folder of code is read-only to it.
  - Each listens on loopback only, on its own port. Caddy sends each domain to its own site and no other; a request for a name no site has is refused during the TLS handshake, and so is one for a site through Cloudflare that does not come with Cloudflare's client certificate.
  - One site that had been broken into could reach the others' servers on loopback, as any visitor can through Caddy, and claim any address there. That only lets it guess another site's word faster from many addresses, which the pause for everyone (below) holds to 50 wrong guesses in ten minutes.
- **The word**:
  - Stored only as a salted scrypt hash (N=2¹⁷, r=8, p=1).
  - Checked only on the server, one check at a time.
  - From the third wrong try from one address, each miss imposes a wait that doubles (2 s, 4 s, 8 s …), up to an hour. An IPv6 address counts with the rest of its /64, which one client usually holds whole.
  - Each try counts the moment it is made, so a burst of guesses sent all at once gets no more tries than guesses sent one after another.
  - A try refused only because the server is busy checking other words is not counted: its word was never checked, so flooding the logins cannot earn your address a wait.
  - Over 50 failures in ten minutes from anywhere pauses all logins for a while, except from a browser that has spoken the right word before: it carries a signed device cookie, which a new word cancels. So guessing from many addresses at once gains nothing, and cannot keep the keeper out either.
- **The session**:
  - A random 256-bit token in a `__Host-` cookie: HttpOnly, Secure, SameSite=Strict, for its own domain alone.
  - Page scripts can't read it, and other sites can't make the browser send it.
  - The server keeps only its SHA-256.
  - Sessions end after 12 hours (`SESSION_HOURS`), on "Seal it again", or when the word changes.
  - A write still on its way when its session ends (a large upload, say) is refused once it has arrived, so changing the word really does stop every other session at once.
  - Once a session has ended, an open tab lets go of the private sections within a minute, or as soon as it is looked at; one sealed in another tab of the same browser, at once.
- **Writes**:
  - Each needs the session, a CSRF token in a header, a JSON body, and an `Origin` equal to the site's address (`PUBLIC_ORIGIN`).
  - Uploads are the one exception to JSON: PNG, JPEG, WebP or GIF images and MP4 or WebM videos only, checked by their bytes, at most 8 MiB for a picture, 40 MiB for a GIF and 90 MiB for a video, stored under their content hash and served with their own type and `nosniff`. SVG is never accepted.
  - GIFs lose their comments and XMP; MP4s lose their `udta`, `meta` and XMP boxes (where a phone recorded them, tags), which are zeroed in place. WebM videos are kept as they come. Pictures are re-encoded in the keeper's browser, which keeps nothing but the picture.
  - Every field is validated and capped on the server. Artists' links must be `http(s)`.
  - The page shows all of it as text, never as markup.
- **The page**:
  - The CSP allows only its own inline script and style, by hash, and three.js (only with a 3D centerpiece) and the fonts from the site itself. Nothing comes from another host: no CDN can run code in the page, so none could reach the keeper's session or the private sections, and no font host learns who visits.
  - It also requires Trusted Types: browsers that support them (Chrome and Edge among them) refuse any attempt to write HTML into the page or turn text into script, so even a mistake in the page's code could not become cross-site scripting.
  - It is isolated from every other site (COOP and COEP): it runs in a process of its own, even on browsers that do not otherwise keep sites apart, so no other site's page can read its memory.
  - Also sent: HSTS, `nosniff`, no framing, no referrer, and a Permissions-Policy that switches off the camera, microphone, location and other features the page never uses.
- **The statistics** (visitors, what they open, where they came from, their countries):
  - Each visitor is counted once, by their address (an IPv6 address by its /64). Nothing on disk keeps an address: each is sealed at once (X25519, then AES-256-GCM) to a key whose private half is stored only encrypted under the same key as the private sections, which only the site's word unlocks. When the keeper reads the statistics, the server opens what came in since, turns each address into a keyed hash (that key is locked away the same way) and lets the address go.
  - So `stats.json`, and every copy of it, says how many came and what they opened, never who they were: without the word, a hash can be neither turned back into an address nor checked against a guess.
  - The page reports only what visitors open, and only from the site's own pages. The keeper's own browsers (signed in now, or signed in before under the current word), robots and headless browsers are not counted, and one address counts as at most 100 visits a day.
  - Only the keeper's session, with its CSRF token, reads the numbers. Sealing the archive takes them off the page.
  - A forgotten word (`--forget-private`) takes the statistics' keys with it: from then on visitors are counted afresh, and the visits by day stay.
  - Visitors' addresses are personal data in the EU. Nothing is stored that names one, but if a site keeps a privacy note anywhere, it should say that the site counts visits by address, sealed, and never shares them.
- **Slow requests**: a JSON body has 60 seconds to arrive, so nobody can hold connections open by sending a login a byte at a time. A request refused before its body has arrived, such as an upload without a session, is answered at once and let go 10 seconds later; so is a body sent with a GET. A download stopped half way closes its file at once.
- **The machine**:
  - Every site's server runs as an unprivileged user of its own, sandboxed by systemd: it can write only its own data folder and talk only to loopback, where nothing else listens that could be told what to do: Caddy's admin API is switched off.
  - So a changed Caddy configuration needs `systemctl restart caddy`, not `reload` (which asks the admin API); `sites` restarts it, and checks the configuration first, leaving the old one in place if Caddy refuses the new one.
  - With every site through Cloudflare (and the firewall without `open`), the ports Caddy listens on accept only Cloudflare, and the VPS's address is known to nobody else.
  - A site reached directly (Let's Encrypt, or your own certificate) gives its visitors the VPS's address, and the firewall then lets everyone reach Caddy. Its logins are guarded by the server's own throttles (above), as they are behind Cloudflare; junk traffic reaches the VPS itself.

`chalice-archive/tools/smoke.js` tests these properties against a running server, and `sites` itself: what it refuses and writes, and two sites behind Caddy with the configuration it wrote.
