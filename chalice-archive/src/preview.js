/* Preview stand-in for server/server.mjs. It goes only into dist/preview.html, the build published as the claude.ai
   Artifact so the owner can see changes before deploying them; build.py never puts it into dist/index.html.
   The Artifact viewer allows no network requests, so this answers the page's requests in memory: the model comes
   from #ca-model, the example plates' images from #ca-files, and the API behaves like the real one, except that
   the word is "preview" and every change, uploaded images included, is lost when the page reloads. */
(function () {
  "use strict";
  var LIMIT = {
    title: 120, domain: 60, note: 4000, source: 160, upload: 8 * 1024 * 1024, art: 500,
    artist: 80, link: 300, caption: 1000, facts: 16, factLabel: 40, factValue: 160, sections: 12, heading: 80, section: 6000
  };
  var STATUSES = ["remembered", "superseded", "relearned", "fragment", "sought"];
  var IMAGE_TYPES = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };
  var FILE_RE = /^[0-9a-f]{32}\.(webp|jpg|png)$/;
  var word = "preview", csrf = "", archive = null, model = null, files = null, sizes = {};

  function data() {
    if (!archive) {
      try { archive = JSON.parse(document.getElementById("ca-data").textContent); } catch (e) { archive = null; }
      archive = archive && Array.isArray(archive.records) ? archive : { profile: {}, records: [] };
      if (!Array.isArray(archive.art)) archive.art = [];
      if (!archive.about) archive.about = { portrait: "", facts: [], sections: [] };
    }
    return archive;
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
  function validDate(d) { return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)); }
  function clean(input, prev) {
    var title = str(input && input.title, LIMIT.title);
    if (!title) throw fail(400, "Give the record a title.");
    return {
      id: prev ? prev.id : "r" + token().slice(0, 12), title: title,
      domain: str(input.domain, LIMIT.domain) || "Unsorted",
      status: STATUSES.indexOf(input.status) >= 0 ? input.status : "fragment",
      note: str(input.note, LIMIT.note), source: str(input.source, LIMIT.source),
      date: validDate(input.date) ? input.date : today(),
      added: prev ? prev.added : Date.now(), example: false
    };
  }
  function cleanLink(v) {
    var s = str(v, LIMIT.link);
    if (!s) return "";
    try {
      var u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "https://" + s);
      return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.indexOf(".") >= 0 && u.href.length <= LIMIT.link ? u.href : "";
    } catch (e) { return ""; }
  }
  // An image a plate may use, and its size
  function stored(name) {
    if (typeof name !== "string" || !FILE_RE.test(name)) throw fail(400, "Upload the image first.");
    if (!fileMap()[name]) throw fail(400, "That image is gone. Upload it again.");
    var used = data().art.filter(function (a) { return a.file === name; })[0];
    return sizes[name] || (used ? [used.width, used.height] : [1, 1]);
  }
  function cleanArt(input, prev) {
    if (!input || typeof input !== "object") throw fail(400, "The plate is malformed.");
    var file = prev ? prev.file : "", thumb = prev ? prev.thumb : "", size = prev ? [prev.width, prev.height] : [1, 1];
    if (input.file !== undefined || !prev) { size = stored(input.file); stored(input.thumb); file = input.file; thumb = input.thumb; }
    return {
      id: prev ? prev.id : "a" + token().slice(0, 12), file: file, thumb: thumb, width: size[0], height: size[1],
      title: str(input.title, LIMIT.title), artist: str(input.artist, LIMIT.artist), link: cleanLink(input.link),
      date: validDate(input.date) ? input.date : today(), note: str(input.note, LIMIT.caption),
      added: prev ? prev.added : Date.now(), example: false
    };
  }
  function cleanAbout(input, art) {
    var a = input && typeof input === "object" ? input : {};
    function list(v) { return (Array.isArray(v) ? v : []).filter(function (x) { return x && typeof x === "object"; }); }
    return {
      portrait: typeof a.portrait === "string" && art.some(function (x) { return x.id === a.portrait; }) ? a.portrait : "",
      facts: list(a.facts).map(function (f) { return { label: str(f.label, LIMIT.factLabel), value: str(f.value, LIMIT.factValue) }; })
        .filter(function (f) { return f.label || f.value; }).slice(0, LIMIT.facts),
      sections: list(a.sections).map(function (x) { return { heading: str(x.heading, LIMIT.heading), body: str(x.body, LIMIT.section) }; })
        .filter(function (x) { return x.heading || x.body; }).slice(0, LIMIT.sections)
    };
  }
  function change(fields) { archive = Object.assign({}, data(), fields); return archive; }
  function modelBytes() {
    if (!model) {
      var bin = atob(document.getElementById("ca-model").textContent.trim()), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      model = out.buffer;
    }
    return model.slice(0);
  }

  // An uploaded image is kept as a data: URI under the same kind of name the server gives it
  function upload(blob) {
    var ext = IMAGE_TYPES[blob.type];
    if (!ext) return reply(415, { error: "Send a PNG, JPEG or WebP image." });
    if (blob.size > LIMIT.upload) return reply(413, { error: "That image is too large. The limit is 8 MB." });
    var read = new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    var name = window.crypto && crypto.subtle
      ? blob.arrayBuffer().then(function (b) { return crypto.subtle.digest("SHA-256", b); }).then(function (d) { return hex(d).slice(0, 32); })
      : Promise.resolve(hex(crypto.getRandomValues(new Uint8Array(16))));
    return Promise.all([read, createImageBitmap(blob), name]).then(function (got) {
      var file = got[2] + "." + ext;
      fileMap()[file] = got[0];
      sizes[file] = [got[1].width, got[1].height];
      return reply(200, { file: file, width: got[1].width, height: got[1].height });
    }, function () { return reply(415, { error: "That file is not the image it claims to be." }); });
  }

  function handle(method, path, body, sent) {
    var a = data();
    if (method === "GET" && path === "api/session") return reply(200, { owner: !!csrf, csrf: csrf });
    if (method === "GET" && path === "api/archive") return reply(200, { archive: a });
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
    if (method === "POST" && path === "api/uploads") return reply(415, { error: "Send a PNG, JPEG or WebP image." });
    if (method === "PUT" && path === "api/about") {
      var profile = Object.assign({}, a.profile, { name: str(body.name, 60) || "Unnamed Dracthyr", epithet: str(body.epithet, 280) });
      return reply(200, { archive: change({ profile: profile, about: cleanAbout(body, a.art) }) });
    }
    if (method === "POST" && path === "api/art") {
      if (a.art.length >= LIMIT.art) return reply(413, { error: "There is no room for more plates." });
      var plate = cleanArt(body);
      return reply(200, { archive: change({ art: [plate].concat(a.art) }), id: plate.id });
    }
    if (method === "POST" && path === "api/art/order") {
      var ids = body.ids, byId = {};
      a.art.forEach(function (x) { byId[x.id] = x; });
      var ok = Array.isArray(ids) && ids.length === a.art.length && ids.every(function (id, i) { return byId[id] && ids.indexOf(id) === i; });
      if (!ok) return reply(409, { error: "The plates have changed. Reload and try again." });
      return reply(200, { archive: change({ art: ids.map(function (id) { return byId[id]; }) }) });
    }
    if (method === "POST" && path === "api/records/clear-examples") {
      return reply(200, { archive: change({ records: a.records.filter(function (r) { return !r.example; }) }) });
    }
    if (method === "POST" && path === "api/records") {
      var rec = clean(body);
      return reply(200, { archive: change({ records: a.records.concat([rec]) }), id: rec.id });
    }
    var pm = path.match(/^api\/art\/([^/]+)$/);
    if (pm) {
      var pid = decodeURIComponent(pm[1]);
      var was = a.art.filter(function (x) { return x.id === pid; })[0];
      if (!was) return reply(404, { error: "That plate is gone." });
      if (method === "PUT") {
        var revised = cleanArt(body, was);
        return reply(200, { archive: change({ art: a.art.map(function (x) { return x.id === pid ? revised : x; }) }), id: pid });
      }
      if (method === "DELETE") {
        var art = a.art.filter(function (x) { return x.id !== pid; });
        return reply(200, { archive: change({ art: art, about: cleanAbout(a.about, art) }) });
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
