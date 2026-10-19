/*
 * stats/app/js/sync.js - sends the outbox (Store) to the sync server and
 * shows the SYNCED / n PENDING chip.
 *
 * The server is the page's own origin (POST /stats/op), or the URL in
 * localStorage "statsapp.syncUrl". Ops carry their opId, so the server keeps
 * each op once however often it is sent; an op leaves the outbox only when
 * the server lists it in `acked`. Nothing here blocks logging: sending runs
 * in the background, one batch at a time, and retries with a backoff
 * (1 s doubling to 30 s) while the link is down.
 */
var Sync = (function () {

    var BATCH = 200, TIMEOUT = 8000, MAX_WAIT = 30000;
    var base = null, busy = false, again = false, timer = null, wait = 1000, gas = false;
    var st = { mode: "init", pending: 0, detail: "", sheet: null };
    var metas = {};

    // Where ops go. "statsapp.syncUrl" (set once by opening the app with
    // ?sync=<url>, cleared with ?sync=off) is either a server like the
    // stand-in, or a Google Sheet's Apps Script web app (stats/sheet/: its
    // /exec URL), else the page's own server. ?key=<word> sets the key the
    // sheet may ask for.
    // A setting kept on the device, set by opening the app with ?<param>=value
    // (?<param>=off clears it).
    function setting(name, param) {
        var m = new RegExp("[?&]" + param + "=([^&]*)").exec(location.search), v;
        try {
            if (m) {
                v = decodeURIComponent(m[1]);
                if (v === "off" || v === "") { localStorage.removeItem(name); } else { localStorage.setItem(name, v); }
            }
            return localStorage.getItem(name);
        } catch (e) { return m ? decodeURIComponent(m[1]) : null; }
    }

    function endpoint() {
        var u = setting("statsapp.syncUrl", "sync");
        gas = !!u && /^https:\/\/script\.google(usercontent)?\.com\//.test(u);
        if (gas) { return u; }
        if (u) { return u.replace(/\/+$/, "") + "/stats/op"; }
        if (/^https?:$/.test(location.protocol)) { return location.origin + "/stats/op"; }
        return null;
    }
    function where() { return gas ? "the Google Sheet" : base.replace(/\/stats\/op$/, ""); }

    // ------------------------------------------------------------ chip

    function show(mode, detail) {
        var el = document.getElementById("syncChip"), n = st.pending, text;
        st.mode = mode;
        st.detail = detail || "";
        text = {
            ok: gas ? "SHEET SYNCED" : "SYNCED",
            pending: n + " PENDING",
            offline: "OFFLINE" + (n ? " · " + n + " PENDING" : ""),
            nosync: "NO SYNC" + (n ? " · " + n + " PENDING" : ""),
            sheet: st.sheet === "TAKEOVER" ? "SHEET TOOK OVER" : (st.sheet === "OTHER_GAME" ? "SHEET HAS ANOTHER GAME" : "SHEET ERROR"),
            init: "…"
        }[mode];
        el.className = "chip sync " + (mode === "sheet" ? "offline" : mode);
        el.textContent = text;
        el.title = st.detail;
    }

    // ------------------------------------------------------------ sending

    // A Google Apps Script web app answers through a redirect and only takes a
    // "simple" request, so the body goes as text/plain (still JSON inside).
    function post(body) {
        var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
        var t = ctl ? setTimeout(function () { ctl.abort(); }, gas ? TIMEOUT * 3 : TIMEOUT) : null;
        return fetch(base, {
            method: "POST", headers: { "Content-Type": gas ? "text/plain;charset=utf-8" : "application/json" },
            body: JSON.stringify(body), cache: "no-store", redirect: "follow", signal: ctl ? ctl.signal : undefined
        }).then(function (r) {
            clearTimeout(t);
            if (r.status === 404 || r.status === 405 || r.status === 501) {
                var e = new Error("No sync server at " + where()); e.nosync = true; throw e;
            }
            if (!r.ok) { throw new Error("Server answered " + r.status); }
            return r.json();
        }, function (e) {
            clearTimeout(t);
            throw new Error(e && e.name === "AbortError" ? "No answer from " + where() : "Can't reach " + where());
        });
    }

    function gameMeta(id) {
        if (metas[id]) { return Promise.resolve(metas[id]); }
        return Store.getGame(id).then(function (g) {
            metas[id] = g ? { id: g.id, name: g.name, setup: g.setup } : { id: id };
            return metas[id];
        });
    }

    function sendGame(id, ops) {
        var t0 = performance.now();
        return gameMeta(id).then(function (g) {
            var body = { game: g, ops: ops }, key = setting("statsapp.syncKey", "key");
            if (key) { body.key = key; }
            return post(body);
        }).then(function (j) {
            if (!j || !j.ok || !j.acked) { throw new Error((j && j.error) || "Bad answer from the server"); }
            var hud = document.getElementById("hudSync");
            if (hud) { hud.textContent = "sync " + Math.round(performance.now() - t0) + " ms"; }
            // The Google Sheet also says whether it could write its rows.
            st.sheet = j.sheet && j.sheet.state && j.sheet.state !== "OK" ? j.sheet.state : null;
            st.sheetDetail = !st.sheet ? "" : (st.sheet === "TAKEOVER" ? "Someone typed in " + j.sheet.tab + " row " + j.sheet.row +
                ": the sheet keeps this game. Plays are still saved in its Scorebook Log tab." :
                (st.sheet === "OTHER_GAME" ? "The sheet holds another game. Scorebook menu > New game in the sheet to start over." :
                    (j.sheet.error || j.sheet.tab || st.sheet)));
            return Store.outboxDone(id, j.acked);
        });
    }

    function flush() {
        timer = null;
        if (!base || !Store.ok) { return; }
        if (busy) { again = true; return; }
        busy = true;
        Store.outboxBatch(BATCH).then(function (by) {
            var ids = Object.keys(by), chain = Promise.resolve();
            ids.forEach(function (id) { chain = chain.then(function () { return sendGame(id, by[id]); }); });
            return chain;
        }).then(function () {
            return Store.outboxCount();
        }).then(function (n) {
            st.pending = n;
            wait = 1000;
            if (st.sheet && !n) { show("sheet", st.sheetDetail); }
            else { show(n ? "pending" : "ok", n ? "Sending" : (gas ? "Every play is in the Google Sheet" : "Every op is on the server")); }
            if (n) { schedule(0); }               // more than one batch waiting
        }, function (e) {
            return Store.outboxCount().catch(function () { return st.pending; }).then(function (n) {
                st.pending = n;
                show(e && e.nosync ? "nosync" : "offline", (e && e.message) || "Sync failed");
                schedule(e && e.nosync ? MAX_WAIT : wait);
                wait = Math.min(wait * 2, MAX_WAIT);
            });
        }).then(function () {
            busy = false;
            if (again) { again = false; schedule(0); }
        });
    }

    function schedule(ms) {
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(flush, ms);
    }

    // After every logged op: count it at once, send in the background.
    function kick() {
        if (!base) { return; }
        st.pending++;
        if (st.mode !== "offline" && st.mode !== "nosync") { show("pending"); } else { show(st.mode, st.detail); }
        wait = 1000;
        schedule(0);
    }

    function start() {
        base = endpoint();
        if (!base) { show("nosync", "Opened from a file: open the app from the stand-in server to sync"); return; }
        if (!Store.ok) { show("nosync", "Device storage is off, so there is no outbox"); return; }
        window.addEventListener("online", function () { wait = 1000; schedule(0); });
        document.addEventListener("visibilitychange", function () { if (!document.hidden) { schedule(0); } });
        Store.outboxCount().then(function (n) { st.pending = n; show(n ? "pending" : "ok"); schedule(0); });
    }

    // The sheet's web app URL + key when the app syncs to a Google Sheet (players.js reads the rosters there), else null.
    function sheet() {
        var u = setting("statsapp.syncUrl", "sync");
        return u && /^https:\/\/script\.google(usercontent)?\.com\//.test(u) ? { url: u, key: setting("statsapp.syncKey", "key") } : null;
    }
    return { start: start, kick: kick, flush: function () { schedule(0); }, sheet: sheet, get state() { return st; } };
})();
