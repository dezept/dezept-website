# Chalice Archive: handover

A one-page RP site for a Dracthyr character. The landing page shows his construct (the *Eternal Gladiator's Chalice* model, an archival construct bought from a Shadowlands broker) floating on a dark stage. Clicking it locks on, sweeps a teal scan line down the screen, then opens the archive: his most recent records and a knowledge index of what he has re-learned since waking.

- **Live page:** https://claude.ai/artifact/UFSgUToU7a4ZhuMdXe6ZWh. Published as a claude.ai Artifact, private until shared from its Share menu. Version 2 at handover.
- **`dist/chalice-archive.html`** is byte-identical to live version 2. `python3 build.py` reproduces it from `src/`.

## Status

| Area | State |
|---|---|
| Landing, float motion, scan animation, archive panel, filters, record detail | Done |
| Inscribe / revise / remove record, edit profile, remove examples | Done |
| Saving | Tested only locally, with a mocked `window.claude`. Never run live. The owner's first real save is the live test. |
| Content | Placeholder name "Unnamed Dracthyr" and 9 example records (`"example": true`). |
| **Construct image** | **Weak.** It is a cutout of a 235 × 245 px screenshot, upscaled 2×, and looks blurry. Next task: replace it with the real 3D model (see below). |

## Files

```
build.py                         builds dist/ from src/ + assets/
src/page.html                    the page: CSS, markup template, app script, with placeholders
src/seed.json                    profile + records embedded in the page
src/skeleton-reset.css           exact <style> of the claude.ai Artifact skeleton (used by the save path)
assets/front.webp|png            front-view cutout (floating construct)
assets/side.webp|png             side-view cutout (header of the archive panel)
assets/screenshots/              the original in-game screenshots
tools/cutout.py                  background removal used to make the cutouts (ISNet via onnxruntime)
dist/chalice-archive.html             page body: what gets published as the Artifact
dist/chalice-archive.standalone.html  same page in the skeleton; open locally in a browser (read-only)
```

Placeholders in `src/page.html`, filled by `build.py`:

| Placeholder | Filled with |
|---|---|
| `__FRONT__`, `__SIDE__` | WebP data URIs |
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
7. `<script id="ca-app">`

On boot, `ca-app` first captures `SRC`: the style's text, the template's innerHTML and its own text. It then clones the template into `#ca-root` and renders from the JSON.

### Saving (self-republishing Artifact)

The page declares the Artifact capabilities `artifact` and `user`. Inside claude.ai:

1. `claude.use("user")` reports whether the viewer can edit. Owners and editors get **Inscribe record** and **Edit profile**.
2. Saving builds a complete new document with `buildHTML(state)`: the claude.ai skeleton, the same blocks rebuilt from `SRC`, and new JSON. It calls `artifact.publish(html)`.
3. The viewer reloads every open view to the new version.
4. `sessionStorage["ca-after"] = {view, id, toast}` survives the reload, so the archive reopens on the saved record with a confirmation.

Rules that keep this working:

- **Skeleton:** the skeleton string in `buildHTML` must match claude.ai's exactly. That means `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>` + reset + `</style></head><body>`. If it doesn't, later publishes nest one skeleton inside another.
- **New blocks:** anything you add to the page outside the five blocks above (e.g. an import map or a model data block) must also be emitted by `buildHTML`. Otherwise the first save from the page deletes it.
- **Live DOM:** never serialize the live DOM.
- **Boolean attributes:** after the first save, template serialization turns `hidden` into `hidden=""`. This is harmless.
- **Error codes:**
  - `conflict`: the view reloads; the edit is dropped and the toast explains why.
  - `not_writer`, `not_granted` and similar: switch to read-only.
  - `rate_limited` and `too_large`: show a message.
  - `upstream_error`: retry once.
- **Viewer limits:** the viewer has no `alert`, `confirm` or `prompt`. Deletes are two-step buttons: the first click arms, the second confirms, and it auto-disarms after 5 s.

**Outside claude.ai** (local file, GitHub Pages, …), `window.claude` doesn't exist. The page is read-only and still renders the embedded records. Self-hosting needs another way to save, either by editing `seed.json` and rebuilding, or with a small backend.

**Live data vs. `seed.json`:** records added through the live page exist only in the published Artifact. Before you rebuild from `seed.json` and republish, copy the current `ca-data` JSON from the live page into `src/seed.json`. Otherwise you overwrite his records. At handover nothing had been added, so `seed.json` equals the live data.

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
- **Status bar:** the counts of each state.

### Design

- **Theme:** one deliberate dark theme (`color-scheme: dark`). Tokens live in `:root` of `ca-style`: void navy grounds, copper (the construct's frame) for structure, teal (the gem) for light and scan, plus amber and rose.
- **Fonts:** Forum (display), Alegreya Sans (body), Martian Mono (labels, readouts, counts).
- **Float:** three nested wrappers with different periods, so the motion never visibly loops:
  - `.fx-x`: 13 s drift
  - `.fx-y`: 5.6 s bob
  - `.fx-tilt`: 9 s tilt

  `.halo` and `.pool` pulse with the bob. `.gem` is a glow overlay at 50 % / 80.2 % of the image box, positioned for the front cutout.
- **Scan:** `scan()` adds `.is-scanning` to the stage (corner brackets lock on, gem flares, ring speeds up). It shows `#scan`: a beam plus a grid revealed by `clip-path`, both on the same 1.45 s easing, with readout lines every 230 ms. The dialog opens at about 1.95 s with a clip-path unfold.
- **Motes:** a canvas particle field, paused while the dialog is open or the tab is hidden.
- **Reduced motion:** `prefers-reduced-motion` turns off the float, the sweep and the unfold.

## Next task: real 3D model instead of the screenshot

1. **Export.** Use [wow.export](https://github.com/Kruithne/wow.export), which works from a local install or by streaming from Blizzard's CDN. Find the Chalice's model and export it as glTF with textures. Pack it to a single GLB, e.g. `npx @gltf-transform/cli copy model.gltf model.glb`. Keep it small, because every save republishes the whole page and the page limit is 16 MB including data URIs.
2. **Load three.js within the Artifact CSP.** Scripts may load only from `cdnjs.cloudflare.com`, `cdn.jsdelivr.net/npm/`, `unpkg.com`, `cdn.tailwindcss.com` and `code.jquery.com`. Every other request (fetch, images, other hosts) is blocked silently. Use three.js and `GLTFLoader` from jsdelivr with an exact pinned version, either as ES modules via an import map or as an older global build. Check it in the live viewer. Embed the GLB in the page, e.g. as a base64 `<script type="application/octet-stream" id="ca-model">`. Decode it to an ArrayBuffer and call `new GLTFLoader().parse(buffer, "", onLoad, onError)`. **Add that block, and any import map, to `buildHTML`.**
3. **Swap it in.** Replace `<img class="construct-img">` inside `.fx-tilt` with a `<canvas>` and transparent renderer (`alpha: true`). Either keep the CSS float wrappers or move the bob into three.js and add a slow yaw. Keep `.halo`, `.ring`, `.lock` and `.pool` as CSS overlays. Make the gem's material emissive teal and pulse it, then remove the CSS `.gem` overlay. On `.is-scanning`, sweep a light or emissive band down the model, synced to the 1.45 s beam. For the archive header (`__SIDE__`), either render a side view once to a data URI or keep the cutout.
4. **Keep it light.** Cap device pixel ratio at 2. Pause the render loop while the dialog is open or the tab is hidden, as `motes` does. Render a single still frame under reduced motion.
5. **Publish.** Rebuild and publish to the same Artifact URL. If records were added live in the meantime, pull them into `seed.json` first.

## Open items for the owner

- Set the character's name and the line under it (**Edit profile**).
- Remove the 9 example records (**Remove examples**) once real ones exist.
- Do a first real save, to confirm publishing works from the owner account.
- Share the page from its Share menu so other RPers can open it.
