#!/usr/bin/env python3
"""Build the Chalice Archive site.

    python3 build.py

Writes dist/:
  dist/index.html            the page server/server.mjs serves; it fills in __ARCHIVE__ with the records on each request
  dist/chalice.<hash>.glb    the construct's 3D model (assets/model/chalice.glb, made by tools/m2_to_glb.py),
                             named by its SHA-256 so browsers and Cloudflare can cache it for good
  dist/preview.html          the preview published as the claude.ai Artifact (git-ignored). The Artifact viewer wraps
                             the page in its own <html>/<head> and allows no network requests, so this build is a
                             page fragment with src/seed.json as its records, the model embedded as base64 and
                             src/preview.js standing in for the server.

Placeholders in src/page.html:
  __FRONT__      front cutout (assets/front.webp) as a data URI, shown until the 3D model has drawn
  __MODEL_URL__  the model's file name
  __ARCHIVE__    left for the server (filled from src/seed.json in the preview)
"""
import base64
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / "dist"


def script_json(obj) -> str:
    """JSON for a <script> data block, escaped the same way as the server does it."""
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    for ch, esc in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"), (" ", "\\u2028"), (" ", "\\u2029")):
        s = s.replace(ch, esc)
    return s


def cut(text: str, part: str) -> str:
    assert text.count(part) == 1, f"expected exactly one {part[:60]!r}"
    return text.replace(part, "")


page = (ROOT / "src/page.html").read_text(encoding="utf-8")
model = (ROOT / "assets/model/chalice.glb").read_bytes()
model_name = f"chalice.{hashlib.sha256(model).hexdigest()[:12]}.glb"

page = page.replace("__FRONT__", "data:image/webp;base64," + base64.b64encode((ROOT / "assets/front.webp").read_bytes()).decode())
page = page.replace("__MODEL_URL__", model_name)
leftover = [line.strip()[:80] for line in page.splitlines() if "__FRONT__" in line or "__MODEL_URL__" in line]
assert not leftover, leftover
assert page.count("__ARCHIVE__") == 1, "src/page.html must contain __ARCHIVE__ exactly once"

# the preview: a fragment for the Artifact skeleton, with the model inline and the server's stand-in before the app
shim = (ROOT / "src/preview.js").read_text(encoding="utf-8")
assert "</script" not in shim.lower()
preview = page.replace("__ARCHIVE__", script_json(json.loads((ROOT / "src/seed.json").read_text(encoding="utf-8"))))
preview = cut(preview, '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                       '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n')
preview = cut(preview, f'<link rel="preload" href="{model_name}" as="fetch" crossorigin>\n')
preview = cut(preview, "</head>\n<body>\n")
preview = cut(preview, "</body>\n</html>\n")
preview = preview.replace('<script id="ca-app">',
                          '<script type="application/octet-stream" id="ca-model">' + base64.b64encode(model).decode() + "</script>\n"
                          '<script id="ca-preview">\n' + shim + "</script>\n"
                          '<script id="ca-app">', 1)
assert preview.startswith("<title>")

DIST.mkdir(exist_ok=True)
for old in [*DIST.glob("chalice.*.glb"), *DIST.glob("chalice-archive*.html")]:
    old.unlink()
(DIST / "index.html").write_text(page, encoding="utf-8")
(DIST / model_name).write_bytes(model)
(DIST / "preview.html").write_text(preview, encoding="utf-8")
print(f"built {DIST / 'index.html'} ({len(page.encode()) / 1024:.0f} KB), {model_name} ({len(model) / 1024:.0f} KB) "
      f"and preview.html ({len(preview.encode()) / 1024:.0f} KB)")
