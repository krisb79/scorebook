/*
 * stats/app/js/center.js - the center column, ported from GRIDIRON
 * (statsapp/Gridiron.html #colC) and wired to the stats engine instead of
 * PLAYBOOK's /api. Three cards:
 *
 *   FIELD CARD   preview line + FLIP, the field, -1 / spot / +1, the PLAY
 *                BUTTONS (drag one onto the field: letting go logs the play),
 *                the FG and Penalty huddles, MOVE THE LINES (drag the blue /
 *                yellow line: D&D huddle; tap the preview line for the same).
 *   DRIVE CARD   the open drive (EDIT, HOLD: END DRIVE, DELETE while it has
 *                no plays), the try after a touchdown, or NEXT DRIVE (team,
 *                start spot = the field, start time, START = the kickoff).
 *   DRIVE CHART  the open / last drive on a small field, one row per play.
 *
 * Every tap becomes an engine event, validated, then committed by App (stored
 * on the device first, then applied; UNDO on the toast). Nothing here is game
 * state: drives come from the engine's Result (possession owns the drive), so
 * a punt, turnover, score or 4th down short ends the drive by itself and the
 * engine opens the next one. GRIDIRON rules kept: D&D always changeable (D&D
 * huddle = a SPOT event), no orphan drives (giving the ball to the other team
 * while a drive is open asks first), shake + toast on errors, play buttons
 * locked without an open drive. Left out: the scoring drive huddle and
 * anything that takes graphics or reads rosters.
 */
var Center = (function () {

    var $ = function (id) { return document.getElementById(id); };
    var esc = Fmt.esc;
    var REF = null;

    // FIELD.start: the next drive's start, yards from the receiving team's own
    // goal line (null = the touchback spot), tb = the TOUCHBACK preset.
    // FIELD.spot: the new spot for a play (absolute; null = none).
    var FIELD = { start: null, tb: false, spot: null };
    var NEXT = { side: null, time: "" };
    var PLAY = { key: "" };
    var keys = { play: "", next: "" };
    var drag = null, fdrag = null, lineDrag = null, lastSnap = null;
    // A play being dragged from the PLAYERS card: { type: PASS / RUSH, qb, rec, car (jerseys),
    // result }; the new spot is FIELD.spot. Letting go on the field logs it.
    var PEND = null, pdrag = null;

    var PLAYS = {
        PASS: { label: "PASS COMPLETE", spot: true, arc: true },
        INC: { label: "PASS INCOMPLETE", arc: true },
        INT: { label: "INTERCEPTION", spot: true, flip: true, arc: true },
        RUSH: { label: "RUSH", spot: true },
        FUM: { label: "FUMBLE", spot: true, flip: true },
        PUNT: { label: "PUNT", spot: true, flip: true, arc: true },
        FG: { label: "FIELD GOAL", huddle: function () { fgHuddle(); }, arc: true },
        OFFPEN: { label: "OFF PENALTY", huddle: function () { penHuddle("OFF"); } },
        DEFPEN: { label: "DEF PENALTY", huddle: function () { penHuddle("DEF"); } }
    };

    // ------------------------------------------------------------ helpers

    function res() { return App.result; }
    function live() { return App.result.situation; }
    function codes() { return App.result.codes; }
    function team(side) { return codes()[side] || side; }
    function other(s) { return Fmt.other(s); }
    function spotText(a) { return Fmt.spot(a, codes()); }
    function signed(n) { return (n > 0 ? "+" : "") + n; }
    function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
    function rules() { var r = (App.game.setup && App.game.setup.rules) || {}, d = StatsEngine.DEFAULT_RULES; return { tb: r.touchbackSpot || d.touchbackSpot, q: r.quarterMinutes || d.quarterMinutes }; }
    function buzz(ms) { if (navigator.vibrate) { try { navigator.vibrate(ms || 12); } catch (e) { /* not supported */ } } }
    function lastDrive() { var ds = res().drives; return ds.length ? ds[ds.length - 1] : null; }
    function openDrive() { var d = lastDrive(); return d && d.open ? d : null; }
    function playById(id) { var p = res().plays, i; for (i = p.length - 1; i >= 0; i--) { if (p[i].id === id) { return p[i]; } } return null; }
    function eventById(id) { var e = App.events, i; for (i = 0; i < e.length; i++) { if (e[i].id === id) { return e[i]; } } return null; }
    function copy(o) { var out = {}, k; for (k in o) { if (o.hasOwnProperty(k) && k !== "id") { out[k] = o[k]; } } return out; }
    function ddText(down, toGo, goal) { return Fmt.ordinal(down) + " & " + (goal ? "Goal" : (toGo < 1 ? "Inches" : Math.round(toGo))); }

    // Which card face: "play" (a drive is open), "next" (between drives:
    // kickoff), "try" (after a touchdown), "final".
    function mode() {
        var sit = live();
        if (sit.phase === "FINAL") { return "final"; }
        if (sit.phase === "TRY") { return "try"; }
        if (openDrive()) { return "play"; }
        return "next";
    }

    function nextSide() {
        var sit = live(), ld = lastDrive();
        return NEXT.side || sit.offense || (ld ? other(ld.side) : "AWAY");
    }
    function startRel() { return FIELD.start !== null ? FIELD.start : rules().tb; }
    function startAbs() { return Fmt.abs(nextSide(), startRel()); }

    // The clock box (optional): "721" = 7:21, stamped on the next play.
    function clockOf(id) {
        var c = Fmt.normClock($(id) ? $(id).value : "");
        if (!c) { return { ok: true, clock: "" }; }
        return StatsEngine.parseClock(c) === null ? { ok: false, clock: c } : { ok: true, clock: c };
    }

    // Why the play buttons are locked right now (null = they aren't).
    function blocked() {
        var sit = live(), d = openDrive();
        if (App.isViewing()) { return { text: "Viewing an earlier point: tap Go live to log", el: $("goLive") }; }
        if (Entry.mode !== "LIVE") { return { text: "Finish the edit first: SAVE or Cancel in the entry panel", el: $("enMode") }; }
        if (sit.phase === "FINAL") { return { text: "The game is final" }; }
        if (sit.phase === "TRY") { return { text: "Log the try first (drive card)", el: $("driveCard") }; }
        if (!d) { return { text: "Start a drive first (drive card under the field)", el: $("startBtn") }; }
        if (!sit.offense) { return { text: "Ball is OFF: give " + team(d.side) + " the ball back first", el: $("enPoss") }; }
        return null;
    }

    // The error shake: the element wobbles with a red edge, a short buzz, the toast says why.
    function shake(el) {
        if (!el) { return; }
        el.classList.remove("shake");
        void el.offsetWidth;
        el.classList.add("shake", "err");
        setTimeout(function () { el.classList.remove("shake"); }, 320);
        setTimeout(function () { el.classList.remove("err"); }, 1000);
    }
    function refuse(why, el) {
        shake(el);
        if (why.el && why.el !== el) { shake(why.el); }
        buzz(40);
        App.toast(why.text, false, "bad");
    }

    // Commit one event; on a refusal shake el and say why.
    function add(ev, el) {
        var r = App.addEvent(ev);
        if (!r.ok) { refuse({ text: r.reason }, el); return false; }
        buzz(25);
        return true;
    }

    // ------------------------------------------------------------ the field

    // Snap onto the line to gain, the goal line, the 50 or no gain, only from
    // close by (0.8 yd), less when two of those lines are near each other, so
    // every yard in between can still be picked (same rule as GRIDIRON).
    function snap(raw) {
        var sit = live(), off = sit.offense, c = clamp(raw, 0, 100), pts, i, k, gap;
        if (!off || sit.spot === null) { return { c: Math.round(c), hit: false }; }
        pts = [sit.spot, Fmt.goalOf(off), 50];
        if (sit.lineToGain !== null && !sit.goal) { pts.push(sit.lineToGain); }
        for (i = 0; i < pts.length; i++) {
            gap = 99;
            for (k = 0; k < pts.length; k++) { if (pts[k] !== pts[i]) { gap = Math.min(gap, Math.abs(pts[k] - pts[i])); } }
            if (Math.abs(c - pts[i]) <= Math.min(0.8, gap / 4)) { return { c: pts[i], hit: true }; }
        }
        return { c: Math.round(c), hit: false };
    }
    function snapFlash(c, hit) {
        var f = $("field");
        if (hit && lastSnap !== c) {
            f.classList.add("snapflash");
            buzz(8);
            setTimeout(function () { f.classList.remove("snapflash"); }, 160);
        }
        lastSnap = hit ? c : null;
    }

    // Short tag on the white marker / the magnifier: "+7", "TD", "TOUCHBACK".
    function tagFor(key, c) {
        var sit = live(), off = sit.offense, def = other(off), r, y;
        if (!off || sit.spot === null) { return spotText(c); }
        if (key && PLAYS[key] && PLAYS[key].flip) {
            r = Fmt.rel(def, c);
            if (r >= 100) { return "TD " + team(def); }
            if (r <= 0) { return "TOUCHBACK"; }
            return team(def) + " BALL";
        }
        r = Fmt.rel(off, c);
        if (r >= 100) { return "TD"; }
        if (r <= 0) { return "SAFETY"; }
        y = Math.round((c - sit.spot) * Fmt.dir(off));
        return signed(y);
    }

    // Draw the field: the moment being entered against (an edit), else live.
    function paint() {
        var sit, m, ed, arrow = null, fake;
        if (!REF || !App.result) { return; }
        ed = Entry.fieldSituation();
        sit = ed || live();
        m = mode();
        if (!ed && m === "next") { arrow = { side: nextSide(), at: startAbs() }; }
        if (lineDrag) {
            fake = {}; for (var k in sit) { if (sit.hasOwnProperty(k)) { fake[k] = sit[k]; } }
            if (lineDrag.kind === "LOS") { fake.spot = lineDrag.c; } else { fake.lineToGain = lineDrag.c; fake.goal = false; }
            Field.update(REF, fake, codes(), null, true);
        } else {
            Field.update(REF, sit, codes(), arrow);
        }
        if (Entry.active()) { return; }               // the entry panel draws its own marker
        if (m === "next" && !App.isViewing()) { Field.ghost(REF, startAbs(), "START " + spotText(startAbs())); }
        else if (m === "play" && FIELD.spot !== null) { Field.ghost(REF, FIELD.spot, tagFor(PLAY.key || pendKey(), FIELD.spot)); }
        else { Field.ghost(REF, null); }
    }

    // The preview line, the -1 / spot / +1 row and the line under the play buttons.
    function texts() {
        var sit = live(), m = mode(), d = openDrive(), pv = $("preview"), sp = $("yScrub").querySelector("span"),
            sm = $("yScrub").querySelector("small"), now = $("playNow"), off = sit.offense, t, y, dd, why = blocked(), k = PLAY.key;
        pv.classList.remove("ready");
        if (App.isViewing()) { t = "Viewing an earlier point - tap Go live to log"; }
        else if (Entry.mode !== "LIVE") { t = (Entry.mode === "EDIT" ? "Editing " : "Adding a play after ") + Entry.label + " - drag on the field, then SAVE in the entry panel"; }
        else if (Entry.active()) { t = "Entry panel: drag on the field for the spot, then LOG"; }
        else if (m === "final") { t = "FINAL"; }
        else if (m === "try") { t = "TRY - " + team(sit.trySide) + ": log the PAT / 2PT on the drive card"; }
        else if (m === "next") { t = "Drag the field to where " + team(nextSide()) + " takes over - now " + spotText(startAbs()); pv.classList.add("ready"); }
        else if (!off) { t = "BALL OFF - " + team(d.side) + " drive " + d.num + " is open: give " + team(d.side) + " the ball back"; }
        else {
            dd = (k ? PLAYS[k].label + "  |  " : (PEND ? pendLabel() + "  |  " : "")) + sit.ddText + " at " + spotText(sit.spot);
            if (FIELD.spot === null) { t = dd + " - tap here to change the D&D"; }
            else { y = Math.round((FIELD.spot - sit.spot) * Fmt.dir(off)); t = dd + "  ->  " + spotText(FIELD.spot) + " (" + signed(y) + ")"; pv.classList.add("ready"); }
        }
        pv.textContent = t;
        // the strip's second line shows what is being entered (a drag, a spot, an edit); else its own line
        if (pv.classList.contains("ready") || k || PEND || App.isViewing() || Entry.mode !== "LIVE" || Entry.active()) {
            $("detail").textContent = t; $("situW").classList.add("live");
        } else if ($("situW").classList.contains("live")) {
            $("detail").textContent = $("detail").getAttribute("data-base") || ""; $("situW").classList.remove("live");
        }

        if (m === "next" && !App.isViewing()) { sp.textContent = spotText(startAbs()); sm.textContent = "start spot - drag left / right"; }
        else if (m === "play" && off && FIELD.spot !== null) {
            y = Math.round((FIELD.spot - sit.spot) * Fmt.dir(off));
            sp.textContent = signed(y); sm.textContent = "new spot " + spotText(FIELD.spot);
        } else if (m === "play" && off) { sp.textContent = "0"; sm.textContent = "scrub left / right"; }
        else { sp.textContent = "-"; sm.textContent = ""; }

        if (!k && PEND && !why) { t = pendNow(); }
        else if (!k) {
            t = why ? why.text :
                "Drag a play onto the field - it logs when you let go (UNDO on the toast)";
        } else if (k === "INC") { t = "PASS INCOMPLETE - let go on the field"; }
        else if (!PLAYS[k].spot) { t = PLAYS[k].label + " - let go on the field"; }
        else if (FIELD.spot === null) { t = PLAYS[k].label + " - drag it onto the field"; }
        else { t = nowText(k, FIELD.spot); }
        now.textContent = t;
        now.classList.toggle("ready", !!k || pendReady());

        document.body.classList.toggle("nodrive", !!why);
        Array.prototype.forEach.call($("playBtns").querySelectorAll("button"), function (b) { b.classList.toggle("on", b.getAttribute("data-play") === k); });
        $("playBtns").classList.toggle("goLeft", !!off && ((off === "HOME") !== Field.flipped));
    }
    function nowText(k, c) {
        var sit = live(), off = sit.offense, def = other(off), r = Fmt.rel(def, c), y = Math.round((c - sit.spot) * Fmt.dir(off));
        if (k === "INT" || k === "FUM") {
            if (r >= 100) { return (k === "INT" ? "PICK SIX" : "FUMBLE") + " - returned for a " + team(def) + " TOUCHDOWN"; }
            if (r <= 0) { return (k === "INT" ? "INTERCEPTION" : "FUMBLE") + " in the end zone - TOUCHBACK"; }
            return k === "INT" ? "INTERCEPTION - " + team(def) + " takes over at " + spotText(c) :
                "FUMBLE - lost at " + spotText(c) + " (" + signed(y) + "), " + team(def) + " ball";
        }
        if (k === "PUNT") { return r <= 0 ? "PUNT - TOUCHBACK" : "PUNT - " + team(def) + " takes over at " + spotText(c); }
        r = Fmt.rel(off, c);
        return PLAYS[k].label + "  " + signed(y) + "  to " + spotText(c) + (r >= 100 ? " - TOUCHDOWN" : (r <= 0 ? " - SAFETY" : ""));
    }

    function setStart(rel) { FIELD.start = clamp(Math.round(rel), 1, 99); FIELD.tb = false; }

    // -1 / +1: one yard lost / gained (between drives: the start spot).
    function nudge(n) {
        var sit = live(), off = sit.offense, base;
        if (App.isViewing() || Entry.active()) { return; }
        if (mode() === "next") { setStart(startRel() + n); }
        else if (mode() === "play" && off) {
            base = FIELD.spot !== null ? FIELD.spot : sit.spot;
            FIELD.spot = clamp(Fmt.abs(off, Fmt.rel(off, base) + n), 0, 100);
        } else { return; }
        buzz(3);
        render();
    }

    // Hold to repeat; stops on any finger-up anywhere.
    var repeatStop = null;
    function repeatBtn(btn, fn) {
        btn.addEventListener("contextmenu", function (e) { e.preventDefault(); });
        btn.addEventListener("pointerdown", function (e) {
            var t1, t2 = null;
            e.preventDefault();
            if (repeatStop) { repeatStop(); }
            t1 = setTimeout(function () {
                var n = 0;
                t2 = setInterval(function () { fn(); n++; if (n === 8) { clearInterval(t2); t2 = setInterval(fn, 60); } }, 110);
            }, 400);
            repeatStop = function () { clearTimeout(t1); clearInterval(t2); repeatStop = null; };
            fn();
        });
    }

    // Field press / drag: the entry panel's spot while it is typing, a line
    // (blue / yellow) when one is grabbed, else the new spot (or the start spot).
    function lineAt(x) {
        var sit = live(), best = null, dist = 16, g;
        if (mode() !== "play" || !sit.offense || PLAY.key || Entry.active() || App.isViewing()) { return null; }
        g = Math.abs(x - Field.clientX(REF, sit.spot));
        if (g <= dist) { best = "LOS"; dist = g; }
        if (!sit.goal && sit.lineToGain !== null) {
            g = Math.abs(x - Field.clientX(REF, sit.lineToGain));
            if (g < dist) { best = "GAIN"; }
        }
        return best;
    }

    function spotMove(e) {
        var c = Field.spotAt(REF, e.clientX), sit = live(), s, y;
        if (mode() === "next") {
            setStart(Fmt.rel(nextSide(), c));
            Field.loupe(REF, e.clientX, startAbs(), spotText(startAbs()), null);
            render();
            return;
        }
        s = snap(c);
        snapFlash(s.c, s.hit);
        FIELD.spot = s.c;
        y = Math.round((s.c - sit.spot) * Fmt.dir(sit.offense));
        Field.loupe(REF, e.clientX, s.c, spotText(s.c) + "   (" + signed(y) + ")", sit.spot);
        paint();
        texts();
    }

    function lineMove(e) {
        var sit = live(), off = sit.offense, c = Math.round(Field.spotAt(REF, e.clientX)), d = Fmt.dir(off);
        if (lineDrag.kind === "LOS") { c = clamp(c, 1, 99); }
        else { c = d > 0 ? clamp(c, sit.spot + 1, 100) : clamp(c, 0, sit.spot - 1); }
        if (c !== lineDrag.c) { lineDrag.c = c; buzz(3); }
        Field.loupe(REF, e.clientX, c, spotText(c), lineDrag.kind === "LOS" ? null : sit.spot);
        paint();
    }

    function bindField() {
        var f = $("field");
        f.addEventListener("pointerdown", function (e) {
            var k, m;
            if (!App.result || App.isViewing()) { return; }
            try { f.setPointerCapture(e.pointerId); } catch (x) { /* old browsers */ }
            if (Entry.active()) { fdrag = "entry"; Entry.fieldDrag(Field.spotAt(REF, e.clientX), e, "down"); return; }
            k = lineAt(e.clientX);
            if (k) {
                lineDrag = { kind: k, c: k === "LOS" ? live().spot : live().lineToGain, start: k === "LOS" ? live().spot : live().lineToGain };
                fdrag = "line"; buzz(10); e.preventDefault();
                return;
            }
            m = mode();
            if (m === "next" || (m === "play" && live().offense)) { fdrag = "spot"; spotMove(e); }
        });
        f.addEventListener("pointermove", function (e) {
            if (!fdrag) { f.style.cursor = App.result && lineAt(e.clientX) ? "col-resize" : ""; return; }
            if (fdrag === "entry") { Entry.fieldDrag(Field.spotAt(REF, e.clientX), e, "move"); }
            else if (fdrag === "line") { lineMove(e); }
            else { spotMove(e); }
        });
        function up(e, cancel) {
            var k = fdrag, g = lineDrag;
            if (!k) { return; }
            fdrag = null;
            if (k === "entry") { Entry.fieldDrag(Field.spotAt(REF, e.clientX), e, "up"); return; }
            Field.hideLoupe();
            if (k === "line") {
                lineDrag = null;
                if (cancel || g.c === g.start) { paint(); return; }
                ddHuddle(g.kind, g.c);
                return;
            }
            render();
        }
        f.addEventListener("pointerup", function (e) { up(e, false); });
        f.addEventListener("pointercancel", function (e) { up(e, true); });

        // the spot row: drag left / right on the middle (14 px = 1 yard, the way the field shows it)
        var sc = $("yScrub"), x0 = null, base = 0;
        sc.addEventListener("pointerdown", function (e) {
            var m = mode();
            if (!App.result || App.isViewing() || Entry.active() || !(m === "next" || (m === "play" && live().offense))) { return; }
            x0 = e.clientX;
            base = m === "next" ? startAbs() : (FIELD.spot !== null ? FIELD.spot : live().spot);
            try { sc.setPointerCapture(e.pointerId); } catch (x) { /* old browsers */ }
        });
        sc.addEventListener("pointermove", function (e) {
            var n, c;
            if (x0 === null) { return; }
            n = Math.round((e.clientX - x0) / 14) * (Field.flipped ? -1 : 1);
            c = clamp(base + n, 0, 100);
            if (mode() === "next") { if (Fmt.abs(nextSide(), startRel()) === c) { return; } setStart(Fmt.rel(nextSide(), c)); }
            else { if (FIELD.spot === c) { return; } FIELD.spot = c; }
            buzz(3);
            render();
        });
        ["pointerup", "pointercancel"].forEach(function (t) { sc.addEventListener(t, function () { x0 = null; }); });
        repeatBtn($("ym"), function () { nudge(-1); });
        repeatBtn($("yp"), function () { nudge(1); });
        ["pointerup", "pointercancel", "blur"].forEach(function (t) { window.addEventListener(t, function () { if (repeatStop) { repeatStop(); } }, true); });

    }

    // ------------------------------------------------------------ PLAY BUTTONS

    // Each button is a play; drag it onto the field. A copy of the button
    // follows the finger, the magnifier shows the yard line and the gain, the
    // spot snaps onto the line to gain / goal line / 50 / no gain. LETTING GO
    // ON THE FIELD LOGS THE PLAY; letting go off the field drops nothing.
    //   PASS          let go = where the catch ended (into the end zone = TD)
    //   INCOMPLETE    let go anywhere on the field (or tap)
    //   INTERCEPTION  let go = where the other team takes over (the offense's own end zone = pick six,
    //                 the far end zone = touchback); the engine ends the drive and starts theirs
    //   RUSH          let go = where the run ended (own end zone = safety)
    //   FUMBLE        let go = where the other team recovered (always lost), same end zones as INT
    //   PUNT          let go = where the receiving team takes over (their end zone = touchback)
    //   FG            let go anywhere (or tap) = the Field Goal huddle
    //   OFF / DEF PEN let go anywhere (or tap) = the Penalty huddle
    // A tap on PASS / RUSH / INT / FUMBLE / PUNT logs it to the new spot when one
    // is set on the field (drag the field or -1 / +1 first); else it says to drag.
    function playEvent(k, c) {
        var sit = live(), def = other(sit.offense), ev = { kind: "PLAY", period: sit.period };
        if (k === "PASS") { ev.type = "PASS"; ev.result = "COMPLETE"; ev.endSpot = c; }
        else if (k === "INC") { ev.type = "PASS"; ev.result = "INCOMPLETE"; }
        else if (k === "INT") { ev.type = "PASS"; ev.result = "INTERCEPTION"; ev.endSpot = c; }
        else if (k === "RUSH") { ev.type = "RUSH"; ev.endSpot = c; }
        else if (k === "FUM") { ev.type = "RUSH"; ev.result = "FUMBLE_LOST"; ev.endSpot = c; if (c > 0 && c < 100) { ev.fumbleSpot = c; } }
        else if (k === "PUNT") {
            ev.type = "PUNT";
            if (Fmt.rel(def, c) <= 0) { ev.touchback = true; ev.puntLandSpot = Fmt.abs(def, 0); }
            else { ev.endSpot = c; ev.puntLandSpot = c; }
        }
        return ev;
    }

    // Stamp the clock box on an event; false (and a shake) when it isn't m:ss.
    function stamp(ev, boxId) {
        var c = clockOf(boxId);
        if (!c.ok) { refuse({ text: "Clock must be m:ss (721 = 7:21)" }, $(boxId)); return false; }
        if (c.clock) { ev.clock = c.clock; }
        return true;
    }

    function logPlay(k, c, btn) {
        var why = blocked(), ev;
        if (why) { clearPlay(); render(); refuse(why, btn); return; }
        ev = playEvent(k, c);
        if (!stamp(ev, "cClock")) { return; }
        clearPlay();
        add(ev, btn);
        render();
    }
    function clearPlay() { PLAY.key = ""; FIELD.spot = null; PEND = null; }

    function overField(e) {
        var r = $("field").getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 20 && e.clientY <= r.bottom + 20;
    }

    function drawArc(x, y) {
        var ax = drag.ax, ay = drag.ay, col = drag.color;
        $("arc").innerHTML = PLAYS[drag.k].arc ?
            '<path d="M' + ax + " " + ay + " Q " + ((ax + x) / 2) + " " + (Math.min(ay, y) - 90) + " " + x + " " + y +
                '" fill="none" stroke="' + col + '" stroke-width="4" stroke-dasharray="10 7"/>' :
            '<line x1="' + ax + '" y1="' + ay + '" x2="' + x + '" y2="' + y + '" stroke="' + col + '" stroke-width="4" stroke-dasharray="10 7"/>';
    }

    function bindPlays() {
        var box = $("playBtns"), chip = $("dragChip");
        box.addEventListener("contextmenu", function (e) { e.preventDefault(); });
        box.addEventListener("pointerdown", function (e) {
            var b = e.target.closest("[data-play]"), r, why, cs;
            if (!b || !App.result) { return; }
            e.preventDefault();
            why = blocked();
            if (why) { refuse(why, b); return; }       // locked: no drag without an open drive
            Entry.clear();
            r = b.getBoundingClientRect();
            cs = getComputedStyle(b);
            drag = { k: b.getAttribute("data-play"), btn: b, label: b.textContent, x: e.clientX, y: e.clientY, id: e.pointerId, moving: false,
                ax: r.left + r.width / 2, ay: r.top + r.height / 2, w: r.width, h: r.height, bg: cs.backgroundColor, color: cs.borderTopColor };
        });
        document.addEventListener("pointermove", function (e) {
            var g = drag, over, s;
            if (!g || e.pointerId !== g.id) { return; }
            if (!g.moving) {
                if (Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y) < 8) { return; }
                g.moving = true;
                PLAY.key = g.k;
                FIELD.spot = null;
                chip.textContent = g.label;
                chip.style.width = g.w + "px"; chip.style.height = g.h + "px"; chip.style.background = g.bg; chip.style.borderColor = g.color;
                chip.hidden = false;
                document.body.classList.add("dragging-play");
                buzz(10);
                render();
            }
            chip.style.left = e.clientX + "px";
            chip.style.top = e.clientY + "px";
            drawArc(e.clientX, e.clientY);
            over = overField(e);
            $("field").classList.toggle("drop-on", over && !PLAYS[g.k].spot);   // INCOMPLETE / FG / PEN: the whole field is the target
            if (over && PLAYS[g.k].spot) {
                s = snap(Field.spotAt(REF, e.clientX));
                snapFlash(s.c, s.hit);
                FIELD.spot = s.c;
                Field.loupe(REF, e.clientX, s.c, spotText(s.c) + "   " + tagFor(g.k, s.c), live().spot);
                paint();
                texts();
            } else {
                if (FIELD.spot !== null) { FIELD.spot = null; paint(); texts(); }
                Field.hideLoupe();
            }
            e.preventDefault();
        }, { passive: false });
        function end(e, cancel) {
            var g = drag, def;
            if (!g || e.pointerId !== g.id) { return; }
            drag = null;
            chip.hidden = true;
            $("arc").innerHTML = "";
            Field.hideLoupe();
            $("field").classList.remove("drop-on");
            document.body.classList.remove("dragging-play");
            def = PLAYS[g.k];
            if (cancel) { if (g.moving) { clearPlay(); } render(); return; }
            if (!g.moving) {                                  // a tap
                if (def.huddle) { def.huddle(); return; }
                if (!def.spot) { logPlay(g.k, null, g.btn); return; }
                if (FIELD.spot !== null) { logPlay(g.k, FIELD.spot, g.btn); return; }
                App.toast("Drag " + def.label + " onto the field", false);
                return;
            }
            if (overField(e)) {                               // the drop logs it
                if (def.huddle) { clearPlay(); render(); def.huddle(); return; }
                logPlay(g.k, def.spot ? snap(Field.spotAt(REF, e.clientX)).c : null, g.btn);
                return;
            }
            clearPlay();                                      // let go off the field: nothing
            render();
        }
        document.addEventListener("pointerup", function (e) { end(e, false); });
        document.addEventListener("pointercancel", function (e) { end(e, true); });
    }

    // ------------------------------------------------------------ PLAYERS (the Logger's flow)

    function pName(n) { return Players.name(live().offense, n); }
    function pLast(n) { return Players.last(live().offense, n) || "#" + n; }
    // the PLAYS key the pending play looks like (the field tag, the now line)
    function pendKey() {
        if (!PEND) { return ""; }
        if (PEND.type === "PASS") { return PEND.result === "INTERCEPTION" ? "INT" : (PEND.result === "INCOMPLETE" ? "INC" : "PASS"); }
        return PEND.result === "FUMBLE_LOST" ? "FUM" : "RUSH";
    }
    function pendLabel() {
        if (!PEND) { return ""; }
        var x = PEND.result === "FUMBLE_LOST" ? " - FUMBLE LOST" : (PEND.result === "INTERCEPTION" ? " - INTERCEPTED" : "");
        if (PEND.type === "PASS") { return (PEND.qb ? pLast(PEND.qb) + " " : "") + "PASS" + (PEND.rec ? " TO " + pLast(PEND.rec) : "") + x; }
        return (PEND.car ? pLast(PEND.car) + " " : "") + "RUSH" + x;
    }
    function pendReady() {
        if (!PEND || mode() !== "play" || !live().offense) { return false; }
        if (PEND.type === "PASS" && (PEND.result === "INCOMPLETE" || PEND.result === "INTERCEPTION")) { return true; }
        return FIELD.spot !== null;
    }
    function pendNow() {
        var k = pendKey(), r;
        if (!pendReady()) { return pendLabel() + " - now onto the field" + (PEND.type === "PASS" ? " (let go off the field = incomplete)" : ""); }
        if (k === "INC") { return pendLabel() + " - INCOMPLETE"; }
        if (k === "INT" && FIELD.spot === null) { return pendLabel() + " - INTERCEPTED, " + team(other(live().offense)) + " ball at the line"; }
        r = nowText(k, FIELD.spot);
        return pendLabel() + " - " + (PEND.result === "FUMBLE_RECOVERED" ? "fumble kept, " : "") + r.replace(/^(PASS COMPLETE|RUSH)\s+/, "") + "";
    }
    function pendEvent() {
        var sit = live(), c = FIELD.spot, ev = { kind: "PLAY", type: PEND.type, period: sit.period }, pl = {};
        if (PEND.type === "PASS") {
            ev.result = PEND.result || "COMPLETE";
            if (ev.result !== "INCOMPLETE") { ev.endSpot = c !== null ? c : sit.spot; }
            if (ev.result === "FUMBLE_LOST" && c > 0 && c < 100) { ev.fumbleSpot = c; }
            if (PEND.qb) { pl.passer = PEND.qb; }
            if (PEND.rec) { pl.receiver = PEND.rec; }
        } else {
            ev.endSpot = c;
            if (PEND.result === "FUMBLE_RECOVERED" || PEND.result === "FUMBLE_LOST") { ev.result = PEND.result; }
            if (PEND.result === "FUMBLE_LOST" && c > 0 && c < 100) { ev.fumbleSpot = c; }
            if (PEND.car) { pl.rusher = PEND.car; }
        }
        if (pl.passer || pl.receiver || pl.rusher) { ev.players = pl; }
        return ev;
    }
    function setPending(p, keepSpot) {
        var why = blocked();
        if (why) { refuse(why, $("playersCard")); return; }
        Entry.clear();
        PLAY.key = "";
        if (!keepSpot) { FIELD.spot = null; }
        PEND = p;
        buzz();
        render();
        Players.render();
    }
    function logPending() {
        var ev, b = $("plGrid") || $("playersCard");
        if (!pendReady()) { refuse({ text: PEND ? "Set the spot first: drag the field (or -1 / +1)" : "Pick a player first" }, b); return; }
        ev = pendEvent();
        if (!stamp(ev, "cClock")) { return; }
        clearPlay();
        add(ev, b);
        render();
        Players.render();
    }

    // A player dropped on a logged RUSH / PASS row (or one of its slots): that play gets the player.
    // role = the slot it was dropped on (rusher / passer / receiver), else: a run = rusher, a pass = QB
    // then receiver (the first empty one; a drag that went through a receiver sets both).
    // j = "" clears that role; anyTeam = picked in a huddle for that play's team (not dragged from the card).
    function assignPlayers(evId, role, j, rec, anyTeam) {
        var ev = eventById(evId), p = playById(evId), e2, pl, k, txt;
        if (!ev || !p || ev.kind !== "PLAY" || (ev.type !== "RUSH" && ev.type !== "PASS")) { App.toast("Players go on runs and passes only", false, "bad"); return; }
        if (!anyTeam && p.offense !== Players.side()) { App.toast("That is a " + team(p.offense) + " play - the PLAYERS card shows " + team(Players.side()) + " (tap the slot to pick from " + team(p.offense) + ")", false, "bad"); return; }
        pl = {}; for (k in (ev.players || {})) { if (ev.players.hasOwnProperty(k)) { pl[k] = ev.players[k]; } }
        if (!j) {
            if (!role || !pl[role]) { return; }
            delete pl[role];
            e2 = copy(ev);
            if (Object.keys(pl).length) { e2.players = pl; } else { delete e2.players; }
            txt = p.text + ": " + ({ passer: "QB", receiver: "receiver", rusher: "ball carrier" }[role]) + " cleared";
            if (App.commitBatch([{ kind: "EDIT", eventId: evId, event: e2 }], "EDIT", txt)) { buzz(20); App.toast(txt, true); }
            return;
        }
        if (ev.type === "RUSH") { pl.rusher = j; }
        else if (rec) { pl.passer = j; pl.receiver = rec; }
        else if (role === "passer" || role === "receiver") { pl[role] = j; }
        else if (!pl.passer) { pl.passer = j; }
        else if (!pl.receiver) { pl.receiver = j; }
        else { pl.receiver = j; }
        if (ev.type === "PASS" && pl.passer && pl.passer === pl.receiver) { App.toast("The QB and the receiver can't be the same player", false, "bad"); return; }
        e2 = copy(ev); e2.players = pl;
        txt = p.text + ": " + (ev.type === "RUSH" ? who(p.offense, j) : (pl.passer ? who(p.offense, pl.passer) : "QB ?") + " > " + (pl.receiver ? who(p.offense, pl.receiver) : "REC ?"));
        if (App.commitBatch([{ kind: "EDIT", eventId: evId, event: e2 }], "EDIT", txt)) { buzz(20); App.toast(txt, true); }
    }

    function who(sd, n) { return Players.last(sd, n) || "#" + n; }

    // Tap a QB / REC / RB slot in the drive log: pick (or change, or clear) that player.
    function pickSlot(evId, role) {
        var ev = eventById(evId), p = playById(evId), lab = { passer: "QB", receiver: "Receiver", rusher: "Ball carrier" }[role];
        if (!ev || !p || !lab) { return; }
        if (App.isViewing()) { refuse({ text: "Viewing an earlier point: tap Go live first", el: $("goLive") }); return; }
        Players.pickFor(p.offense, lab + " - " + p.text, (ev.players || {})[role] || "", { passer: "passing", receiver: "receiving", rusher: "rushing" }[role],
            function (v) { assignPlayers(evId, role, v, null, true); });
    }

    function playerArc(x, y) {
        var g = pdrag, a = g.tok.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2, h = "", r, rx, ry,
            recEl = g.rec ? $("plGrid").querySelector('.tok[data-j="' + g.rec + '"]') : null;
        if (recEl) {
            r = recEl.getBoundingClientRect(); rx = r.left + r.width / 2; ry = r.top + r.height / 2;
            h += '<path d="M' + ax + " " + ay + " Q " + ((ax + rx) / 2) + " " + (Math.min(ay, ry) - 50) + " " + rx + " " + ry + '" fill="none" stroke="#22c55e" stroke-width="4"/>';
            h += '<line x1="' + rx + '" y1="' + ry + '" x2="' + x + '" y2="' + y + '" stroke="#22c55e" stroke-width="3" stroke-dasharray="8 6"/>';
        } else {
            h += '<line x1="' + ax + '" y1="' + ay + '" x2="' + x + '" y2="' + y + '" stroke="#1d9e75" stroke-width="3" stroke-dasharray="8 6"/>';
        }
        $("arc").innerHTML = h;
    }

    function bindPlayers() {
        var card = $("playersCard"), chip = $("dragChip");
        card.addEventListener("contextmenu", function (e) { if (e.target.closest(".tok")) { e.preventDefault(); } });
        card.addEventListener("pointerdown", function (e) {
            var t = e.target.closest(".tok"), held;
            if (!t || !App.result || App.isViewing()) { return; }
            e.preventDefault();
            pdrag = held = { tok: t, j: t.getAttribute("data-j"), idx: +t.getAttribute("data-idx"), x: e.clientX, y: e.clientY, id: e.pointerId,
                moving: false, rec: null, hold: false };
            held.timer = setTimeout(function () {
                if (pdrag === held && !held.moving) { held.hold = true; t.classList.add("holdready"); buzz(30); }
            }, 550);
        });
        document.addEventListener("pointermove", function (e) {
            var g = pdrag, under, over, s, btn;
            if (!g || e.pointerId !== g.id || !g.j) { return; }
            if (!g.moving) {
                if (Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y) < 10) { return; }
                if (App.isViewing()) { return; }
                clearTimeout(g.timer); g.hold = false; g.tok.classList.remove("holdready");
                g.moving = true;
                Entry.clear();
                PLAY.key = ""; FIELD.spot = null;
                PEND = { type: "RUSH", car: g.j, result: "DOWN" };
                chip.textContent = pName(g.j);
                chip.style.width = ""; chip.style.height = ""; chip.style.background = ""; chip.style.borderColor = "";
                chip.hidden = false;
                document.body.classList.add("dragging-play");
                buzz(10);
            }
            chip.style.left = e.clientX + "px";
            chip.style.top = e.clientY + "px";
            under = document.elementFromPoint(e.clientX, e.clientY);
            over = under && under.closest && under.closest("#plGrid .tok");
            Array.prototype.forEach.call($("plGrid").querySelectorAll(".tok.hover"), function (x) { x.classList.remove("hover"); });
            // over another player = a pass to them; the last one stays the target on the way to the field
            if (over && over !== g.tok && over.getAttribute("data-j")) {
                if (g.rec !== over.getAttribute("data-j")) { buzz(6); }
                g.rec = over.getAttribute("data-j");
                over.classList.add("hover");
            }
            // through a play button: FUMBLE / INTERCEPTION stay on for the rest of the drag (then the field);
            // INCOMPLETE logs when you let go on it
            btn = under && under.closest && under.closest("#playBtns [data-play]");
            Array.prototype.forEach.call(document.querySelectorAll("#playBtns .pdrop, #listBody .pdrop"), function (x) { x.classList.remove("pdrop"); });
            g.inc = !!(btn && btn.getAttribute("data-play") === "INC");
            if (btn && (btn.getAttribute("data-play") === "FUM" || btn.getAttribute("data-play") === "INT") && g.mode !== btn.getAttribute("data-play")) {
                g.mode = btn.getAttribute("data-play"); buzz(8);
                chip.textContent = pName(g.j) + (g.rec ? " > " + pLast(g.rec) : "") + "  -  " + (g.mode === "FUM" ? "FUMBLE" : "INTERCEPTION");
            }
            if (btn && (g.inc || btn.getAttribute("data-play") === g.mode)) { btn.classList.add("pdrop"); }
            // over a RUSH / PASS row of the drive log: assign the player(s) to it
            g.row = under && under.closest && under.closest("#listBody .play[data-ev]");
            g.slot = under && under.closest && under.closest("#listBody .pslot");
            if (g.row && g.row.querySelector(".pslot")) { (g.slot || g.row).classList.add("pdrop"); } else { g.row = null; g.slot = null; }
            if (g.mode === "INT") { PEND = { type: "PASS", qb: g.j, rec: g.rec, result: "INTERCEPTION" }; }
            else if (g.mode === "FUM") { PEND = g.rec ? { type: "PASS", qb: g.j, rec: g.rec, result: "FUMBLE_LOST" } : { type: "RUSH", car: g.j, result: "FUMBLE_LOST" }; }
            else { PEND = g.rec ? { type: "PASS", qb: g.j, rec: g.rec, result: "COMPLETE" } : { type: "RUSH", car: g.j, result: "DOWN" }; }
            playerArc(e.clientX, e.clientY);
            if (overField(e)) {
                s = snap(Field.spotAt(REF, e.clientX));
                snapFlash(s.c, s.hit);
                FIELD.spot = s.c;
                Field.loupe(REF, e.clientX, s.c, spotText(s.c) + "   " + tagFor(pendKey(), s.c), live().spot);
            } else {
                FIELD.spot = null;
                Field.hideLoupe();
            }
            paint();
            texts();
            e.preventDefault();
        }, { passive: false });
        function end(e, cancel) {
            var g = pdrag;
            if (!g || e.pointerId !== g.id) { return; }
            pdrag = null;
            clearTimeout(g.timer);
            g.tok.classList.remove("holdready");
            chip.hidden = true;
            $("arc").innerHTML = "";
            Field.hideLoupe();
            document.body.classList.remove("dragging-play");
            Array.prototype.forEach.call(document.querySelectorAll("#plGrid .tok.hover, .pdrop"), function (x) { x.classList.remove("hover"); x.classList.remove("pdrop"); });
            if (cancel) { if (g.moving) { clearPlay(); } render(); Players.render(); return; }
            if (!g.moving) {
                if (g.hold || !g.j || blocked()) { Players.editSlot(g.idx); return; }   // hold / empty slot / no drive = set the jersey
                App.toast("Drag " + pName(g.j) + " onto the field (a run) or onto a receiver, then the field (a pass) - hold to change the slot", false);
                return;
            }
            // on a drive log row: assign the player(s) to that play
            if (g.row) { clearPlay(); assignPlayers(g.row.getAttribute("data-ev"), g.slot ? g.slot.getAttribute("data-role") : null, g.j, g.rec); render(); Players.render(); return; }
            if (blocked()) { clearPlay(); refuse(blocked(), g.tok); render(); Players.render(); return; }
            if (Players.side() !== Players.auto()) {             // the cards show the team without the ball
                clearPlay(); refuse({ text: "The cards show " + team(Players.side()) + " - " + team(Players.auto()) + " has the ball (tap " + App.result.codes[Players.auto()] + " above the cards)" }, g.tok); render(); Players.render(); return;
            }
            // on INCOMPLETE: an incomplete pass by that player (to the receiver it went through)
            if (g.inc) { PEND = { type: "PASS", qb: g.j, rec: g.rec, result: "INCOMPLETE" }; FIELD.spot = null; logPending(); return; }
            // letting go logs it, like the play buttons: on the field = a run / a completed pass to that spot,
            // or the fumble / interception it went through, at that spot;
            // on (or after) a receiver but off the field = an incomplete pass to them
            if (overField(e)) { FIELD.spot = snap(Field.spotAt(REF, e.clientX)).c; logPending(); return; }
            if (g.mode) { clearPlay(); App.toast("Drag on down to the field: where the " + (g.mode === "FUM" ? "fumble was lost" : "interception was made"), false); render(); Players.render(); return; }
            if (g.rec) { PEND = { type: "PASS", qb: g.j, rec: g.rec, result: "INCOMPLETE" }; FIELD.spot = null; logPending(); return; }
            clearPlay();                                        // a run let go off the field: nothing
            render();
            Players.render();
        }
        document.addEventListener("pointerup", function (e) { end(e, false); });
        document.addEventListener("pointercancel", function (e) { end(e, true); });

    }

    // ------------------------------------------------------------ huddles

    function seg(act, items, cur) {
        return '<div class="seg big wrap">' + items.map(function (it) {
            return '<button data-act="' + act + '" data-v="' + esc(it[0]) + '"' + (String(cur) === String(it[0]) ? ' class="on"' : '') +
                (it[2] ? ' disabled' : '') + '>' + it[1] + '</button>';
        }).join("") + '</div>';
    }
    function huddle(title, h) { Huddles.custom(title, h); }
    function clockField(name, val, label) {
        return '<label class="fld inl"><span>' + esc(label) + '</span><input class="clock" data-kp="clock" inputmode="none" data-in="' + name + '" value="' + esc(val || "") +
            '" inputmode="numeric" placeholder="m:ss" autocomplete="off"></label>';
    }
    function normOk(v) { var c = Fmt.normClock(v); return !c || StatsEngine.parseClock(c) !== null ? c : null; }

    // GRIDIRON's time picker: the m:ss box. Tap = the keypad (921 = 9:21), drag left / right = nudge
    // (6 px = 1 s). TP[id] = { get(), set(v) } is registered by whoever draws it.
    var TP = {}, tpDrag = null;
    function tpHtml(id, val, label) {
        return '<div class="tpk" data-tp="' + id + '"><span class="k">' + esc(label) + '</span><b>' + esc(val || "--:--") + '</b><small>tap to type, drag to nudge</small></div>';
    }
    function tpSecs(v) { var c = normOk(v); return c ? StatsEngine.parseClock(c) : null; }
    function bindTimePicker() {
        document.addEventListener("pointerdown", function (e) {
            var el = e.target.closest && e.target.closest(".tpk"), id;
            if (!el || e.target.tagName === "INPUT") { return; }
            id = el.getAttribute("data-tp");
            if (!TP[id]) { return; }
            tpDrag = { el: el, id: id, x0: e.clientX, base: tpSecs(TP[id].get()), moved: false };
            if (tpDrag.base === null) { tpDrag.base = rules().q * 60; }
            try { el.setPointerCapture(e.pointerId); } catch (x) { /* old browsers */ }
        });
        document.addEventListener("pointermove", function (e) {
            var g = tpDrag, v;
            if (!g) { return; }
            if (!g.moved && Math.abs(e.clientX - g.x0) < 8) { return; }
            g.moved = true;
            v = clamp(g.base + Math.round((e.clientX - g.x0) / 6), 0, rules().q * 60);
            v = StatsEngine.fmtClock(v);
            if (v !== TP[g.id].get()) { TP[g.id].set(v); buzz(3); var b = g.el.isConnected ? g.el : document.querySelector('.tpk[data-tp="' + g.id + '"]'); if (b) { g.el = b; b.querySelector("b").textContent = v; } }
        });
        document.addEventListener("pointerup", function () {
            var g = tpDrag, b, inp, done;
            tpDrag = null;
            if (!g || g.moved) { if (g && TP[g.id].after) { TP[g.id].after(); } return; }
            Keypad.open({ title: (g.el.querySelector(".k") || {}).textContent || "Time", mode: "clock", value: TP[g.id].get(),
                done: function (v) {
                    var nb;
                    if (v) { TP[g.id].set(v); }
                    nb = g.el.isConnected ? g.el : document.querySelector('.tpk[data-tp="' + g.id + '"]');
                    if (nb && nb.querySelector("b")) { nb.querySelector("b").textContent = TP[g.id].get() || "--:--"; }
                    if (TP[g.id].after) { TP[g.id].after(); }
                } });
        });
    }

    // Drive time from its start (period + clock) to an end clock in the period of the ending play.
    function driveTime(d, endClock, endPeriod) {
        var s = d.startClock ? StatsEngine.parseClock(d.startClock.clock) : null, e = tpSecs(endClock), q = rules().q * 60, t;
        if (s === null || e === null || !d.startClock) { return null; }
        t = s - e + (Math.max(0, (endPeriod || d.startClock.period) - d.startClock.period)) * q;
        return t >= 0 ? StatsEngine.fmtClock(t) : null;
    }

    // DRIVE ENDED (GRIDIRON's End Drive huddle): a play just ended the drive (TD, punt, turnover,
    // downs, FG...): its END TIME, with the drive time shown live. SAVE puts the time on that play,
    // so the drive's time, possession time and the next drive's start time all follow.
    function driveEndedHuddle(d) {
        var evId = d.playIds[d.playIds.length - 1], ev = eventById(evId), X;
        if (!ev) { return; }
        X = { clock: ev.clock || (d.startClock && d.startClock.period === ev.period ? d.startClock.clock : rules().q + ":00") };
        TP.end = { get: function () { return X.clock; }, set: function (v) { X.clock = v; var t = document.getElementById("dtEnd"); if (t) { t.textContent = driveTime(d, X.clock, ev.period) || "-"; } } };
        huddle(d.team + " drive " + d.num + " ended - " + Fmt.driveResult(d), {
            render: function () {
                return '<p class="muted">Started ' + (d.startClock ? esc(d.startClock.clock) + ' ' + esc(Fmt.periodShort(d.startClock.period)) : 'with no time (EDIT on the drive card sets it)') +
                    ' at ' + esc(spotText(d.startSpot)) + ' - ' + d.plays + ' play' + (d.plays === 1 ? '' : 's') + ', ' + signed(d.yards) + ' yds</p>' +
                    tpHtml("end", X.clock, "END TIME") +
                    '<div class="dtime"><span class="k">DRIVE TIME</span> <b id="dtEnd">' + esc(driveTime(d, X.clock, ev.period) || "-") + '</b></div>' +
                    '<div class="hrow end"><button class="btn big" data-act="close">NO TIME</button><button class="btn big primary" data-act="etSave">SAVE END TIME</button></div>';
            },
            act: function (a) {
                var c, e2;
                if (a !== "etSave") { return; }
                c = normOk(X.clock);
                if (!c) { Huddles.say("End time must be m:ss (921 = 9:21)", true); return; }
                e2 = copy(ev); e2.clock = c;
                if (!App.commitBatch([{ kind: "EDIT", eventId: ev.id, event: e2 }], "EDIT", d.team + " drive " + d.num + " end time " + c)) { Huddles.say("Not saved, try again", true); return; }
                buzz(25);
                Huddles.close();
            }
        });
    }

    // ---- FIELD GOAL: drop FG anywhere (or tap it). The distance is the line
    // of scrimmage + 17 (the engine works it out). A miss: the other team
    // takes over at the touchback spot or at the line of scrimmage.
    function fgHuddle() {
        var why = blocked(), F = { result: "", after: "TB" };
        if (why) { refuse(why, $("playBtns").querySelector('[data-play="FG"]')); return; }
        huddle("Field goal - " + team(live().offense), {
            render: function () {
                var sit = live(), def = other(sit.offense), dist = Fmt.rel(def, sit.spot) + 17, h;
                h = '<div class="dsum big"><b>' + dist + '</b> <span class="k">yards - from ' + esc(spotText(sit.spot)) + ' (line of scrimmage + 17)</span></div>';
                h += '<h3>Result</h3>' + seg("fgRes", [["GOOD", "GOOD"], ["NO_GOOD", "NO GOOD"], ["BLOCKED", "BLOCKED"]], F.result);
                if (F.result && F.result !== "GOOD") {
                    h += '<h3>' + esc(team(def)) + ' takes over</h3>' + seg("fgAfter", [["TB", "TOUCHBACK (" + esc(team(def)) + " " + rules().tb + ")"], ["LINE", "AT THE LINE (" + esc(spotText(sit.spot)) + ")"]], F.after);
                }
                h += '<div class="hrow">' + clockField("cl", F.clock, "Clock after the kick") + '</div>';
                h += '<div class="hrow end"><button class="btn big" data-act="close">CANCEL</button><button class="btn big primary" data-act="fgLog"' + (F.result ? '' : ' disabled') + '>LOG FIELD GOAL</button></div>';
                return h;
            },
            input: function (n, v) { F.clock = v; },
            act: function (a, v) {
                var sit = live(), ev, c;
                if (a === "fgRes") { F.result = v; F.after = v === "BLOCKED" ? "LINE" : "TB"; Huddles.refresh(); return; }
                if (a === "fgAfter") { F.after = v; Huddles.refresh(); return; }
                if (a !== "fgLog") { return; }
                c = normOk(F.clock);
                if (c === null) { Huddles.say("Clock must be m:ss (721 = 7:21)", true); return; }
                ev = { kind: "PLAY", type: "FG", result: F.result, period: sit.period };
                if (F.result !== "GOOD" && F.after === "LINE") { ev.endSpot = sit.spot; }
                if (c) { ev.clock = c; }
                var r = App.addEvent(ev);
                if (!r.ok) { Huddles.say(r.reason, true); return; }
                buzz(25);
                Huddles.close();
            }
        });
    }

    // ---- PENALTIES: OFF PEN / DEF PEN, dropped anywhere (or tapped).
    //   OFFENSIVE  DEAD BALL (false start, delay...): back from the line of scrimmage, same down again.
    //              SPOT FOUL (holding...): log the PASS / RUSH to where the foul happened first; it is
    //              enforced back from there and that down is played again, to the old line to gain.
    //              LOSS OF DOWN (intentional grounding...): the down counts as well.
    //   DEFENSIVE  FROM THE LINE: forward from the line of scrimmage. SPOT FOUL (pass interference...):
    //              log the PASS / RUSH to the spot first; forward from there. Same down unless it
    //              reaches the line to gain; AUTOMATIC 1ST DOWN for the fouls that give one.
    // Yards 5 / 10 / 15 or OTHER; more than half the distance to the goal = half the distance
    // (from inside the 2: to the inches). A spot foul is two events (the penalty + a SPOT for
    // the down), committed and undone together.
    function penLastPlay() {
        var d = openDrive(), p;
        if (!d || !d.playIds.length) { return null; }
        p = playById(d.playIds[d.playIds.length - 1]);
        return p && (p.type === "PASS" || p.type === "RUSH") && p.result !== "INCOMPLETE" && !p.turnover && !p.td ? p : null;
    }
    function penEnforce(P) {
        var sit = live(), off = sit.offense, r = Fmt.rel(off, sit.spot), room = P.kind === "OFF" ? r : 100 - r, half = P.yards > room / 2;
        var py = half ? (room <= 1 ? room / 2 : Math.floor(room / 2)) : P.yards;
        return { spot: Fmt.abs(off, r + (P.kind === "OFF" ? -py : py)), yards: py, half: half };
    }
    // The events for the penalty as it stands, the Result after them, or why not.
    function penEvents(P) {
        var sit = live(), off = sit.offense, fp = P.foul === "SPOT" ? penLastPlay() : null, en, pen, after, list, down, s2, v;
        if (!P.yards || !P.foul) { return { ok: false, reason: "Pick the foul and the yards" }; }
        en = penEnforce(P);
        pen = { kind: "PLAY", type: "PENALTY", period: sit.period, endSpot: en.spot, penalty: { on: P.kind, yards: en.yards } };
        if (P.kind === "DEF" && P.auto) { pen.penalty.autoFirst = true; }
        if (P.kind === "OFF" && P.loss) { pen.penalty.lossOfDown = true; }
        v = StatsEngine.validate(res(), pen);
        if (!v.ok) { return { ok: false, reason: v.reason }; }
        list = [pen];
        after = StatsEngine.replay(App.game.setup || {}, App.events.concat(list));
        if (fp) {
            s2 = after.situation;
            if (s2.offense === off && s2.phase === "SCRIMMAGE" && !after.plays[after.plays.length - 1].firstDown) {
                down = fp.down + (P.kind === "OFF" && P.loss ? 1 : 0);
                if (down > 4) { return { ok: false, reason: "Loss of down on 4th down is a turnover on downs: log it as a play" }; }
                if (s2.spot > 0 && s2.spot < 100 && (fp.lineToGain - s2.spot) * Fmt.dir(off) > 0) {
                    list.push({ kind: "SPOT", spot: s2.spot, down: down, lineToGain: fp.lineToGain, period: sit.period });
                    after = StatsEngine.replay(App.game.setup || {}, App.events.concat(list));
                }
            }
        }
        return { ok: true, list: list, after: after, enforce: en };
    }
    function penPreview(P) {
        var sit = live(), r = penEvents(P), s2;
        if (!r.ok) { return '<span class="k">' + esc(r.reason) + '</span>'; }
        s2 = r.after.situation;
        return '<span class="k">NOW</span> <b>' + esc(sit.ddText) + '</b> <span class="k">at ' + esc(spotText(sit.spot)) + '</span>  &rarr;  ' +
            (s2.offense === sit.offense && s2.phase === "SCRIMMAGE" ? '<b>' + esc(s2.ddText) + '</b> <span class="k">at ' + esc(spotText(s2.spot)) + '</span>' :
                '<b>' + esc(r.after.plays[r.after.plays.length - 1].text) + '</b>') +
            (r.enforce.half ? '<br><span class="k">half the distance to the goal: ' + (r.enforce.yards < 1 ? 'to the inches' : r.enforce.yards + ' yds') + '</span>' : '');
    }
    function penHuddle(kind) {
        var why = blocked(), P = { kind: kind, foul: kind === "OFF" ? "" : "LINE", yards: null, other: "", auto: false, loss: false, clock: "" };
        if (why) { refuse(why, $("playBtns").querySelector('[data-play="' + kind + 'PEN"]')); return; }
        huddle((kind === "OFF" ? "Offensive" : "Defensive") + " penalty - on " + team(kind === "OFF" ? live().offense : other(live().offense)), {
            render: function () {
                var canSpot = !!penLastPlay(), off = P.kind === "OFF", h, std = [5, 10, 15].indexOf(P.yards) >= 0;
                h = '<h3>Foul</h3>' + seg("foul", [
                    ["SPOT", "SPOT FOUL<small>" + (canSpot ? "from where the last play ended - " + (off ? "replay the down" : "same down unless it gains it") : "log the PASS / RUSH to the spot first") + "</small>", !canSpot],
                    off ? ["DEAD", "DEAD BALL<small>from the line of scrimmage</small>"] : ["LINE", "FROM THE LINE<small>from the line of scrimmage</small>"]
                ], P.foul);
                h += '<h3>Yards</h3><div class="hrow">' + seg("py", [[5, "5"], [10, "10"], [15, "15"]], std ? P.yards : "") +
                    '<label class="fld inl"><span>Other</span><input class="clock" data-kp="number" inputmode="none" data-in="py" value="' + esc(std ? "" : P.other) + '" inputmode="numeric" placeholder="yds" autocomplete="off"></label></div>';
                h += '<div class="hrow">' + (off ? '<button class="tog' + (P.loss ? ' on' : '') + '" data-act="loss">LOSS OF DOWN</button>' :
                    '<button class="tog' + (P.auto ? ' on' : '') + '" data-act="auto">AUTOMATIC 1ST DOWN</button>') + clockField("cl", P.clock, "Clock") + '</div>';
                h += '<div class="dsum" id="penPrev">' + penPreview(P) + '</div>';
                h += '<div class="hrow end"><button class="btn big" data-act="close">CANCEL</button><button class="btn big primary" data-act="penLog">LOG PENALTY</button></div>';
                return h;
            },
            input: function (n, v) {
                if (n === "cl") { P.clock = v; return; }
                P.other = v;
                P.yards = parseInt(v, 10) > 0 && parseInt(v, 10) < 100 ? parseInt(v, 10) : null;
                Array.prototype.forEach.call($("hBody").querySelectorAll('[data-act="py"]'), function (b) { b.classList.remove("on"); });
                $("penPrev").innerHTML = penPreview(P);
            },
            act: function (a, v) {
                var r, c, ops, id;
                if (a === "foul") { P.foul = v; }
                else if (a === "py") { P.yards = +v; P.other = ""; }
                else if (a === "auto") { P.auto = !P.auto; }
                else if (a === "loss") { P.loss = !P.loss; }
                else if (a === "penLog") {
                    r = penEvents(P);
                    if (!r.ok) { Huddles.say(r.reason, true); return; }
                    c = normOk(P.clock);
                    if (c === null) { Huddles.say("Clock must be m:ss (721 = 7:21)", true); return; }
                    if (c) { r.list[0].clock = c; }
                    id = App.newEventId();
                    ops = r.list.map(function (ev, i) { return { kind: "ADD", eventId: i ? id + "." + (i + 1) : id, event: ev }; });
                    if (!App.commitBatch(ops, "LIVE")) { Huddles.say("Not logged, try again", true); return; }
                    buzz(25);
                    Huddles.close();
                    return;
                } else { return; }
                Huddles.refresh();
            }
        });
    }

    // ---- D&D huddle (MOVE THE LINES, or a tap on the preview line). The D&D
    // can always be changed: SAVE writes a SPOT event (no stats). Moving the
    // blue line keeps the line to gain where it is; moving the yellow line
    // changes the distance from the same spot. The down stays unless changed.
    function ddHuddle(kind, c) {
        var sit = live(), off = sit.offense, dr = Fmt.dir(off), D, ltg;
        if (!off || mode() !== "play") { return; }
        D = { spot: sit.spot, down: sit.down || 1, toGo: Math.max(1, Math.round(sit.toGo || 10)), goal: !!sit.goal };
        if (kind === "LOS") {
            D.spot = c;
            ltg = sit.lineToGain;
            if ((ltg - c) * dr <= 0) { ltg = c + 10 * dr; }
            D.goal = (ltg - Fmt.goalOf(off)) * dr >= 0;
            D.toGo = D.goal ? Math.round(Math.abs(Fmt.goalOf(off) - c)) : Math.round((ltg - c) * dr);
        } else if (kind === "GAIN") {
            D.goal = c === Fmt.goalOf(off);
            D.toGo = Math.round((c - sit.spot) * dr);
        }
        function lineOf() {
            var g = Fmt.goalOf(off), l = D.spot + D.toGo * dr;
            return D.goal || (l - g) * dr >= 0 ? g : l;
        }
        function nowDD() { return ddText(D.down, D.goal ? 0 : D.toGo, D.goal || lineOf() === Fmt.goalOf(off)); }
        huddle(kind === "LOS" ? "Move the line of scrimmage" : (kind === "GAIN" ? "Move the line to gain" : "Down & distance"), {
            render: function () {
                var h = '<div class="dsum center"><span class="k">NOW</span> <b>' + esc(sit.ddText) + '</b> <span class="k">at ' + esc(spotText(sit.spot)) + '</span>  &rarr;  ' +
                    '<b>' + esc(nowDD()) + '</b> <span class="k">at ' + esc(spotText(D.spot)) + '</span></div>';
                h += '<h3>Down</h3>' + seg("down", [[1, "1ST"], [2, "2ND"], [3, "3RD"], [4, "4TH"]], D.down);
                h += '<h3>To go</h3><div class="hrow"><div class="stepper"><button data-act="togo" data-v="-1">&minus;</button><span>' + (D.goal ? "Goal" : D.toGo) +
                    '</span><button data-act="togo" data-v="1">+</button></div><button class="tog' + (D.goal ? ' on' : '') + '" data-act="goal">GOAL TO GO</button>' +
                    '<button class="tog" data-act="first">1ST &amp; 10</button></div>';
                h += '<h3>Ball on</h3><div class="hrow"><div class="stepper"><button data-act="spot" data-v="-1">&minus;1</button><span>' + esc(spotText(D.spot)) +
                    '</span><button data-act="spot" data-v="1">+1</button></div></div>';
                h += '<div class="hrow end"><button class="btn big" data-act="close">CANCEL</button><button class="btn big primary" data-act="ddSave">' + (kind === "DD" ? "SAVE D&amp;D" : "MOVE + UPDATE D&amp;D") + '</button></div>';
                return h;
            },
            onClose: function () { paint(); },
            act: function (a, v) {
                var ev, r;
                if (a === "down") { D.down = +v; }
                else if (a === "togo") { D.goal = false; D.toGo = clamp(D.toGo + (+v), 1, 99); }
                else if (a === "goal") { D.goal = !D.goal; }
                else if (a === "first") { D.down = 1; D.toGo = 10; D.goal = false; }
                else if (a === "spot") { D.spot = clamp(Fmt.abs(off, Fmt.rel(off, D.spot) + (+v)), 1, 99); }
                else if (a === "ddSave") {
                    ev = { kind: "SPOT", spot: D.spot, down: D.down, lineToGain: lineOf(), period: sit.period };
                    r = App.addEvent(ev);
                    if (!r.ok) { Huddles.say(r.reason, true); return; }
                    buzz(20);
                    Huddles.close();
                    return;
                } else { return; }
                Huddles.refresh();
            }
        });
    }

    // ------------------------------------------------------------ DRIVE CARD

    // The event that opened drive `num`: the first n events whose replay has
    // that many drives (drives only ever grow, so a binary search).
    function opener(num) {
        var evs = App.events, setup = App.game.setup || {}, lo = 1, hi = evs.length, mid;
        while (lo < hi) {
            mid = (lo + hi) >> 1;
            if (StatsEngine.replay(setup, evs.slice(0, mid)).drives.length >= num) { hi = mid; } else { lo = mid + 1; }
        }
        return { ev: evs[lo - 1], index: lo - 1 };
    }
    // A drive can be deleted while it has no plays and a KICKOFF / POSSESSION started it.
    function deletable(d) {
        var o;
        if (!d || d.playIds.length) { return null; }
        o = opener(d.num);
        return o.ev && (o.ev.kind === "KICKOFF" || o.ev.kind === "POSSESSION") ? o.ev : null;
    }

    function defaultStartTime() {
        var sit = live(), ld = lastDrive(), q = rules().q;
        if (!ld) { return q + ":00"; }
        if (ld.endClock && ld.endClock.period === sit.period && ld.endClock.clock !== "0:00") { return ld.endClock.clock; }
        if (ld.endClock && ld.endClock.clock === "0:00") { return q + ":00"; }       // end of a half: the next one starts at the top
        return "";
    }

    function renderDrive() {
        var C = $("driveCard"), sit = live(), m = mode(), d = openDrive(), ld = lastDrive(), side, h, last, lp, sc, rel, del;
        if (m === "final") {
            C.innerHTML = '<div class="cardLbl">FINAL</div><div class="dsum big"><b>' + esc(team("AWAY")) + ' ' + res().score.AWAY + ' - ' + esc(team("HOME")) + ' ' + res().score.HOME + '</b></div>';
            return;
        }
        if (m === "try") {
            sc = ld && ld.result === "TD" ? ' <span class="hint">- after the touchdown (drive ' + ld.num + ')</span>' : '';
            C.innerHTML = '<div class="cardLbl">TRY - ' + esc(team(sit.trySide)) + sc + '</div><div class="rgrid two" id="tryBtns">' +
                '<button class="big good" data-c="try" data-v="PAT:GOOD">PAT GOOD</button><button class="big miss" data-c="try" data-v="PAT:NO_GOOD">PAT NO GOOD</button>' +
                '<button class="big good" data-c="try" data-v="TWO_PT:GOOD">2PT GOOD</button><button class="big miss" data-c="try" data-v="TWO_PT:NO_GOOD">2PT NO GOOD</button></div>';
            return;
        }
        if (m === "next") {
            side = nextSide();
            if (keys.next !== keys.nextSeen) { keys.nextSeen = keys.next; NEXT.time = defaultStartTime(); }
            TP.next = { get: function () { return NEXT.time; }, set: function (v) { NEXT.time = v; } };
            last = ld ? team(ld.side) + " drive " + ld.num + ": " + Fmt.driveResult(ld) + (ld.time ? ", " + ld.timeText : "") : "";
            rel = startRel();
            C.innerHTML = '<div class="cardLbl">NEXT DRIVE' + (last ? ' <span class="hint">- last: ' + esc(last) + '</span>' : '') + '</div>' +
                '<div class="rgrid two">' + ["AWAY", "HOME"].map(function (s) {
                    return '<button class="' + s.toLowerCase() + (side === s ? ' on' : '') + '" data-c="side" data-v="' + s + '">' + esc(team(s)) + '</button>';
                }).join("") + '</div>' +
                '<div class="dsum"><span class="k">START SPOT</span> <b>' + esc(spotText(startAbs())) + '</b> <span class="k">- drag the field, or:</span></div>' +
                '<div class="rgrid two"><button class="' + (FIELD.tb ? 'on' : '') + '" data-c="ss" data-v="TB">TOUCHBACK (' + rules().tb + ')</button>' +
                '<button class="' + (!FIELD.tb && rel === 35 ? 'on' : '') + '" data-c="ss" data-v="35">OUT OF BOUNDS (35)</button></div>' +
                tpHtml("next", NEXT.time, "START TIME") +
                '<div class="trow"><span class="hint">' + esc(Fmt.PERIOD_TEXT[sit.period] || sit.periodLabel) + ' quarter - kickoff, ' + esc(team(other(side))) + ' kicking' +
                (ld && ld.endClock ? ' - the clock starts where ' + esc(team(ld.side)) + ' drive ' + ld.num + ' stopped' : '') + '</span></div>' +
                '<button id="startBtn" class="big primary" data-c="start">START ' + esc(team(side)) + ' DRIVE</button>';
            return;
        }
        lp = d.playIds.length ? playById(d.playIds[d.playIds.length - 1]) : null;
        del = deletable(d);
        h = '<div class="cardLbl">DRIVE ' + d.num + ' - ' + esc(d.team) + (sit.offense ? '' : ' <span class="tagoff">BALL OFF</span>') + '</div>' +
            '<div class="dsum tap" data-c="edit" title="Tap to change where / when the drive started"><span class="ed1">EDIT</span>' +
            '<span class="k">STARTED</span> <b>' + esc(spotText(d.startSpot)) + '</b> <span class="k">at</span> <b>' + esc(d.startClock ? d.startClock.clock : "--:--") + '</b>' +
            ' <span class="k">' + esc(d.startClock ? Fmt.periodShort(d.startClock.period) : "") + ' · ' + esc(Fmt.driveStart(d)) + '</span><br>' +
            '<span class="k">SO FAR</span> <b>' + d.plays + '</b> <span class="k">play' + (d.plays === 1 ? '' : 's') + ',</span> <b>' + signed(d.yards) + '</b> <span class="k">yds</span>' +
            (lp ? '<span class="lastp">LAST: ' + esc(lp.text) + '</span>' : '') + '</div>' +
            '<div class="rgrid" style="grid-template-columns:' + (del ? '2fr 1fr' : '1fr') + '">' +
            '<button class="hold" data-c="end"><i></i><span>HOLD: END DRIVE</span></button>' + (del ? '<button data-c="del">DELETE</button>' : '') + '</div>';
        C.innerHTML = h;
    }

    function bindDrive() {
        var C = $("driveCard");
        C.addEventListener("click", function (e) {
            var b = e.target.closest("[data-c]"), c, v, parts, ev, d = openDrive(), side, t;
            if (!b || !App.result) { return; }
            c = b.getAttribute("data-c"); v = b.getAttribute("data-v");
            if (c === "end") { return; }                      // the hold handler
            if (App.isViewing()) { refuse({ text: "Viewing an earlier point: tap Go live to log", el: $("goLive") }, b); return; }
            if (Entry.mode !== "LIVE") { refuse({ text: "Finish the edit first: SAVE or Cancel in the entry panel", el: $("enMode") }, b); return; }
            if (c === "side") { NEXT.side = v; buzz(); render(); return; }
            if (c === "ss") { if (v === "TB") { FIELD.start = null; FIELD.tb = true; } else { setStart(+v); } buzz(); render(); return; }
            if (c === "try") {
                parts = v.split(":");
                add({ kind: "PLAY", type: parts[0], result: parts[1], period: live().period }, b);
                return;
            }
            if (c === "start") {
                side = nextSide();
                t = normOk(NEXT.time);
                if (t === null) { refuse({ text: "Start time must be m:ss (1200 = 12:00)" }, C.querySelector(".tpk")); return; }
                ev = { kind: "KICKOFF", receiving: side, period: live().period };
                if (FIELD.tb) { ev.touchback = true; } else { ev.spot = startAbs(); }
                if (t) { ev.clock = t; }
                if (add(ev, b)) { NEXT.side = null; FIELD.start = null; FIELD.tb = false; }
                return;
            }
            if (c === "edit" && d) { buzz(); editHuddle(d); return; }
            if (c === "del" && d) { buzz(); deleteDrive(d, null); }
        });
    }

    function deleteDrive(d, thenSide) {
        var ev = deletable(d), ops;
        if (!ev) { return; }
        ops = [{ kind: "VOID", eventId: ev.id }];
        if (thenSide) { ops.push({ kind: "ADD", eventId: App.newEventId(), event: { kind: "POSSESSION", side: thenSide, reason: "manual", period: live().period } }); }
        App.commitBatch(ops, "DELETE", team(d.side) + " drive " + d.num + " deleted" + (thenSide ? " - " + team(thenSide) + " ball" : ""));
    }

    // HOLD: END DRIVE (600 ms). Touchdowns, turnovers, punts, field goals and
    // 4th down short end the drive by themselves when the play is logged, so
    // this is for the rest: end of the half / game, or the other team simply
    // getting the ball (possession change, with the time it happened).
    function bindHold() {
        document.addEventListener("pointerdown", function (e) {
            var b = e.target.closest && e.target.closest(".hold"), bar, t0, done = false;
            if (!b) { return; }
            bar = b.querySelector("i"); t0 = Date.now(); b._h = true;
            (function step() {
                var f;
                if (!b._h) { return; }
                f = (Date.now() - t0) / 600;
                bar.style.width = Math.min(100, f * 100) + "%";
                if (f >= 1 && !done) { done = true; b._h = false; bar.style.width = "0"; buzz(50); if (b.getAttribute("data-c") === "end") { endHuddle(null); } return; }
                requestAnimationFrame(step);
            })();
            function stop() { b._h = false; if (!done) { bar.style.width = "0"; } }
            b.addEventListener("pointerup", stop, { once: true });
            b.addEventListener("pointerleave", stop, { once: true });
        });
    }

    function endHuddle(want) {
        var d = openDrive(), sit = live(), E = { result: want ? "POSSESSION" : "", clock: "", sure: false };
        if (!d) { return; }
        if (App.isViewing() || Entry.mode !== "LIVE") { refuse(blocked() || { text: "Not now" }, $("driveCard")); return; }
        huddle("End " + d.team + " drive " + d.num, {
            render: function () {
                var o = team(other(d.side)), h;
                h = '<p class="muted">Touchdowns, turnovers, punts, field goals and 4th down short end the drive by themselves: log them with the play buttons.</p>';
                h += '<h3>How it ended</h3>' + seg("res", [
                    ["POSSESSION", "POSSESSION CHANGE<small>" + esc(o) + " ball at " + esc(spotText(sit.spot)) + "</small>"],
                    ["HALF", "END OF HALF<small>0:00, kickoff next</small>"],
                    ["FINAL", "END OF GAME<small>0:00, final</small>"],
                    ["PUNT", "PUNT<small>drag PUNT to the spot</small>"],
                    ["FG", "FIELD GOAL<small>the FG huddle</small>"]
                ], E.result);
                if (E.result === "POSSESSION") {
                    TP.endp = { get: function () { return E.clock; }, set: function (v) { E.clock = v; var t = document.getElementById("dtEndP"); if (t) { t.textContent = driveTime(d, E.clock, sit.period) || "-"; } } };
                    h += tpHtml("endp", E.clock, "END TIME") + '<div class="dtime"><span class="k">DRIVE TIME</span> <b id="dtEndP">' + esc(driveTime(d, E.clock, sit.period) || "-") + '</b></div>' +
                        '<p class="muted">No time = left out of possession time.</p>';
                }
                h += '<div class="hrow end"><button class="btn big" data-act="close">CANCEL</button><button class="btn big primary" data-act="endLog"' + (E.result ? '' : ' disabled') + '>' +
                    (E.result === "FINAL" && E.sure ? "TAP AGAIN: END THE GAME" : "END DRIVE") + '</button></div>';
                return h;
            },
            input: function (n, v) { E.clock = v; },
            act: function (a, v) {
                var ev, c, r;
                if (a === "res") {
                    if (v === "PUNT") { Huddles.close(); shake($("playBtns").querySelector('[data-play="PUNT"]')); App.toast("Drag PUNT to where " + team(other(d.side)) + " takes over (their end zone = touchback)", false); return; }
                    if (v === "FG") { fgHuddle(); return; }
                    E.result = v; E.sure = false; Huddles.refresh(); return;
                }
                if (a !== "endLog" || !E.result) { return; }
                if (E.result === "FINAL" && !E.sure) { E.sure = true; Huddles.refresh(); return; }
                if (E.result === "POSSESSION") {
                    c = normOk(E.clock);
                    if (c === null) { Huddles.say("End time must be m:ss (721 = 7:21)", true); return; }
                    ev = { kind: "POSSESSION", side: other(d.side), reason: "manual", period: sit.period };
                    if (c) { ev.clock = c; }
                } else {
                    ev = { kind: "PERIOD", period: E.result };
                }
                r = App.addEvent(ev);
                if (!r.ok) { Huddles.say(r.reason, true); return; }
                buzz(25);
                Huddles.close();
            }
        });
    }

    // NO ORPHAN DRIVES: giving the ball to the other team while a drive is
    // open asks first. CLOSE IT = one tap (the drive ends as a possession
    // change at the current spot, no end time). SET HOW IT ENDED = the End
    // Drive huddle. DELETE IT = a drive with no plays started by mistake.
    // CANCEL = nothing changes.
    function possession(side, btn) {
        var d = openDrive(), sit = live();
        if (side !== "NONE" && d && d.side !== side) {
            buzz(20);
            huddle("Possession change - " + d.team + " drive " + d.num + " is still open", {
                render: function () {
                    var n = d.plays, del = deletable(d);
                    return '<div class="dsum">Close it before ' + esc(team(side)) + ' gets the ball: <b>' + n + '</b> <span class="k">play' + (n === 1 ? '' : 's') + ' so far</span></div>' +
                        '<div class="hrow"><button class="btn big primary" data-act="pcClose">CLOSE IT - ' + esc(team(side)) + ' BALL<small>at ' + esc(spotText(sit.spot)) + ', ends as possession change</small></button>' +
                        (del ? '<button class="btn big danger" data-act="pcDel">DELETE IT<small>no plays - started by mistake</small></button>' : '') + '</div>' +
                        '<div class="hrow"><button class="btn big" data-act="pcEnd">SET HOW IT ENDED (result + end time)</button>' +
                        '<button class="btn big" data-act="close">CANCEL - keep ' + esc(d.team) + ' ball</button></div>';
                },
                act: function (a) {
                    if (a === "pcClose") { Huddles.close(); add({ kind: "POSSESSION", side: side, reason: "manual", period: sit.period }, btn); }
                    else if (a === "pcDel") { Huddles.close(); deleteDrive(d, side); }
                    else if (a === "pcEnd") { endHuddle(side); }
                }
            });
            return;
        }
        add({ kind: "POSSESSION", side: side, reason: "manual", period: sit.period }, btn);
    }

    // EDIT DRIVE: tap the STARTED line of the open drive: its start spot
    // (steps / presets) and start time. The drive's plays keep their yards and
    // move with the new start. The event that started it is edited (kickoff,
    // possession, or the punt / turnover where the ball changed hands), or a
    // POSSESSION is put in front of a drive that started with its first play.
    function editHuddle(d) {
        var X = { rel: Fmt.rel(d.side, d.startSpot), tb: false, clock: d.startClock ? d.startClock.clock : "" };
        huddle("Edit drive " + d.num + " - " + d.team, {
            render: function () {
                return '<h3>Start spot</h3><div class="spotStep"><button data-act="ds" data-v="-5">-5</button><button data-act="ds" data-v="-1">-1</button><div>' +
                    esc(spotText(Fmt.abs(d.side, X.rel))) + '</div><button data-act="ds" data-v="1">+1</button><button data-act="ds" data-v="5">+5</button></div>' +
                    '<div class="hrow"><button class="tog' + (X.tb ? ' on' : '') + '" data-act="dset" data-v="TB">TOUCHBACK (' + rules().tb + ')</button><button class="tog" data-act="dset" data-v="35">OUT OF BOUNDS (35)</button></div>' +
                    '<div class="hrow">' + clockField("cl", X.clock, "Start time") + '</div>' +
                    '<p class="muted">' + (d.plays ? 'The ' + d.playIds.length + ' play' + (d.playIds.length === 1 ? '' : 's') + ' keep their yards and move with the new start.' : 'No plays yet.') + '</p>' +
                    '<div class="hrow end"><button class="btn big" data-act="close">CANCEL</button><button class="btn big primary" data-act="deSave">SAVE</button></div>';
            },
            input: function (n, v) { X.clock = v; },
            act: function (a, v) {
                var r;
                if (a === "ds") { X.rel = clamp(X.rel + (+v), 1, 99); X.tb = false; }
                else if (a === "dset") { if (v === "TB") { X.rel = rules().tb; X.tb = true; } else { X.rel = +v; X.tb = false; } }
                else if (a === "deSave") {
                    r = editDrive(d, X);
                    if (!r.ok) { Huddles.say(r.reason, true); return; }
                    Huddles.close();
                    return;
                } else { return; }
                Huddles.refresh();
            }
        });
    }
    function invalid(w) { return w.filter(function (x) { return x.code === "INVALID"; }).length; }
    function editDrive(d, X) {
        var o = opener(d.num), ev = o.ev, newAbs = Fmt.abs(d.side, X.rel), delta = newAbs - d.startSpot, ops = [], e2, c = normOk(X.clock), id, before, after, i, pe, k, changed;
        if (c === null) { return { ok: false, reason: "Start time must be m:ss (721 = 7:21)" }; }
        if (d.playIds.indexOf(ev.id) >= 0) {
            // the drive started with its own first play: put a POSSESSION in front of it
            e2 = { kind: "POSSESSION", side: d.side, spot: newAbs, reason: "drive start", period: ev.period };
            if (c) { e2.clock = c; }
            ops.push({ kind: "ADD", eventId: App.newEventId(), event: e2, after: o.index > 0 ? App.events[o.index - 1].id : "" });
        } else {
            e2 = copy(ev);
            if (ev.kind === "KICKOFF" || (ev.kind === "PLAY" && ev.type === "PUNT")) {
                if (X.tb) { e2.touchback = true; delete e2.spot; delete e2.endSpot; }
                else { delete e2.touchback; if (ev.kind === "KICKOFF") { e2.spot = newAbs; } else { e2.endSpot = newAbs; } }
            } else if (ev.kind === "POSSESSION") { e2.spot = newAbs; }
            else if (ev.kind === "PLAY") { delete e2.touchback; e2.endSpot = newAbs; }
            if (c) { e2.clock = c; } else { delete e2.clock; }
            ops.push({ kind: "EDIT", eventId: ev.id, event: e2 });
        }
        if (delta) {
            for (i = 0; i < d.playIds.length; i++) {
                pe = eventById(d.playIds[i]);
                if (!pe) { continue; }
                e2 = copy(pe); changed = false;
                ["endSpot", "fumbleSpot", "puntLandSpot"].forEach(function (f) { if (typeof pe[f] === "number") { e2[f] = clamp(pe[f] + delta, 0, 100); changed = true; } });
                if (changed) { ops.push({ kind: "EDIT", eventId: pe.id, event: e2 }); }
            }
            // a moved line (SPOT) or the ball back ON at a spot in this drive moves too (the drive is
            // open, so everything after the event that started it belongs to it)
            for (i = o.index + 1; i < App.events.length; i++) {
                pe = App.events[i];
                if (pe.kind === "SPOT" || (pe.kind === "POSSESSION" && pe.side === d.side && typeof pe.spot === "number")) {
                    e2 = copy(pe);
                    e2.spot = clamp(pe.spot + delta, 1, 99);
                    if (typeof pe.lineToGain === "number") { e2.lineToGain = clamp(pe.lineToGain + delta, 0, 100); }
                    ops.push({ kind: "EDIT", eventId: pe.id, event: e2 });
                }
            }
        }
        // the new events must replay without a new warning
        before = invalid(res().warnings);
        after = StatsEngine.replay(App.game.setup || {}, StatsOps.effective(App.game.ops.concat(ops.map(function (op, n) {
            var x = copy(op); x.seq = 1e9 + n; x.opId = "check-" + n; x.eventId = op.eventId; return x;
        }))));
        if (invalid(after.warnings) > before) {
            for (k = after.warnings.length - 1; k >= 0; k--) { if (after.warnings[k].code === "INVALID") { return { ok: false, reason: "That start doesn't fit the plays: " + after.warnings[k].text }; } }
        }
        id = App.commitBatch(ops, "EDIT", "Drive " + d.num + " start: " + spotText(newAbs) + (c ? " at " + c : ""));
        return id ? { ok: true } : { ok: false, reason: "Not saved, try again" };
    }

    // ------------------------------------------------------------ DRIVE CHART

    // The open drive (between drives: the last one) on a small field: one row
    // per play, a line from where it started to where it ended, coloured like
    // its play button, with the gain at the end. The blue dashed line is where
    // the drive started. Same direction as the field (FLIP). Tap a play row to
    // fold it and every play before it into one row; tap that row to open it
    // again (kept per drive on this device).
    var CHART_COL = { PASS: "#22c55e", INC: "#f59e0b", INT: "#f97316", RUSH: "#2dd4bf", SACK: "#fb7185", FUM: "#ef4444", PUNT: "#a78bfa",
        FG: "#34d399", FGX: "#ef4444", PEN: "#f5d000", OTHER: "#9fb0c2" };
    var FOLD = {};
    try { FOLD = JSON.parse(localStorage.getItem("statsapp.chartFold") || "{}") || {}; } catch (e) { FOLD = {}; }
    function foldKey(d) { return (App.game.id || App.game.fixture || "") + ":" + d.num; }

    function chartKey(p) {
        if (p.type === "PUNT") { return "PUNT"; }
        if (p.type === "PENALTY") { return "PEN"; }
        if (p.type === "FG") { return p.result === "GOOD" ? "FG" : "FGX"; }
        if (p.result === "INCOMPLETE") { return "INC"; }
        if (p.result === "INTERCEPTION") { return "INT"; }
        if (p.result === "FUMBLE_LOST") { return "FUM"; }
        return CHART_COL[p.type] ? p.type : "OTHER";
    }
    function chartEnd(p) { return p.td || p.safety || p.possessionTo ? (p.td ? Fmt.goalOf(p.scoring.side) : (p.safety ? Fmt.goalOf(p.defense) : p.endSpot)) : p.endSpot; }

    // FOLD[drive] = the last play folded by hand (COLLAPSE / a tap on a play), -1 = opened by hand (OPEN ALL /
    // a tap on the folded row). Otherwise the chart folds its oldest plays by itself so that it fits the
    // column without scrolling: drawn once, measured, drawn again folded just enough.
    function renderChart() {
        var C = $("chartCard"), col = C.parentElement, d = openDrive() || lastDrive(), over, svg, rowPx, f;
        drawChart(undefined);
        if (!d || !col || getComputedStyle(col).overflowY === "visible" || FOLD[foldKey(d)] === -1) { return; }
        over = col.scrollHeight - col.clientHeight;
        svg = C.querySelector("svg");
        if (over <= 1 || !svg) { return; }
        rowPx = svg.getBoundingClientRect().width / 1000 * 34;
        f = FOLD[foldKey(d)];
        f = (f === undefined ? 0 : f) + Math.ceil(over / rowPx);   // folding plays 0..f into one row saves f rows
        drawChart(Math.min(f, Math.max(0, d.playIds.length - 1)));
        if (col.scrollHeight - col.clientHeight > 1 && f < d.playIds.length - 1) { drawChart(f + 1); }   // rounding: one more
    }

    function drawChart(auto) {
        var C = $("chartCard"), d = openDrive() || lastDrive(), flip = Field.flipped, plays, ROW = 34, top = 8, h = "", rows = [], fold, H, i, fy, fn, y, X, lbl;
        if (!d) { C.innerHTML = '<div class="cardLbl">DRIVE CHART</div><div class="hint">No drives yet.</div>'; return; }
        X = function (c) { var x = 60 + clamp(+c, 0, 100) * 8.8; return flip ? 1000 - x : x; };
        plays = d.playIds.map(playById).filter(function (p) { return !!p; });
        fold = FOLD[foldKey(d)];
        if (fold === -1) { fold = undefined; }
        if (auto !== undefined && (fold === undefined || auto > fold)) { fold = auto; }
        if (fold !== undefined && fold >= plays.length) { fold = plays.length ? plays.length - 1 : undefined; }
        if (fold !== undefined && plays.length) {
            fy = 0; fn = 0;
            for (i = 0; i <= fold; i++) { fy += plays[i].type === "PUNT" || plays[i].type === "FG" ? 0 : plays[i].yards; fn++; }
            rows.push({ fold: true, from: plays[0].spot, to: chartEnd(plays[fold]), n: fn, yards: fy });
        }
        for (i = fold !== undefined ? fold + 1 : 0; i < plays.length; i++) { rows.push({ i: i }); }
        H = top + Math.max(1, rows.length) * ROW + 30;
        h += '<rect x="0" y="0" width="1000" height="' + H + '" fill="#1d5a2c"/>';
        h += '<rect x="' + (flip ? 940 : 0) + '" y="0" width="60" height="' + H + '" style="fill:var(--away)"/><rect x="' + (flip ? 0 : 940) + '" y="0" width="60" height="' + H + '" style="fill:var(--home)"/>';
        for (y = 10; y < 100; y += 10) {
            h += '<line x1="' + X(y) + '" y1="0" x2="' + X(y) + '" y2="' + (H - 24) + '" stroke="rgba(255,255,255,' + (y === 50 ? '.55' : '.25') + ')" stroke-width="' + (y === 50 ? 3 : 2) + '"/>' +
                '<text x="' + X(y) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="20" font-weight="800" fill="rgba(255,255,255,.75)">' + (y <= 50 ? y : 100 - y) + '</text>';
        }
        h += '<line x1="' + X(d.startSpot) + '" y1="0" x2="' + X(d.startSpot) + '" y2="' + (H - 24) + '" stroke="#4ea1ff" stroke-width="3" stroke-dasharray="8 6"/>';
        rows.forEach(function (row, r) {
            var cy = top + r * ROW + ROW / 2, hit = '<rect class="crow" data-row="' + (row.fold ? 'fold' : row.i) + '" x="0" y="' + (top + r * ROW) + '" width="1000" height="' + ROW + '" fill="transparent"/>';
            var p, k, col, x1, x2, dirn, right, tx, yd, txt;
            if (row.fold) { p = null; k = "FOLD"; col = "#e2e8f0"; x1 = X(row.from); x2 = X(row.to); txt = row.n + " PLAY" + (row.n === 1 ? "" : "S") + " " + signed(row.yards) + "  (TAP TO OPEN)"; h += '<rect x="0" y="' + (top + r * ROW) + '" width="1000" height="' + ROW + '" fill="rgba(0,0,0,.28)"/>'; }
            else {
                p = plays[row.i]; k = chartKey(p); col = CHART_COL[k]; x1 = X(p.spot); x2 = X(chartEnd(p)); yd = p.yards;
                txt = k === "INC" ? "INC" : k === "INT" ? (p.td ? "PICK 6" : "INT") : k === "FUM" ? (p.td ? "FUM TD" : "FUM") : k === "PUNT" ? "PUNT" :
                    k === "PEN" ? (p.declined ? "PEN DECL" : "PEN " + signed(yd)) : k === "FG" ? "FG " + p.kickDistance : k === "FGX" ? "FG MISS" : (p.td ? "TD" : (p.safety ? "SAFETY" : signed(yd)));
            }
            if (Math.abs(x2 - x1) < 6) { h += '<circle cx="' + x1 + '" cy="' + cy + '" r="10" fill="' + col + '"/>'; }
            else {
                dirn = x2 > x1 ? 1 : -1;
                h += '<line x1="' + x1 + '" y1="' + cy + '" x2="' + (x2 - dirn * 10) + '" y2="' + cy + '" stroke="' + col + '" stroke-width="10" stroke-linecap="round"' +
                    (k === "INT" || k === "PUNT" || k === "FOLD" ? ' stroke-dasharray="14 8"' : '') + '/>' +
                    '<path d="M' + x2 + ' ' + cy + ' L' + (x2 - dirn * 20) + ' ' + (cy - 12) + ' L' + (x2 - dirn * 20) + ' ' + (cy + 12) + ' Z" fill="' + col + '"/>';
            }
            right = Math.max(x1, x2) < 880;
            tx = right ? Math.max(x1, x2) + 10 : Math.min(x1, x2) - 10;
            h += '<text x="' + tx + '" y="' + (cy + 8) + '" text-anchor="' + (right ? 'start' : 'end') + '" font-size="' + (row.fold ? 22 : 24) + '" font-weight="900" fill="#fff" style="paint-order:stroke;pointer-events:none" stroke="#0b1017" stroke-width="4">' + esc(txt) + '</text>' + hit;
        });
        if (!plays.length) { h += '<text x="500" y="' + (top + ROW / 2 + 6) + '" text-anchor="middle" font-size="16" font-weight="700" fill="rgba(255,255,255,.7)">no plays yet</text>'; }
        lbl = esc(d.team) + ' drive ' + d.num + (d.open ? '' : ' (' + esc(Fmt.driveResult(d)) + ')') + ': ' + d.plays + ' play' + (d.plays === 1 ? '' : 's') + ', ' + signed(d.yards) + ' yds' +
            (plays.length ? ' - tap a play to fold it and the ones before' : '');
        C.innerHTML = '<div class="chhead"><div class="cardLbl">DRIVE CHART <span class="hint">- ' + lbl + '</span></div>' +
            (plays.length > 1 ? '<button class="btn" data-chart="' + (fold !== undefined ? 'open' : 'collapse') + '">' + (fold !== undefined ? 'OPEN ALL' : 'COLLAPSE') + '</button>' : '') +
            '</div><div class="chartWrap"><svg viewBox="0 0 1000 ' + H + '">' + h + '</svg></div>';
    }

    function bindChart() {
        $("chartCard").addEventListener("click", function (e) {
            var r = e.target.closest && e.target.closest("[data-row], [data-chart]"), d, v;
            if (!r || !App.result) { return; }
            d = openDrive() || lastDrive();
            if (!d) { return; }
            v = r.getAttribute("data-row") || r.getAttribute("data-chart");
            // COLLAPSE = every play but the last one in one row; OPEN ALL = every play again
            if (v === "collapse") { v = String(Math.max(0, d.playIds.length - 2)); }
            if (v === "open" || v === "fold") { FOLD[foldKey(d)] = -1; } else { FOLD[foldKey(d)] = +v; }
            try { localStorage.setItem("statsapp.chartFold", JSON.stringify(FOLD)); } catch (x) { /* private mode */ }
            buzz();
            renderChart();
        });
    }

    // ------------------------------------------------------------ render

    // A new op or another game clears the play being built; a new drive
    // situation resets the next drive's choices.
    function sync() {
        var k = App.game.ops.length + ":" + App.isViewing() + ":" + (App.game.id || App.game.fixture), ld = lastDrive(), nk;
        endedByPlay();
        if (k !== keys.play) { keys.play = k; if (!drag && !pdrag) { clearPlay(); } }
        nk = (App.game.id || App.game.fixture) + ":" + (ld ? ld.num + ":" + ld.open : "-") + ":" + live().phase;
        if (nk !== keys.next) { keys.next = nk; NEXT.side = null; FIELD.start = null; FIELD.tb = false; }
    }

    // A new op that closed a drive with a play (not an undo, not another game, not viewing back):
    // ask for the end time, unless the play already had one (the clock box).
    function endedByPlay() {
        var gk = App.game.id || App.game.fixture, ops = App.game.ops, op = ops[ops.length - 1], ds = res().drives, closed = 0, i, d = null, ev;
        for (i = 0; i < ds.length; i++) { if (!ds[i].open) { closed++; d = ds[i]; } }
        if (keys.endGame === gk && keys.endOps === ops.length - 1 && closed === keys.ended + 1 && !App.isViewing() && op && op.kind === "ADD" &&
            d && d.playIds.length && d.playIds[d.playIds.length - 1] === op.eventId) {
            ev = eventById(op.eventId);
            if (ev && !ev.clock && !Huddles.current) { setTimeout(function () { driveEndedHuddle(d); }, 0); }
        }
        keys.endGame = gk; keys.endOps = ops.length; keys.ended = closed;
    }

    function render() {
        if (!REF || !App.result) { return; }
        sync();
        paint();
        texts();
        renderDrive();
        renderChart();
    }

    function init() {
        REF = View.fieldRef();
        bindField();
        bindPlays();
        bindPlayers();
        bindTimePicker();
        // re-fit the drive chart when its column changes size (window, menu, player tracking on / off)
        if (typeof ResizeObserver !== "undefined") {
            new ResizeObserver(function () { if (REF && App.result) { renderChart(); } }).observe($("chartCard").parentElement);
        } else {
            window.addEventListener("resize", function () { if (REF && App.result) { renderChart(); } });
        }
        bindDrive();
        bindHold();
        bindChart();
        $("hBody").addEventListener("input", function (e) {
            var h = Huddles.current, n = e.target.getAttribute && e.target.getAttribute("data-in");
            if (h && h.input && n) { h.input(n, e.target.value); }
        });
    }

    return { init: init, render: render, paint: function () { if (REF && App.result) { paint(); } }, possession: possession,
        ddEdit: function () {
            if (mode() === "play" && live().offense && !Entry.active() && !App.isViewing()) { ddHuddle("DD", null); }
            else { App.toast(App.isViewing() ? "Viewing an earlier point: tap Go live first" : "The down & distance can be changed during a drive", false); }
        },
        nextSide: nextSide, pending: function () { return PEND; }, setPending: setPending, pickSlot: pickSlot };
})();
