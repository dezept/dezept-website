#!/usr/bin/env python3
"""Build the Chalice Archive site.

    python3 build.py

Writes dist/:
  dist/index.html            the page server/server.mjs serves; it fills in __ARCHIVE__ with the records on each request
  dist/chalice.<hash>.glb    the construct's 3D model (assets/model/chalice.glb, made by tools/m2_to_glb.py),
                             named by its SHA-256 so browsers and Cloudflare can cache it for good
  dist/preview.html          the preview published as the claude.ai Artifact (git-ignored). The Artifact viewer wraps
                             the page in its own <html>/<head> and allows no network requests, so this build is a
                             page fragment with src/seed.json as its records, plus the example About page, forms and
                             art from src/preview-examples.json (their images, GIF and video in #ca-files as data: URIs), the model
                             embedded as base64 and src/preview.js standing in for the server.

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


def jpeg_size(b: bytes) -> tuple[int, int]:
    """Width and height from a JPEG's frame header."""
    i = 2
    while i + 9 < len(b):
        assert b[i] == 0xFF, "not a JPEG"
        m = b[i + 1]
        if m == 0xFF:
            i += 1
        elif m == 0x01 or 0xD0 <= m <= 0xD8:
            i += 2
        elif 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            return int.from_bytes(b[i + 7:i + 9], "big"), int.from_bytes(b[i + 5:i + 7], "big")
        else:
            i += 2 + int.from_bytes(b[i + 2:i + 4], "big")
    raise ValueError("no frame header")


MEDIA = {".jpg": ("jpg", "image/jpeg"), ".gif": ("gif", "image/gif"), ".webm": ("webm", "video/webm"), ".mp4": ("mp4", "video/mp4")}


def preview_archive() -> tuple[dict, dict, dict]:
    """src/seed.json with the preview's examples added, the examples' images, GIFs and videos by name, as data: URIs,
    and the example encounters' private sections, which the stand-in keeps apart from the archive as the server does."""
    archive = json.loads((ROOT / "src/seed.json").read_text(encoding="utf-8"))
    examples = json.loads((ROOT / "src/preview-examples.json").read_text(encoding="utf-8"))
    files, art = {}, []

    def embed(rel: str) -> tuple[str, bytes]:
        data = (ROOT / rel).read_bytes()
        ext, mime = MEDIA[pathlib.Path(rel).suffix]
        name = hashlib.sha256(data).hexdigest()[:32] + "." + ext  # named the way the server names uploads
        files[name] = f"data:{mime};base64," + base64.b64encode(data).decode()
        return name, data

    for n, ex in enumerate(examples["art"]):
        versions = []
        for v in ex["versions"]:
            file, data = embed(v["image"])
            thumb = embed(v["still"])[0] if "still" in v else file  # a GIF's or a video's still
            if file.endswith(".jpg"):
                width, height = jpeg_size(data)
            elif file.endswith(".gif"):
                width, height = int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")
            else:
                width, height = v["width"], v["height"]
            versions.append({"id": v["id"], "file": file, "thumb": thumb, "width": width, "height": height, "label": v["label"],
                             "mature": v["mature"], "loop": v.get("loop", False)})
        art.append({**ex, "versions": versions, "added": n, "example": True})
    archive["galleries"] = [{**g, "added": n, "example": True} for n, g in enumerate(examples["galleries"])]
    archive["art"] = art
    archive["about"] = examples["about"]
    archive["encounters"] = [{**e, "added": n, "example": True} for n, e in enumerate(examples["encounters"])]
    archive["records"] = [{**r, "added": n, "example": True} for n, r in enumerate(examples["records"])]
    return archive, files, examples["private"]


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
archive, files, private = preview_archive()
preview = page.replace("__ARCHIVE__", script_json(archive))
preview = cut(preview, '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                       '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n')
preview = cut(preview, f'<link rel="preload" href="{model_name}" as="fetch" crossorigin>\n')
preview = cut(preview, "</head>\n<body>\n")
preview = cut(preview, "</body>\n</html>\n")
preview = preview.replace('<script id="ca-app">',
                          '<script type="application/octet-stream" id="ca-model">' + base64.b64encode(model).decode() + "</script>\n"
                          '<script type="application/json" id="ca-files">' + script_json(files) + "</script>\n"
                          '<script type="application/json" id="ca-private">' + script_json(private) + "</script>\n"
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
