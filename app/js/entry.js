/*
 * stats/app/js/entry.js - play entry. Builds one event from the operator's
 * taps (type, result, options, the spot dragged on the field), checks it with
 * StatsEngine.validate, and hands it to App.commit as an op.
 *
 * Modes: LIVE (append), EDIT (replace an event: EDIT op), INSERT (a missed
 * play: ADD after an event). EDIT / INSERT enter against the Result just
 * before / after that event, so the field shows that moment of the game.
 * Nothing here is game state: it is only the play being typed.
 */
var Entry = (function () {

    var $ = function (id) { return document.getElementById(id); };
    var esc = Fmt.esc;

    var TYPES = [["RUSH", "Rush"], ["PASS", "Pass"], ["SACK", "Sack"], ["PENALTY", "Penalty"], ["PUNT", "Punt"],
        ["FG", "FG"], ["PAT", "PAT"], ["TWO_PT", "2PT"], ["KICKOFF", "Kickoff"], ["SPOT", "Set spot"]];
    var RESULTS = {
        RUSH: [["GAIN", "Gain"], ["FUMBLE_RECOVERED", "Fumble, kept"], ["FUMBLE_LOST", "Fumble lost"]],
        PASS: [["COMPLETE", "Complete"], ["INCOMPLETE", "Incomplete"], ["INTERCEPTION", "Intercepted"], ["FUMBLE_LOST", "Fumble lost"]],
        SACK: [["GAIN", "Sack"], ["FUMBLE_LOST", "Fumble lost"]],
        FG: [["GOOD", "Good"], ["NO_GOOD", "No good"], ["BLOCKED", "Blocked"]],
        PAT: [["GOOD", "Good"], ["NO_GOOD", "No good"], ["BLOCKED", "Blocked"]],
        TWO_PT: [["GOOD", "Good"], ["NO_GOOD", "No good"]]
    };
    var DEFAULT_RESULT = { RUSH: "GAIN", SACK: "GAIN" };
    var HINT = {
        RUSH: "Drag the ball to where the run ended.",
        PASS: "Drag the ball to where the play ended. Intercepted / fumble lost: where the other team took over.",
        SACK: "Drag the ball to where the sack ended.",
        PENALTY: "The spot moves by the yards (half the distance near the goal). Drag to adjust.",
        PUNT: "Drag to where the receiving team takes over, or tap Touchback.",
        FG: "A miss with no spot is a touchback. Drag to where the defense takes over if it is not.",
        KICKOFF: "Drag to where the receiving team takes over, or tap Touchback.",
        SPOT: "Drag the ball, pick the down and the distance."
    };
    // Event fields this panel owns; anything else on an edited event is kept.
    var OWNED = { id: 1, kind: 1, type: 1, result: 1, endSpot: 1, spot: 1, penalty: 1, touchback: 1,
        receiving: 1, down: 1, lineToGain: 1, clock: 1 };

    var s = null;
    var mode = { kind: "LIVE", eventId: null, base: null, ctx: null, label: "" };

    function reset() {
        s = { type: null, result: null, spot: null, touched: false, touchback: false, receiving: null,
            pen: { on: "DEF", yards: 5, autoFirst: false, lossOfDown: false, declined: false },
            down: 1, toGo: 10, goal: false };
        $("enClock").value = "";
    }

    function ctx() { return mode.ctx || App.result; }
    function sit() { return ctx().situation; }
    function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

    // ------------------------------------------------------------ the spot

    function penaltySpot(st) {
        var off = st.offense, r = Fmt.rel(off, st.spot), y = s.pen.yards, room;
        if (s.pen.on === "DEF") { room = 100 - r; r += y > room / 2 ? room / 2 : y; }
        else { r -= y > r / 2 ? r / 2 : y; }
        return Fmt.abs(off, r);
    }

    function usesSpot() {
        var t = s.type;
        if (!t || t === "PAT" || t === "TWO_PT") { return false; }
        if (t === "PASS" && s.result === "INCOMPLETE") { return false; }
        if (t === "PENALTY" && s.pen.declined) { return false; }
        if ((t === "PUNT" || t === "KICKOFF") && s.touchback) { return false; }
        if (t === "FG") { return s.result !== "GOOD" && s.touched; }
        return true;
    }

    function spotValue() {
        var st = sit();
        if (s.touched) { return s.spot; }
        if (st.spot === null || !st.offense) { return null; }
        if (s.type === "PUNT") { return clamp(st.spot + 35 * Fmt.dir(st.offense), 1, 99); }
        if (s.type === "PENALTY") { return penaltySpot(st); }
        if (s.type === "KICKOFF" || s.type === "FG") { return null; }
        return st.spot;
    }

    // The team that has the ball after the play, if it changes hands.
    function newOffense(st) {
        var t = s.type;
        if (t === "KICKOFF") { return s.receiving; }
        if (t === "PUNT" || t === "FG" || s.result === "INTERCEPTION" || s.result === "FUMBLE_LOST") { return Fmt.other(st.offense); }
        return null;
    }

    function spotLtg(sp, off) {
        var g = Fmt.goalOf(off), l;
        if (s.goal) { return g; }
        l = sp + s.toGo * Fmt.dir(off);
        return (l - g) * Fmt.dir(off) >= 0 ? g : l;
    }

    function ghostTag(sp) {
        var st = sit(), codes = ctx().codes, flip = newOffense(st), r, y;
        if (s.type === "SPOT") {
            return Fmt.ordinal(s.down) + " & " + (s.goal ? "Goal" : s.toGo);
        }
        if (flip) {
            r = Fmt.rel(flip, sp);
            if (r >= 100) { return "TD " + codes[flip]; }
            if (r <= 0) { return "TOUCHBACK"; }
            return Fmt.spot(sp, codes);
        }
        if (!st.offense || st.spot === null) { return Fmt.spot(sp, codes); }
        r = Fmt.rel(st.offense, sp);
        if (r >= 100) { return "TD"; }
        if (r <= 0) { return "SAFETY"; }
        y = Math.round((sp - st.spot) * Fmt.dir(st.offense) * 10) / 10;
        return Fmt.signed(y) + " yd" + (Math.abs(y) === 1 ? "" : "s");
    }

    // ------------------------------------------------------------ the event

    function build() {
        var t = s.type, st = sit(), sp = usesSpot() ? spotValue() : null, ev = {}, k, base = mode.base;
        var clock = Fmt.normClock($("enClock").value);
        if (base) { for (k in base) { if (base.hasOwnProperty(k) && !OWNED[k]) { ev[k] = base[k]; } } }

        if (t === "KICKOFF") {
            ev.kind = "KICKOFF";
            ev.receiving = s.receiving;
            if (s.touchback) { ev.touchback = true; } else if (sp !== null) { ev.spot = sp; }
        } else if (t === "SPOT") {
            ev.kind = "SPOT";
            ev.spot = sp;
            ev.down = s.down;
            if (sp !== null && st.offense) { ev.lineToGain = spotLtg(sp, st.offense); }
        } else {
            ev.kind = "PLAY";
            ev.type = t;
            if (t === "PENALTY") {
                ev.penalty = { on: s.pen.on, yards: s.pen.yards };
                if (s.pen.autoFirst && s.pen.on === "DEF") { ev.penalty.autoFirst = true; }
                if (s.pen.lossOfDown && s.pen.on === "OFF") { ev.penalty.lossOfDown = true; }
                if (s.pen.declined) { ev.penalty.accepted = false; }
            } else if (t === "PUNT") {
                if (s.touchback) { ev.touchback = true; }
            } else if (s.result && !(s.result === "GAIN" && (t === "RUSH" || t === "SACK"))) {
                ev.result = s.result;
            }
            if (sp !== null) { ev.endSpot = sp; }
        }
        if (ev.period === undefined) { ev.period = st.period; }
        if (clock) { ev.clock = clock; }
        return ev;
    }

    // { ok, reason, ev }: the panel's own checks, then the engine's.
    function check() {
        var t = s.type, ev, v;
        if (!t) { return { ok: false, reason: "Pick a play type" }; }
        if (RESULTS[t] && !s.result) { return { ok: false, reason: "Pick the result" }; }
        if (t === "KICKOFF") {
            if (!s.receiving) { return { ok: false, reason: "Pick the receiving team" }; }
            if (!s.touchback && !s.touched) { return { ok: false, reason: "Drag the spot or tap Touchback" }; }
        }
        if (t === "PUNT" && !s.touchback && spotValue() === null) { return { ok: false, reason: "Drag the spot or tap Touchback" }; }
        ev = build();
        v = StatsEngine.validate(ctx(), ev);
        return { ok: v.ok, reason: v.reason, ev: ev };
    }

    function available(t, st) {
        if (st.phase === "FINAL") { return false; }
        if (t === "KICKOFF") { return true; }
        if (st.phase === "TRY") { return t === "PAT" || t === "TWO_PT"; }
        if (!st.offense) { return false; }
        return t !== "PAT" && t !== "TWO_PT";
    }

    // ------------------------------------------------------------ actions

    function selectType(t) {
        var st = sit();
        if (s.type === t) { s.type = null; return; }
        s.type = t;
        s.result = DEFAULT_RESULT[t] || null;
        s.touchback = false;
        if (t === "PUNT" || t === "PENALTY" || t === "KICKOFF") { s.touched = false; }
        if (t === "SPOT") {
            s.down = st.down || 1;
            s.goal = !!st.goal;
            s.toGo = st.toGo !== null && st.toGo > 0 ? Math.round(st.toGo) : 10;
        }
        if (t === "KICKOFF") { s.receiving = st.phase === "KICKOFF" && st.offense ? st.offense : null; }
    }

    function setSpot(sp) {
        if (App.isViewing()) { return; }
        s.spot = clamp(sp, 0, 100);
        s.touched = true;
        if ((s.type === "PUNT" || s.type === "KICKOFF") && s.touchback) { s.touchback = false; }
        render();
    }

    // d: +1 = one yard to the right on screen, -1 = left (follows FLIP FIELD).
    function nudge(d) {
        var cur = usesSpot() ? spotValue() : null;
        if (cur === null) { return; }
        setSpot(Math.round(cur + (Field.flipped ? -d : d)));
    }

    function act(a, v) {
        switch (a) {
            case "type": selectType(v); break;
            case "result": s.result = v; break;
            case "penOn": s.pen.on = v; s.touched = false; break;
            case "penYds": s.pen.yards = +v; s.touched = false; break;
            case "penFlag": s.pen[v] = !s.pen[v]; break;
            case "touchback": s.touchback = !s.touchback; break;
            case "recv": s.receiving = v; break;
            case "down": s.down = +v; break;
            case "togo": s.goal = false; s.toGo = clamp(s.toGo + (+v), 1, 99); break;
            case "goal": s.goal = !s.goal; break;
            case "nudge": nudge(+v); return;
            case "cancel": exitMode(); App.refresh(); return;
            case "log": log(); return;
            default: return;
        }
        render();
    }

    function log() {
        var r = check(), saved, op;
        if (!r.ok) { return; }
        if (mode.kind === "EDIT") { op = { kind: "EDIT", eventId: mode.eventId, event: r.ev }; }
        else { op = { kind: "ADD", eventId: App.newEventId(), event: r.ev }; }
        if (mode.kind === "INSERT") { op.after = mode.eventId; }
        saved = { s: s, mode: mode, clock: $("enClock").value };
        reset();
        mode = { kind: "LIVE", eventId: null, base: null, ctx: null, label: "" };
        if (!App.commit(op, saved.mode.kind)) {           // refused (double tap / viewing): keep what was typed
            s = saved.s; mode = saved.mode; $("enClock").value = saved.clock;
            render();
        }
    }

    // ------------------------------------------------------------ edit / insert

    function eventsAndIndex(eventId) {
        var events = StatsOps.effective(App.game.ops), i;
        for (i = 0; i < events.length; i++) { if (events[i].id === eventId) { return { events: events, i: i }; } }
        return null;
    }

    function edit(eventId, label) {
        var f = eventsAndIndex(eventId), ev, pe;
        if (!f) { return; }
        ev = f.events[f.i];
        reset();
        mode = { kind: "EDIT", eventId: eventId, base: ev, label: label,
            ctx: StatsEngine.replay(App.game.setup, f.events.slice(0, f.i)) };
        s.type = ev.kind === "PLAY" ? ev.type : ev.kind;
        s.result = ev.result || DEFAULT_RESULT[s.type] || null;
        s.touchback = !!ev.touchback;
        s.receiving = ev.receiving || null;
        if (typeof ev.endSpot === "number") { s.spot = ev.endSpot; s.touched = true; }
        if (typeof ev.spot === "number") { s.spot = ev.spot; s.touched = true; }
        if (ev.penalty) {
            pe = ev.penalty;
            s.pen = { on: pe.on === "OFF" || pe.on === mode.ctx.situation.offense ? "OFF" : "DEF", yards: pe.yards || 5,
                autoFirst: !!pe.autoFirst, lossOfDown: !!pe.lossOfDown, declined: pe.accepted === false };
        }
        if (ev.kind === "SPOT") {
            s.down = ev.down;
            s.goal = typeof ev.lineToGain === "number" && (ev.lineToGain === 0 || ev.lineToGain === 100);
            s.toGo = typeof ev.lineToGain === "number" ? Math.max(1, Math.round(Math.abs(ev.lineToGain - ev.spot))) : 10;
        }
        $("enClock").value = ev.clock || "";
        App.refresh();
    }

    function insertAfter(eventId, label) {
        var f = eventsAndIndex(eventId);
        if (!f) { return; }
        reset();
        mode = { kind: "INSERT", eventId: eventId, base: null, label: label,
            ctx: StatsEngine.replay(App.game.setup, f.events.slice(0, f.i + 1)) };
        App.refresh();
    }

    function exitMode() {
        if (mode.kind !== "LIVE") { reset(); }
        mode = { kind: "LIVE", eventId: null, base: null, ctx: null, label: "" };
    }

    // ------------------------------------------------------------ render

    function seg(act, items, cur, disabled) {
        return '<div class="seg big">' + items.map(function (it) {
            var off = disabled && disabled(it[0]);
            return '<button data-act="' + act + '" data-v="' + esc(it[0]) + '"' + (cur === it[0] ? ' class="on"' : '') +
                (off ? ' disabled' : '') + '>' + esc(it[1]) + '</button>';
        }).join("") + '</div>';
    }
    function toggle(act, v, label, on, disabled) {
        return '<button class="tog' + (on ? ' on' : '') + '" data-act="' + act + '" data-v="' + v + '"' +
            (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
    }
    function group(label, html) { return '<div class="og"><span class="ol">' + esc(label) + '</span>' + html + '</div>'; }

    function optionsHtml(st, codes) {
        var t = s.type, h = "";
        if (!t) { return '<div class="hint">Pick a play type. Drag on the field to set the spot.</div>'; }
        if (RESULTS[t]) { h += group("Result", seg("result", RESULTS[t], s.result)); }
        if (t === "PENALTY") {
            h += group("On", seg("penOn", [["OFF", (codes[st.offense] || "OFF") + " (offense)"], ["DEF", (codes[Fmt.other(st.offense)] || "DEF") + " (defense)"]], s.pen.on));
            h += group("Yards", seg("penYds", [["5", "5"], ["10", "10"], ["15", "15"]], String(s.pen.yards)));
            h += group("", toggle("penFlag", "autoFirst", "Auto 1st down", s.pen.autoFirst, s.pen.on !== "DEF") +
                toggle("penFlag", "lossOfDown", "Loss of down", s.pen.lossOfDown, s.pen.on !== "OFF") +
                toggle("penFlag", "declined", "Declined", s.pen.declined));
        }
        if (t === "KICKOFF") {
            h += group("Receiving", seg("recv", [["AWAY", codes.AWAY], ["HOME", codes.HOME]], s.receiving));
        }
        if (t === "PUNT" || t === "KICKOFF") { h += group("", toggle("touchback", "1", "Touchback", s.touchback)); }
        if (t === "SPOT") {
            h += group("Down", seg("down", [["1", "1st"], ["2", "2nd"], ["3", "3rd"], ["4", "4th"]], String(s.down)));
            h += group("To go", '<div class="stepper"><button data-act="togo" data-v="-1">&minus;</button><span>' +
                (s.goal ? "Goal" : s.toGo) + '</span><button data-act="togo" data-v="1">+</button></div>' +
                toggle("goal", "1", "Goal to go", s.goal));
        }
        if (HINT[t]) { h += '<div class="hint">' + esc(HINT[t]) + '</div>'; }
        return h;
    }

    function render() {
        var live = App.result, st = sit(), codes = ctx().codes, viewing = App.isViewing(), r, sp, uses, offOn;
        var modeEl = $("enMode"), panel = $("entry");
        if (!s) { reset(); }
        panel.classList.toggle("viewing", viewing);
        panel.classList.toggle("editing", mode.kind !== "LIVE");

        modeEl.hidden = mode.kind === "LIVE";
        modeEl.innerHTML = mode.kind === "LIVE" ? "" :
            '<span>' + (mode.kind === "EDIT" ? "Editing " : "Adding a missed play after ") + esc(mode.label) + '</span>' +
            '<button class="btn" data-act="cancel">Cancel</button>';

        offOn = live.situation.offense || "NONE";
        $("enPoss").innerHTML = [["AWAY", live.codes.AWAY], ["NONE", "OFF"], ["HOME", live.codes.HOME]].map(function (it) {
            return '<button data-poss="' + it[0] + '" class="' + it[0].toLowerCase() + (offOn === it[0] ? ' on' : '') + '"' +
                (mode.kind !== "LIVE" || live.situation.phase === "FINAL" ? ' disabled' : '') + '>' + esc(it[1]) + '</button>';
        }).join("");
        $("enUndo").disabled = mode.kind !== "LIVE" || !App.canUndo();
        $("enGame").disabled = mode.kind !== "LIVE";

        $("enTypes").innerHTML = TYPES.map(function (it) {
            var ok = available(it[0], st);
            return '<button data-act="type" data-v="' + it[0] + '" class="' + (s.type === it[0] ? 'on' : '') + '"' +
                (ok ? '' : ' disabled') + '>' + esc(it[1]) + '</button>';
        }).join("");
        if (s.type && !available(s.type, st)) { s.type = null; }
        $("enOpts").innerHTML = optionsHtml(st, codes);

        uses = usesSpot();
        sp = uses ? spotValue() : null;
        $("enSpot").innerHTML = sp === null ?
            '<span class="muted">' + (s.type === "FG" && s.result !== "GOOD" ? "Touchback" : (uses ? "Drag the spot" : "No spot")) + '</span>' :
            '<b>' + esc(Fmt.spot(sp, codes)) + '</b>' + (ghostTag(sp) === Fmt.spot(sp, codes) ? '' : ' <span class="tag">' + esc(ghostTag(sp)) + '</span>');
        $("enMinus").disabled = $("enPlus").disabled = sp === null;
        // the field card's own marker when nothing is being typed here
        if (active()) { Field.ghost(View.fieldRef(), sp, sp === null ? "" : ghostTag(sp)); } else { Center.paint(); }

        r = viewing ? { ok: false, reason: "Viewing an earlier point: tap Go live to log" } : check();
        $("enLog").disabled = !r.ok;
        $("enLog").textContent = mode.kind === "EDIT" ? "SAVE" : (mode.kind === "INSERT" ? "ADD" : "LOG");
        $("enWhy").textContent = r.ok ? "" : r.reason;
        $("enWhy").classList.toggle("bad", !r.ok && !!s.type);
    }

    // The field shows the moment being entered against.
    function fieldSituation() { return mode.ctx ? mode.ctx.situation : null; }

    // Something is being typed here (a type picked, or an edit / missed play):
    // field drags then set this panel's spot, not the field card's.
    function active() { return mode.kind !== "LIVE" || !!(s && s.type); }
    function clear() { if (mode.kind === "LIVE" && s && s.type) { s.type = null; render(); } }

    // ------------------------------------------------------------ drag a play onto the field

    // Works like the PLAYBOOK logger's player drag, with play buttons instead
    // of players: press a play button and drag it onto the field. A copy of the
    // button follows the finger with a dashed line back to it (an arc for a
    // pass), the magnifier shows the yard line and the gain, and the spot
    // snaps onto the line to gain / goal line / 50 / no gain from close by.
    // Letting go on the field sets the spot; a PASS let go off the field is
    // incomplete. LOG still logs. A plain tap just picks the play.
    var DRAGGABLE = { RUSH: 1, PASS: 1, SACK: 1, PENALTY: 1, PUNT: 1, FG: 1, KICKOFF: 1, SPOT: 1 };
    var drag = null, suppressClick = false, lastSnap = null;

    function buzz(ms) { if (navigator.vibrate) { try { navigator.vibrate(ms || 12); } catch (e) { /* not supported */ } } }

    // Snap onto the line to gain, goal line, 50 or no gain - only from close by
    // (0.8 yd), and less when two of those lines are near each other, so every
    // yard in between can still be picked (same rule as the PLAYBOOK logger).
    function snapSpot(raw) {
        var st = sit(), off = st.offense, c = clamp(raw, 0, 100), pts, i, k, gap, r;
        if (!off || st.spot === null || s.type === "KICKOFF") { return { c: Math.round(c), hit: false }; }
        pts = [st.spot, Fmt.goalOf(off), 50];
        if (st.lineToGain !== null && !st.goal) { pts.push(st.lineToGain); }
        for (i = 0; i < pts.length; i++) {
            gap = 99;
            for (k = 0; k < pts.length; k++) { if (pts[k] !== pts[i]) { gap = Math.min(gap, Math.abs(pts[k] - pts[i])); } }
            r = Math.min(0.8, gap / 4);
            if (Math.abs(c - pts[i]) <= r) { return { c: pts[i], hit: true }; }
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

    // The magnifier: a zoomed strip of field above the finger (Field.loupe).
    function showLoupe(clientX, c) {
        var st = sit(), codes = ctx().codes, label = Fmt.spot(c, codes), y;
        if (st.offense && st.spot !== null && !newOffense(st) && s.type !== "SPOT") {
            y = Math.round((c - st.spot) * Fmt.dir(st.offense));
            label += "   (" + (y > 0 ? "+" : "") + y + ")";
        }
        Field.loupe(View.fieldRef(), clientX, c, label, st.offense ? st.spot : null);
    }
    function hideLoupe() { Field.hideLoupe(); }

    // Dashed line from the dragged button to the finger; an arc for a pass.
    function drawArc(x, y) {
        var ax = drag.ax, ay = drag.ay, h;
        if (drag.t === "PASS") {
            h = '<path d="M' + ax + " " + ay + " Q " + ((ax + x) / 2) + " " + (Math.min(ay, y) - 90) + " " + x + " " + y +
                '" fill="none" stroke="#22c55e" stroke-width="4" stroke-dasharray="10 7"/>';
        } else {
            h = '<line x1="' + ax + '" y1="' + ay + '" x2="' + x + '" y2="' + y + '" stroke="#1d9e75" stroke-width="4" stroke-dasharray="10 7"/>';
        }
        $("arc").innerHTML = h;
    }

    // Field press / drag (no button): same snap and magnifier.
    function fieldDrag(raw, e, phase) {
        var sn = snapSpot(raw);
        if (App.isViewing()) { return; }
        snapFlash(sn.c, sn.hit);
        setSpot(sn.c);
        if (phase === "up" || !usesSpot()) { hideLoupe(); } else { showLoupe(e.clientX, sn.c); }
    }

    function overField(e) {
        var r = $("field").getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    function dragStart(e) {
        var b = e.target.closest('#enTypes button[data-act="type"]'), r;
        if (!b || b.disabled || App.isViewing() || !DRAGGABLE[b.getAttribute("data-v")]) { return; }
        r = b.getBoundingClientRect();
        drag = { t: b.getAttribute("data-v"), label: b.textContent, x: e.clientX, y: e.clientY, moving: false, id: e.pointerId,
            ax: r.left + r.width / 2, ay: r.top + r.height / 2, w: r.width, h: r.height };
    }

    function dragMove(e) {
        var chip = $("dragChip");
        if (!drag || e.pointerId !== drag.id) { return; }
        if (!drag.moving) {
            if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 10) { return; }
            drag.moving = true;
            if (s.type !== drag.t) { selectType(drag.t); }
            if (drag.t === "PASS" && !s.result) { s.result = "COMPLETE"; }
            chip.textContent = drag.label;
            chip.style.width = drag.w + "px";
            chip.style.height = drag.h + "px";
            chip.hidden = false;
            document.body.classList.add("dragging-play");
            buzz(10);
            render();
        }
        chip.style.left = e.clientX + "px";
        chip.style.top = e.clientY + "px";
        drawArc(e.clientX, e.clientY);
        $("field").classList.toggle("drop-on", overField(e));
        if (overField(e)) {
            var sn = snapSpot(Field.spotAt(View.fieldRef(), e.clientX));
            if (drag.t === "PASS" && (s.result === "INCOMPLETE" || !s.result)) { s.result = "COMPLETE"; }
            snapFlash(sn.c, sn.hit);
            setSpot(sn.c);
            showLoupe(e.clientX, sn.c);
        } else {
            hideLoupe();
        }
        e.preventDefault();
    }

    function dragEnd(e) {
        if (!drag || e.pointerId !== drag.id) { return; }
        if (drag.moving) {
            if (overField(e)) {
                var sn = snapSpot(Field.spotAt(View.fieldRef(), e.clientX));
                setSpot(sn.c);
            } else if (drag.t === "PASS") {
                s.result = "INCOMPLETE";            // a pass let go off the field: incomplete, no spot
                s.touched = false;
                render();
            }
            suppressClick = true;
            setTimeout(function () { suppressClick = false; }, 0);
            $("dragChip").hidden = true;
            $("arc").innerHTML = "";
            hideLoupe();
            $("field").classList.remove("drop-on");
            document.body.classList.remove("dragging-play");
        }
        drag = null;
    }

    function init() {
        reset();
        $("entry").addEventListener("click", function (e) {
            var b = e.target.closest("[data-act]");
            if (!b || b.disabled || suppressClick) { return; }
            act(b.getAttribute("data-act"), b.getAttribute("data-v"));
        });
        $("enClock").addEventListener("input", render);
        $("enTypes").addEventListener("pointerdown", dragStart);
        document.addEventListener("pointermove", dragMove, { passive: false });
        document.addEventListener("pointerup", dragEnd);
        document.addEventListener("pointercancel", dragEnd);
    }

    return { init: init, render: render, edit: edit, insertAfter: insertAfter, exitMode: exitMode,
        fieldSituation: fieldSituation, fieldDrag: fieldDrag, active: active, clear: clear,
        get mode() { return mode.kind; }, get label() { return mode.label; } };
})();
