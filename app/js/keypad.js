/*
 * stats/app/js/keypad.js - the on-screen keypad, so the app never needs the
 * iPad's keyboard or a real one (a real keyboard still works while it is open).
 *
 *   Keypad.open({ title, mode: "clock" | "number" | "text", value, max, live(v), done(v) })
 *     clock   a number pad; the digits read as m:ss (921 = 9:21, 1200 = 12:00)
 *     number  a number pad (max digits, 3 by default)
 *     text    a QWERTY with a number row, SPACE, DEL
 *   live(v) is called on every key, done(v) on OK (CANCEL calls nothing). The value it opens with
 *   shows until the first digit / letter, which starts a new one (DEL edits it instead).
 *
 * Every <input data-kp="clock | number | text"> opens it when tapped (instead
 * of taking focus, so no keyboard pops up) and gets its value back, with an
 * input event like typing would give. It is its own dialog, so it opens on
 * top of a huddle.
 */
var Keypad = (function () {

    var $ = function (id) { return document.getElementById(id); };
    var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
    var st = null;

    function clockText(d) {
        var c;
        if (!d) { return ""; }
        c = Fmt.normClock(d);
        return c && StatsEngine.parseClock(c) !== null ? c : d;
    }
    function value() { return st.o.mode === "clock" ? clockText(st.v) : st.v; }

    function draw() {
        var o = st.o, h, shown = value(), rows = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
        h = '<div class="kphead"><b>' + esc(o.title || "") + '</b></div>' +
            '<div class="kpshow' + (o.mode === "text" ? ' text' : '') + '">' + (shown ? esc(shown) : '<span class="ph">' + (o.mode === "clock" ? 'm:ss' : (o.mode === "number" ? '#' : 'type')) + '</span>') + '</div>';
        if (o.mode === "clock" && st.v && clockText(st.v) === st.v && st.v.length > 2) { h += '<div class="kpwarn">not a time yet</div>'; }
        if (o.mode === "text") {
            h += '<div class="kprow" style="grid-template-columns:repeat(10,minmax(0,1fr))">' + "1234567890".split("").map(function (c) { return '<button data-k="' + c + '">' + c + '</button>'; }).join("") + '</div>';
            rows.forEach(function (r, i) {
                h += '<div class="kprow" style="grid-template-columns:repeat(' + (i === 2 ? 10 : r.length) + ',minmax(0,1fr))">' +
                    r.split("").map(function (c) { return '<button data-k="' + c + '">' + c + '</button>'; }).join("") +
                    (i === 2 ? '<button data-k="DEL" style="grid-column:span 3">DEL</button>' : '') + '</div>';
            });
            h += '<div class="kprow" style="grid-template-columns:1fr 3fr 1fr 1.4fr"><button data-k="CANCEL">CANCEL</button><button data-k=" ">SPACE</button><button data-k="CLEAR">CLEAR</button><button class="ok" data-k="OK">OK</button></div>';
        } else {
            h += '<div class="kprow num">' + ["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLEAR", "0", "DEL"].map(function (k) {
                return '<button data-k="' + k + '">' + (k === "DEL" ? "&#9003;" : k) + '</button>'; }).join("") + '</div>' +
                '<div class="kprow" style="grid-template-columns:1fr 2fr"><button data-k="CANCEL">CANCEL</button><button class="ok" data-k="OK">OK</button></div>';
        }
        // CLEAR takes two taps: armed, it says AGAIN (red)
        if (st.arm) { h = h.split('data-k="CLEAR">CLEAR<').join('data-k="CLEAR" class="arm">AGAIN<'); }
        $("kpBody").innerHTML = h;
    }

    function key(k) {
        var o = st.o, max = o.mode === "clock" ? 4 : (o.mode === "number" ? (o.max || 3) : (o.max || 40)), v;
        if (k === "OK") {
            v = value();
            if (o.mode === "clock" && v && StatsEngine.parseClock(v) === null) { $("kpBody").querySelector(".kpshow").classList.add("bad"); return; }
            close(); if (o.done) { o.done(v); } return;
        }
        if (k === "CANCEL") { close(); if (o.cancel) { o.cancel(); } return; }
        // the value it opened with shows until the first new digit / letter, which starts over
        if (k === "CLEAR" && !st.arm) { st.arm = true; draw(); return; }
        if (k !== "CLEAR") { st.arm = false; }
        if (st.fresh && k !== "DEL" && k !== "CLEAR") { st.v = ""; }
        st.fresh = false;
        if (k === "CLEAR") { st.v = ""; st.arm = false; }
        else if (k === "DEL") { st.v = st.v.slice(0, -1); }
        else if (o.mode === "text") { if (st.v.length < max) { st.v += k; } }
        else if (/^\d$/.test(k) && st.v.length < max) { st.v += k; }
        if (o.live) { o.live(value()); }
        draw();
    }

    function open(o) {
        var v = String(o.value == null ? "" : o.value);
        st = { o: o, v: o.mode === "text" ? v : v.replace(/\D/g, ""), fresh: !!v };
        draw();
        if (!$("kpad").open) { $("kpad").showModal(); }
    }
    function close() { st = null; if ($("kpad").open) { $("kpad").close(); } }

    // an <input data-kp="..."> (its label's text is the title)
    function forInput(inp) {
        var lab = inp.closest("label"), t = inp.getAttribute("aria-label") || (lab && lab.querySelector("span") ? lab.querySelector("span").textContent : "") || inp.placeholder || "";
        function put(v) { inp.value = v; inp.dispatchEvent(new Event("input", { bubbles: true })); }
        open({ title: t, mode: inp.getAttribute("data-kp"), value: inp.value, max: +inp.getAttribute("maxlength") || 0, live: put, done: put,
            cancel: (function (before) { return function () { put(before); }; })(inp.value) });
    }

    function init() {
        $("kpBody").addEventListener("click", function (e) { var b = e.target.closest("[data-k]"); if (b && st) { key(b.getAttribute("data-k")); } });
        $("kpad").addEventListener("cancel", function (e) { e.preventDefault(); key("CANCEL"); });   // Esc
        document.addEventListener("keydown", function (e) {
            if (!st || e.ctrlKey || e.metaKey || e.altKey) { return; }
            e.stopPropagation();                                   // the keypad has the keys while it is open
            if (e.key === "Enter") { e.preventDefault(); key("OK"); }
            else if (e.key === "Backspace") { e.preventDefault(); key("DEL"); }
            else if (/^\d$/.test(e.key)) { e.preventDefault(); key(e.key); }
            else if (st.o.mode === "text" && /^[a-zA-Z ]$/.test(e.key)) { e.preventDefault(); key(e.key === " " ? " " : e.key.toUpperCase()); }
        }, true);
        // tapping a keypad field opens the keypad instead of focusing it (no iPad keyboard)
        document.addEventListener("pointerdown", function (e) {
            var inp = e.target.closest && e.target.closest("input[data-kp]");
            if (!inp) { return; }
            e.preventDefault();
            inp.blur();
            forInput(inp);
        }, true);
    }

    return { init: init, open: open, close: close, forInput: forInput, get isOpen() { return !!st; } };
})();
