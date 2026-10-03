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
  2. With window.claude mocked as the owner: the editing tools stay hidden until the keeper's word is set or
     spoken; setting it publishes only a salted PBKDF2 hash; a wrong word is refused; saves keep the skeleton,
     the model and the seal, and a second save matches the first apart from its data.
  3. A visitor who knows the word still gets no editing tools.
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
    check(await page.$('#recent-title') !== null && await page.$('#index-title') !== null, 'the archive shows its two pages: recent accessions and the index');
    check(await page.$('#btn-inscribe[hidden]') !== null, 'no editing tools without window.claude');
    check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await page.close();

    // 2. the keeper's seal, and saves through the self-republishing path (window.claude mocked as the owner)
    const WORD = 'a long smoke-test passphrase';
    const SEAL = /"seal":\{"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":"[A-Za-z0-9+/=]{24}","hash":"[A-Za-z0-9+/=]{44}"\}/;
    const waitPublished = (n) => (async () => { for (let i = 0; i < 100 && published.length < n; i++) await new Promise((r) => setTimeout(r, 100)); })();
    async function ownerTab() {
      const t = await ctx.newPage();
      await t.goto(url);
      await t.evaluate(() => sessionStorage.setItem('smoke-claude', '1'));
      await t.reload();
      await t.waitForSelector('.core.is-3d', { timeout: 30000 });
      await t.focus('#construct');
      await t.keyboard.press('Enter'); // keyboard activation always scans
      await t.waitForSelector('#archive[open]', { timeout: 5000 });
      await t.waitForTimeout(1200); // claude.use resolves
      return t;
    }
    async function inscribe(t, title, n) {
      await t.click('#btn-inscribe');
      await t.fill('#f-title', title);
      await t.click('#f-submit');
      await waitPublished(n);
      const html = published[n - 1] || '';
      check(html.startsWith(SKELETON) && html.endsWith('</body></html>') && (html.match(MODEL_BLOCK) || [])[1] === originalModel,
        `save ${n}: the published page keeps the Artifact skeleton and the model`);
      return html;
    }

    let t = await ownerTab();
    check(await t.$('#btn-inscribe[hidden]') !== null, 'the owner sees no editing tools while the archive is sealed');
    await t.click('#clasp');
    check(await t.$('#seal-f2:not([hidden])') !== null, 'with no word set yet, the clasp asks the owner to choose one');
    await t.fill('#seal-word', WORD);
    await t.fill('#seal-again', WORD + '!');
    await t.click('#seal-go');
    check((await t.textContent('#seal-error')).includes("don't match"), 'mismatched words are refused');
    await t.fill('#seal-again', WORD);
    await t.click('#seal-go');
    await waitPublished(1);
    const sealed = published[0] || '';
    const sealJson = (sealed.match(SEAL) || [''])[0];
    check(!!sealJson, 'choosing the word publishes a salted PBKDF2-SHA256 hash (600,000 rounds)');
    check(!sealed.includes(WORD), 'the word itself appears nowhere in the published page');
    served = sealed;
    await t.reload(); // the viewer reloads every open view to the new version
    check(await t.waitForSelector('#btn-inscribe:not([hidden])', { timeout: 15000 }).then(() => true, () => false), "after sealing, the owner's tab stays unsealed");
    served = await inscribe(t, 'Smoke record 1', 2);
    check(served.includes(sealJson), 'saving a record keeps the seal');
    await t.close();

    t = await ownerTab(); // a new tab starts sealed again
    check(await t.$('#btn-inscribe[hidden]') !== null, 'a new tab starts sealed, even for the owner');
    check(await t.evaluate(() => JSON.parse(document.getElementById('ca-data').textContent).records.some((r) => r.title === 'Smoke record 1')), 'the saved record is in the reloaded page');
    await t.click('#clasp');
    await t.fill('#seal-word', 'not the word at all');
    await t.click('#seal-go');
    await t.waitForSelector('#seal-error:not([hidden])', { timeout: 15000 });
    check((await t.textContent('#seal-error')).includes('does not yield') && await t.$('#btn-inscribe[hidden]') !== null, 'a wrong word is refused and the tools stay hidden');
    await t.waitForTimeout(1100); // the first miss costs a second
    await t.fill('#seal-word', WORD);
    await t.click('#seal-go');
    check(await t.waitForSelector('#btn-inscribe:not([hidden])', { timeout: 15000 }).then(() => true, () => false), 'the right word shows the editing tools');
    served = await inscribe(t, 'Smoke record 2', 3);
    await t.close();
    check(published[1].replace(DATA_BLOCK, '') === published[2].replace(DATA_BLOCK, ''), 'a re-saved page differs from the first save only in its data');

    // 3. a visitor who knows the word still cannot write: claude.ai decides that
    const v = await ctx.newPage();
    await v.goto(url);
    await v.waitForSelector('.core.is-3d', { timeout: 30000 });
    await v.focus('#construct');
    await v.keyboard.press('Enter');
    await v.waitForSelector('#archive[open]', { timeout: 5000 });
    await v.click('#clasp');
    await v.fill('#seal-word', WORD);
    await v.click('#seal-go');
    await v.waitForSelector('#seal-error:not([hidden])', { timeout: 15000 });
    check((await v.textContent('#seal-error')).includes("only the keeper's claude.ai account") && await v.$('#btn-inscribe[hidden]') !== null,
      'a visitor with the right word gets no editing tools');
    await v.close();
  } catch (e) {
    check(false, `run completed (${e.message})`);
  } finally {
    await browser.close();
    server.close();
    console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
    process.exitCode = failures.length ? 1 : 0;
  }
});
