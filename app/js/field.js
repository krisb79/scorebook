/*
 * stats/app/js/field.js - the field (the field card's yard bar, ported from
 * GRIDIRON). Plain DOM: end zones, yard lines, the blue line of scrimmage, the
 * yellow line to gain, the arrow showing which way the offense goes, and the
 * white marker for a pending spot (ghost). Spots are absolute 0-100 from the
 * AWAY goal line; AWAY goes left to right until setFlip(ref, true) turns the
 * picture round (HOME left to right). Only the picture turns: spots, stats and
 * the log don't change.
 *
 * Zoom (the ZOOM button on the field card, setZoom(level)): 0 = the whole
 * field, 1 = 50 yards, 2 = 25 yards, with the line of scrimmage in the middle
 * (between drives: the next drive's start), held inside the goal lines.
 * The field's 0-100 sits between 6% and 94% of the width; the end zones are
 * the 6% at each end (a drag into one = the goal line).
 */
var Field = (function () {

    var EZ = 6, IW = 88;            // end zone width, playing field width (% of the field)
    var flipped = false;            // one field per page
    var zoom = 0;                   // 0 whole field, 1 = 50 yards, 2 = 25 yards (the ZOOM button)
    var SPAN = [100, 50, 25];

    function div(cls, parent) {
        var e = document.createElement("div");
        e.className = cls;
        if (parent) { parent.appendChild(e); }
        return e;
    }

    function create(el) {
        var ref = { el: el, view: { lo: 0, hi: 100 }, gridKey: "" };
        el.innerHTML = "";
        ref.ezL = div("ez l", el);
        ref.ezR = div("ez r", el);
        ref.grid = div("grid", el);
        ref.ltg = div("mk ltg", el);
        ref.los = div("mk los", el);
        ref.dir = div("dir", el);
        ref.ghost = div("mark", el);
        div("bar", ref.ghost);
        ref.ghostTag = div("tag", ref.ghost);
        ref.rz = div("rz", el);
        ref.rz.textContent = "";
        ref.ghost.style.display = "none";
        return ref;
    }

    // Absolute spot -> % from the left edge of the field.
    function pct(ref, spot) {
        var v = ref.view, p = EZ + (spot - v.lo) / (v.hi - v.lo) * IW;
        return flipped ? 100 - p : p;
    }
    function rel(side, s) { return side === "AWAY" ? s : 100 - s; }

    // Like a real field: a line every 5 yards (numbered, the 10s bigger, in the
    // middle of the field) and a hash mark on every other yard (both sidelines
    // and the two inbound rows).
    function drawGrid(ref) {
        var v = ref.view, key = v.lo + ":" + v.hi + ":" + flipped, y, n, h = "";
        if (key === ref.gridKey) { return; }
        ref.gridKey = key;
        for (y = Math.ceil(v.lo); y < 100; y++) {
            if (y <= v.lo || y >= v.hi) { continue; }
            if (y % 5 === 0) {
                n = y <= 50 ? y : 100 - y;
                h += '<div class="gl' + (y % 10 === 0 ? ' ten' : ' five') + '" style="left:' + pct(ref, y).toFixed(2) + '%">' +
                    '<span>' + n + '</span></div>';
            } else {
                h += '<div class="hm" style="left:' + pct(ref, y).toFixed(2) + '%"></div>';
            }
        }
        ref.grid.innerHTML = h;
    }

    // sit = Result.situation, codes = Result.codes. arrow (optional) =
    // { side, at }: between drives the arrow sits on the next drive's start.
    // keepView: don't re-zoom (a line being dragged across the 30).
    function update(ref, sit, codes, arrow, keepView) {
        var off = sit.offense, spot = sit.spot, live = !!off && spot !== null && sit.phase !== "FINAL";
        var scrim = live && sit.phase === "SCRIMMAGE", ltgOn = scrim && sit.lineToGain !== null && !sit.goal;
        var v = { lo: 0, hi: 100 }, left, right, aSide, aAt, goingLeft, mid, span;

        if (keepView) { v = ref.view; }
        else if (zoom) {
            mid = spot !== null && spot !== undefined ? spot : (arrow ? arrow.at : 50);
            span = SPAN[zoom];
            v.lo = Math.max(0, Math.min(100 - span, Math.round(mid - span / 2)));
            v.hi = v.lo + span;
        }
        ref.view = v;
        drawGrid(ref);

        // end zones: left = spot 0 (AWAY) unless flipped; a zoomed end shows where the view starts
        left = flipped ? "hi" : "lo";
        right = flipped ? "lo" : "hi";
        paintEz(ref.ezL, v, left, codes, false);
        paintEz(ref.ezR, v, right, codes, true);
        ref.rz.style.display = zoom ? "" : "none";
        ref.rz.textContent = zoom ? SPAN[zoom] + " YARDS" : "";
        ref.rz.classList.toggle("left", (off === "HOME") !== flipped);

        ref.el.classList.toggle("has-away", live && off === "AWAY");
        ref.el.classList.toggle("has-home", live && off === "HOME");

        ref.los.style.display = live ? "" : "none";
        if (live) { ref.los.style.left = pct(ref, spot) + "%"; }
        ref.ltg.style.display = ltgOn ? "" : "none";
        if (ltgOn) { ref.ltg.style.left = pct(ref, sit.lineToGain) + "%"; }

        aSide = arrow ? arrow.side : (live ? off : null);
        aAt = arrow ? arrow.at : spot;
        ref.dir.style.display = aSide && aAt !== null ? "" : "none";
        if (aSide && aAt !== null) {
            goingLeft = (aSide === "HOME") !== flipped;
            ref.dir.className = "dir " + aSide.toLowerCase() + (goingLeft ? " left" : "");
            ref.dir.style.left = "calc(" + pct(ref, aAt) + "% " + (goingLeft ? "- 58px" : "+ 6px") + ")";
        }
    }

    function paintEz(el, v, end, codes, isRight) {
        var atGoal = end === "lo" ? v.lo === 0 : v.hi === 100, side = end === "lo" ? "AWAY" : "HOME", cut = end === "lo" ? v.lo : v.hi;
        el.className = "ez " + (isRight ? "r" : "l") + (atGoal ? " " + side.toLowerCase() : " cut");
        el.textContent = atGoal ? codes[side] : (isRight ? Fmt.spot(cut, codes) + " >" : "< " + Fmt.spot(cut, codes));
    }

    // The pending spot (null hides it) with a short tag such as "+7" or "TD".
    function ghost(ref, spot, tag) {
        var p;
        if (spot === null || spot === undefined) { ref.ghost.style.display = "none"; return; }
        p = pct(ref, Math.max(ref.view.lo, Math.min(ref.view.hi, spot)));
        ref.ghost.style.display = "";
        ref.ghost.style.left = p + "%";
        ref.ghost.classList.toggle("right", p > 72);
        ref.ghostTag.textContent = tag || "";
        ref.ghostTag.style.display = tag ? "" : "none";
    }

    // Screen x -> absolute spot 0-100 (not rounded, so the caller can snap).
    function spotAt(ref, clientX) {
        var r = ref.el.getBoundingClientRect(), p = (clientX - r.left) / r.width * 100, v = ref.view, s;
        if (flipped) { p = 100 - p; }
        s = v.lo + (p - EZ) / IW * (v.hi - v.lo);
        return s < 0 ? 0 : (s > 100 ? 100 : s);
    }
    // Absolute spot -> screen x (for grabbing the lines).
    function clientX(ref, spot) {
        var r = ref.el.getBoundingClientRect();
        return r.left + pct(ref, spot) / 100 * r.width;
    }

    function setFlip(ref, on) { flipped = !!on; ref.gridKey = ""; }

    // The magnifier above the finger: label on top, a zoomed strip of field,
    // the blue line of scrimmage (los, optional) and the spot in white.
    function loupe(ref, x, c, label, los) {
        var L = document.getElementById("loupe"), r = ref.el.getBoundingClientRect();
        var cv = L.querySelector("canvas"), g = cv.getContext("2d"), W = cv.width, H = cv.height, span = 7;
        var d = flipped ? -1 : 1, yd, px, five;
        L.hidden = false;
        L.style.left = Math.max(4, Math.min(window.innerWidth - 204, x - 100)) + "px";
        L.style.top = Math.max(30, r.top - 96) + "px";
        L.querySelector("div").textContent = label;
        g.fillStyle = "#1d5a2c"; g.fillRect(0, 0, W, H);
        for (yd = Math.floor(c - span); yd <= Math.ceil(c + span); yd++) {
            if (yd < 0 || yd > 100) { continue; }
            px = W / 2 + d * (yd - c) * (W / (span * 2));
            five = yd % 5 === 0;
            g.fillStyle = five ? "rgba(255,255,255,.8)" : "rgba(255,255,255,.35)";
            g.fillRect(px - (five ? 2 : 1), five ? 0 : H * 0.3, five ? 4 : 2, five ? H : H * 0.4);
            if (yd % 10 === 0 && yd > 0 && yd < 100) {
                g.fillStyle = "#fff"; g.font = "bold 26px sans-serif"; g.textAlign = "center";
                g.fillText(String(yd <= 50 ? yd : 100 - yd), px, H - 10);
            }
        }
        if (los !== null && los !== undefined) { g.fillStyle = "#4ea1ff"; g.fillRect(W / 2 + d * (los - c) * (W / (span * 2)) - 3, 0, 6, H); }
        g.fillStyle = "#fff"; g.fillRect(W / 2 - 4, 0, 8, H);
    }
    function hideLoupe() { document.getElementById("loupe").hidden = true; }

    return {
        setZoom: function (level) { zoom = Math.max(0, Math.min(2, +level || 0)); },
        get zoom() { return zoom; },
        create: create, update: update, ghost: ghost, spotAt: spotAt, clientX: clientX, setFlip: setFlip,
        loupe: loupe, hideLoupe: hideLoupe, get flipped() { return flipped; } };
})();
