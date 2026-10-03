# Chalice Archive: handover

A one-page RP site for a Dracthyr character. The landing page is nothing but his construct (the *Eternal Gladiator's Chalice*, an archival construct bought from a Shadowlands broker) floating on a dark stage. It is rendered from the game's own 3D model and turns to aim its gem at the cursor. Clicking the gem locks on, sweeps a teal scan line down the screen and over the model, then opens the archive. The archive is an old leather-bound tome in the style of the game's books and journals. It holds only his records: the most recent on the left page, and a chaptered index of everything he has re-learned since waking on the right.

- **Live page:** https://claude.ai/artifact/UFSgUToU7a4ZhuMdXe6ZWh. Published as a claude.ai Artifact, private until shared from its Share menu. Version 12 at handover.
- **`dist/chalice-archive.html`** is what version 12 was published from. `python3 build.py` reproduces it from `src/` and `assets/`.

## Status

| Area | State |
|---|---|
| Landing (the construct alone, no text), scan animation, archive panel, filters, record detail | Done |
| Inscribe / revise / remove record, remove examples | Done |
| **Keeper's seal** | **Done.** A brass clasp on the book's edge. The editing tools stay hidden, even for the owner, until the keeper's word is spoken. The word must be chosen once on the live page (see Open items). |
| Profile (name, epithet, construct name and note) | Kept in the data but no longer shown or editable on the page. The name is only used for screen readers. To change it, edit `profile` in `src/seed.json` (after copying the live data) and republish. |
| **Construct** | **Done.** The real in-game model (M2 → GLB) at the game's full detail, drawn with three.js and the game's own shading, animation and glow. It aims its gem at the cursor. The screenshot cutouts remain as the fallback. |
| Saving | **Works live.** The owner's first real save, **Remove examples** on 2026-10-03, republished the page as version 10. Also covered locally by `tools/smoke.js` (two saves in a row through a mocked `window.claude`). |
| Live viewer | Works in the claude.ai viewer (the owner has used the landing and saved from the archive). Also tested in headless Chromium under a CSP shaped like the viewer's. |
| Content | No records yet: the owner removed the 9 examples on the live page. `src/seed.json` was updated from the live page before version 11 was published. |

## Files

```
build.py                         builds dist/ from src/ + assets/
src/page.html                    the page: CSS, markup template, app script, with placeholders
src/seed.json                    profile + records embedded in the page
src/skeleton-reset.css           exact <style> of the claude.ai Artifact skeleton (used by the save path)
assets/model/chalice.glb         the construct's 3D model (made by tools/m2_to_glb.py, 544 KB)
assets/front.webp|png            front-view cutout (fallback while/if the model can't load)
assets/screenshots/              the original in-game screenshots
tools/m2.py                      minimal reader for M2 models and .skin files
tools/m2_to_glb.py               downloads the game files and writes assets/model/chalice.glb
tools/smoke.js                   headless-browser smoke test (CSP load + two saves); npm install in tools/ first
tools/cutout.py                  background removal used to make the cutouts (ISNet via onnxruntime)
dist/chalice-archive.html             page body: what gets published as the Artifact
dist/chalice-archive.standalone.html  same page in the skeleton; open locally in a browser (read-only)
```

Placeholders in `src/page.html`, filled by `build.py`:

| Placeholder | Filled with |
|---|---|
| `__FRONT__` | WebP data URI of the front cutout |
| `__MODEL__` | `assets/model/chalice.glb`, base64 |
| `__DATA__` | `seed.json` (with `<`, U+2028 and U+2029 escaped) |
| `"__RESET__"` | The skeleton CSS as a JS string |

## How the page works

### Structure

The published file contains exactly these blocks, in this order:

1. `<title>`
2. Google Fonts `<link>`
3. `<style id="ca-style">`
4. `<template id="ca-shell">`, which holds all the markup, including the scan overlay, the `<dialog>` and the toast
5. `<div id="ca-root">`
6. `<script type="application/json" id="ca-data">`
7. `<script type="application/octet-stream" id="ca-model">`: the GLB as base64
8. `<script id="ca-app">`

On boot, `ca-app` first captures `SRC`: the style's text, the template's innerHTML, the model's base64 and its own text. It then clones the template into `#ca-root` and renders from the JSON.

### Saving (self-republishing Artifact)

The page declares the Artifact capabilities `artifact` and `user`. Inside claude.ai:

1. `claude.use("user")` reports whether the viewer can edit. Owners and editors get **Inscribe record**, **Revise** and **Remove record**, plus **Remove examples** while example records exist.
2. Saving builds a complete new document with `buildHTML(state)`: the claude.ai skeleton, the same blocks rebuilt from `SRC`, and new JSON. It calls `artifact.publish(html)`.
3. The viewer reloads every open view to the new version.
4. `sessionStorage["ca-after"] = {view, id, toast}` survives the reload, so the archive reopens on the saved record with a confirmation.

Rules that keep this working:

- **Skeleton:** the skeleton string in `buildHTML` must match claude.ai's exactly. That means `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>` + reset + `</style></head><body>`. If it doesn't, later publishes nest one skeleton inside another.
- **New blocks:** anything you add to the page outside the blocks above must also be emitted by `buildHTML`. Otherwise the first save from the page deletes it. The model block is emitted from `SRC.model`.
- **Size:** every save republishes the whole page, currently 922 KB (the model is about 725 KB of it, nearly all textures). The limit is 16 MB.
- **Live DOM:** never serialize the live DOM.
- **Boolean attributes:** after the first save, template serialization turns `hidden` into `hidden=""`. This is harmless.
- **Error codes:**
  - `conflict`: the view reloads; the edit is dropped and the toast explains why.
  - `not_writer`, `not_granted` and similar: switch to read-only.
  - `rate_limited` and `too_large`: show a message.
  - `upstream_error`: retry once.
- **Viewer limits:** the viewer has no `alert`, `confirm` or `prompt`. Deletes are two-step buttons: the first click arms, the second confirms, and it auto-disarms after 5 s.

**Outside claude.ai** (local file, GitHub Pages, …), `window.claude` doesn't exist. The page is read-only and still renders the embedded records and the model. Self-hosting needs another way to save, either by editing `seed.json` and rebuilding, or with a small backend.

**Live data vs. `seed.json`:** records added through the live page exist only in the published Artifact. Before you rebuild from `seed.json` and republish, copy the current `ca-data` JSON from the live page into `src/seed.json`. Otherwise you overwrite his records. Version 10 was the owner's own save (examples removed). Its data was copied into `seed.json` before version 11 was built, so the two match at handover.

### Data model

```jsonc
{
  "profile": { "name": "", "epithet": "", "construct": "", "constructNote": "" },
  "records": [{
    "id": "r…",               // unique
    "title": "",
    "domain": "",             // free text; SUGGESTED_DOMAINS sets display order
    "status": "relearned",    // see below
    "note": "", "source": "",
    "date": "YYYY-MM-DD",
    "added": 0,               // ms timestamp, tie-breaker for ordering
    "example": false
  }],
  "seal": {                   // absent until the keeper chooses a word
    "v": 1, "kdf": "PBKDF2-SHA256", "iter": 600000,
    "salt": "…",              // 16 random bytes, base64
    "hash": "…"               // 32-byte PBKDF2 output, base64; the word itself is never stored
  }
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
- **Status bar:** the counts of each state.

### Design

- **Two worlds, one token set** (`:root` of `ca-style`): the landing is the dark void (navy grounds, teal light, copper). The archive is the tome (leather, parchment, sepia ink, red rubric ink, brass, and the game's red-and-gold buttons). It is a single deliberate look, not light and dark themes.
- **Fonts:** Cinzel (titles, buttons, the game's inscriptional capitals), IM Fell English (the book's text, an 18th-century typeface with old-style numerals) and IM Fell English SC (labels and dates).
- **The tome:** a leather binding (`.tome`, SVG noise as the hide) with brass corner fittings (`--corner`, an inline SVG) and a red silk ribbon in the gutter.
  - **Pages:** two parchment leaves either side of a shadowed spine (`.book`, `#page-l`, `#page-r`). The paper is fine SVG grain plus a stretched low-frequency stain (`--grain`, `--mottle`); a tiled stain showed a seam. Stacked page edges show beneath.
  - **Left leaf:** the owner's buttons (Inscribe record, and Remove examples while any exist; hidden from visitors), then "Recent accessions", the latest six records with date, state and the start of the note.
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

**Who can save is decided by claude.ai, not by this page.** `artifact.publish` succeeds only for the owner and people given edit access. Anyone on a public link is read-only on Anthropic's servers, whatever they run in their own browser. That is the real security boundary, and it already holds.

**The seal is a second lock on top, for the keeper's own browser.** The editing tools appear only when two things are true (`canPost()`): claude.ai says this account can write (`user.canEdit()` / `isOwner()`), and this tab has been unsealed with the word.
- **The clasp:** the brass keyhole on the book's right edge (`#clasp`) opens the word panel (`#seal`).
- **Choosing the word:** with no word set yet, an account that can write chooses one: at least 12 characters, typed twice. The page derives PBKDF2-SHA256 with a random 16-byte salt and 600,000 iterations (the OWASP figure for PBKDF2-SHA256) in the browser with WebCrypto. Only `{salt, hash, iter}` goes into the data block, published with the next save.
- **Unsealing:** the word is re-derived and compared byte by byte. Unsealing lasts until the tab closes (`sessionStorage["ca-unsealed"]`), so the reload after a save keeps the tools. **Seal it again** hides them at once. **Change the word** needs an unsealed tab.
- **Wrong words:** each miss doubles a wait, up to 30 s. A visitor who knows the right word is told that only the keeper's claude.ai account can write, and gets no tools.
- **Never leaves the browser:** the word is never stored, never sent anywhere and never written into the page. The inputs are cleared after use, and saves rebuild the page from the template rather than the live DOM.

**What this means in practice:**
- **Public hash:** the salted hash is public with the page, so the word should be a long phrase used nowhere else. PBKDF2's cost makes guessing slow, but a weak word could still be guessed offline.
- **Leaked word:** if someone learned the word, they still could not post. Without the keeper's claude.ai account they get nothing.
- **Encryption:** the page and every save travel over HTTPS to claude.ai. The records are not encrypted at rest because they are meant to be read by visitors. The word is hashed, not encrypted, so it cannot be recovered from the page.
- **Untrusted input:** every record field is rendered as text, never as HTML, and the data block escapes `<`, U+2028 and U+2029.

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

- **Loading:** three.js 0.186.1 and its GLTFLoader load as ES modules from jsDelivr's `+esm` bundles with dynamic `import()`. The loader's bundle imports `three` from the same pinned URL, so there is one three.js instance and no import map. GLTFLoader normally decodes embedded images through `blob:` URLs and `fetch`, which the Artifact CSP may refuse, so a small plugin decodes them through `<img>` with data URIs instead.
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
cd tools && npm install
CHROME=/path/to/chrome node smoke.js
```

It serves the standalone build under a CSP shaped like the viewer's and checks that the model loads. It checks that a click on the construct's body does nothing, that pointing at the gem shows the hand cursor, that clicking the gem opens the archive, and that the archive shows its two pages. With `window.claude` mocked as the owner, it checks that the tools stay hidden until the word is set, that setting it publishes only the salted hash and never the word, that a wrong word is refused, that the right word shows the tools, and that saves keep the seal. Finally it checks that a visitor who knows the word gets no tools. It then saves twice through a mocked `window.claude` and reloads each saved page. Screenshots go to `tools/.smoke/`. Behind an intercepting proxy, pass the proxy CA's key to Chromium with `CHROME_ARGS="--ignore-certificate-errors-spki-list=<sha256 of the CA's SPKI, base64>"`.

## Open items for the owner

- **Choose the keeper's word.** Open the live page, scan the gem, click the brass clasp on the book's right edge, and choose a long phrase you use nowhere else. Until then the editing tools stay hidden, even for you. Don't share the word in chats or files.
- If the character should have a name for screen readers, set `profile.name` in `src/seed.json` (it is no longer editable on the page).
- Share the page from its Share menu so other RPers can open it.
