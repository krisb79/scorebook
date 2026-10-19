/*
 * stats/app/js/store.js - the device copy of every game, in IndexedDB (the
 * browser's own database: survives reloads and crashes, works offline).
 *
 *   games  { id, name, setup, created, source }        key: id
 *   ops    { gameId, ...op }                            key: [gameId, opId]
 *   meta   { key: "current", value: "g:<id>" | "f:<fixture name>" }
 *   outbox { gameId, ...op }                            key: [gameId, opId]
 *          ops not yet acknowledged by the sync server (js/sync.js); an op
 *          goes into ops and outbox in the same transaction.
 *
 * Ops are only ever added (an op never changes once written; undo is a new
 * op), so a put is one small write. A repeated opId overwrites the same
 * record with the same content, so re-sending is harmless.
 * All calls return Promises. Store.ok is false when IndexedDB can't be used
 * (private window, blocked storage): the app keeps working in memory.
 */
var Store = (function () {

    var NAME = "statsapp", VERSION = 2;
    var db = null, state = { ok: false, error: "" };

    function open() {
        return new Promise(function (resolve, reject) {
            var r;
            if (!window.indexedDB) { reject(new Error("This browser has no IndexedDB")); return; }
            try { r = indexedDB.open(NAME, VERSION); } catch (e) { reject(e); return; }
            r.onupgradeneeded = function (e) {
                var d = r.result, ops, ob, cur;
                if (!d.objectStoreNames.contains("games")) { d.createObjectStore("games", { keyPath: "id" }); }
                if (!d.objectStoreNames.contains("ops")) {
                    ops = d.createObjectStore("ops", { keyPath: ["gameId", "opId"] });
                    ops.createIndex("byGame", "gameId");
                }
                if (!d.objectStoreNames.contains("meta")) { d.createObjectStore("meta", { keyPath: "key" }); }
                if (!d.objectStoreNames.contains("outbox")) {
                    ob = d.createObjectStore("outbox", { keyPath: ["gameId", "opId"] });
                    if (e.oldVersion >= 1) {            // games saved before syncing existed: queue them all
                        cur = r.transaction.objectStore("ops").openCursor();
                        cur.onsuccess = function () {
                            var c = cur.result;
                            if (c) { ob.put(c.value); c.continue(); }
                        };
                    }
                }
            };
            r.onsuccess = function () {
                db = r.result;
                db.onversionchange = function () { db.close(); db = null; state.ok = false; state.error = "Database closed by a newer version: reload"; };
                state.ok = true;
                resolve();
            };
            r.onerror = function () { reject(r.error || new Error("IndexedDB open failed")); };
            r.onblocked = function () { reject(new Error("IndexedDB is blocked by another tab")); };
        }).catch(function (e) {
            state.ok = false;
            state.error = e && e.message ? e.message : String(e);
            throw e;
        });
    }

    function need() { if (!db) { throw new Error(state.error || "Storage is not available"); } }

    // Resolves when the transaction is committed.
    function run(stores, fn) {
        return new Promise(function (resolve, reject) {
            var t, out;
            need();
            t = db.transaction(stores, "readwrite");
            t.oncomplete = function () { resolve(out); };
            t.onerror = function () { reject(t.error || new Error("Write failed")); };
            t.onabort = function () { reject(t.error || new Error("Write aborted")); };
            out = fn(t);
        });
    }
    function read(stores, fn) {
        return new Promise(function (resolve, reject) {
            var t, r;
            need();
            t = db.transaction(stores, "readonly");
            r = fn(t);
            r.onsuccess = function () { resolve(r.result); };
            r.onerror = function () { reject(r.error); };
        });
    }

    function record(gameId, op) {
        var rec = { gameId: gameId }, k;
        for (k in op) { if (op.hasOwnProperty(k)) { rec[k] = op[k]; } }
        return rec;
    }
    function strip(rec) {
        var op = {}, k;
        for (k in rec) { if (rec.hasOwnProperty(k) && k !== "gameId") { op[k] = rec[k]; } }
        return op;
    }
    function bySeq(a, b) { return a.seq - b.seq || (a.at || 0) - (b.at || 0); }

    function putOp(gameId, op) {
        return run(["ops", "outbox"], function (t) {
            var rec = record(gameId, op);
            t.objectStore("ops").put(rec);
            t.objectStore("outbox").put(rec);
        });
    }

    // A game and all its ops (new, imported, or a practice copy of a fixture).
    function createGame(meta, ops) {
        return run(["games", "ops", "outbox"], function (t) {
            var os = t.objectStore("ops"), ob = t.objectStore("outbox"), i, rec;
            t.objectStore("games").put(meta);
            for (i = 0; i < ops.length; i++) { rec = record(meta.id, ops[i]); os.put(rec); ob.put(rec); }
        });
    }

    function listGames() {
        return read(["games"], function (t) { return t.objectStore("games").getAll(); }).then(function (list) {
            return list.sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
        });
    }

    function loadGame(id) {
        return read(["games"], function (t) { return t.objectStore("games").get(id); }).then(function (meta) {
            if (!meta) { return null; }
            return read(["ops"], function (t) { return t.objectStore("ops").index("byGame").getAll(id); }).then(function (recs) {
                return { id: meta.id, name: meta.name, setup: meta.setup, created: meta.created, ops: recs.map(strip).sort(bySeq) };
            });
        });
    }

    function deleteGame(id) {
        return run(["games", "ops", "outbox"], function (t) {
            var range = IDBKeyRange.bound([id, ""], [id, "￿"]);
            t.objectStore("games").delete(id);
            t.objectStore("ops").delete(range);
            t.objectStore("outbox").delete(range);
        });
    }

    function getGame(id) {
        return read(["games"], function (t) { return t.objectStore("games").get(id); });
    }

    // ------------------------------------------------------------ outbox

    function outboxCount() {
        return read(["outbox"], function (t) { return t.objectStore("outbox").count(); });
    }
    // Up to `limit` waiting ops, as { gameId: [op, ...] } (each list in seq order).
    function outboxBatch(limit) {
        return read(["outbox"], function (t) { return t.objectStore("outbox").getAll(null, limit); }).then(function (recs) {
            var by = {}, i;
            for (i = 0; i < recs.length; i++) { (by[recs[i].gameId] = by[recs[i].gameId] || []).push(strip(recs[i])); }
            for (i in by) { if (by.hasOwnProperty(i)) { by[i].sort(bySeq); } }
            return by;
        });
    }
    function outboxDone(gameId, opIds) {
        return run(["outbox"], function (t) {
            var ob = t.objectStore("outbox"), i;
            for (i = 0; i < opIds.length; i++) { ob.delete([gameId, opIds[i]]); }
        });
    }

    function setCurrent(v) {
        return run(["meta"], function (t) { t.objectStore("meta").put({ key: "current", value: v }); });
    }
    function getCurrent() {
        return read(["meta"], function (t) { return t.objectStore("meta").get("current"); }).then(function (r) { return r ? r.value : null; });
    }

    return {
        open: open, putOp: putOp, createGame: createGame, listGames: listGames, loadGame: loadGame,
        deleteGame: deleteGame, setCurrent: setCurrent, getCurrent: getCurrent, getGame: getGame,
        outboxCount: outboxCount, outboxBatch: outboxBatch, outboxDone: outboxDone,
        get ok() { return state.ok; }, get error() { return state.error; }
    };
})();
