/*
 * stats/app/js/players.js - the PLAYERS card (the Logger's player slots,
 * statsapp/Logger.html build 272, one grid per team, not split by position).
 *
 *   - 5 rows of 4 slots for the team with the ball. Tap an empty slot or hold
 *     any slot to set its jersey (number or name, from the team's roster).
 *   - The gestures (center.js, next to the field they drop on): drag a player
 *     onto the field = a run to that spot; drag a player onto another player =
 *     a pass to them, then on to the catch spot (let go off the field = an
 *     incomplete pass to them). Letting go logs it, like the play buttons.
 *
 * Rosters come from the app's team list (teams.js: the PLAYERS tab edits it;
 * season stats there drive the picker's PASSING / RUSHING / RECEIVING
 * filters), else the Google Sheet's roster tabs, else PLAYBOOK's team file
 * through the stand-in; the last copy is kept on this device. The slots
 * are kept per team code on this device. Nothing here is game state: plays
 * store only the jerseys (players: { passer, receiver, rusher }).
 */
var Players = (function () {

    var $ = function (id) { return document.getElementById(id); };
    var esc = Fmt.esc;
    // The grid size (ARRANGE): rows x columns, the same for both teams, kept on this device.
    // Slots past rows x columns are kept and come back when the grid grows.
    function dims() {
        var d = store("statsapp.slotDims") || {};
        return { r: Math.max(1, Math.min(8, +d.r || 5)), c: Math.max(2, Math.min(8, +d.c || 4)) };
    }
    var ROSTER = {}, asked = {}, SLOTS = {}, NOTE = {}, BUSY = {};   // NOTE[code]: why there is no roster
    var pickerList = null;        // the open picker's list redraw (a roster that arrives late fills it)

    function store(k, v) { try { if (v === undefined) { return JSON.parse(localStorage.getItem(k) || "null"); } localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } return null; }

    function codeOf(side) { return App.result ? App.result.codes[side] : side; }

    // ------------------------------------------------------------ rosters

    // The app's team list first (teams.js), as picker rows { n, name, last, pos, active, season }.
    var TEAMR = {};
    function fromTeam(c) {
        var t = typeof Teams !== "undefined" ? Teams.get(c) : null;
        if (!t || !t.players || !t.players.length) { return null; }
        if (!TEAMR[c] || TEAMR[c].t !== t) {
            TEAMR[c] = { t: t, r: t.players.map(function (p) {
                var nm = ((p.first || "") + " " + (p.last || "")).trim();
                return { n: String(p.jersey), name: nm, last: p.last || nm, pos: p.pos || "", active: p.active !== false, season: p.season || {} };
            }) };
        }
        return TEAMR[c].r;
    }
    function roster(side) {
        var c = codeOf(side), t = fromTeam(c);
        if (t) { return t; }
        if (!ROSTER[c]) { ROSTER[c] = store("statsapp.roster." + c) || []; load(side, c); }
        return ROSTER[c];
    }
    function done(code) { BUSY[code] = false; if (pickerList && $("pkList")) { $("pkList").innerHTML = pickerList(); } }
    function got(code, players) {
        ROSTER[code] = players;
        NOTE[code] = "";
        store("statsapp.roster." + code, players);
        render();
        Center.render();
        if (pickerList && $("pkList")) { $("pkList").innerHTML = pickerList(); }
    }
    // Where the roster comes from: the Google Sheet's Away Roster / Home Roster tab when the app
    // syncs to the sheet (by side: the sheet holds tonight's two teams), else PLAYBOOK's team
    // file through the stand-in (by code). The last copy stays on this device for offline.
    function fromStandin(code) {
        return fetch("../roster?code=" + encodeURIComponent(code), { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.ok && j.players && j.players.length) { got(code, j.players); return; }
                NOTE[code] = (NOTE[code] ? NOTE[code] + " " : "") + "The stand-in has no team file for " + code + " (data/teams/" + code + ".xml in the Playbook folder).";
            });
    }
    var sheetAsk = null;
    function fromSheet(sh) {
        if (!sheetAsk) {
            sheetAsk = fetch(sh.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify({ rosters: true, key: sh.key || undefined }) })
                .then(function (r) { return r.json(); })
                .then(function (j) { if (!j || !j.ok || !j.rosters) { throw new Error((j && j.error) || "no rosters"); } return j.rosters; });
            sheetAsk.catch(function () { sheetAsk = null; });   // ask again next time
        }
        return sheetAsk;
    }
    // The sheet's tabs hold whichever game is set up there: use them only for the same team
    // (the sheet's Bound Import name matches this game's team name or code).
    function sameTeam(side, sheetName) {
        var su = (App.game && App.game.setup) || {}, t = (side === "AWAY" ? su.away : su.home) || {},
            norm = function (x) { return String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); },
            a = norm(sheetName), n = norm(t.name), c = norm(t.code || codeOf(side));
        if (!a) { return false; }
        return a === c || (n && (a === n || a.indexOf(n) === 0 || n.indexOf(a) === 0));
    }
    function load(side, code) {
        var sh = typeof Sync !== "undefined" && Sync.sheet ? Sync.sheet() : null;
        if (asked[code] || typeof fetch === "undefined") { return; }
        asked[code] = true;
        BUSY[code] = true;
        NOTE[code] = "";
        (sh ? fromSheet(sh).then(function (r) {
            var t = r[side];
            if (t && t.players && t.players.length && sameTeam(side, t.name)) { got(code, t.players); return; }
            NOTE[code] = t && t.name && !sameTeam(side, t.name) ? "The sheet's " + side.toLowerCase() + " team is " + t.name + " (Bound Import), not this game's." :
                "The sheet's " + (side === "AWAY" ? "Away" : "Home") + " Roster tab is empty.";
            return fromStandin(code);
        }) : fromStandin(code))
            .catch(function (e) {
                NOTE[code] = (NOTE[code] ? NOTE[code] + " " : "") + "Couldn't reach the roster source (" + (e && e.message ? e.message : e) + ").";
                return sh ? fromStandin(code).catch(function () { /* the copy on this device (or numbers only) */ }) : null;
            })
            .then(function () { done(code); });
    }
    // Ask the sheet / stand-in again (after a roster is edited there).
    function reload() {
        var res = App.result;
        if (!res) { return; }
        if (typeof Teams !== "undefined") { Teams.reload(res.codes.AWAY); Teams.reload(res.codes.HOME); }
        ["AWAY", "HOME"].forEach(function (sd) { var c = res.codes[sd]; asked[c] = false; delete ROSTER[c]; });
        if (Sync.sheet && Sync.sheet()) { sheetAsk = null; }
        roster("AWAY"); roster("HOME");
        if (pickerList && $("pkList")) { $("pkList").innerHTML = pickerList(); }
    }
    function player(side, n) {
        var r = roster(side), i;
        for (i = 0; i < r.length; i++) { if (String(r[i].n) === String(n)) { return r[i]; } }
        return null;
    }
    function last(side, n) { var p = player(side, n); return p ? String(p.last || p.name || "").toUpperCase() : ""; }
    // "#7 SIMPSON" (just "#7" when the roster doesn't have that jersey)
    function name(side, n) { var l = last(side, n); return n ? "#" + n + (l ? " " + l : "") : ""; }

    // ------------------------------------------------------------ slots

    function slots(side) {
        var c = codeOf(side), s = SLOTS[c];
        if (!s) {
            s = store("statsapp.slots." + c) || [];
            SLOTS[c] = s;
        }
        while (s.length < dims().r * dims().c) { s.push(""); }
        return s;
    }
    function saveSlots(side) { store("statsapp.slots." + codeOf(side), slots(side)); }

    // The team the grid follows: the offense, else the open drive's team, else the next drive's.
    function auto() {
        var res = App.result, sit = res.situation, ds = res.drives, ld = ds.length ? ds[ds.length - 1] : null;
        return sit.offense || (ld && ld.open ? ld.side : null) || Center.nextSide();
    }
    // The team the grid shows: the AWAY / HOME toggle picks one; it goes back to following the ball
    // when the ball changes hands.
    var VIEW = null, VIEW_AT = null;
    function side() {
        var a = auto();
        if (VIEW && VIEW_AT === a) { return VIEW; }
        VIEW = null;
        return a;
    }
    function show(sd) { var a = auto(); VIEW = sd === a ? null : sd; VIEW_AT = a; render(); }
    // "Add another": after a jersey goes in a slot, the picker opens on the next empty slot (kept on this device)
    var MORE = store("statsapp.addAnother") === true;

    // What each jersey did tonight: thrown / caught / carried -> the tile's coloured edge.
    function roles(sd) {
        var out = {}, p = App.result.plays, i, pl;
        function mark(n, r) { if (n) { (out[n] = out[n] || {})[r] = 1; } }
        for (i = 0; i < p.length; i++) {
            pl = p[i].players;
            if (!pl || p[i].offense !== sd) { continue; }
            mark(pl.passer, "qb"); mark(pl.receiver, "wr"); mark(pl.rusher, "rb");
        }
        return out;
    }

    function render() {
        var C = $("playersCard"), sd, s, h = "", i, n, r, rl, pend, cls, sel;
        if (!C || !App.result) { return; }
        sd = side();
        s = slots(sd);
        rl = roles(sd);
        pend = Center.pending();
        sel = pend ? [pend.qb, pend.rec, pend.car] : [];
        var g = dims();
        for (i = 0; i < g.r * g.c; i++) {
            n = s[i];
            if (!n) { h += '<div class="tok key" data-j="" data-idx="' + i + '">+<small>SET</small></div>'; continue; }
            r = rl[n] ? Object.keys(rl[n]) : [];
            cls = "tok" + (r.length > 1 ? " mix" : (r.length ? " " + r[0] : "")) + (sel.indexOf(n) >= 0 ? " sel" : "");
            h += '<div class="' + cls + '" data-j="' + esc(n) + '" data-idx="' + i + '">' + esc(n) + '<small>' + esc(last(sd, n)) + '</small></div>';
        }
        C.innerHTML = '<div class="plhead"><div class="seg pltabs">' + ["AWAY", "HOME"].map(function (k) {
                return '<button class="' + k.toLowerCase() + (k === sd ? ' on' : '') + '" data-plside="' + k + '" title="' + esc(View.teamName(k, App.result.codes)) + '">' + esc(codeOf(k)) + '</button>';
            }).join("") + '</div><div class="cardLbl">PLAYERS - ' + esc(View.teamName(sd, App.result.codes)) +
            (sd !== auto() ? ' <span class="hint off">- not the team with the ball: hold a slot to set it</span>' :
            ' <span class="hint">- drag onto the field = run, onto a player then the field = pass | hold a slot to set it</span>') + '</div>' +
            '<button class="btn" data-arrange="1" title="Rows, columns and the order of the slots">ARRANGE</button></div>' +
            '<div id="plGrid" style="grid-template-columns:repeat(' + g.c + ',minmax(0,1fr))">' + h + '</div>';
    }

    // ARRANGE (the Logger's Arrange Players huddle): rows / columns for the grid (both teams), drag a
    // tile onto another spot to move it there (the others shift along), tap a tile to set / clear it.
    function arrange() {
        var sd = side(), mv = null;
        function draw() {
            var g = dims(), s = slots(sd), h = "", i, n;
            for (i = 0; i < g.r * g.c; i++) {
                n = s[i];
                h += '<div class="atok' + (n ? '' : ' empty') + '" data-i="' + i + '">' + (n ? esc(n) + '<small>' + esc(last(sd, n)) + '</small>' : '+<small>EMPTY</small>') + '</div>';
            }
            return '<div class="arrDims"><span class="k">ROWS</span><button class="btn" data-act="dim" data-v="r:-1">&minus;</button><b>' + g.r + '</b><button class="btn" data-act="dim" data-v="r:1">+</button>' +
                '<span class="k">COLUMNS</span><button class="btn" data-act="dim" data-v="c:-1">&minus;</button><b>' + g.c + '</b><button class="btn" data-act="dim" data-v="c:1">+</button></div>' +
                '<p class="muted">Drag a tile onto another spot to move it there - tap a tile to set or clear its player. The size is the same for both teams.</p>' +
                (function () {
                    var hid = slots(sd).slice(g.r * g.c).filter(function (x) { return x; });
                    return hid.length ? '<p class="arrHid">' + hid.length + ' player' + (hid.length > 1 ? 's are' : ' is') + ' past the last tile (kept, not shown): ' +
                        hid.map(function (n) { return '#' + esc(n); }).join(" ") + ' - add rows / columns to show them again</p>' : '';
                }()) +
                '<div id="arrGrid" style="grid-template-columns:repeat(' + g.c + ',minmax(0,1fr))">' + h + '</div>' +
                '<div class="hrow end"><button class="btn big primary" data-act="close">DONE</button></div>';
        }
        Huddles.custom("Arrange players - " + codeOf(sd), {
            render: draw,
            act: function (a, v) {
                var g = dims(), k, n;
                if (a !== "dim") { return; }
                k = v.split(":")[0]; n = +v.split(":")[1];
                g[k] = g[k] + n;
                store("statsapp.slotDims", { r: Math.max(1, Math.min(8, g.r)), c: Math.max(2, Math.min(8, g.c)) });
                slots(sd);
                Huddles.refresh();
                render();
            },
            onClose: function () { render(); }
        });
        var body = $("hBody");
        if (body._arr) { return; }
        body._arr = true;
        body.addEventListener("pointerdown", function (e) {
            var t = e.target.closest && e.target.closest("#arrGrid .atok");
            if (!t) { return; }
            e.preventDefault();
            mv = { from: +t.getAttribute("data-i"), t: t, x0: e.clientX, y0: e.clientY, moved: false, to: null };
            try { body.setPointerCapture(e.pointerId); } catch (x) { /* old browsers */ }
        });
        body.addEventListener("pointermove", function (e) {
            var u, o;
            if (!mv) { return; }
            if (!mv.moved && Math.abs(e.clientX - mv.x0) + Math.abs(e.clientY - mv.y0) < 8) { return; }
            mv.moved = true; mv.t.classList.add("lift");
            u = document.elementFromPoint(e.clientX, e.clientY); o = u && u.closest && u.closest("#arrGrid .atok");
            Array.prototype.forEach.call(body.querySelectorAll(".atok.over"), function (x) { x.classList.remove("over"); });
            mv.to = o && o !== mv.t ? +o.getAttribute("data-i") : null;
            if (o && o !== mv.t) { o.classList.add("over"); }
        });
        body.addEventListener("pointerup", function () {
            var m = mv, sd2 = side(), s, it;
            mv = null;
            if (!m) { return; }
            s = slots(sd2);
            if (!m.moved) { editSlot(m.from); return; }
            if (m.to !== null && m.to !== m.from) { it = s.splice(m.from, 1)[0]; s.splice(m.to, 0, it); saveSlots(sd2); buzz(); }
            if (Huddles.current) { Huddles.refresh(); }
            render();
        });
    }

    // ------------------------------------------------------------ set a slot (the player picker)

    function matches(sd, q) {
        var r = roster(sd), words, out = [];
        q = String(q || "").trim().toLowerCase();
        if (!q) { return r.slice(); }
        words = q.split(/\s+/);
        r.forEach(function (p) {
            var nm = String(p.name || "").toLowerCase(), lst = String(p.last || "").toLowerCase(), score;
            if (/^\d+$/.test(q)) {
                if (String(p.n).indexOf(q) !== 0) { return; }
                score = String(p.n) === q ? 0 : 1;
            } else {
                if (!words.every(function (w) { return nm.indexOf(w) >= 0; })) { return; }
                score = lst.indexOf(words[0]) === 0 ? 0 : 2;
            }
            out.push({ p: p, s: score });
        });
        out.sort(function (a, b) { return a.s - b.s || (+a.p.n) - (+b.p.n); });
        return out.map(function (x) { return x.p; });
    }

    // PASSING / RUSHING / RECEIVING: the sport profile's stat groups with a filter.
    var FILTERS = [
        { id: "passing", label: "PASSING", filter: { count: "CATT", total: "PASSINGYDS", unit: "YDS" } },
        { id: "rushing", label: "RUSHING", filter: { count: "CAR", total: "RUSHINGYDS", unit: "YDS" } },
        { id: "receiving", label: "RECEIVING", filter: { count: "REC", total: "RECYDS", unit: "YDS" } }
    ];
    function filters() { var f = typeof Teams !== "undefined" ? Teams.filters() : []; return f.length ? f : FILTERS; }
    function num(v) { var x = parseFloat(String(v == null ? "" : v).split("/").pop()); return isNaN(x) ? 0 : x; }
    // tonight's line for that jersey in that group (the engine's player stats)
    function tonight(sd, n, gid) {
        var P = App.result && App.result.players && App.result.players[sd], l = P && P[n] && P[n][gid];
        return l && (l.att || l.rec) ? l : null;
    }
    function seasonOf(p, g) { return p.season && p.season[g.id] ? p.season[g.id] : null; }
    function hasStats(sd, p, g) {
        var s = seasonOf(p, g);
        return !!(s && (num(s[g.filter.count]) || num(s[g.filter.total]))) || !!tonight(sd, p.n, g.id);
    }
    function yards(sd, p, g) { var s = seasonOf(p, g), t = tonight(sd, p.n, g.id); return (s ? num(s[g.filter.total]) : 0) + (t ? t.yds : 0); }
    // "97/162  1216 YDS" (season) + "tonight 3/5 41" when there is one
    function statText(sd, p, g) {
        var s = seasonOf(p, g), t = tonight(sd, p.n, g.id), out = "";
        if (s && (s[g.filter.count] || s[g.filter.total])) { out = (s[g.filter.count] || "0") + "  " + (s[g.filter.total] || "0") + (g.filter.unit ? " " + g.filter.unit : ""); }
        if (t) { out += (out ? "  |  " : "") + "tonight " + (g.id === "passing" ? t.comp + "/" + t.att : (t.att || t.rec)) + " " + t.yds; }
        return out;
    }

    // A jersey slot: the picker, then that slot gets the player (a player sits in one slot only).
    function editSlot(idx) {
        var sd = side(), s = slots(sd);
        picker(sd, {
            title: "Player slot " + (idx + 1) + " - " + codeOf(sd), cur: s[idx], used: s, clearLabel: "Empty this slot", more: true,
            pick: function (v) {
                var dup = v ? s.indexOf(v) : -1, g = dims(), nx = -1, i;
                if (dup >= 0 && dup !== idx) { s[dup] = ""; }
                s[idx] = v;
                saveSlots(sd);
                render();
                if (!v || !MORE) { return; }
                for (i = 1; i < g.r * g.c && nx < 0; i++) { if (!s[(idx + i) % (g.r * g.c)]) { nx = (idx + i) % (g.r * g.c); } }
                if (nx >= 0) { setTimeout(function () { editSlot(nx); }, 0); }
                else { App.toast("Every " + codeOf(sd) + " slot is full", false); }
            }
        });
    }
    // A play's QB / receiver / ball carrier (the drive log): the picker with that stat group's filter on.
    function pickFor(sd, title, cur, flt, done) { picker(sd, { title: title, cur: cur, flt: flt, clearLabel: "Clear", pick: done }); }

    // The player picker: number or name, ALL / PASSING / RUSHING / RECEIVING, the team's roster.
    // o = { title, cur, used (jerseys shown dimmed), flt, clearLabel, pick(jersey or "") }
    function picker(sd, o) {
        var s = o.used || [], q = "", cur = o.cur, flt = o.flt || "";
        function group(id) { var f = filters(), i; for (i = 0; i < f.length; i++) { if (f[i].id === id) { return f[i]; } } return null; }
        function fltRow() {
            return '<button data-act="flt" data-v=""' + (flt ? '' : ' class="on"') + '>ALL</button>' + filters().map(function (g) {
                return '<button data-act="flt" data-v="' + esc(g.id) + '"' + (flt === g.id ? ' class="on"' : '') + '>' + esc(g.label) + '</button>';
            }).join("");
        }
        function list() {
            var m = matches(sd, q), h, g = flt ? group(flt) : null;
            if (g) {
                m = m.filter(function (p) { return hasStats(sd, p, g); });
                m.sort(function (a, b) { return yards(sd, b, g) - yards(sd, a, g); });
            }
            h = m.slice(0, 60).map(function (p, k) {
                var used = s.indexOf(String(p.n)) >= 0;
                return '<button class="pk' + (k === 0 && q ? ' top' : '') + (used ? ' used' : '') + (p.active === false ? ' off' : '') + '" data-act="pick" data-v="' + esc(p.n) + '"><b>#' + esc(p.n) + '</b> ' + esc(p.name) + ' <small>' + esc(p.pos || "") + '</small>' +
                    (g ? '<span class="pst">' + esc(statText(sd, p, g)) + '</span>' : '') + '</button>';
            }).join("");
            if (!h && g && roster(sd).length) { return '<p class="muted">No ' + esc(codeOf(sd)) + ' players with ' + esc(g.label.toLowerCase()) + ' stats' + (q ? ' matching "' + esc(q) + '"' : '') + '.</p>'; }
            if (/^\d{1,3}$/.test(q) && !player(sd, q)) { h = '<button class="pk top" data-act="pick" data-v="' + esc(q) + '"><b>#' + esc(q) + '</b> (not on the roster)</button>' + h; }
            if (!h && BUSY[codeOf(sd)]) { return '<p class="muted">Loading the ' + esc(codeOf(sd)) + ' roster...</p>'; }
            return h || '<p class="muted">' + (roster(sd).length ? "No match on the " + esc(codeOf(sd)) + " roster" : "No roster for " + esc(codeOf(sd)) + " on this device - type the jersey number, or add players on the PLAYERS tab." +
                (typeof Teams !== "undefined" && Teams.note(codeOf(sd)) ? " " + esc(Teams.note(codeOf(sd))) : (NOTE[codeOf(sd)] ? " " + esc(NOTE[codeOf(sd)]) : ""))) + '</p>';
        }
        function pick(v) {
            v = v ? String(v) : "";
            document.removeEventListener("keydown", onKey);
            Huddles.close();
            o.pick(v);
        }
        // KEYPAD (the Logger's picker): NAME (left) + # (right). The number pad by default; tap the name for an
        // on-screen QWERTY (a real keyboard works too: digits go to #, letters to the name). Typing a name lists
        // the matching players; tap one, or OK takes it (the top match). OK on a number takes that jersey.
        var tab = "list", K = { mode: "num", num: "", name: "", sel: null };
        try { tab = localStorage.getItem("statsapp.pickerTab") === "keys" ? "keys" : "list"; } catch (e) { /* private mode */ }
        function kMatches() { return K.name ? matches(sd, K.name).slice(0, 8) : []; }
        function keysHtml() {
            var pl = K.num ? player(sd, K.num) : null, sug = kMatches(), h, rows = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
            h = '<div class="kdisp"><button class="kbox name' + (K.mode === "name" ? ' on' : '') + '" data-act="kmode" data-v="name">' +
                (K.mode === "name" ? (K.name ? esc(K.name.toUpperCase()) + '<i class="kcur"></i>' : '<span class="ph">TAP TO TYPE A NAME</span>') :
                    (K.num ? (pl ? esc(String(pl.name).toUpperCase()) : '<span class="ph">NOT ON THE ROSTER</span>') : '<span class="ph">TAP TO TYPE A NAME</span>')) + '</button>' +
                '<button class="kbox num' + (K.mode === "num" ? ' on' : '') + '" data-act="kmode" data-v="num">' + (K.num ? esc(K.num) : '#') + '</button></div>';
            h += '<div class="ksug">' + (K.mode === "name" ?
                (sug.map(function (r, i) { return '<button class="chip' + ((K.sel ? K.sel === String(r.n) : i === 0) ? ' on' : '') + '" data-act="ksel" data-v="' + esc(r.n) + '">#' + esc(r.n) + ' ' + esc(r.name) + ' <small>' + esc(r.pos || "") + '</small></button>'; }).join("") ||
                    '<span class="muted">' + (K.name ? 'No match on the ' + esc(codeOf(sd)) + ' roster' : 'Start typing a first or last name') + '</span>') :
                '<span class="muted">' + (pl ? esc(pl.pos || "") : 'Type a number, or tap the name to search') + '</span>') + '</div>';
            if (K.mode === "num") {
                h += '<div class="kpad num">' + ["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLEAR", "0", "OK"].map(function (k) {
                    return '<button data-act="key" data-v="' + k + '"' + (k === "OK" ? ' class="ok"' : '') + '>' + k + '</button>'; }).join("") + '</div>';
            } else {
                rows.forEach(function (r, i) {
                    h += '<div class="kpad row" style="grid-template-columns:repeat(' + (i === 2 ? 10 : r.length) + ',minmax(0,1fr))">' +
                        r.split("").map(function (c) { return '<button data-act="key" data-v="' + c + '">' + c + '</button>'; }).join("") +
                        (i === 2 ? '<button data-act="key" data-v="DEL" style="grid-column:span 3">DEL</button>' : '') + '</div>';
                });
                h += '<div class="kpad row" style="grid-template-columns:1fr 3fr 1fr 1.4fr"><button data-act="key" data-v="123">123</button><button data-act="key" data-v="SPACE">SPACE</button>' +
                    '<button data-act="key" data-v="CLEAR">CLEAR</button><button class="ok" data-act="key" data-v="OK">OK</button></div>';
            }
            return h;
        }
        function kDraw() { var el = $("pkKeys"); if (el) { el.innerHTML = keysHtml(); } }
        function kKey(k) {
            var top;
            if (k === "OK") {
                if (K.mode === "num") { if (K.num) { pick(K.num); } else { App.toast("Type a jersey number first", false, "bad"); } return; }
                top = K.sel || (kMatches()[0] ? String(kMatches()[0].n) : "");
                if (top) { pick(top); } else { App.toast(K.name ? "No match on the " + codeOf(sd) + " roster" : "Type a name first", false, "bad"); }
                return;
            }
            if (k === "CLEAR") { K.num = ""; K.name = ""; K.sel = null; }
            else if (k === "123") { K.mode = "num"; }
            else if (K.mode === "num") { if (/^\d$/.test(k) && K.num.length < 3) { K.num += k; } }
            else if (k === "DEL") { K.name = K.name.slice(0, -1); K.sel = null; }
            else if (k === "SPACE") { K.name += " "; K.sel = null; }
            else { K.name += k.toLowerCase(); K.sel = null; }
            kDraw();
        }
        // a real keyboard on the KEYPAD tab
        function onKey(e) {
            if (tab !== "keys" || !$("pkKeys") || e.ctrlKey || e.metaKey || e.altKey) { return; }
            if (e.key === "Enter") { e.preventDefault(); kKey("OK"); }
            else if (/^\d$/.test(e.key)) { e.preventDefault(); K.mode = "num"; kKey(e.key); }
            else if (/^[a-zA-Z]$/.test(e.key)) { e.preventDefault(); if (K.mode !== "name") { K.mode = "name"; K.name = ""; } kKey(e.key.toUpperCase()); }
            else if (e.key === "Backspace") { e.preventDefault(); if (K.mode === "num") { K.num = K.num.slice(0, -1); kDraw(); } else { kKey("DEL"); } }
            else if (e.key === " " && K.mode === "name") { e.preventDefault(); kKey("SPACE"); }
        }
        document.addEventListener("keydown", onKey);
        function afterDraw() {
            setTimeout(function () {
                var inp = $("pkIn");
                if (!inp || tab !== "list") { return; }
                if (!window.matchMedia || !window.matchMedia("(pointer: coarse)").matches) { inp.focus(); }   // a touch screen: the keypad, not focus
                inp.addEventListener("keydown", function (e) {
                    var top;
                    if (e.key !== "Enter") { return; }
                    e.preventDefault();
                    top = $("pkList").querySelector("[data-act=pick]");
                    if (top && q) { pick(top.getAttribute("data-v")); }
                });
            }, 30);
        }
        // CLEAR / EMPTY THIS SLOT: the first tap arms it, a second tap (within 3 s) clears
        var armT = 0;
        function clearTap() {
            var b = $("pkClear");
            if (armT) { clearTimeout(armT); armT = 0; pick(""); return; }
            if (!b) { return; }
            b.classList.add("arm"); b.textContent = "TAP AGAIN TO CLEAR";
            armT = setTimeout(function () { armT = 0; var x = $("pkClear"); if (x) { x.classList.remove("arm"); x.textContent = o.clearLabel || "Clear"; } }, 3000);
        }
        pickerList = list;
        Huddles.custom(o.title, {
            render: function () {
                return '<div class="pktabs"><button data-act="tab" data-v="list"' + (tab === "list" ? ' class="on"' : '') + '>LIST</button>' +
                    '<button data-act="tab" data-v="keys"' + (tab === "keys" ? ' class="on"' : '') + '>KEYPAD</button></div>' +
                    (cur ? '<p class="muted">Now: ' + esc(name(sd, cur)) + '</p>' : '') +
                    (tab === "list" ?
                        '<input class="pkin" id="pkIn" data-in="q" data-kp="text" inputmode="none" aria-label="Jersey number or name" autocomplete="off" spellcheck="false" placeholder="Jersey number or name" value="' + esc(q) + '">' +
                        '<div class="pkflt" id="pkFlt">' + fltRow() + '</div>' +
                        '<div class="pklist" id="pkList">' + list() + '</div>' :
                        '<div class="pkkeys" id="pkKeys">' + keysHtml() + '</div>') +
                    '<div class="hrow">' + (o.more ? '<button class="btn tog' + (MORE ? ' on' : '') + '" data-act="more" title="After a pick, open the picker on the next empty slot">ADD ANOTHER: ' + (MORE ? 'ON' : 'OFF') + '</button>' : '') +
                    (cur ? '<button class="btn clearbtn" id="pkClear" data-act="clear">' + esc(o.clearLabel || "Clear") + '</button>' : '') +
                    '<button class="btn" data-act="reload">Reload roster</button></div>';
            },
            input: function (k, v) { q = v; $("pkList").innerHTML = list(); },
            act: function (a, v) {
                if (a === "pick") { pick(v); }
                else if (a === "clear") { clearTap(); }
                else if (a === "reload") { reload(); }
                else if (a === "more") { MORE = !MORE; store("statsapp.addAnother", MORE); Huddles.refresh(); afterDraw(); }
                else if (a === "flt") { flt = flt === v ? "" : v; $("pkFlt").innerHTML = fltRow(); $("pkList").innerHTML = list(); }
                else if (a === "tab") {
                    tab = v;
                    try { localStorage.setItem("statsapp.pickerTab", v); } catch (e) { /* private mode */ }
                    Huddles.refresh();
                    afterDraw();
                }
                else if (a === "kmode") { if (K.mode !== v) { K.mode = v; if (v === "name") { K.name = ""; K.sel = null; } } kDraw(); }
                else if (a === "ksel") { K.sel = v; K.num = v; kDraw(); }
                else if (a === "key") { kKey(v); }
            },
            onClose: function () { document.removeEventListener("keydown", onKey); }
        });
        afterDraw();
    }

    function buzz(ms) { if (navigator.vibrate) { try { navigator.vibrate(ms || 12); } catch (e) { /* not supported */ } } }
    function init() {
        $("playersCard").addEventListener("click", function (e) {
            var b = e.target.closest && e.target.closest("[data-plside]");
            if (b) { show(b.getAttribute("data-plside")); return; }
            if (e.target.closest && e.target.closest("[data-arrange]")) { arrange(); }
        });
        if (typeof Teams !== "undefined") {
            Teams.on(function () {
                if (!App.result) { return; }
                render();
                if (pickerList && $("pkList")) { $("pkList").innerHTML = pickerList(); }
            });
        }
    }

    return { init: init, render: render, reload: reload, note: function (c) { return NOTE[c]; }, editSlot: editSlot, pickFor: pickFor, name: name, last: last, side: side, auto: auto, slots: slots };
})();
