// Sinkful calendar dishes: a Google Apps Script that turns today's calendar events into dishes.
// Runs every hour from 7am to 5pm. Each event you accepted (or created yourself) is added once
// to the sink in your Gist; reruns, washed dishes and deleted dishes never bring it back.
//
// Setup (once), at https://script.google.com:
//   1. New project, paste this file in, save.
//   2. Project Settings > Script Properties: add GIST_ID and GIST_TOKEN (a token with the gist scope).
//   3. Pick `setup` in the function dropdown and Run; allow the permissions it asks for.
// After that it runs on its own. Run `syncCalendarDishes` any time to sync right now.

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

function syncCalendarDishes() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return; // a run is already going
  try {
    const props = PropertiesService.getScriptProperties();
    const gist = { id: props.getProperty('GIST_ID'), token: props.getProperty('GIST_TOKEN') };
    if (!gist.id || !gist.token) throw new Error('Set GIST_ID and GIST_TOKEN in Script Properties');
    const events = todaysEvents(new Date());
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = readGist(gist);
      const changed = addCalendarDishes(state, events, Date.now());
      if (!changed) return;
      // Gists have no compare-and-swap: write only if nobody saved while we were working.
      if ((readGist(gist).rev || 0) !== (state.rev || 0)) continue;
      writeGist(gist, state);
      console.log(`Sink updated: ${changed} dish(es)`);
      return;
    }
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
  const file = JSON.parse(res.getContentText()).files['sinkful.json'];
  if (!file) return { tasks: [], deleted: {}, rev: 0 };
  return JSON.parse(file.truncated ? UrlFetchApp.fetch(file.raw_url).getContentText() : file.content);
}

function writeGist({ id, token }, state) {
  const content = JSON.stringify({ tasks: state.tasks, deleted: state.deleted, rev: (state.rev || 0) + 1, savedAt: new Date().toISOString() });
  const res = UrlFetchApp.fetch(`https://api.github.com/gists/${id}`, {
    method: 'patch', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ files: { 'sinkful.json': { content } } }),
  });
  if (res.getResponseCode() !== 200) throw new Error(`Saving the Gist failed: ${res.getResponseCode()} ${res.getContentText()}`);
}
