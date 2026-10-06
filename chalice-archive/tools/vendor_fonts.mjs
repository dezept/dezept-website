#!/usr/bin/env node
/* Copies the page's fonts into assets/fonts/, so the site serves them itself and no visitor's browser asks Google (or
   anyone else) for anything: Cinzel (500 and 700), IM Fell English (roman and italic) and IM Fell English SC, all
   under the SIL Open Font License, whose text goes along as LICENSE-<family>.txt.

     cd tools && npm install && node vendor_fonts.mjs

   The fonts come from the Fontsource packages (Google Fonts' own files), pinned exactly in package.json, and
   package-lock.json holds their sha512, which npm checks on install. Only the WOFF2 files are kept: every browser the
   page supports reads them. assets/fonts/fonts.css holds their @font-face rules, with each file's unicode-range;
   build.py names each file by its hash and puts the rules into the page's own style block. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "assets", "fonts");
// each package, and the stylesheets of the faces the page uses (Fontsource has one per weight and style)
const FONTS = [
  ["cinzel", ["500.css", "700.css"]],
  ["im-fell-english", ["400.css", "400-italic.css"]],
  ["im-fell-english-sc", ["400.css"]],
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const rules = [];
for (const [name, sheets] of FONTS) {
  const dir = path.join(HERE, "node_modules", "@fontsource", name);
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const sheet of sheets) {
    const css = fs.readFileSync(path.join(dir, sheet), "utf8");
    for (const [, body] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const file = (body.match(/url\(\.\/files\/([a-z0-9-]+\.woff2)\)/) || [])[1];
      if (!file) throw new Error(`no WOFF2 file in a rule of @fontsource/${name}/${sheet}`);
      fs.copyFileSync(path.join(dir, "files", file), path.join(OUT, file));
      // the same rule, with the WOFF2 file alone, by its plain name
      const kept = body.trim().split(/;\s*/).filter(Boolean).map((d) => (/^src:/.test(d) ? `src: url(${file}) format('woff2')` : d));
      rules.push(`/* ${file}, from @fontsource/${name} ${version} */\n@font-face {\n  ${kept.join(";\n  ")};\n}`);
    }
  }
  fs.copyFileSync(path.join(dir, "LICENSE"), path.join(OUT, `LICENSE-${name}.txt`));
}
fs.writeFileSync(path.join(OUT, "fonts.css"), `/* The page's fonts, written by tools/vendor_fonts.mjs. Do not edit. */\n${rules.join("\n")}\n`);
console.log(`wrote ${rules.length} @font-face rules and their files to ${path.relative(process.cwd(), OUT)}`);
