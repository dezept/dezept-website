/* Preview stand-in for server/server.mjs. It goes only into dist/preview.html, the build published as the claude.ai
   Artifact so the owner can see changes before deploying them; build.py never puts it into dist/index.html.
   The Artifact viewer allows no network requests, so this answers the page's requests in memory: the model comes
   from #ca-model, the example art's images, GIFs and videos from #ca-files, and the API behaves like the real one,
   except that the word is "preview", every change, uploads included, is lost when the page reloads, and GIFs and
   videos are kept as they come (the server strips their metadata). The example
   encounters' private sections, and the example encounter only for the keeper, come from #ca-private and are kept
   apart from what visitors get, as the server keeps them; here they are only in memory, not encrypted. Nothing is
   counted: the statistics are made-up example numbers, the same on every load, for the example art and the rest. */
(function () {
  "use strict";
  var MiB = 1024 * 1024;
  var LIMIT = {
    title: 120, note: 4000, source: 160, encounters: 2000, story: 20000, private: 20000, encounterBody: 160 * 1024, upload: 8 * MiB, gif: 40 * MiB, video: 90 * MiB,
    galleries: 40, galleryName: 80, art: 500, versions: 12, label: 60, side: 10000,
    artist: 80, link: 300, caption: 1000, facts: 24, factLabel: 40, factValue: 400, sections: 24, heading: 120, section: 40000,
    traits: 24, pole: 40, glances: 5, glanceTitle: 80, glanceText: 1000, aboutBody: 256 * 1024
  };
  var ABOUT_TEXT = { title: 60, currently: 1000, ooc: 1000, race: 60, "class": 60, age: 60, eyes: 60, height: 60, build: 60, birthplace: 120, residence: 120 };
  var UPLOAD_TYPES = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" };
  var FILE_RE = /^[0-9a-f]{32}\.(webp|jpg|png|gif|mp4|webm)$/, STILL_RE = /^[0-9a-f]{32}\.(webp|jpg|png)$/;
  function isVideo(name) { return /\.(mp4|webm)$/.test(name); }
  var word = "preview", csrf = "", archive = null, model = null, files = null, sizes = {}, secret = null;
  // #ca-private: { sections: encounter id -> its private text, sealed: [the encounters only for the keeper] }
  function secrets() {
    if (!secret) {
      try { secret = JSON.parse(document.getElementById("ca-private").textContent) || {}; } catch (e) { secret = {}; }
      if (!secret.sections) secret.sections = {};
    }
    return secret;
  }

  function data() {
    if (!archive) {
      try { archive = JSON.parse(document.getElementById("ca-data").textContent); } catch (e) { archive = null; }
      archive = archive && Array.isArray(archive.records) ? archive : { profile: {}, records: [] };
      if (!Array.isArray(archive.art)) archive.art = [];
      if (!Array.isArray(archive.galleries)) archive.galleries = [];
      if (!archive.about) archive.about = { facts: [], sections: [] };
      if (!Array.isArray(archive.encounters)) archive.encounters = [];
      // the example encounters only for the keeper join the archive here, where only the keeper's answers show them
      (secrets().sealed || []).forEach(function (e, n) {
        archive.encounters.push({ id: e.id, title: e.title, date: e.date || "", text: e.text || "", added: 1000 + n, example: true, sealed: true });
        if (e.private) privates()[e.id] = e.private;
      });
    }
    return archive;
  }
  // encounter id -> its private text, never part of the archive
  function privates() { return secrets().sections; }
  // What visitors get: no encounter only for the keeper, and no record's link to one
  function publicView(a) {
    var hidden = {};
    a.encounters.forEach(function (e) { if (e.sealed) hidden[e.id] = true; });
    return Object.assign({}, a, {
      encounters: a.encounters.filter(function (e) { return !e.sealed; }),
      records: a.records.map(function (r) { return hidden[r.encounter] ? Object.assign({}, r, { encounter: "" }) : r; })
    });
  }
  // image name -> data: URI: the example plates' images, then whatever is uploaded
  function fileMap() {
    if (!files) {
      try { files = JSON.parse(document.getElementById("ca-files").textContent) || {}; } catch (e) { files = {}; }
    }
    return files;
  }
  function reply(status, body) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: status, headers: { "Content-Type": "application/json" } }));
  }
  function fail(status, message) { var e = new Error(message); e.status = status; return e; }
  function token() {
    var b = crypto.getRandomValues(new Uint8Array(32)), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function hex(bytes) { return Array.prototype.map.call(new Uint8Array(bytes), function (b) { return b.toString(16).padStart(2, "0"); }).join(""); }
  function str(v, max) { return typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : ""; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function validDate(d) { // a day that exists, as on the server: not 2024-02-30
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    var t = Date.parse(d + "T00:00:00Z");
    return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  }
  function clean(input, prev) {
    var title = str(input && input.title, LIMIT.title);
    if (!title) throw fail(400, "Give the record a title.");
    return {
      id: prev ? prev.id : "r" + token().slice(0, 12), title: title,
      note: str(input.note, LIMIT.note), source: str(input.source, LIMIT.source),
      encounter: typeof input.encounter === "string" && data().encounters.some(function (e) { return e.id === input.encounter; }) ? input.encounter : "",
      date: validDate(input.date) ? input.date : "",
      added: prev ? prev.added : Date.now(), example: false
    };
  }
  function cleanEncounter(input, prev) {
    var title = str(input && input.title, LIMIT.title);
    if (!title) throw fail(400, "Give the encounter a title.");
    var enc = {
      id: prev ? prev.id : "e" + token().slice(0, 12), title: title, date: validDate(input.date) ? input.date : "",
      text: str(input.text, LIMIT.story), added: prev ? prev.added : Date.now(), example: false
    };
    if (input.sealed === undefined ? prev && prev.sealed : input.sealed === true) enc.sealed = true; // only for the keeper
    return enc;
  }
  // undefined keeps the private text, "" removes it
  function keepPrivate(id, text) {
    if (text === undefined) return;
    var t = str(text, LIMIT.private);
    if (t) privates()[id] = t; else delete privates()[id];
  }
  function cleanLink(v) {
    var s = str(v, LIMIT.link);
    if (!s) return "";
    try {
      var u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "https://" + s);
      return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.indexOf(".") >= 0 && u.href.length <= LIMIT.link ? u.href : "";
    } catch (e) { return ""; }
  }
  // A file an art piece may use, and its size (a still: a thumbnail or a video's poster)
  function stored(name, still) {
    if (typeof name !== "string" || !(still ? STILL_RE : FILE_RE).test(name)) throw fail(400, "Upload the image first.");
    if (!fileMap()[name]) throw fail(400, isVideo(name) ? "That video is gone. Upload it again." : "That image is gone. Upload it again.");
    return sizes[name] || [1, 1];
  }
  function side(n) { return Math.min(LIMIT.side, Math.max(1, Math.round(Number(n)) || 1)); }
  // A plate's images as sent, as the server takes them: the first is the main image; one that names an image of
  // the plate keeps its files unless it brings new ones
  function cleanVersions(input, prev) {
    var old = {}, used = {};
    (prev || []).forEach(function (v) { old[v.id] = v; });
    var out = (Array.isArray(input) ? input : []).filter(function (v) { return v && typeof v === "object"; }).slice(0, LIMIT.versions).map(function (v) {
      var was = typeof v.id === "string" && !used[v.id] ? old[v.id] : null, base;
      if (was) used[was.id] = true;
      if (was && v.file === undefined) base = was;
      else {
        var size = stored(v.file), still = stored(v.thumb, true);
        if (isVideo(v.file)) size = [v.width || still[0], v.height || still[1]]; // a video's size comes from the keeper's browser
        base = { id: was && was.id, file: v.file, thumb: v.thumb, width: side(size[0]), height: side(size[1]) };
      }
      return { id: base.id || "v" + token().slice(0, 8), file: base.file, thumb: base.thumb, width: base.width, height: base.height, label: str(v.label, LIMIT.label),
               mature: v.mature === true, loop: isVideo(base.file) && v.loop === true };
    });
    if (!out.length) throw fail(400, "An art piece needs an image.");
    return out;
  }
  function cleanArt(input, prev) {
    if (!input || typeof input !== "object") throw fail(400, "The art piece is malformed.");
    var gallery = typeof input.gallery === "string" && data().galleries.some(function (g) { return g.id === input.gallery; }) ? input.gallery : "";
    if (input.gallery === undefined && prev) gallery = prev.gallery || "";
    else if (input.gallery && !gallery) throw fail(400, "That form is gone. Reload the page and choose another.");
    return {
      id: prev ? prev.id : "a" + token().slice(0, 12), gallery: gallery,
      versions: input.versions === undefined && prev ? prev.versions : cleanVersions(input.versions, prev && prev.versions),
      title: str(input.title, LIMIT.title), artist: str(input.artist, LIMIT.artist), link: cleanLink(input.link),
      date: validDate(input.date) ? input.date : today(), note: str(input.note, LIMIT.caption),
      added: prev ? prev.added : Date.now(), example: false
    };
  }
  function cleanGallery(input, prev) {
    var name = str(input && input.name, LIMIT.galleryName);
    if (!name) throw fail(400, "Give the form a name.");
    return { id: prev ? prev.id : "g" + token().slice(0, 12), name: name, added: prev ? prev.added : Date.now(), example: false };
  }
  function cleanAbout(input) {
    var a = input && typeof input === "object" ? input : {};
    function list(v) { return (Array.isArray(v) ? v : []).filter(function (x) { return x && typeof x === "object"; }); }
    var out = {};
    Object.keys(ABOUT_TEXT).forEach(function (k) { out[k] = str(a[k], ABOUT_TEXT[k]); });
    out.eyeColor = typeof a.eyeColor === "string" && /^#[0-9a-f]{6}$/i.test(a.eyeColor) ? a.eyeColor.toLowerCase() : "";
    out.facts = list(a.facts).map(function (f) { return { label: str(f.label, LIMIT.factLabel), value: str(f.value, LIMIT.factValue) }; })
      .filter(function (f) { return f.label || f.value; }).slice(0, LIMIT.facts);
    out.traits = list(a.traits).map(function (t) {
      var v = Math.round(Number(t.value));
      return { left: str(t.left, LIMIT.pole), right: str(t.right, LIMIT.pole), value: isFinite(v) ? Math.min(20, Math.max(0, v)) : 10 };
    }).filter(function (t) { return t.left || t.right; }).slice(0, LIMIT.traits);
    out.glances = list(a.glances).map(function (g) { return { title: str(g.title, LIMIT.glanceTitle), text: str(g.text, LIMIT.glanceText) }; })
      .filter(function (g) { return g.title || g.text; }).slice(0, LIMIT.glances);
    out.sections = list(a.sections).map(function (x) {
      return { heading: str(x.heading, LIMIT.heading), body: str(x.body, LIMIT.section), color: typeof x.color === "string" && /^#[0-9a-f]{6}$/i.test(x.color) ? x.color.toLowerCase() : "" };
    })
      .filter(function (x) { return x.heading || x.body; }).slice(0, LIMIT.sections);
    return out;
  }
  function change(fields) { archive = Object.assign({}, data(), fields); return archive; }
  // Made-up statistics in the shape the server gives them, naming the example forms, art, encounters and records
  function exampleStats(a) {
    var seed = 20261007;
    function rand() { // mulberry32: the same numbers on every load
      seed = seed + 0x6d2b79f5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    function between(lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); }
    function day(k) {
      var d = new Date();
      d.setDate(d.getDate() - k);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    var days = [];
    for (var k = 29; k >= 0; k--) {
      var v = Math.max(1, Math.round(9 + 5 * Math.sin(k / 3.2) + (k === 11 ? 31 : 0) + rand() * 6));
      days.push({ day: day(k), visitors: v, visits: Math.round(v * (1.4 + rand() * .5)) });
    }
    function sum(list, key) { return list.reduce(function (n, x) { return n + x[key]; }, 0); }
    var last = days[days.length - 1], week = days.slice(-7), month = sum(days, "visitors"), items = {};
    a.galleries.forEach(function (g) { items[g.id] = between(60, 150); });
    a.art.forEach(function (x) { items[x.id] = between(4, 110); });
    a.encounters.forEach(function (e) { if (!e.sealed) items[e.id] = between(3, 40); });
    a.records.forEach(function (r) { items[r.id] = between(1, 25); });
    return {
      example: true, since: day(45), today: last.day,
      visitors: { today: last.visitors, week: Math.round(sum(week, "visitors") * .8), month: Math.round(month * .62), all: Math.round(month * .62) + 143 },
      visits: { today: last.visits, week: sum(week, "visits"), month: sum(days, "visits"), all: sum(days, "visits") + 420 },
      days: days, chapters: { about: 162, art: 214, knowledge: 71, encounters: 58 }, items: items,
      from: [["", 131], ["t.co", 94], ["discord.com", 38], ["google.com", 11], ["bsky.app", 6], ["wowhead.com", 2]],
      countries: [["DE", 84], ["GB", 61], ["US", 47], ["FR", 23], ["NL", 15], ["SE", 9], ["XX", 3]]
    };
  }
  function modelBytes() {
    if (!model) {
      var bin = atob(document.getElementById("ca-model").textContent.trim()), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      model = out.buffer;
    }
    return model.slice(0);
  }

  // An upload is kept as a data: URI under the same kind of name the server gives it. A picture's or a GIF's size is
  // read here; a video's comes with the art piece, from the keeper's browser, as on the server.
  function upload(blob) {
    var ext = UPLOAD_TYPES[blob.type], video = ext === "mp4" || ext === "webm";
    if (!ext) return reply(415, { error: "Send an image (PNG, JPEG, WebP or GIF) or a video (MP4 or WebM)." });
    var limit = video ? LIMIT.video : ext === "gif" ? LIMIT.gif : LIMIT.upload;
    if (blob.size > limit) return reply(413, { error: "That " + (video ? "video" : ext === "gif" ? "GIF" : "image") + " is too large. The limit is " + limit / MiB + " MB." });
    var read = new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    var name = window.crypto && crypto.subtle
      ? blob.arrayBuffer().then(function (b) { return crypto.subtle.digest("SHA-256", b); }).then(function (d) { return hex(d).slice(0, 32); })
      : Promise.resolve(hex(crypto.getRandomValues(new Uint8Array(16))));
    return Promise.all([read, video ? null : createImageBitmap(blob), name]).then(function (got) {
      var file = got[2] + "." + ext;
      fileMap()[file] = got[0];
      if (video) return reply(200, { file: file });
      sizes[file] = [got[1].width, got[1].height];
      return reply(200, { file: file, width: got[1].width, height: got[1].height });
    }, function () { return reply(415, { error: "That file is not the image it claims to be." }); });
  }

  function handle(method, path, body, sent) {
    var a = data();
    if (method === "POST" && path === "api/hit") return Promise.resolve(new Response(null, { status: 204 })); // the preview counts nothing
    if (method === "GET" && path === "api/session") return reply(200, { owner: !!csrf, csrf: csrf });
    if (method === "GET" && path === "api/archive") return reply(200, { archive: publicView(a) });
    if (method === "POST" && path === "api/login") {
      if (body.password !== word) return reply(401, { error: "The seal does not yield." });
      csrf = token();
      return reply(200, { owner: true, csrf: csrf });
    }
    if (!csrf) return reply(401, { error: "Unlock the archive first." });
    if (sent !== csrf) return reply(403, { error: "The request was refused." });
    if (method === "POST" && path === "api/logout") { csrf = ""; return reply(200, { owner: false }); }
    if (method === "POST" && path === "api/password") {
      if (body.current !== word) return reply(401, { error: "The current word is wrong." });
      if (typeof body.next !== "string" || body.next.length < 12) return reply(400, { error: "Use at least 12 characters." });
      word = body.next;
      csrf = token();
      return reply(200, { owner: true, csrf: csrf });
    }
    if (method === "POST" && path === "api/uploads") return reply(415, { error: "Send an image (PNG, JPEG, WebP or GIF) or a video (MP4 or WebM)." });
    if (method === "PUT" && path === "api/about") {
      if (JSON.stringify(body).length > LIMIT.aboutBody) return reply(413, { error: "The About page is too long to keep: " + LIMIT.aboutBody / 1024 + " KB in all." });
      var profile = Object.assign({}, a.profile, { name: str(body.name, 60) || "Unnamed Dracthyr", epithet: str(body.epithet, 280) });
      return reply(200, { archive: change({ profile: profile, about: cleanAbout(body) }) });
    }
    if (method === "POST" && path === "api/galleries") {
      if (a.galleries.length >= LIMIT.galleries) return reply(413, { error: "There is no room for more forms." });
      var gallery = cleanGallery(body);
      return reply(200, { archive: change({ galleries: a.galleries.concat([gallery]) }), id: gallery.id });
    }
    if (method === "POST" && path === "api/galleries/order") {
      var gids = body.ids, gById = {};
      a.galleries.forEach(function (g) { gById[g.id] = g; });
      if (!(Array.isArray(gids) && gids.length === a.galleries.length && gids.every(function (id, i) { return gById[id] && gids.indexOf(id) === i; }))) {
        return reply(409, { error: "The forms have changed. Reload and try again." });
      }
      return reply(200, { archive: change({ galleries: gids.map(function (id) { return gById[id]; }) }) });
    }
    var gm = path.match(/^api\/galleries\/([^/]+)$/);
    if (gm) {
      var gid = decodeURIComponent(gm[1]), gwas = a.galleries.filter(function (g) { return g.id === gid; })[0];
      if (!gwas) return reply(404, { error: "That form is gone." });
      if (method === "PUT") {
        var renamed = cleanGallery(body, gwas);
        return reply(200, { archive: change({ galleries: a.galleries.map(function (g) { return g.id === gid ? renamed : g; }) }), id: gid });
      }
      if (method === "DELETE") {
        if (a.art.some(function (x) { return x.gallery === gid; })) return reply(409, { error: "Move its art pieces to another form, or remove them, first." });
        return reply(200, { archive: change({ galleries: a.galleries.filter(function (g) { return g.id !== gid; }) }) });
      }
    }
    if (method === "POST" && path === "api/art") {
      if (a.art.length >= LIMIT.art) return reply(413, { error: "There is no room for more art pieces." });
      var plate = cleanArt(body);
      return reply(200, { archive: change({ art: [plate].concat(a.art) }), id: plate.id });
    }
    if (method === "POST" && path === "api/art/order") {
      var ids = body.ids, byId = {};
      a.art.forEach(function (x) { byId[x.id] = x; });
      var ok = Array.isArray(ids) && ids.length === a.art.length && ids.every(function (id, i) { return byId[id] && ids.indexOf(id) === i; });
      if (!ok) return reply(409, { error: "The art pieces have changed. Reload and try again." });
      return reply(200, { archive: change({ art: ids.map(function (id) { return byId[id]; }) }) });
    }
    if (method === "GET" && path === "api/private") {
      var out = {};
      a.encounters.forEach(function (e) { if (privates()[e.id] !== undefined) out[e.id] = privates()[e.id]; });
      return reply(200, { encounters: out, archive: a });
    }
    if (method === "GET" && path === "api/stats") return reply(200, exampleStats(a));
    if (method === "POST" && path === "api/encounters") {
      if (JSON.stringify(body).length > LIMIT.encounterBody) return reply(413, { error: "That is too large." });
      var enc = cleanEncounter(body);
      keepPrivate(enc.id, body.private);
      return reply(200, { archive: change({ encounters: a.encounters.concat([enc]) }), id: enc.id });
    }
    var em = path.match(/^api\/encounters\/([^/]+)$/);
    if (em) {
      var eid = decodeURIComponent(em[1]), was = a.encounters.filter(function (e) { return e.id === eid; })[0];
      if (!was) return reply(404, { error: "That encounter is gone." });
      if (method === "PUT") {
        if (JSON.stringify(body).length > LIMIT.encounterBody) return reply(413, { error: "That is too large." });
        var revised = cleanEncounter(body, was);
        keepPrivate(eid, body.private);
        return reply(200, { archive: change({ encounters: a.encounters.map(function (e) { return e.id === eid ? revised : e; }) }), id: eid });
      }
      if (method === "DELETE") {
        delete privates()[eid];
        return reply(200, { archive: change({ encounters: a.encounters.filter(function (e) { return e.id !== eid; }),
          records: a.records.map(function (r) { return r.encounter === eid ? Object.assign({}, r, { encounter: "" }) : r; }) }) });
      }
    }
    if (method === "POST" && path === "api/records/clear-examples") {
      var kept = a.encounters.filter(function (e) { if (e.example) delete privates()[e.id]; return !e.example; });
      return reply(200, { archive: change({ encounters: kept, records: a.records.filter(function (r) { return !r.example; }).map(function (r) {
        return kept.some(function (e) { return e.id === r.encounter; }) ? r : Object.assign({}, r, { encounter: "" });
      }) }) });
    }
    if (method === "POST" && path === "api/records") {
      var rec = clean(body);
      return reply(200, { archive: change({ records: a.records.concat([rec]) }), id: rec.id });
    }
    var pm = path.match(/^api\/art\/([^/]+)$/);
    if (pm) {
      var pid = decodeURIComponent(pm[1]);
      var was = a.art.filter(function (x) { return x.id === pid; })[0];
      if (!was) return reply(404, { error: "That art piece is gone." });
      if (method === "PUT") {
        var revised = cleanArt(body, was), list = a.art.map(function (x) { return x.id === pid ? revised : x; });
        return reply(200, { archive: change({ art: list }), id: pid });
      }
      if (method === "DELETE") {
        var art = a.art.filter(function (x) { return x.id !== pid; });
        return reply(200, { archive: change({ art: art }) });
      }
    }
    var m = path.match(/^api\/records\/([^/]+)$/);
    if (m) {
      var id = decodeURIComponent(m[1]);
      var prev = a.records.filter(function (r) { return r.id === id; })[0];
      if (!prev) return reply(404, { error: "That record is gone." });
      if (method === "PUT") {
        var next = clean(body, prev);
        return reply(200, { archive: change({ records: a.records.map(function (r) { return r.id === id ? next : r; }) }), id: id });
      }
      if (method === "DELETE") {
        return reply(200, { archive: change({ records: a.records.filter(function (r) { return r.id !== id; }) }) });
      }
    }
    return reply(404, { error: "Not found." });
  }

  window.CA_PREVIEW = {
    note: "This is the preview: the word is “preview”, and changes last only until the page reloads.",
    src: function (name) { return fileMap()[name] || ""; },
    fetch: function (url, opts) {
      opts = opts || {};
      var path = String(url).replace(/^\.?\//, ""), method = (opts.method || "GET").toUpperCase(), sent = (opts.headers || {})["X-CSRF-Token"] || "";
      if (/^chalice\.[0-9a-f]{12}\.glb$/.test(path)) {
        return Promise.resolve(new Response(modelBytes(), { headers: { "Content-Type": "model/gltf-binary" } }));
      }
      if (typeof Blob !== "undefined" && opts.body instanceof Blob) {
        if (!csrf) return reply(401, { error: "Unlock the archive first." });
        if (sent !== csrf) return reply(403, { error: "The request was refused." });
        return method === "POST" && path === "api/uploads" ? upload(opts.body) : reply(415, { error: "Send JSON." });
      }
      var body;
      try { body = opts.body ? JSON.parse(opts.body) : {}; } catch (e) { return reply(400, { error: "The request is not valid JSON." }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "The request is malformed." });
      try {
        return handle(method, path, body, sent);
      } catch (err) {
        return reply(err.status || 500, { error: err.message });
      }
    }
  };
})();
