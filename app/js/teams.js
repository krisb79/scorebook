/*
 * stats/app/js/teams.js - the app's own team list: each team's players with
 * bio and season stats, and the sport profile that says which fields and stat
 * groups there are (sports/football.json).
 *
 *   - The laptop stand-in keeps the master copy (data/stats_teams/<CODE>.json).
 *     A team it doesn't have yet comes in from PLAYBOOK's team file, season
 *     stats included; from then on edits go to the app's copy only.
 *   - Every team is also kept on this device, so the PLAYERS tab and the
 *     player picker work with no network. An edit made offline is kept
 *     ("dirty") and sent when the stand-in answers again. The newer copy wins.
 *   - A team nobody has (no app copy, no PLAYBOOK file) starts empty; add its
 *     players on the PLAYERS tab.
 *
 * Teams.get(code) answers at once from memory / the device (null = not known
 * yet) and asks the stand-in in the background; Teams.on(fn) hears about
 * every change (fn(code)).
 */
var Teams = (function () {

    var T = {}, asked = {}, NOTE = {}, SPORT = null, sportAsked = false, fns = [];

    function store(k, v) {
        try {
            if (v === undefined) { return JSON.parse(localStorage.getItem(k) || "null"); }
            if (v === null) { localStorage.removeItem(k); } else { localStorage.setItem(k, JSON.stringify(v)); }
        } catch (e) { return null; }
        return null;
    }
    function fire(code) { fns.forEach(function (fn) { try { fn(code); } catch (e) { /* a listener's problem */ } }); }
    function key(code) { return "statsapp.team." + code; }
    function set(code, t) { T[code] = t; store(key(code), t); fire(code); }

    function get(code) {
        if (!code) { return null; }
        if (T[code] === undefined) { T[code] = store(key(code)); }
        ask(code);
        return T[code];
    }

    function ask(code) {
        if (asked[code] || typeof fetch === "undefined") { return; }
        asked[code] = true;
        fetch("../team?code=" + encodeURIComponent(code), { cache: "no-store" })
            .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
            .then(function (x) {
                var have = T[code], t;
                if (x.status === 404) {                         // nobody has this team: start an empty one
                    NOTE[code] = "No team file for " + code + " - add its players on the PLAYERS tab.";
                    if (!have) { set(code, { code: code, name: code, players: [], source: "NEW", updated: 0 }); }
                    else if (have.dirty) { push(code); }
                    return;
                }
                if (!x.j || !x.j.ok) { throw new Error((x.j && x.j.error) || "bad answer"); }
                t = x.j.team;
                NOTE[code] = "";
                if (have && have.dirty && (have.updated || 0) > (t.updated || 0)) { push(code); return; }   // ours is newer
                if (!have || JSON.stringify(stripLocal(have)) !== JSON.stringify(stripLocal(t))) { set(code, t); }
            })
            .catch(function () {
                setTimeout(function () { asked[code] = false; }, 20000);   // ask again later
                // no laptop (the online copy, or the stand-in is off): a sample roster that ships with the online
                // copy (made-up players, teams/<CODE>.json), else a team list on this device only, so the PLAYERS
                // tab still works; the laptop's copy replaces it later unless it was edited here
                return sample(code).then(function (t) {
                    var have = T[code];
                    if (t && (!have || (!have.dirty && (!have.players.length || have.sample)))) { set(code, t); }
                    if (!T[code]) { T[code] = { code: code, name: code, players: [], source: "DEVICE", updated: 0 }; store(key(code), T[code]); }
                    NOTE[code] = T[code].sample ? "Sample roster (made-up players) - edit it on the PLAYERS tab, or the roster comes from the Google Sheet." :
                        "No laptop stand-in - the team list is kept on this device" +
                        (T[code].players.length ? "." : "; add players on the PLAYERS tab, or the roster comes from the Google Sheet.");
                    fire(code);
                });
            });
    }
    var sampled = {};
    function sample(code) {
        if (sampled[code]) { return Promise.resolve(null); }
        sampled[code] = true;
        return fetch("../teams/" + encodeURIComponent(code) + ".json", { cache: "no-cache" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (t) { return t && t.players && t.players.length ? t : null; })
            .catch(function () { return null; });
    }
    function stripLocal(t) { var o = {}, k; for (k in t) { if (t.hasOwnProperty(k) && k !== "dirty") { o[k] = t[k]; } } return o; }

    // Save a changed team: on this device at once, then to the stand-in.
    function save(code, t) {
        t.code = code;
        t.updated = Date.now();
        t.dirty = true;
        set(code, t);
        return push(code);
    }
    function push(code) {
        var t = T[code];
        if (!t || typeof fetch === "undefined") { return Promise.resolve(false); }
        return fetch("../team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ team: stripLocal(t) }) })
            .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
            .then(function (x) {
                if (x.status === 409 && x.j.team) { set(code, x.j.team); NOTE[code] = "The laptop had a newer copy of " + code + " - it was kept."; return false; }
                if (!x.j.ok) { throw new Error(x.j.error); }
                if (T[code] === t) { t.dirty = false; store(key(code), t); }
                NOTE[code] = "";
                fire(code);
                return true;
            })
            .catch(function (e) {
                NOTE[code] = "Saved on this device; the laptop stand-in didn't answer (" + (e && e.message ? e.message : e) + "). It is sent when it does.";
                fire(code);
                return false;
            });
    }
    // Edits made offline: send them when the stand-in is back.
    setInterval(function () { var c; for (c in T) { if (T.hasOwnProperty(c) && T[c] && T[c].dirty) { push(c); } } }, 30000);

    // ------------------------------------------------------------ sport profile

    function sport() {
        if (!SPORT) { SPORT = store("statsapp.sport"); }
        if (!sportAsked && typeof fetch !== "undefined") {
            sportAsked = true;
            fetch("../sport?id=football", { cache: "no-store" })
                .then(function (r) { return r.json(); })
                .then(function (j) { if (j && j.ok && j.sport) { SPORT = j.sport; store("statsapp.sport", SPORT); fire(""); } })
                .catch(function () { sportAsked = false; });
        }
        return SPORT;
    }
    // The season stat groups with a filter (PASSING / RUSHING / RECEIVING for football).
    function filters() {
        var sp = sport(), out = [];
        ((sp && sp.stats && sp.stats.season) || []).forEach(function (g) { if (g.filter) { out.push(g); } });
        return out;
    }

    return {
        get: get, save: save, sport: sport, filters: filters,
        reload: function (code) { asked[code] = false; ask(code); },
        note: function (code) { return NOTE[code] || ""; },
        on: function (fn) { fns.push(fn); }
    };
})();
