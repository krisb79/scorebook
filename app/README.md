# Stats logging app (STATS_APP_PLAN.md step 2)

Plain web page, no framework, no build step. Everything on screen is
`StatsEngine.replayOps(setup, ops)`; the page keeps only the game (setup + ops).

| File | What |
|---|---|
| `index.html` | the page: strip, center column (field card, drive card, drive chart), entry, plays / drives / log, game bar, huddle, toast |
| `app.css` | styles (tablet landscape first; light/dark follow the device) |
| `js/store.js` | the device copy of every game in IndexedDB: games, ops (one record per op), the outbox, the current game |
| `js/sync.js` | sends the outbox to the sync server, the SYNCED / n PENDING chip |
| `sw.js` | service worker: keeps the app on the device so it opens with no network |
| `../server/standin.py` | stand-in sync server (Python, standard library): serves `stats/`, appends ops to `data/games/*.jsonl` |
| `js/format.js` | display helpers (spot "PEL 35", down & distance, drive result) |
| `js/field.js` | the field (GRIDIRON's yard bar): end zones, yard lines, blue / yellow lines, direction arrow, red zone zoom, the white marker, the magnifier |
| `js/center.js` | the center column ported from GRIDIRON: field card + play buttons, FG / Penalty / D&D huddles, drive card, drive chart |
| `js/players.js` | the PLAYERS card: the Logger's 5 x 4 jersey slots (one grid, not by position), the player picker, QUICK PLAYS; rosters from the stand-in |
| `js/keypad.js` | the on-screen keypad (clock m:ss, number, text QWERTY): every time / number / text field opens it, so the iPad keyboard (or a real one) is never needed |
| `js/teams.js` | the app's own team list (players, bio, season stats) + the sport profile; on this device and on the stand-in (`data/stats_teams/<CODE>.json`) |
| `players.html` | the PLAYERS tab (GRIDIRON's PLAYERS page in an iframe): number grid, search, PASSING / RUSHING / RECEIVING filters, add / edit / delete, bio + season stats |
| `js/view.js` | renders a Result onto the page |
| `js/entry.js` | play entry: type, result, options, the dragged spot -> one validated event (LOG / SAVE / ADD) |
| `js/huddles.js` | GAME huddle (period, timeouts, score fix, clock, new game) and the event huddle (edit / add missed play / delete) |
| `js/app.js` | owns the game: commit / commitBatch (store first, then apply), undo, toast, saved / test games, import / export, op scrubber, timing HUD |

## Online (GitHub Pages)

`python stats/tools/publish_pages.py` publishes just the app (app, engine, practice games, the football profile) to
the public repo krisb79/scorebook, hosted at https://krisb79.github.io/scorebook/app/ . It runs with no laptop: plays
go to the Google Sheet (the `?sync=` link), rosters come from the sheet or are added on the PLAYERS tab (kept on that
device). Run the script again after a change to update it.

## Open it

- **With syncing (normal):** from the repo root run `python stats/server/standin.py`, then open
  `http://localhost:5216/stats/app/` on the laptop. It prints the address for the tablet on the LAN
  (`http://<laptop IP>:5216/stats/app/`).
- Without syncing: double-click `index.html`, or `python -m http.server 8765` from the repo root and open
  `http://localhost:8765/stats/app/`. The sync chip then says NO SYNC; everything else works.

The game menu lists every fixture in `stats/test/fixtures_bundle.js` (rebuilt by
`stats/test/run_rhino.js`). **Open file** reads a fixture `.json` or a game `.jsonl`
(line 1 = setup, then one op per line). The slider replays the game up to any op;
logging is off while you look at an earlier point (tap **Go live**).

## Logging (slice 2)

- **Possession**: AWAY / OFF / HOME at the top of the entry panel (each tap is a POSSESSION event).
- **Play**: pick a type, a result, then press or drag on the field to set where the ball ended (the
  dashed ball; the ◀ / ▶ buttons move it one yard left / right on screen). Faster, and the way the
  PLAYBOOK logger worked with players: **drag the play button itself onto the field** and let go on the yard
  line. A copy of the button follows the finger with a dashed line back to it (an arc for a pass), the
  magnifier above the field shows the yard line and the gain, and the spot snaps onto the line to gain, the
  goal line, the 50 or no gain from close by. A dragged Pass counts as Complete; a Pass let go off the
  field is Incomplete. A plain tap still just picks the play; LOG logs. Dragging into the end zone is a TD or a safety.
  The optional clock box stamps the game clock after the play (`721` = 7:21). **LOG** stays grey with
  the reason until the engine accepts the play.
- **Penalty**: on offense / defense, 5 / 10 / 15 (half the distance near the goal), auto 1st down,
  loss of down, declined. **Set spot**: drag the ball, pick the down and the distance (or goal to go).
- **UNDO** (and the toast's UNDO) writes the opposite op. A turnover on downs shows a red toast.
- Tap any play or log row: **Edit** (the field shows the moment before that play; SAVE writes an
  EDIT op), **Add missed play after**, or **Delete**. Later plays re-derive at once.
- **GAME**: period, timeouts (use / fix), score fix, a clock stamp, new game.
- **FLIP** (field card) shows the field the other way round (HOME on the left), for example to match the camera
  or after the teams change ends. Only the picture turns: spots, stats and the log don't change. The
  choice is remembered on the device.

## Center column (from GRIDIRON)

The middle of GRIDIRON (statsapp/Gridiron.html) without the scoring drive huddle and without graphics:
three cards on the left, the entry panel and the lists on the right. Every tap is an engine event,
validated and committed like any other op (UNDO on the toast; the toast now sits at the bottom).
Drives come from the engine: possession owns the drive, so a punt, turnover, score or 4th down
short ends the drive by itself and the engine opens the other team's.

- **Field card**: preview line (tap it = D&D huddle) + FLIP, the field (blue line of scrimmage,
  yellow line to gain, arrow = the way the offense goes, red zone zoom inside the 30), -1 / spot / +1
  (drag the middle to scrub), the **play buttons** and a clock box (optional, stamped on the next play).
  Drag a play button onto the field: **letting go logs it**. PASS / RUSH = where the play ended (end
  zone = TD, own end zone = safety); INCOMPLETE = anywhere; INTERCEPTION / FUMBLE = where the other
  team takes over (the offense's own end zone = their TD, the far one = touchback); PUNT = where the
  receiving team takes over (their end zone = touchback); FG / OFF PEN / DEF PEN = the Field Goal /
  Penalty huddle. A tap on PASS / RUSH / INT / FUMBLE / PUNT logs to the spot set on the field (drag the
  field or -1 / +1 first). Letting go off the field logs nothing.
- **Penalty huddle**: spot foul / dead ball (offense) or from the line (defense), 5 / 10 / 15 / other,
  loss of down / automatic 1st down, NOW -> NEXT preview, half the distance near the goal. A spot foul
  replays the down of the play it happened on to the old line to gain (penalty + SPOT, one UNDO).
- **Move the lines**: drag the blue or yellow line, or tap the preview line: the D&D huddle (down,
  to go, goal to go, ball on). SAVE = a SPOT event. The D&D can always be changed.
- **Drive card**: the open drive (STARTED / SO FAR / LAST; tap it = **Edit drive**: start spot + start
  time, the plays keep their yards and move with it), **HOLD: END DRIVE** (possession change with an
  end time, end of half, end of game; punts / FGs point to their buttons), DELETE while a drive has no
  plays. After a touchdown: **TRY** (PAT / 2PT good / no good). Between drives: **NEXT DRIVE** (team,
  start spot = drag the field or TOUCHBACK / OUT OF BOUNDS, start time, START = the kickoff).
- **No orphan drives**: giving the ball to the other team (AWAY / HOME in the entry panel) while a
  drive is open opens the Possession Change huddle: close it (one tap), set how it ended, delete it
  (no plays), or cancel.
- **Errors**: a locked play button (no drive, a try pending, ball OFF, viewing history, an edit open)
  shakes with a red edge and the toast says why.
- **Drive chart**: the open drive (between drives the last one), one row per play, same direction as
  the field. Tap a play to fold it and the ones before into one row; tap that row to open it again.
- The entry panel stays for kickoffs, tries, sacks, set spot, edits and missed plays; while it is
  typing a play, drags on the field set its spot.

## LOG tab layout

The strip: ZOOM next to the quarter, FLIP next to the menu button; tap the down & distance to change it (the D&D
huddle); while a play is being dragged its second line shows what will be logged. Row 1, the field card: the play
buttons in one row (drag one onto the field below; PASS
/ RUSH log a play with no players), the field, -1 / scrub / +1. Row 2: the PLAYERS slots (ARRANGE: rows, columns, drag
to reorder), the drive card, the drive chart (it folds its oldest plays into one row by itself so it fits without scrolling; COLLAPSE
folds every play but the last, OPEN ALL opens them (then it scrolls); tapping a play folds it and the ones before) | the drive log (Plays / Drives / Log; on Plays a drive's header folds / opens its plays, COLLAPSE ALL /
EXPAND ALL on top) | the team stats, always showing: VS (both teams side by side) or one team (its stats + its player
lines), picked with the VS / team code buttons on top; tap a section heading (Downs, Offense ...) to fold it; the
numbers a new play changed glow for a few seconds. Row 2 widths: 38.25% | 40% | 21.75%. A play that
earns something gets a green toast: 1ST DOWN, 3RD / 4TH DOWN CONVERTED, 15+ ... 50+ YARD PLAY. The **menu** (the
strip's menu button) has LOG | PLAYERS, PLAYER TRACKING (off = team stats only: no jersey cards, no player tags on the drive log, no player lines in Stats), THEME (auto / light / dark), GAME and the older entry panel (MORE: possession, sack, set spot, a missed play; it opens by
itself for an edit). Times go on through the drive start / end pickers (there is no clock box on the plays).

## Field zoom and drive times

**ZOOM** (next to FLIP): each tap = the next level: whole field -> 50 yards -> 25 yards -> whole field, with the line
of scrimmage in the middle (kept on this device).

Drive times work like GRIDIRON: when a play ends a drive (touchdown, punt, turnover, downs, field goal) the
**drive ended** huddle asks for the **END TIME** and shows the drive time as you set it; SAVE puts the time on that
play (NO TIME skips it). The next drive starts at that time. HOLD: END DRIVE (possession change) asks the same, and
NEXT DRIVE has the START TIME. Times use GRIDIRON's picker: tap it and type (921 = 9:21), or drag left / right to nudge
it a second at a time. The clock box next to the plays still stamps a time on the next play.

## Players (the Logger's flow)

The PLAYERS card (top right) shows the jersey slots of the team with the ball, 5 rows of 4, one grid per team, not
split by position. The slots are kept on this device per team code.

- **The player picker** has two tabs (the last one used comes back): **LIST** (search box, ALL / PASSING / RUSHING /
  RECEIVING, the roster) and **KEYPAD** (the Logger's: NAME + #, a number pad; tap the name for an on-screen QWERTY,
  the matching players show as you type, OK takes the top one; a real keyboard works too).
- **Set a slot:** tap an empty slot, or hold any slot until it glows amber. Type a jersey number or part of a name;
  tap a player or press Enter for the top match. **Empty this slot** clears it. A player sits in one slot only.
- **Run:** drag a player onto the field and let go at the spot.
- **Pass:** drag the QB onto the receiver (green arc), then on to the catch spot on the field. Let go on the receiver
  instead = incomplete to him.
- Letting go logs it at once, like the play buttons (UNDO on the toast). A tap on a player only says how.
- **Onto INCOMPLETE** (the play button): an incomplete pass by that player (to the receiver the drag went through).
- **Through FUMBLE (or INTERCEPTION), then the field:** a lost fumble (or an interception) at the spot where you let go;
  a run, or a pass when the drag went through a receiver.
- **Assign later:** every run in the drive log has an **RB** slot, every pass **QB > REC** (dashed while empty). Drag a
  player onto a slot to put them there, or onto the row for the next empty one (a drag through a receiver sets QB and
  REC). It is an edit of that play (UNDO on the toast). Only plays of the team the PLAYERS card shows.
  Or **tap the slot**: the player picker for that play's team opens with its filter on (QB = PASSING, REC =
  RECEIVING, RB = RUSHING): pick a player, or CLEAR. Works for either team's plays.
- The plays list shows the names, and **Stats** adds passing / rushing / receiving lines per player.

Rosters: when the app syncs to the Google Sheet, from its **Away Roster** / **Home Roster** tabs (by side, and only when the sheet's team name on Bound Import matches the game's team; edit there,
then reload the app). Otherwise, or when a tab is empty, the stand-in reads PLAYBOOK's team library
(`data/teams/<CODE>.xml`, `GET /stats/roster?code=PEL`). The app keeps the last copy for offline. Without a roster the slots show numbers only. The play buttons (PASS, RUSH ...)
still log without a player.

## Tabs and the team list

**LOG | PLAYERS** are in the menu (the strip's menu button). The page itself never scrolls (the game bar stays at the
bottom); the drive log, the jersey cards and the menu scroll inside. PLAYERS is GRIDIRON's PLAYERS page for this game's two teams: tap a player or a
number to edit, an empty number to add, SAVE / CANCEL / ACTIVE / DELETE (tap twice), season stats under the bio.

The app keeps its **own team list**. The first time a team is needed, the stand-in brings it in from PLAYBOOK's team
file (`data/teams/<CODE>.xml`: bios and season stats); from then on edits go to the app's copy only
(`data/stats_teams/<CODE>.json` in the Playbook folder, plus a copy on each device). An edit made with the stand-in
away is kept on the device and sent when it answers; the newer copy wins. PLAYBOOK's files are never changed.
A team with no file starts empty: add its players on the PLAYERS tab.

The player picker on the LOG tab has **ALL / PASSING / RUSHING / RECEIVING**: only players with season (or
tonight's) stats in that group, most yards first, with the numbers next to the name.

## Saving (slice 3)

- Every op is written to the device (IndexedDB) **before** it is applied and drawn. A reload or a
  crash reopens the last game exactly as it was. The chip in the game bar says **SAVED** (hover: the
  write time), **SAVING**, **TEST GAME** or, in red, **NOT SAVED** (storage is blocked or a write
  failed: the play is still logged on screen, so export the game to keep it).
- The game menu lists **Saved games** (newest first) and the read-only **Test games**. Logging a play
  on a test game first saves a copy named "Practice: <test game>" and carries on in that copy.
- **Export** downloads `<date>_<AWAY>_at_<HOME>.jsonl`: line 1 is the header
  `{schema, app, engine, id, name, setup}`, then one op per line, oldest first.
- **Open file** reads a `.jsonl` (or a fixture `.json`) as a new saved game. A cut-off last line is skipped.
- GAME huddle, "This game": new game, export, delete the saved game (asks first).

## Team stats (slice 4)

The **Stats** tab shows both teams side by side, straight from the engine's `Result.team`: score,
first downs (rush / pass / penalty), 3rd and 4th down (conversions and average to go), total yards,
plays and yards per play, rushing, passing (comp-att-int, average), sacks, rush / pass play calls,
turnovers (INT, fumbles lost, downs), punts, FG, PAT, 2PT, penalties, drives, possession time and
timeouts. Key lines have an AWAY / HOME bar. It follows the slider, so it shows the stats at any op.

## Sync and offline (slice 5)

- Every op also goes into an **outbox** on the device, in the same write as the op. `js/sync.js` sends
  the outbox to the server in the background (`POST /stats/op`, up to 200 ops per batch) and removes
  an op only when the server lists it as acknowledged. If the link is down it retries after 1 s,
  doubling up to 30 s, and at once when the browser comes back online. Logging never waits for it.
- The chip next to SAVED: **SYNCED**, **n PENDING** (yellow), **OFFLINE · n PENDING** (red; hover for the
  reason) or **NO SYNC** (opened from a file, or a server without the sync route).
- Ops carry their opId, so sending one twice is harmless: the server writes it once.
- The stand-in keeps the master copy in `data/games/<gameId>.jsonl` (same format as Export) and
  answers `GET /stats/ops?game=ID&since=N` and `GET /stats/v?game=ID` for readers later. Only the
  `stats/` folder is served; the rest of the repo (PLAYBOOK.grid, data/) is not reachable.
- The service worker keeps the app on the device ("offline ready" next to the version), so a reload
  works with no server. It asks the network first and falls back to the copy after 2.5 s, so an
  updated app is picked up whenever the server answers.
- **Browser rule:** service workers only run on `https://` or `localhost`. On the tablet over a plain
  `http://192.168...` LAN address the version line says "no offline copy (needs https)". Logging,
  saving and the outbox still work there; only a *reload* with the laptop unreachable fails. Fixing
  that needs https on the laptop (a certificate the tablet trusts) or the Electron app later.

## Slices

1. Strip + field + drive list + play list from a replay. **Done.**
2. Play entry (every input is a validated op), undo / edit / delete. **Done.**
3. IndexedDB persistence, export / import `.jsonl`. **Done.**
4. Team box score. **Done.**
5. Offline (service worker) + outbox with a SYNCED / n PENDING chip. **Done** (against the stand-in).
6. GRIDIRON's center column (field card, drive card, drive chart) on the engine. **Done.**
