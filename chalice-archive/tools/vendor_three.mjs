#!/usr/bin/env node
/* Bundles three.js and its GLTFLoader into assets/vendor/three.module.js, the one script the page loads besides its
   own. The site serves it itself (build.py names it by its hash), so no visitor's browser runs code from a CDN, and the
   page's Content-Security-Policy allows no script from anywhere else.

     cd tools && npm install && node vendor_three.mjs

   Both inputs are pinned exactly in package.json, and package-lock.json holds their sha512, which npm checks on
   install: three (the npm package, unchanged) and esbuild (which bundles and minifies it). The same versions give the
   same file, byte for byte. To move to a newer three.js, change its version in package.json, run npm install and this
   tool, then python3 build.py and the smoke test. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "assets", "vendor", "three.module.js");
const { version } = JSON.parse(fs.readFileSync(path.join(HERE, "node_modules", "three", "package.json"), "utf8")); // not in its exports

// One module: everything three.js exports (the page uses it as a namespace), plus the GLTFLoader built on the same copy
const result = await esbuild.build({
  stdin: {
    contents: 'export * from "three";\nexport { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\n',
    resolveDir: HERE,
    sourcefile: "three-with-gltf-loader.js",
  },
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2020",
  legalComments: "eof", // three.js's MIT licence notice stays in the file
  banner: { js: `/* three.js ${version} (https://threejs.org, MIT licence) with its GLTFLoader, bundled by tools/vendor_three.mjs with esbuild ${esbuild.version}. Do not edit. */` },
  write: false,
  logLevel: "warning",
});
const code = result.outputFiles[0].contents;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, code);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (three.js ${version}, ${Math.round(code.length / 1024)} KB)`);
