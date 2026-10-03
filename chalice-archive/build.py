#!/usr/bin/env python3
"""Build the Chalice Archive page.

    python3 build.py

Writes:
  dist/chalice-archive.html             page body, the file published as the claude.ai Artifact
  dist/chalice-archive.standalone.html  same page wrapped in the Artifact skeleton; opens directly in a browser

Placeholders in src/page.html:
  __FRONT__    front cutout (assets/front.webp) as a data URI, shown until the 3D model has drawn
  __MODEL__    the construct's 3D model (assets/model/chalice.glb, made by tools/m2_to_glb.py), base64
  __DATA__     src/seed.json, escaped for a <script> block
  "__RESET__"  the claude.ai skeleton reset CSS (src/skeleton-reset.css), as a JS string literal
"""
import base64
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent


def data_uri(path: pathlib.Path) -> str:
    return "data:image/webp;base64," + base64.b64encode(path.read_bytes()).decode()


def script_json(obj) -> str:
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return s.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


reset = (ROOT / "src/skeleton-reset.css").read_text(encoding="utf-8").strip()
page = (ROOT / "src/page.html").read_text(encoding="utf-8")
page = page.replace("__FRONT__", data_uri(ROOT / "assets/front.webp"))
page = page.replace("__MODEL__", base64.b64encode((ROOT / "assets/model/chalice.glb").read_bytes()).decode())
page = page.replace("__DATA__", script_json(json.loads((ROOT / "src/seed.json").read_text(encoding="utf-8"))))
page = page.replace('"__RESET__"', json.dumps(reset))
leftover = [line[:80] for line in page.splitlines() if any(k in line for k in ("__FRONT__", "__MODEL__", "__DATA__", "__RESET__"))]
assert not leftover, leftover

dist = ROOT / "dist"
dist.mkdir(exist_ok=True)
(dist / "chalice-archive.html").write_text(page, encoding="utf-8")

skeleton = ('<!doctype html><html><head><meta charset=utf8><meta name=viewport '
            'content="width=device-width,initial-scale=1,viewport-fit=cover"><style>' + reset +
            '</style></head><body>\n')
(dist / "chalice-archive.standalone.html").write_text(skeleton + page + "</body></html>", encoding="utf-8")
print("built", dist / "chalice-archive.html", f"{len(page.encode()) / 1024:.0f} KB")
