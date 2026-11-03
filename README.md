# Sinkful

A to-do list you wash. Every task is a dish in the sink.

- **Dish = task size**: fork 2 min · glass 10 min · mug 15 min · plate 30 min · bowl 1 hr · pan 2 hr · pot half a day
- **Grime = urgency**: rinse (whenever) · crusty (soon) · burnt-on (overdue)
- **Pick any dish** from the pile (or the side list) to lift it up and look at it. Click again (anywhere) to set it down. Drag to turn it.
- **Finish the real task, then press "✓ Done, wash it"** (or Enter, or the ✓ in the side list). The dish washes itself: a rubber glove and an Infinity Gauntlet (the scrubbing hand, all six stones) fly in, soap gets squirted onto the sponge, the grime is scrubbed off into lather, it's rinsed under the faucet, shaken dry, and a thumbs-up sends it to the drying rack.
- **Daily non-negotiables** (`DAILIES` in `main.js`): every day the sink gets one dish for each, in order (Read the Bible, Take Supplements, Brush Teeth, Exercise, ...). Washing or tossing one is final for the day. At midnight (or the next time you open the site) yesterday's unwashed ones are cleared away and today's go in, so they never pile up. Washed ones stay on the rack like any other dish.
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
- **Holiday themes** (button top-left, only shown while a holiday is in season): each device remembers if you switch one off for the season. Out of season a theme is archived: its code stays, but it doesn't show until next year. Preview any of them in the console with `sinkful.theme('halloween')`, `sinkful.theme('thanksgiving')` or `sinkful.theme()` for the regular kitchen.
  - **Thanksgiving** (Nov 1 through the Sunday after Thanksgiving, leaf button): an olive wall and butcher-block counter, a roast turkey (click it twice: gobble gobble and steam), a pumpkin pie (whipped cream), harvest pumpkins, a leaf wreath, a leaf garland under the sign, "GIVE THANKS" bunting and leaves drifting down.
  - **Halloween** (Oct 15 to 31, archived): a dusky purple kitchen with bats, cobwebs, a dangling spider, flickering candles, string lights, pumpkins, a jack-o'-lantern (click it twice for a boo) and a candy bowl.
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

### Notion goals

The same script can also sync a Notion goals database with the sink, both ways, every 10 minutes: **Not started** goals are dishes in the sink, **In Progress** goals soak in the tub, and **Done** goals are washed. Soak a goal's dish and Notion says In Progress; wash it and it says Done; take it out of the tub and it's back to Not started. Change a goal's status in Notion and the dish moves to match (if both changed, the newer change wins). Goals already Done when first seen are left out, tossing a goal's dish leaves Notion alone, and when the tub's six spots are full an In Progress goal waits in the sink until one frees up. A blank status counts as Not started, if the database has no such option.

Edit a goal's dish (**Edit**, or `E`) to change its name, notes (the database's text column), category or week, and the change goes to Notion; edits made in Notion come back the same way. Tick **Add it to my Notion goals** when adding a dish to make it a new goal: the next sync creates its Notion page. Changing a goal's week moves it to the cabinet if that isn't this week. The integration needs the Read, Update and Insert content capabilities. Set `NOTION_TOKEN` and `NOTION_DATABASE` in the script's properties, then run `setup` again.

The **goals cabinet** (glass-front, on the left of the wall) keeps the sink to this week's goals: a goal dish whose Week isn't the current one waits in the cabinet, shown as plates on its shelves. Week 1 began Monday, Sept 28, 2026 (`GOAL_WEEK_ONE` in `main.js`), so the label on top always says the current week. Click the cabinet to open its doors and a list grouped by week; **take out** a goal (or a whole week) to put it in the sink, or pick a goal dish up and choose **Back in the cabinet**. Soaking (In Progress) and washed goals are never in the cabinet, and taking one out or putting it back doesn't change Notion. When a new week starts, its goals come out and last week's untouched ones go in.

The **wall calendar** next to the sign shows today's date. Clicking it syncs right away (calendar and goals): it opens the script's web app in a small popup, waits for the sync to be recorded in the Gist's `calendar.json`, pulls in the new dishes, and closes the popup. The first click asks for the web app URL and saves it to the Gist for every device. On localhost the calendar is decoration only.

## Credits

3D models: [Kenney Food Kit](https://kenney.nl/assets/food-kit) and [Furniture Kit](https://kenney.nl/assets/furniture-kit) (both CC0), see `models/KENNEY-LICENSE.txt` and `models/decor/KENNEY-FURNITURE-LICENSE.txt`.
