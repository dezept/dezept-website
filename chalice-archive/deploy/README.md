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

- Until this setup is merged, add `-b claude/new-session-qjr9xt`.
- If the repository is private, give the VPS a read-only deploy key.
- `dist/` is committed, so the VPS needs no build step.

## 3. Run the archive server

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin chalice
sudo cp /opt/dezept-website/chalice-archive/deploy/chalice-archive.service /etc/systemd/system/
sudo nano /etc/systemd/system/chalice-archive.service     # set PUBLIC_ORIGIN=https://archive.example.com
sudo systemctl daemon-reload
sudo systemctl enable --now chalice-archive
```

- systemd creates `/var/lib/chalice-archive` (mode 0700, owned by `chalice`).
- On the first start the server copies `src/seed.json` into `archive.json` there.

Then set the keeper's word, as the service user:

```sh
sudo -u chalice env DATA_DIR=/var/lib/chalice-archive node /opt/dezept-website/chalice-archive/server/server.mjs set-password
```

- It asks twice and shows nothing while you type, so the word stays out of shell history and logs.
- Use at least 12 characters, and a phrase you use nowhere else.
- Only a salted scrypt hash is stored (`auth.json`, mode 0600).
- The word also locks the key that encrypts the encounters' private sections. The key is made on the first login and stored in `auth.json` only wrapped by a second key derived from the word, so nothing on disk can read the private sections without the word.
- Running it again replaces the word and signs every session out. Once there are private sections, it asks for the current word a third time, to carry the key over to the new word. Changing the word from the page does the same.
- **A forgotten word:** run `set-password --forget-private` instead. The archive opens again with the new word, but the private sections written so far can never be read again, by anyone. Everything else is untouched.

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
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

What the Caddyfile does:

- It requires Cloudflare's client certificate (Authenticated Origin Pulls), so connections that don't come through Cloudflare fail during the TLS handshake.
  - If you leave Authenticated Origin Pulls off in Cloudflare, delete the `client_auth` block, or every request fails with error 525/526.
- It trusts `CF-Connecting-IP`, the visitor's address, only when the request comes from Cloudflare's ranges. It hands that address to Node as `X-Real-IP`, overwriting anything the request carried.
- It caps request bodies at 10 MB for image uploads (`/api/uploads`) and 320 KB for everything else, compresses responses and drops the `Server` and `Via` headers. The server's own limits are lower (8 MiB, and 256 KiB or 64 KiB), so it is the one that answers with a clear message.

## 6. Firewall

```sh
sudo sh /opt/dezept-website/chalice-archive/deploy/firewall.sh                  # SSH on 22
sudo SSH_PORT=2222 sh /opt/dezept-website/chalice-archive/deploy/firewall.sh    # or another SSH port
```

- The script allows SSH (rate-limited) and 443 from Cloudflare's current ranges, and denies everything else.
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
3. The editing tools appear: **Amend this page** in About, **Add a plate** in Art, **Inscribe record** in Character Knowledge, **Record an encounter** in Encounters.

## Day to day

- **Updating**:

  ```sh
  cd /opt/dezept-website && sudo git pull && sudo systemctl restart chalice-archive
  ```

  Sessions live in memory, so a restart signs the keeper out.
  If `deploy/Caddyfile` changed (it did when art uploads were added), copy it again and reload Caddy, keeping your hostname:

  ```sh
  sudo cp /opt/dezept-website/chalice-archive/deploy/Caddyfile /etc/caddy/Caddyfile
  sudo nano /etc/caddy/Caddyfile                 # set your hostname
  sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
  ```
- **Backups**:
  - Each change keeps the previous `archive.json` in `/var/lib/chalice-archive/backups/`, up to the last 50.
  - The images are in `/var/lib/chalice-archive/art/`. An image stays there while the archive or any of those 50 backups uses it, so restoring a backup finds its images.
  - Copy the whole `/var/lib/chalice-archive` directory off the VPS now and then.
  - To restore, stop the service, copy a backup over `archive.json`, then start the service.
  - The encounters' private sections are encrypted in `archive.json` and every backup. Keep `auth.json` with them: its wrapped key and your word are what read them. A copy of the directory without the word is a copy without the private sections.
- **Removing a picture for good**: removing its plate stops the server serving it at once. Cloudflare keeps its copy for up to a day; to clear it sooner, purge the image's address under Caching → Configuration → Custom Purge.
- **Logs**:
  - The server logs only startup messages and unexpected errors, to the journal.
  - Caddy keeps no access log with this Caddyfile.

## What protects what

- **The word**:
  - Stored only as a salted scrypt hash (N=2¹⁷, r=8, p=1).
  - Checked only on the server, one check at a time.
  - From the third wrong try from one address, each miss imposes a wait that doubles (2 s, 4 s, 8 s …), up to an hour.
  - Over 50 failures in ten minutes from anywhere pauses all logins for a while.
- **The session**:
  - A random 256-bit token in a `__Host-` cookie: HttpOnly, Secure, SameSite=Strict.
  - Page scripts can't read it, and other sites can't make the browser send it.
  - The server keeps only its SHA-256.
  - Sessions end after 12 hours (`SESSION_HOURS`), on "Seal it again", or when the word changes.
- **Writes**:
  - Each needs the session, a CSRF token in a header, a JSON body, and an `Origin` equal to `PUBLIC_ORIGIN`.
  - Image uploads are the one exception to JSON: PNG, JPEG or WebP only, checked by their bytes, at most 8 MiB, stored under their content hash and served with their own type and `nosniff`. SVG is never accepted.
  - Every field is validated and capped on the server. Artists' links must be `http(s)`.
  - The page shows all of it as text, never as markup.
- **The page**:
  - The CSP allows only its own inline script and style, by hash, plus three.js from jsDelivr and the fonts from Google.
  - Also sent: HSTS, `nosniff`, no framing, no referrer.
- **The machine**:
  - Node runs as an unprivileged user.
  - It can write only `/var/lib/chalice-archive` and talk only to loopback.
  - The port Caddy listens on accepts only Cloudflare.

`tools/smoke.js` tests these properties against a running server: headers, CSRF, Origin, cookies, validation, throttling, password changes and the page itself under its CSP.
