/*
 * stats/app/js/huddles.js - the huddles (modal sheets): GAME (period,
 * timeouts, score fix, clock, new game), the event huddle (edit / add a
 * missed play / delete) and the new game form. Every action is an op through
 * App.addEvent / App.commit, validated first.
 */
var Huddles = (function () {

    var $ = function (id) { return document.getElementById(id); };
    var esc = Fmt.esc;
    var current = null;           // { render(), act(a, v, el) }

    function open(h) {
        current = h;
        draw();
        if (!$("huddle").open) { $("huddle").showModal(); }
    }
    // onClose (optional on a huddle): runs however it is broken (a button,
    // Close, tap outside, Esc), e.g. to put a dragged line back.
    function close() {
        var c = current;
        current = null;
        if ($("huddle").open) { $("huddle").close(); }
        $("hExtra").innerHTML = "";
        if (c && c.onClose) { c.onClose(); }
    }
    function draw() {
        // head (optional): buttons next to Close
        if (current) { $("hBody").innerHTML = current.render(); $("hExtra").innerHTML = current.head ? current.head() : ""; }
    }
    function say(text, bad) {
        var m = $("hMsg");
        m.textContent = text || "";
        m.classList.toggle("bad", !!bad);
    }

    // Validate against the live Result and log; keeps the huddle open.
    function log(ev) {
        var r = App.addEvent(ev);
        say(r.ok ? "Logged: " + Fmt.event(ev, App.result.codes) : r.reason, !r.ok);
        draw();
        return r.ok;
    }

    // ------------------------------------------------------------ GAME

    var PERIODS = [[1, "1ST"], [2, "2ND"], ["HALF", "HALF"], [3, "3RD"], [4, "4TH"], ["OT", "OT"], ["FINAL", "FINAL"]];

    var game = {
        render: function () {
            var res = App.result, sit = res.situation, c = res.codes, h = "";
            h += '<h3>Period</h3><div class="seg big wrap">' + PERIODS.map(function (p) {
                var on = sit.periodLabel === p[1] || (p[0] === "OT" && sit.period >= 5 && sit.phase !== "FINAL");
                return '<button data-act="period" data-v="' + p[0] + '"' + (on ? ' class="on"' : '') + '>' + p[1] + '</button>';
            }).join("") + '</div>';
            h += '<h3>Timeouts</h3><div class="hgrid">' + ["AWAY", "HOME"].map(function (side) {
                return '<div class="hteam ' + side.toLowerCase() + '"><b>' + esc(c[side]) + '</b>' +
                    '<button class="btn" data-act="to" data-v="' + side + '">Use timeout</button>' +
                    '<div class="stepper"><button data-act="toSet" data-v="' + side + ':-1">&minus;</button><span>' +
                    res.timeouts[side] + ' left</span><button data-act="toSet" data-v="' + side + ':1">+</button></div></div>';
            }).join("") + '</div>';
            h += '<h3>Score fix</h3><div class="hgrid">' + ["AWAY", "HOME"].map(function (side) {
                return '<div class="hteam ' + side.toLowerCase() + '"><b>' + esc(c[side]) + '</b>' +
                    '<div class="stepper"><button data-act="score" data-v="' + side + ':-1">&minus;1</button><span>' +
                    res.score[side] + '</span><button data-act="score" data-v="' + side + ':1">+1</button></div></div>';
            }).join("") + '</div>';
            h += '<h3>Clock stamp</h3><div class="hrow"><input id="hClock" class="clock" data-kp="clock" inputmode="none" aria-label="Clock stamp" placeholder="m:ss" autocomplete="off">' +
                '<button class="btn" data-act="clock">Stamp clock</button></div>';
            h += '<h3>This game</h3><p class="muted">' + esc(App.game.name) + (App.game.id ? '' : ' (test game: logging on it saves a practice copy)') + '</p>' +
                '<div class="hrow"><button class="btn" data-act="newgame">New game…</button>' +
                '<button class="btn" data-act="export">Export .jsonl</button>' +
                (App.game.id ? '<button class="btn danger" data-act="deletegame">Delete saved game</button>' : '') + '</div>';
            return h;
        },
        act: function (a, v) {
            var res = App.result, parts, side, n, set;
            if (a === "period") { log({ kind: "PERIOD", period: /^\d$/.test(v) ? +v : v }); return; }
            if (a === "to") { log({ kind: "TIMEOUT", side: v, period: res.situation.period }); return; }
            if (a === "toSet") {
                parts = v.split(":"); side = parts[0]; n = res.timeouts[side] + (+parts[1]);
                set = { AWAY: res.timeouts.AWAY, HOME: res.timeouts.HOME };
                set[side] = n;
                log({ kind: "TIMEOUT", set: set, period: res.situation.period });
                return;
            }
            if (a === "score") {
                parts = v.split(":");
                log({ kind: "SCORE_FIX", side: parts[0], delta: +parts[1], period: res.situation.period });
                return;
            }
            if (a === "clock") {
                log({ kind: "CLOCK", clock: Fmt.normClock($("hClock").value), period: res.situation.period });
                return;
            }
            if (a === "newgame") { title("New game"); open(newGame); }
            if (a === "export") { App.exportGame(); }
            if (a === "deletegame") { close(); App.deleteGame(); }
        }
    };

    // ------------------------------------------------------------ event huddle

    function eventHuddle(eventId) {
        var events = StatsOps.effective(App.game.ops), ev = null, i, play = null, res = App.result, label;
        for (i = 0; i < events.length; i++) { if (events[i].id === eventId) { ev = events[i]; break; } }
        if (!ev) { return null; }
        for (i = 0; i < res.plays.length; i++) { if (res.plays[i].id === eventId) { play = res.plays[i]; break; } }
        label = play ? "play " + play.num : Fmt.event(ev, res.codes).toLowerCase();
        return {
            render: function () {
                var editable = ev.kind === "PLAY" || ev.kind === "KICKOFF" || ev.kind === "SPOT", h;
                h = '<p class="hev">' + esc(Fmt.event(ev, res.codes, play && play.text)) + '</p>';
                if (play && play.down) { h += '<p class="muted">' + esc(Fmt.playDD(play) + " at " + Fmt.spot(play.spot, res.codes)) + '</p>'; }
                h += '<div class="hrow">' +
                    (editable ? '<button class="btn big" data-act="edit">Edit</button>' : '') +
                    '<button class="btn big" data-act="insert">Add missed play after</button>' +
                    '<button class="btn big danger" data-act="delete">Delete</button></div>';
                return h;
            },
            act: function (a) {
                if (App.isViewing()) { say("Viewing an earlier point: go live first", true); return; }
                if (a === "edit") { close(); Entry.edit(eventId, label); }
                if (a === "insert") { close(); Entry.insertAfter(eventId, label); }
                if (a === "delete") { close(); App.commit({ kind: "VOID", eventId: eventId }, "DELETE"); }
            }
        };
    }

    // ------------------------------------------------------------ new game

    var newGame = {
        render: function () {
            var su = App.game.setup || {}, a = su.away || {}, h = su.home || {}, rules = su.rules || {};
            function f(id, label, val, extra) {
                return '<label class="fld"><span>' + label + '</span><input id="' + id + '" value="' + esc(val) + '" ' + (extra || "") + '></label>';
            }
            return '<p class="muted">Starts an empty game, saved on this device. The current game stays in the game menu.</p>' +
                '<div class="hgrid">' +
                '<div>' + f("ngAwayCode", "Away code", a.code || "", 'maxlength="5" data-kp="text" inputmode="none"') + f("ngAwayName", "Away name", a.name || "", 'data-kp="text" inputmode="none"') + '</div>' +
                '<div>' + f("ngHomeCode", "Home code", h.code || "", 'maxlength="5" data-kp="text" inputmode="none"') + f("ngHomeName", "Home name", h.name || "", 'data-kp="text" inputmode="none"') + '</div>' +
                '</div><div class="hgrid">' +
                f("ngQuarter", "Quarter minutes", rules.quarterMinutes || 12, 'maxlength="2" data-kp="number" inputmode="none"') +
                f("ngTouchback", "Touchback at", rules.touchbackSpot || 20, 'maxlength="2" data-kp="number" inputmode="none"') +
                '</div><div class="hrow"><button class="btn big primary" data-act="start">Start game</button></div>';
        },
        act: function (a) {
            var ac, hc, q, tb;
            if (a !== "start") { return; }
            ac = $("ngAwayCode").value.trim().toUpperCase(); hc = $("ngHomeCode").value.trim().toUpperCase();
            q = +$("ngQuarter").value; tb = +$("ngTouchback").value;
            if (!ac || !hc || ac === hc) { say("Give each team a different code", true); return; }
            if (!(q > 0 && q <= 20) || !(tb > 0 && tb < 50)) { say("Check the quarter length and touchback spot", true); return; }
            App.newGame({
                date: new Date().toISOString().slice(0, 10),
                away: { code: ac, name: $("ngAwayName").value.trim() || ac },
                home: { code: hc, name: $("ngHomeName").value.trim() || hc },
                detail: "TEAM",
                rules: { quarterMinutes: q, touchbackSpot: tb }
            });
            close();
        }
    };

    // ------------------------------------------------------------ score fix

    // From the strip: tap a score. Each step is a SCORE_FIX event (undo on the toast).
    function scoreFixHuddle(side) {
        return {
            render: function () {
                var res = App.result, name = res.codes[side];
                return '<p class="hev">' + esc(name) + ' score now <b>' + res.score[side] + '</b></p>' +
                    '<div class="hrow">' + [-6, -3, -2, -1, 1, 2, 3, 6].map(function (n) {
                        return '<button class="btn big" data-act="pts" data-v="' + n + '">' + (n > 0 ? "+" : "") + n + '</button>';
                    }).join("") + '</div>' +
                    '<p class="muted">A fix is logged like a play, so it shows in the Log and can be undone. ' +
                    'Touchdowns, field goals, PATs and safeties count by themselves when the plays are logged.</p>';
            },
            act: function (a, v) {
                if (a === "pts") { log({ kind: "SCORE_FIX", side: side, delta: +v, period: App.result.situation.period }); }
            }
        };
    }

    // ------------------------------------------------------------ wiring

    function init() {
        var dlg = $("huddle"), downOutside = false;
        // only a press that STARTED outside the sheet breaks the huddle (the tap
        // or hold that opened it lets go on the fresh backdrop)
        dlg.addEventListener("pointerdown", function (e) { downOutside = e.target === dlg; });
        dlg.addEventListener("click", function (e) {
            var b;
            if (e.target === dlg) { if (downOutside) { close(); } downOutside = false; return; }   // tap outside the sheet
            b = e.target.closest("[data-act]");
            if (!b || b.disabled || !current) { return; }
            if (b.getAttribute("data-act") === "close") { close(); return; }
            current.act(b.getAttribute("data-act"), b.getAttribute("data-v"), b);
        });
        // (the close event comes a moment later: a huddle opened right after another one closed is left alone)
        dlg.addEventListener("close", function () { var c; if (dlg.open) { return; } c = current; current = null; if (c && c.onClose) { c.onClose(); } });
    }

    function title(t) { $("hTitle").textContent = t; say(""); }

    return {
        init: init,
        refresh: draw,
        game: function () { title("Game"); open(game); },
        scoreFix: function (side) { title("Fix score"); open(scoreFixHuddle(side)); },
        event: function (eventId) { var h = eventHuddle(eventId); if (h) { title("Logged event"); open(h); } },
        newGame: function () { title("New game"); open(newGame); },
        // the field card / drive card huddles (center.js): { render(), act(a, v, el), onClose? }
        custom: function (t, h) { title(t); open(h); },
        close: close,
        say: say,
        get current() { return current; }
    };
})();
