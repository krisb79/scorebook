/*
 * stats/app/js/app.js - the page. Holds only the game (setup + ops) and view
 * choices; everything shown is a replay of the ops (STATS_APP_PLAN.md rule 1).
 *
 * Every input becomes one op: validated (StatsEngine.validate), written to
 * the device (Store, IndexedDB) and only then appended, replayed and
 * rendered. Undo is a new op (StatsOps.inverse). No global UI lock: the only
 * guard stops a second op while one is being stored.
 *
 * Saved ops also wait in the outbox until the sync server has them (Sync).
 * The service worker (sw.js) keeps the app itself on the device.
 *
 * Games: saved games live in Store. Test games (fixtures) are read-only; the
 * first op logged on one saves a practice copy and continues on that.
 */
var App = (function () {

    var APP_VERSION = "0.2.0-dev";
    var SCHEMA = 1;
    var $ = function (id) { return document.getElementById(id); };

    // id: Store key (null = a test game not saved yet); ready: Promise of the
    // game record being stored; fixture: the test game's name.
    var game = { id: null, name: "", setup: {}, ops: [], ready: null, fixture: null };
    var ui = { upTo: 0, tab: "plays", driveTeam: "ALL", drive: null };
    var result = null, events = [];
    var device = deviceId();
    var guard = false, lastDown = 0, toastTimer = null;

    function deviceId() {
        var id = null;
        try { id = localStorage.getItem("statsapp.device"); } catch (e) { /* private mode */ }
        if (!id) {
            id = "d" + Math.random().toString(36).slice(2, 7);
            try { localStorage.setItem("statsapp.device", id); } catch (e) { /* private mode */ }
        }
        return id;
    }

    // ------------------------------------------------------------ game files

    // Fixture ops may be bare events (= ADD with eventId e<n>), same as
    // stats/test/harness.js; seq and opId default to the position.
    var OP_KINDS = { ADD: 1, EDIT: 1, VOID: 1, RESTORE: 1 };
    function normalizeOps(list) {
        var out = [], i, x, op, k;
        for (i = 0; i < list.length; i++) {
            x = list[i];
            if (OP_KINDS[x.kind]) {
                op = {};
                for (k in x) { if (x.hasOwnProperty(k)) { op[k] = x[k]; } }
            } else {
                op = { kind: "ADD", eventId: x.id || ("e" + (i + 1)), event: x };
            }
            if (op.seq === undefined) { op.seq = i + 1; }
            if (op.opId === undefined) { op.opId = "fx-" + (i + 1); }
            out.push(op);
        }
        return out;
    }

    // .json: a fixture / game { setup, ops | log }. .jsonl: line 1 = header
    // { schema, app, name, setup } (or a bare setup), then one op per line.
    function parseGame(text, name) {
        var t = text.replace(/^﻿/, "").trim(), lines, head, ops = [], i, obj;
        if (/\.jsonl$/i.test(name) || isJsonl(t)) {
            lines = t.split(/\r?\n/).filter(function (l) { return l.trim(); });
            head = JSON.parse(lines[0]);
            for (i = 1; i < lines.length; i++) {
                try { ops.push(JSON.parse(lines[i])); }
                catch (e) { if (i < lines.length - 1) { throw new Error("line " + (i + 1) + " is not valid"); } }   // a cut-off last line is skipped
            }
            if (head.schema > SCHEMA) { throw new Error("made by a newer app (schema " + head.schema + ")"); }
            return { name: head.name || name, setup: head.setup || head, ops: normalizeOps(ops) };
        }
        obj = JSON.parse(t);
        if (!obj.setup) { throw new Error("No setup in " + name); }
        return { name: obj.name || name, setup: obj.setup, ops: normalizeOps(obj.ops || obj.log || []) };
    }
    function isJsonl(t) {
        try { JSON.parse(t); return false; } catch (e) { return true; }
    }

    function toJsonl(g) {
        var head = { schema: SCHEMA, app: APP_VERSION, engine: StatsEngine.VERSION, id: g.id, name: g.name, setup: g.setup };
        return [JSON.stringify(head)].concat(g.ops.map(function (o) { return JSON.stringify(o); })).join("\n") + "\n";
    }

    function gameDate(setup) { return (setup && setup.date) || new Date().toISOString().slice(0, 10); }
    function codes(setup) {
        return { a: (setup.away && setup.away.code) || "AWAY", h: (setup.home && setup.home.code) || "HOME" };
    }
    function fileBase(setup) { var c = codes(setup); return gameDate(setup) + "_" + c.a + "_at_" + c.h; }
    function newGameId(setup) { return fileBase(setup) + "_" + Date.now().toString(36); }

    function exportGame() {
        var blob = new Blob([toJsonl(game)], { type: "application/x-ndjson" }), a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileBase(game.setup || {}) + ".jsonl";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    // ------------------------------------------------------------ games

    function load(g) {
        game = g;
        ui.upTo = g.ops.length;
        ui.drive = null;
        Entry.exitMode();
        syncScrub();
        $("src").value = keyOf(g);
        setSave(g.id ? "ok" : "test");
        refresh();
    }

    function keyOf(g) { return g.id ? "g:" + g.id : "f:" + g.fixture; }

    // A new stored game (new, imported); it is in memory at once and
    // stored in the background; the first op waits for it (ensureStored).
    function startSaved(name, setup, ops) {
        var g = { id: newGameId(setup), name: name, setup: setup, ops: ops, ready: null, fixture: null, created: Date.now() };
        g.ready = storeGame(g);
        g.ready.catch(function (e) { setSave("bad", e.message); });
        return g;
    }
    function storeGame(g) {
        if (!Store.ok) { return Promise.reject(new Error(Store.error || "Storage is not available")); }
        return Store.createGame({ id: g.id, name: g.name, setup: g.setup, created: g.created }, g.ops.slice())
            .then(function () { return Store.setCurrent("g:" + g.id); })
            .then(function () { Sync.flush(); return fillSources(); });
    }

    function newGame(setup) {
        var c = codes(setup), g = startSaved(gameDate(setup) + " " + c.a + " at " + c.h, setup, []);
        addOption(g);
        load(g);
    }

    function importGame(parsed, fileName) {
        var name = parsed.name === fileName ? fileName.replace(/\.jsonl?$/i, "") : parsed.name, taken = {}, n = 2, g, i;
        var opts = $("src").querySelectorAll('option[value^="g:"]');
        for (i = 0; i < opts.length; i++) { taken[opts[i].textContent] = true; }
        if (taken[name]) { while (taken[name + " (copy " + n + ")"]) { n++; } name += " (copy " + n + ")"; }
        g = startSaved(name, parsed.setup, parsed.ops);
        addOption(g);
        load(g);
        toast("Opened " + fileName + " (" + parsed.ops.length + " ops) as a saved game", false);
    }

    // A test game: save a practice copy before its first new op.
    function ensureStored() {
        var g = game;
        if (!Store.ok) { return Promise.reject(new Error(Store.error || "Storage is not available")); }
        if (g.ready) { return g.ready; }
        g.id = newGameId(g.setup);
        g.name = "Practice: " + g.fixture;
        g.created = Date.now();
        g.ready = storeGame(g);
        return g.ready;
    }

    function deleteGame() {
        var g = game;
        if (!g.id || !Store.ok) { return; }
        if (!window.confirm("Delete the saved game \"" + g.name + "\" from this device? Export it first if you need it.")) { return; }
        Store.deleteGame(g.id).then(function () {
            return Store.setCurrent(null);
        }).then(function () {
            return fillSources();
        }).then(function () {
            openDefault();
            toast("Deleted " + g.name, false);
        }, function (e) { toast("Couldn't delete: " + e.message, false); });
    }

    // ------------------------------------------------------------ render

    function refresh() {
        var t0 = performance.now(), t1, t2, ops = game.ops.length === ui.upTo ? game.ops : game.ops.slice(0, ui.upTo);
        events = StatsOps.effective(ops);
        result = StatsEngine.replay(game.setup || {}, events);
        t1 = performance.now();
        View.render(result, ui, Entry.fieldSituation(), events);
        Entry.render();
        if (Entry.active() || Entry.mode !== "LIVE") { $("entryMore").open = true; drawer(true); }   // an edit / missed play opens the entry panel
        Center.render();
        Players.render();
        t2 = performance.now();
        $("scrubLbl").textContent = "op " + ui.upTo + " / " + game.ops.length;
        $("goLive").hidden = !isViewing();
        $("hudReplay").textContent = "replay " + (t1 - t0).toFixed(1) + " ms · render " + (t2 - t1).toFixed(1) + " ms";
    }

    function syncScrub() {
        $("scrub").max = game.ops.length;
        $("scrub").value = ui.upTo;
    }

    function setUpTo(n) {
        ui.upTo = Math.max(0, Math.min(game.ops.length, n));
        if (isViewing()) { Entry.exitMode(); }
        syncScrub();
        refresh();
    }

    function isViewing() { return ui.upTo < game.ops.length; }

    // SAVED / SAVING / NOT SAVED / TEST GAME
    function setSave(state, detail) {
        var el = $("saveChip");
        el.className = "chip save " + state;
        el.textContent = { ok: "SAVED", saving: "SAVING", bad: "NOT SAVED", test: "TEST GAME" }[state];
        el.title = state === "bad" ? "Not stored on this device: " + (detail || "") + ". Export the game to keep it." :
            (state === "test" ? "A test game: the first play you log saves a practice copy" : (detail || ""));
    }

    // ------------------------------------------------------------ ops

    function nextSeq() {
        var m = 0, i;
        for (i = 0; i < game.ops.length; i++) { if (game.ops[i].seq > m) { m = game.ops[i].seq; } }
        return m + 1;
    }
    function newEventId() { return device + "-e" + nextSeq(); }

    // One line describing an event in a given Result (for toasts).
    function describe(eventId, evs, res) {
        var i, ev = null, play = null;
        for (i = 0; i < evs.length; i++) { if (evs[i].id === eventId) { ev = evs[i]; break; } }
        for (i = 0; i < res.plays.length; i++) { if (res.plays[i].id === eventId) { play = res.plays[i]; break; } }
        return ev ? Fmt.event(ev, res.codes, play && play.text) : "";
    }

    // Append one op: stored on the device first, then applied and drawn.
    // why: LIVE / EDIT / INSERT / DELETE / UNDO (for the toast). Returns false
    // if refused (viewing history, or another op still being stored).
    function commit(op, why) { return commitBatch([op], why); }

    // Several ops for one tap (a spot foul, moving a drive's start): stored in
    // order, then applied together; UNDO takes them all back (op.batch).
    // text: the toast instead of the first op's event.
    function commitBatch(list, why, text) {
        var beforeText, g = game, t0, stored = false, seq, i, chain;
        if (!list.length || guard || isViewing()) { return false; }
        guard = true;
        beforeText = list[0].eventId ? describe(list[0].eventId, events, result) : "";
        seq = nextSeq();
        for (i = 0; i < list.length; i++) {
            list[i].seq = seq + i;
            list[i].opId = device + "-" + list[i].seq;
            list[i].at = Date.now();
            if (list.length > 1) { list[i].batch = list[0].opId; }
        }
        if (text && why !== "UNDO") { list[0].note = text; }     // what UNDO says it took back
        setSave("saving");
        t0 = performance.now();
        chain = ensureStored();
        list.forEach(function (op) { chain = chain.then(function () { return Store.putOp(g.id, op); }); });
        chain.then(function () {
            var ms = performance.now() - t0;
            stored = true;
            setSave("ok", "Last op stored in " + ms.toFixed(1) + " ms");
            $("hudStore").textContent = "store " + ms.toFixed(1) + " ms";
        }, function (e) {
            setSave("bad", e && e.message);
        }).then(function () {
            guard = false;
            if (game === g) { apply(list, why, beforeText, text); }
            if (stored) { Sync.kick(); }
        });
        return true;
    }

    function apply(list, why, beforeText, text) {
        Array.prototype.push.apply(game.ops, list);
        ui.upTo = game.ops.length;
        syncScrub();
        refresh();
        if (text) { toast(text, why !== "UNDO"); } else { afterCommit(list[0], why, beforeText); }
        Huddles.refresh();
        measurePaint();
    }

    // Validate against the live Result, then append as an ADD.
    function addEvent(ev) {
        var v;
        if (isViewing()) { return { ok: false, reason: "Viewing an earlier point: go live first" }; }
        v = StatsEngine.validate(result, ev);
        if (!v.ok) { return v; }
        if (!commit({ kind: "ADD", eventId: newEventId(), event: ev }, "LIVE")) { return { ok: false, reason: "Not logged, try again" }; }
        return { ok: true, reason: "" };
    }

    // Undo = the inverse of the newest op that is not an undo and not undone.
    function undoTarget() {
        var undone = {}, i, o;
        for (i = 0; i < game.ops.length; i++) { if (game.ops[i].undoOf) { undone[game.ops[i].undoOf] = true; } }
        for (i = game.ops.length - 1; i >= 0; i--) {
            o = game.ops[i];
            if (!o.undoOf && !undone[o.opId]) { return o; }
        }
        return null;
    }
    function canUndo() { return !isViewing() && !!undoTarget(); }
    function undo() {
        var target = undoTarget(), list = [], inv, i, o, undone = {}, batch;
        if (!target || isViewing()) { return; }
        batch = target.batch ? game.ops.filter(function (x) { return x.batch === target.batch; }) : [target];
        for (i = 0; i < game.ops.length; i++) { if (game.ops[i].undoOf) { undone[game.ops[i].undoOf] = true; } }
        for (i = batch.length - 1; i >= 0; i--) {
            o = batch[i];
            if (undone[o.opId]) { continue; }
            inv = StatsOps.inverse(game.ops, o);
            if (!inv) { toast("Can't undo that", false); return; }
            inv.undoOf = o.opId;
            list.push(inv);
        }
        if (list.length === 1) { commit(list[0], "UNDO"); return; }
        commitBatch(list, "UNDO", "Undone: " + (batch[0].note || describe(batch[0].eventId, events, result) || "the last change"));
    }

    // ------------------------------------------------------------ toast

    function afterCommit(op, why, beforeText) {
        var play = null, i, sit = result.situation, hl;
        if (why === "UNDO") { toast("Undone: " + (beforeText || describe(op.eventId, events, result)), false); return; }
        if (why === "DELETE") { toast("Deleted: " + beforeText, true); return; }
        for (i = result.plays.length - 1; i >= 0; i--) { if (result.plays[i].id === op.eventId) { play = result.plays[i]; break; } }
        if (play && play.turnover === "DOWNS") {
            toast("Turnover on downs: " + result.codes[sit.offense] + " ball at " + Fmt.spot(sit.spot, result.codes), true, "downs", 8000);
            return;
        }
        hl = why === "LIVE" && play ? highlights(play) : "";
        if (hl) { toast(hl + "  -  " + describe(op.eventId, events, result).replace(/, 1ST DOWN/, ""), true, "hl", 6000); return; }
        toast((why === "EDIT" ? "Saved: " : (why === "INSERT" ? "Added: " : "")) + describe(op.eventId, events, result), true);
    }

    // What a new play earned, for the toast: a 1st down (3RD / 4TH DOWN CONVERTED when it came on 3rd / 4th
    // down) and a big play (15+, 20+ ... 50+ yards).
    function highlights(p) {
        var out = [], big;
        if (p.firstDown && !p.td) { out.push(p.down === 3 ? "3RD DOWN CONVERTED" : (p.down === 4 ? "4TH DOWN CONVERTED" : "1ST DOWN")); }
        if ((p.type === "RUSH" || p.type === "PASS") && p.yards >= 15) {
            big = Math.min(50, Math.floor(p.yards / 5) * 5);
            out.push(big + "+ YARD PLAY");
        }
        return out.join("  |  ");
    }

    // The toast never blocks the controls: pointer-events none except UNDO.
    function toast(text, withUndo, kind, ms) {
        var el = $("toast");
        el.className = "toast show" + (kind ? " " + kind : "");
        $("toastText").textContent = text;
        $("toastUndo").hidden = !withUndo;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.className = "toast"; }, ms || 4000);
    }

    function measurePaint() {
        var t = lastDown;
        if (!t) { return; }
        requestAnimationFrame(function () {
            setTimeout(function () {
                $("hudTap").textContent = "tap→paint " + Math.round(performance.now() - t) + " ms";
            }, 0);
        });
        lastDown = 0;
    }

    function store(k, v) { try { localStorage.setItem("statsapp." + k, v); } catch (e) { /* private mode */ } }
    function recall(k) { try { return localStorage.getItem("statsapp." + k); } catch (e) { return null; } }

    // FLIP FIELD: the picture only (HOME on the left); remembered on this device.
    function setFlip(on) {
        Field.setFlip(View.fieldRef(), on);
        document.body.classList.toggle("flipped", on);
        $("flipField").setAttribute("aria-pressed", on ? "true" : "false");
        $("flipField").classList.toggle("on", on);
        store("flipField", on ? "1" : "0");
        if (result) { refresh(); }
    }

    // ZOOM: each tap = the next level: whole field -> 50 yards -> 25 yards -> whole field, the line of
    // scrimmage in the middle (kept on this device).
    function setZoom(level) {
        Field.setZoom(level);
        level = Field.zoom;
        $("zoomField").textContent = level ? "ZOOM " + (level === 1 ? 50 : 25) : "ZOOM";
        $("zoomField").setAttribute("aria-pressed", level ? "true" : "false");
        $("zoomField").classList.toggle("on", !!level);
        store("zoomLevel", String(level));
        if (result) { refresh(); }
    }

    // ------------------------------------------------------------ sources

    function fixtures() { return typeof STATS_FIXTURES !== "undefined" ? STATS_FIXTURES : []; }

    function option(value, text) {
        var o = document.createElement("option");
        o.value = value; o.textContent = text;
        return o;
    }

    // The game menu: saved games (newest first), then the test games.
    function fillSources() {
        var list = Store.ok ? Store.listGames() : Promise.resolve([]);
        return list.catch(function () { return []; }).then(function (saved) {
            var sel = $("src"), grp, i, fx = fixtures();
            sel.innerHTML = "";
            grp = document.createElement("optgroup");
            grp.label = Store.ok ? "Saved games" : "Saved games (storage off)";
            for (i = 0; i < saved.length; i++) { grp.appendChild(option("g:" + saved[i].id, saved[i].name)); }
            if (game.id && !saved.some(function (s) { return s.id === game.id; })) { grp.appendChild(option("g:" + game.id, game.name)); }
            if (!grp.children.length) { grp.appendChild(option("", "none yet")).disabled = true; }
            sel.appendChild(grp);
            grp = document.createElement("optgroup");
            grp.label = "Test games (read-only)";
            for (i = 0; i < fx.length; i++) { grp.appendChild(option("f:" + fx[i].name, fx[i].name)); }
            sel.appendChild(grp);
            if (game.id || game.fixture) { sel.value = keyOf(game); }
        });
    }
    function addOption(g) {
        var grp = $("src").querySelector("optgroup");
        if (grp && !$("src").querySelector('option[value="g:' + g.id.replace(/"/g, "") + '"]')) {
            grp.insertBefore(option("g:" + g.id, g.name), grp.firstChild);
        }
    }

    function loadFixture(name) {
        var fx = fixtures().filter(function (f) { return f.name === name; })[0];
        if (!fx) { return false; }
        load({ id: null, name: fx.name, setup: fx.setup, ops: normalizeOps(fx.ops), ready: null, fixture: fx.name });
        return true;
    }

    function openSaved(id) {
        return Store.loadGame(id).then(function (rec) {
            if (!rec) { return false; }
            rec.ready = Promise.resolve();
            rec.fixture = null;
            load(rec);
            return true;
        });
    }

    function openKey(key) {
        if (key && key.indexOf("g:") === 0 && Store.ok) {
            return openSaved(key.slice(2)).then(function (ok) { if (!ok) { openDefault(); } }, openDefault);
        }
        if (key && key.indexOf("f:") === 0 && loadFixture(key.slice(2))) { return Promise.resolve(); }
        openDefault();
        return Promise.resolve();
    }

    function openDefault() {
        var fx = fixtures(), real = fx.filter(function (f) { return /^real_/.test(f.name); })[0] || fx[0];
        if (!real || !loadFixture(real.name)) { load({ id: null, name: "", setup: {}, ops: [], ready: null, fixture: "" }); }
    }

    function choose(key) {
        openKey(key).then(function () {
            if (Store.ok) { Store.setCurrent(keyOf(game)).catch(function () { /* not fatal */ }); }
        });
    }

    function openFile(file) {
        var r = new FileReader();
        r.onload = function () {
            var parsed;
            try { parsed = parseGame(String(r.result), file.name); }
            catch (e) { alert("Couldn't read " + file.name + ": " + e.message); return; }
            importGame(parsed, file.name);
        };
        r.readAsText(file);
    }

    // ------------------------------------------------------------ wiring

    // LOG | PLAYERS. The PLAYERS page (players.html, GRIDIRON's) loads the first time it is opened and
    // is told when a team changes. The tab is remembered on this device.
    // THEME (the menu): AUTO follows the device, LIGHT / DARK fix it (kept on this device).
    function setTheme(v) {
        if (v === "light" || v === "dark") { document.documentElement.setAttribute("data-theme", v); }
        else { v = "auto"; document.documentElement.removeAttribute("data-theme"); }
        Array.prototype.forEach.call($("themeSeg").querySelectorAll("button"), function (b) { b.classList.toggle("on", b.getAttribute("data-theme") === v); });
        store("theme", v);
    }

    // PLAYER TRACKING (the menu): OFF = team stats only: the jersey cards, the player tags on the drive
    // log and the player lines in Stats are hidden (players already on plays stay in the log).
    function setTracking(on) {
        document.body.classList.toggle("noplayers", !on);
        Array.prototype.forEach.call($("trackSeg").querySelectorAll("button"), function (b) { b.classList.toggle("on", (b.getAttribute("data-track") === "on") === on); });
        store("tracking", on ? "on" : "off");
        if (result) { refresh(); }
    }

    // The menu: slides in from the right over the page (the field stays usable on the left).
    function drawer(open) {
        $("drawer").classList.toggle("open", open);
        $("drawerScrim").hidden = !open;
        $("menuBtn").classList.toggle("on", open);
    }

    function initTabs() {
        var frame = $("playersFrame"), cur = "log";
        function show(tab) {
            cur = tab;
            Array.prototype.forEach.call($("mainTabs").querySelectorAll("button"), function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === tab); });
            $("logTab").hidden = tab !== "log";
            $("playersTab").hidden = tab !== "players";
            document.body.classList.toggle("tab-players", tab === "players");
            if (tab === "players") {
                if (!frame.getAttribute("src")) { frame.setAttribute("src", "players.html"); }
                else if (frame.contentWindow && frame.contentWindow.refresh) { frame.contentWindow.refresh(); }
            }
            try { localStorage.setItem("statsapp.tab", tab); } catch (e) { /* private mode */ }
        }
        $("mainTabs").addEventListener("click", function (e) { var b = e.target.closest("[data-tab]"); if (b) { show(b.getAttribute("data-tab")); drawer(false); } });
        Teams.on(function () { if (cur === "players" && frame.contentWindow && frame.contentWindow.refresh) { frame.contentWindow.refresh(); } });
        try { if (localStorage.getItem("statsapp.tab") === "players") { show("players"); } } catch (e) { /* private mode */ }
    }

    function init() {
        Keypad.init();
        View.init();
        Entry.init();
        Center.init();
        Players.init();
        initTabs();
        $("drawerClose").addEventListener("click", function () { drawer(false); });
        $("drawerScrim").addEventListener("click", function () { drawer(false); });
        $("drawerGame").addEventListener("click", function () { Huddles.game(); });
        $("themeSeg").addEventListener("click", function (e) { var b = e.target.closest("[data-theme]"); if (b) { setTheme(b.getAttribute("data-theme")); } });
        setTheme(recall("theme") || "auto");
        $("trackSeg").addEventListener("click", function (e) { var b = e.target.closest("[data-track]"); if (b) { setTracking(b.getAttribute("data-track") === "on"); } });
        setTracking(recall("tracking") !== "off");
        document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("huddle").open) { drawer(false); } });
        Huddles.init();
        $("ver").textContent = "app " + APP_VERSION + " · engine " + StatsEngine.VERSION;

        document.addEventListener("pointerdown", function () { lastDown = performance.now(); }, true);

        $("src").addEventListener("change", function () { if (this.value) { choose(this.value); } });
        $("file").addEventListener("change", function () {
            if (this.files[0]) { openFile(this.files[0]); }
            this.value = "";
        });
        $("export").addEventListener("click", exportGame);
        $("scrub").addEventListener("input", function () { setUpTo(+this.value); });
        $("stepBack").addEventListener("click", function () { setUpTo(ui.upTo - 1); });
        $("stepFwd").addEventListener("click", function () { setUpTo(ui.upTo + 1); });
        $("goLive").addEventListener("click", function () { setUpTo(game.ops.length); });

        $("enPoss").addEventListener("click", function (e) {
            var b = e.target.closest("[data-poss]"), side;
            if (!b || b.disabled) { return; }
            side = b.getAttribute("data-poss");
            if (side === (result.situation.offense || "NONE")) { return; }
            Center.possession(side, b);
        });
        $("enUndo").addEventListener("click", undo);
        $("toastUndo").addEventListener("click", undo);
        $("enGame").addEventListener("click", function () { Huddles.game(); });

        // The strip: BALL = possession (the same path as the entry panel's
        // buttons, so the open-drive checks apply), dots = timeouts, score = fix,
        // period / menu = the GAME huddle.
        $("strip").addEventListener("click", function (e) {
            var t = e.target, b, side, k, left, set, have;
            if (t.closest("#menuBtn")) { drawer(!$("drawer").classList.contains("open")); return; }
            if (t.closest("#period")) { Huddles.game(); return; }
            if (t.closest("#situW")) { Center.ddEdit(); return; }
            if ((b = t.closest("[data-fix]"))) { Huddles.scoreFix(b.getAttribute("data-fix")); return; }
            if ((b = t.closest("[data-dot]"))) {
                side = b.getAttribute("data-dot").split(":")[0];
                k = +b.getAttribute("data-dot").split(":")[1];
                have = result.timeouts[side];
                left = k <= have ? k - 1 : k;                  // tap a full dot = use it; an empty one = give it back
                set = { AWAY: result.timeouts.AWAY, HOME: result.timeouts.HOME };
                set[side] = left;
                b = addEvent({ kind: "TIMEOUT", set: set, period: result.situation.period });
                if (!b.ok) { toast(b.reason, false); }
                return;
            }
            if ((b = t.closest("[data-ball]"))) {
                side = b.getAttribute("data-ball");
                b = document.querySelector('#enPoss [data-poss="' + (result.situation.offense === side ? "NONE" : side) + '"]');
                if (b && !b.disabled) { b.click(); }
            }
        });
        $("flipField").addEventListener("click", function () { setFlip(!Field.flipped); });
        setFlip(recall("flipField") === "1");
        $("zoomField").addEventListener("click", function () { setZoom((Field.zoom + 1) % 3); });
        setZoom(+(recall("zoomLevel") || 0));

        $("listTabs").addEventListener("click", function (e) {
            var b = e.target.closest("button");
            if (!b) { return; }
            ui.tab = b.getAttribute("data-v");
            View.render(result, ui, Entry.fieldSituation(), events);
        });
        $("driveTeam").addEventListener("click", function (e) {
            var b = e.target.closest("button");
            if (!b) { return; }
            ui.driveTeam = b.getAttribute("data-v");
            View.render(result, ui, Entry.fieldSituation(), events);
        });
        $("listBody").addEventListener("click", function (e) {
            var d = e.target.closest("[data-drive]"), ev = e.target.closest("[data-ev]"), n, sl = e.target.closest(".pslot");
            if (sl && ev) { Center.pickSlot(ev.getAttribute("data-ev"), sl.getAttribute("data-role")); return; }
            n = e.target.closest("[data-dfold]");
            if (n) { View.foldDrive(+n.getAttribute("data-dfold")); View.render(result, ui, Entry.fieldSituation(), events); return; }
            if (d) {
                n = +d.getAttribute("data-drive");
                ui.drive = ui.drive === n ? null : n;
                ui.tab = ui.drive === null ? ui.tab : "plays";
                View.render(result, ui, Entry.fieldSituation(), events);
            } else if (ev) {
                Huddles.event(ev.getAttribute("data-ev"));
            }
        });
        $("playFilter").addEventListener("click", function () { ui.drive = null; View.render(result, ui, Entry.fieldSituation(), events); });

        // Show something at once, then restore the last game from the device.
        openDefault();
        Store.open().catch(function () { /* Store.ok stays false */ }).then(function () {
            if (!Store.ok) { setSave("bad", Store.error); }
            if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () { /* best effort */ }); }
            return fillSources();
        }).then(function () {
            return Store.ok ? Store.getCurrent().catch(function () { return null; }) : null;
        }).then(function (key) {
            return key ? openKey(key) : null;
        }).then(function () {
            if (!Store.ok) { setSave("bad", Store.error); }
            Sync.start();
        });
        registerWorker();
    }

    // The service worker keeps the app on the device for offline use. Browsers
    // only allow it on https:// or localhost, not on a plain http:// LAN address.
    function registerWorker() {
        var ver = $("ver"), base = ver.textContent;
        function say(t) { ver.textContent = base + " · " + t; }
        if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) { say("no offline copy (opened from a file)"); return; }
        if (!window.isSecureContext) { say("no offline copy (needs https)"); return; }
        navigator.serviceWorker.register("sw.js").then(function (reg) {
            return navigator.serviceWorker.ready.then(function () { say("offline ready"); return reg; });
        }, function (e) { say("no offline copy (" + e.message + ")"); });
    }

    document.addEventListener("DOMContentLoaded", init);

    return {
        version: APP_VERSION,
        parseGame: parseGame,
        toJsonl: toJsonl,
        refresh: refresh,
        commit: commit,
        commitBatch: commitBatch,
        addEvent: addEvent,
        toast: toast,
        newEventId: newEventId,
        newGame: newGame,
        exportGame: exportGame,
        deleteGame: deleteGame,
        undo: undo,
        canUndo: canUndo,
        isViewing: isViewing,
        get result() { return result; },
        get events() { return events; },
        get game() { return game; }
    };
})();
