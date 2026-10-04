/* Preview stand-in for server/server.mjs. It goes only into dist/preview.html, the build published as the claude.ai
   Artifact so the owner can see changes before deploying them; build.py never puts it into dist/index.html.
   The Artifact viewer allows no network requests, so this answers the page's requests in memory: the model comes
   from #ca-model, and the API behaves like the real one, except that the word is "preview" and every change is
   lost when the page reloads. */
(function () {
  "use strict";
  var LIMIT = { title: 120, domain: 60, note: 4000, source: 160 };
  var STATUSES = ["remembered", "superseded", "relearned", "fragment", "sought"];
  var word = "preview", csrf = "", archive = null, model = null;

  function data() {
    if (!archive) {
      try { archive = JSON.parse(document.getElementById("ca-data").textContent); } catch (e) { archive = null; }
      archive = archive && Array.isArray(archive.records) ? archive : { profile: {}, records: [] };
    }
    return archive;
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
  function str(v, max) { return typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : ""; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function clean(input, prev) {
    var title = str(input && input.title, LIMIT.title);
    if (!title) throw fail(400, "Give the record a title.");
    return {
      id: prev ? prev.id : "r" + token().slice(0, 12), title: title,
      domain: str(input.domain, LIMIT.domain) || "Unsorted",
      status: STATUSES.indexOf(input.status) >= 0 ? input.status : "fragment",
      note: str(input.note, LIMIT.note), source: str(input.source, LIMIT.source),
      date: /^\d{4}-\d{2}-\d{2}$/.test(input.date) && !isNaN(Date.parse(input.date)) ? input.date : today(),
      added: prev ? prev.added : Date.now(), example: false
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
    if (method === "POST" && path === "api/records/clear-examples") {
      archive = { profile: a.profile, records: a.records.filter(function (r) { return !r.example; }) };
      return reply(200, { archive: archive });
    }
    if (method === "POST" && path === "api/records") {
      var rec = clean(body);
      archive = { profile: a.profile, records: a.records.concat([rec]) };
      return reply(200, { archive: archive, id: rec.id });
    }
    var m = path.match(/^api\/records\/([^/]+)$/);
    if (m) {
      var id = decodeURIComponent(m[1]);
      var prev = a.records.filter(function (r) { return r.id === id; })[0];
      if (!prev) return reply(404, { error: "That record is gone." });
      if (method === "PUT") {
        var next = clean(body, prev);
        archive = { profile: a.profile, records: a.records.map(function (r) { return r.id === id ? next : r; }) };
        return reply(200, { archive: archive, id: id });
      }
      if (method === "DELETE") {
        archive = { profile: a.profile, records: a.records.filter(function (r) { return r.id !== id; }) };
        return reply(200, { archive: archive });
      }
    }
    return reply(404, { error: "Not found." });
  }

  window.CA_PREVIEW = {
    note: "This is the preview: the word is “preview”, and changes last only until the page reloads.",
    fetch: function (url, opts) {
      opts = opts || {};
      var path = String(url).replace(/^\.?\//, "");
      if (/^chalice\.[0-9a-f]{12}\.glb$/.test(path)) {
        return Promise.resolve(new Response(modelBytes(), { headers: { "Content-Type": "model/gltf-binary" } }));
      }
      var body;
      try { body = opts.body ? JSON.parse(opts.body) : {}; } catch (e) { return reply(400, { error: "The request is not valid JSON." }); }
      try {
        return handle((opts.method || "GET").toUpperCase(), path, body || {}, (opts.headers || {})["X-CSRF-Token"] || "");
      } catch (err) {
        return reply(err.status || 500, { error: err.message });
      }
    }
  };
})();
