// Sinkful sync: a Google Apps Script that keeps the sink in your Gist in step with
//  - your calendar: each event you accepted (or created) today becomes a dish, once; reruns,
//    washed dishes and deleted dishes never bring it back. Runs every hour from 7am to 5pm.
//  - your Notion goals database (optional), both ways, every 10 minutes:
//      Notion "Not started"  <->  a dish in the sink
//      Notion "In Progress"  <->  a dish soaking in the tub
//      Notion "Done"         <->  washed
//    Change it on either side and the other follows; the same goes for a goal's name, notes
//    (the text column), category and week. Goals you add in Sinkful become Notion pages.
//    Each goal dish also carries its Week number;
//    the site keeps goals from other weeks in its cabinet until you take them out. A goal that's already Done the first time
//    it's seen is left out; tossing a goal's dish in Sinkful leaves Notion alone.
//
// Setup (once), at https://script.google.com:
//   1. New project, paste this file in, save.
//   2. Project Settings > Script Properties: add GIST_ID and GIST_TOKEN (a token with the gist scope).
//      For goals, also add NOTION_TOKEN (your integration's secret) and NOTION_DATABASE (the
//      goals database's link, or the link of the page it sits on).
//   3. Pick `setup` in the function dropdown and Run; allow the permissions it asks for.
//   4. For the sync button on the site: Deploy > New deployment > type "Web app",
//      Execute as "Me", Who has access "Only myself" > Deploy. Copy the Web app URL (ends in
//      /exec) and paste it when the site asks, the first time you click the wall calendar.
// After that it runs on its own. Run `syncEverything` any time to sync right now.
// After pasting a new version of this file: run `setup` again (it resets the timers), then
// Deploy > Manage deployments > edit (pencil) > Version "New version" > Deploy, so the web app
// picks it up too.

const FIRST_HOUR = 7;  // 7am
const LAST_HOUR = 17;  // 5pm
const GRIME = 2;       // 1 rinse, 2 crusty, 3 burnt-on
const GOAL_GRIME = 1;  // goals are long-running, not urgent
const GOAL_SYNC_MINUTES = 10;
const TUB_SPOTS = 6;   // SPOTS.length in main.js
const NOTION_VERSION = '2022-06-28';
// Dish size for a goal, by its category. Anything else is a pan.
const GOAL_DISH = { Food: 'pan', Hobbies: 'bowl', Media: 'pan', Fitness: 'pot', Spirituality: 'pot' };

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
  if (notionConfigured()) ScriptApp.newTrigger('syncGoals').timeBased().everyMinutes(GOAL_SYNC_MINUTES).create();
  console.log(JSON.stringify(syncEverything()));
}

// The sync button on the site opens this (as a web app only you can reach).
function doGet() {
  let message;
  try {
    const r = syncEverything();
    message = r.busy ? 'A sync is already running. The site will pick up its dishes.'
      : `${r.events} accepted event(s) today, ${r.added} new dish(es) added.` +
        (r.goals ? ` ${r.goals.count} goal(s) checked, ${r.goals.changed} change(s).` : '');
  } catch (err) {
    message = `Sync failed: ${err.message}`;
  }
  return HtmlService.createHtmlOutput(
    `<div style="font:16px system-ui;padding:28px;text-align:center;color:#1f2a2e">` +
    `<h2 style="color:#2f8f7a;margin:0 0 10px">Sinkful</h2><p>${message}</p>` +
    `<p style="color:#5d6b70;font-size:13px">This window closes by itself; if not, close it.</p></div>`,
  ).setTitle('Sinkful sync');
}

function syncCalendarDishes() { return syncSink({ calendar: true }); }
function syncGoals() { return syncSink({ goals: true }); }
function syncEverything() { return syncSink({ calendar: true, goals: notionConfigured() }); }

// Returns { events, added, goals: { count, changed } }, or { busy: true } if another run holds the lock.
function syncSink({ calendar = false, goals = false }) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return { busy: true };
  try {
    const props = PropertiesService.getScriptProperties();
    const gist = { id: props.getProperty('GIST_ID'), token: props.getProperty('GIST_TOKEN') };
    if (!gist.id || !gist.token) throw new Error('Set GIST_ID and GIST_TOKEN in Script Properties');
    const events = calendar ? todaysEvents(new Date()) : null;
    if (events) console.log(`${events.length} accepted/own event(s) today: ${events.map((e) => e.title).join(', ') || 'none'}`);
    const notion = goals ? notionDatabase() : null;
    const pages = notion ? queryGoals(notion) : null;
    if (pages) console.log(`${pages.length} goal(s) in Notion`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { state, calendar: cal } = readGist(gist);
      const added = events ? addCalendarDishes(state, events, Date.now()) : 0;
      const goalSync = pages ? reconcileGoals(state, pages, notion.schema, Date.now()) : { changed: 0, pushes: [], creates: [] };
      const changed = added + goalSync.changed + goalSync.pushes.length + goalSync.creates.length;
      // Gists have no compare-and-swap: write only if nobody saved while we were working.
      if (changed && (readGist(gist).state.rev || 0) !== (state.rev || 0)) continue;
      // Dishes you moved in Sinkful: tell Notion, then remember what it now says.
      // (One goal Notion refuses doesn't block the rest; it's retried next run.)
      for (const p of goalSync.pushes) {
        const what = JSON.stringify(p.fields);
        try {
          updateGoal(notion, p.task.notion.pageId, p.fields);
        } catch (err) {
          console.warn(`Notion: couldn't update "${p.task.title}" ${what}: ${err.message}`);
          continue;
        }
        if ('status' in p.fields) p.task.notion.status = p.fields.status;
        for (const k of GOAL_FIELDS) if (k in p.fields) p.task.notion.fields[k] = p.fields[k];
        console.log(`Notion: "${p.task.title}" ${what}`);
      }
      // Goals you added in Sinkful.
      for (const t of goalSync.creates) {
        const status = notion.schema.names[dishGroup(t)];
        const fields = { status, ...Object.fromEntries(GOAL_FIELDS.map((k) => [k, dishField(t, k)])) };
        let pageId;
        try {
          pageId = createGoal(notion, fields);
        } catch (err) {
          console.warn(`Notion: couldn't add "${t.title}": ${err.message}`);
          continue;
        }
        adoptPage(state, t, pageId, status, Date.now());
        console.log(`Notion: added "${t.title}"`);
      }
      const files = {};
      // calendar.json tells the site when the last calendar sync ran (and keeps the URL it saved there).
      if (events) files['calendar.json'] = { ...cal, lastSync: new Date().toISOString(), added, events: events.length };
      if (changed) files['sinkful.json'] = { ...state, rev: (state.rev || 0) + 1, savedAt: new Date().toISOString() };
      if (Object.keys(files).length) writeGist(gist, files);
      console.log(`Sink updated: ${changed} change(s)`);
      return { events: events ? events.length : 0, added, goals: pages ? { count: pages.length, changed: goalSync.changed + goalSync.pushes.length } : null };
    }
    throw new Error('The sink kept changing while syncing; try again in a moment');
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Notion goals
// ---------------------------------------------------------------------------

function notionConfigured() {
  const props = PropertiesService.getScriptProperties();
  return Boolean(props.getProperty('NOTION_TOKEN') && props.getProperty('NOTION_DATABASE'));
}

function notionFetch(token, path, method = 'get', body) {
  const res = UrlFetchApp.fetch(`https://api.notion.com/v1/${path}`, {
    method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
    payload: body ? JSON.stringify(body) : undefined,
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    const err = new Error(`Notion ${method.toUpperCase()} ${path}: ${code} ${res.getContentText().slice(0, 300)}`);
    err.code = code;
    throw err;
  }
  return JSON.parse(res.getContentText());
}

// Finds the goals database (NOTION_DATABASE can be the database's link or the page it's on) and
// works out which columns hold the name, status, category, week and notes.
function notionDatabase() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('NOTION_TOKEN');
  const raw = props.getProperty('NOTION_DATABASE');
  const hex = (raw.match(/[0-9a-f]{32}/i) || raw.replace(/-/g, '').match(/[0-9a-f]{32}/i) || [])[0];
  if (!hex) throw new Error('NOTION_DATABASE should be the link to your goals database');
  let db;
  try {
    db = notionFetch(token, `databases/${hex}`);
  } catch (err) {
    if (err.code !== 400 && err.code !== 404) throw err;
    // It's the page the database sits on: look for the database inside it.
    const kids = notionFetch(token, `blocks/${hex}/children?page_size=100`).results;
    const child = kids.find((b) => b.type === 'child_database');
    if (!child) throw new Error("Couldn't find the goals database. Is the integration connected to it (••• > Connections)?");
    db = notionFetch(token, `databases/${child.id}`);
  }
  return { token, id: db.id, schema: goalSchema(db.properties) };
}

function goalSchema(properties) {
  const list = Object.entries(properties).map(([name, p]) => ({ name, ...p }));
  const title = list.find((p) => p.type === 'title');
  const status = list.find((p) => p.type === 'status' && /status/i.test(p.name)) || list.find((p) => p.type === 'status')
    || list.find((p) => p.type === 'select' && /status/i.test(p.name));
  if (!title || !status) throw new Error('The goals database needs a Name column and a Status column');
  const selects = list.filter((p) => p.type === 'select' && p !== status);
  const isWeek = (p) => p.select.options.length && p.select.options.every((o) => /^week/i.test(o.name));
  const week = selects.find(isWeek);
  const category = selects.find((p) => /categor|type|area|tag/i.test(p.name) && !isWeek(p)) || selects.find((p) => !isWeek(p));
  const note = list.find((p) => p.type === 'rich_text');

  // Which status option means what. A Notion status column groups its options into
  // To-do / In progress / Complete; a plain select is matched by name.
  const names = {};
  const groupOf = {};
  if (status.type === 'status') {
    const byId = new Map(status.status.options.map((o) => [o.id, o.name]));
    for (const g of status.status.groups) {
      const key = /complete|done/i.test(g.name) ? 'done' : /progress/i.test(g.name) ? 'progress' : 'todo';
      const opts = g.option_ids.map((id) => byId.get(id));
      opts.forEach((n) => { groupOf[n] = key; });
      if (!names[key]) names[key] = opts.find((n) => /^(done|in progress|not started)$/i.test(n)) || opts[0];
    }
  } else {
    for (const o of status.select.options) {
      const key = /done|complete/i.test(o.name) ? 'done' : /progress/i.test(o.name) ? 'progress' : 'todo';
      groupOf[o.name] = key;
      if (!names[key] || /^(done|in progress|not started)$/i.test(o.name)) names[key] = o.name;
    }
  }
  if (!names.done || !names.progress) throw new Error(`Status needs an in-progress and a done option (found: ${Object.keys(groupOf).join(', ')})`);
  // No to-do option: a blank status means not started.
  names.todo = names.todo || null;
  return {
    title: title.name, status: status.name, statusType: status.type, category: category && category.name,
    week: week && week.name, weekOptions: week ? week.select.options.map((o) => o.name) : [], note: note && note.name, names, groupOf,
  };
}

function queryGoals({ token, id }) {
  const pages = [];
  let cursor;
  do {
    const res = notionFetch(token, `databases/${id}/query`, 'post', { page_size: 100, ...(cursor && { start_cursor: cursor }) });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return pages.filter((p) => !p.archived && !p.in_trash);
}

// The Notion property values for a goal's fields; only the ones given (and that the database has).
function goalProperties(schema, fields) {
  const props = {};
  const text = (v) => (v ? [{ text: { content: String(v).slice(0, 2000) } }] : []);
  const option = (name) => (name ? { name } : null); // null clears it (a blank status means not started)
  if ('status' in fields) props[schema.status] = schema.statusType === 'status' ? { status: option(fields.status) } : { select: option(fields.status) };
  if ('title' in fields) props[schema.title] = { title: text(fields.title || 'Untitled goal') };
  if ('note' in fields && schema.note) props[schema.note] = { rich_text: text(fields.note) };
  if ('category' in fields && schema.category) props[schema.category] = { select: option(fields.category) };
  if ('week' in fields && schema.week) {
    const n = fields.week;
    // Reuse the column's own spelling ("Week 7"); a week it doesn't have yet gets added.
    const name = n == null ? null : schema.weekOptions.find((o) => Number((o.match(/\d+/) || [])[0]) === n) || `Week ${n}`;
    props[schema.week] = { select: option(name) };
  }
  return props;
}

function updateGoal({ token, schema }, pageId, fields) {
  notionFetch(token, `pages/${pageId}`, 'patch', { properties: goalProperties(schema, fields) });
}

function createGoal({ token, id, schema }, fields) {
  return notionFetch(token, 'pages', 'post', { parent: { database_id: id }, properties: goalProperties(schema, fields) }).id;
}

const plainText = (rich) => (rich || []).map((r) => r.plain_text).join('').trim();
function readGoal(page, schema) {
  const p = page.properties;
  const status = schema.statusType === 'status' ? p[schema.status].status : p[schema.status].select;
  const pick = (name) => (name && p[name] && p[name].select ? p[name].select.name : '');
  const statusName = status ? status.name : schema.names.todo; // null when blank and there's no to-do option
  const week = (pick(schema.week).match(/\d+/) || [])[0];
  return {
    pageId: page.id,
    status: statusName,
    group: (statusName && schema.groupOf[statusName]) || 'todo',
    // The fields you can edit on either side.
    fields: {
      title: plainText(p[schema.title].title) || 'Untitled goal',
      note: schema.note && p[schema.note] ? plainText(p[schema.note].rich_text) : '',
      category: pick(schema.category),
      week: week ? Number(week) : null, // the site keeps other weeks' goals in its cabinet
    },
  };
}
const GOAL_FIELDS = ['title', 'note', 'category', 'week'];
// A goal dish's copy of a field (the dish keeps the Notion text column as its notes).
const dishField = (t, k) => (k === 'note' ? t.notes || '' : k === 'week' ? t.week ?? null : t[k] || '');
function setDishField(t, k, v) {
  if (k === 'note') t.notes = v;
  else t[k] = v;
}

// Where a dish is: washed, soaking, or in the sink.
const dishGroup = (t) => (t.doneAt ? 'done' : t.soak ? 'progress' : 'todo');
function freeSpot(state) {
  const used = new Set(state.tasks.filter((t) => t.soak && !t.doneAt).map((t) => t.soak.spot));
  for (let i = 0; i < TUB_SPOTS; i++) if (!used.has(i)) return i;
  return -1;
}
function moveDish(state, t, group, now) {
  t.archived = false;
  if (group === 'done') { t.doneAt = t.doneAt || now; t.soak = null; return; }
  t.doneAt = null;
  if (group === 'todo') { t.soak = null; return; }
  if (!t.soak) {
    const spot = freeSpot(state);
    t.soak = spot < 0 ? null : { since: now, spot };
  }
  // Tub full: it waits in the sink (still In Progress in Notion) and goes in when a spot frees up.
  if (t.notion) t.notion.waiting = !t.soak;
}

// Brings goal dishes and Notion into step. Each goal dish remembers what it last agreed with
// Notion: its status (task.notion.status) and its fields (task.notion.fields: name, note, category,
// week). If Notion's value differs from that, Notion changed; if the dish's differs, you changed it in
// Sinkful. If both changed, the newer change wins.
// Goal dishes you add in Sinkful (no pageId yet) become new Notion pages.
// Returns { changed: dishes updated, pushes: [{ task, fields }] to send to Notion, creates: [task] }.
function reconcileGoals(state, pages, schema, now) {
  state.tasks = state.tasks || [];
  state.deleted = state.deleted || {};
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const seen = new Set();
  const pushes = [];
  let changed = 0;
  pages.forEach((page, i) => {
    const g = readGoal(page, schema);
    const id = `notion-${g.pageId.replace(/-/g, '')}`;
    seen.add(id);
    const t = byId.get(id);
    if (!t) {
      if (state.deleted[id] || g.group === 'done') return;
      const f = g.fields;
      const dish = {
        id, title: f.title, type: GOAL_DISH[f.category] || 'pan', grime: GOAL_GRIME, notes: f.note, category: f.category, week: f.week,
        createdAt: now + i, updatedAt: now + i, doneAt: null, archived: false, soak: null,
        source: 'notion', notion: { pageId: g.pageId, status: g.status, fields: { ...f } },
      };
      state.tasks.push(dish);
      moveDish(state, dish, g.group, now);
      changed++;
      return;
    }
    let touched = false;
    const out = {};
    const notionNewer = Date.parse(page.last_edited_time) >= (t.updatedAt || 0);
    // Dishes from before fields were tracked: take Notion's values.
    if (!t.notion.fields) {
      t.notion.fields = { ...g.fields };
      for (const k of GOAL_FIELDS) setDishField(t, k, g.fields[k]);
      touched = true;
    }
    for (const k of GOAL_FIELDS) {
      const agreed = t.notion.fields[k] ?? (k === 'week' ? null : '');
      const theirs = g.fields[k];
      const mine = dishField(t, k);
      const notionMoved = theirs !== agreed;
      const sinkMoved = mine !== agreed;
      if (notionMoved && (!sinkMoved || notionNewer)) {
        if (mine !== theirs) setDishField(t, k, theirs);
        t.notion.fields[k] = theirs;
        touched = true;
      } else if (sinkMoved) {
        if (mine !== theirs) out[k] = mine;
        else { t.notion.fields[k] = mine; touched = true; }
      }
    }
    const agreed = schema.groupOf[t.notion.status] || 'todo';
    if (t.notion.waiting) {
      if (dishGroup(t) === 'todo' && agreed === 'progress') { moveDish(state, t, 'progress', now); touched = touched || Boolean(t.soak); }
      else t.notion.waiting = false;
    }
    const notionMoved = g.status !== t.notion.status;
    const sinkMoved = dishGroup(t) !== agreed && !t.notion.waiting;
    if (notionMoved && (!sinkMoved || notionNewer)) {
      if (dishGroup(t) !== g.group) moveDish(state, t, g.group, now);
      t.notion.status = g.status;
      touched = true;
    } else if (sinkMoved) {
      const status = schema.names[dishGroup(t)];
      if (status !== g.status) out.status = status;
      else { t.notion.status = g.status; touched = true; }
    }
    if (Object.keys(out).length) pushes.push({ task: t, fields: out });
    if (touched) { t.updatedAt = now; changed++; }
  });
  // Goals deleted from Notion: their unwashed dishes go too.
  state.tasks = state.tasks.filter((t) => {
    if (t.source !== 'notion' || !t.notion || !t.notion.pageId || seen.has(t.id) || t.doneAt) return true;
    state.deleted[t.id] = now;
    changed++;
    return false;
  });
  // A device that hadn't heard a new goal got its page can save the old copy back: fold it into
  // the page's dish (so its edits still reach Notion) instead of making a second page.
  const adopted = new Map(state.tasks.filter((t) => t.notion && t.notion.from).map((t) => [t.notion.from, t]));
  state.tasks = state.tasks.filter((t) => {
    const home = t.notion && !t.notion.pageId && adopted.get(t.id);
    if (!home) return true;
    for (const k of ['title', 'notes', 'category', 'week', 'type', 'grime', 'soak', 'doneAt']) home[k] = t[k];
    home.updatedAt = now;
    state.deleted[t.id] = now;
    changed++;
    return false;
  });
  const creates = state.tasks.filter((t) => t.source === 'notion' && t.notion && !t.notion.pageId);
  return { changed, pushes, creates };
}

// A goal you added in Sinkful now has a Notion page: give its dish the page's id (so every device
// and every later sync agree on it) and drop the old id.
function adoptPage(state, t, pageId, status, now) {
  const id = `notion-${pageId.replace(/-/g, '')}`;
  state.deleted = state.deleted || {};
  state.deleted[t.id] = now;
  const fields = Object.fromEntries(GOAL_FIELDS.map((k) => [k, dishField(t, k)]));
  const dish = { ...t, id, updatedAt: now, notion: { ...t.notion, pageId, from: t.id, status, fields } };
  state.tasks = state.tasks.map((x) => (x === t ? dish : x));
  return dish;
}

// ---------------------------------------------------------------------------
// Gist
// ---------------------------------------------------------------------------

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
