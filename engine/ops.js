/*
 * stats/engine/ops.js - op log -> effective event list.
 *
 * A game is setup + an ordered list of ops. Ops never change once written;
 * undo is a new op. Kinds:
 *   ADD     { eventId, event, after? }  add an event (at the end, or right
 *                                        after event `after`; after:"" = first)
 *   EDIT    { eventId, event }          replace the event's payload in place
 *   VOID    { eventId }                 remove the event
 *   RESTORE { eventId }                 undo a VOID
 * Ops are applied in seq order (ties keep file order). A repeated opId is
 * ignored, so re-sending an op is harmless.
 *
 * ES5 only, no JSON, no DOM, no timers: runs in Chrome and DashBoard Rhino.
 * One global: StatsOps.
 */
var StatsOps = (function () {

    function copyEvent(ev, id) {
        var out = {}, k;
        for (k in ev) {
            if (ev.hasOwnProperty(k)) { out[k] = ev[k]; }
        }
        out.id = id;
        return out;
    }

    // Stable sort by seq (Array.sort is not guaranteed stable in Rhino).
    function sortedOps(ops) {
        var list = [], i, j, cur;
        for (i = 0; i < ops.length; i++) {
            list.push({ op: ops[i], i: i, seq: typeof ops[i].seq === "number" ? ops[i].seq : i });
        }
        for (i = 1; i < list.length; i++) {
            cur = list[i];
            j = i - 1;
            while (j >= 0 && (list[j].seq > cur.seq || (list[j].seq === cur.seq && list[j].i > cur.i))) {
                list[j + 1] = list[j];
                j--;
            }
            list[j + 1] = cur;
        }
        return list;
    }

    // Apply ops (already sorted) to an index. Returns { order, byId, warnings }.
    function build(sorted, stopAt) {
        var order = [], byId = {}, seen = {}, warnings = [];
        var n, op, id, rec, pos, k;
        for (n = 0; n < sorted.length; n++) {
            if (stopAt !== undefined && n >= stopAt) { break; }
            op = sorted[n].op;
            if (op.opId !== undefined && op.opId !== null) {
                if (seen[op.opId]) { continue; }
                seen[op.opId] = true;
            }
            id = op.eventId;
            rec = byId.hasOwnProperty(id) ? byId[id] : null;
            if (op.kind === "ADD") {
                if (rec) { warnings.push({ opId: op.opId, text: "ADD of existing event " + id + " ignored" }); continue; }
                if (!op.event) { warnings.push({ opId: op.opId, text: "ADD without event ignored" }); continue; }
                rec = { event: copyEvent(op.event, id), voided: false };
                byId[id] = rec;
                if (op.after === undefined || op.after === null) {
                    order.push(id);
                } else if (op.after === "") {
                    order.unshift(id);
                } else {
                    pos = -1;
                    for (k = 0; k < order.length; k++) {
                        if (order[k] === op.after) { pos = k; break; }
                    }
                    if (pos < 0) {
                        warnings.push({ opId: op.opId, text: "ADD after unknown event " + op.after + ": appended" });
                        order.push(id);
                    } else {
                        order.splice(pos + 1, 0, id);
                    }
                }
            } else if (op.kind === "EDIT") {
                if (!rec) { warnings.push({ opId: op.opId, text: "EDIT of unknown event " + id + " ignored" }); continue; }
                rec.event = copyEvent(op.event, id);
            } else if (op.kind === "VOID") {
                if (!rec) { warnings.push({ opId: op.opId, text: "VOID of unknown event " + id + " ignored" }); continue; }
                rec.voided = true;
            } else if (op.kind === "RESTORE") {
                if (!rec) { warnings.push({ opId: op.opId, text: "RESTORE of unknown event " + id + " ignored" }); continue; }
                rec.voided = false;
            } else {
                warnings.push({ opId: op.opId, text: "unknown op kind " + op.kind + " ignored" });
            }
        }
        return { order: order, byId: byId, warnings: warnings };
    }

    function resolve(ops) {
        var idx = build(sortedOps(ops || [])), events = [], i, rec, maxSeq = 0;
        for (i = 0; i < idx.order.length; i++) {
            rec = idx.byId[idx.order[i]];
            if (!rec.voided) { events.push(rec.event); }
        }
        for (i = 0; ops && i < ops.length; i++) {
            if (typeof ops[i].seq === "number" && ops[i].seq > maxSeq) { maxSeq = ops[i].seq; }
        }
        return { events: events, warnings: idx.warnings, seq: maxSeq };
    }

    function effective(ops) {
        return resolve(ops).events;
    }

    // The op that undoes `op` (without opId / seq; the caller assigns those).
    function inverse(ops, op) {
        var sorted = sortedOps(ops), n, idx, rec;
        if (op.kind === "ADD") { return { kind: "VOID", eventId: op.eventId }; }
        if (op.kind === "VOID") { return { kind: "RESTORE", eventId: op.eventId }; }
        if (op.kind === "RESTORE") { return { kind: "VOID", eventId: op.eventId }; }
        if (op.kind === "EDIT") {
            for (n = 0; n < sorted.length; n++) {
                if (sorted[n].op === op || (op.opId !== undefined && sorted[n].op.opId === op.opId)) { break; }
            }
            idx = build(sorted, n);
            rec = idx.byId.hasOwnProperty(op.eventId) ? idx.byId[op.eventId] : null;
            if (!rec) { return null; }
            return { kind: "EDIT", eventId: op.eventId, event: rec.event };
        }
        return null;
    }

    return { resolve: resolve, effective: effective, inverse: inverse, VERSION: "0.1.0" };
})();
