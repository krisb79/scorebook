/*
 * stats/app/sw.js - keeps a copy of the app on the device so it opens with
 * no network (STATS_APP_PLAN.md section 4: "works offline once loaded").
 *
 * Network first, so an updated app is picked up whenever the server answers;
 * the cached copy is used when it doesn't answer within 2.5 s. Sync calls
 * (/stats/op, /stats/ops, /stats/v) are never cached.
 * Service workers only run on https:// or localhost (a browser rule).
 */
var CACHE = "statsapp-shell-42";
var SHELL = [
    "./", "index.html", "app.css",
    "js/store.js", "js/sync.js", "js/format.js", "js/keypad.js", "js/field.js", "js/view.js",
    "js/entry.js", "js/teams.js", "js/players.js", "players.html", "js/center.js", "js/huddles.js", "js/app.js",
    "../engine/ops.js", "../engine/engine.js", "../test/fixtures_bundle.js"
];
var NETWORK_WAIT = 2500;

self.addEventListener("install", function (e) {
    e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
    e.waitUntil(caches.keys().then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); }));
});

function fromCache(req) {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) { return hit; }
        if (req.mode === "navigate") { return caches.match("index.html"); }
        return Response.error();
    });
}

self.addEventListener("fetch", function (e) {
    var req = e.request, url = new URL(req.url);
    if (req.method !== "GET" || url.origin !== self.location.origin) { return; }
    if (/\/stats\/(op|ops|v)$/.test(url.pathname)) { return; }

    e.respondWith(new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () {
            fromCache(req).then(function (r) { if (!done && r && r.type !== "error") { done = true; resolve(r); } });
        }, NETWORK_WAIT);
        // always ask the server whether a file changed (GitHub Pages tells browsers to keep files 10 minutes)
        (req.mode === "navigate" ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" }) : fetch(req, { cache: "no-cache" })).then(function (res) {
            if (res.ok) {
                var copy = res.clone();
                caches.open(CACHE).then(function (c) { c.put(req, copy); });
            }
            clearTimeout(timer);
            if (!done) { done = true; resolve(res); }
        }, function () {
            clearTimeout(timer);
            fromCache(req).then(function (r) { if (!done) { done = true; resolve(r); } });
        });
    }));
});
