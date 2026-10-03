#!/usr/bin/env node
/* Smoke test for dist/chalice-archive.standalone.html in headless Chromium.

    cd tools && npm install && node smoke.js

Environment:
  CHROME       path to a Chromium/Chrome binary (default: Playwright's own install)
  CHROME_ARGS  extra browser flags, space-separated
  HTTPS_PROXY  used for the CDN requests when set

Checks:
  1. Under a CSP shaped like the claude.ai Artifact viewer's (scripts only from the allowed CDNs, images only
     from data:, no fetch), the page swaps the cutout for the 3D model, and the archive shows its accessions and index.
     A click on the construct's body does nothing; pointing at the gem shows the hand cursor, and clicking
     the gem opens the archive.
  2. With a mocked window.claude, inscribing a record publishes a page that keeps the skeleton and the model
     block, boots again in 3D with the new record, and a second save matches the first apart from its data.
Screenshots go to tools/.smoke/.
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, '.smoke');
const CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com " +
  "https://cdn.tailwindcss.com https://code.jquery.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
  "img-src data:; connect-src 'none'";
const SKELETON = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>';
const MODEL_BLOCK = /<script type="application\/octet-stream" id="ca-model">([A-Za-z0-9+/=]+)<\/script>/;
const DATA_BLOCK = /<script type="application\/json" id="ca-data">[\s\S]*?<\/script>/;

let served = fs.readFileSync(path.join(ROOT, 'dist/chalice-archive.standalone.html'), 'utf8');
const originalModel = (served.match(MODEL_BLOCK) || [])[1];
const failures = [];
function check(ok, what) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(served.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`));
});

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'].concat((process.env.CHROME_ARGS || '').split(' ').filter(Boolean)),
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const published = [];
    await ctx.exposeBinding('__publish', (_, html) => { published.push(html); return {}; });
    await ctx.addInitScript(() => {
      if (!sessionStorage.getItem('smoke-claude')) return;
      window.claude = {
        use: (name) => Promise.resolve(name === 'artifact' ? { publish: (html) => window.__publish(html) }
          : name === 'user' ? { canEdit: () => Promise.resolve(true), isOwner: () => Promise.resolve(true) } : null),
      };
    });

    // 1. read-only view under the CSP
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    await page.goto(url);
    check(await page.waitForSelector('.core.is-3d', { timeout: 30000 }).then(() => true, () => false), '3D model replaces the cutout under the Artifact CSP');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, 'landing.png') });
    const box = await (await page.$('#construct')).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.click(cx, cy - box.height * .3); // the frame between the horns, above the gem
    await page.waitForTimeout(2500);
    check(!(await page.$('#archive[open]')), 'a click on the construct away from the gem does not scan');
    let gem = null; // walk down the centre line until the pointer is over the gem
    for (let dy = 0; dy <= box.height * .5 && !gem; dy += 12) {
      await page.mouse.move(cx, cy + dy);
      await page.waitForTimeout(500);
      if (await page.$('#stage.on-gem')) gem = [cx, cy + dy];
    }
    check(!!gem, 'pointing at the gem shows the hand cursor');
    if (gem) await page.mouse.click(gem[0], gem[1]);
    await page.waitForSelector('#archive[open]', { timeout: 5000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, 'archive.png') });
    check(await page.$$eval('#recent .rec-btn', (n) => n.length) > 0 && await page.$$eval('#index .domain', (n) => n.length) > 0, 'the archive shows recent accessions and the index');
    check(await page.$('#btn-inscribe[hidden]') !== null, 'no owner controls without window.claude');
    check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await page.close();

    // 2. two saves through the self-republishing path
    for (let round = 1; round <= 2; round++) {
      const p = await ctx.newPage();
      await p.goto(url);
      await p.evaluate(() => sessionStorage.setItem('smoke-claude', '1'));
      await p.reload();
      await p.waitForSelector('.core.is-3d', { timeout: 30000 });
      await p.focus('#construct');
      await p.keyboard.press('Enter'); // keyboard activation always scans
      await p.waitForSelector('#btn-inscribe:not([hidden])', { timeout: 10000 });
      await p.click('#btn-inscribe');
      await p.fill('#f-title', `Smoke record ${round}`);
      await p.click('#f-submit');
      await p.waitForFunction((n) => document.querySelector('#toast') && !document.querySelector('#toast').hidden, round, { timeout: 5000 });
      const html = published[round - 1] || '';
      check(html.startsWith(SKELETON) && html.endsWith('</body></html>'), `save ${round}: published page keeps the Artifact skeleton`);
      check((html.match(MODEL_BLOCK) || [])[1] === originalModel, `save ${round}: model block survives unchanged`);
      served = html;
      await p.reload();
      check(await p.waitForSelector('.core.is-3d', { timeout: 30000 }).then(() => true, () => false), `save ${round}: saved page boots in 3D`);
      const titles = await p.evaluate(() => JSON.parse(document.getElementById('ca-data').textContent).records.map((r) => r.title));
      check(titles.includes(`Smoke record ${round}`), `save ${round}: saved page holds the new record`);
      await p.close();
    }
    check(published[0].replace(DATA_BLOCK, '') === published[1].replace(DATA_BLOCK, ''), 'a re-saved page differs from the first save only in its data');
  } catch (e) {
    check(false, `run completed (${e.message})`);
  } finally {
    await browser.close();
    server.close();
    console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
    process.exitCode = failures.length ? 1 : 0;
  }
});
