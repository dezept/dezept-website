#!/usr/bin/env node
/* Renders the example plates shown only in the claude.ai preview (assets/examples/*.jpg, listed in
   src/preview-examples.json): studies of the construct on its dark stage, drawn by the page itself from the game's
   model, at a few shapes so the Art chapter can be judged with portrait, landscape and square images.

    python3 build.py && cd tools && npm install && node example_plates.js && cd .. && python3 build.py

Environment: CHROME (path to Chromium), CHROME_ARGS, HTTPS_PROXY (for three.js from jsDelivr), as for smoke.js.
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'examples');
const PLATES = [
  // file, viewport, where the pointer rests as a share of the viewport (the gem turns to it), or a scan in progress
  { file: 'facing.jpg', width: 960, height: 1200, aim: [0.5, 0.62] },
  { file: 'turning.jpg', width: 1500, height: 1000, aim: [0.86, 0.3] },
  { file: 'scan.jpg', width: 1100, height: 1100, scan: true },
  { file: 'below.jpg', width: 900, height: 1300, aim: [0.3, 0.95] },
];

(async () => {
  const page0 = fs.readFileSync(path.join(ROOT, 'dist', 'preview.html'), 'utf8');
  const html = '<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">' +
    '<style>body{margin:0}.core{--size:min(84vmin,980px)!important}</style></head><body>\n' + page0 + '</body></html>';
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'].concat((process.env.CHROME_ARGS || '').split(' ').filter(Boolean)),
  });
  fs.mkdirSync(OUT, { recursive: true });
  try {
    for (const p of PLATES) {
      const page = await (await browser.newContext({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: 1 })).newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForSelector('.core.is-3d', { timeout: 60000 });
      if (p.scan) {
        await page.mouse.move(p.width / 2, p.height * 0.7);
        await page.waitForTimeout(2500);
        await page.focus('#construct');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(820);
      } else {
        await page.mouse.move(p.width * p.aim[0], p.height * p.aim[1], { steps: 8 });
        await page.waitForTimeout(3000);
      }
      await page.screenshot({ path: path.join(OUT, p.file), type: 'jpeg', quality: 84 });
      console.log('wrote', path.join(OUT, p.file));
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
})();
