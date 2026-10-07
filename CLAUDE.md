# dezept-website

## chalice-archive/

A one-page WoW RP site for a Dracthyr character, the owner's own. It is self-hosted on the owner's VPS: Cloudflare, then Caddy, then `chalice-archive/server/server.mjs`.

- Read `chalice-archive/HANDOVER.md` before changing anything.
- `hosting/README.md` covers the VPS.

### After every change to the page, publish the preview

The owner checks changes on the claude.ai Artifact before deploying them, so keep it current:

1. `cd chalice-archive && python3 build.py`. This writes `dist/index.html` (the real site) and `dist/preview.html` (the preview).
2. Run the smoke test, and make sure every check passes: `cd chalice-archive/tools && npm install && node smoke.js`. Set `CHROME=<path to chrome>` if Playwright has no browser of its own.
3. Publish `chalice-archive/dist/preview.html` to the existing Artifact, updating it in place: https://claude.ai/artifact/UFSgUToU7a4ZhuMdXe6ZWh.
   - Use the Artifact tool with `url` set to that link.
   - In a new conversation, read the artifact first.
   - Never publish the preview as a new artifact.
4. Give the owner the link, then commit and push the source. `dist/preview.html` is git-ignored.

### What the Artifact is, and isn't

The Artifact is only a preview.

- The viewer allows no network requests, so `src/preview.js` stands in for the server.
- In the preview, the word is `preview` and changes vanish on reload.
- The real records and the real word live only on the VPS. Never put either into the Artifact.
- Never bring back the old way of saving by republishing the Artifact.

## hosting/ and friends' sites

The VPS hosts several sites. Each is a folder in `/srv/sites`, put online with `sudo sites link <folder> <domain>` (`hosting/sites.mjs`).

- `hosting/README.md` covers the VPS and the `sites` command. Read it before changing anything in `hosting/`.
- A friend's site is a whole copy of `chalice-archive/` in a folder of its own beside it, changed freely for them. `hosting/README.md` ("Making a site") says what in the copy is the owner's, and what the hosting needs kept.
- The Artifact above is chalice-archive's preview, the owner's alone. Never publish a friend's site to it.
