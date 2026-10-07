# dezept-website

## chalice-archive/

A one-page WoW RP site for a Dracthyr character, the owner's own. It is self-hosted on the owner's VPS: Caddy (with Cloudflare in front, or not), then `chalice-archive/server/server.mjs`.

- Read `chalice-archive/HANDOVER.md` before changing anything.
- `hosting/README.md` covers the VPS.

### After every change to the page

1. `cd chalice-archive && python3 build.py`. This writes `dist/index.html`, the page the server serves.
2. Run the smoke test, and make sure every check passes: `cd chalice-archive/tools && npm install && node smoke.js`. Set `CHROME=<path to chrome>` if Playwright has no browser of its own.
3. Commit and push the source with `dist/`.

There is no preview any more: the site is deployed, and the owner checks changes there. Don't bring back a claude.ai Artifact preview, a stand-in server or example content.

### Interface text

Anyone can read every string in the served page, so keep the text in it terse: labels, button names, short error messages ("Title required.", "Couldn't read the video."). No help paragraphs, no explanatory placeholders, no sentences describing what the site does behind the scenes (encryption, who can see what, where a setting lives in Cloudflare). Explanations belong in `HANDOVER.md` or in comments, which `build.py` strips from the served page. The few hints on the page ("Unfilled fields won't show up", the TRP3 formatting note on the About form, "Private (Only you can read this)") are the owner's own wording; add others only when the owner asks.

## hosting/ and friends' sites

The VPS hosts several sites. Each is a folder in `/srv/sites`, put online with `sudo sites link <folder> <domain>` (`hosting/sites.mjs`).

- `hosting/README.md` covers the VPS and the `sites` command. Read it before changing anything in `hosting/`.
- A friend's site is a whole copy of `chalice-archive/` in a folder of its own beside it, changed freely for them. `hosting/README.md` ("Making a site") says what in the copy is the owner's, and what the hosting needs kept.
