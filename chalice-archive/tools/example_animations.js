#!/usr/bin/env node
/* Renders the example animations shown only in the claude.ai preview (listed in src/preview-examples.json): an
   animated GIF of the construct turning after a cursor, and a WebM video of its gem drawing the light in, each with a
   still taken from it. The page draws them itself from the game's model, one frame at a time on a virtual clock, so
   slow software rendering still gives smooth motion. Needs ffmpeg (with libvpx-vp9).

    python3 build.py && cd tools && npm install && node example_animations.js && cd .. && python3 build.py

Environment: CHROME (path to Chromium), CHROME_ARGS, HTTPS_PROXY (for three.js from jsDelivr), as for smoke.js.
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'examples');
const CLIPS = [
  // the GIF: five seconds (the model's own hover takes five) while the pointer circles the construct
  { name: 'circling', width: 320, height: 320, fps: 8, seconds: 5, gif: true },
  // the video: the pointer comes to rest on the gem, then the gem draws the light in
  { name: 'drawing-in', width: 640, height: 400, fps: 24, seconds: 6, summonAt: 1.2 },
];

// The page's clock, animation frames and (once asked) timers, all driven from here
function virtualTime() {
  let now = 0;
  const frames = [], timers = [], realTimeout = window.setTimeout.bind(window);
  performance.now = () => now;
  window.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  window.cancelAnimationFrame = () => {};
  window.setTimeout = (fn, ms, ...args) => {
    if (!window.__virtualTimers) return realTimeout(fn, ms, ...args);
    timers.push({ at: now + (ms || 0), fn: () => fn(...args) });
    return 0;
  };
  window.__advance = (ms) => {
    now += ms;
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) if (t.at <= now) t.fn(); else timers.push(t);
    for (const cb of frames.splice(0)) cb(now);
  };
}

(async () => {
  const page0 = fs.readFileSync(path.join(ROOT, 'dist', 'preview.html'), 'utf8');
  const html = '<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">' +
    // the construct larger, the choices it projects left out, and it stays where it is when they would appear
    '<style>body{margin:0}.core{--size:min(80vmin,980px)!important}.hub{display:none!important}.stage.has-hub .core{translate:none!important}</style></head><body>\n' + page0 + '</body></html>';
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'].concat((process.env.CHROME_ARGS || '').split(' ').filter(Boolean)),
  });
  try {
    for (const c of CLIPS) {
      const ctx = await browser.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: 1 });
      await ctx.addInitScript(virtualTime);
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const frameMs = 1000 / c.fps;
      for (let i = 0; i < 600 && !(await page.$('.core.is-3d')); i++) { await page.evaluate((ms) => window.__advance(ms), frameMs); await page.waitForTimeout(50); }
      if (!(await page.$('.core.is-3d'))) throw new Error('the model did not load');
      const at = (t) => {
        if (!c.summonAt) return [c.width / 2 + Math.cos(t / c.seconds * 2 * Math.PI) * c.width * .42, c.height / 2 + Math.sin(t / c.seconds * 2 * Math.PI) * c.height * .36];
        const k = Math.min(1, t / c.summonAt); // from the corner to just below the centre, where the gem looks
        return [c.width * (.9 - .4 * k), c.height * (.85 - .2 * k)];
      };
      // one period first, so the pointer's smoothing and the drift have settled when the recording starts
      for (let t = -c.seconds; t < 0; t += 1 / c.fps) { const [x, y] = at(t); await page.mouse.move(x, y); await page.evaluate((ms) => window.__advance(ms), frameMs); }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chalice-' + c.name + '-'));
      const n = Math.round(c.fps * c.seconds);
      for (let f = 0; f < n; f++) {
        const t = f / c.fps;
        if (c.summonAt && Math.abs(t - c.summonAt) < .5 / c.fps) {
          // as the keyboard wakes it (a click without a pointer), but with no focus ring in the picture
          await page.evaluate(() => { window.__virtualTimers = true; document.getElementById('construct').click(); });
        }
        const [x, y] = at(t);
        await page.mouse.move(x, y);
        await page.evaluate((ms) => window.__advance(ms), frameMs);
        await page.screenshot({ path: path.join(dir, `f${String(f).padStart(4, '0')}.png`) });
      }
      const frames = path.join(dir, 'f%04d.png');
      const still = path.join(OUT, `${c.name}.jpg`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(dir, `f${String(Math.floor(n * .3)).padStart(4, '0')}.png`), '-q:v', '4', still]);
      if (c.gif) {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(c.fps), '-i', frames,
          '-vf', 'split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', path.join(OUT, `${c.name}.gif`)]);
      } else {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(c.fps), '-i', frames, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1',
          '-pix_fmt', 'yuv420p', '-an', path.join(OUT, `${c.name}.webm`)]);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('wrote', c.name, c.gif ? '.gif' : '.webm', 'and', path.basename(still));
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
})();
