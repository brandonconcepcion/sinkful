// Sinkful calendar dishes: a Google Apps Script that turns today's calendar events into dishes.
// Runs every hour from 7am to 5pm. Each event you accepted (or created yourself) is added once
// to the sink in your Gist; reruns, washed dishes and deleted dishes never bring it back.
//
// Setup (once), at https://script.google.com:
//   1. New project, paste this file in, save.
//   2. Project Settings > Script Properties: add GIST_ID and GIST_TOKEN (a token with the gist scope).
//   3. Pick `setup` in the function dropdown and Run; allow the permissions it asks for.
//   4. For the sync button on the site: Deploy > New deployment > type "Web app",
//      Execute as "Me", Who has access "Only myself" > Deploy. Copy the Web app URL (ends in
//      /exec) and paste it when the site asks, the first time you click the wall calendar.
// After that it runs on its own. Run `syncCalendarDishes` any time to sync right now.
// After pasting a new version of this file: Deploy > Manage deployments > edit (pencil) >
// Version "New version" > Deploy, so the web app picks it up too.

const FIRST_HOUR = 7;  // 7am
const LAST_HOUR = 17;  // 5pm
const GRIME = 2;       // 1 rinse, 2 crusty, 3 burnt-on

// Dish size from meeting length (the same scale as the site: fork 2 min ... pot half a day).
function dishFor(minutes) {
  if (minutes <= 10) return 'glass';
  if (minutes <= 15) return 'mug';
  if (minutes <= 30) return 'plate';
  if (minutes <= 60) return 'bowl';
  if (minutes <= 120) return 'pan';
  return 'pot';
}

function setup() {
  for (const t of ScriptApp.getProjectTriggers()) ScriptApp.deleteTrigger(t);
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    ScriptApp.newTrigger('syncCalendarDishes').timeBased().atHour(h).nearMinute(0).everyDays(1).create();
  }
  syncCalendarDishes();
}

// The sync button on the site opens this (as a web app only you can reach).
function doGet() {
  let message;
  try {
    const r = syncCalendarDishes();
    message = r.busy ? 'A sync is already running. The site will pick up its dishes.'
      : `${r.events} accepted event(s) today, ${r.added} new dish(es) added.`;
  } catch (err) {
    message = `Sync failed: ${err.message}`;
  }
  return HtmlService.createHtmlOutput(
    `<div style="font:16px system-ui;padding:28px;text-align:center;color:#1f2a2e">` +
    `<h2 style="color:#2f8f7a;margin:0 0 10px">Sinkful</h2><p>${message}</p>` +
    `<p style="color:#5d6b70;font-size:13px">This window closes by itself; if not, close it.</p></div>`,
  ).setTitle('Sinkful calendar sync');
}

// Returns { events, added }, or { busy: true } if another run holds the lock.
function syncCalendarDishes() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return { busy: true };
  try {
    const props = PropertiesService.getScriptProperties();
    const gist = { id: props.getProperty('GIST_ID'), token: props.getProperty('GIST_TOKEN') };
    if (!gist.id || !gist.token) throw new Error('Set GIST_ID and GIST_TOKEN in Script Properties');
    const events = todaysEvents(new Date());
    console.log(`${events.length} accepted/own event(s) today: ${events.map((e) => e.title).join(', ') || 'none'}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { state, calendar } = readGist(gist);
      const added = addCalendarDishes(state, events, Date.now());
      // Gists have no compare-and-swap: write only if nobody saved while we were working.
      if (added && (readGist(gist).state.rev || 0) !== (state.rev || 0)) continue;
      // calendar.json tells the site when the last sync ran (and keeps the URL it saved there).
      const files = { 'calendar.json': { ...calendar, lastSync: new Date().toISOString(), added, events: events.length } };
      if (added) files['sinkful.json'] = { ...state, rev: (state.rev || 0) + 1, savedAt: new Date().toISOString() };
      writeGist(gist, files);
      console.log(`Sink updated: ${added} dish(es)`);
      return { events: events.length, added };
    }
    throw new Error('The sink kept changing while syncing; try again in a moment');
  } finally {
    lock.releaseLock();
  }
}

// Today's timed events you said yes to, or that you own.
function todaysEvents(now) {
  const tz = Session.getScriptTimeZone();
  const day = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const keep = [CalendarApp.GuestStatus.YES, CalendarApp.GuestStatus.OWNER];
  return CalendarApp.getDefaultCalendar().getEventsForDay(now)
    .filter((e) => !e.isAllDayEvent() && keep.includes(e.getMyStatus()) && isRegular(e))
    .map((e) => ({
      key: `${e.getId()}|${day}`, // recurring meetings share an id, so the day is part of the key
      title: `${e.getTitle().trim() || 'Untitled event'} · ${Utilities.formatDate(e.getStartTime(), tz, 'h:mma').toLowerCase()}`,
      minutes: (e.getEndTime() - e.getStartTime()) / 60000,
    }));
}
// Skip out-of-office, focus time and working-location blocks.
function isRegular(e) {
  try { return e.getEventType() === CalendarApp.EventType.DEFAULT; } catch (err) { return true; }
}

// Adds a dish per event not already in the sink (present, washed, or deleted), and renames
// unwashed ones whose event moved or was renamed. Returns how many dishes changed.
function addCalendarDishes(state, events, now) {
  state.tasks = state.tasks || [];
  state.deleted = state.deleted || {};
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  let changed = 0;
  events.forEach((ev, i) => {
    const id = dishId(ev.key);
    const existing = byId.get(id);
    if (existing) {
      if (!existing.doneAt && existing.title !== ev.title) {
        existing.title = ev.title;
        existing.updatedAt = now;
        changed++;
      }
      return;
    }
    if (state.deleted[id]) return; // you tossed it: leave it gone
    state.tasks.push({
      id, title: ev.title, type: dishFor(ev.minutes), grime: GRIME, notes: 'From your calendar',
      createdAt: now + i, updatedAt: now + i, doneAt: null, archived: false, source: 'calendar',
    });
    changed++;
  });
  return changed;
}

function dishId(key) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key);
  return 'cal' + bytes.slice(0, 5).map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function readGist({ id, token }) {
  const res = UrlFetchApp.fetch(`https://api.github.com/gists/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error(`Reading the Gist failed: ${res.getResponseCode()} ${res.getContentText()}`);
  const files = JSON.parse(res.getContentText()).files;
  const parse = (file, fallback) => {
    if (!file) return fallback;
    try { return JSON.parse(file.truncated ? UrlFetchApp.fetch(file.raw_url).getContentText() : file.content); } catch (err) { return fallback; }
  };
  return { state: parse(files['sinkful.json'], { tasks: [], deleted: {}, rev: 0 }), calendar: parse(files['calendar.json'], {}) };
}

// files: { name: object } — each is saved as JSON; files not listed are left alone.
function writeGist({ id, token }, files) {
  const payload = { files: {} };
  for (const [name, obj] of Object.entries(files)) payload.files[name] = { content: JSON.stringify(obj, null, name === 'calendar.json' ? 2 : 0) };
  const res = UrlFetchApp.fetch(`https://api.github.com/gists/${id}`, {
    method: 'patch', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify(payload),
  });
  if (res.getResponseCode() !== 200) throw new Error(`Saving the Gist failed: ${res.getResponseCode()} ${res.getContentText()}`);
}
