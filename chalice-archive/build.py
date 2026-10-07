#!/usr/bin/env python3
"""Build the Chalice Archive site.

    python3 build.py

Writes dist/:
  dist/index.html            the page server/server.mjs serves; it fills in __ARCHIVE__ with the records on each request.
                             Its style and script carry none of src/page.html's comments (strip_comments, below)
  dist/<model>.<hash>.glb    the centerpiece's 3D model, if the site has one (assets/model/<model>.glb; the chalice's
                             was made by tools/m2_to_glb.py), named by its SHA-256 so browsers and Cloudflare can
                             cache it for good
  dist/three.<hash>.js       three.js with its GLTFLoader (assets/vendor/three.module.js, made by tools/vendor_three.mjs),
                             served by the site itself, so the page runs no script from a CDN; named by its SHA-256 too.
                             Only with a model
  dist/<font>.<hash>.woff2   the fonts (assets/fonts/, copied by tools/vendor_fonts.mjs), served by the site itself too, so
                             no visitor's browser asks anyone else for anything; each named by its SHA-256

The centerpiece on the landing is optional, and follows the files in assets/:
  assets/front.webp and one assets/model/*.glb
                 the cutout shows at once, and the model is drawn over it once loaded (the chalice: this site)
  assets/front.webp alone
                 the cutout alone; its gem (.gem in the style, placed for the chalice) still wakes it
  neither        no centerpiece: the construct is left out (hidden), and the landing shows the archive's name and
                 the four chapters straight away. No model or three.js is built or served.
A model without a cutout is refused.

Placeholders in src/page.html:
  __FRONT__      front cutout (assets/front.webp) as a data URI, shown until the 3D model has drawn
  __MODEL_URL__  the model's file name ("" without one)
  __THREE_URL__  three.js: dist/three.<hash>.js ("" without a model)
  __GLTF_URL__   its GLTFLoader: the same file ("" without a model)
  __FONTS__      the fonts' @font-face rules (assets/fonts/fonts.css, with the hashed names), in the page's style block
  __ARCHIVE__    left for the server
"""
import base64
import hashlib
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / "dist"


def cut(text: str, part: str) -> str:
    assert text.count(part) == 1, f"expected exactly one {part[:60]!r}"
    return text.replace(part, "")


# A / after one of these starts a regular expression; after anything else (a name, a number, ")" or "]") it divides
REGEX_AFTER = set("(,=:[!&|?{};+-*%<>~^")
REGEX_AFTER_WORDS = {"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"}


def strip_comments(src: str, js: bool) -> str:
    """src without its comments: /* … */ in CSS, and // … as well in JavaScript. Strings, template literals and regular
    expressions are read through, so a // or /* inside one stays. A comment alone on its line takes the line with it."""
    out, i, n, last = [], 0, len(src), ""

    def line_start() -> bool:  # drops the space before a comment; true if nothing else is on its line
        while out and out[-1] in " \t":
            out.pop()
        return not out or out[-1] == "\n"

    while i < n:
        c = src[i]
        if c in "\"'" or (js and c == "`"):
            j = i + 1
            while src[j] != c:
                if src[j] == "\\":
                    j += 1
                elif src[j] == "\n" and c != "`":
                    raise ValueError(f"a string does not end on its line: {src[i:i + 60]!r}")
                elif c == "`" and src.startswith("${", j):
                    raise ValueError("strip_comments cannot read a template literal with ${…} in it")
                j += 1
            out.extend(src[i:j + 1])
            last, i = c, j + 1
        elif src.startswith("/*", i) or (js and src.startswith("//", i)):
            block = src[i + 1] == "*"
            if block:
                j = src.index("*/", i + 2) + 2
            else:  # a line comment ends before its newline
                j = src.find("\n", i)
                j = n if j < 0 else j
            alone = line_start()
            k = j
            while k < n and src[k] in " \t":
                k += 1
            if alone and (k == n or src[k] == "\n"):
                i = k + 1  # the comment's line goes with it
            elif alone:
                i = k
            else:
                if block:
                    out.append("\n" if "\n" in src[i:j] else " ")  # a line break can end a statement
                i = j
        elif js and c == "/" and (last == "" or last in REGEX_AFTER or last in REGEX_AFTER_WORDS):
            j, in_class = i + 1, False
            while in_class or src[j] != "/":
                if src[j] == "\\":
                    j += 1
                elif src[j] == "\n":
                    raise ValueError(f"a regular expression does not end on its line: {src[i:i + 60]!r}")
                elif src[j] in "[]":
                    in_class = src[j] == "["
                j += 1
            j += 1
            while j < n and src[j].isalpha():  # its flags
                j += 1
            out.extend(src[i:j])
            last, i = "/regex/", j
        elif js and (c.isalnum() or c in "_$"):
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            out.extend(src[i:j])
            last, i = src[i:j], j
        else:
            out.append(c)
            if not c.isspace():
                last = c
            i += 1
    return "".join(out)


def strip_page_comments(html: str) -> str:
    """The page's own style and script without their comments, which stay in src/page.html for whoever works on it"""
    for opening, closing, js in (('<style id="ca-style">', "</style>", False), ('<script id="ca-app">', "</script>", True)):
        start = html.index(opening) + len(opening)
        end = html.index(closing, start)
        html = html[:start] + strip_comments(html[start:end], js) + html[end:]
    assert "<!--" not in html, "the page has an HTML comment; strip_page_comments does not take those out"
    return html


page = strip_page_comments((ROOT / "src/page.html").read_text(encoding="utf-8"))
# The centerpiece (see the top): a cutout, and maybe a model drawn over it
front_path = ROOT / "assets/front.webp"
models = sorted((ROOT / "assets/model").glob("*.glb")) if (ROOT / "assets/model").is_dir() else []
assert len(models) <= 1, f"assets/model may hold one model, not {len(models)}"
assert front_path.exists() or not models, "a model needs its cutout, assets/front.webp, shown until the model is drawn"
model = models[0].read_bytes() if models else b""
model_stem = (re.sub(r"[^a-z0-9_-]", "", models[0].stem.lower()) or "model") if models else ""
model_name = f"{model_stem}.{hashlib.sha256(model).hexdigest()[:12]}.glb" if models else ""
three = (ROOT / "assets/vendor/three.module.js").read_bytes()
three_name = f"three.{hashlib.sha256(three).hexdigest()[:12]}.js"
three_version = re.match(rb"/\* three\.js (\d+\.\d+\.\d+) ", three).group(1).decode()  # from the bundle's banner
# The site serves its fonts itself, each named by its hash
fonts = {}  # hashed name -> bytes


def hashed_font(m: re.Match) -> str:
    data = (ROOT / "assets/fonts" / m.group(1)).read_bytes()
    name = f"{m.group(1).removesuffix('.woff2')}.{hashlib.sha256(data).hexdigest()[:12]}.woff2"
    fonts[name] = data
    return f"url({name})"


font_faces = re.sub(r"url\(([a-z0-9-]+\.woff2)\)", hashed_font, strip_comments((ROOT / "assets/fonts/fonts.css").read_text(encoding="utf-8"), False)).strip("\n")
assert len(fonts) == 7, f"expected 7 font files in assets/fonts/fonts.css, found {len(fonts)}; run tools/vendor_fonts.mjs"

if front_path.exists():
    page = page.replace("__FRONT__", "data:image/webp;base64," + base64.b64encode(front_path.read_bytes()).decode())
else:  # no centerpiece: the construct stays in the page, hidden, so the script finds it and knows
    for part, bare in (('<button class="construct" id="construct" ', '<button class="construct" id="construct" hidden '),
                       ('<span class="pool" aria-hidden="true">', '<span class="pool" aria-hidden="true" hidden>'),
                       (' src="__FRONT__"', "")):
        assert page.count(part) == 1, f"expected exactly one {part!r} in src/page.html"
        page = page.replace(part, bare)
if models:
    page = page.replace("__MODEL_URL__", model_name)
else:  # nothing to preload, and no three.js to load
    page = cut(page, '<link rel="preload" href="__MODEL_URL__" as="fetch" crossorigin>\n')
    page = cut(page, '<link rel="modulepreload" href="__THREE_URL__">\n')
    page = page.replace("__MODEL_URL__", "").replace("__THREE_URL__", "").replace("__GLTF_URL__", "")
assert page.count("__ARCHIVE__") == 1, "src/page.html must contain __ARCHIVE__ exactly once"

# one file holds both; "./" because import() takes a bare name for a package, not a file
page = page.replace("__THREE_URL__", "./" + three_name).replace("__GLTF_URL__", "./" + three_name)
page = page.replace("__FONTS__", font_faces)
leftover = [line.strip()[:80] for line in page.splitlines() if re.search(r"__(FRONT|MODEL_URL|THREE_URL|GLTF_URL|FONTS)__", line)]
assert not leftover, leftover
assert "cdn.jsdelivr.net" not in page, "the site's page must load no script from a CDN"
assert not re.search(r"fonts\.(googleapis|gstatic)\.com", page), "the site's page must load its fonts from the site"

DIST.mkdir(exist_ok=True)
for old in [*DIST.glob("*.glb"), *DIST.glob("three.*.js"), *DIST.glob("*.woff2"), *DIST.glob("chalice-archive*.html"), *DIST.glob("preview.html")]:
    old.unlink()
(DIST / "index.html").write_text(page, encoding="utf-8")
if models:
    (DIST / model_name).write_bytes(model)
    (DIST / three_name).write_bytes(three)
for name, data in fonts.items():
    (DIST / name).write_bytes(data)
centerpiece = (f"{model_name} ({len(model) / 1024:.0f} KB), {three_name} (three.js {three_version}, {len(three) / 1024:.0f} KB)" if models
               else "the cutout alone as the centerpiece" if front_path.exists() else "no centerpiece")
print(f"built {DIST / 'index.html'} ({len(page.encode()) / 1024:.0f} KB), {centerpiece}, {len(fonts)} fonts ({sum(map(len, fonts.values())) / 1024:.0f} KB)")
