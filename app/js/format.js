/*
 * stats/app/js/format.js - display helpers. Pure: Result values in, strings out.
 * Spots are absolute 0-100 from the AWAY goal line (STATS_APP_PLAN.md 2.1).
 */
var Fmt = (function () {

    function esc(s) {
        return String(s === null || s === undefined ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // 35 -> "PEL 35", 65 -> "CCA 35", 50 -> "50"
    function spot(s, codes) {
        if (s === null || s === undefined) { return ""; }
        s = Math.round(s);
        if (s === 50) { return "50"; }
        if (s <= 0) { return codes.AWAY + " end zone"; }
        if (s >= 100) { return codes.HOME + " end zone"; }
        return s < 50 ? codes.AWAY + " " + s : codes.HOME + " " + (100 - s);
    }

    function ordinal(d) { return ["", "1st", "2nd", "3rd", "4th"][d] || ""; }

    // Down & distance at the snap of an annotated play.
    function playDD(p) {
        if (p.type === "PAT" || p.type === "TWO_PT") { return "TRY"; }
        if (p.type === "KICKOFF_RETURN") { return "KO"; }
        if (!p.down) { return ""; }
        return ordinal(p.down) + " & " + (p.goal ? "Goal" : (p.toGo < 1 ? "Inches" : Math.round(p.toGo)));
    }

    function clock(c) {
        if (!c) { return ""; }
        return periodShort(c.period) + " " + c.clock;
    }

    function periodShort(p) {
        if (p >= 1 && p <= 4) { return "Q" + p; }
        if (p === 5) { return "OT"; }
        return (p - 4) + "OT";
    }

    function signed(n) { return n > 0 ? "+" + n : String(n); }

    var RESULT_TEXT = {
        TD: "TD", FG: "FG", PUNT: "Punt", INT: "INT", FUMBLE: "Fumble", DOWNS: "Downs",
        SAFETY: "Safety", "MISSED FG": "Missed FG", "FG BLOCKED": "FG blocked",
        POSSESSION: "Possession", KICKOFF: "Kickoff", "END OF HALF": "End of half",
        "END OF GAME": "End of game", "END OF PERIOD": "End of period"
    };
    function driveResult(d) {
        if (d.open) { return "In progress"; }
        var r = RESULT_TEXT[d.result] || d.result || "";
        if (d.tryResult) {
            r += " + " + (d.tryResult.type === "PAT" ? "PAT" : "2PT") + (d.tryResult.result === "GOOD" ? "" : " X");
        }
        return r;
    }

    var REASON_TEXT = { KICKOFF: "kickoff", PLAY: "play", POSSESSION: "set", PUNT: "punt", INT: "INT",
        FUMBLE: "fumble", DOWNS: "downs", "MISSED FG": "missed FG", "FG BLOCKED": "blocked FG" };
    function driveStart(d) { return REASON_TEXT[d.startReason] || (d.startReason || "").toLowerCase(); }

    // Field geometry (same conventions as the engine): AWAY attacks toward 100.
    function other(side) { return side === "AWAY" ? "HOME" : (side === "HOME" ? "AWAY" : null); }
    function dir(side) { return side === "AWAY" ? 1 : -1; }
    function rel(side, s) { return side === "AWAY" ? s : 100 - s; }       // yards from own goal line
    function abs(side, r) { return side === "AWAY" ? r : 100 - r; }
    function goalOf(side) { return side === "AWAY" ? 100 : 0; }

    var PERIOD_TEXT = { 1: "1ST", 2: "2ND", 3: "3RD", 4: "4TH", OT: "OT", HALF: "HALF", FINAL: "FINAL" };

    // One line for any logged event (the Log list, toasts). playText: the
    // engine's annotated text for a PLAY, if there is one.
    function event(ev, codes, playText) {
        var k = ev.kind, c = function (s) { return codes[s] || s; };
        if (k === "PLAY") { return playText || (ev.type + (ev.result ? " " + ev.result : "")); }
        if (k === "KICKOFF") {
            return "Kickoff, " + c(ev.receiving) + " receives" +
                (ev.touchback ? ", touchback" : (typeof ev.spot === "number" ? " at " + spot(ev.spot, codes) : ""));
        }
        if (k === "POSSESSION") {
            return ev.side === "NONE" ? "Ball OFF" :
                "Possession " + c(ev.side) + (typeof ev.spot === "number" ? " at " + spot(ev.spot, codes) : "");
        }
        if (k === "SPOT") {
            return "Set spot: " + ordinal(ev.down) + " & " +
                (typeof ev.lineToGain === "number" ? (ev.lineToGain === 0 || ev.lineToGain === 100 ? "Goal" : Math.abs(ev.lineToGain - ev.spot)) : 10) +
                " at " + spot(ev.spot, codes);
        }
        if (k === "PERIOD") { return "Period: " + (PERIOD_TEXT[ev.period] || ev.period); }
        if (k === "TIMEOUT") {
            if (ev.set) { return "Timeouts set: " + codes.AWAY + " " + ev.set.AWAY + ", " + codes.HOME + " " + ev.set.HOME; }
            return "Timeout " + c(ev.side);
        }
        if (k === "SCORE_FIX") { return "Score fix " + c(ev.side) + " " + signed(ev.delta); }
        if (k === "CLOCK") { return "Clock " + ev.clock; }
        return k;
    }

    // "721" -> "7:21", "1200" -> "12:00"; anything else is returned trimmed.
    function normClock(s) {
        s = String(s || "").trim();
        if (/^\d{1,4}$/.test(s)) {
            while (s.length < 3) { s = "0" + s; }
            return String(+s.slice(0, -2)) + ":" + s.slice(-2);
        }
        return s;
    }

    return { esc: esc, spot: spot, ordinal: ordinal, playDD: playDD, clock: clock,
        periodShort: periodShort, signed: signed, driveResult: driveResult, driveStart: driveStart,
        other: other, dir: dir, rel: rel, abs: abs, goalOf: goalOf, event: event, normClock: normClock,
        PERIOD_TEXT: PERIOD_TEXT };
})();
