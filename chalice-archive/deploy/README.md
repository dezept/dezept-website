# Hosting the Chalice Archive on a VPS behind Cloudflare

```
visitor ──HTTPS──▶ Cloudflare ──HTTPS (Origin Certificate, client cert)──▶ Caddy :443 ──HTTP, loopback──▶ Node :8080
```

- **Cloudflare** holds the public certificate. It hides the VPS's address and absorbs junk traffic.
- **Caddy** terminates the connection from Cloudflare, using a Cloudflare Origin Certificate. It accepts only Cloudflare's client certificate, compresses responses and passes each visitor's real address on.
- **Node** (`server/server.mjs`) serves the page, the model and the art, keeps the records, the About page and the plates, and checks the keeper's word. It listens on 127.0.0.1 only.

The firewall lets port 443 in only from Cloudflare's addresses. Nothing else is reachable except SSH.

Replace `archive.example.com` everywhere below with your hostname.

## 1. Install Node.js and Caddy

- **Node.js 20 or newer** (`node --version`).
  - On Debian 13, `sudo apt install nodejs` is new enough.
  - On Ubuntu 24.04 or Debian 12, install the current LTS from [NodeSource](https://github.com/nodesource/distributions).
- **Caddy**: use the [official apt repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). It installs a `caddy` service running as the `caddy` user.

## 2. Get the code

```sh
sudo git clone https://github.com/dezept/dezept-website.git /opt/dezept-website
```

- If the repository is private, give the VPS a read-only deploy key.
- `dist/` is committed, so the VPS needs no build step. It holds three.js and the fonts too: the site serves them itself, so no visitor's browser asks a CDN or Google for anything.

## 3. Run the archive server

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin chalice
sudo cp /opt/dezept-website/chalice-archive/deploy/chalice-archive.service /etc/systemd/system/
sudo nano /etc/systemd/system/chalice-archive.service     # set PUBLIC_ORIGIN=https://archive.example.com
sudo systemctl daemon-reload
sudo systemctl enable --now chalice-archive
```

- `SESSION_HOURS` (1 to 720) and `PORT` must be plain numbers. Anything else, such as `12h`, stops the server with a message in the journal, rather than letting sessions last for ever.
- `PUBLIC_ORIGIN` must be the site's https address, such as `https://archive.example.com`, and nothing more. Without it, or with anything else, the server will not start, rather than checking logins and writes against whatever `Host` a request names.

- systemd creates `/var/lib/chalice-archive` (mode 0700, owned by `chalice`).
- On the first start the server copies `src/seed.json` into `archive.json` there.

Then set the keeper's word, as the service user:

```sh
sudo -u chalice env DATA_DIR=/var/lib/chalice-archive node /opt/dezept-website/chalice-archive/server/server.mjs set-password
```

- It asks twice and shows nothing while you type, so the word stays out of shell history and logs.
- Use at least 12 characters, and a phrase you use nowhere else. Arrow keys and Escape don't edit at this prompt; they would go into the word, so it refuses one with them in it.
- Run it as `chalice`, as above. Run as root (plain `sudo`), it refuses: the server could not read a word written by root, and nobody could unseal the archive.
- Only a salted scrypt hash is stored (`auth.json`, mode 0600).
- The word also locks the key that encrypts the encounters' private sections, and the encounters marked "Only for me" in whole. The key is made on the first login and stored in `auth.json` only wrapped by a second key derived from the word, so nothing on disk can read the private sections without the word.
- Running it again replaces the word and signs every session out. Once there are private sections, it asks for the current word a third time, to carry the key over to the new word. Changing the word from the page does the same.
- **A forgotten word:** run `set-password --forget-private` instead. The archive opens again with the new word, but the private sections and the encounters only for you written so far can never be read again, by anyone (the page still lists the latter, as unreadable, so you can remove them). Everything else is untouched.

## 4. Cloudflare

| Where | Setting |
| --- | --- |
| DNS | An `A` record (and `AAAA` if the VPS has IPv6) for `archive` pointing at the VPS. Set it to **Proxied** (orange cloud). |
| SSL/TLS → Overview | **Full (strict)** |
| SSL/TLS → Origin Server | **Create Certificate** for `archive.example.com`, PEM format. Save the certificate and the private key for step 5. The key is shown only once. |
| SSL/TLS → Origin Server → Authenticated Origin Pulls | In the **Global** section, switch it **On**. |
| SSL/TLS → Edge Certificates | **Always Use HTTPS** on, **Minimum TLS Version** 1.2, **TLS 1.3** on |

Leave off everything that rewrites the page:

- Rocket Loader
- Email Address Obfuscation
- Cloudflare Fonts
- Zaraz
- automatic Web Analytics injection

The page's Content-Security-Policy runs only the page's own script, matched by its hash. Anything injected is blocked, and Rocket Loader breaks the page outright.

Add no Cache Rule or Page Rule that caches every address ("Cache Everything", or an Edge TTL that ignores the origin's `Cache-Control`). The page and the API answer `no-store`, and Cloudflare keeps one copy for everyone who asks for the same address, whoever they are: a cached answer to the keeper (`/api/private` holds the private sections, decrypted) would go to the next visitor who asked for it.

Optional, and free: add a rate-limiting rule under Security → WAF:

- Match: URI path equals `/api/login`.
- Limit: 5 requests per 10 seconds per IP.
- Action: block.

The server throttles failed logins by itself anyway.

## 5. Caddy

```sh
sudo install -d -m 750 -o root -g caddy /etc/caddy/certs
sudo nano /etc/caddy/certs/origin.pem          # paste the Origin Certificate
sudo nano /etc/caddy/certs/origin.key          # paste its private key
sudo curl -fsSo /etc/caddy/certs/cloudflare-origin-pull-ca.pem https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem
sudo chown root:caddy /etc/caddy/certs/* && sudo chmod 640 /etc/caddy/certs/*
sudo cp /opt/dezept-website/chalice-archive/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile                 # set your hostname
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl restart caddy
```

What the Caddyfile does:

- It requires Cloudflare's client certificate (Authenticated Origin Pulls), so connections that don't come through Cloudflare fail during the TLS handshake.
  - If you leave Authenticated Origin Pulls off in Cloudflare, delete the `client_auth` block, or every request fails with error 525/526.
- It trusts `CF-Connecting-IP`, the visitor's address, only when the request comes from Cloudflare's ranges. It hands that address to Node as `X-Real-IP`, overwriting anything the request carried.
- It switches off Caddy's admin API. Left on, it listens on `localhost:2019` and takes a whole new configuration from any process on the VPS that asks, the archive's own server included, which is otherwise allowed only loopback: a server that had been broken into could have had Caddy serve the Origin Certificate's key. So a changed Caddyfile needs `systemctl restart caddy`, not `reload`, which goes through the admin API.
- It caps request bodies at 100 MB for uploads (`/api/uploads`, the same as Cloudflare's own limit on the Free and Pro plans) and 320 KB for everything else, compresses responses and drops the `Server` and `Via` headers. The server's own limits are lower (8 MiB for a picture, 40 MiB for a GIF, 90 MiB for a video, and 256 KiB or 64 KiB), so it is the one that answers with a clear message.

## 6. Firewall

```sh
sudo sh /opt/dezept-website/chalice-archive/deploy/firewall.sh                  # SSH on 22
sudo SSH_PORT=2222 sh /opt/dezept-website/chalice-archive/deploy/firewall.sh    # or another SSH port
```

- The script allows SSH (rate-limited) and 443 from Cloudflare's current ranges, and denies everything else.
- It checks every range it fetches before using it. If one is not a plain IPv4 or IPv6 range, or is wide enough to open the port to most of the internet, it stops and changes nothing.
- Run it again now and then to pick up new Cloudflare ranges.
- When Cloudflare's list changes, update the `trusted_proxies` line in the Caddyfile too.

## 7. Check it

```sh
curl -sI https://archive.example.com | grep -iE '^(HTTP|content-security-policy|strict-transport)'
curl -m 5 -k https://<the VPS's IP>/        # should time out: the firewall drops it
journalctl -u chalice-archive -n 20         # "Chalice Archive listening on http://127.0.0.1:8080"
```

Then open the site:

1. Click the gem. Once it has drawn the light in, choose About, Art, Character Knowledge or Encounters beneath the construct.
2. Click the small brass clasp on the tome's right edge and speak the word.
3. The editing tools appear: **Amend this page** in About, **Add a form** in Art (then **Add an art piece** inside the form), **Inscribe record** in Character Knowledge, **Record an encounter** in Encounters.

## Day to day

- **Updating**:

  ```sh
  cd /opt/dezept-website && sudo git pull && sudo systemctl restart chalice-archive
  ```

  Sessions live in memory, so a restart signs the keeper out.
  If `deploy/Caddyfile` changed (it did when art uploads were added, again when videos were, and again when its admin API was switched off), copy it again and restart Caddy, keeping your hostname:

  ```sh
  sudo cp /opt/dezept-website/chalice-archive/deploy/Caddyfile /etc/caddy/Caddyfile
  sudo nano /etc/caddy/Caddyfile                 # set your hostname
  sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl restart caddy
  ```
- **Backups**:
  - Each change keeps the previous `archive.json` in `/var/lib/chalice-archive/backups/`, up to the last 50.
  - The images, GIFs and videos are in `/var/lib/chalice-archive/art/`. A file stays there while the archive or any of those 50 backups uses it, so restoring a backup finds its images. Videos take room: a removed one stays until it has dropped out of the last 50 backups, so keep an eye on the disk (`df -h /var/lib`).
  - Copy the whole `/var/lib/chalice-archive` directory off the VPS now and then.
  - To restore, stop the service, copy a backup over `archive.json`, then start the service.
  - The encounters' private sections, and the encounters only for you, are encrypted in `archive.json` and every backup. Keep `auth.json` with them: its wrapped key and your word are what read them. A copy of the directory without the word is a copy without the private sections.
- **Removing a picture for good**: removing its art piece stops the server serving it at once. Cloudflare keeps its copy for up to a day; to clear it sooner, purge the image's address under Caching → Configuration → Custom Purge.
- **Videos and Cloudflare**: Cloudflare's Service-Specific Terms ([explained here](https://blog.cloudflare.com/updated-tos/)) say that on the Free, Pro and Business plans the CDN is not for serving video from your own server; that takes Stream, R2 or the Enterprise plan. Cloudflare reserves the right to limit a site that does it anyway, or that serves a disproportionate share of pictures or other large files. Keep videos short and few, or decide to host them elsewhere.
- **Logs**:
  - The server logs only startup messages and unexpected errors, to the journal.
  - Caddy keeps no access log with this Caddyfile.

## What protects what

- **The word**:
  - Stored only as a salted scrypt hash (N=2¹⁷, r=8, p=1).
  - Checked only on the server, one check at a time.
  - From the third wrong try from one address, each miss imposes a wait that doubles (2 s, 4 s, 8 s …), up to an hour. An IPv6 address counts with the rest of its /64, which one client usually holds whole.
  - Each try counts the moment it is made, so a burst of guesses sent all at once gets no more tries than guesses sent one after another.
  - Over 50 failures in ten minutes from anywhere pauses all logins for a while, except from a browser that has spoken the right word before: it carries a signed device cookie, which a new word cancels. So guessing from many addresses at once gains nothing, and cannot keep you out either.
- **The session**:
  - A random 256-bit token in a `__Host-` cookie: HttpOnly, Secure, SameSite=Strict.
  - Page scripts can't read it, and other sites can't make the browser send it.
  - The server keeps only its SHA-256.
  - Sessions end after 12 hours (`SESSION_HOURS`), on "Seal it again", or when the word changes.
  - Once a session has ended, an open tab lets go of the private sections within a minute, or as soon as it is looked at; one sealed in another tab of the same browser, at once.
- **Writes**:
  - Each needs the session, a CSRF token in a header, a JSON body, and an `Origin` equal to `PUBLIC_ORIGIN`.
  - Uploads are the one exception to JSON: PNG, JPEG, WebP or GIF images and MP4 or WebM videos only, checked by their bytes, at most 8 MiB for a picture, 40 MiB for a GIF and 90 MiB for a video, stored under their content hash and served with their own type and `nosniff`. SVG is never accepted.
  - GIFs lose their comments and XMP; MP4s lose their `udta`, `meta` and XMP boxes (where a phone recorded them, tags), which are zeroed in place. WebM videos are kept as they come. Pictures are re-encoded in the keeper's browser, which keeps nothing but the picture.
  - Every field is validated and capped on the server. Artists' links must be `http(s)`.
  - The page shows all of it as text, never as markup.
- **The page**:
  - The CSP allows only its own inline script and style, by hash, and three.js and the fonts from the site itself. Nothing comes from another host: no CDN can run code in the page, so none could reach the keeper's session or the private sections, and no font host learns who visits.
  - It also requires Trusted Types: browsers that support them (Chrome and Edge among them) refuse any attempt to write HTML into the page or turn text into script, so even a mistake in the page's code could not become cross-site scripting.
  - Also sent: HSTS, `nosniff`, no framing, no referrer, and a Permissions-Policy that switches off the camera, microphone, location and other features the page never uses.
- **Slow requests**: a JSON body has 60 seconds to arrive, so nobody can hold connections open by sending a login a byte at a time. A request refused before its body has arrived, such as an upload without a session, is answered at once and let go 10 seconds later. A download stopped half way closes its file at once.
- **The machine**:
  - Node runs as an unprivileged user.
  - It can write only `/var/lib/chalice-archive` and talk only to loopback, where nothing else listens that could be told what to do: Caddy's admin API is switched off.
  - The port Caddy listens on accepts only Cloudflare.

`tools/smoke.js` tests these properties against a running server: headers, CSRF, Origin, cookies, validation, throttling, password changes and the page itself under its CSP.
