# Chalice Archive: handover

A one-page RP site for a Dracthyr character. The landing page is nothing but his construct (the *Eternal Gladiator's Chalice*, an archival construct bought from a Shadowlands broker) floating on a dark stage. It is rendered from the game's own 3D model and turns to aim its gem at the cursor. Clicking the gem locks on, sweeps a teal scan line down the screen and over the model, then opens the archive. The archive is an old leather-bound tome in the style of the game's books and journals. It holds only his records: the most recent on the left page, and a chaptered index of everything he has re-learned since waking on the right.

- **Self-hosted** on the owner's VPS: Cloudflare in front, then Caddy, then a small Node server (`server/server.mjs`, no dependencies) that serves the page and the model, stores the records, and checks the keeper's word. **`deploy/README.md` is the step-by-step setup.**
- **The old claude.ai Artifact** (https://claude.ai/artifact/UFSgUToU7a4ZhuMdXe6ZWh, version 12) is left as it was: a frozen snapshot that no longer matches this code. Its data (no records, no word) matched `src/seed.json` when the move was made, so nothing needed migrating.

## Status

| Area | State |
|---|---|
| Landing (the construct alone, no text), scan animation, archive tome, record detail | Done |
| Inscribe / revise / remove record, remove examples | Done, through the server's API |
| **Keeper's seal** | **Done.** A brass clasp on the tome's edge opens a small panel. The keeper's word is checked on the server and gives a session; **Seal it again** ends it. The word is set on the VPS with `set-password` and can be changed from the panel. |
| Server, Caddy, Cloudflare, firewall, systemd | Written and tested here. The server is covered by `tools/smoke.js` (60 checks). The Caddyfile was run with Caddy 2.10.2 in front of the server, with test certificates standing in for Cloudflare's. The systemd unit passes `systemd-analyze verify`, but this container has no systemd to run it. |
| Profile (name, epithet, construct name and note) | Kept in the data, not shown or editable. The name is only used for screen readers. To change it, stop the service and edit `profile` in `/var/lib/chalice-archive/archive.json`. |
| **Construct** | **Done.** The real in-game model (M2 → GLB) at the game's full detail, drawn with three.js and the game's own shading, animation and glow. It aims its gem at the cursor. The screenshot cutout remains as the fallback. |
| Content | No records yet. |

## Files

```
build.py                         builds dist/ from src/ + assets/
src/page.html                    the page: CSS, markup, app script, with placeholders
src/seed.json                    the starting archive, copied to DATA_DIR/archive.json on the server's first start
server/server.mjs                the server (Node 20+, no dependencies); `set-password` sets the keeper's word
deploy/README.md                 VPS setup: Node, Caddy, Cloudflare, firewall, backups, what protects what
deploy/Caddyfile                 Caddy in front of the server: Origin Certificate, Authenticated Origin Pulls, real client IP
deploy/chalice-archive.service   systemd unit with sandboxing
deploy/firewall.sh               ufw: 443 only from Cloudflare, SSH rate-limited, everything else closed
assets/model/chalice.glb         the construct's 3D model (made by tools/m2_to_glb.py, 544 KB)
assets/front.webp|png            front-view cutout (fallback while/if the model can't load)
assets/screenshots/              the original in-game screenshots
tools/m2.py                      minimal reader for M2 models and .skin files
tools/m2_to_glb.py               downloads the game files and writes assets/model/chalice.glb
tools/smoke.js                   starts the server and tests the API and the page; npm install in tools/ first
tools/cutout.py                  background removal used to make the cutouts (ISNet via onnxruntime)
dist/index.html                  the built page (committed, so the VPS needs no build step)
dist/chalice.<hash>.glb          the model, named by its SHA-256 so it can be cached forever
```

Placeholders in `src/page.html`:

| Placeholder | Filled by | With |
|---|---|---|
| `__FRONT__` | `build.py` | WebP data URI of the front cutout |
| `__MODEL_URL__` | `build.py` | `chalice.<first 12 hex of SHA-256>.glb` |
| `__ARCHIVE__` | the server, per request | the archive JSON, with `<`, `>`, `&`, U+2028 and U+2029 escaped |

### Running it locally

```
python3 build.py
node server/server.mjs set-password                  # asks twice; data goes to server/data/ (git-ignored)
COOKIE_SECURE=false node server/server.mjs           # http://127.0.0.1:8080
```

`COOKIE_SECURE=false` drops the cookie's `Secure` flag and `__Host-` prefix and HSTS, which plain http needs. Never set it in production.

## How the page works

### Structure

`dist/index.html` is an ordinary document: `<head>` with the title, an inline SVG favicon, a preload of the model, the Google Fonts `<link>` and `<style id="ca-style">`; `<body>` with the markup (stage, scan overlay, the `<dialog>` tome, the toast), `<script type="application/json" id="ca-data">` and `<script id="ca-app">`. The model is fetched from `MODEL_URL`.

The server computes SHA-256 hashes of `ca-app` and `ca-style` at startup and puts them in the Content-Security-Policy, so they are the only inline script and style that can run. **Any other inline `<script>`, `<style>`, `style="…"` attribute or `on…=` handler is blocked.** Add styles to `ca-style`, code to `ca-app`, and set styles from JS through `el.style` (allowed), not `setAttribute("style", …)`.

### Server and API

| Route | Who | Does |
|---|---|---|
| `GET /` | anyone | the page, with the current archive in `ca-data` |
| `GET /chalice.<hash>.glb` | anyone | the model, cached for a year (`immutable`) |
| `GET /api/session` | anyone | `{owner, csrf}`: whether this browser holds the keeper's session, and its CSRF token |
| `GET /api/archive` | anyone | `{archive}` |
| `POST /api/login` | anyone, throttled | `{password}` → session cookie + `{csrf}` |
| `POST /api/logout` | keeper | ends the session |
| `POST /api/password` | keeper | `{current, next}` → new word, every other session ended |
| `POST /api/records` | keeper | new record → `{archive, id}` |
| `PUT /api/records/:id` | keeper | revise → `{archive, id}` |
| `DELETE /api/records/:id` | keeper | remove → `{archive}` |
| `POST /api/records/clear-examples` | keeper | remove example records → `{archive}` |

- **Keeper-only routes** need the session cookie, an `X-CSRF-Token` header equal to the session's token and an `Origin` equal to `PUBLIC_ORIGIN`. Bodies must be JSON (`Content-Type: application/json`, at most 64 KB).
- **Server-side cleaning:** ids, `added` and `example` are set by the server. Text is trimmed, stripped of control characters and capped (title 120, domain 60, note 4000, source 160). Unknown states become `fragment`, bad dates become today, an empty domain becomes "Unsorted".
- **Storage:** `DATA_DIR/archive.json`, written atomically (temp file, fsync, rename). The previous version goes to `DATA_DIR/backups/` first, keeping the last 50. `auth.json` holds the scrypt hash. All are mode 0600 in a 0700 directory.
- **Sessions** are kept in memory (at most 50), so a restart signs the keeper out. Only each token's SHA-256 is stored.
- **In the page** (`ca-app`): `call(method, url, body)` wraps `fetch` with the CSRF header. `save()` sends a change and re-renders from the archive the server returns. A 401/403 asks the server about the session again: if it has ended, the seal panel opens without closing an open form, so the keeper can unseal and press Inscribe again.
- **Deletes** are two-step buttons: the first click arms, the second confirms, and they disarm after 5 s.

### Data model

```jsonc
{
  "profile": { "name": "", "epithet": "", "construct": "", "constructNote": "" },
  "records": [{
    "id": "r…",               // set by the server: "r" + 12 random base64url characters
    "title": "",
    "domain": "",             // free text; SUGGESTED_DOMAINS sets display order
    "status": "relearned",    // see below
    "note": "", "source": "",
    "date": "YYYY-MM-DD",
    "added": 0,               // ms timestamp, tie-breaker for ordering
    "example": false
  }]
}
```

| `status` | Label | Meaning | Colour / glyph |
|---|---|---|---|
| `remembered` | Remembered | Known before the slumber and still true | Copper, filled diamond |
| `superseded` | Superseded | Known before, no longer true | Rose, struck diamond |
| `relearned` | Re-learned | Learned since waking | Teal, filled diamond |
| `fragment` | Fragmentary | Heard of, not understood | Amber, half diamond |
| `sought` | Sought | A gap he means to fill | Grey, hollow diamond |

- **Recent accessions:** sorted by `date` desc, then `added` desc, top 6.
- **Knowledge index:** grouped by domain.

### Design

- **Two worlds, one token set** (`:root` of `ca-style`): the landing is the dark void (navy grounds, teal light, copper). The archive is the tome (leather, parchment, sepia ink, red rubric ink, brass, and the game's red-and-gold buttons). It is a single deliberate look, not light and dark themes.
- **Fonts:** Cinzel (titles, buttons, the game's inscriptional capitals), IM Fell English (the book's text, an 18th-century typeface with old-style numerals) and IM Fell English SC (labels and dates).
- **The tome:** a leather binding (`.tome`, SVG noise as the hide) with brass corner fittings (`--corner`, an inline SVG) and a red silk ribbon in the gutter.
  - **Pages:** two parchment leaves either side of a shadowed spine (`.book`, `#page-l`, `#page-r`). The paper is fine SVG grain plus a stretched low-frequency stain (`--grain`, `--mottle`); a tiled stain showed a seam. Stacked page edges show beneath.
  - **Left leaf:** the keeper's buttons (Inscribe record, and Remove examples while any exist; shown only during the keeper's session), then "Recent accessions", the latest six records with date, state and the start of the note.
  - **Right leaf:** the "Index of knowledge" as a table of contents. Domains are numbered chapters with roman numerals, and each entry runs to its state on dotted leaders. A record or a form opens on this leaf. A record has a red drop capital and its sources as marginalia. Forms are written on ruled lines.
  - **Game styling:** buttons copy the game's red panel buttons (gold text, brass rim). The close button is the round red one, and notices are dark tooltips with gold text.
  - **Narrow screens (≤ 860 px):** one leaf at a time. Opening a record or a form hides the recent accessions (`.book[data-view]`), so it is not buried below them.
- **Landing:** only the construct, centred on the dark stage, with its ambient light (below). There is no visible text and no ring. The character's name is only in a visually hidden `<h1>`, the button's accessible name ("Scan the archive of …") and the archive's hidden heading.
- **Not shown anywhere:** the profile (name, epithet, construct name and note), the state-of-knowledge ledger and filters, and "Example" tags. The removed pieces are gone from the code, not hidden. The `example` flag stays in the data so **Remove examples** still works.
- **Float (cutout fallback only):** three nested wrappers with different periods, so the motion never visibly loops: `.fx-x` 13 s drift, `.fx-y` 5.6 s bob, `.fx-tilt` 9 s tilt. In 3D mode they stop: the model hovers on its own, and the canvas must stay put under the cursor it aims at.
- **Starting a scan:** only the gem starts it. A pointer click must land on the gem: `model3d.gemAt(x, y)` raycasts the gem mesh in its current pose, with slack inside 55 % of its projected bounding circle. While the pointer is over the gem, the stage gets `.on-gem` (hand cursor) and the gem brightens. Clicks anywhere else do nothing. Keyboard activation of the construct button (Tab, then Enter or Space; the click reports `detail` 0) always scans. Without the 3D model, the hit area is the cutout's gem overlay.
- **Scan:** `scan()` adds `.is-scanning` to the stage (corner brackets lock on, gem flares). It shows `#scan`: a beam plus a grid revealed by `clip-path`, both on the same 1.45 s easing. The dialog opens at about 1.95 s with a clip-path unfold.
- **Halo and pool:** with the cutout they pulse with the CSS bob. In 3D mode the renderer writes the model's hover height to `--lift` on `.core` each frame, and `.halo` and `.pool` follow it.
- **Ambient light.** The idea is a lamp in the void that gathers drifting memories.
  - **Haze (`.nebula`, CSS):** three large indigo, teal and copper clouds that drift over 70 to 110 s with `mix-blend-mode: screen`. They only move by transform, so they stay cheap.
  - **Light shafts (`#motes` canvas):** nine soft wedges fanning from the construct. They turn slowly in both directions and brighten as the model rises (`model3d.lift()`). Each wedge is drawn three times at narrowing widths for a soft edge. They are on the canvas rather than in CSS because a rotating CSS layer that large costs tens of MB of GPU memory at 2× pixel density.
  - **Motes (`#motes`):** at random depths. Near ones are larger, brighter and faster, and slide against the cursor more than far ones, for parallax.
  - **Anima wisps (`#motes`):** six glowing teal or copper streaks with tapered trails. They drift in from the edges on a slow flow field and orbit the construct. Some spiral in, and each arrival flickers the gem (`model3d.absorb()`). Clicking to scan pulls every wisp in flight into the construct (`motes.gather()`).
  - **Paused** while the archive is open (`.is-paused` on the stage) or the tab is hidden.
- **Reduced motion:** `prefers-reduced-motion` turns off the float, the halo and pool pulse, the haze drift, the motes, the wisps, the sweep and the unfold. The shafts stay as a still frame. The model draws one still frame and does not follow the cursor.

## The keeper's seal and what keeps the archive safe

- **The clasp:** the brass keyhole on the tome's right edge (`#clasp`) opens the seal panel (`#seal`). It is deliberately small and unlabelled; visitors see a book fitting.
- **Unsealing:** the word goes to `POST /api/login` over HTTPS. The server compares it with the stored scrypt hash (N=2¹⁷, r=8, p=1, 16-byte salt, 64-byte key; one check at a time, so a burst cannot exhaust memory). The right word gets a random 256-bit session token in a `__Host-ca_session` cookie (HttpOnly, Secure, SameSite=Strict, 12 hours), plus a CSRF token in the response body, kept in a variable.
- **Wrong words:** two free misses per client address, then waits of 2 s, 4 s, 8 s … up to an hour (429 with Retry-After). More than 50 misses in ten minutes from anywhere pauses all logins until the window clears. Behind Caddy, the client address is Cloudflare's `CF-Connecting-IP`, trusted only from Cloudflare's ranges and passed on as `X-Real-IP`; the server believes `X-Real-IP` only from loopback and only with `TRUST_PROXY=true`.
- **Panel modes:** unsealed, the panel offers **Seal it again** (logout) and **Change the word** (current word, new word twice; at least 12 characters). Changing the word signs every other session out.
- **Setting the word:** only on the server, as the service user: `node server/server.mjs set-password` asks twice with hidden input (or reads two lines from stdin). It refuses words under 12 characters. There is no web form for a first word, so nobody can claim the archive before the keeper does. Running it again is also the recovery path for a forgotten word.
- **Where the word goes:** typed into the panel, sent once over HTTPS, hashed, discarded. It is never logged, stored in the browser, or written into the page. The inputs are cleared after use.
- **Encryption:**
  - In transit: visitor ↔ Cloudflare uses Cloudflare's edge certificate, and Cloudflare ↔ Caddy uses the Origin Certificate in Full (strict) mode with Authenticated Origin Pulls, TLS 1.2+. Caddy ↔ Node is plain HTTP on loopback only.
  - At rest: the records are not encrypted, because they are published to every visitor. The word is hashed, not encrypted, so it cannot be recovered from `auth.json`.
- **Untrusted input:** every record field is rendered with `textContent`, never as HTML. The data block escapes `<`, `>`, `&`, U+2028 and U+2029. The CSP blocks any script that is not the page's own.
- **Headers on every response:** the CSP (`default-src 'none'`; scripts: the page's hash and jsDelivr's `/npm/`; styles: the page's hash and Google Fonts; `connect-src 'self'`; `frame-ancestors 'none'`), HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP same-origin and a restrictive Permissions-Policy.

## The 3D construct

### Source

The model is the item's own game asset, not a recreation. Item 192207 *Eternal Gladiator's Chalice* shares its appearance with the Cosmic Gladiator's Chalice, and the model is `offhand_1h_progenitorraid_d_01.m2`. The lookup chain from item to file IDs is written out at the top of `tools/m2_to_glb.py`. The files come from wago.tools, which serves raw files from Blizzard's CDN by FileDataID.

**wow.export would not give a better model.** It reads the same files from the same CDN. The GLB already uses the most detailed geometry (skin 0, 958 triangles; the M2's 2,385 vertices are its four LODs stored back to back) and every texture's top mip, which is the largest stored in the game files (the item texture is 256 × 256). The textures are stored lossless and are pixel-identical to the decoded game files.

```
python3 tools/m2_to_glb.py                   # copper variant (matches the screenshots)
python3 tools/m2_to_glb.py --variant elite   # silver variant of the same appearance
python3 build.py
```

Raw downloads are cached in `tools/.cache/` (git-ignored). Only the converted GLB is committed.

### What the GLB holds

- One skinned mesh (LOD 0: 838 vertices, 958 triangles) in four primitives: `gem`, `body`, `shell_edge` and `shell`. Each primitive has its own vertex range, so its POSITION bounds describe only itself (three.js computes mesh bounds from the whole attribute). Y is up and the gem faces +Z.
- Six joints and one 5 s `Stand` clip: the hover (bones 0–2 rise about 0.13 units) and the orb's two-axis spin (bones 3 and 4).
- Five lossless WebP textures at full game resolution: the copper item texture, the env sphere map, two shell noise textures and the orange glow sprite.
- Standard glTF materials, so any viewer shows something sensible, plus the M2 shading in `materials[].extras.wow` (combiner, vertex shader, blend mode, all texture slots, UV scroll). The glow emitter's curves are in `nodes[glow_emitter].extras.wowParticle`.
- It passes the Khronos glTF validator with 0 errors and 0 warnings.

### Renderer (`model3d` in `ca-app`)

- **Loading:** three.js 0.186.1 and its GLTFLoader load as ES modules from jsDelivr's `+esm` bundles with dynamic `import()`, in parallel with the model's `fetch(MODEL_URL)` (already started by a `<link rel="preload">`). The loader's bundle imports `three` from the same pinned URL, so there is one three.js instance and no import map. GLTFLoader normally decodes embedded images through `blob:` URLs, which the CSP's `img-src 'self' data:` refuses, so a small plugin decodes them through `<img>` with data URIs instead.
- **Shading:** a `ShaderMaterial` reproduces the game's combiners in gamma space. `Combiners_Opaque_Mod2xNA_Alpha` with a sphere-mapped env texture shades the body and gem. `Combiners_Mod_Mod` shades the additive shells, and `shell_edge` also gets the game's edge fade. Lighting is ambient plus a warm key and a teal under-fill, with a teal rim that strengthens on hover. Additive passes leave canvas alpha untouched, so they add light to the page instead of darkening it.
- **Motion:** the model's own clip plays, the shell UVs scroll on their 4.033 s loop, and five glow sprites follow the emitter's colour, alpha and size curves. The sprites fade to zero at their edges, because the glow texture's background is near-black and would otherwise show as a faint square on the dark stage.
- **Cursor:** `aim()` casts the cursor's ray through the camera and meets it with a pane facing the camera, `GAP` (1.2) model units in front of the construct. It then turns the construct so the gem's own line of sight, not the centre's, passes through that point. On screen the gem always points straight at the cursor. `GAP` sets how far it turns: 0.7 swings it nearly side-on at the window's corners. It eases in through two smoothing stages in a row (`Math.exp(-dt * 7)` each), so the turn starts gently and trails the cursor by about 290 ms. With no cursor (touch after release, pointer outside the window) it sways ±22° on its own. Touch follows the finger while it is down.
- **Gem:** pulses on the CSS gem's 3.4 s rhythm and flares on scan.
- **Scan:** each frame of the sweep reads the CSS beam's position and the tilt wrapper's rotation, and lights a teal band on the model exactly under the beam, with a fading wash above it. The model's animation slows to 15 % speed while it is being scanned.
- **Fallback:** the cutout stays visible until the first frame is drawn, then cross-fades out. If WebGL, the CDN or the GLB fails, the page keeps the cutout and logs one console warning. WebGL context loss also falls back to the cutout.
- **Size:** the canvas is twice the button (`--size`, up to 460 px), so the construct can turn without clipping. The camera frames the body at 40 % of the canvas.
- **Cost:** device pixel ratio is capped at 2, and textures use up to 8× anisotropic filtering. The loop pauses while the dialog is open, the tab is hidden or the canvas is off-screen.

### Smoke test

```
python3 build.py
cd tools && npm install
CHROME=/path/to/chrome node smoke.js
```

It starts the real server twice with throwaway data under `tools/.smoke/`:

- **API checks** use production settings: Secure cookies, `PUBLIC_ORIGIN`, `TRUST_PROXY`. They cover:
  - the password file and `set-password`;
  - the CSP hashes against the served page, and the other headers;
  - path traversal and other paths;
  - Origin, CSRF and content-type refusals;
  - the cookie's flags;
  - field cleaning and size limits;
  - stored markup escaping;
  - backups;
  - changing the word, which signs older sessions out;
  - logout;
  - per-address throttling via `X-Real-IP`.
- **Browser checks** run Chromium against the server's real CSP and treat any console error or CSP violation as a failure. They walk the gem, then:
  - try a wrong word, then the right one, confirming the cookie stays invisible to scripts;
  - inscribe a record containing markup, which must stay text;
  - reload, still unsealed, then revise and remove the record;
  - change the word;
  - seal, reload, and unseal with the new word.

Screenshots go to `tools/.smoke/`. Behind an intercepting proxy, pass the proxy CA's key to Chromium with `CHROME_ARGS="--ignore-certificate-errors-spki-list=<sha256 of the CA's SPKI, base64>"`.

## Open items for the owner

- **Deploy:** follow `deploy/README.md`. Replace `archive.example.com` in the Caddyfile and in `PUBLIC_ORIGIN` in the unit.
- **Set the keeper's word on the VPS** with `set-password` (step 3). Don't share it in chats or files.
- **Optional:** set `profile.name` for screen readers. It lives in `archive.json` on the server once deployed, or in `src/seed.json` before the first start.
- **Optional:** once the site is live, the old claude.ai Artifact can be deleted, or left private.
