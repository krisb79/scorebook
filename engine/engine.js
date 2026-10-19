/*
 * stats/engine/engine.js - the PLAYBOOK stats engine. The only place football
 * rules live (STATS_APP_PLAN.md sections 1-3).
 *
 *   StatsEngine.replay(setup, events)   -> Result
 *   StatsEngine.replayOps(setup, ops)   -> Result   (needs StatsOps from ops.js)
 *   StatsEngine.validate(result, event) -> { ok, reason }
 *
 * The event log is the only truth. Possession owns the drive: drives are the
 * runs of plays between possession changes and are derived, never stored.
 * Spots are absolute, 0-100 from the AWAY goal line: AWAY attacks toward 100,
 * HOME toward 0. Down is never above 4. Overrides (SPOT, POSSESSION,
 * SCORE_FIX, TIMEOUT) are events like any other. Invalid events are skipped
 * with a warning, so a bad op can never break the replay.
 *
 * ES5 only (DashBoard Rhino 1.7.7 / Java 8): no JSON global, no DOM, no
 * timers, no Date, no randomness. Input events are never modified.
 * One global: StatsEngine.
 */
var StatsEngine = (function () {

    var VERSION = "0.1.0";

    var DEFAULT_RULES = {
        quarterMinutes: 12,
        touchbackSpot: 20,     // confirmed 2026-10-16 (today's Logger uses 25)
        patFrom: 3,
        timeoutsPerHalf: 3,
        otTimeouts: 1,
        sacksAs: "RUSH"        // NFHS / NCAA: sack yards count as rushing. "PASS" = net passing
    };

    var PLAY_TYPES = { RUSH: 1, PASS: 1, SACK: 1, PENALTY: 1, PUNT: 1, FG: 1, PAT: 1, TWO_PT: 1 };
    var RESULTS = {
        RUSH: { GAIN: 1, FUMBLE_LOST: 1, FUMBLE_RECOVERED: 1 },
        SACK: { GAIN: 1, FUMBLE_LOST: 1, FUMBLE_RECOVERED: 1 },
        PASS: { GAIN: 1, COMPLETE: 1, INCOMPLETE: 1, INTERCEPTION: 1, FUMBLE_LOST: 1, FUMBLE_RECOVERED: 1 },
        FG: { GOOD: 1, NO_GOOD: 1, BLOCKED: 1 },
        PAT: { GOOD: 1, NO_GOOD: 1, BLOCKED: 1 },
        TWO_PT: { GOOD: 1, NO_GOOD: 1 }
    };
    var PERIOD_LABELS = ["", "1ST", "2ND", "3RD", "4TH"];

    // ---------------------------------------------------------------- helpers

    function other(side) { return side === "AWAY" ? "HOME" : (side === "HOME" ? "AWAY" : null); }
    function dir(side) { return side === "AWAY" ? 1 : -1; }
    function rel(side, spot) { return side === "AWAY" ? spot : 100 - spot; }      // yards from own goal line
    function abs(side, r) { return side === "AWAY" ? r : 100 - r; }
    function goalOf(side) { return side === "AWAY" ? 100 : 0; }                   // the goal it attacks
    function isSide(s) { return s === "AWAY" || s === "HOME"; }
    function isNum(x) { return typeof x === "number" && x === x; }
    function round1(x) { return Math.round(x * 10) / 10; }
    function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

    function parseClock(c) {
        var m;
        if (typeof c !== "string") { return null; }
        m = /^(\d{1,2}):(\d{2})$/.exec(c);
        if (!m || +m[2] > 59) { return null; }
        return (+m[1]) * 60 + (+m[2]);
    }
    function fmtClock(secs) {
        var m = Math.floor(secs / 60), s = secs - m * 60;
        return m + ":" + (s < 10 ? "0" : "") + s;
    }
    function periodLabel(p) {
        if (p >= 1 && p <= 4) { return PERIOD_LABELS[p]; }
        if (p === 5) { return "OT"; }
        return (p - 4) + "OT";
    }
    function ordinal(d) { return ["", "1st", "2nd", "3rd", "4th"][d] || ""; }

    function mergeRules(r) {
        var out = {}, k;
        for (k in DEFAULT_RULES) { if (DEFAULT_RULES.hasOwnProperty(k)) { out[k] = DEFAULT_RULES[k]; } }
        if (r) { for (k in r) { if (r.hasOwnProperty(k)) { out[k] = r[k]; } } }
        return out;
    }

    function newTeam() {
        return {
            firstDowns: { total: 0, rush: 0, pass: 0, penalty: 0 },
            third: { att: 0, conv: 0, ytg: 0, avgYtg: 0 },
            fourth: { att: 0, conv: 0, ytg: 0, avgYtg: 0 },
            rushing: { att: 0, yds: 0, avg: 0 },
            passing: { comp: 0, att: 0, yds: 0, ints: 0, avg: 0 },
            sacks: { n: 0, yds: 0 },
            plays: { rush: 0, pass: 0 },             // play selection; a sack is a called pass
            totalPlays: 0, totalYards: 0, yardsPerPlay: 0,
            penalties: { count: 0, yds: 0 },
            turnovers: { total: 0, ints: 0, fumblesLost: 0, downs: 0 },
            punts: { n: 0, yds: 0, avg: 0 },
            fg: { made: 0, att: 0 },
            pat: { made: 0, att: 0 },
            twoPt: { made: 0, att: 0 },
            drives: 0,
            top: 0, topText: "0:00"
        };
    }

    // ---------------------------------------------------------------- state

    function newState(setup) {
        var rules = mergeRules(setup && setup.rules);
        return {
            setup: setup || {},
            rules: rules,
            codes: {
                AWAY: (setup && setup.away && setup.away.code) || "AWAY",
                HOME: (setup && setup.home && setup.home.code) || "HOME"
            },
            period: 1, half: 1,
            phase: "KICKOFF",            // KICKOFF | SCRIMMAGE | TRY | FINAL
            offense: null,               // null = Ball OFF
            offBefore: null,             // who had it when the ball went OFF
            spot: null, down: null, ltg: null,
            trySide: null,
            score: { AWAY: 0, HOME: 0 },
            timeouts: { AWAY: rules.timeoutsPerHalf, HOME: rules.timeoutsPerHalf },
            drives: [], drive: null,
            plays: [], warnings: [],
            cur: null,                   // this event's clock stamp {period, clock, abs}
            team: { AWAY: newTeam(), HOME: newTeam() }
        };
    }

    function elapsed(rules, period, secs) {
        var q = rules.quarterMinutes * 60;
        if (!(period >= 1 && period <= 4) || secs === null) { return null; }
        return (period - 1) * q + (q - secs);
    }

    function stamp(st, period, secs) {
        return { period: period, clock: fmtClock(secs), abs: elapsed(st.rules, period, secs) };
    }

    function warn(st, ev, code, text) {
        st.warnings.push({ eventId: ev ? ev.id : null, code: code, text: text });
    }

    function firstAndTen(st, side, spot) {
        var g = goalOf(side), l = spot + 10 * dir(side);
        st.offense = side;
        st.spot = spot;
        st.down = 1;
        st.ltg = (l - g) * dir(side) >= 0 ? g : l;
    }

    // --------------------------------------------------------------- drives

    function openDrive(st, side, spot, reason) {
        var d = {
            num: st.drives.length + 1,
            teamNum: st.team[side].drives + 1,
            side: side,
            startSpot: spot, startReason: reason, startClock: st.cur,
            endSpot: null, endClock: null, last: st.cur,
            result: null, plays: 0, playIds: [], yards: 0, time: null,
            open: true, tryResult: null
        };
        st.team[side].drives++;
        st.drives.push(d);
        st.drive = d;
        return d;
    }

    function closeDrive(st, result, endSpot, endStamp) {
        var d = st.drive;
        if (!d) { return; }
        d.result = result;
        d.endSpot = endSpot;
        d.endClock = endStamp || st.cur || d.last;
        d.open = false;
        st.drive = null;
    }

    function kickoffPending(st, receiver) {
        firstAndTen(st, receiver, abs(receiver, st.rules.touchbackSpot));
        st.phase = "KICKOFF";
        st.trySide = null;
        st.drive = null;
    }

    function touchdown(st, p, side) {
        st.score[side] += 6;
        p.td = true;
        p.scoring = { side: side, pts: 6, kind: "TD" };
        if (st.drive && st.drive.side === side) { closeDrive(st, "TD", goalOf(side)); }
        st.phase = "TRY";
        st.trySide = side;
        st.offense = side;
        st.spot = abs(side, 100 - st.rules.patFrom);
        st.down = null;
        st.ltg = goalOf(side);
    }

    function safety(st, p, offSide) {
        var scorer = other(offSide);
        st.score[scorer] += 2;
        p.safety = true;
        p.scoring = { side: scorer, pts: 2, kind: "SAFETY" };
        closeDrive(st, "SAFETY", abs(offSide, 0));
        kickoffPending(st, scorer);     // the team that scored receives the free kick
    }

    // Possession flips to newOff at spot. Closes the drive (result, driveEnd),
    // handles a return TD (no drive) and a touchback (own end zone -> rules spot).
    function flip(st, p, newOff, spot, result, driveEnd) {
        var r = rel(newOff, spot);
        closeDrive(st, result, driveEnd);
        p.possessionTo = newOff;
        if (r >= 100) { touchdown(st, p, newOff); return; }
        if (r <= 0) { spot = abs(newOff, st.rules.touchbackSpot); p.touchback = true; }
        firstAndTen(st, newOff, spot);
        st.phase = "SCRIMMAGE";
        openDrive(st, newOff, spot, result);
    }

    // Down & distance after a play that kept the ball. opts: replayDown,
    // autoFirst, cat (first-down category: rush / pass / penalty).
    function progress(st, p, end, opts) {
        var off = st.offense, r = rel(off, end);
        if (r >= 100) {
            p.firstDown = true;             // a TD always covers the distance
            countFirst(st, off, opts.cat);
            touchdown(st, p, off);
            return;
        }
        if (r <= 0) { safety(st, p, off); return; }
        if ((st.ltg - end) * dir(off) <= 0 || opts.autoFirst) {
            p.firstDown = true;
            countFirst(st, off, opts.cat);
            firstAndTen(st, off, end);
            return;
        }
        st.spot = end;
        if (opts.replayDown) { return; }
        if (st.down >= 4) {
            p.turnover = "DOWNS";
            st.team[off].turnovers.downs++;
            st.team[off].turnovers.total++;
            warn(st, p, "DOWNS", "4th down short -> turnover on downs");
            flip(st, p, other(off), end, "DOWNS", end);
            return;
        }
        st.down++;
    }

    function countFirst(st, side, cat) {
        var f = st.team[side].firstDowns;
        f.total++;
        f[cat]++;
    }

    // ---------------------------------------------------------------- plays

    function penaltyOn(pe, off) {
        if (!pe) { return null; }
        if (pe.on === "OFF" || pe.on === off) { return "OFF"; }
        if (pe.on === "DEF" || pe.on === other(off)) { return "DEF"; }
        return null;
    }

    function countPenalty(st, p, pe, off, start, end) {
        var who = penaltyOn(pe, off), side = who === "OFF" ? off : other(off);
        var yds = isNum(pe.yards) ? pe.yards : Math.abs(end - start);
        st.team[side].penalties.count++;
        st.team[side].penalties.yds += yds;
        p.penalty = { on: who, side: side, yards: yds, autoFirst: !!pe.autoFirst, lossOfDown: !!pe.lossOfDown };
    }

    function applyScrimmage(st, ev, p) {
        var t = ev.type, res = ev.result || "GAIN", off = st.offense, def = other(off), d = dir(off);
        var T = st.team[off], start = st.spot, end = isNum(ev.endSpot) ? clamp(ev.endSpot, 0, 100) : start;
        var yds, pe = ev.penalty, accepted = pe && pe.accepted !== false;
        var cat = t === "PASS" ? "pass" : "rush", wasDown = st.down, toGo = p.toGo, drive = st.drive, line;

        if (t === "PASS" && (res === "INCOMPLETE" || res === "INTERCEPTION")) {
            yds = 0;
        } else if (res === "FUMBLE_LOST") {
            yds = isNum(ev.fumbleSpot) ? (ev.fumbleSpot - start) * d : 0;
        } else {
            yds = (end - start) * d;
        }
        p.yards = yds;

        if (t === "RUSH") { T.rushing.att++; T.rushing.yds += yds; T.plays.rush++; }
        if (t === "PASS") {
            T.passing.att++;
            T.plays.pass++;
            if (res !== "INCOMPLETE" && res !== "INTERCEPTION") { T.passing.comp++; T.passing.yds += yds; }
        }
        if (t === "SACK") {
            T.sacks.n++; T.sacks.yds += yds; T.plays.pass++;
            if (st.rules.sacksAs === "PASS") { T.passing.yds += yds; } else { T.rushing.att++; T.rushing.yds += yds; }
        }
        drive.plays++;

        if (pe && accepted) { countPenalty(st, p, pe, off, start, end); }

        if (res === "INTERCEPTION" || res === "FUMBLE_LOST") {
            p.turnover = res === "INTERCEPTION" ? "INT" : "FUMBLE";
            if (res === "INTERCEPTION") { T.passing.ints++; T.turnovers.ints++; } else { T.turnovers.fumblesLost++; }
            T.turnovers.total++;
            flip(st, p, def, end, p.turnover, res === "FUMBLE_LOST" && isNum(ev.fumbleSpot) ? ev.fumbleSpot : start);
        } else {
            progress(st, p, t === "PASS" && res === "INCOMPLETE" ? start : end, {
                cat: cat,
                autoFirst: !!(pe && accepted && pe.autoFirst && penaltyOn(pe, off) === "DEF")
            });
        }
        p.endSpot = endOfPlay(st, p, end);

        if (wasDown === 3 || wasDown === 4) {
            line = wasDown === 3 ? T.third : T.fourth;
            line.att++;
            line.ytg += toGo;
            if (p.firstDown) { line.conv++; }
        }
    }

    function endOfPlay(st, p, end) {
        return p.td || p.safety ? end : st.spot;
    }

    function applyPenalty(st, ev, p) {
        var off = st.offense, pe = ev.penalty || {}, start = st.spot;
        var end = isNum(ev.endSpot) ? clamp(ev.endSpot, 0, 100) : start;
        p.yards = (end - start) * dir(off);
        if (pe.accepted === false) { p.declined = true; p.yards = 0; p.endSpot = start; return; }
        countPenalty(st, p, pe, off, start, end);
        if (pe.lossOfDown) {
            progress(st, p, end, { cat: "penalty", replayDown: false, autoFirst: false });
        } else {
            progress(st, p, end, { cat: "penalty", replayDown: true, autoFirst: !!pe.autoFirst && p.penalty.on === "DEF" });
        }
        p.endSpot = endOfPlay(st, p, end);
    }

    function applyPunt(st, ev, p) {
        var off = st.offense, def = other(off), T = st.team[off], start = st.spot, end;
        T.punts.n++;
        if (isNum(ev.puntLandSpot)) { T.punts.yds += (ev.puntLandSpot - start) * dir(off); }
        if (ev.touchback) { end = abs(def, 0); }
        else if (isNum(ev.endSpot)) { end = clamp(ev.endSpot, 0, 100); }
        else if (isNum(ev.puntLandSpot)) { end = clamp(ev.puntLandSpot, 0, 100); }
        else { end = abs(def, 0); }
        p.yards = 0;
        flip(st, p, def, end, "PUNT", start);
        p.endSpot = endOfPlay(st, p, end);
    }

    function applyFieldGoal(st, ev, p) {
        var off = st.offense, def = other(off), T = st.team[off], start = st.spot, end;
        T.fg.att++;
        p.yards = 0;
        p.kickDistance = rel(def, start) + 17;
        if (ev.result === "GOOD") {
            T.fg.made++;
            st.score[off] += 3;
            p.scoring = { side: off, pts: 3, kind: "FG" };
            closeDrive(st, "FG", start);
            kickoffPending(st, def);
            p.endSpot = start;
            return;
        }
        end = isNum(ev.endSpot) ? clamp(ev.endSpot, 0, 100) : abs(def, 0);
        flip(st, p, def, end, ev.result === "BLOCKED" ? "FG BLOCKED" : "MISSED FG", start);
        p.endSpot = endOfPlay(st, p, end);
    }

    function applyTry(st, ev, p) {
        var side = st.trySide, T = st.team[side], pts = ev.type === "PAT" ? 1 : 2;
        var line = ev.type === "PAT" ? T.pat : T.twoPt, last = st.drives[st.drives.length - 1];
        p.offense = side;
        p.defense = other(side);
        p.down = null; p.toGo = null;
        line.att++;
        if (ev.result === "GOOD") {
            line.made++;
            st.score[side] += pts;
            p.scoring = { side: side, pts: pts, kind: ev.type };
        }
        if (last && last.side === side && last.result === "TD") {
            last.tryResult = { type: ev.type, result: ev.result };
            p.drive = last.num;
        } else {
            p.drive = null;
        }
        p.endSpot = st.spot;
        kickoffPending(st, other(side));
    }

    function playText(st, ev, p) {
        var t = ev.type, res = ev.result || "GAIN", s, y = p.yards;
        var code = st.codes[p.offense] || "";
        function yd(n) { return n + (Math.abs(n) === 1 ? " yd" : " yds"); }
        if (t === "RUSH") { s = "Rush for " + yd(y); }
        else if (t === "SACK") { s = "Sacked for " + yd(y); }
        else if (t === "PASS") {
            if (res === "INCOMPLETE") { s = "Pass incomplete"; }
            else if (res === "INTERCEPTION") { s = "Pass intercepted"; }
            else { s = "Pass complete for " + yd(y); }
        }
        else if (t === "PENALTY") {
            s = p.declined ? "Penalty declined" :
                "Penalty on " + (p.penalty ? st.codes[p.penalty.side] : "?") + ", " + yd(p.penalty ? p.penalty.yards : 0);
        }
        else if (t === "PUNT") { s = "Punt" + (p.touchback ? ", touchback" : ""); }
        else if (t === "FG") { s = p.kickDistance + " yd FG " + (ev.result === "GOOD" ? "good" : (ev.result === "BLOCKED" ? "blocked" : "no good")); }
        else if (t === "PAT") { s = "PAT " + (ev.result === "GOOD" ? "good" : (ev.result === "BLOCKED" ? "blocked" : "no good")); }
        else if (t === "TWO_PT") { s = "2PT " + (ev.result === "GOOD" ? "good" : "no good"); }
        else { s = t; }
        if (res === "FUMBLE_LOST") { s += ", fumble lost"; }
        if (res === "FUMBLE_RECOVERED") { s += ", fumble recovered"; }
        if (p.td) { s += ", TOUCHDOWN" + (p.scoring && p.scoring.side !== p.offense ? " " + st.codes[p.scoring.side] : ""); }
        else if (p.safety) { s += ", SAFETY"; }
        else if (p.turnover === "DOWNS") { s += ", turnover on downs"; }
        else if (p.firstDown) { s += ", 1ST DOWN"; }
        return code + " " + s;
    }

    function applyPlay(st, ev) {
        var off = st.offense, t = ev.type;
        var p = {
            id: ev.id, num: st.plays.length + 1, type: t, result: ev.result || (t === "RUSH" || t === "PASS" || t === "SACK" ? "GAIN" : null),
            offense: off, defense: other(off), period: st.period, clock: st.cur ? st.cur.clock : null,
            drive: null, down: st.down, toGo: null, spot: st.spot, lineToGain: st.ltg, goal: false,
            endSpot: null, yards: 0, firstDown: false, td: false, safety: false,
            turnover: null, scoring: null, penalty: null, possessionTo: null, touchback: false, text: ""
        };
        if (t === "PAT" || t === "TWO_PT") {
            applyTry(st, ev, p);
        } else {
            if (!st.drive) { openDrive(st, off, st.spot, st.phase === "KICKOFF" ? "KICKOFF" : "PLAY"); }
            st.phase = "SCRIMMAGE";
            p.drive = st.drive.num;
            p.toGo = (st.ltg - st.spot) * dir(off);
            p.goal = st.ltg === goalOf(off);
            st.drive.playIds.push(ev.id);
            if (t === "RUSH" || t === "PASS" || t === "SACK") { applyScrimmage(st, ev, p); }
            else if (t === "PENALTY") { applyPenalty(st, ev, p); }
            else if (t === "PUNT") { applyPunt(st, ev, p); }
            else if (t === "FG") { applyFieldGoal(st, ev, p); }
        }
        if (ev.players) { p.players = ev.players; }   // PLAYERS level: carried through, stats later
        p.text = playText(st, ev, p);
        st.plays.push(p);
    }

    // --------------------------------------------------------------- events

    function applyKickoff(st, ev) {
        var rec = ev.receiving, spot;
        spot = ev.touchback || !isNum(ev.spot) ? abs(rec, 0) : clamp(ev.spot, 0, 100);
        if (st.drive) { closeDrive(st, "KICKOFF", st.spot); }
        if (rel(rec, spot) >= 100) {
            // kick return TD: no drive for the receiving team
            touchdown(st, { }, rec);
            st.plays.push({ id: ev.id, num: st.plays.length + 1, type: "KICKOFF_RETURN", result: "TD",
                offense: rec, defense: other(rec), period: st.period, clock: st.cur ? st.cur.clock : null,
                drive: null, down: null, toGo: null, spot: null, lineToGain: null, goal: false, endSpot: goalOf(rec),
                yards: 0, firstDown: false, td: true, safety: false, turnover: null,
                scoring: { side: rec, pts: 6, kind: "TD" }, penalty: null, possessionTo: rec, touchback: false,
                text: st.codes[rec] + " Kickoff return, TOUCHDOWN" });
            return;
        }
        if (rel(rec, spot) <= 0) { spot = abs(rec, st.rules.touchbackSpot); }
        firstAndTen(st, rec, spot);
        st.phase = "SCRIMMAGE";
        st.trySide = null;
        openDrive(st, rec, spot, "KICKOFF");
    }

    function applyPossession(st, ev) {
        var side = ev.side, spot;
        if (side === "NONE") {                                      // sticky until the next possession event
            if (st.offense) { st.offBefore = st.offense; }
            st.offense = null;
            return;
        }
        if (!st.drive && side === st.offBefore && (st.phase === "TRY" || st.phase === "KICKOFF") && !isNum(ev.spot)) {
            st.offense = side;                                      // back ON during a try / before a kickoff: nothing else changes
            return;
        }
        spot = isNum(ev.spot) ? clamp(ev.spot, 0, 100) :
            (st.spot !== null ? st.spot : abs(side, st.rules.touchbackSpot));
        if (st.drive && st.drive.side === side) {
            // Ball back ON for the team that has the drive: the drive resumes.
            st.offense = side;
            if (isNum(ev.spot)) { firstAndTen(st, side, spot); }
            if (st.down === null) { firstAndTen(st, side, spot); }
            if (st.phase !== "TRY") { st.phase = "SCRIMMAGE"; }
            return;
        }
        if (st.drive) { closeDrive(st, "POSSESSION", st.spot); }      // ev.reason is kept in the log only
        firstAndTen(st, side, spot);
        st.phase = "SCRIMMAGE";
        st.trySide = null;
        openDrive(st, side, spot, "POSSESSION");
    }

    function applySpot(st, ev) {
        var off = st.offense;
        st.spot = ev.spot;
        st.down = ev.down;
        if (isNum(ev.lineToGain)) {
            st.ltg = ev.lineToGain;
        } else {
            firstAndTen(st, off, ev.spot);
            st.down = ev.down;
        }
        if (st.phase !== "SCRIMMAGE") { st.phase = "SCRIMMAGE"; st.trySide = null; }
    }

    function endOfPeriodStamp(st, period) {
        return period >= 1 && period <= 4 ? stamp(st, period, 0) : null;
    }

    function halfOver(st, ev, result, endPeriod) {
        if (st.drive) { closeDrive(st, result, st.spot, endOfPeriodStamp(st, endPeriod)); }
        st.offense = null;
        st.phase = "KICKOFF";
        st.trySide = null;
        st.down = null;
    }

    function applyPeriod(st, ev) {
        var v = ev.period, prev = st.period;
        if (v === "FINAL") {
            halfOver(st, ev, "END OF GAME", prev);
            st.phase = "FINAL";
            return;
        }
        if (v === "HALF" || (isNum(v) && v >= 3 && st.half === 1)) {
            halfOver(st, ev, "END OF HALF", v === "HALF" ? prev : Math.min(prev, 2));
            st.half = 2;
            st.timeouts = { AWAY: st.rules.timeoutsPerHalf, HOME: st.rules.timeoutsPerHalf };
            if (isNum(v)) { st.period = v; } else { st.period = 2; }
            return;
        }
        if (v === "OT") {
            halfOver(st, ev, "END OF PERIOD", prev);
            st.period = prev < 5 ? 5 : prev + 1;
            st.half = 3;
            st.timeouts = { AWAY: st.rules.otTimeouts, HOME: st.rules.otTimeouts };
            return;
        }
        st.period = v;      // 1 -> 2, 3 -> 4: the drive carries on across the quarter
    }

    function applyTimeout(st, ev) {
        if (ev.set) {
            if (isNum(ev.set.AWAY)) { st.timeouts.AWAY = ev.set.AWAY; }
            if (isNum(ev.set.HOME)) { st.timeouts.HOME = ev.set.HOME; }
            return;
        }
        st.timeouts[ev.side]--;
    }

    // ------------------------------------------------------------- validate

    function check(st, ev) {
        var k = ev && ev.kind, t, res, pe;
        if (!ev || typeof k !== "string") { return no("Event has no kind"); }
        if (ev.clock !== undefined && ev.clock !== null && parseClock(ev.clock) === null) { return no("Clock must be m:ss"); }
        if (st.phase === "FINAL" && k !== "SCORE_FIX" && k !== "TIMEOUT" && k !== "CLOCK" && !(k === "PERIOD" && ev.period === "OT")) {
            return no("The game is final");
        }
        if (k === "PLAY") {
            t = ev.type;
            if (!PLAY_TYPES[t]) { return no("Unknown play type " + t); }
            res = ev.result;
            if (t === "PAT" || t === "TWO_PT") {
                if (st.phase !== "TRY") { return no("No try pending: a PAT / 2PT only follows a touchdown"); }
                if (!RESULTS[t][res]) { return no("Try result must be GOOD or NO_GOOD"); }
                return ok();
            }
            if (!isSide(st.offense)) { return no("Ball is OFF: set possession first"); }
            if (st.phase === "TRY") { return no("A try is pending: log the PAT / 2PT (or a KICKOFF) first"); }
            if (RESULTS[t] && res !== undefined && res !== null && !RESULTS[t][res]) {
                return no(res === "INTERCEPTION" ? "Only a pass can be intercepted" : "Result " + res + " does not fit a " + t);
            }
            if (t === "FG" && !RESULTS.FG[res]) { return no("FG result must be GOOD, NO_GOOD or BLOCKED"); }
            if ((t === "RUSH" || t === "SACK" || (t === "PASS" && res !== "INCOMPLETE")) && !isNum(ev.endSpot)) {
                return no("Drag the spot: the play needs an end spot");
            }
            if (t === "PENALTY") {
                pe = ev.penalty;
                if (!pe || !penaltyOn(pe, st.offense)) { return no("Penalty needs on: OFF or DEF"); }
                if (pe.accepted !== false && !isNum(ev.endSpot)) { return no("Drag the spot: the penalty needs an end spot"); }
            }
            if (isNum(ev.endSpot) && (ev.endSpot < 0 || ev.endSpot > 100)) { return no("End spot must be 0-100"); }
            return ok();
        }
        if (k === "SPOT") {
            if (!isSide(st.offense)) { return no("Ball is OFF: set possession first"); }
            if (!(ev.down === 1 || ev.down === 2 || ev.down === 3 || ev.down === 4)) { return no("Down must be 1-4"); }
            if (!isNum(ev.spot) || ev.spot <= 0 || ev.spot >= 100) { return no("Spot must be between the goal lines (0-100)"); }
            if (ev.lineToGain !== undefined && ev.lineToGain !== null) {
                if (!isNum(ev.lineToGain) || ev.lineToGain < 0 || ev.lineToGain > 100) { return no("Line to gain must be 0-100"); }
                if ((ev.lineToGain - ev.spot) * dir(st.offense) <= 0) { return no("Line to gain must be ahead of the ball"); }
            }
            return ok();
        }
        if (k === "POSSESSION") {
            if (!(isSide(ev.side) || ev.side === "NONE")) { return no("Possession side must be AWAY, HOME or NONE"); }
            if (ev.spot !== undefined && ev.spot !== null && (!isNum(ev.spot) || ev.spot <= 0 || ev.spot >= 100)) {
                return no("Spot must be between the goal lines (0-100)");
            }
            return ok();
        }
        if (k === "KICKOFF") {
            if (!isSide(ev.receiving)) { return no("Kickoff needs the receiving team"); }
            if (!ev.touchback && ev.spot !== undefined && ev.spot !== null && (!isNum(ev.spot) || ev.spot < 0 || ev.spot > 100)) {
                return no("Spot must be 0-100");
            }
            return ok();
        }
        if (k === "PERIOD") {
            if (ev.period === 1 || ev.period === 2 || ev.period === 3 || ev.period === 4 ||
                ev.period === "OT" || ev.period === "HALF" || ev.period === "FINAL") { return ok(); }
            return no("Period must be 1-4, OT, HALF or FINAL");
        }
        if (k === "TIMEOUT") {
            if (ev.set) {
                if ((ev.set.AWAY !== undefined && !(isNum(ev.set.AWAY) && ev.set.AWAY >= 0 && ev.set.AWAY <= 9)) ||
                    (ev.set.HOME !== undefined && !(isNum(ev.set.HOME) && ev.set.HOME >= 0 && ev.set.HOME <= 9))) {
                    return no("Timeouts must be 0-9");
                }
                return ok();
            }
            if (!isSide(ev.side)) { return no("Timeout needs a side"); }
            if (!(st.timeouts[ev.side] > 0)) { return no(st.codes[ev.side] + " has no timeouts left"); }
            return ok();
        }
        if (k === "SCORE_FIX") {
            if (!isSide(ev.side)) { return no("Score fix needs a side"); }
            if (!isNum(ev.delta) || ev.delta === 0 || Math.floor(ev.delta) !== ev.delta) { return no("Score fix needs a whole, non-zero delta"); }
            if (st.score[ev.side] + ev.delta < 0) { return no("Score can't go below 0"); }
            return ok();
        }
        if (k === "CLOCK") {
            if (parseClock(ev.clock) === null) { return no("Clock must be m:ss"); }
            return ok();
        }
        return no("Unknown event kind " + k);
    }
    function ok() { return { ok: true, reason: "" }; }
    function no(reason) { return { ok: false, reason: reason }; }

    // Public: validate an event against a Result (what the page holds).
    function validate(result, ev) {
        var s = result.situation;
        return check({
            phase: s.phase, offense: s.offense, timeouts: result.timeouts, score: result.score,
            codes: result.codes || { AWAY: "AWAY", HOME: "HOME" }
        }, ev);
    }

    // --------------------------------------------------------------- replay

    function noteClock(st, ev) {
        var secs = ev.kind === "PERIOD" ? null : parseClock(ev.clock);
        if (secs === null) { st.cur = null; return; }
        st.cur = stamp(st, isNum(ev.period) ? ev.period : st.period, secs);
        if (st.drive) {
            if (!st.drive.startClock) { st.drive.startClock = st.cur; st.drive.startLate = true; }   // no start time: the first time seen
            st.drive.last = st.cur;
        }
    }

    function applyEvent(st, ev) {
        var v = check(st, ev);
        if (!v.ok) { warn(st, ev, "INVALID", v.reason); return; }
        noteClock(st, ev);
        switch (ev.kind) {
            case "PLAY": applyPlay(st, ev); break;
            case "KICKOFF": applyKickoff(st, ev); break;
            case "POSSESSION": applyPossession(st, ev); break;
            case "SPOT": applySpot(st, ev); break;
            case "PERIOD": applyPeriod(st, ev); break;
            case "TIMEOUT": applyTimeout(st, ev); break;
            case "SCORE_FIX": st.score[ev.side] += ev.delta; break;
            case "CLOCK": break;
        }
    }

    function clockOut(c) { return c ? { period: c.period, clock: c.clock } : null; }

    function finishDrive(st, d) {
        // An open drive runs to the current spot and the last clock stamp seen.
        var end = d.open ? d.last : d.endClock;
        var endSpot = d.open ? (st.spot !== null ? st.spot : d.startSpot) : d.endSpot;
        var time = (d.startClock && end && d.startClock.abs !== null && end.abs !== null && end.abs >= d.startClock.abs) ?
            end.abs - d.startClock.abs : null;
        var yards = endSpot !== null && d.startSpot !== null ? (endSpot - d.startSpot) * dir(d.side) : 0;
        // a drive with no start time whose only time is its end: no drive time (not 0:00)
        if (d.startLate && end === d.startClock) { time = null; }
        return {
            num: d.num, teamNum: d.teamNum, side: d.side, team: st.codes[d.side],
            startSpot: d.startSpot, startReason: d.startReason, startClock: clockOut(d.startClock),
            endSpot: endSpot, endClock: clockOut(d.open ? null : end),
            result: d.result, open: d.open, plays: d.plays, playIds: d.playIds,
            yards: yards, time: time, timeText: time === null ? "" : fmtClock(time),
            tryResult: d.tryResult
        };
    }

    function finishTeam(st, side, drives) {
        var T = st.team[side], top = 0, i;
        T.rushing.avg = T.rushing.att ? round1(T.rushing.yds / T.rushing.att) : 0;
        T.passing.avg = T.passing.comp ? round1(T.passing.yds / T.passing.comp) : 0;
        T.third.avgYtg = T.third.att ? round1(T.third.ytg / T.third.att) : 0;
        T.fourth.avgYtg = T.fourth.att ? round1(T.fourth.ytg / T.fourth.att) : 0;
        T.punts.avg = T.punts.n ? round1(T.punts.yds / T.punts.n) : 0;
        T.totalYards = T.rushing.yds + T.passing.yds;
        T.totalPlays = T.rushing.att + T.passing.att + (st.rules.sacksAs === "PASS" ? T.sacks.n : 0);
        T.yardsPerPlay = T.totalPlays ? round1(T.totalYards / T.totalPlays) : 0;
        for (i = 0; i < drives.length; i++) {
            if (drives[i].side === side && drives[i].time !== null) { top += drives[i].time; }
        }
        T.top = top;
        T.topText = fmtClock(top);
        T.score = st.score[side];
        T.timeouts = st.timeouts[side];
        return T;
    }

    function situation(st) {
        var off = st.offense, s = {
            period: st.period, periodLabel: periodLabel(st.period), half: st.half, phase: st.phase,
            offense: off, defense: other(off), ballOff: off === null,
            spot: st.spot, down: null, toGo: null, lineToGain: null, goal: false,
            ballOn: null, ddText: "", trySide: st.trySide
        };
        if (st.phase === "FINAL") { s.periodLabel = "FINAL"; }
        else if (st.half === 2 && st.period === 2) { s.periodLabel = "HALF"; }
        if (st.spot !== null) {
            s.ballOn = st.spot < 50 ? { side: "AWAY", team: st.codes.AWAY, yardLine: st.spot } :
                (st.spot > 50 ? { side: "HOME", team: st.codes.HOME, yardLine: 100 - st.spot } : { side: null, team: "", yardLine: 50 });
        }
        if (off && st.phase === "TRY") {
            s.ddText = "PAT";
        } else if (off && st.down !== null) {
            s.down = st.down;
            s.lineToGain = st.ltg;
            s.toGo = (st.ltg - st.spot) * dir(off);
            s.goal = st.ltg === goalOf(off);
            s.ddText = ordinal(st.down) + " & " + (s.goal ? "Goal" : (s.toGo < 1 ? "Inches" : s.toGo));
        }
        return s;
    }

    function replay(setup, events) {
        var st = newState(setup), i, drives = [];
        for (i = 0; events && i < events.length; i++) { applyEvent(st, events[i]); }
        for (i = 0; i < st.drives.length; i++) { drives.push(finishDrive(st, st.drives[i])); }
        return {
            engine: VERSION,
            codes: { AWAY: st.codes.AWAY, HOME: st.codes.HOME },
            situation: situation(st),
            score: { AWAY: st.score.AWAY, HOME: st.score.HOME },
            timeouts: { AWAY: st.timeouts.AWAY, HOME: st.timeouts.HOME },
            drives: drives,
            plays: st.plays,
            team: { AWAY: finishTeam(st, "AWAY", drives), HOME: finishTeam(st, "HOME", drives) },
            players: playerStats(st.plays),   // PLAYERS level (null in a TEAM game)
            warnings: st.warnings
        };
    }

    // PLAYERS level: one line per jersey from the plays that carry players
    // { passer, receiver, rusher } (jersey strings). Null when no play has any,
    // so TEAM games are unchanged. A missed jersey only loses that player line.
    function playerStats(plays) {
        var out = { AWAY: {}, HOME: {} }, any = false, i, p, pl, side, yds, td, line;
        function get(n) {
            n = String(n);
            return out[side][n] || (out[side][n] = {
                n: n,
                passing: { comp: 0, att: 0, yds: 0, td: 0, ints: 0, long: null },
                rushing: { att: 0, yds: 0, td: 0, long: null },
                receiving: { rec: 0, yds: 0, td: 0, long: null }
            });
        }
        function longest(o, y) { if (o.long === null || y > o.long) { o.long = y; } }
        for (i = 0; i < plays.length; i++) {
            p = plays[i]; pl = p.players;
            if (!pl || (p.type !== "RUSH" && p.type !== "PASS")) { continue; }
            side = p.offense;
            if (side !== "AWAY" && side !== "HOME") { continue; }
            any = true;
            yds = p.yards || 0;
            td = !!(p.td && p.scoring && p.scoring.side === side);
            if (p.type === "RUSH" && pl.rusher) {
                line = get(pl.rusher).rushing;
                line.att++; line.yds += yds; if (td) { line.td++; } longest(line, yds);
            }
            if (p.type === "PASS") {
                if (pl.passer) {
                    line = get(pl.passer).passing;
                    line.att++;
                    if (p.result === "INTERCEPTION") { line.ints++; }
                    else if (p.result !== "INCOMPLETE") { line.comp++; line.yds += yds; if (td) { line.td++; } longest(line, yds); }
                }
                if (pl.receiver && p.result !== "INCOMPLETE" && p.result !== "INTERCEPTION") {
                    line = get(pl.receiver).receiving;
                    line.rec++; line.yds += yds; if (td) { line.td++; } longest(line, yds);
                }
            }
        }
        return any ? out : null;
    }

    function replayOps(setup, ops) {
        return replay(setup, StatsOps.effective(ops));
    }

    return {
        VERSION: VERSION,
        DEFAULT_RULES: DEFAULT_RULES,
        replay: replay,
        replayOps: replayOps,
        validate: validate,
        parseClock: parseClock,
        fmtClock: fmtClock
    };
})();
