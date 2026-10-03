#!/usr/bin/env python3
"""Build the Chalice Archive site.

    python3 build.py

Writes dist/, which server/server.mjs serves:
  dist/index.html               the page; the server fills in __ARCHIVE__ with the records on every request
  dist/chalice.<hash>.glb       the construct's 3D model (assets/model/chalice.glb, made by tools/m2_to_glb.py),
                                named by its SHA-256 so browsers and Cloudflare can cache it for good

Placeholders in src/page.html:
  __FRONT__      front cutout (assets/front.webp) as a data URI, shown until the 3D model has drawn
  __MODEL_URL__  the model's file name
  __ARCHIVE__    left for the server
"""
import base64
import hashlib
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / "dist"

page = (ROOT / "src/page.html").read_text(encoding="utf-8")
model = (ROOT / "assets/model/chalice.glb").read_bytes()
model_name = f"chalice.{hashlib.sha256(model).hexdigest()[:12]}.glb"

page = page.replace("__FRONT__", "data:image/webp;base64," + base64.b64encode((ROOT / "assets/front.webp").read_bytes()).decode())
page = page.replace("__MODEL_URL__", model_name)
leftover = [line.strip()[:80] for line in page.splitlines() if "__FRONT__" in line or "__MODEL_URL__" in line]
assert not leftover, leftover
assert page.count("__ARCHIVE__") == 1, "src/page.html must contain __ARCHIVE__ exactly once"

DIST.mkdir(exist_ok=True)
for old in [*DIST.glob("chalice.*.glb"), *DIST.glob("chalice-archive*.html")]:
    old.unlink()
(DIST / "index.html").write_text(page, encoding="utf-8")
(DIST / model_name).write_bytes(model)
print(f"built {DIST / 'index.html'} ({len(page.encode()) / 1024:.0f} KB) and {model_name} ({len(model) / 1024:.0f} KB)")
