# Chalice Archive: handover

A one-page RP site for a Dracthyr character. The landing page is nothing but his construct (the *Eternal Gladiator's Chalice*, an archival construct bought from a Shadowlands broker) floating on a dark stage. It is rendered from the game's own 3D model and turns to aim its gem at the cursor. Clicking the gem draws in all the light drifting in the dark around it: wisps, flares and motes spiral into the gem while it charges, then it flashes, a ring of light leaves it, and the construct rises and projects its choices beneath it: **About**, **Art**, **Character Knowledge** and **Encounters**. Closing the tome takes the choices away again; the gem has to be clicked once more to bring them back.

Each choice opens its chapter of the archive: a single parchment page in a leather binding, in the style of the game's books and journals, with index tabs on its top edge to move between chapters. Each chapter reads down one centred column; there is no two-page spread.

- **About:** laid out like a Total RP 3 profile. His title, name and full title head the page; then Currently and OOC, the directory (race, class, age, eyes …), additional information, personality traits, at first glance, and the description in sections. The description keeps TRP3's markup, so a TRP profile can be pasted in.
- **Art:** his **forms** (say "Character (OC)" and "Character (Dracthyr)"), each a gallery with its first piece as its cover. A form opens on its **art pieces** as a list; a piece opens on its own page, and a full-size view shows it on a dark ground. A piece is one or more images: its main image and alternate versions, and each can be a picture, an animated **GIF** (with a button to pause it) or a **video** (MP4 or WebM, in the archive's own player). Any image can be flagged **mature**: it stays covered, and is not even loaded, until a visitor says they are 18 or older, and it is covered again once they move on.
  - In the code and the API an art piece is still a *plate* (`art`, `/api/art`, `plateId`) and a form is a *gallery* (`galleries`, `/api/galleries`), so as not to confuse it with the page's HTML forms.
- **Character Knowledge:** his records, newest first: what he has learned, with an optional date, and where he learned it, in his own words or by naming one of the encounters, which then links to it.
- **Encounters:** what happened when he met someone or something, newest first, with what he learned from each. Each can have a **private section** only the keeper sees while unsealed. It is never sent to visitors, and it is stored encrypted with a key that only the keeper's word unlocks. An encounter can also be **only for the keeper** ("Only for me"): then all of it is encrypted with that key, and visitors receive nothing of it, not even that it exists.

- **Self-hosted** on the owner's VPS: Cloudflare in front, then Caddy, then a small Node server (`server/server.mjs`, no dependencies) that serves the page and the model, stores the records, and checks the keeper's word. **`deploy/README.md` is the step-by-step setup.**
- **Preview:** the claude.ai Artifact https://claude.ai/artifact/UFSgUToU7a4ZhuMdXe6ZWh is now the preview. After every change, publish `dist/preview.html` to it (see [Previewing changes](#previewing-changes-on-claudeai)) so the owner can see the change before deploying it. Version 13 is the first preview build; version 14 adds the hub and the About and Art chapters; version 15 adds alternate versions, mature images and the age check; version 16 is the single-page layout with the TRP-style About; version 17 sets section headings as pull quotes with a colour each; version 18 replaces the scan with the gem drawing the light in, and adds the flares; version 19 takes the portrait off the About page; version 20 simplifies Character Knowledge and adds Encounters with private sections; version 21 takes the hub's choices away when the tome closes, renames plates to art pieces, sorts them into his forms, and adds GIFs and videos with their players; version 22 takes the icons off the hub's choices and heads Art's list of forms "Overview"; version 23 adds encounters only for the keeper; version 24 is the security pass (the site serves three.js itself and requires Trusted Types; in the preview, Escape now keeps unsaved writing in every form and dates that do not exist are refused), and the Artifact declares no runtime capabilities any more, since the page uses none; version 25 is the second security pass (the site serves its fonts itself, and an unsealed tab lets go of the private sections as soon as the session has ended elsewhere; the preview itself still takes its fonts from Google); version 26 is the third pass (the server keeps idle connections from Caddy longer than Caddy does, so a save or an upload no longer fails with a 502 when both close one at the same moment; a record's link to an encounter only for the keeper follows the seal without the record being reopened; the keeper's address of such an encounter opens it after a reload; dates in years below 100 show in their own year; `set-password` refuses a word with an arrow key in it, and refuses to run as another user than the data directory's); version 27 is the fourth pass (a write whose body was still arriving when its session ended is refused; a login refused only because the server was busy no longer counts as a miss; a body sent with a GET is let go within seconds; the page is isolated from other sites with COEP; and an answer that arrives after a tab has sealed, or a form left after the session ended, leaves nothing private in the page); version 28 is the fifth pass (the video's bar goes on following the video after a click on it; the tome's close button keeps unsaved writing; just after unsealing, before the keeper's archive is back, an encounter only for the keeper is revised rather than saved a second time, a record keeps its link to one, and Escape keeps what was written in an encounter's form; moving an art piece stays on the image on view); version 29 is the sixth pass (revising an art piece, or cancelling the revision, stays on the image on view too; a form with no art yet is the keeper's alone also at its own address, which showed it to anyone; an encounter's form kept open as the session ended lets go of its private section once the tome is closed; an encounter only for the keeper written under a forgotten word says so once, not again in a private section; the age check and the full-size view keep the keyboard's focus where it can be used).
  - Before the move, its data (no records, no word) matched `src/seed.json`, so nothing needed migrating.

## Status

| Area | State |
|---|---|
| Landing (the construct alone, no text), the gem drawing the light in, archive (one page per chapter), record detail | Done |
| **Hub** (About, Art, Character Knowledge, Encounters beneath the construct once it has drawn the light in, no other text; gone again once the tome closes) and the tome's chapter tabs | Done |
| **About** page, as a Total RP 3 profile (no portrait): title, name, full title, currently and OOC, directory, additional information, personality traits, at first glance, description with TRP markup; amended by the keeper | Done, through the server's API |
| **Art**: his **forms**, each holding its **art pieces** (plates in the code), uploaded from the keeper's browser, ordered, captioned, shown full size | Done, through the server's API |
| **Alternate versions** (up to 12 images per piece) and **mature** images behind an age check | Done |
| **GIFs** (kept animated, with a pause button) and **videos** (MP4 or WebM, the archive's own player, byte ranges for seeking); their metadata is stripped on the server | Done |
| Addresses: `#about`, `#art`, `#knowledge`, `#encounters`, `#art/<form>`, `#art/<art piece>`, `#knowledge/<record>` and `#encounters/<encounter>` open there at once | Done |
| Inscribe / revise / remove record, remove examples | Done, through the server's API |
| **Encounters** with an encrypted private section; records can name an encounter as their source | Done, through the server's API |
| **Encounters only for the keeper**, encrypted whole and never sent to visitors | Done, through the server's API |
| **Keeper's seal** | **Done.** A brass clasp on the tome's edge opens a small panel. The keeper's word is checked on the server and gives a session; **Seal it again** ends it. The word is set on the VPS with `set-password` and can be changed from the panel. |
| Server, Caddy, Cloudflare, firewall, systemd | Written and tested here. The server is covered by `tools/smoke.js` (245 checks, including the preview). The Caddyfile was run with Caddy 2.10.2 in front of the server, with test certificates standing in for Cloudflare's; its per-route body limits were checked again with Caddy 2.10.2, and so was switching off its admin API (`admin off`: nothing listens on `localhost:2019` any more; client certificates, headers and proxying unchanged). The systemd unit passes `systemd-analyze verify`, but this container has no systemd to run it. |
| Profile (name, epithet, construct name and note) | The name and epithet are shown on the About page and amended there. The construct's name and note are kept in the data but not shown. |
| **Construct** | **Done.** The real in-game model (M2 → GLB) at the game's full detail, drawn with three.js (served by the site itself) and the game's own shading, animation and glow. It aims its gem at the cursor. The screenshot cutout remains as the fallback. |
| Preview on claude.ai | Done. The Artifact shows the current build with an in-page stand-in for the server (version 29). |
| Content | No records, encounters, About text, forms or art yet. The preview shows two example forms with example art (a GIF and a video among them), an example About page, and example encounters and records; the real site starts empty. |

## Files

```
build.py                         builds dist/ from src/ + assets/
src/page.html                    the page: CSS, markup, app script, with placeholders
src/seed.json                    the starting archive, copied to DATA_DIR/archive.json on the server's first start
src/preview.js                   the server's stand-in for the claude.ai preview (only in dist/preview.html)
src/preview-examples.json        the preview's example About page, forms and art (only in dist/preview.html)
server/server.mjs                the server (Node 20+, no dependencies); `set-password` sets the keeper's word
deploy/README.md                 VPS setup: Node, Caddy, Cloudflare, firewall, backups, what protects what
deploy/Caddyfile                 Caddy in front of the server: Origin Certificate, Authenticated Origin Pulls, real client IP, no admin API
deploy/chalice-archive.service   systemd unit with sandboxing
deploy/firewall.sh               ufw: 443 only from Cloudflare, SSH rate-limited, everything else closed
assets/model/chalice.glb         the construct's 3D model (made by tools/m2_to_glb.py, 544 KB)
assets/vendor/three.module.js    three.js 0.186.1 with its GLTFLoader, one minified module (made by tools/vendor_three.mjs, 769 KB)
assets/fonts/                    the page's fonts (Cinzel 500 and 700, IM Fell English roman and italic, IM Fell English SC) as
                                 WOFF2, their @font-face rules (fonts.css) and their SIL Open Font Licences (made by tools/vendor_fonts.mjs, 216 KB of fonts)
assets/front.webp|png            front-view cutout (fallback while/if the model can't load)
assets/screenshots/              the original in-game screenshots
assets/examples/                 the preview's example art: the construct rendered by tools/example_plates.js (.jpg) and
                                 tools/example_animations.js (circling.gif, drawing-in.webm, and a still of each)
tools/m2.py                      minimal reader for M2 models and .skin files
tools/m2_to_glb.py               downloads the game files and writes assets/model/chalice.glb
tools/smoke.js                   starts the server and tests the API and the page; npm install in tools/ first
tools/vendor_three.mjs           bundles three.js and its GLTFLoader from npm with esbuild, both pinned in tools/package.json
tools/vendor_fonts.mjs           copies the fonts from the Fontsource packages (Google Fonts' own files), pinned in tools/package.json
tools/example_plates.js          renders assets/examples/*.jpg from the preview build (only needed to remake them)
tools/example_animations.js      renders the example GIF and video, frame by frame on a virtual clock (needs ffmpeg)
tools/fixtures/                  a tiny WebM and GIF the smoke test uploads
tools/cutout.py                  background removal used to make the cutouts (ISNet via onnxruntime)
dist/index.html                  the built page (committed, so the VPS needs no build step)
dist/chalice.<hash>.glb          the model, named by its SHA-256 so it can be cached forever
dist/three.<hash>.js             three.js, named by its SHA-256 the same way
dist/<font>.<hash>.woff2         each font, named by its SHA-256 the same way
dist/preview.html                the claude.ai preview build (git-ignored; rebuilt by build.py)
CLAUDE.md (repo root)            standing instructions for future Claude sessions: publish the preview after each change
```

Placeholders in `src/page.html`:

| Placeholder | Filled by | With |
|---|---|---|
| `__FRONT__` | `build.py` | WebP data URI of the front cutout |
| `__MODEL_URL__` | `build.py` | `chalice.<first 12 hex of SHA-256>.glb` |
| `__THREE_URL__`, `__GLTF_URL__` | `build.py` | both `./three.<first 12 hex of SHA-256>.js`; in the preview, jsDelivr's `+esm` copies of three.js and GLTFLoader, of the version in the bundle's banner |
| `__FONTS__` (first line of `ca-style`) | `build.py` | `assets/fonts/fonts.css`, each file named `<font>.<first 12 hex of SHA-256>.woff2`; nothing in the preview |
| `__FONT_LINK__` (in `<head>`) | `build.py` | nothing on the site; in the preview, Google Fonts' stylesheet for the same faces |
| `__ARCHIVE__` | the server, per request; `build.py` in the preview | the archive JSON, with `<`, `>`, `&`, U+2028 and U+2029 escaped (`src/seed.json` in the preview) |

### Running it locally

```
python3 build.py
node server/server.mjs set-password                  # asks twice; data goes to server/data/ (git-ignored)
COOKIE_SECURE=false node server/server.mjs           # http://127.0.0.1:8080
```

`COOKIE_SECURE=false` drops the cookie's `Secure` flag and `__Host-` prefix and HSTS, which plain http needs. Never set it in production.

### Previewing changes on claude.ai

The owner looks at changes on the claude.ai Artifact before deploying them. After every change:

1. Run `python3 build.py`.
2. Run the smoke test.
3. Publish `dist/preview.html` to https://claude.ai/artifact/UFSgUToU7a4ZhuMdXe6ZWh, updating it in place.
4. Send the owner the link.

The repo-root `CLAUDE.md` says the same, so future sessions do it without being asked.

How the preview differs from the real page:

- **Fragment:** `dist/preview.html` is a page fragment, because the viewer wraps it in its own `<html>`/`<head>`. The model preload is dropped.
- **three.js from jsDelivr:** the viewer can load scripts only from a few CDNs, so the preview imports three.js and GLTFLoader from jsDelivr (the same version the site bundles). Only the preview does; the site serves its own copy.
- **Fonts from Google:** the viewer loads fonts only from Google Fonts, so the preview links Google's stylesheet for the same faces (`__FONT_LINK__`). The site serves its own copies of them.
- **No network:** the viewer's CSP has `connect-src 'none'` and `img-src data:`, so the page can't fetch anything. The model is embedded as base64 in `#ca-model`, and the example art's images, GIF and video as data: URIs in `#ca-files`. The smoke test assumes the viewer plays media from data: and blob: (its contract says muted autoplay works); if it ever doesn't, the player says the preview could not play the video, and choosing a video to upload says the preview could not read it.
- **Stand-in server:** `<script id="ca-preview">` (`src/preview.js`) sets `window.CA_PREVIEW`. `ca-app` then sends its requests there instead of to `fetch`, and asks `CA_PREVIEW.src(name)` for each plate's image instead of `art/<name>`. That covers the model and every API route, image uploads included, with the same validation and error messages as the server.
- **Examples:** the preview adds `src/preview-examples.json` to `src/seed.json`: an About page, two forms ("Example: Character (OC)" with a GIF and a video, "Example: Character (Dracthyr)" with three renders of the construct, one with alternate versions). Two images are flagged mature only to show the cover and the age check; none is really mature. They are marked as examples in their titles and never reach the real site.
- **GIFs and videos** uploaded in the preview are kept as they come; only the server strips their metadata.
- **The word** is `preview`, and the seal panel says so. Changing the word works until reload.
- **Records, encounters, the About page, forms and art** start from the seed and the examples and live only in memory (uploaded images as data: URIs), so a reload forgets every change and seals the archive again.
- **The real page carries none of this:** `dist/index.html` has no `ca-preview`, `ca-model` or `ca-files`, and `window.CA_PREVIEW` can't be set there, because its CSP runs no other inline script. The smoke test checks both.
- **Private sections:** the example encounter's private text is in `#ca-private` (from `preview-examples.json`'s `private`), apart from the archive as on the server. The stand-in returns it only to the unsealed preview, from memory; it is not encrypted there, since there is no server.
- **Encounters only for the keeper:** the example one is in `#ca-private` too (`preview-examples.json`'s `sealed`), never in `#ca-data`. The stand-in adds it to its archive but leaves it out of what visitors get (`publicView()`), so it shows only once the preview is unsealed.
- **Never put real records or the real word into the preview.** Never use the Artifact's own capabilities (`artifact.publish`) to save; that path was removed on purpose.

## How the page works

### Structure

`dist/index.html` is an ordinary document: `<head>` with the title, an inline SVG favicon, a preload of the model and `<style id="ca-style">`, which begins with the fonts' `@font-face` rules; `<body>` with the markup (stage with the hub, the `<dialog>` with the chapter tabs, the tome and the full-size plate view, the toast), `<script type="application/json" id="ca-data">` and `<script id="ca-app">`. The model is fetched from `MODEL_URL`, three.js imported from `THREE_URL` (`three.<hash>.js`, preloaded with `<link rel="modulepreload">`), the fonts from `<font>.<hash>.woff2`, and plates' images from `art/<name>`. Nothing comes from any other host.

In `ca-app`, `el` holds every element with an id, in camelCase (`det-title` is `el.detTitle`).

The server computes SHA-256 hashes of `ca-app` and `ca-style` at startup and puts them in the Content-Security-Policy, so they are the only inline script and style that can run. **Any other inline `<script>`, `<style>`, `style="…"` attribute or `on…=` handler is blocked.** Add styles to `ca-style`, code to `ca-app`, and set styles from JS through `el.style` (allowed), not `setAttribute("style", …)`.

The CSP also requires **Trusted Types** (`require-trusted-types-for 'script'; trusted-types 'none'`): in Chromium, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, a script's `text` or `src`, `eval`, `new Function` and `setTimeout` with a string all throw. Build elements with `h()` and `textContent`, as the page already does everywhere. A new version of three.js must pass the smoke test, which would catch it using one of them.

### Server and API

| Route | Who | Does |
|---|---|---|
| `GET /` | anyone | the page, with the current archive in `ca-data` |
| `GET /chalice.<hash>.glb` | anyone | the model, cached for a year (`immutable`) |
| `GET /three.<hash>.js` | anyone | three.js with its GLTFLoader (`text/javascript`), cached for a year (`immutable`) |
| `GET /<font>.<hash>.woff2` | anyone | one of the seven fonts (`font/woff2`), cached for a year (`immutable`) |
| `GET /api/session` | anyone | `{owner, csrf}`: whether this browser holds the keeper's session, and its CSRF token |
| `GET /api/archive` | anyone | `{archive}` |
| `GET /art/<name>` | anyone | an art piece's image, GIF, video or still, only while a piece uses it; cached for a year by browsers and a day by Cloudflare; one byte range (`Range: bytes=…`, 206, or 416 past the end), as video players ask |
| `POST /api/login` | anyone, throttled | `{password}` → session cookie and device cookie + `{csrf}` |
| `POST /api/logout` | keeper | ends the session |
| `POST /api/password` | keeper | `{current, next}` → new word, every other session ended |
| `POST /api/records` | keeper | new record → `{archive, id}` |
| `PUT /api/records/:id` | keeper | revise → `{archive, id}` |
| `DELETE /api/records/:id` | keeper | remove → `{archive}` |
| `POST /api/records/clear-examples` | keeper | remove the example records and encounters → `{archive}` |
| `GET /api/private` | keeper, with the CSRF token | `{encounters: {id: text}, archive}`: the private sections, decrypted (`null` for one that cannot be decrypted), and the archive as the keeper sees it, with the encounters only for the keeper |
| `POST /api/encounters` | keeper | new encounter `{title, date, text, private, sealed}` → `{archive, id}`; `sealed: true` makes it only for the keeper |
| `PUT /api/encounters/:id` | keeper | revise; `private` left out keeps it, `""` removes it; `sealed` left out keeps it as it was → `{archive, id}` |
| `DELETE /api/encounters/:id` | keeper | remove; records that named it keep their own words, without the link → `{archive}` |
| `PUT /api/about` | keeper | the whole page: `{name, epithet, title, currently, ooc, race, class, age, eyes, eyeColor, height, build, birthplace, residence, facts, traits, glances, sections}` → `{archive}` |
| `POST /api/uploads` | keeper | a file's raw bytes, sent with its type: a PNG, JPEG or WebP picture (at most 8 MiB), a GIF (40 MiB) → `{file, width, height}`; an MP4 or WebM video (90 MiB, streamed to disk) → `{file}` |
| `POST /api/galleries` | keeper | new form `{name}` → `{archive, id}`; it goes last |
| `PUT /api/galleries/:id` | keeper | rename `{name}` → `{archive, id}` |
| `DELETE /api/galleries/:id` | keeper | remove an empty form (409 while art pieces are in it) → `{archive}` |
| `POST /api/galleries/order` | keeper | `{ids}`, every form once, in the new order → `{archive}` |
| `POST /api/art` | keeper | new plate `{gallery, title, artist, link, date, note, versions: [{file, thumb, label, mature, loop, width, height}]}` → `{archive, id}`; it goes first. `width` and `height` are read only for a video |
| `PUT /api/art/:id` | keeper | revise; `gallery` left out keeps its form; `versions` (if sent) lists every image in its new order: `{id, label, mature, loop}` keeps one of the plate's images, `{file, thumb, …}` adds an uploaded one → `{archive, id}` |
| `DELETE /api/art/:id` | keeper | remove → `{archive}` |
| `POST /api/art/order` | keeper | `{ids}`, every plate once, in the new order → `{archive}`. There is one order for all plates; the page moves a piece past the next one of the same form |

- **Keeper-only routes** need the session cookie, an `X-CSRF-Token` header equal to the session's token and an `Origin` equal to `PUBLIC_ORIGIN`. Bodies must be a JSON object (`Content-Type: application/json`, at most 64 KiB; 256 KiB for the About page), except uploads.
  - **The session is checked again once the body has arrived** (`keeperJson()`, `stillKeeper()`; for a change of the word, again just before `auth.json` is written). A body may take a minute (a video, a quarter of an hour), and a write whose session was sealed, ran out or was signed out by a new word meanwhile used to land anyway; now it is refused and nothing of it is kept.
  - **Each write reads its body first**, then checks and changes the archive as it is by then, with nothing awaited before its commit. Before, a write checked its limit, and found the record, encounter, form or art piece it revises, before its body arrived, so a revision could work on a stale copy and many writes at once could pass a limit.
- **Server-side cleaning:** ids, `added` and `example` are set by the server. Text is trimmed, stripped of control characters and capped:
  - records: title 120, note 4000, source 160. A bad or missing date, or one that does not exist (30 February), is left empty (dates are optional); everywhere else a date is checked the same way. `encounter` must name an existing encounter, or is left empty.
  - encounters: title 120, text 20 000 (TRP markup kept as text), private 20 000, a body of at most 160 KiB. A bad date is left empty.
- **Answers:** the page's data block and `GET /api/archive` carry `publicArchive()`: the archive without the encounters' private sections (not even their ciphertext), without the encounters only for the keeper (not even their ids), and with records' links to those emptied. Every keeper write answers with `keeperArchive()`: everything, the encounters only for the keeper decrypted, but still no private sections. Only `GET /api/private` returns those.
  - About: name 60, epithet (the full title) 280, title 60, currently and OOC 1000 each, directory fields 60 (birthplace and residence 120). The eye colour must be `#rrggbb` or is dropped. Up to 24 lines of additional information (label 40, value 400), 24 traits (each pole 40; the value is rounded into 0–20, anything else becomes 10), 5 glances (title 80, text 1000) and 24 sections (heading 120, text 40 000, heading colour `#rrggbb` or dropped; the 256 KiB body is the real limit, about 250 000 characters in all, and a longer page is refused with a message that says so). Empty rows are dropped. Unknown fields are dropped. A portrait that names no plate is cleared. Section text keeps TRP markup as plain text; only the page reads it.
  - forms: name 80 (required), at most 40.
  - plates: title 120, artist 80, note 1000, at most 500 plates of 1 to 12 images each, image labels 60. Only `"mature": true` flags an image, and only a video can `loop`. `gallery` must name an existing form or be `""` (no form; a write naming a form that is gone is refused). A link must be `http(s)` (a bare `artstation.com/x` becomes `https://artstation.com/x`); anything else, `javascript:` included, is dropped. A picture's or GIF's width and height come from its file, never from the request; a video's come from the keeper's browser, which measured them while making its poster (the server does not decode video), capped to 1–10000. A `thumb` must be a still picture (PNG, JPEG or WebP).
- **Uploads:** the type is read from the bytes and must match the `Content-Type` (PNG, JPEG, WebP, GIF, MP4 or WebM; never SVG or HTML). Pictures at most 8 MiB, GIFs 40 MiB, videos 90 MiB (Cloudflare's own limit is 100 MB on the Free and Pro plans), images at most 10000 pixels on a side. The file is stored as `DATA_DIR/art/<first 32 hex digits of its SHA-256>.<png|jpg|webp|gif|mp4|webm>`, so the same file is stored once.
  - **GIFs** (`cleanGif()`) are read block by block to their end; comments, plain-text and application blocks (XMP) are dropped, the looping block stays. One that cannot be read to its end is refused.
  - **Videos** are streamed to a temporary file (`.upload-….tmp` in `art/`, which the sweep removes if it is ever left behind), then renamed after their hash. An MP4 (`cleanMp4()`) must start with an `ftyp` box, not QuickTime's (`qt  `), and hold a `moov`; every `udta` and `meta` box (top level, in `moov` and in each `trak`) and every top-level `uuid` box (XMP) becomes a `free` box of the same size filled with zeros, so no offset moves and the file still plays. A WebM must have an EBML header whose DocType is `webm`; it is kept as it comes.
- **The keeper's browser prepares each file:**
  - A picture is scaled to at most 2400 pixels on the long side and re-encoded as WebP (JPEG on browsers that can't write WebP), which drops any metadata such as a photo's location. It also makes an 800-pixel thumbnail for the list.
  - A GIF goes up as it is, with a WebP still of its first frame (up to 1280 pixels) as its thumbnail.
  - A video is played silently from a `blob:` URL (the CSP's `media-src` allows `blob:` for this) to learn its size and length and to take a WebP poster (up to 1280 pixels) from early on (at a tenth of its length, at most 1 s in). A video the browser cannot play is refused with a message to export it as MP4 (H.264) or WebM; QuickTime `.mov` files are refused outright, as not every browser plays them. A video of 30 s or less is set to loop.
  - The files are uploaded one after another, then the plate is saved.
- **Serving art:** only files a plate uses right now, by exact name, with their type, `nosniff` and the CSP, and one byte range when asked (`Accept-Ranges: bytes`), which video players need to seek and Safari needs to play at all. Removing a plate stops serving its files at once; Cloudflare's copy expires within a day (`s-maxage=86400`). A download stopped half way closes its file at once (`pipeline()`); with `pipe()`, every one kept a file open for good, so anyone could have made the server run out of files it may open.
- **Timeouts:** the server waits up to 15 minutes for a whole request (`requestTimeout`), so a video can be uploaded over a slow connection; Cloudflare holds slow uploads back before they reach the VPS anyway. A JSON body has only 60 seconds (`readJson()`), so nobody can hold connections open by sending a login a byte at a time. A body cut off half way is refused at once. A request refused before its body has all arrived (an upload without a session, a body over its limit) is answered at once, and the rest of the body is read and thrown away for at most 10 seconds before the connection is closed; it used to be read for up to the 15 minutes an upload may take. So is a body sent with a request that reads none, such as a GET: answered at once, it could otherwise hold its connection for a quarter of an hour by sending a byte now and then (`letGo()`).
  - **Idle connections from Caddy** are kept for 130 seconds (`keepAliveTimeout`), longer than Caddy keeps them (2 minutes), so Caddy always closes an idle connection first. With the server closing first (it used to, after 5 seconds), Caddy could send a request down a connection at the very moment the server closed it, and a login, a save or an upload then failed with a 502: Caddy tries only a request that is safe to send twice (a GET) again.
- **What visitors get** (the page and `GET /api/archive`) is made once per change of the archive (`forVisitors()`), not for every request, so asking for the page over and over costs a copy of it, not the whole archive serialized again.
- **The sweep** (at start, every 6 hours and after a plate is revised or removed) deletes an image once neither the archive nor any of its 50 backups uses it and it is over a day old. So restoring a backup always finds its images, and an upload whose plate was never saved disappears after a day.
- **Storage:** `DATA_DIR/archive.json`, written atomically (temp file, fsync, rename). The previous version goes to `DATA_DIR/backups/` first (`archive-<time>-<n>.json`, numbered within its millisecond so no backup overwrites another), keeping the last 50. A write that fails, such as on a full disk, leaves no temporary file behind. `auth.json` holds the scrypt hash. `art/` holds the images. All are mode 0600 in 0700 directories.
- **Sessions** are kept in memory (at most 50), so a restart signs the keeper out. Only each token's SHA-256 is stored.
- **In the page** (`ca-app`): `call(method, url, body)` wraps `fetch` with the CSRF header. `save()` sends a change and re-renders from the archive the server returns. A 401/403 asks the server about the session again: if it has ended, the seal panel opens without closing an open form, so the keeper can unseal and press Inscribe again.
  - **When the session ends elsewhere** (it runs out, it is sealed in another tab, the word is changed, the server restarts), an unsealed tab notices: it asks `GET /api/session` every minute and whenever it is looked at again (`watchSession()`, `refreshSession()`, which re-renders only on a change), and tabs tell one another over a `BroadcastChannel` when one seals, unseals or changes the word. The tab then drops the private sections and the encounters only for the keeper at once; a form being written stays, and the seal panel opens so it can be sent after unsealing (a form sent while sealed opens it too, `mayPost()`). A sealed tab never unseals itself because another tab did, so nothing private appears on a screen nobody is looking at; it unseals on its own clasp or a reload.
  - **Just after unsealing**, the keeper's archive (`GET /api/private`) is still on its way, and until it arrives the encounters only for the keeper, and records' links to them, are not in the page. So an encounter's form saves a revision by the id it opened with (looking the encounter up there found nothing, and saved it a second time, as a new one); a record's form draws its list of encounters again when the keeper's archive arrives and gives the record its link back unless another was chosen meanwhile (`refreshRecordForm()`; saved without it, the record lost the link); and the private text, arriving in an encounter's form, no longer resets what Escape compares against, so what was written meanwhile still counts as unsaved. A keeper's archive that failed to arrive is asked for again with the next session check.
  - **Nothing private stays behind once sealed**, even out of sight: an answer to a change that arrives after the tab has sealed carries the keeper's archive, and `applyArchive()` drops the encounters only for the keeper from it (they came back before); sealing empties the encounter view's private section wherever the tab is (it stayed in the page, hidden, when the tab showed something else), and a record's own page is drawn again with every change even out of sight, so its link to an encounter only for the keeper goes too (and a removed record's page is emptied); the toast lets go of its words once it hides ("Removed “…”" named the encounter); and a form kept open as the session ended lets go of what it held once it is left (`showView()` calls `wipeForms()` while sealed), such as the encounters only for the keeper that the record form offered, or once the tome is closed, since nothing leads back to it (`wipeForms(true)`; an encounter's form, closed so, kept its private section).
- **Deletes** are two-step buttons: the first click arms, the second confirms, and they disarm after 5 s.

### Data model

```jsonc
{
  "profile": { "name": "", "epithet": "", "construct": "", "constructNote": "" },
  "about": {
    "title": "",              // shown above the name, e.g. "Archivist"
    "currently": "", "ooc": "",
    "race": "", "class": "", "age": "", "eyes": "", "eyeColor": "",   // "#rrggbb" or ""
    "height": "", "build": "", "birthplace": "", "residence": "",
    "facts": [{ "label": "Motto", "value": "" }],                     // additional information
    "traits": [{ "left": "Chaotic", "right": "Lawful", "value": 10 }], // 0 = all left, 20 = all right
    "glances": [{ "title": "", "text": "" }],                         // at first glance, at most 5
    "sections": [{ "heading": "Physical description", "body": "", "color": "#ffd100" }] // the description; body keeps TRP markup; color is the heading's ("" = TRP's gold)
  },
  "galleries": [{             // his forms, in the keeper's order; a new one goes last
    "id": "g…",               // set by the server: "g" + 12 random base64url characters
    "name": "Character (Dracthyr)",
    "added": 0, "example": false
  }],
  "art": [{                   // the art pieces, in the keeper's order (one order for all forms); a new one goes first
    "id": "a…",               // set by the server: "a" + 12 random base64url characters
    "gallery": "g…",          // the form it belongs to, or "" for none ("Other art" on the page)
    "versions": [{            // 1 to 12 images; the first is the main one, shown in the list
      "id": "v…",             // set by the server
      "file": "<32 hex>.webp",  // a picture up to 2400 px on the long side, or a .gif, .mp4 or .webm
      "thumb": "<32 hex>.webp", // a still: up to 800 px for a picture, 1280 px for a GIF's first frame or a video's poster
      "width": 0, "height": 0,  // of `file`: read by the server, or for a video measured by the keeper's browser
      "label": "",            // e.g. "Without armour"; shown as "Main" or "Version 2" when empty
      "mature": false,        // covered until the visitor says they are 18 or older
      "loop": false           // a video only: plays on a loop
    }],
    "title": "", "artist": "", "link": "", "note": "",
    "date": "YYYY-MM-DD", "added": 0, "example": false
  }],
  "records": [{
    "id": "r…",               // set by the server: "r" + 12 random base64url characters
    "title": "",
    "note": "", "source": "", // source: where he learned it, in his own words
    "encounter": "",          // or an encounter's id, or ""
    "date": "",               // "YYYY-MM-DD" or ""
    "added": 0,               // ms timestamp, tie-breaker for ordering
    "example": false
  }],
  "encounters": [{
    "id": "e…",               // set by the server: "e" + 12 random base64url characters
    "title": "", "date": "",  // date: "YYYY-MM-DD" or ""
    "text": "",               // what happened; TRP markup
    "private": { "iv": "", "tag": "", "data": "" }, // only when there is one: AES-256-GCM, base64; never sent to visitors
    "added": 0, "example": false
  }, {                        // an encounter only for the keeper: nothing but this is stored
    "id": "e…",
    "sealed": { "iv": "", "tag": "", "data": "" }, // AES-256-GCM of {"title", "date", "text", "private"} as JSON, bound to the id
    "added": 0, "example": false
  }]
}
```

- **Dates** are shown in their own year, even below 100 (`fmtDate()`; `new Date(35, …)` would be 1935).
- **Lists:** records and encounters are newest first, by `date`, those without one by the day they were added (`newest()` in `ca-app`).
- **Older archives:** a record's `domain` and `status` from before are dropped when the server loads the archive.
- **Plates saved before forms existed** have no `gallery`; they are shown together as "Other art" after his forms, and revising one can move it into a form.
- **Plates saved with a single image** (before plates had versions) carry `file`, `thumb`, `width` and `height` on the plate itself. The server reads them as a plate of one image, with the id `v` + the first 12 hex digits of its file name, and writes them in the new form on the next change.

### Design

- **Two worlds, one token set** (`:root` of `ca-style`): the landing and the hub are the dark void (navy grounds, teal light, copper). The archive is the tome (leather, parchment, sepia ink, red rubric ink, brass, and the game's red-and-gold buttons). The full-size plate goes back to the dark ground. It is a single deliberate look, not light and dark themes.
- **The hub** (`#hub`, inside `.core`): once the light is drawn in, `.has-hub` on the stage lifts the construct 56 px and four choices appear beneath it, each only its label: About, Art, Character Knowledge, Encounters (the icons above them were taken out). Below 620 px they stand two by two. There is no other text. They are dark panes with teal corner brackets, and they flicker in one after another as the gem flashes. On short landscape screens they stand beside the construct instead. Waking the construct from the keyboard moves the focus to the first. Closing the tome takes the hub away again (`hideHub()`): the choices go, the construct sinks back, and the focus returns to the construct, so the gem has to be clicked again to bring the choices back.
- **Chapter tabs** (`#tabs`): leather index tabs on the tome's top edge; the open chapter's tab is a parchment leaf. While a form is open, they only say to finish or cancel it, so nothing written is lost. Escape leaves a form (a record, an encounter, the About page, an art piece, the name of a form) only while nothing in it has changed; otherwise it says there are unsaved changes (`closeTop()`, with `formChanged()`: `recordChanged()`, `encounterChanged()`, `aboutChanged()`, `artChanged()` and `galleryChanged()`). The tome's round close button keeps unsaved writing the same way; it used to close the tome and take the form with it.
- **Escape** closes what is on top first (`closeTop()`): the age check, the full-size view, the seal panel, an open form; only then the tome. It is handled on `keydown` with `preventDefault()`, because Chrome lets a page hold back a dialog's own `cancel` only once per click or key press: a second Escape that relied on `cancel` closed the whole tome. The `cancel` handler runs the same steps for other close requests, such as a phone's back gesture.
- **Views:** each view belongs to a chapter and shows below that chapter's own leaf (`#leaf-about`, `#leaf-art`, `#leaf-knowledge`, `#leaf-encounters`) in one column (`VIEWS` in `ca-app`). The DOM still has the two `#page-l` and `#page-r` sections, but they are stacked: `#page-l` holds the chapter's leaf, `#page-r` the view. `.book` carries `data-book`, `data-view` and, for a record, a plate or a form, `data-solo`, which hides the chapter's leaf so the record, plate or form has the page to itself. In Art, Character Knowledge and Encounters, the list (`data-view` `galleries`, `overview`, `encounters`) shows alone, and an entry opens on its own page with a link back. In Art that list is his forms (`#leaf-art`); a form opens on its own page (`#view-gallery`, with its art pieces in `#plates`), and an art piece on another (`#view-plate`), with a link back to its form.
- **About** (a Total RP 3 profile):
  - **Header**, centred: the title in red small capitals, the name with the record title's rule and red dot beneath it, and the full title (the `epithet`) in italic. There is no portrait; one was there before (a plate shown as a frontispiece) and was taken out, along with "Make it the portrait" on plates. An `about.portrait` left in an older `archive.json` is dropped when the server loads it.
  - **Below it**, each part only when it has something in it: Currently and Out of character in a note box; the **Directory** (two columns of label and value; the eyes get a colour swatch); **Additional information** (the old particulars, one column); **Personality traits** (each a bar between its two poles with a brass marker; the pole it leans toward is darker, and screen readers hear "fairly Lawful"); **At first glance** (up to five cards); then the **description**'s sections. Each section's heading is set like a pull quote: large italic IM Fell English in faded curly quotes, centred between two flourishes that fade out from a small diamond (`sectionHeading()`, `.ab-heading`). Quotes typed into the heading are dropped, so they never double. Its colour is the section's own `color` made readable by `ink()`; without one it is TRP's gold, `{col:ffd100}` darkened (`--ink-gold`, #705c00). The first plain paragraph of the description, if longer than 120 characters, opens with a red drop capital.
  - **TRP markup** (`trp()` in `ca-app`) is turned into elements, never parsed as HTML: `{h1}`…`{/h1}` to `{h3}` (as h5 and h6) with `:c`/`:r`, `{p:c}`/`{p:r}`, `{col:rrggbb}`…`{/col}`, the game's `|cAARRGGBB`…`|r`, and `{link*url*text}` (a link only for `http(s)://`, opened in a new tab with `noopener noreferrer`). `{icon:…}`, `{img:…}` and `|T…|t` are game files and are dropped. A blank line starts a paragraph; a single line break stays a line break. TRP colours are chosen for dark frames, so `ink()` keeps each colour's hue but darkens it until it has 4.5:1 contrast with the parchment; white and pale greys become the sepia ink. Colours are set through `el.style`, which the CSP allows.
  - **The keeper's form:** title, name, full title, currently and OOC, the directory with an optional eye colour, then rows with ↑, ↓ and × buttons for additional information (with suggested labels), traits (two poles and a 0–20 slider; **Add TRP's standard traits** adds TRP3's eleven pairs at the middle), glances, and the description's sections, each with a colour picker for its heading (TRP's gold by default; a new section takes the colour of the last one; the heading field shows the colour as it will look) (**Add TRP's three sections**: Physical description, Personality, History). A collapsible note lists the markup.
- **Art:**
  - **Overview** (`#galleries`, under the heading "Overview"): his forms, a card each, in the keeper's order, with the first art piece's main image as its cover (its cover sheet if mature), the form's name and how many pieces it holds. Then **Other art**, if any piece belongs to no form. Visitors do not see a form until it has art in it, not even at its address (`showGallery()` shows them the overview instead; it used to show the empty form), and a tab sealed on an empty form goes back to the overview; the keeper sees empty ones as "No art yet". On phones they stand two by two.
  - **A form** (`#view-gallery`, address `#art/<form>`): its name as the page title, **Add an art piece** for the keeper, then **Art Pieces**: mounted thumbnails of each piece's main image, cropped to 4 : 5 and numbered with roman numerals in the keeper's order within the form; a piece of several images says how many, and a GIF or a video is marked on its still ("GIF", "▶ Video"). Beneath, for the keeper: **Rename the form**, **Move earlier**, **Move later**, and **Remove the form** (only while it is empty, so no art goes with it; the server refuses otherwise too).
  - **An art piece** (`#view-plate`): its number within the form ("Art piece II.", and the image's label), the image at its own shape, title, "by" the artist (a link to their page when there is one, opened with `noopener noreferrer`), date and note. Beneath the image, a strip of small thumbnails switches between the piece's images. The keeper can revise it (which can move it to another form), move it earlier or later within its form, or remove it; revised, moved, or with its revision cancelled, it stays on the image on view (it used to go back to the main one). "← Return to <form>" goes back.
- **What is on view** (`renderMedia()`) depends on the image: a picture or a GIF sits in `#pl-open`, the button that shows it full size; a video sits in `#pl-video` with its player. The image is drawn only while the piece's page is open (`clearMedia()` empties both when the visitor moves on, which also stops a video), and a re-render that would show the same thing leaves it alone, so a session check or a save never restarts a video.
  - **GIF player** (`gifPlayer()`): the GIF itself, and the game's round red button on the frame's corner to pause and play it. Paused, it holds the frame it is on (drawn to a canvas). With reduced motion it starts paused on its still, and the GIF is loaded only once it is played.
  - **Video player** (`videoPlayer()`): the video with its poster, a large round play button over it until it plays, and a dark bar beneath in the game's gold: play and pause, a bar to move through it (arrow keys step by a twentieth, at least a second; it follows the video except while it is held, and it used to stop following whenever it had the focus, which a click on it gives), the time (hidden below 420 px), sound on and off, and full screen where the browser allows it. A click on the picture plays or pauses it. It loads only its first moments (`preload="metadata"`) until played, and loops if the keeper ticked **Loop**. It is at least 300 px wide, so its controls fit. A video the browser cannot play says so.
- **The art piece form** has a **Form** select (his forms and "Other art"; a new piece starts in the form it is added from) and a row per image, in order (the first is the main image): its still, a label, a **Mature (18+)** box, for a video a **Loop** box, and ↑ ↓ × buttons. **+ Add an image or video** adds a row with a file input that takes pictures, GIFs, MP4 and WebM; the row says what the file is ("A video of 0:12, 1920 × 1080 pixels, 24.0 MB to upload"). To change an image, add the new one and remove the old.
- **The form for a form** (`#view-gallery-form`) has only its name.
- **Mature images and the age check:**
  - A mature image shows only a cover (`.spoiler`: a dark hatched panel with a red **18+** seal and "Mature"), in the list, in the strip, on the plate's page and in the full-size view. The image itself is not loaded until it is shown, so its pixels never reach the browser before then.
  - Selecting a cover (or a plate in the list whose main image is mature) opens the age check (`#gate`): "How old are you?" with a number. 18 or older shows the image; under 18 says mature images are only for those 18 or older and keeps it covered. Opened from the list, the piece's cover takes the focus first, so the check gives it back there (it gave it back to the list left behind, and so to nothing).
  - The answer is kept for the browser tab (`sessionStorage`, in memory where storage is blocked), so later covers open on a click without asking again, and someone under 18 is not asked again.
  - Whatever the answer, a mature image is covered again as soon as another image takes its place, the visitor goes back to the form or another chapter, or the tome closes (`shown` in `ca-app` holds the one image on view). In the full-size view, stepping onto a mature image shows its cover.
  - It is an honest question, not proof of age, as on most sites: nothing stops someone from claiming to be 18, and the image addresses are in the page's data for anyone who digs. What it guarantees is that nobody sees a mature image without choosing to and saying they are an adult.
- **Full-size view** (`#lightbox`, inside the dialog): the image on the dark ground with its number, title, label and artist in the game's gold; the game's round red buttons step through every image of every art piece of the same form, in order (arrow keys too, except while the focus is in a video's controls) and close it. It shows a picture's thumbnail at once and swaps in the full image when it has loaded; a GIF and a video come with their players. A video on the piece's page pauses when it opens. While it is open, the tome is `inert`; Escape closes only it. A mature image uncovered there replaces the cover that had the focus, so the focus goes to the close button (left on nothing, it took the arrow keys out of the view). On narrow screens the step buttons sit at the bottom.
- **Addresses:** the open chapter is written into the address with `history.replaceState` (`#about`, `#art/<form>`, `#art/<art piece>`, `#knowledge/<record>`, `#encounters/<encounter>`; "Other art" is `#art/other`), so it can be copied and shared. Older `#art/<plate>` links still open the piece. Opening such an address goes straight to it, without waking the construct, and so does changing the hash. An encounter only for the keeper is not in the page until the keeper's archive arrives, after the session is known, so its address first shows the list and opens it then (`awaited`), unless the keeper has moved on meanwhile. A form with no art yet is shown only once the session is known, so its address does the same with the overview.
- **A record on its own page** is drawn again with every change of the archive (`renderDetail()`, from `renderArchive()`), even while another view is open, as an encounter's and an art piece's are: its link to an encounter only for the keeper appears once the keeper's archive has arrived and goes when the archive is sealed. It used to appear only when the record was opened again.
- **Fonts:** Cinzel (titles, buttons, the game's inscriptional capitals), IM Fell English (the book's text, an 18th-century typeface with old-style numerals) and IM Fell English SC (labels and dates). The site serves them itself, latin (and for Cinzel latin-ext) subsets in WOFF2, with `font-display: swap`. To update them, change their versions in `tools/package.json`, then `npm install`, `node vendor_fonts.mjs` and `python3 build.py`.
- **The tome:** a leather binding (`.tome`, SVG noise as the hide) with brass corner fittings (`--corner`, an inline SVG) and a red silk ribbon hanging out below the page.
  - **The page:** one parchment page (`.book`) with a printed double rule, at most 800 px of text column centred on it. The paper is fine SVG grain plus a stretched low-frequency stain (`--grain`, `--mottle`); a tiled stain showed a seam. Stacked page edges show beneath. The page keeps its height; its contents scroll inside `#book-scroll`, fading out at the rules.
  - **Character Knowledge:** the keeper's buttons (Inscribe record, and Remove examples while any example records or encounters exist; shown only during the keeper's session), then the records: each its date and source ("from …"), title and the start of its note. A record has the page to itself: its date, title, a red drop capital, and "Learned from": the encounter as a link to it, and/or his own words. Its form has the title, an optional date, the note, an encounter to choose and the free-text source. Forms are written on ruled lines.
  - **Encounters:** the keeper's button (Record an encounter), then the encounters: each its date, how many records name it, title and the start of its text. An encounter's page has its date, title, its text through `trp()`, then, for the keeper alone, the **private section** in a dashed box with a lock ("Private: only you can see this"), and "What he learned from it": the records that name it. Its form has the title, an optional date, what happened and the private section. Its private text is sent only when it was changed in the form, so an encounter saved before its private section arrived keeps it. Escape leaves the form only while nothing in it has changed.
    - **Only for me** (a box under the date) makes it only for the keeper; "What happened" then says only the keeper can read it. Such an encounter is marked with a lock and "Only for you" in the list and in a dashed box on its page. A record that names it links to it only for the keeper ("only you see this link"); visitors see the record without the link. Unticking it makes it everyone's again, its private section still private. One that can no longer be read (its word forgotten) says so once, in place of its text (its private section said it again), and can only be removed.
    - **On sealing**, the page drops these encounters and the records' links to them from its memory, along with the last one shown and what the forms held, unless a form is open (a session that ran out keeps it, to be saved once unsealed again).
  - **Game styling:** buttons copy the game's red panel buttons (gold text, brass rim). The close button is the round red one, and notices are dark tooltips with gold text.
  - **Narrow screens (≤ 860 px):** the same page with a thinner binding and narrower margins; form rows stack. At 560 px and below, the About header stacks too.
- **Landing:** only the construct, centred on the dark stage, with its ambient light (below). There is no visible text until the hub appears. The character's name is in a visually hidden `<h1>`, the button's accessible name ("Open the archive of …") and the archive's hidden heading, and visibly on the About page.
- **Not shown anywhere:** the construct's name and note from the profile, the state-of-knowledge ledger and filters, the old record states and domains, and "Example" tags. The removed pieces are gone from the code, not hidden. The `example` flag stays in the data so **Remove examples** still works.
- **Float (cutout fallback only):** three nested wrappers with different periods, so the motion never visibly loops: `.fx-x` 13 s drift, `.fx-y` 5.6 s bob, `.fx-tilt` 9 s tilt. In 3D mode they stop: the model hovers on its own, and the canvas must stay put under the cursor it aims at.
- **Waking the construct:** only the gem does it. A pointer click must land on the gem: `model3d.gemAt(x, y)` raycasts the gem mesh in its current pose, with slack inside 55 % of its projected bounding circle. While the pointer is over the gem, the stage gets `.on-gem` (hand cursor) and the gem brightens. Clicks anywhere else do nothing. Keyboard activation of the construct button (Tab, then Enter or Space; the click reports `detail` 0) always does. Without the 3D model, the hit area is the cutout's gem overlay.
- **Drawing the light in** (`summon()`): `.is-drawing` on the stage; `model3d.charge()` slows the model to 15 % speed and charges its gem, and `motes.gather()` sets everything on the canvas spiralling in (below). At 1.35 s the gem is at its brightest, `motes.pulse()` sends a ring of light (and a fainter second one) out from it, and the hub appears. `.is-drawing` clears at 1.95 s; the model is back to full speed at 2.6 s. There is no scan line, grid or lock-on any more.
- **Halo and pool:** with the cutout they pulse with the CSS bob. In 3D mode the renderer writes the model's hover height to `--lift` on `.core` each frame, and `.halo` and `.pool` follow it.
- **Ambient light.** The idea is a lamp in the void that gathers drifting memories.
  - **Haze (`.nebula`, CSS):** three large indigo, teal and copper clouds that drift over 70 to 110 s with `mix-blend-mode: screen`. They only move by transform, so they stay cheap.
  - **Light shafts (`#motes` canvas):** nine soft wedges fanning from the construct. They turn slowly in both directions and brighten as the model rises (`model3d.lift()`). Each wedge is drawn three times at narrowing widths for a soft edge. They are on the canvas rather than in CSS because a rotating CSS layer that large costs tens of MB of GPU memory at 2× pixel density. The canvas finds the construct's centre every frame, so the shafts and wisps follow it when it rises for the hub.
  - **Motes (`#motes`):** at random depths. Near ones are larger, brighter and faster, and slide against the cursor more than far ones, for parallax.
  - **Flares (`#motes`):** 10 to 28 soft glints (by screen area), each a glow with four thin rays (`starSprite()`; the upright ray is shorter, as in a lens). They drift slowly, twinkle, and every few seconds one flares up with long rays.
  - **Anima wisps (`#motes`):** 8 to 18 glowing teal or copper streaks (by screen area) with tapered trails. They drift in from the edges on a slow flow field and orbit the construct. Some spiral in, and each arrival flickers the gem (`model3d.absorb()`).
  - **Drawn in (`motes.gather()`):** every wisp (the waiting ones set off from the edges at once), every flare, the motes within 45 % of the screen's size (as sparks with short trails) and a rush of extra wisps from the edges spiral into the gem, all turning the same way so they read as one vortex. `fallIn()` shrinks the distance ever faster while turning, quicker near the centre, so far and near ones arrive within about 0.9 to 1.3 s of each other. Each arrival flickers the gem. Afterwards the flares and motes fade back in elsewhere over a few seconds, the wisps return, and the rush wisps are gone.
  - **Paused** while the archive is open (`.is-paused` on the stage) or the tab is hidden.
- **Reduced motion:** `prefers-reduced-motion` turns off the float, the halo and pool pulse, the haze drift, the motes, the wisps, the flares' twinkle and the drawing in, the unfold, the hub's flicker and the construct's rise (it moves at once). The shafts and flares stay as a still frame. The model draws one still frame and does not follow the cursor.

## The keeper's seal and what keeps the archive safe

- **The clasp:** the brass keyhole on the tome's right edge (`#clasp`) opens the seal panel (`#seal`). It is deliberately small and unlabelled; visitors see a book fitting.
- **Unsealing:** the word goes to `POST /api/login` over HTTPS. The server compares it with the stored scrypt hash (N=2¹⁷, r=8, p=1, 16-byte salt, 64-byte key; one check at a time, so a burst cannot exhaust memory). The right word gets a random 256-bit session token in a `__Host-ca_session` cookie (HttpOnly, Secure, SameSite=Strict, 12 hours), plus a CSRF token in the response body, kept in a variable. A word that was right when it was checked, but was changed before the session began (from another tab, or with `set-password`), is refused like any wrong word: every write of `auth.json` in the server takes its turn (`authTurn()`) and first checks that the word it was given is still the word on file (its `generation`). Before, such a login got a session that had already ended, or failed on the key wrapped under the new word.
- **Wrong words:** two free misses per client address, then waits of 2 s, 4 s, 8 s … up to an hour (429 with Retry-After). An IPv6 address counts with the rest of its /64 (`throttleKey()`), since one client usually holds a whole /64. Each try counts as a miss the moment it is made, and is forgiven once the word proves right (`beginTry()`, `forgive()`); the wait is checked and the try counted with nothing awaited in between, so a burst of parallel guesses gets no more tries than guesses sent one after another. A try refused because four words already wait to be checked (503, `KDF_QUEUE`) is no miss, since its word was never checked: before, whoever flooded the logins earned the keeper's own address a wait. A word that proves right forgives its address at once, before the session is made, and the work that follows (unwrapping the private key) is never refused for being busy. More than 50 misses in ten minutes from anywhere pauses all logins until the window clears, except from the keeper's own browsers: the right word also sets a device cookie (`__Host-ca_device`: HttpOnly, Secure, SameSite=Strict, 400 days), a random id signed with HMAC-SHA256 under a key derived (HKDF) from the word's scrypt hash, so a new word cancels every one of them, and the browser that changed it gets a new one. With it, a login waits only for its own address's misses (`knownDevice()`). Without it, someone guessing from a few hundred addresses (one home connection's IPv6 /56 holds 256 /64s) could have kept the keeper out for as long as they kept guessing. Changing the word from the page needs the session already, so it too waits only for its own address. Behind Caddy, the client address is Cloudflare's `CF-Connecting-IP`, trusted only from Cloudflare's ranges and passed on as `X-Real-IP`; the server believes `X-Real-IP` only from loopback and only with `TRUST_PROXY=true`.
- **Panel modes:** unsealed, the panel offers **Seal it again** (logout) and **Change the word** (current word, new word twice; at least 12 characters). Changing the word signs every other session out.
- **Setting the word:** only on the server, as the service user: `node server/server.mjs set-password` asks twice with hidden input (or reads two lines from stdin). It refuses words under 12 characters, and words holding control characters: an arrow key or Escape pressed at the hidden prompt goes into the word, which no browser could then send (the page's change of the word refuses them too). Run as another user than the one `DATA_DIR` belongs to (root, through `sudo` without `-u chalice`), it refuses before writing anything: it used to write an `auth.json` the server could not read, so nobody could unseal the archive. There is no web form for a first word, so nobody can claim the archive before the keeper does. Once there are private sections, it also asks for the current word (a third line on stdin) and carries the private key over; without it, it refuses and changes nothing. For a forgotten word, `set-password --forget-private` sets the new word and lets the key go: the private sections written so far can never be read again. If `auth.json` changes while it waits for the words (the keeper's first login makes the private key; the word is changed from the page), it changes nothing and says so, rather than writing over the key and every private section written with it.
- **Where the word goes:** typed into the panel, sent once over HTTPS, hashed, discarded. It is never logged, stored in the browser, or written into the page. The inputs are cleared after use.
- **Encryption:**
  - In transit: visitor ↔ Cloudflare uses Cloudflare's edge certificate, and Cloudflare ↔ Caddy uses the Origin Certificate in Full (strict) mode with Authenticated Origin Pulls, TLS 1.2+. Caddy ↔ Node is plain HTTP on loopback only.
  - At rest: the records, encounters, About page and plates are not encrypted, because they are published to every visitor. The word is hashed, not encrypted, so it cannot be recovered from `auth.json`.
  - **The encounters' private sections, and the encounters only for the keeper,** are encrypted at rest with AES-256-GCM under one random 256-bit key, each bound to its encounter's id (as associated data), so ciphertext moved onto another encounter does not decrypt. An encounter only for the keeper is one box holding its title, date, text and private section; only its id and when it was added are in the clear. The key is made on the first login and stored only wrapped (AES-256-GCM) by a key derived from the word with scrypt (its own salt, the same cost as the password hash) in `auth.json`. The server unwraps it when the word is spoken and keeps it only in memory, with each session; a restart forgets it until the next login. Changing the word wraps the same key under the new word. So `archive.json`, every backup and `auth.json` together still need the word to read a private section: a leaked or stolen copy of the data directory, or a bug that reads files, gives ciphertext. There is no database, so SQL injection does not apply; what could reach the private text is someone holding the keeper's session (it needs the CSRF token as well) or code running inside the server while the keeper is logged in.
  - **Never to visitors:** the private sections are stripped from the page, `GET /api/archive` and every write's answer, ciphertext included. The encounters only for the keeper are left out of the page and `GET /api/archive` entirely (`publicArchive()`), ids included, and records lose their links to them there; they reach only the keeper's session, in the answers to its writes and `GET /api/private`. The page forgets both when sealed.
- **Untrusted input:** every record, About and plate field is rendered with `textContent`, never as HTML. A plate's link becomes an `<a>` only if it starts with `http(s)://`, on the server and again in the page. The data block escapes `<`, `>`, `&`, U+2028 and U+2029. The CSP blocks any script that is not the page's own.
- **Images:** only PNG, JPEG and WebP whose bytes match their type, served with that type and `nosniff`, so an upload can never be read as a page or a script. Uploads need the keeper's session like every other write.
- **Headers on every response:** the CSP (`default-src 'none'`; scripts: the page's hash and `'self'`, which only `three.<hash>.js` can satisfy, since nothing else is served as JavaScript and every response says `nosniff`; no CDN; styles: the page's hash alone; fonts: `'self'`; `connect-src 'self'`; `frame-ancestors 'none'`; Trusted Types required), HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP same-origin, COEP `require-corp` (with COOP, the page is cross-origin isolated: it gets a process of its own even where the browser does not otherwise keep sites apart, such as Chrome on Android, out of reach of Spectre-style reads from another site's page; it loads nothing from any other origin, so nothing breaks) and a Permissions-Policy that switches off every powerful feature the page does not use (full screen stays, for the video player).
- **No third-party code, and nothing from another host:** three.js used to load from jsDelivr on every visit, which meant jsDelivr (or anyone who compromised it) could run code beside the keeper's session, read its CSRF token and then the private sections. It is now bundled from the npm package, whose sha512 `package-lock.json` pins, with a pinned esbuild (`tools/vendor_three.mjs`; the same versions give the same file, byte for byte) and served by the site. The fonts are served by the site too (`tools/vendor_fonts.mjs`, from pinned Fontsource packages): Google's stylesheet could not run script, but every visit sent the visitor's address to Google, and whoever served that stylesheet could style the page. Now a visitor's browser asks nothing of any host but the site.
- **Configuration:** `SESSION_HOURS` (1 to 720) and `PORT` must be plain numbers; anything else stops the server. Before, `SESSION_HOURS=12h` gave every session an expiry of `NaN`, which never came. `PUBLIC_ORIGIN` is required unless `COOKIE_SECURE=false`, and must be the site's https address (`https://Archive.example.com/` is taken as browsers write it, `https://archive.example.com`); anything else stops the server. Before, without it, writes were checked against whatever `Host` the request named.
- **Stored times:** an `added` that no date can show (in an archive restored or edited by hand) is read as 0, so it cannot stop the page from listing anything.

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

- **Loading:** three.js 0.186.1 and its GLTFLoader load with dynamic `import()`, in parallel with the model's `fetch(MODEL_URL)` (already started by a `<link rel="preload">`). On the site both come from one module the site serves, `three.<hash>.js` (`tools/vendor_three.mjs` bundles them, so there is one three.js instance), and `THREE_URL` and `GLTF_URL` name the same file; in the preview they are jsDelivr's `+esm` bundles, whose loader imports `three` from the same pinned URL. GLTFLoader normally decodes embedded images through `blob:` URLs, which the CSP's `img-src 'self' data:` refuses, so a small plugin decodes them through `<img>` with data URIs instead.
- **Shading:** a `ShaderMaterial` reproduces the game's combiners in gamma space. `Combiners_Opaque_Mod2xNA_Alpha` with a sphere-mapped env texture shades the body and gem. `Combiners_Mod_Mod` shades the additive shells, and `shell_edge` also gets the game's edge fade. Lighting is ambient plus a warm key and a teal under-fill, with a teal rim that strengthens on hover. Additive passes leave canvas alpha untouched, so they add light to the page instead of darkening it.
- **Motion:** the model's own clip plays, the shell UVs scroll on their 4.033 s loop, and five glow sprites follow the emitter's colour, alpha and size curves. The sprites fade to zero at their edges, because the glow texture's background is near-black and would otherwise show as a faint square on the dark stage.
- **Cursor:** `aim()` casts the cursor's ray through the camera and meets it with a pane facing the camera, `GAP` (1.2) model units in front of the construct. It then turns the construct so the gem's own line of sight, not the centre's, passes through that point. On screen the gem always points straight at the cursor. `GAP` sets how far it turns: 0.7 swings it nearly side-on at the window's corners. It eases in through two smoothing stages in a row (`Math.exp(-dt * 7)` each), so the turn starts gently and trails the cursor by about 290 ms. With no cursor (touch after release, pointer outside the window) it sways ±22° on its own. Touch follows the finger while it is down.
- **Gem:** pulses on the CSS gem's 3.4 s rhythm. While the light is drawn in it charges up to a flash, then settles over 1.2 s.
- **Drawing in:** the model's animation slows to 15 % speed while the light is drawn in (`charge()`), and the gem hover check pauses.
- **Fallback:** the cutout stays visible until the first frame is drawn, then cross-fades out. If WebGL, three.js or the GLB fails, the page keeps the cutout and logs one console warning. WebGL context loss also falls back to the cutout.
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
  - the password file and `set-password` (which refuses a word with an arrow key in it, and another user's data directory);
  - the server keeping idle connections longer than Caddy does (`Keep-Alive: timeout=130`);
  - the CSP hashes against the served page, no CDN among its script sources, Trusted Types, and the other headers;
  - three.js served by the site, named by its hash;
  - a `SESSION_HOURS` or `PORT` that is not a number in range stops the server;
  - path traversal and other paths;
  - Origin, CSRF and content-type refusals;
  - the cookie's flags;
  - field cleaning and size limits, and dates that do not exist;
  - stored markup escaping;
  - backups, numbered so none overwrites another;
  - encounters: cleaning; the private section encrypted in `archive.json`, its key only wrapped in `auth.json`, absent from the page and the API, read back only with the session and its CSRF token, kept when not sent, removed when empty, still readable after the word changes; records naming an encounter, unlinked when it is removed;
  - an encounter only for the keeper: stored as one box (only its id and `added` in the clear), nothing of it in the page or `GET /api/archive` (not its id), a record naming it without the link for visitors and with it for the keeper, unticked and ticked again with its private section kept, readable after the word changes;
  - the About page's cleaning;
  - `PUBLIC_ORIGIN`: required, an https address, and taken as browsers write it (the API server is started with `https://Archive.test/`);
  - the fonts served by the site, named by their hashes, and a CSP that takes styles only by hash and fonts only from the site;
  - uploads: session, CSRF and Origin; SVG, HTML and JSON refused; bytes that don't match their type; size and dimension limits; storage under the content hash; a JPEG's size from its header; an upload without a session, sent slowly, refused at once and its connection let go within seconds;
  - plates: links, sizes from the file, several images per plate (reordered, relabelled, flagged, added), order, serving only the images in use, the sweep;
  - forms: cleaning, a plate naming a form that does not exist, keeping and moving a plate's form, renaming, order, no removal while a form holds plates;
  - GIFs (comments and XMP dropped, the frames byte for byte as they were, a cut-off GIF and one without an image refused), MP4s (metadata boxes zeroed in place, the picture data where it was; QuickTime and other files refused, also behind an `ftyp` box that gives its size in 64 bits, and one whose `moov` cannot be read through), WebM (kept as it is), the GIF and video limits, no temporary file left behind, stills that must be pictures, a video's size from the request and only a video looping, byte ranges (206, the last bytes, 416 past the end) and `media-src` in the CSP; 20 downloads of a long video stopped half way, after which the server must hold no more files open than before (counted in `/proc`, so only on Linux);
  - an archive saved before plates had several images (a separate server start);
  - the private sections and encounters only for the keeper across restarts (more server starts on the same data): no file holds their text; the word unlocks them after a restart; ciphertext copied onto another encounter does not decrypt; `set-password` refuses without the current word, carries the key over with it, will not write over the key a first login made while it waited for the words, and `--forget-private` leaves the old private sections unreadable while new ones can be written;
  - changing the word, which signs older sessions out;
  - logout;
  - per-address throttling via `X-Real-IP`, an IPv6 address by its /64, and a burst of parallel guesses that must get no more tries than guesses one after another;
  - a login refused while the server is busy checking other words (503), which must not count against its address;
  - a write whose body was still arriving when its session was sealed, which must be refused and leave nothing behind, and a GET sent with a trickling body, which must be let go within seconds;
  - COEP `require-corp` among the headers;
  - the device cookie: set with the session, and the pause for everyone (guesses from many addresses, four at a time so each is checked) sparing only a browser that carries a valid one, not a forged one nor one from before the word changed.
- **Word race checks** change the word eight times while a login with the old word is sent at a different moment each time: it must be over before the change (which then signs it out) or be refused; never a session that has already ended, nor an error.
- **Browser checks** run Chromium against the server's real CSP and treat any console error or CSP violation as a failure. A page just loaded or reloaded, and every further tab, first waits until its model is drawn (`settle()`): under software rendering (SwiftShader, as in a Claude Code cloud session) compiling the shaders and drawing the first frame hold a page up for many seconds, longer than the steps after it allow, and the checks after a load failed on that now and then (the last one every time). Nothing may be fetched from anywhere but the site (every face of the fonts must load from it), the page must be cross-origin isolated (`crossOriginIsolated`), and in a visitor's browser writing HTML into the page or turning text into script must throw (Trusted Types). They walk the gem until it reveals the hub's four choices, open Character Knowledge from it, close the tome (the choices must go and the construct sink back), wake the gem again and reopen Character Knowledge, then:
  - try a wrong word, then the right one, confirming the cookie stays invisible to scripts;
  - leave an empty record form with Escape, then inscribe a record containing markup (Escape must not throw it away first), which must stay text, dated in the year 35, which must show as 35, not 1935; the tome's close button must not throw the record away either;
  - reload, still unsealed, then revise and remove the record;
  - record an encounter only for the keeper, marked as such on its page and in the list;
  - record an encounter with TRP markup, an `<img>` and a private section; inscribe an undated record naming it; follow the record's link to it and find the record listed there; open the encounter in a second tab, seal the first, and check the private section and the encounter only for the keeper have left both, form fields included; open the encounter's address in a second browser and check nothing it receives holds the private text, then the address of the one only for the keeper, which shows the list and names it nowhere;
  - inscribe a record naming the encounter only for the keeper; on the record's page, seal and unseal: its link must go and come back without the record being opened again; then load the keeper's address of that encounter, which must open it;
  - with the keeper's archive held back after a reload, revise that record: it must keep its link; revise the encounter only for the keeper, seal elsewhere, unseal and save with the keeper's archive held back again: it must be revised, not saved a second time; open the encounter with a private section, retitle it while its private section is held back, then press Escape: the form and the new title must stay;
  - look at the record naming the encounter only for the keeper and at the encounter with a private section, then start a record; the record is held on its way (its answer, the keeper's archive, is held back) while the session is sealed elsewhere; once the answer arrives, nothing of the encounter only for the keeper, nor the private section, may be anywhere in the page, the record form's list of encounters included;
  - amend the About page in TRP terms: title, a directory field, lines of additional information (one moved up), TRP's standard traits with one slid, a glance with markup, and a description with TRP markup (a centred heading, a white and a gold colour, a `javascript:` and an https link, an icon) and an `<img>`; check that Escape keeps the unsaved form, that the colours are darkened, that only the https link is a link and that the HTML stays text;
  - add a form (Escape must not throw away its unsaved name), which opens at its own address; while it has no art, that address must show a second browser only the overview, which does not name it, and must open it for the keeper after a reload; then upload into it a plate of two images (Escape must not throw away the chosen image), the second flagged mature (re-encoded to WebP in the browser, then served under the CSP), with a `javascript:` link that must be dropped;
  - check the mature image is covered and not loaded; answer the age check (0 is refused, 30 shows it); go back to the form and find nothing of it left on the page, and open it without a second question; see it covered in the full-size view, then uncover it there: the focus must stay in the view, and the arrow keys must go on stepping;
  - in a second browser, answer 15: the image stays covered for the visit and is never requested;
  - upload a plate of a WebM video and a GIF: the row offers Loop for the video; the video plays and pauses in the player, and its bar goes on following it after a click on the bar; switching to the GIF removes the video, and the GIF pauses on a frame and plays again; moved later, the piece stays on the GIF, and so it does once its revision is cancelled, and once it is revised; the full-size view steps to the video in its player; Escape, a second time in the visit, closes only the full-size view;
  - open `#about` (no portrait on it) and the plate's own address, remove the plate, then remove the now empty form;
  - change the word;
  - seal, reload, and unseal with the new word;
  - change the word with `set-password` while three more tabs are open, one on the encounter, one with a record being written and one with the encounter's form open, and show them: the private section must leave the first, and the second must keep its writing and open the seal panel; the third, its tome closed, must let go of the private section its form held;
  - forget the word (`set-password --forget-private`) and unseal with a new one at the address of the encounter only for the keeper: it must say once that it can no longer be read, with no private section, and offer only its removal.
- **Preview checks** load `dist/preview.html` inside the Artifact skeleton, under a CSP like the viewer's, with no network requests allowed. They check that:
  - Art opens on the two example forms; the model and the example plates load from the page itself, and the plate flagged mature shows only its cover; opened from the list by keyboard, it asks first, and going back leaves the focus on its cover;
  - the example GIF and video are marked in their form's list, and both play from the page itself;
  - the age check works where the page has no storage;
  - the About page shows its example profile, and can be amended;
  - the seal panel names the preview word;
  - only `preview` unseals;
  - the example encounter's private section shows once unsealed, and the example encounter only for the keeper appears only then;
  - a record can be inscribed, and a plate of a picture and a GIF uploaded and shown from memory;
  - a reload forgets them;
  - there are no console errors;
  - `dist/index.html` carries no stand-in.

`SMOKE_ONLY=api,private,race,legacy,browser,preview` (any of them) runs only those checks. Screenshots go to `tools/.smoke/`. Behind an intercepting proxy, pass the proxy CA's key to Chromium with `CHROME_ARGS="--ignore-certificate-errors-spki-list=<sha256 of the CA's SPKI, base64>"`. In a Claude Code cloud session:

```
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
CHROME_ARGS="--ignore-certificate-errors-spki-list=$(openssl x509 -in /root/.ccr/agent-proxy-ca.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)" \
node smoke.js
```

## Open items for the owner

- **Deploy:** follow `deploy/README.md`. Replace `archive.example.com` in the Caddyfile and in `PUBLIC_ORIGIN` in the unit.
- **Set the keeper's word on the VPS** with `set-password` (step 3). Don't share it in chats or files.
- **Write the About page and add art** once deployed: open About or Art, unseal with the clasp, then **Amend this page**, or **Add a form** for each of his forms and **Add an art piece** inside it. The TRP description can be pasted into a section as it is; its markup carries over. Credit artists in the Artist field and link their page.
- **When updating an existing deployment**, check that `PUBLIC_ORIGIN` in the systemd unit is the site's https address and nothing more (`https://archive.example.com`): the server now refuses to start otherwise. Copy the new `deploy/Caddyfile` too, then `systemctl restart caddy` (with its admin API off, `reload` no longer works): video uploads need its 100 MB body limit for `/api/uploads`. Art added before forms existed shows as "Other art"; revise each piece to move it into a form.
- **Videos behind Cloudflare:** Cloudflare's terms say the Free, Pro and Business plans are not for serving video from your own server (`deploy/README.md`, Day to day). Decide whether a few clips are worth that, or host them elsewhere.
- **Preview:** the claude.ai Artifact stays private until you share it from its Share menu. It is for you to check changes; the real site is the VPS.
