# Chalice Archive: handover

A one-page RP site for a Dracthyr character. The landing page is nothing but his construct (the *Eternal Gladiator's Chalice*, an archival construct bought from a Shadowlands broker) floating on a dark stage. It is rendered from the game's own 3D model and turns to aim its gem at the cursor. Clicking the gem draws in all the light drifting in the dark around it: wisps, flares and motes spiral into the gem while it charges, then it flashes, a ring of light leaves it, and the construct rises and projects three choices beneath it: **About**, **Art** and **Character Knowledge**.

Each choice opens its chapter of the archive: a single parchment page in a leather binding, in the style of the game's books and journals, with index tabs on its top edge to move between chapters. Each chapter reads down one centred column; there is no two-page spread.

- **About:** laid out like a Total RP 3 profile. His portrait beside his title, name and full title; then Currently and OOC, the directory (race, class, age, eyes …), additional information, personality traits, at first glance, and the description in sections. The description keeps TRP3's markup, so a TRP profile can be pasted in.
- **Art:** the plates (pictures of him) as a list; a plate opens on its own page, and a full-size view shows it on a dark ground. A plate is one or more images: its main image and alternate versions. Any image can be flagged **mature**: it stays covered, and is not even loaded, until a visitor says they are 18 or older, and it is covered again once they move on.
- **Character Knowledge:** his records: the most recent first, then a chaptered index of everything he has re-learned since waking.

- **Self-hosted** on the owner's VPS: Cloudflare in front, then Caddy, then a small Node server (`server/server.mjs`, no dependencies) that serves the page and the model, stores the records, and checks the keeper's word. **`deploy/README.md` is the step-by-step setup.**
- **Preview:** the claude.ai Artifact https://claude.ai/artifact/UFSgUToU7a4ZhuMdXe6ZWh is now the preview. After every change, publish `dist/preview.html` to it (see [Previewing changes](#previewing-changes-on-claudeai)) so the owner can see the change before deploying it. Version 13 is the first preview build; version 14 adds the hub and the About and Art chapters; version 15 adds alternate versions, mature images and the age check; version 16 is the single-page layout with the TRP-style About; version 17 sets section headings as pull quotes with a colour each; version 18 replaces the scan with the gem drawing the light in, and adds the flares.
  - Before the move, its data (no records, no word) matched `src/seed.json`, so nothing needed migrating.

## Status

| Area | State |
|---|---|
| Landing (the construct alone, no text), the gem drawing the light in, archive (one page per chapter), record detail | Done |
| **Hub** (About, Art, Character Knowledge beneath the construct once it has drawn the light in, no other text) and the tome's chapter tabs | Done |
| **About** page, as a Total RP 3 profile: portrait, title, name, full title, currently and OOC, directory, additional information, personality traits, at first glance, description with TRP markup; amended by the keeper | Done, through the server's API |
| **Art**: plates uploaded from the keeper's browser, ordered, captioned, shown full size, one chosen as the portrait | Done, through the server's API |
| **Alternate versions** (up to 12 images per plate) and **mature** images behind an age check | Done |
| Addresses: `#about`, `#art`, `#knowledge`, `#art/<plate>` and `#knowledge/<record>` open there at once | Done |
| Inscribe / revise / remove record, remove examples | Done, through the server's API |
| **Keeper's seal** | **Done.** A brass clasp on the tome's edge opens a small panel. The keeper's word is checked on the server and gives a session; **Seal it again** ends it. The word is set on the VPS with `set-password` and can be changed from the panel. |
| Server, Caddy, Cloudflare, firewall, systemd | Written and tested here. The server is covered by `tools/smoke.js` (120 checks, including the preview). The Caddyfile was run with Caddy 2.10.2 in front of the server, with test certificates standing in for Cloudflare's; its per-route body limits were checked again with Caddy 2.10.2. The systemd unit passes `systemd-analyze verify`, but this container has no systemd to run it. |
| Profile (name, epithet, construct name and note) | The name and epithet are shown on the About page and amended there. The construct's name and note are kept in the data but not shown. |
| **Construct** | **Done.** The real in-game model (M2 → GLB) at the game's full detail, drawn with three.js and the game's own shading, animation and glow. It aims its gem at the cursor. The screenshot cutout remains as the fallback. |
| Preview on claude.ai | Done. The Artifact shows the current build with an in-page stand-in for the server (version 14). |
| Content | No records, no About text and no plates yet. The preview shows example plates and an example About page; the real site starts empty. |

## Files

```
build.py                         builds dist/ from src/ + assets/
src/page.html                    the page: CSS, markup, app script, with placeholders
src/seed.json                    the starting archive, copied to DATA_DIR/archive.json on the server's first start
src/preview.js                   the server's stand-in for the claude.ai preview (only in dist/preview.html)
src/preview-examples.json        the preview's example About page and plates (only in dist/preview.html)
server/server.mjs                the server (Node 20+, no dependencies); `set-password` sets the keeper's word
deploy/README.md                 VPS setup: Node, Caddy, Cloudflare, firewall, backups, what protects what
deploy/Caddyfile                 Caddy in front of the server: Origin Certificate, Authenticated Origin Pulls, real client IP
deploy/chalice-archive.service   systemd unit with sandboxing
deploy/firewall.sh               ufw: 443 only from Cloudflare, SSH rate-limited, everything else closed
assets/model/chalice.glb         the construct's 3D model (made by tools/m2_to_glb.py, 544 KB)
assets/front.webp|png            front-view cutout (fallback while/if the model can't load)
assets/screenshots/              the original in-game screenshots
assets/examples/                 the preview's example plates: the construct rendered by tools/example_plates.js
tools/m2.py                      minimal reader for M2 models and .skin files
tools/m2_to_glb.py               downloads the game files and writes assets/model/chalice.glb
tools/smoke.js                   starts the server and tests the API and the page; npm install in tools/ first
tools/example_plates.js          renders assets/examples/ from the preview build (only needed to remake them)
tools/cutout.py                  background removal used to make the cutouts (ISNet via onnxruntime)
dist/index.html                  the built page (committed, so the VPS needs no build step)
dist/chalice.<hash>.glb          the model, named by its SHA-256 so it can be cached forever
dist/preview.html                the claude.ai preview build (git-ignored; rebuilt by build.py)
CLAUDE.md (repo root)            standing instructions for future Claude sessions: publish the preview after each change
```

Placeholders in `src/page.html`:

| Placeholder | Filled by | With |
|---|---|---|
| `__FRONT__` | `build.py` | WebP data URI of the front cutout |
| `__MODEL_URL__` | `build.py` | `chalice.<first 12 hex of SHA-256>.glb` |
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
- **No network:** the viewer's CSP has `connect-src 'none'` and `img-src data:`, so the page can't fetch anything. The model is embedded as base64 in `#ca-model`, and the example plates' images as data: URIs in `#ca-files`.
- **Stand-in server:** `<script id="ca-preview">` (`src/preview.js`) sets `window.CA_PREVIEW`. `ca-app` then sends its requests there instead of to `fetch`, and asks `CA_PREVIEW.src(name)` for each plate's image instead of `art/<name>`. That covers the model and every API route, image uploads included, with the same validation and error messages as the server.
- **Examples:** the preview adds `src/preview-examples.json` to `src/seed.json`: an About page and three plates (renders of the construct), one with alternate versions. Two images are flagged mature only to show the cover and the age check; none is really mature. They are marked as examples in their titles and never reach the real site.
- **The word** is `preview`, and the seal panel says so. Changing the word works until reload.
- **Records, the About page and plates** start from the seed and the examples and live only in memory (uploaded images as data: URIs), so a reload forgets every change and seals the archive again.
- **The real page carries none of this:** `dist/index.html` has no `ca-preview`, `ca-model` or `ca-files`, and `window.CA_PREVIEW` can't be set there, because its CSP runs no other inline script. The smoke test checks both.
- **Never put real records or the real word into the preview.** Never use the Artifact's own capabilities (`artifact.publish`) to save; that path was removed on purpose.

## How the page works

### Structure

`dist/index.html` is an ordinary document: `<head>` with the title, an inline SVG favicon, a preload of the model, the Google Fonts `<link>` and `<style id="ca-style">`; `<body>` with the markup (stage with the hub, the `<dialog>` with the chapter tabs, the tome and the full-size plate view, the toast), `<script type="application/json" id="ca-data">` and `<script id="ca-app">`. The model is fetched from `MODEL_URL`, and plates' images from `art/<name>`.

In `ca-app`, `el` holds every element with an id, in camelCase (`det-title` is `el.detTitle`).

The server computes SHA-256 hashes of `ca-app` and `ca-style` at startup and puts them in the Content-Security-Policy, so they are the only inline script and style that can run. **Any other inline `<script>`, `<style>`, `style="…"` attribute or `on…=` handler is blocked.** Add styles to `ca-style`, code to `ca-app`, and set styles from JS through `el.style` (allowed), not `setAttribute("style", …)`.

### Server and API

| Route | Who | Does |
|---|---|---|
| `GET /` | anyone | the page, with the current archive in `ca-data` |
| `GET /chalice.<hash>.glb` | anyone | the model, cached for a year (`immutable`) |
| `GET /api/session` | anyone | `{owner, csrf}`: whether this browser holds the keeper's session, and its CSRF token |
| `GET /api/archive` | anyone | `{archive}` |
| `GET /art/<name>` | anyone | a plate's image, only while a plate uses it; cached for a year by browsers and a day by Cloudflare |
| `POST /api/login` | anyone, throttled | `{password}` → session cookie + `{csrf}` |
| `POST /api/logout` | keeper | ends the session |
| `POST /api/password` | keeper | `{current, next}` → new word, every other session ended |
| `POST /api/records` | keeper | new record → `{archive, id}` |
| `PUT /api/records/:id` | keeper | revise → `{archive, id}` |
| `DELETE /api/records/:id` | keeper | remove → `{archive}` |
| `POST /api/records/clear-examples` | keeper | remove example records → `{archive}` |
| `PUT /api/about` | keeper | the whole page: `{name, epithet, portrait, title, currently, ooc, race, class, age, eyes, eyeColor, height, build, birthplace, residence, facts, traits, glances, sections}` → `{archive}` |
| `POST /api/uploads` | keeper | an image's raw bytes, sent with its type (PNG, JPEG or WebP, at most 8 MiB) → `{file, width, height}` |
| `POST /api/art` | keeper | new plate `{title, artist, link, date, note, versions: [{file, thumb, label, mature}]}` → `{archive, id}`; it goes first |
| `PUT /api/art/:id` | keeper | revise; `versions` (if sent) lists every image in its new order: `{id, label, mature}` keeps one of the plate's images, `{file, thumb, label, mature}` adds an uploaded one → `{archive, id}` |
| `DELETE /api/art/:id` | keeper | remove; clears it as the portrait → `{archive}` |
| `POST /api/art/order` | keeper | `{ids}`, every plate once, in the new order → `{archive}` |

- **Keeper-only routes** need the session cookie, an `X-CSRF-Token` header equal to the session's token and an `Origin` equal to `PUBLIC_ORIGIN`. Bodies must be a JSON object (`Content-Type: application/json`, at most 64 KiB; 256 KiB for the About page), except uploads.
- **Server-side cleaning:** ids, `added` and `example` are set by the server. Text is trimmed, stripped of control characters and capped:
  - records: title 120, domain 60, note 4000, source 160. Unknown states become `fragment`, bad dates become today, an empty domain becomes "Unsorted".
  - About: name 60, epithet (the full title) 280, title 60, currently and OOC 1000 each, directory fields 60 (birthplace and residence 120). The eye colour must be `#rrggbb` or is dropped. Up to 24 lines of additional information (label 40, value 400), 24 traits (each pole 40; the value is rounded into 0–20, anything else becomes 10), 5 glances (title 80, text 1000) and 24 sections (heading 120, text 40 000, heading colour `#rrggbb` or dropped; the 256 KiB body is the real limit, about 250 000 characters in all, and a longer page is refused with a message that says so). Empty rows are dropped. Unknown fields are dropped. A portrait that names no plate is cleared. Section text keeps TRP markup as plain text; only the page reads it.
  - plates: title 120, artist 80, note 1000, at most 500 plates of 1 to 12 images each, image labels 60. Only `"mature": true` flags an image. A link must be `http(s)` (a bare `artstation.com/x` becomes `https://artstation.com/x`); anything else, `javascript:` included, is dropped. Width and height come from the image file, never from the request.
  - the portrait: a plate whose main image is mature can't be the portrait, and flagging the portrait's main image as mature clears it.
- **Uploads:** the type is read from the bytes and must match the `Content-Type` (PNG, JPEG or WebP; never SVG or HTML). At most 8 MiB and 10000 pixels on a side. The file is stored as `DATA_DIR/art/<first 32 hex digits of its SHA-256>.<png|jpg|webp>`, so the same image is stored once.
- **The keeper's browser prepares each image:** it scales it to at most 2400 pixels on the long side and re-encodes it as WebP (JPEG on browsers that can't write WebP), which drops any metadata such as a photo's location. It also makes an 800-pixel thumbnail for the list and the portrait. Both are uploaded, then the plate is saved.
- **Serving art:** only files a plate uses right now, by exact name, with their type, `nosniff` and the CSP. Removing a plate stops serving its image at once; Cloudflare's copy expires within a day (`s-maxage=86400`).
- **The sweep** (at start, every 6 hours and after a plate is revised or removed) deletes an image once neither the archive nor any of its 50 backups uses it and it is over a day old. So restoring a backup always finds its images, and an upload whose plate was never saved disappears after a day.
- **Storage:** `DATA_DIR/archive.json`, written atomically (temp file, fsync, rename). The previous version goes to `DATA_DIR/backups/` first, keeping the last 50. `auth.json` holds the scrypt hash. `art/` holds the images. All are mode 0600 in 0700 directories.
- **Sessions** are kept in memory (at most 50), so a restart signs the keeper out. Only each token's SHA-256 is stored.
- **In the page** (`ca-app`): `call(method, url, body)` wraps `fetch` with the CSRF header. `save()` sends a change and re-renders from the archive the server returns. A 401/403 asks the server about the session again: if it has ended, the seal panel opens without closing an open form, so the keeper can unseal and press Inscribe again.
- **Deletes** are two-step buttons: the first click arms, the second confirms, and they disarm after 5 s.

### Data model

```jsonc
{
  "profile": { "name": "", "epithet": "", "construct": "", "constructNote": "" },
  "about": {
    "portrait": "",           // a plate's id, or ""
    "title": "",              // shown above the name, e.g. "Archivist"
    "currently": "", "ooc": "",
    "race": "", "class": "", "age": "", "eyes": "", "eyeColor": "",   // "#rrggbb" or ""
    "height": "", "build": "", "birthplace": "", "residence": "",
    "facts": [{ "label": "Motto", "value": "" }],                     // additional information
    "traits": [{ "left": "Chaotic", "right": "Lawful", "value": 10 }], // 0 = all left, 20 = all right
    "glances": [{ "title": "", "text": "" }],                         // at first glance, at most 5
    "sections": [{ "heading": "Physical description", "body": "", "color": "#ffd100" }] // the description; body keeps TRP markup; color is the heading's ("" = TRP's gold)
  },
  "art": [{                   // in the keeper's order; a new plate goes first
    "id": "a…",               // set by the server: "a" + 12 random base64url characters
    "versions": [{            // 1 to 12 images; the first is the main one, shown in the list and as the portrait
      "id": "v…",             // set by the server
      "file": "<32 hex>.webp",  // up to 2400 px on the long side
      "thumb": "<32 hex>.webp", // up to 800 px
      "width": 0, "height": 0,  // of `file`, read by the server
      "label": "",            // e.g. "Without armour"; shown as "Main" or "Version 2" when empty
      "mature": false         // covered until the visitor says they are 18 or older
    }],
    "title": "", "artist": "", "link": "", "note": "",
    "date": "YYYY-MM-DD", "added": 0, "example": false
  }],
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
- **Plates saved with a single image** (before plates had versions) carry `file`, `thumb`, `width` and `height` on the plate itself. The server reads them as a plate of one image, with the id `v` + the first 12 hex digits of its file name, and writes them in the new form on the next change.

### Design

- **Two worlds, one token set** (`:root` of `ca-style`): the landing and the hub are the dark void (navy grounds, teal light, copper). The archive is the tome (leather, parchment, sepia ink, red rubric ink, brass, and the game's red-and-gold buttons). The full-size plate goes back to the dark ground. It is a single deliberate look, not light and dark themes.
- **The hub** (`#hub`, inside `.core`): once the light is drawn in, `.has-hub` on the stage lifts the construct 56 px and three choices appear beneath it, each a glyph (a slit-pupilled eye, a framed picture, an open book) and its label: About, Art, Character Knowledge. There is no other text. They are dark panes with teal corner brackets, and they flicker in one after another as the gem flashes. On short landscape screens they stand beside the construct instead. Waking the construct from the keyboard moves the focus to the first. The hub stays once shown; closing the tome returns the focus to the choice that opened it.
- **Chapter tabs** (`#tabs`): leather index tabs on the tome's top edge; the open chapter's tab is a parchment leaf. While a form is open, they only say to finish or cancel it, so nothing written is lost. Escape leaves the About form only while nothing in it has changed; otherwise it says there are unsaved changes.
- **Views:** each view belongs to a chapter and shows below that chapter's own leaf (`#leaf-about`, `#leaf-art`, `#leaf-knowledge`) in one column (`VIEWS` in `ca-app`). The DOM still has the two `#page-l` and `#page-r` sections, but they are stacked: `#page-l` holds the chapter's leaf, `#page-r` the view. `.book` carries `data-book`, `data-view` and, for a record, a plate or a form, `data-solo`, which hides the chapter's leaf so the record, plate or form has the page to itself. In Art, the list of plates (`data-view="plates"`) shows alone, and a plate opens on its own with "← Return to the plates".
- **About** (a Total RP 3 profile):
  - **Header:** the portrait is the plate's thumbnail in an oval inside a parchment mount, the way old books print a frontispiece; a click shows it full size. Without one, a dashed oval says "No likeness yet". Beside it, the title in red small capitals, the name with the record title's rule and red dot beneath it, and the full title (the `epithet`) in italic. On phones they stack, centred.
  - **Below it**, each part only when it has something in it: Currently and Out of character in a note box; the **Directory** (two columns of label and value; the eyes get a colour swatch); **Additional information** (the old particulars, one column); **Personality traits** (each a bar between its two poles with a brass marker; the pole it leans toward is darker, and screen readers hear "fairly Lawful"); **At first glance** (up to five cards); then the **description**'s sections. Each section's heading is set like a pull quote: large italic IM Fell English in faded curly quotes, centred between two flourishes that fade out from a small diamond (`sectionHeading()`, `.ab-heading`). Quotes typed into the heading are dropped, so they never double. Its colour is the section's own `color` made readable by `ink()`; without one it is TRP's gold, `{col:ffd100}` darkened (`--ink-gold`, #705c00). The first plain paragraph of the description, if longer than 120 characters, opens with a red drop capital.
  - **TRP markup** (`trp()` in `ca-app`) is turned into elements, never parsed as HTML: `{h1}`…`{/h1}` to `{h3}` (as h5 and h6) with `:c`/`:r`, `{p:c}`/`{p:r}`, `{col:rrggbb}`…`{/col}`, the game's `|cAARRGGBB`…`|r`, and `{link*url*text}` (a link only for `http(s)://`, opened in a new tab with `noopener noreferrer`). `{icon:…}`, `{img:…}` and `|T…|t` are game files and are dropped. A blank line starts a paragraph; a single line break stays a line break. TRP colours are chosen for dark frames, so `ink()` keeps each colour's hue but darkens it until it has 4.5:1 contrast with the parchment; white and pale greys become the sepia ink. Colours are set through `el.style`, which the CSP allows.
  - **The keeper's form:** title, name, full title, portrait, currently and OOC, the directory with an optional eye colour, then rows with ↑, ↓ and × buttons for additional information (with suggested labels), traits (two poles and a 0–20 slider; **Add TRP's standard traits** adds TRP3's eleven pairs at the middle), glances, and the description's sections, each with a colour picker for its heading (TRP's gold by default; a new section takes the colour of the last one; the heading field shows the colour as it will look) (**Add TRP's three sections**: Physical description, Personality, History). A collapsible note lists the markup. "Make it the portrait" on a plate sends the whole page back with the new portrait (`aboutNow()`), so nothing else changes.
- **Art:** the plates are mounted thumbnails of their main image, cropped to 4 : 5 and numbered with roman numerals in the keeper's order; a plate of several images says how many. The chosen plate shows on its own page at its own shape, with its number (and the image's label), title, "by" the artist (a link to their page when there is one, opened with `noopener noreferrer`), date and note. Beneath the image, a strip of small thumbnails switches between the plate's images. The keeper can revise it, make it the portrait, move it earlier or later, or remove it.
- **The plate form** has a row per image, in order (the first is the main image): its thumbnail, a label, a **Mature (18+)** box, and ↑ ↓ × buttons. **+ Add an image** adds a row with a file input. To change an image, add the new one and remove the old.
- **Mature images and the age check:**
  - A mature image shows only a cover (`.spoiler`: a dark hatched panel with a red **18+** seal and "Mature"), in the list, in the strip, on the plate's page and in the full-size view. The image itself is not loaded until it is shown, so its pixels never reach the browser before then.
  - Selecting a cover (or a plate in the list whose main image is mature) opens the age check (`#gate`): "How old are you?" with a number. 18 or older shows the image; under 18 says mature images are only for those 18 or older and keeps it covered.
  - The answer is kept for the browser tab (`sessionStorage`, in memory where storage is blocked), so later covers open on a click without asking again, and someone under 18 is not asked again.
  - Whatever the answer, a mature image is covered again as soon as another image takes its place, the visitor goes back to the plates or another chapter, or the tome closes (`shown` in `ca-app` holds the one image on view). In the full-size view, stepping onto a mature image shows its cover.
  - It is an honest question, not proof of age, as on most sites: nothing stops someone from claiming to be 18, and the image addresses are in the page's data for anyone who digs. What it guarantees is that nobody sees a mature image without choosing to and saying they are an adult.
- **Full-size plate** (`#lightbox`, inside the dialog): the image on the dark ground with its number, title, label and artist in the game's gold; the game's round red buttons step through every image of every plate in order (arrow keys too) and close it. It shows the thumbnail at once and swaps in the full image when it has loaded. While it is open, the tome is `inert`; Escape closes only it. On narrow screens the step buttons sit at the bottom.
- **Addresses:** the open chapter is written into the address with `history.replaceState` (`#about`, `#art/<plate>`, `#knowledge/<record>`), so it can be copied and shared. Opening such an address goes straight to it, without waking the construct, and so does changing the hash.
- **Fonts:** Cinzel (titles, buttons, the game's inscriptional capitals), IM Fell English (the book's text, an 18th-century typeface with old-style numerals) and IM Fell English SC (labels and dates).
- **The tome:** a leather binding (`.tome`, SVG noise as the hide) with brass corner fittings (`--corner`, an inline SVG) and a red silk ribbon hanging out below the page.
  - **The page:** one parchment page (`.book`) with a printed double rule, at most 800 px of text column centred on it. The paper is fine SVG grain plus a stretched low-frequency stain (`--grain`, `--mottle`); a tiled stain showed a seam. Stacked page edges show beneath. The page keeps its height; its contents scroll inside `#book-scroll`, fading out at the rules.
  - **Character Knowledge:** the keeper's buttons (Inscribe record, and Remove examples while any exist; shown only during the keeper's session), then "Recent accessions", the latest six records with date, state and the start of the note, then the "Index of knowledge" as a table of contents. Domains are numbered chapters with roman numerals, and each entry runs to its state on dotted leaders. A record or a form has the page to itself. A record has a red drop capital and its sources as marginalia. Forms are written on ruled lines.
  - **Game styling:** buttons copy the game's red panel buttons (gold text, brass rim). The close button is the round red one, and notices are dark tooltips with gold text.
  - **Narrow screens (≤ 860 px):** the same page with a thinner binding and narrower margins; form rows stack. At 560 px and below, the About header stacks too.
- **Landing:** only the construct, centred on the dark stage, with its ambient light (below). There is no visible text until the hub appears. The character's name is in a visually hidden `<h1>`, the button's accessible name ("Open the archive of …") and the archive's hidden heading, and visibly on the About page.
- **Not shown anywhere:** the construct's name and note from the profile, the state-of-knowledge ledger and filters, and "Example" tags. The removed pieces are gone from the code, not hidden. The `example` flag stays in the data so **Remove examples** still works.
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
- **Unsealing:** the word goes to `POST /api/login` over HTTPS. The server compares it with the stored scrypt hash (N=2¹⁷, r=8, p=1, 16-byte salt, 64-byte key; one check at a time, so a burst cannot exhaust memory). The right word gets a random 256-bit session token in a `__Host-ca_session` cookie (HttpOnly, Secure, SameSite=Strict, 12 hours), plus a CSRF token in the response body, kept in a variable.
- **Wrong words:** two free misses per client address, then waits of 2 s, 4 s, 8 s … up to an hour (429 with Retry-After). More than 50 misses in ten minutes from anywhere pauses all logins until the window clears. Behind Caddy, the client address is Cloudflare's `CF-Connecting-IP`, trusted only from Cloudflare's ranges and passed on as `X-Real-IP`; the server believes `X-Real-IP` only from loopback and only with `TRUST_PROXY=true`.
- **Panel modes:** unsealed, the panel offers **Seal it again** (logout) and **Change the word** (current word, new word twice; at least 12 characters). Changing the word signs every other session out.
- **Setting the word:** only on the server, as the service user: `node server/server.mjs set-password` asks twice with hidden input (or reads two lines from stdin). It refuses words under 12 characters. There is no web form for a first word, so nobody can claim the archive before the keeper does. Running it again is also the recovery path for a forgotten word.
- **Where the word goes:** typed into the panel, sent once over HTTPS, hashed, discarded. It is never logged, stored in the browser, or written into the page. The inputs are cleared after use.
- **Encryption:**
  - In transit: visitor ↔ Cloudflare uses Cloudflare's edge certificate, and Cloudflare ↔ Caddy uses the Origin Certificate in Full (strict) mode with Authenticated Origin Pulls, TLS 1.2+. Caddy ↔ Node is plain HTTP on loopback only.
  - At rest: the records are not encrypted, because they are published to every visitor. The word is hashed, not encrypted, so it cannot be recovered from `auth.json`.
- **Untrusted input:** every record, About and plate field is rendered with `textContent`, never as HTML. A plate's link becomes an `<a>` only if it starts with `http(s)://`, on the server and again in the page. The data block escapes `<`, `>`, `&`, U+2028 and U+2029. The CSP blocks any script that is not the page's own.
- **Images:** only PNG, JPEG and WebP whose bytes match their type, served with that type and `nosniff`, so an upload can never be read as a page or a script. Uploads need the keeper's session like every other write.
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
- **Gem:** pulses on the CSS gem's 3.4 s rhythm. While the light is drawn in it charges up to a flash, then settles over 1.2 s.
- **Drawing in:** the model's animation slows to 15 % speed while the light is drawn in (`charge()`), and the gem hover check pauses.
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
  - the About page's cleaning;
  - uploads: session, CSRF and Origin; SVG, HTML and JSON refused; bytes that don't match their type; size and dimension limits; storage under the content hash; a JPEG's size from its header;
  - plates: links, sizes from the file, several images per plate (reordered, relabelled, flagged, added), order, the portrait (never a mature image), serving only the images in use, the sweep;
  - an archive saved before plates had several images (a separate server start);
  - changing the word, which signs older sessions out;
  - logout;
  - per-address throttling via `X-Real-IP`.
- **Browser checks** run Chromium against the server's real CSP and treat any console error or CSP violation as a failure. They walk the gem until it reveals the hub, open Knowledge from it, then:
  - try a wrong word, then the right one, confirming the cookie stays invisible to scripts;
  - inscribe a record containing markup, which must stay text;
  - reload, still unsealed, then revise and remove the record;
  - amend the About page in TRP terms: title, a directory field, lines of additional information (one moved up), TRP's standard traits with one slid, a glance with markup, and a description with TRP markup (a centred heading, a white and a gold colour, a `javascript:` and an https link, an icon) and an `<img>`; check that Escape keeps the unsaved form, that the colours are darkened, that only the https link is a link and that the HTML stays text;
  - after making a plate the portrait, check the rest of the About page is still there;
  - upload a plate of two images, the second flagged mature (re-encoded to WebP in the browser, then served under the CSP), with a `javascript:` link that must be dropped;
  - check the mature image is covered and not loaded; answer the age check (0 is refused, 30 shows it); see it covered again back at the plates, and open without a second question; see it covered in the full-size view;
  - in a second browser, answer 15: the image stays covered for the visit and is never requested;
  - make the plate the portrait, open `#about` and the plate's own address, and remove it;
  - change the word;
  - seal, reload, and unseal with the new word.
- **Preview checks** load `dist/preview.html` inside the Artifact skeleton, under a CSP like the viewer's, with no network requests allowed. They check that:
  - the model and the example plates load from the page itself, and the plate flagged mature shows only its cover;
  - the age check works where the page has no storage;
  - the About page shows its example profile, and can be amended;
  - the seal panel names the preview word;
  - only `preview` unseals;
  - a record can be inscribed, and a plate uploaded and shown from memory;
  - a reload forgets them;
  - there are no console errors;
  - `dist/index.html` carries no stand-in.

Screenshots go to `tools/.smoke/`. Behind an intercepting proxy, pass the proxy CA's key to Chromium with `CHROME_ARGS="--ignore-certificate-errors-spki-list=<sha256 of the CA's SPKI, base64>"`. In a Claude Code cloud session:

```
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
CHROME_ARGS="--ignore-certificate-errors-spki-list=$(openssl x509 -in /root/.ccr/agent-proxy-ca.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)" \
node smoke.js
```

## Open items for the owner

- **Deploy:** follow `deploy/README.md`. Replace `archive.example.com` in the Caddyfile and in `PUBLIC_ORIGIN` in the unit.
- **Set the keeper's word on the VPS** with `set-password` (step 3). Don't share it in chats or files.
- **Write the About page and add art** once deployed: open About or Art, unseal with the clasp, then **Amend this page** or **Add a plate**. The TRP description can be pasted into a section as it is; its markup carries over. Credit artists in the Artist field and link their page.
- **When updating an existing deployment**, copy the new `deploy/Caddyfile` too: uploads need its larger body limit for `/api/uploads`.
- **Preview:** the claude.ai Artifact stays private until you share it from its Share menu. It is for you to check changes; the real site is the VPS.
