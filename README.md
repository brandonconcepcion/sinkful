# Sinkful

A to-do list you wash. Every task is a dish in the sink.

- **Dish = task size**: fork 2 min · glass 10 min · mug 15 min · plate 30 min · bowl 1 hr · pan 2 hr · pot half a day
- **Grime = urgency**: rinse (whenever) · crusty (soon) · burnt-on (overdue)
- **Pick any dish** from the pile (or the side list) to lift it up and look at it. Click again (anywhere) to set it down. Drag to turn it.
- **Finish the real task, then press "✓ Done, wash it"** (or Enter, or the ✓ in the side list). The dish washes itself: a rubber glove and an Infinity Gauntlet (the scrubbing hand, all six stones) fly in, soap gets squirted onto the sponge, the grime is scrubbed off into lather, it's rinsed under the faucet, shaken dry, and a thumbs-up sends it to the drying rack.
- **Soak long-running work.** Pick up a dish and hit **🫧 Soak** (or `S`) to drop it into the soaking tub (6 spots; add or remove entries in `SPOTS` in `main.js` to change it): it sits in soapy water with bubbles rising, and the bottom panel shows how long it's been soaking. Click it later to finish it (**✓ Done**) or **take it out** (back to the sink). The longer it soaks, the more its grime loosens (fully after ~4 hours), and soaked dishes wash faster.
- **Drag dishes between the sink and the tub.** Drop one in the tub to soak it (it takes the free spot nearest where you let go), drop a soaking dish in the sink to take it out, or drag within the sink to rearrange. A label by the cursor says what the drop will do; anywhere else, the dish slides back.
- **Shortcut buttons follow the held dish:** ✓ Done · 🫧 Soak · ↓ Set down.
- **Play with the counter.** Click anything on the counter (toaster, pepper mill, soap, plants, lemon...) to pick it up, drag to turn it, click it again for a little surprise (toast pops, pepper grinds, soap squirts bubbles), and click away or press `Esc` to put it back. Props always return to their spot and aren't saved. Clicking a letter of the **Sinkful** sign makes it hop.
- **Each dish gets its own scrub:** pots and pans get a long-handled brush (back-and-forth strokes), glasses and mugs get the sponge stuffed in and twisted, plates and bowls get sponge circles.
- **Sink's empty finale:** washing the last dish in the sink fills it with soapy water, a glove pulls the plug, and it all swirls down the drain.
- **Sound** (🔊 top-left to mute): running water, squeaks, brush scratch, soap squirt, rack clinks, tub plop, drain gurgle. All synthesized in `sfx.js`, no audio files.
- The background blurs (depth of field) while a dish is being washed.
- **Edit a task** with the ✎ Edit button on a held dish (or `E`), or the pencil next to it in the list: change its title, notes, size or urgency. A new size or urgency rebuilds the 3D dish to match. Undoable.
- **Bulk actions** in each panel header: sink **wash all** / **clear**, tub **wash all** / **take out**, rack **put away**, plus the trash button top-left to clear everything (sink and tub emptied, rack put away). Every bulk action shows an **Undo** toast for 7 seconds.
- **Halloween mode** (pumpkin button, top-left): a dusky purple kitchen with bats on the wall, cobwebs, a dangling spider, flickering candles, string lights under the sign, a couple more pumpkins and a bowl of candy you can pick up (click it again and candy hops out). It's on by default from mid-October through Halloween; each device remembers your choice. The jack-o'-lantern on the counter stays year-round (click it twice for a boo).
- **Put away** clears the rack. Tasks are saved in `localStorage`.

## Run

```sh
python3 server.py          # http://localhost:5173
```

`server.py` (no dependencies) serves the site **and saves your data**:

- `data/sinkful.json`: the full current state (sink, tub, rack, every completed task with timestamps). Rewritten automatically on every change and loaded on startup, so progress survives across browsers and sessions.
- `data/history.jsonl`: append-only activity log, one JSON line per event (`added`, `soaked`, `taken-out`, `washed`, `removed`, `put-away`, `undo`).

- `data/backups/`: a snapshot of `sinkful.json` before it's overwritten (at most one every 5 minutes, newest 100 kept). To roll back, stop the server and copy one over `data/sinkful.json`.

Nothing is ever overwritten wholesale: every task carries an `updatedAt`, deletions leave tombstones, and the browser's copy, the file, and any other open tabs are merged task by task (newest wins). A save from a tab that's behind gets rejected by the server, merged, and retried.

A small note appears top-left only when saving to the file isn't working (browser-only or server unreachable). Under any other static server (e.g. `python3 -m http.server`) the app still works but saves only in the browser.
Use a separate data folder with `python3 server.py 5175 --data /tmp/sinkful-test`.

Static site with no build step. Three.js loads from jsDelivr.
Reset data in the console: `sinkful.reset()`.
Watch a wash on load: `#wash` or `#wash-pot`. Slow motion: `sinkful.speed(0.25)`. Preview the finale: `sinkful.finale()`. Fast-forward soaking: `sinkful.ageSoak(4)`. Pick up a prop: `sinkful.hold('toaster')`. Performance: `sinkful.perf()` (draw calls, frame and hit-test cost), `sinkful.meshBreakdown()`.

Rendering is on demand: nothing redraws while the scene is still, ambient tub motion redraws at 30 fps without redoing the shadow map, and static scenery, tub suds and each dish's grime are merged or instanced to keep draw calls low (~185 per frame with a full sink).

## Hosted copy (GitHub Pages)

Live at [brandonconcepcion.com/sinkful](https://brandonconcepcion.com/sinkful), behind a password. Pages has no server, so:

- `vault.json` holds a GitHub token and a Gist id, AES-GCM encrypted with a key derived from the password (PBKDF2, 600k rounds). `vault.js` shows the lock screen and decrypts it in the browser; "Remember this device" keeps the unlocked token in localStorage.
- The sink is saved to `sinkful.json` in that secret Gist, with the same merge rules as `server.py`. Every save is a Gist revision, so the Gist's history is the backup.
- To set up or change the password: `node tools/make-vault.mjs` (or `--gist <id>` to keep the existing Gist), then commit `vault.json`. Use a fine-grained token with only **Gists: Read and write**.

The lock keeps the site to yourself, but it isn't server-side auth: the code is public and `vault.json` can be guessed at offline, so use a long password. Revoking the token cuts off every device at once.

The localhost copy (`server.py`, `data/`) is separate from the hosted one.

### Calendar dishes

`tools/calendar-dishes.gs` is a Google Apps Script that adds today's calendar events to the Gist as dishes, every hour from 7am to 5pm. Only timed events you accepted or created count. The dish size follows the meeting length, from a glass for 10 minutes to a pot for 3+ hours. Each event gets one dish per day, keyed on the event id + date, so reruns, washing or deleting it never bring it back. Unwashed calendar dishes pile up like any other. Setup steps are at the top of the file.

The **wall calendar** next to the sign shows today's date. Clicking it syncs right away: it opens the script's web app in a small popup, waits for the sync to be recorded in the Gist's `calendar.json`, pulls in the new dishes, and closes the popup. The first click asks for the web app URL and saves it to the Gist for every device. On localhost the calendar is decoration only.

## Credits

3D models: [Kenney Food Kit](https://kenney.nl/assets/food-kit) and [Furniture Kit](https://kenney.nl/assets/furniture-kit) (both CC0), see `models/KENNEY-LICENSE.txt` and `models/decor/KENNEY-FURNITURE-LICENSE.txt`.
