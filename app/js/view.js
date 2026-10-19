/*
 * stats/app/js/view.js - renders a Result onto the page: strip, field, drive
 * list, play list. Nothing here keeps game state; every value comes from the
 * Result passed in (STATS_APP_PLAN.md rule 7).
 */
var View = (function () {

    var $ = function (id) { return document.getElementById(id); };
    var field = null;
    var SIDES = ["AWAY", "HOME"];

    function init() {
        $("boxBody").addEventListener("click", function (e) {
            var tr = e.target.closest && e.target.closest("tr.sec");
            if (!tr || typeof App === "undefined" || !App.result) { return; }
            var sec = tr.getAttribute("data-sec");
            if (FOLDED[sec]) { delete FOLDED[sec]; } else { FOLDED[sec] = 1; }
            try { localStorage.setItem("statsapp.statFold", JSON.stringify(FOLDED)); } catch (x) { /* private mode */ }
            LAST.ops = -1;                                       // a fold is not a change
            statCol(App.result);
        });
        // one toggle: COLLAPSE ALL while any drive is open, else EXPAND ALL
        $("foldAll").addEventListener("click", function () {
            if (typeof App === "undefined" || !App.result) { return; }
            foldAll(App.result, anyOpen(App.result));
            App.refresh();
        });
        $("statFoldAll").addEventListener("click", function () {
            var secs = Array.prototype.map.call($("boxBody").querySelectorAll("tr.sec"), function (tr) { return tr.getAttribute("data-sec"); }),
                open = secs.some(function (x) { return !FOLDED[x]; });
            if (typeof App === "undefined" || !App.result) { return; }
            secs.forEach(function (x) { if (open) { FOLDED[x] = 1; } else { delete FOLDED[x]; } });
            try { localStorage.setItem("statsapp.statFold", JSON.stringify(FOLDED)); } catch (x) { /* private mode */ }
            LAST.ops = -1;
            statCol(App.result);
        });
        $("statTabs").addEventListener("click", function (e) {
            var b = e.target.closest("[data-st]");
            if (!b || typeof App === "undefined" || !App.result) { return; }
            statTab = b.getAttribute("data-st");
            try { localStorage.setItem("statsapp.statTab", statTab); } catch (x) { /* private mode */ }
            statCol(App.result);
        });
        field = Field.create($("field"));
    }

    // ---------------------------------------------------------------- strip

    function teamName(side, codes) {
        var su = typeof App !== "undefined" && App.game ? App.game.setup || {} : {}, t = side === "AWAY" ? su.away : su.home;
        return String((t && t.name) || codes[side] || side).toUpperCase();
    }

    // GRIDIRON's strip: team blocks + period + situation. Taps are wired in app.js.
    function strip(res) {
        var sit = res.situation, codes = res.codes, i, side, el, dots, k, to, has, d = null, situ, detail;
        for (i = 0; i < 2; i++) {
            side = SIDES[i];
            el = $("sb" + side);
            has = sit.offense === side;
            to = res.timeouts[side];
            dots = "";
            for (k = 1; k <= 3; k++) {
                dots += '<span class="dot' + (k <= to ? '' : ' used') + '" data-dot="' + side + ':' + k + '" title="Timeouts: tap to use or give back"></span>';
            }
            el.classList.toggle("has", has);
            el.innerHTML = '<div class="info" data-ball="' + side + '" title="' + (has ? "Has the ball - tap for no possession" : "Tap to give " + Fmt.esc(teamName(side, codes)) + " the ball") + '">' +
                '<div class="nm">' + Fmt.esc(teamName(side, codes)) + '</div>' +
                '<div class="tor"><div class="dots">' + dots + '</div><span class="bt">&#127944; BALL</span></div></div>' +
                '<button class="sc" data-fix="' + side + '" title="Tap to fix the score">' + res.score[side] + '</button>';
        }
        $("period").textContent = sit.periodLabel || "-";
        $("period").classList.toggle("brk", sit.periodLabel === "HALF" || sit.phase === "FINAL");

        for (i = res.drives.length - 1; i >= 0; i--) { if (res.drives[i].open) { d = res.drives[i]; break; } }
        if (sit.phase === "FINAL") { situ = "FINAL"; }
        else if (sit.phase === "TRY") { situ = "TRY - " + teamName(sit.offense || sit.trySide, codes); }
        else if (sit.phase === "KICKOFF") { situ = "KICKOFF" + (sit.offense ? " - " + teamName(sit.offense, codes) + " receives" : ""); }
        else if (sit.ballOff) { situ = "BALL OFF"; }
        else { situ = (sit.ddText || "-") + (sit.spot !== null ? " at " + Fmt.spot(sit.spot, codes) : ""); }
        $("situ").textContent = situ;

        if (d) { detail = teamName(d.side, codes) + " ball  |  drive " + d.num + "  |  play " + (d.plays + 1) + "  |  " + sit.periodLabel; }
        else { detail = teamName("AWAY", codes) + " at " + teamName("HOME", codes) + "  |  " + sit.periodLabel; }
        $("detail").textContent = detail;
        $("detail").setAttribute("data-base", detail);
        $("situW").classList.remove("live");
        document.body.setAttribute("data-offense", sit.offense || "NONE");
    }

    // ---------------------------------------------------------------- lists

    function driveRow(d, codes, selected) {
        var cls = "drive " + d.side.toLowerCase() + (d.open ? " open" : "") + (selected ? " sel" : "") +
            (d.result === "TD" || d.result === "FG" ? " score" : "");
        return '<button class="' + cls + '" data-drive="' + d.num + '">' +
            '<span class="n">' + d.num + '</span>' +
            '<span class="t">' + Fmt.esc(d.team) + '</span>' +
            '<span class="from">' + Fmt.esc(Fmt.spot(d.startSpot, codes)) + ' <em>' + Fmt.esc(Fmt.driveStart(d)) + '</em></span>' +
            '<span class="pl">' + d.plays + '-' + d.yards + '</span>' +
            '<span class="tm">' + Fmt.esc(d.timeText) + '</span>' +
            '<span class="res">' + Fmt.esc(Fmt.driveResult(d)) + '</span>' +
            '</button>';
    }

    function drives(res, ui) {
        var out = [], i, d, list = res.drives;
        if (ui.tab !== "drives") { return null; }
        for (i = list.length - 1; i >= 0; i--) {
            d = list[i];
            if (ui.driveTeam !== "ALL" && d.side !== ui.driveTeam) { continue; }
            out.push(driveRow(d, res.codes, ui.drive === d.num));
        }
        return out.length ? out.join("") : '<div class="empty">No drives yet</div>';
    }

    // the jerseys on a PLAYERS-level play: " - SIMPSON to VASKE" / " - SCHROCK"
    // The players on a RUSH / PASS row: RB, or QB + REC. An empty slot is dashed; drag a player from the
    // PLAYERS card onto it (or onto the row) to assign them (center.js).
    function who(p) {
        var pl = p.players || {}, nm, chip;
        if ((p.type !== "PASS" && p.type !== "RUSH") || !p.offense || typeof Players === "undefined") { return ""; }
        nm = function (n) { return Players.last(p.offense, n) || "#" + n; };
        chip = function (role, label, n) {
            return '<span class="pslot' + (n ? ' on' : '') + '" data-role="' + role + '" title="' + (n ? Fmt.esc(Players.name(p.offense, n)) : 'Drag a player here') + '">' +
                (n ? Fmt.esc(nm(n)) : label) + '</span>';
        };
        if (p.type === "RUSH") { return ' <span class="pslots">' + chip("rusher", "RB", pl.rusher) + '</span>'; }
        return ' <span class="pslots">' + chip("passer", "QB", pl.passer) + '<i>&rsaquo;</i>' + chip("receiver", "REC", pl.receiver) + '</span>';
    }

    function playRow(p, codes) {
        var flags = "", cls = "play " + (p.offense ? p.offense.toLowerCase() : "");
        if (p.scoring) { flags += '<b class="f score">' + (p.scoring.kind === "TD" ? "TD" : p.scoring.kind) + '</b>'; cls += " scored"; }
        if (p.turnover) { flags += '<b class="f to">' + (p.turnover === "DOWNS" ? "DOWNS" : p.turnover) + '</b>'; }
        else if (p.firstDown && !p.td) { flags += '<b class="f first">1ST</b>'; }
        if (p.penalty) { flags += '<b class="f flag">FLAG</b>'; }
        return '<div class="' + cls + '" data-ev="' + Fmt.esc(p.id) + '" role="button" tabindex="0">' +
            '<span class="dd">' + Fmt.esc(Fmt.playDD(p)) + '</span>' +
            '<span class="at">' + Fmt.esc(p.spot !== null && p.type !== "PAT" && p.type !== "TWO_PT" ? Fmt.spot(p.spot, codes) : "") + '</span>' +
            '<span class="txt">' + Fmt.esc(p.text) + who(p) + '</span>' +
            '<span class="fl">' + flags + '</span>' +
            '<span class="clk">' + Fmt.esc(p.clock ? Fmt.periodShort(p.period) + " " + p.clock : Fmt.periodShort(p.period)) + '</span>' +
            '</div>';
    }

    // Drives fold in the Plays list: tap a drive's header (COLLAPSE ALL / EXPAND ALL on top), kept on this device per game.
    var DFOLD = {};
    try { DFOLD = JSON.parse(localStorage.getItem("statsapp.logFold") || "{}") || {}; } catch (e) { DFOLD = {}; }
    function gameKey() { var g = typeof App !== "undefined" ? App.game : null; return g ? (g.id || g.fixture || "") : ""; }
    function dKey(n) { return gameKey() + ":" + n; }
    function saveFold() { try { localStorage.setItem("statsapp.logFold", JSON.stringify(DFOLD)); } catch (e) { /* private mode */ } }
    function foldDrive(n) { if (DFOLD[dKey(n)]) { delete DFOLD[dKey(n)]; } else { DFOLD[dKey(n)] = 1; } saveFold(); }
    function foldAll(res, on) {
        var k;
        for (k in DFOLD) { if (DFOLD.hasOwnProperty(k) && k.indexOf(gameKey() + ":") === 0) { delete DFOLD[k]; } }
        if (on) { res.drives.forEach(function (d) { DFOLD[dKey(d.num)] = 1; }); }
        saveFold();
    }

    function anyOpen(res) { return res.drives.some(function (d) { return !DFOLD[dKey(d.num)]; }); }

    function driveHead(d, codes) {
        var f = !!DFOLD[dKey(d.num)];
        return '<div class="dhead ' + d.side.toLowerCase() + (f ? ' folded' : '') + '" data-dfold="' + d.num + '" title="Tap to ' + (f ? 'open' : 'fold') + ' this drive">' +
            '<span><span class="arr">' + (f ? '&#9656;' : '&#9662;') + '</span>Drive ' + d.num + ' · ' + Fmt.esc(d.team) +
            (f ? ' <span class="muted">' + d.plays + ' play' + (d.plays === 1 ? '' : 's') + ', ' + Fmt.signed(d.yards) + ' yds</span>' : '') + '</span>' +
            '<span class="muted">from ' + Fmt.esc(Fmt.spot(d.startSpot, codes)) +
            (d.startClock ? ' · ' + Fmt.esc(Fmt.clock(d.startClock)) : '') + '</span>' +
            '<span class="res">' + Fmt.esc(Fmt.driveResult(d)) + '</span></div>';
    }

    // Newest first, with a header each time the drive changes.
    function plays(res, ui) {
        var out = [], i, p, last = -1, byNum = {}, d, list = res.plays;
        for (i = 0; i < res.drives.length; i++) { byNum[res.drives[i].num] = res.drives[i]; }
        for (i = list.length - 1; i >= 0; i--) {
            p = list[i];
            if (ui.drive !== null && p.drive !== ui.drive) { continue; }
            if (p.drive !== last) {
                d = p.drive !== null ? byNum[p.drive] : null;
                out.push(d ? driveHead(d, res.codes) : '<div class="dhead none"><span>No drive</span></div>');
                last = p.drive;
            }
            if (d && DFOLD[dKey(d.num)]) { continue; }
            out.push(playRow(p, res.codes));
        }
        return out.length ? out.join("") : '<div class="empty">No plays yet</div>';
    }

    // Every logged event, newest first; skipped ones show the engine's reason.
    function log(res, events) {
        var out = [], i, ev, plays = {}, bad = {}, p, cls;
        for (i = 0; i < res.plays.length; i++) { plays[res.plays[i].id] = res.plays[i]; }
        for (i = 0; i < res.warnings.length; i++) {
            if (res.warnings[i].code === "INVALID") { bad[res.warnings[i].eventId] = res.warnings[i].text; }
        }
        for (i = events.length - 1; i >= 0; i--) {
            ev = events[i];
            p = plays[ev.id];
            cls = "lev" + (bad[ev.id] ? " skipped" : "") + (ev.kind !== "PLAY" ? " meta" : "");
            out.push('<div class="' + cls + '" data-ev="' + Fmt.esc(ev.id) + '" role="button" tabindex="0">' +
                '<span class="n">' + (i + 1) + '</span>' +
                '<span class="txt">' + Fmt.esc(Fmt.event(ev, res.codes, p && p.text)) +
                (bad[ev.id] ? '<em>skipped: ' + Fmt.esc(bad[ev.id]) + '</em>' : '') + '</span>' +
                '<span class="clk">' + Fmt.esc((typeof ev.period === "number" ? Fmt.periodShort(ev.period) : "") + (ev.clock ? " " + ev.clock : "")) + '</span>' +
                '</div>');
        }
        return out.length ? out.join("") : '<div class="empty">Nothing logged yet</div>';
    }

    // ---------------------------------------------------------------- box score

    function pct(made, att) { return att ? " (" + Math.round(made / att * 100) + "%)" : ""; }
    function forYds(n, yds) { return n + " for " + yds; }
    function share(v) { return v > 0 ? v : 0; }

    // [label, value(T), bar(T)?] ; a label starting with "#" is a section head,
    // one starting with "  " is a sub-line. bar: the number the compare bar uses.
    var BOX = [
        ["#Downs"],
        ["First downs", function (T) { return T.firstDowns.total; }, function (T) { return T.firstDowns.total; }],
        ["  Rushing", function (T) { return T.firstDowns.rush; }],
        ["  Passing", function (T) { return T.firstDowns.pass; }],
        ["  Penalty", function (T) { return T.firstDowns.penalty; }],
        ["3rd down", function (T) { return T.third.conv + "-" + T.third.att + pct(T.third.conv, T.third.att); }],
        ["  Avg to go", function (T) { return T.third.att ? T.third.avgYtg : "-"; }],
        ["4th down", function (T) { return T.fourth.conv + "-" + T.fourth.att + pct(T.fourth.conv, T.fourth.att); }],
        ["  Avg to go", function (T) { return T.fourth.att ? T.fourth.avgYtg : "-"; }],
        ["#Offense"],
        ["Total yards", function (T) { return T.totalYards; }, function (T) { return T.totalYards; }],
        ["  Plays", function (T) { return T.totalPlays; }],
        ["  Yards per play", function (T) { return T.totalPlays ? T.yardsPerPlay : "-"; }],
        ["Rushing", function (T) { return forYds(T.rushing.att, T.rushing.yds); }, function (T) { return T.rushing.yds; }],
        ["  Avg per rush", function (T) { return T.rushing.att ? T.rushing.avg : "-"; }],
        ["Passing yards", function (T) { return T.passing.yds; }, function (T) { return T.passing.yds; }],
        ["  Comp-Att-Int", function (T) { return T.passing.comp + "-" + T.passing.att + "-" + T.passing.ints; }],
        ["  Avg per catch", function (T) { return T.passing.comp ? T.passing.avg : "-"; }],
        ["Sacked", function (T) { return forYds(T.sacks.n, T.sacks.yds); }],
        ["Play calls rush / pass", function (T) { return T.plays.rush + " / " + T.plays.pass; }],
        ["#Turnovers"],
        ["Turnovers", function (T) { return T.turnovers.total; }],
        ["  Interceptions", function (T) { return T.turnovers.ints; }],
        ["  Fumbles lost", function (T) { return T.turnovers.fumblesLost; }],
        ["  On downs", function (T) { return T.turnovers.downs; }],
        ["#Kicking and more"],
        ["Punts", function (T) { return T.punts.n + (T.punts.n && T.punts.yds ? ", avg " + T.punts.avg : ""); }],
        ["Field goals", function (T) { return T.fg.made + "-" + T.fg.att; }],
        ["PAT", function (T) { return T.pat.made + "-" + T.pat.att; }],
        ["2PT", function (T) { return T.twoPt.made + "-" + T.twoPt.att; }],
        ["Penalties", function (T) { return forYds(T.penalties.count, T.penalties.yds); }],
        ["Drives", function (T) { return T.drives; }],
        ["Possession time", function (T) { return T.topText; }, function (T) { return T.top; }],
        ["Timeouts left", function (T) { return T.timeouts; }]
    ];

    function box(res) {
        var A = res.team.AWAY, H = res.team.HOME, out = [], i, row, a, h, tot;
        out.push('<table class="box"><thead><tr><th></th>' +
            '<th class="away">' + Fmt.esc(res.codes.AWAY) + '</th><th class="home">' + Fmt.esc(res.codes.HOME) + '</th></tr>' +
            '<tr class="score"><td>Score</td><td>' + res.score.AWAY + '</td><td>' + res.score.HOME + '</td></tr></thead><tbody>');
        for (i = 0; i < BOX.length; i++) {
            row = BOX[i];
            if (row[0].charAt(0) === "#") {
                out.push('<tr class="sec"><th colspan="3">' + Fmt.esc(row[0].slice(1)) + '</th></tr>');
                continue;
            }
            out.push('<tr' + (row[0].indexOf("  ") === 0 ? ' class="sub"' : '') + '><td>' + Fmt.esc(row[0].trim()) + '</td>' +
                '<td>' + Fmt.esc(row[1](A)) + '</td><td>' + Fmt.esc(row[1](H)) + '</td></tr>');
            if (row[2]) {
                a = share(row[2](A)); h = share(row[2](H)); tot = a + h;
                out.push('<tr class="cmp"><td colspan="3"><div><i class="a" style="flex-grow:' + (tot ? a : 1) + '"></i>' +
                    '<i class="h" style="flex-grow:' + (tot ? h : 1) + '"></i></div></td></tr>');
            }
        }
        out.push('</tbody></table>');
        return out.join("");
    }

    // One team (the stats column's AWAY / HOME button): its stats in one column, then its player lines.
    function teamBox(res, side) {
        var T = res.team[side], out = [], i, row;
        out.push('<table class="box one"><thead><tr><th></th><th class="' + side.toLowerCase() + '">' + Fmt.esc(res.codes[side]) + '</th></tr>' +
            '<tr class="score"><td>Score</td><td>' + res.score[side] + '</td></tr></thead><tbody>');
        for (i = 0; i < BOX.length; i++) {
            row = BOX[i];
            if (row[0].charAt(0) === "#") { out.push('<tr class="sec"><th colspan="2">' + Fmt.esc(row[0].slice(1)) + '</th></tr>'); continue; }
            out.push('<tr' + (row[0].indexOf("  ") === 0 ? ' class="sub"' : '') + '><td>' + Fmt.esc(row[0].trim()) + '</td><td>' + Fmt.esc(row[1](T)) + '</td></tr>');
        }
        out.push('</tbody></table>');
        if (res.players) { out.push(playerBox(res, [side])); }
        return out.join("");
    }

    // The stats column: VS | AWAY | HOME (team codes, like the end zones; the name on mouse-over), kept on this device.
    var statTab = "VS";
    try { statTab = localStorage.getItem("statsapp.statTab") || "VS"; } catch (e) { /* private mode */ }
    function statCol(res) {
        $("statTabs").innerHTML = ["VS", "AWAY", "HOME"].map(function (k) {
            return '<button data-st="' + k + '"' + (k === statTab ? ' class="on"' : '') + ' title="' + (k === "VS" ? "Both teams side by side" : Fmt.esc(teamName(k, res.codes))) + '">' +
                Fmt.esc(k === "VS" ? "VS" : res.codes[k]) + '</button>';
        }).join("");
        $("boxBody").innerHTML = statTab === "VS" ? box(res) : teamBox(res, statTab);
        folds();
        changes();
        $("statFoldAll").textContent = Array.prototype.some.call($("boxBody").querySelectorAll("tr.sec"), function (tr) { return !FOLDED[tr.getAttribute("data-sec")]; }) ? "COLLAPSE ALL" : "EXPAND ALL";
    }

    // Sections (DOWNS, OFFENSE, TURNOVERS, KICKING AND MORE): tap the heading to fold / open it (kept on this device).
    var FOLDED = {};
    try { FOLDED = JSON.parse(localStorage.getItem("statsapp.statFold") || "{}") || {}; } catch (e) { FOLDED = {}; }
    function folds() {
        Array.prototype.forEach.call($("boxBody").querySelectorAll("table.box tbody"), function (tb) {
            var sec = null;
            Array.prototype.forEach.call(tb.rows, function (tr) {
                var th;
                if (tr.classList.contains("sec")) {
                    th = tr.querySelector("th");
                    sec = th.textContent.trim();
                    tr.setAttribute("data-sec", sec);
                    tr.classList.toggle("folded", !!FOLDED[sec]);
                    th.innerHTML = '<span class="arr">' + (FOLDED[sec] ? "&#9656;" : "&#9662;") + '</span>' + Fmt.esc(sec);
                    return;
                }
                if (sec && FOLDED[sec]) { tr.hidden = true; }
            });
        });
    }

    // A play just logged (an ADD): every number that changed glows for a moment (not on a tab switch, a
    // fold, an undo / edit, another game or viewing back).
    var LAST = { key: "", ops: -1, vals: {} };
    function changes() {
        var vals = {}, g = typeof App !== "undefined" ? App.game : null, key = (g ? (g.id || g.fixture) : "") + ":" + statTab,
            ops = g ? g.ops.length : 0, lastOp = g && g.ops.length ? g.ops[g.ops.length - 1] : null,
            mark = key === LAST.key && LAST.ops >= 0 && ops > LAST.ops && !!lastOp && lastOp.kind === "ADD" && !(App.isViewing && App.isViewing());
        Array.prototype.forEach.call($("boxBody").querySelectorAll("table.box"), function (t, ti) {
            var head = t.querySelector("thead th") ? t.querySelector("thead th").textContent : String(ti);
            Array.prototype.forEach.call(t.querySelectorAll("tr"), function (tr, ri) {
                var cells = tr.children, i, k;
                if (tr.classList.contains("sec") || tr.classList.contains("cmp") || cells.length < 2 || cells[0].tagName !== "TD") { return; }
                for (i = 1; i < cells.length; i++) {
                    k = head + "|" + (t.classList.contains("pbox") ? "" : ri) + "|" + cells[0].textContent + "|" + i;   // labels repeat (Rushing, Avg to go)
                    vals[k] = cells[i].textContent;
                    if (mark && LAST.vals[k] !== undefined && LAST.vals[k] !== vals[k]) { cells[i].classList.add("chg"); }
                    else if (mark && LAST.vals[k] === undefined && ti > 0) { cells[i].classList.add("chg"); }   // a new player line
                }
            });
        });
        LAST = { key: key, ops: ops, vals: vals };
    }

    // PLAYERS level: passing / rushing / receiving lines per team, most yards first.
    function playerBox(res, sides) {
        var out = [], cats = [
            ["passing", "Passing", "C-ATT", function (l) { return l.comp + "-" + l.att; }, ["yds", "td", "ints", "long"], ["YDS", "TD", "INT", "LONG"]],
            ["rushing", "Rushing", "CAR", function (l) { return l.att; }, ["yds", "td", "long"], ["YDS", "TD", "LONG"]],
            ["receiving", "Receiving", "REC", function (l) { return l.rec; }, ["yds", "td", "long"], ["YDS", "TD", "LONG"]]
        ];
        (sides || SIDES).forEach(function (side) {
            var P = res.players[side], ns = Object.keys(P);
            if (!ns.length) { return; }
            out.push('<h4 class="pbh ' + side.toLowerCase() + '">' + Fmt.esc(teamName(side, res.codes)) + '</h4>');
            cats.forEach(function (c) {
                var rows = ns.filter(function (n) { return P[n][c[0]].att || P[n][c[0]].rec; })
                    .sort(function (a, b) { return P[b][c[0]].yds - P[a][c[0]].yds; });
                if (!rows.length) { return; }
                out.push('<table class="box pbox"><thead><tr><th>' + c[1] + '</th><th>' + c[2] + '</th>' + c[5].map(function (h) { return '<th>' + h + '</th>'; }).join("") + '</tr></thead><tbody>' +
                    rows.map(function (n) {
                        var l = P[n][c[0]];
                        return '<tr><td>' + Fmt.esc(typeof Players !== "undefined" ? Players.name(side, n) : "#" + n) + '</td><td>' + c[3](l) + '</td>' +
                            c[4].map(function (k) { return '<td>' + (l[k] === null ? "-" : l[k]) + '</td>'; }).join("") + '</tr>';
                    }).join("") + '</tbody></table>');
            });
        });
        return out.join("");
    }

    function lists(res, ui, events) {
        $("foldAll").hidden = ui.tab !== "plays";
        $("foldAll").textContent = anyOpen(res) ? "COLLAPSE ALL" : "EXPAND ALL";
        var html, tabs = $("listTabs").querySelectorAll("button"), i, body = $("listBody");
        for (i = 0; i < tabs.length; i++) { tabs[i].classList.toggle("on", tabs[i].getAttribute("data-v") === ui.tab); }
        tabs = $("driveTeam").querySelectorAll("button");
        for (i = 0; i < tabs.length; i++) { tabs[i].classList.toggle("on", tabs[i].getAttribute("data-v") === ui.driveTeam); }
        $("driveTeam").hidden = ui.tab !== "drives";
        $("playFilter").hidden = ui.tab !== "plays" || ui.drive === null;
        $("playFilter").textContent = ui.drive === null ? "" : "Drive " + ui.drive + " ×";
        if (ui.tab === "drives") { html = drives(res, ui); }
        else if (ui.tab === "log") { html = log(res, events); }
        else if (ui.tab === "stats") { html = box(res); }
        else { html = plays(res, ui); }
        if (body.getAttribute("data-tab") !== ui.tab) { body.scrollTop = 0; body.setAttribute("data-tab", ui.tab); }
        body.innerHTML = html;
    }

    // --------------------------------------------------------------- warnings

    function warnings(res) {
        var bad = [], i, w, box = $("warn");
        for (i = 0; i < res.warnings.length; i++) {
            w = res.warnings[i];
            if (w.code === "INVALID") { bad.push(w); }
        }
        box.hidden = !bad.length;
        if (!bad.length) { box.open = false; return; }
        box.querySelector("summary").textContent = bad.length + " skipped";
        box.querySelector("ul").innerHTML = bad.map(function (x) {
            return "<li><code>" + Fmt.esc(x.eventId) + "</code> " + Fmt.esc(x.text) + "</li>";
        }).join("");
    }

    // The field is drawn by the field card (center.js).
    function render(res, ui, fieldSit, events) {
        strip(res);
        if (ui.tab === "stats") { ui.tab = "plays"; }          // the box score has its own column now
        lists(res, ui, events || []);
        statCol(res);
        warnings(res);
    }

    return { init: init, render: render, foldDrive: foldDrive, teamName: teamName, fieldRef: function () { return field; } };
})();
